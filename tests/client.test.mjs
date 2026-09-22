import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { OVClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';

const silent = { emit() {}, begin() { return 1; }, end() {} };
const base = () => loadConfig('/does-not-exist', { home: '/does-not-exist', env: {} });
async function server(t, handler) {
  const app = createServer(handler);
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const cfg = { ...base(), endpoint: `http://127.0.0.1:${app.address().port}`, apiKey: 'test-token', account: 'acct', user: 'user', peerId: 'peer' };
  const client = new OVClient(cfg, silent);
  t.after(async () => { await client.close(true); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
  return client;
}
function send(res, status, result) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); }
async function body(req) { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text || '{}'); }

test('remember requests extraction without archiving the shared live backlog', async t => {
  const requests = [];
  const client = await server(t, async (req, res) => {
    requests.push({path: req.url, method: req.method, body: await body(req)});
    send(res, 200, {status: 'ok', result: {}});
  });
  assert.equal(await client.commitRememberedMessage('shared/id'), true);
  assert.deepEqual(requests, [{path: '/api/v1/sessions/shared%2Fid/extract', method: 'POST', body: {}}]);
});

test('live-shaped health, envelope, namespace, peer header and message body', async t => {
  const requests = [];
  const client = await server(t, async (req, res) => {
    requests.push({ path: req.url, headers: req.headers, body: await body(req) });
    send(res, 200, req.url === '/health' ? { status: 'ok', healthy: true, version: 'v0.4.20' } : { status: 'ok', result: null });
  });
  assert.equal(await client.health(), true);
  client.bindUser('bound');
  assert.equal(client.userRoot, 'viking://user/bound');
  assert.equal(await client.addMessage('session/a', 'user', 'hello'), true);
  assert.deepEqual(requests[1].body, { role: 'user', content: 'hello', peer_id: 'peer' });
  assert.equal(requests[1].headers.authorization, 'Bearer test-token');
  assert.equal(requests[1].headers['x-openviking-user'], 'bound');
  assert.equal(requests[1].headers['x-openviking-actor-peer'], 'peer');
  assert.equal(requests[1].path, '/api/v1/sessions/session%2Fa/messages');
  const result = await client.fetchJSON('/empty');
  assert.equal(result.result, null);
  assert.equal(result.status, 200);
});

test('loopback bypasses a process-wide proxy dispatcher', async t => {
  const client = await server(t, (_req, res) => send(res, 200, { healthy: true }));
  const previous = getGlobalDispatcher();
  const blocked = new MockAgent();
  blocked.disableNetConnect();
  setGlobalDispatcher(blocked);
  try { assert.equal(await client.health(), true); }
  finally { setGlobalDispatcher(previous); await blocked.close(); }
});

test('reads retry transient errors but uncertain writes are never retried', async t => {
  let reads = 0, writes = 0;
  const client = await server(t, (req, res) => {
    if (req.method === 'GET') send(res, ++reads === 1 ? 503 : 200, { status: 'ok', result: 'done' });
    else { writes++; req.socket.destroy(); }
  });
  assert.equal((await client.fetchJSON('/read')).result, 'done');
  assert.equal(reads, 2);
  const response = await client.fetchJSON('/write', { method: 'POST', body: '{}' });
  assert.equal(response.ok, false);
  assert.equal(writes, 1);
});

test('retry shares one deadline and close aborts then rejects subsequent requests', async t => {
  let count = 0;
  const signals = [];
  const client = new OVClient({...base(),endpoint:'https://openviking.example',requestTimeoutMs:70},silent);
  t.after(()=>client.close(true));
  t.mock.method(globalThis,'fetch',async (_url,init)=>{
    count++; signals.push(init.signal);
    if(count===1) return new Response(JSON.stringify({status:'error'}),{status:503});
    return new Promise((_resolve,reject)=>{
      // Hold the simulated request open; AbortSignal.timeout alone is unreferenced.
      const keepAlive=setTimeout(()=>reject(new Error('deadline did not fire')),1000);
      init.signal.addEventListener('abort',()=>{clearTimeout(keepAlive);reject(init.signal.reason);},{once:true});
    });
  });
  const result = await client.fetchJSON('/retry');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ABORTED', 'combined retry work must exceed its single deadline');
  assert.equal(count, 2);
  assert.equal(signals[0],signals[1],'retry must reuse the original deadline signal');
  assert.equal(signals[0].aborted,true);
  await client.close();
  await client.close();
  assert.equal((await client.fetchJSON('/closed')).ok, false);
  assert.equal(count, 2);
});

test('malformed envelopes and server errors cannot echo captured secrets', async t => {
  const client = await server(t, (req, res) => {
    if (req.url === '/invalid') { res.end('not json test-token'); return; }
    send(res, 401, { status: 'error', error: { code: 'UNAUTHENTICATED', message: 'payload test-token', details: { authorization: 'test-token' } } });
  });
  const invalid = await client.fetchJSON('/invalid');
  assert.equal(invalid.ok, false);
  const denied = await client.fetchJSON('/denied');
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(denied).includes('test-token'), false);
});

test('redirects cannot forward bearer tokens to another origin', async t => {
  let requests = 0;
  const client = await server(t, (_req, res) => { requests++; res.writeHead(302, { location: 'http://127.0.0.1:9/stolen' }); res.end('{}'); });
  const result = await client.fetchJSON('/redirect');
  assert.equal(result.status, 302);
  assert.equal(result.ok, false);
  assert.equal(requests, 1);
  assert.throws(() => new OVClient({ ...base(), endpoint: 'http://remote.example', apiKey: 'secret' }, silent), /require HTTPS/);
});

test('immutable batches use server mode:create, verify bytes, and reconcile replay', async t => {
  const values = new Map();
  let writes = 0;
  const client = await server(t, async (req, res) => {
    if (req.method === 'GET') {
      const uri = new URL(req.url, 'http://localhost').searchParams.get('uri');
      if (!values.has(uri)) return send(res, 404, { status: 'error' });
      res.end(values.get(uri)); return;
    }
    const input = await body(req); writes++;
    for (const operation of input.operations) {
      assert.equal(operation.mode, 'create');
      assert.equal(Object.hasOwn(operation, 'precondition'), false);
      values.set(operation.uri, Buffer.from(operation.content_base64, 'base64'));
    }
    send(res, 200, { status: 'ok', result: { root_uri: input.root_uri, created: input.operations.map(operation => operation.uri), updated: [], unchanged: [] } });
  });
  const request = { root_uri: 'viking://resources/test', operations: [{ uri: 'viking://resources/test/a', content_base64: Buffer.from('immutable').toString('base64'), precondition: { kind: 'create_if_absent' } }], wait: false };
  assert.equal((await client.batchWrite(request)).result.created.length, 1);
  assert.equal((await client.batchWrite(request)).result.unchanged.length, 1);
  assert.equal(writes, 1);
  const conflict = structuredClone(request); conflict.operations[0].content_base64 = Buffer.from('different').toString('base64');
  assert.equal((await client.batchWrite(conflict)).status, 409);
  const unsupported = structuredClone(request); unsupported.operations[0].precondition = { kind: 'replace_if_hash', base_hash: 'a'.repeat(64) };
  assert.equal((await client.batchWrite(unsupported)).status, 501);
  assert.equal(writes, 1);
});

test('upload transfers bytes then references temp id without a fetchable path', async t => {
  const seen = [];
  const client = await server(t, async (req, res) => {
    if (req.url.endsWith('/temp_upload')) {
      assert.match(req.headers['content-type'], /^multipart\/form-data;/);
      let data = ''; for await (const chunk of req) data += chunk;
      assert.match(data, /filename="example.txt"/);
      assert.match(data, /text payload/);
      send(res, 200, { status: 'ok', result: { temp_file_id: 'temp-1' } });
    } else { seen.push(await body(req)); send(res, 200, { status: 'ok', result: { root_uri: 'viking://resources/import' } }); }
  });
  const response = await client.uploadResource(Buffer.from('text payload'), 'example.html', { sourceUrl: 'https://example.com', to: 'viking://user/test/resources/import' });
  assert.equal(response.ok, true);
  assert.equal(seen[0].temp_file_id, 'temp-1');
  assert.equal(seen[0].to, 'viking://user/test/resources/import');
  assert.equal(seen[0].create_parent, true);
  assert.equal(Object.hasOwn(seen[0], 'path'), false);
});

test('live OpenAPI confirms implemented wire contract', { skip: process.env.OPENVIKING_LIVE_TEST !== '1' }, async () => {
  const endpoint = process.env.OPENVIKING_URL || 'http://127.0.0.1:1933';
  const response = await fetch(`${endpoint}/openapi.json`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  assert.equal(response.ok, true);
  const schema = await response.json();
  assert.ok(schema.paths['/api/v1/content/write'].post);
  assert.ok(schema.paths['/api/v1/fs/tree'].get);
  assert.ok(schema.components.schemas.AddMessageRequest.properties.peer_id);
  assert.ok(schema.components.schemas.BatchWriteOperation.properties.mode.enum.includes('create'));
  assert.equal(schema.components.schemas.BatchWriteOperation.properties.precondition, undefined);
});


test('createSession reuses only after verifying a 409 session is readable', async t => {
  let readAllowed = true, creates = 0, reads = 0;
  const client = await server(t, (req, res) => {
    if (req.method === 'POST') { creates++; send(res, 409, { status: 'error', error: { code: 'ALREADY_EXISTS' } }); }
    else { reads++; send(res, readAllowed ? 200 : 403, readAllowed ? { status: 'ok', result: { session_id: 'existing' } } : { status: 'error' }); }
  });
  assert.equal(await client.createSession('existing'), true);
  readAllowed = false;
  assert.equal(await client.createSession('existing'), false);
  assert.equal(creates, 2);
  assert.equal(reads, 2);
});


test('storage scope isolates paths without changing authenticated header identity', async t => {
  const users = [];
  const client = await server(t, (req, res) => { users.push(req.headers['x-openviking-user']); send(res, 200, { status: 'ok', result: {} }); });
  client.bindScope('a'.repeat(24));
  assert.equal(client.authenticatedUser, 'user');
  assert.equal(client.baseUserRoot, 'viking://user/user');
  assert.equal(client.userRoot, `viking://user/user/omp-ov-memory/sessions/${'a'.repeat(24)}`);
  assert.equal(client.memorySpace, `user/omp-ov-memory/sessions/${'a'.repeat(24)}`);
  assert.equal(client.recordedEventTarget.scope, 'a'.repeat(24));
  await client.fetchJSON('/probe');
  assert.deepEqual(users, ['user']);
  assert.throws(() => client.bindScope('../another-user'), /safe hexadecimal/);
  client.bindScope('');
  assert.equal(client.userRoot, client.baseUserRoot);
});

test('identity resolution fails closed when server does not establish a user', async t => {
  const client = await server(t, (_req, res) => send(res, 200, { status: 'ok', result: { initialized: true } }));
  assert.equal(await client.resolveUserSpace(), '');
});
