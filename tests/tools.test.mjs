import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import { createTools, VIKING_TOOL_NAMES } from '../src/tools.ts';
import { canonicalVikingUri, isPublicAddress, validatePublicUrl, downloadPublicText } from '../src/security.ts';

function fixture(overrides = {}, sync = null, observe = {emit() {}}) {
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
    ls: async (...args) => { calls.push(['ls', ...args]); return []; },
    stat: async (...args) => { calls.push(['stat', ...args]); return { isDir: true }; },
    ...overrides,
  };
  const tools = new Map(createTools(client, sync, observe).map(tool => [tool.name, tool]));
  return { client, calls, tools, call: (name, args = {}) => tools.get(name).execute('1', args, new AbortController().signal) };
}

test('registers exactly eleven shared tools with JSON schemas', () => {
  const { tools } = fixture();
  assert.equal(tools.size, 11);
  assert.deepEqual([...tools.keys()], [...VIKING_TOOL_NAMES]);
  for (const tool of tools.values()) assert.equal(tool.parameters.additionalProperties, false);
});

test('published tool JSON schemas contain no TypeBox internal keys', () => {
  const { tools } = fixture();
  const check = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(key.startsWith('~'), false, `internal schema key: ${key}`);
      check(child);
    }
  };
  for (const tool of tools.values()) check(JSON.parse(JSON.stringify(tool.parameters)));
});

test('audit attributes write/edit operations and new tools/routes without other fallback', async t => {
  const {mkdtemp, readFile, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {createObservation} = await import('../src/shared/observe.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'ov-audit-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = join(dir, 'audit.jsonl');
  const observe = createObservation({env: {OV_OBSERVE: file}, autoFinalize: false});
  const {call} = fixture({}, null, observe);
  await call('viking_write', {uri: 'viking://user/alice/note.txt', content: 'text'});
  await call('viking_edit', {uri: 'viking://user/alice/note.txt', old_text: 'hello', new_text: 'hi'});
  for (const tool of ['viking_tree', 'viking_health']) observe.emit('tool_availability', tool, true);
  const routes = ['/api/v1/fs/tree', '/api/v1/content/write', '/api/v1/resources/temp_upload', '/api/v1/tasks/fixture/cancel', '/api/v1/sessions/fixture/extract'];
  for (const route of routes) {
    const op = observe.begin('client_http', route, 'POST', 2000);
    observe.end('client_http', op, 'success', 200, undefined);
  }
  await observe.finish();
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.some(record => record.data?.tool === 'other' || record.data?.route === 'other'), false);
  const mutations = records.filter(record => record.stage === 'tool_scope');
  assert.equal(mutations.length, 2);
  assert.ok(mutations.every(record => record.data.operation === 'write'));
  const http = records.filter(record => record.stage === 'client_http' && record.data.phase === 'begin');
  assert.deepEqual(http.map(record => record.data.route), routes.map(route => route.replace('/fixture/', '/{id}/')));
});

test('browse defaults to listing the active root through direct and prepared calls', async () => {
  for (const sessionScopedMemory of [true, false]) {
    const { tools, call, calls } = fixture({ cfg: { sessionScopedMemory, recallMaxContentChars: 1000 } });
    const browse = tools.get('viking_browse');
    const root = sessionScopedMemory ? 'viking://user/alice' : 'viking://';
    assert.equal((await call('viking_browse')).isError, undefined);
    assert.deepEqual(calls, [['ls', root]]);
    assert.equal(browse.parameters.properties.action.default, 'list');
    assert.equal(browse.parameters.properties.uri.default, 'viking://');
    assert.ok(Value.Check(browse.parameters, {}));
    const prepared = browse.prepareArguments({});
    assert.deepEqual(prepared, { action: 'list', uri: 'viking://' });
    assert.ok(Value.Check(browse.parameters, prepared));
    assert.deepEqual(browse.prepareArguments(prepared), prepared);
    assert.equal((await call('viking_browse', prepared)).isError, undefined);
    assert.deepEqual(calls[1], ['ls', root]);
  }
});

test('browse normalizes bare actions, bare URIs and unambiguous positional fields before validation', async () => {
  const uri = 'viking://user/alice/memories';
  for (const [input, expected, operation] of [
    ['list', { action: 'list', uri: 'viking://' }, 'ls'],
    ['stat', { action: 'stat', uri: 'viking://' }, 'stat'],
    [uri, { action: 'list', uri }, 'ls'],
    [{ 0: 'stat', 1: uri }, { action: 'stat', uri }, 'stat'],
    [{ 0: 'list', uri }, { action: 'list', uri }, 'ls'],
  ]) {
    const { tools, call, calls } = fixture();
    const browse = tools.get('viking_browse');
    const original = structuredClone(input);
    const prepared = browse.prepareArguments(input);
    assert.deepEqual(prepared, expected);
    assert.ok(Value.Check(browse.parameters, prepared));
    assert.deepEqual(browse.prepareArguments(prepared), prepared);
    assert.deepEqual(input, original, 'normalization must not mutate the caller input');
    assert.equal((await call('viking_browse', input)).isError, undefined);
    assert.equal((await call('viking_browse', prepared)).isError, undefined);
    const target = expected.uri === 'viking://' ? 'viking://user/alice' : expected.uri;
    assert.deepEqual(calls, [[operation, target], [operation, target]]);
  }
});

test('browse preserves invalid values, unknown fields and conflicting positional arguments for rejection', async () => {
  const { tools, call, calls } = fixture();
  const browse = tools.get('viking_browse');
  for (const args of [
    'delete', '', null, 3, [], ['list'],
    { action: 'delete' }, { action: '' }, { action: null }, { action: 1 },
    { uri: null }, { uri: 1 }, { unexpected: true },
    { action: 'stat', 0: 'list' }, { uri: 'viking://', 1: 'viking://user/alice' },
    { 0: 'list', 2: 'extra' },
  ]) {
    assert.equal(Value.Check(browse.parameters, browse.prepareArguments(args)), false, JSON.stringify(args));
    const result = await call('viking_browse', args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, /Invalid tool arguments/);
  }
  for (const uri of ['viking://user/bob', 'viking://user/alice/../bob', '']) {
    assert.equal((await call('viking_browse', { uri })).isError, true);
  }
  assert.deepEqual(calls, []);
});

test('tree supplies root and bounded defaults and accepts a bare URI before validation', async () => {
  for (const sessionScopedMemory of [true, false]) {
    const { tools, call, calls } = fixture({ cfg: { sessionScopedMemory, recallMaxContentChars: 1000 } });
    const tree = tools.get('viking_tree');
    const root = sessionScopedMemory ? 'viking://user/alice' : 'viking://';
    assert.equal(tree.parameters.properties.uri.default, 'viking://');
    assert.ok(Value.Check(tree.parameters, {}));
    for (const [input, expected] of [
      [{}, { uri: 'viking://', depth: 3, limit: 100 }],
      [undefined, { uri: 'viking://', depth: 3, limit: 100 }],
      ['viking://user/alice/memories', { uri: 'viking://user/alice/memories', depth: 3, limit: 100 }],
      [{ depth: 2, limit: 20 }, { uri: 'viking://', depth: 2, limit: 20 }],
    ]) {
      const prepared = tree.prepareArguments(input);
      assert.deepEqual(prepared, expected);
      assert.ok(Value.Check(tree.parameters, prepared));
      assert.deepEqual(tree.prepareArguments(prepared), prepared);
      for (const args of [input, prepared]) {
        assert.equal((await call('viking_tree', args)).isError, undefined);
        assert.deepEqual(calls.at(-1), ['tree', expected.uri === 'viking://' ? root : expected.uri, { depth: expected.depth, nodeLimit: expected.limit }]);
      }
    }
  }
});

test('tree normalization preserves invalid types, bounds and namespace checks', async () => {
  const { tools, call, calls } = fixture();
  const tree = tools.get('viking_tree');
  for (const args of [null, 7, [], { uri: null }, { uri: 9 }, { depth: '3' }, { depth: 0 }, { depth: 11 }, { depth: 1.5 }, { limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { limit: null }, { unexpected: true }]) {
    const prepared = tree.prepareArguments ? tree.prepareArguments(args) : args;
    assert.equal(Value.Check(tree.parameters, prepared), false, JSON.stringify(args));
    assert.equal((await call('viking_tree', args)).isError, true, JSON.stringify(args));
  }
  for (const uri of ['viking://user/bob', 'viking://user/alice/../bob', '']) {
    assert.equal((await call('viking_tree', { uri })).isError, true);
  }
  assert.deepEqual(calls, []);
});

test('browse tree action uses the same bounded tree operation and preserves server failures', async () => {
  const { tools, call, calls } = fixture();
  const browse = tools.get('viking_browse');
  for (const args of ['tree', { action: 'tree' }, { 0: 'tree', 1: 'viking://' }]) {
    const prepared = browse.prepareArguments(args);
    assert.ok(Value.Check(browse.parameters, prepared));
    assert.equal((await call('viking_browse', prepared)).isError, undefined);
    assert.deepEqual(calls.at(-1), ['tree', 'viking://user/alice', { depth: 3, nodeLimit: 100 }]);
  }
  const unavailableTree = fixture({ tree: async () => ({ ok: false, status: 503 }) });
  for (const [name, args] of [['viking_browse', { action: 'tree' }], ['viking_tree', {}]]) {
    const result = await unavailableTree.call(name, args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Could not read directory tree/);
  }
});

test('read accepts a bare URI and defaults to abstract without overriding an explicit level', async () => {
  const reads = [];
  const { tools, call } = fixture(Object.fromEntries([
    ['abstract', 'abstract'], ['overview', 'overview'], ['readContent', 'full'],
  ].map(([method, level]) => [method, async uri => { reads.push([level, uri]); return level; }])));
  const read = tools.get('viking_read');
  const uri = 'viking://user/alice/memories/fact';
  for (const [input, level] of [[uri, 'abstract'], [{ uri }, 'abstract'], [{ uri, level: 'overview' }, 'overview'], [{ uri, level: 'full' }, 'full']]) {
    const prepared = read.prepareArguments?.(input) ?? input;
    assert.ok(Value.Check(read.parameters, prepared));
    assert.deepEqual(prepared, { uri, level });
    assert.deepEqual(read.prepareArguments(prepared), prepared);
    for (const args of [input, prepared]) {
      assert.equal((await call('viking_read', args)).content[0].text, level);
      assert.deepEqual(reads.at(-1), [level, uri]);
    }
  }
  assert.equal(read.parameters.properties.level.default, 'abstract');
});

test('read still requires a valid authorized URI and rejects invalid levels and extra fields', async () => {
  let reads = 0;
  const { tools, call } = fixture({ abstract: async () => { reads++; return 'abstract'; } });
  const read = tools.get('viking_read');
  for (const args of [undefined, null, {}, 7, [], { uri: 7 }, { uri: null }, { uri: 'viking://user/alice/x', level: null }, { uri: 'viking://user/alice/x', level: 'summary' }, { uri: 'viking://user/alice/x', extra: true }]) {
    const prepared = read.prepareArguments ? read.prepareArguments(args) : args;
    assert.equal(Value.Check(read.parameters, prepared), false, JSON.stringify(args));
    assert.equal((await call('viking_read', args)).isError, true);
  }
  for (const uri of ['viking://', 'viking://user/bob/x', 'viking://user/alice/../bob', '']) {
    assert.equal((await call('viking_read', { uri })).isError, true);
  }
  assert.equal(reads, 0);
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
