import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveMemoryNamespace, resolveWorkspace } from '../src/workspace.ts';

const proxyPath = fileURLToPath(new URL('../servers/mcp-proxy.mjs', import.meta.url));

async function harness(t, { sessionScopedMemory = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'omp-ov-mcp-test-'));
  if (!sessionScopedMemory) {
    await mkdir(join(home, '.openviking'));
    await writeFile(join(home, '.openviking', 'omp-ov-memory.jsonc'), JSON.stringify({ sessionScopedMemory: false }));
  }
  const requests = [];
  const content = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, url, body: parsed, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    const ok = result => res.end(JSON.stringify({ status: 'ok', result }));
    if (url.pathname === '/health') { res.end(JSON.stringify({ status: 'ok', healthy: true, version: 'test' })); return; }
    if (req.headers.authorization !== 'Bearer fake-test-key') { res.statusCode = 401; res.end('{}'); return; }
    if (url.pathname === '/api/v1/system/status') { ok({ initialized: true, user: 'tester' }); return; }
    if (url.pathname === '/api/v1/fs/stat') { ok({ isDir: true }); return; }
    if (url.pathname === '/api/v1/fs/mkdir') { ok({ uri: parsed.uri }); return; }
    if (url.pathname === '/api/v1/fs/tree') { ok({ entries: [{ name: 'fact.txt' }] }); return; }
    if (url.pathname === '/api/v1/content/read') {
      if (url.searchParams.get('uri')?.endsWith('/slow')) await new Promise(resolve => setTimeout(resolve, 150));
      ok(content.get(url.searchParams.get('uri')) ?? 'hello world'); return;
    }
    if (url.pathname === '/api/v1/content/write') { content.set(parsed.uri, parsed.content); ok({ uri: parsed.uri }); return; }
    if (url.pathname === '/api/v1/search/find') { ok({ memories: [], resources: [], skills: [] }); return; }
    if (url.pathname === '/api/v1/sessions' || /\/sessions\/[^/]+\/(messages|commit)$/.test(url.pathname)) { ok({}); return; }
    res.statusCode = 404; res.end(JSON.stringify({ status: 'error' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENVIKING_')));
  const child = spawn(process.execPath, [proxyPath], {
    cwd: home,
    env: { ...env, HOME: home, OPENVIKING_URL: `http://127.0.0.1:${server.address().port}`, OPENVIKING_API_KEY: 'fake-test-key', OPENVIKING_USER: 'tester', OPENVIKING_SESSION_ID: 'integration' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text; });
  let sequence = 0;
  let buffer = '';
  const listeners = new Map();
  const received = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const message = JSON.parse(line);
      received.push(message);
      listeners.get(message.id)?.(message);
      listeners.delete(message.id);
    }
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    child.stdin.end();
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); })]);
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
    assert.doesNotMatch(stderr, /fake-test-key/);
  });
  function waitFor(id) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No MCP response for ${id}; stderr=${stderr}`)), 5000);
      listeners.set(id, message => { clearTimeout(timeout); resolve(message); });
    });
  }
  function rpc(method, params) {
    const id = ++sequence;
    const response = waitFor(id);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return response;
  }
  const user = deriveMemoryNamespace('tester', 'integration', resolveWorkspace(home));
  return { rpc, child, requests, content, received, waitFor, root: sessionScopedMemory ? `viking://user/${user}` : 'viking://user/tester' };
}

test('MCP process initializes, lists eleven shared tools and uses authenticated real HTTP client', async t => {
  const h = await harness(t);
  const init = await h.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'omp-ov-memory');
  assert.equal(init.result.protocolVersion, '2025-11-25');
  h.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  assert.equal((await h.rpc('tools/list')).result.tools.length, 11);
  assert.deepEqual((await h.rpc('ping')).result, {});
  const health = await h.rpc('tools/call', { name: 'viking_health' });
  assert.equal(JSON.parse(health.result.content[0].text).healthy, true);
  const tree = await h.rpc('tools/call', { name: 'viking_tree', arguments: { depth: 2, limit: 20 } });
  assert.match(tree.result.content[0].text, /fact.txt/);
  const req = h.requests.find(request => request.url.pathname === '/api/v1/fs/tree');
  assert.equal(req.url.searchParams.get('uri'), h.root);
  assert.equal(req.url.searchParams.get('level_limit'), '2');
  assert.equal(req.headers.authorization, 'Bearer fake-test-key');
  assert.equal(req.headers['x-openviking-user'], 'tester');
  const uri = `${h.root}/memories/fact.txt`;
  assert.equal((await h.rpc('tools/call', { name: 'viking_write', arguments: { uri, content: 'alpha beta' } })).result.isError, undefined);
  const edited = await h.rpc('tools/call', { name: 'viking_edit', arguments: { uri, old_text: 'beta', new_text: 'gamma' } });
  assert.equal(edited.result.structuredContent.atomic, false);
  assert.equal(h.content.get(uri), 'alpha gamma');
  const read = await h.rpc('tools/call', { name: 'viking_read', arguments: { uri, level: 'full' } });
  assert.equal(read.result.content[0].text, 'alpha gamma');
  assert.equal(h.requests.filter(request => request.url.pathname === '/api/v1/content/write').length, 2);
});

test('MCP protocol errors, tool validation, cancellation and archive session behavior', async t => {
  const h = await harness(t);
  assert.equal((await h.rpc('tools/list')).error.code, -32002);
  await h.rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal((await h.rpc('missing/method')).error.code, -32601);
  assert.equal((await h.rpc('tools/call', { name: 'missing' })).error.code, -32602);
  assert.equal((await h.rpc('tools/call', { name: 'viking_write', arguments: { uri: '../bad' } })).result.isError, true);
  const parse = h.waitFor(null); h.child.stdin.write('{broken}\n');
  assert.equal((await parse).error.code, -32700);
  const remembered = await h.rpc('tools/call', { name: 'viking_remember', arguments: { content: 'fixture fact', category: 'case' } });
  assert.equal(remembered.result.isError, false);
  assert.ok(h.requests.some(request => request.url.pathname === '/api/v1/content/write' && request.body.uri.startsWith(h.root+'/memories/case/') && request.body.content.includes('fixture fact')));
  assert.equal(h.requests.some(request => /\/sessions\/[^/]+\/messages$/.test(request.url.pathname)), false);
  const archives = await h.rpc('tools/call', { name: 'viking_archive_expand', arguments: {} });
  assert.match(archives.result.content[0].text, /No committed archives/);
  const cancellation = h.waitFor('cancel-me');
  h.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'cancel-me', method: 'tools/call', params: { name: 'viking_read', arguments: { uri: `${h.root}/slow`, level: 'full' } } })}\n`);
  h.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-me' } })}\n`);
  assert.equal((await cancellation).error.code, -32800);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(h.received.filter(message => message.id === 'cancel-me').length, 1);
});

test('MCP explicit session IDs stay separated by workspace even with shared memory mode', async t => {
  const first = await harness(t, { sessionScopedMemory: false });
  const second = await harness(t, { sessionScopedMemory: false });
  for (const h of [first, second]) {
    await h.rpc('initialize', { protocolVersion: '2025-11-25' });
    const result = await h.rpc('tools/call', { name: 'viking_remember', arguments: { content: 'workspace-local session fixture' } });
    assert.equal(result.result.isError, false);
  }
  const nativeId = h => h.requests.find(request => request.method === 'POST' && request.url.pathname === '/api/v1/sessions')?.body.session_id;
  assert.equal(typeof nativeId(first), 'string');
  assert.equal(typeof nativeId(second), 'string');
  assert.notEqual(nativeId(first), nativeId(second));
  for (const h of [first, second]) {
    assert.ok(h.requests.some(request => request.url.pathname === `/api/v1/sessions/${nativeId(h)}/messages`));
    assert.ok(h.requests.some(request => request.url.pathname === `/api/v1/sessions/${nativeId(h)}/commit`));
  }
});
