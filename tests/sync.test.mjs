import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncManager } from '../src/sync.ts';
import { EXTENSION_CONFIG_DEFAULTS } from '../src/shared/config-schema.mjs';

const silent = { emit() {}, bindSession() {}, begin() { return { end() {} }; } };
const entry = (id, parentId, text) => ({ type: 'message', id, parentId, timestamp: '2026-09-21T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text }], timestamp: 123 } });
const source = entries => ({ isPersisted: () => false, getEntries: () => entries, getBranch: () => entries, getLeafId: () => entries.at(-1)?.id ?? null });

async function fixture(t, extra = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'omp-sync-test-'));
  const writes = [];
  const client = {
    cfg: { ...EXTENSION_CONFIG_DEFAULTS, archive: { chunkTokenBudget: 50000, rawTailTokenBudget: 20000 }, takeover: { ...EXTENSION_CONFIG_DEFAULTS.takeover, enabled: false }, stateDir },
    userRoot: 'viking://user/test', recordedEventTarget: { endpoint: 'http://127.0.0.1:1933', account: 'test', user: 'test' },
    commitSession: async id => ({ ok: true, result: { session_id: id } }),
    ...extra.client,
  };
  const adapter = {
    writeEvents: async (_, events) => { writes.push(structuredClone(events)); return { acceptedEventIds: events.map(event => event.eventId), capabilityVerified: true }; },
    ...extra.adapter,
  };
  const sync = new SyncManager(client, {
    stateDir,
    observation: silent,
    ackPathForSession: () => join(stateDir, 'ack.json'),
    activeContextPathForSession: () => null,
    adapterFactory: () => adapter,
    ...extra.options,
  });
  t.after(async () => { await sync.stopBackground(); await rm(stateDir, { recursive: true, force: true }); });
  await sync.ensureSession('session-test');
  return { stateDir, sync, writes, client, adapter };
}

test('capture policy excludes persistent JSONL secrets while preserving branch ancestry', async t => {
  const { stateDir, sync, writes } = await fixture(t, { options: { filterEntry: value => JSON.stringify(value).includes('top-secret') ? null : value } });
  const entries = [entry('a', null, 'allowed first'), entry('b', 'a', 'top-secret'), entry('c', 'b', 'allowed last')];
  const path = join(stateDir, 'source.jsonl');
  await writeFile(path, [{ type: 'session', id: 'session-test' }, ...entries].map(value => JSON.stringify(value)).join('\n'));
  const result = await sync.syncBranch({ ...source(entries), isPersisted: () => true, getSessionFile: () => path });
  assert.equal(result.allDelivered, true);
  assert.doesNotMatch(JSON.stringify(writes), /top-secret/);
  assert.match(JSON.stringify(writes), /allowed first/);
  assert.match(JSON.stringify(writes), /allowed last/);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'ack.json'), 'utf8')).acknowledgedLeaves, ['c']);
  assert.equal((await sync.syncBranch(source(entries))).added, 0, 'filtered entries still advance ACK ancestry');
});

test('filter failures fail closed without projecting an unfiltered source', async t => {
  const { sync, writes } = await fixture(t, { options: { filterEntry: () => { throw new Error('policy failure'); } } });
  const result = await sync.syncBranch(source([entry('a', null, 'never-write')]));
  assert.equal(result.allDelivered, false);
  assert.equal(writes.length, 0);
});

test('outage ACK only advances a verified prefix and replay uses deterministic event IDs', async t => {
  const attempted = [];
  let unavailable = true;
  const { sync } = await fixture(t, { adapter: { writeEvents: async (_, events) => {
    attempted.push(events.map(event => event.eventId));
    if (unavailable && events.some(event => event.source.entryId === 'b')) throw new Error('offline');
    return { acceptedEventIds: events.map(event => event.eventId), capabilityVerified: true };
  } } });
  const entries = [entry('a', null, 'first'), entry('b', 'a', 'second')];
  const first = await sync.syncBranch(source(entries));
  assert.equal(first.added, 1);
  assert.equal(first.pending, 1);
  assert.deepEqual(sync.status.acknowledgedLeaves, ['a']);
  unavailable = false;
  const second = await sync.syncBranch(source(entries));
  assert.equal(second.added, 1);
  assert.equal(second.allDelivered, true);
  assert.deepEqual(attempted[1], attempted[2]);
});

test('concurrent branch sync serializes ACK and commit targets the bound session', async t => {
  const commits = [];
  const { sync, writes } = await fixture(t, { client: { commitSession: async id => { commits.push(id); return { ok: true, result: {} }; } } });
  const entries = [entry('a', null, 'one')];
  const results = await Promise.all([sync.syncBranch(source(entries)), sync.syncBranch(source(entries))]);
  assert.deepEqual(results.map(result => result.added), [1, 0]);
  assert.equal(writes.length, 1);
  assert.equal(await sync.commit(), true);
  assert.deepEqual(commits, [sync.sessionId]);
});

test('cancelled queued sync stops before another event write and retains remaining source', async t => {
  const controller = new AbortController();
  const delivered = [];
  const { sync } = await fixture(t, { adapter: { writeEvents: async (_, events) => {
    delivered.push(events[0].source.entryId);
    controller.abort();
    return { acceptedEventIds: events.map(event => event.eventId), capabilityVerified: true };
  } } });
  const result = await sync.syncBranch(source([entry('a', null, 'one'), entry('b', 'a', 'two')]), null, controller.signal);
  assert.equal(result.allDelivered, false);
  assert.equal(result.pending, 1);
  assert.deepEqual(delivered, ['a']);
  assert.deepEqual(sync.status.acknowledgedLeaves, ['a']);
});

test('identical harness session IDs in distinct workspace namespaces get distinct native sessions', async t => {
  const first = await fixture(t, {options:{namespaceKey:'workspace-alpha'}});
  const second = await fixture(t, {options:{namespaceKey:'workspace-beta'}});
  assert.notEqual(first.sync.sessionId, second.sync.sessionId);
  const again = await fixture(t, {options:{namespaceKey:'workspace-alpha'}});
  assert.equal(first.sync.sessionId, again.sync.sessionId);
});

test('bound storage scopes also isolate native session IDs when no namespace override is given', async t => {
  const target = {endpoint:'http://127.0.0.1:1933',account:'test',user:'test'};
  const first = await fixture(t, {client:{recordedEventTarget:{...target,scope:'a'.repeat(24)}}});
  const second = await fixture(t, {client:{recordedEventTarget:{...target,scope:'b'.repeat(24)}}});
  assert.notEqual(first.sync.sessionId, second.sync.sessionId);
});
