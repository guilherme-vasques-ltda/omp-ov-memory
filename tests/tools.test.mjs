import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools, VIKING_TOOL_NAMES } from '../src/tools.ts';
import { canonicalVikingUri, isPublicAddress, validatePublicUrl, downloadPublicText } from '../src/security.ts';

function fixture(overrides = {}, sync = null) {
  const calls = [];
  const client = {
    cfg: { sessionScopedMemory: true, recallMaxContentChars: 1000 }, userRoot: 'viking://user/alice', baseUserRoot: 'viking://user/alice', connected: true,
    statUri: async () => ({ ok: true, exists: true, isDir: true }),
    find: async (...args) => { calls.push(['find', ...args]); return []; },
    readContent: async () => 'hello world', abstract: async () => 'abstract', overview: async () => 'overview',
    writeContent: async (...args) => { calls.push(['write', ...args]); return { ok: true, result: {} }; },
    delete: async (...args) => { calls.push(['delete', ...args]); return true; },
    health: async () => true,
    tree: async (...args) => { calls.push(['tree', ...args]); return { ok: true, result: { entries: [] } }; },
    ...overrides,
  };
  const tools = new Map(createTools(client, sync, { emit() {} }).map(tool => [tool.name, tool]));
  return { client, calls, tools, call: (name, args = {}) => tools.get(name).execute('1', args, new AbortController().signal) };
}

test('registers exactly eleven shared tools with JSON schemas', () => {
  const { tools } = fixture();
  assert.equal(tools.size, 11);
  assert.deepEqual([...tools.keys()], [...VIKING_TOOL_NAMES]);
  for (const tool of tools.values()) assert.equal(tool.parameters.additionalProperties, false);
});

test('canonical URI rejects traversal, encodings, ambiguous separators and namespace prefix collision', async () => {
  for (const bad of ['viking://user/alice/../bob', 'viking://user/alice/%2e%2e/bob', 'viking://user/alice/%252e%252e', 'viking://user/alice\\bob', 'viking://user/alice//x', 'viking://user/alice?x', 'viking://user/alice/#x', ' viking://user/alice']) assert.equal(canonicalVikingUri(bad), null, bad);
  assert.equal(canonicalVikingUri('viking://user/memories/fact', 'viking://user/alice'), 'viking://user/alice/memories/fact');
  const { call, calls } = fixture();
  assert.equal((await call('viking_write', { uri: 'viking://user/alice-other/fact', content: 'secret' })).isError, true);
  assert.equal(calls.length, 0);
});

test('mutations refuse immutable engine files and namespace root', async () => {
  const { call, calls } = fixture();
  for (const uri of ['viking://user/alice', 'viking://user/alice/resources/.pi-openviking/fact', 'viking://user/alice/resources/.omp-ov-memory/fact']) {
    for (const [name, args] of [['viking_write', { content: 'x' }], ['viking_edit', { old_text: 'a', new_text: 'b' }], ['viking_forget', {}]]) assert.equal((await call(name, { uri, ...args })).isError, true);
  }
  assert.equal(calls.length, 0);
});

test('validation refuses malformed categories and non-integral limits before mutation', async () => {
  let stored = 0;
  const { call } = fixture({ createSession: async () => { stored++; return true; } }, { sessionId: 's' });
  for (const category of ['../secret', 'Bad', 'a'.repeat(33), 'a\n']) assert.equal((await call('viking_remember', { content: 'fact', category })).isError, true);
  assert.equal((await call('viking_search', { query: 'q', limit: 1.5 })).isError, true);
  assert.equal((await call('viking_health', { unexpected: true })).isError, true);
  assert.equal(stored, 0);
});

test('search clamps scope and filters hostile out-of-scope results', async () => {
  let target;
  const { call } = fixture({ find: async (_q, opts) => {
    target = opts.targetUri;
    return [
      { uri: 'viking://user/alice/memories/good', abstract: 'safe', score: .9 },
      { uri: 'viking://user/bob/memories/bad', abstract: 'secret', score: .9 },
      { uri: 'viking://user/alice/%2e%2e/bob/bad', abstract: 'secret', score: .9 },
    ];
  } });
  const result = await call('viking_search', { query: 'decision', scope: 'viking://user/bob' });
  assert.equal(target, 'viking://user/alice');
  assert.equal(result.details.results.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('write defaults to create, exact edit changes one occurrence and reports non-atomicity', async () => {
  const { call, calls } = fixture();
  assert.equal((await call('viking_write', { uri: 'viking://user/alice/memories/x', content: 'x' })).isError, undefined);
  assert.equal(calls[0][3].mode, 'create');
  const result = await call('viking_edit', { uri: 'viking://user/alice/memories/x', old_text: 'world', new_text: 'earth' });
  assert.equal(result.details.atomic, false);
  assert.equal(calls[1][2], 'hello earth');
});

test('edit refuses no match, overlapping matches and changed content without writing', async () => {
  for (const original of ['nothing', 'aaaa']) {
    const { call, calls } = fixture({ readContent: async () => original });
    assert.equal((await call('viking_edit', { uri: 'viking://user/alice/x', old_text: 'aaa', new_text: 'x' })).isError, true);
    assert.equal(calls.length, 0);
  }
  let reads = 0;
  const { call, calls } = fixture({ readContent: async () => reads++ ? 'someone else edited' : 'hello world' });
  assert.equal((await call('viking_edit', { uri: 'viking://user/alice/x', old_text: 'world', new_text: 'x' })).isError, true);
  assert.equal(calls.length, 0);
});

test('parallel edits are serialized per URI within the shared tool set', async () => {
  let body = 'one two';
  const { call } = fixture({ readContent: async () => body, writeContent: async (_uri, content) => { await new Promise(resolve => setTimeout(resolve, 5)); body = content; return { ok: true }; } });
  const results = await Promise.all([
    call('viking_edit', { uri: 'viking://user/alice/x', old_text: 'one', new_text: 'first' }),
    call('viking_edit', { uri: 'viking://user/alice/x', old_text: 'two', new_text: 'second' }),
  ]);
  assert.equal(body, 'first second');
  assert.ok(results.every(result => !result.isError));
});

test('unreachable tools fail clearly, health can recover, archives require a real session', async () => {
  const { call, client } = fixture({ connected: false });
  assert.equal((await call('viking_write', { uri: 'viking://user/alice/x', content: 'x' })).isError, true);
  client.health = async () => { client.connected = true; return true; };
  assert.equal((await call('viking_health')).isError, false);
  assert.equal((await call('viking_archive_expand')).isError, true);
});

test('SSRF guard blocks private/reserved IP variants and mixed DNS answers', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.1.2', '192.168.1.1', '198.18.0.1', '0.0.0.0', '255.255.255.255', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['file:///etc/passwd', 'http://localhost', 'http://example.local', 'http://2130706433', 'http://0x7f000001', 'http://127.1', 'http://[::ffff:127.0.0.1]', 'https://u:p@public.example.com']) await assert.rejects(validatePublicUrl(url));
  await assert.rejects(validatePublicUrl('https://public.example.com', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]));
  const allowed = await validatePublicUrl('https://public.example.com', async () => [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(allowed.addresses[0].address, '8.8.8.8');
  await assert.rejects(downloadPublicText('http://127.0.0.1:1933/health'));
});

test('resource transport pins the vetted address, omits auth and validates redirects before connecting', async () => {
  const { PassThrough } = await import('node:stream');
  const { EventEmitter } = await import('node:events');
  const seen = [];
  const responses = [
    { status: 302, headers: { location: 'https://other.public.example.com/page' } },
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<img src="http://169.254.169.254/latest/">plain' },
  ];
  const request = (url, options, onResponse) => {
    seen.push({ url, options });
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const spec = responses.shift();
      const response = new PassThrough();
      response.statusCode = spec.status; response.headers = spec.headers;
      onResponse(response); if (!response.destroyed) response.end(spec.body ?? '');
    });
    return req;
  };
  let resolves = 0;
  const resolve = async () => { resolves++; return [{ address: '8.8.8.8', family: 4 }]; };
  const downloaded = await downloadPublicText('https://public.example.com/page', { resolve, request });
  assert.equal(resolves, 2);
  assert.equal(downloaded.sourceUrl, 'https://other.public.example.com/page');
  assert.match(new TextDecoder().decode(downloaded.bytes), /169\.254/); // Literal text; OV receives .txt, never a crawl URL.
  for (const { options } of seen) {
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
    options.lookup('public.example.com', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); });
  }
  responses.push({ status: 302, headers: { location: 'http://169.254.169.254/latest/' } });
  await assert.rejects(downloadPublicText('https://public.example.com', { resolve, request }), /non-public/);
  assert.equal(seen.length, 3); // No socket is opened to redirect target.
});

test('resource transport enforces byte cap and rejects non-text without following embedded content', async () => {
  const { PassThrough } = await import('node:stream');
  const { EventEmitter } = await import('node:events');
  for (const spec of [
    { headers: { 'content-type': 'text/plain' }, body: 'oversized text', pattern: /size limit/ },
    { headers: { 'content-type': 'application/octet-stream' }, body: 'abc', pattern: /Only text/ },
  ]) {
    const request = (_url, _options, onResponse) => {
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => { const res = new PassThrough(); res.statusCode = 200; res.headers = spec.headers; onResponse(res); if (!res.destroyed) res.end(spec.body); });
      return req;
    };
    await assert.rejects(downloadPublicText('https://public.example.com', { request, resolve: async () => [{ address: '8.8.8.8', family: 4 }], maxBytes: 4 }), spec.pattern);
  }
});

test('subpath session scopes preserve authenticated identity, relative aliases and protected archives', async () => {
  const root = 'viking://user/alice/omp-ov-memory/sessions/1234567890abcdef';
  assert.equal(canonicalVikingUri('viking://user/memories/fact', root), `${root}/memories/fact`);
  const { call, calls } = fixture({ userRoot: root });
  assert.equal((await call('viking_write', { uri: `${root}/resources/.pi-openviking/event.json`, content: 'x' })).isError, true);
  assert.equal((await call('viking_read', { uri: 'viking://user/alice/memories/global', level: 'full' })).isError, true);
  const remembered = await call('viking_remember', { content: 'scoped fact', category: 'decision' });
  assert.equal(remembered.isError, false);
  assert.match(remembered.details.uri, /\/memories\/decision\/[a-f0-9]{64}\.md$/);
  assert.equal(calls[0][1], remembered.details.uri);
  assert.equal(calls[0][3].mode, 'create');
});

test('scoped explicit remember treats same create conflict as idempotent only after content verification', async () => {
  const { call } = fixture({ writeContent: async () => ({ ok: false, status: 409 }), readContent: async () => '[Remember — general] fact' });
  assert.equal((await call('viking_remember', { content: 'fact' })).isError, false);
  const other = fixture({ writeContent: async () => ({ ok: false, status: 409 }), readContent: async () => 'different content' });
  assert.equal((await other.call('viking_remember', { content: 'fact' })).isError, true);
});

test('forget rejects ambiguous mutation requests before any delete/search', async () => {
  const { call, calls } = fixture();
  assert.equal((await call('viking_forget', { uri: 'viking://user/alice/fact', query: 'fact' })).isError, true);
  assert.equal((await call('viking_forget')).isError, true);
  assert.equal(calls.length, 0);
});
