import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HookQueue } from '../src/hook-queue.ts';

async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'omp-queue-test-'));
  const queues = [];
  t.after(async () => { for (const queue of queues) await queue.dispose(50); await rm(stateDir, { recursive: true, force: true }); });
  const create = (extra = {}) => { const queue = new HookQueue({ stateDir, identity: 'session-one', flushIntervalMs: 60_000, flushThreshold: 1000, handler: async () => {}, ...options, ...extra }); queues.push(queue); return queue; };
  return { stateDir, create };
}

test('outage remains durable with private permissions and replay preserves order', async t => {
  const { create } = await fixture(t);
  const first = create({ handler: async () => { throw new Error('offline payload must never enter log'); } });
  first.enqueue({ event: 'turn', text: 'one' });
  first.enqueue({ event: 'turn', text: 'two' });
  assert.equal(await first.flush(), false);
  assert.equal((await stat(first.pendingDirectory)).mode & 0o777, 0o700);
  const files = (await readdir(first.pendingDirectory)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 2);
  for (const file of files) assert.equal((await stat(join(first.pendingDirectory, file))).mode & 0o777, 0o600);
  await first.dispose(20);
  const delivered = [];
  const second = create({ handler: async payload => { delivered.push(payload.text); } });
  assert.equal(await second.replayPending(), true);
  assert.deepEqual(delivered, ['one', 'two']);
  assert.equal(second.status.pending, 0);
});

test('capture filter runs before any persistence and applies again at replay', async t => {
  const { create } = await fixture(t);
  const first = create({ filter: value => value.secret ? null : { ...value, text: '[redacted]' }, handler: async () => { throw new Error('offline'); } });
  assert.equal(first.enqueue({ secret: true, text: 'never-store-this' }), false);
  assert.equal(first.enqueue({ text: 'also-never-store-this' }), true);
  await first.flush();
  const files = (await readdir(first.pendingDirectory)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const serialized = await readFile(join(first.pendingDirectory, files[0]), 'utf8');
  assert.doesNotMatch(serialized, /never-store-this/);
  assert.match(serialized, /redacted/);
  await first.dispose(20);
  const second = create({ filter: () => null, handler: async () => assert.fail('new policy excludes replay') });
  assert.equal(await second.replayPending(), true);
  assert.equal(second.status.pending, 0);
});

test('overflow is spooled without loss and concurrent flushes serialize dispatch', async t => {
  const delivered = [];
  let concurrency = 0;
  let maximum = 0;
  const { create } = await fixture(t, { maxSize: 3, handler: async payload => {
    maximum = Math.max(maximum, ++concurrency);
    await new Promise(resolve => setTimeout(resolve, 1));
    delivered.push(payload.index);
    concurrency--;
  } });
  const queue = create();
  for (let index = 0; index < 105; index++) assert.equal(queue.enqueue({ index }), true);
  await Promise.all([queue.flush(), queue.flush(), queue.flush()]);
  assert.equal(maximum, 1);
  assert.deepEqual(delivered, Array.from({ length: 105 }, (_, i) => i));
  assert.equal(queue.status.pending, 0);
});

test('timeout bounds flush and avoids overlapping uncertain delivery', async t => {
  let calls = 0;
  let release;
  let signal;
  const { create } = await fixture(t, { timeoutMs: 25, handler: async (_, inputSignal) => { calls++; signal = inputSignal; await new Promise(resolve => { release = resolve; }); } });
  const queue = create();
  queue.enqueue({ index: 1 });
  const started = performance.now();
  assert.equal(await queue.flush(), false);
  assert.ok(performance.now() - started < 400);
  assert.equal(signal.aborted, true);
  assert.equal(await queue.flush(), false);
  assert.equal(calls, 1);
  assert.equal(queue.status.pending, 1);
  release();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(queue.status.pending, 0, 'late confirmed success removes durable record');
});

test('shutdown drain budget bounds stalled handler while pending survives', async t => {
  let release;
  let onStart;
  const waiting = new Promise(resolve => { onStart = resolve; });
  const { create } = await fixture(t, { timeoutMs: 2000, handler: async () => { onStart(); await new Promise(resolve => { release = resolve; }); } });
  const queue = create();
  queue.enqueue({ index: 1 });
  void queue.flush();
  await waiting;
  const started = performance.now();
  assert.equal(await queue.dispose(25), false);
  assert.ok(performance.now() - started < 400);
  assert.equal(queue.enqueue({ index: 2 }), false);
  assert.equal(queue.status.pending, 1);
  const competing = create({handler: async () => assert.fail('uncertain handler must retain its lease')});
  assert.equal(await competing.flush(), false);
  release();
});

test('dispose quiesces accepted disk writes and leaves no lease temporaries', async t => {
  const { create } = await fixture(t, {handler: async () => { throw new Error('offline'); }});
  const queue = create();
  for (let i = 0; i < 20; i++) queue.enqueue({index: i, text: 'x'.repeat(50_000)}, {immediate: true});
  await queue.dispose(400);
  const files = await readdir(queue.pendingDirectory);
  assert.equal(files.filter(file => file.endsWith('.json')).length, 20);
  assert.equal(files.some(file => file.endsWith('.tmp') || file === '.lease'), false);
  await rm(queue.pendingDirectory, {recursive: true});
  await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(readdir(queue.pendingDirectory), {code: 'ENOENT'}, 'no writes may recreate the spool after dispose');
});

test('dispose aborts and joins an in-flight flush before returning', async t => {
  let onStart;
  const started = new Promise(resolve => { onStart = resolve; });
  const { create } = await fixture(t, {handler: async (_, signal) => {
    onStart();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}));
  }});
  const queue = create();
  queue.enqueue({index: 1}, {immediate: true});
  await started;
  await queue.dispose(400);
  assert.deepEqual((await readdir(queue.pendingDirectory)).map(file => file.endsWith('.json')), [true]);
});

test('a late replay cannot initialize disk state after disposal', async t => {
  const {create} = await fixture(t);
  const queue = create();
  await queue.dispose(400);
  assert.equal(await queue.replayPending(), false);
  await assert.rejects(readdir(queue.pendingDirectory), {code: 'ENOENT'});
});

test('replay collects abandoned lease temporaries while preserving live owners', async t => {
  const { create } = await fixture(t);
  const queue = create();
  await queue.replayPending();
  const { writeFile, utimes } = await import('node:fs/promises');
  await writeFile(join(queue.pendingDirectory, '.lease-dead.tmp'), JSON.stringify({pid: 2147483647}));
  await writeFile(join(queue.pendingDirectory, '.lease-live.tmp'), JSON.stringify({pid: process.pid}));
  const fragment = join(queue.pendingDirectory, '.lease-fragment.tmp');
  await writeFile(fragment, '{');
  await utimes(fragment, new Date(0), new Date(0));
  await queue.replayPending();
  assert.equal((await readdir(queue.pendingDirectory)).includes('.lease-dead.tmp'), false);
  assert.equal((await readdir(queue.pendingDirectory)).includes('.lease-live.tmp'), true);
  assert.equal((await readdir(queue.pendingDirectory)).includes('.lease-fragment.tmp'), false);
});

test('immediate lifecycle events and threshold start non-awaited delivery', async t => {
  let release;
  const started = new Promise(resolve => { release = resolve; });
  const { create } = await fixture(t, { handler: async () => { release(); } });
  const queue = create();
  assert.equal(queue.enqueue({ value: 1 }, { event: 'session-start' }), true);
  await started;
  await queue.flush();
  assert.equal(queue.status.pending, 0);
});

test('replay recovers a complete atomic spool temporary left by a dead process', async t => {
  const delivered = [];
  const { create } = await fixture(t, { handler: async value => { delivered.push(value.text); } });
  const queue = create();
  await queue.replayPending();
  const id = `${String(Date.now()).padStart(16, '0')}-0000000001-01234567-1234-4321-9876-123456789abc`;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(queue.pendingDirectory, `${id}.json.2147483647.recovery.tmp`), JSON.stringify({ version: 1, id, payload: { text: 'recover me' } }), { mode: 0o600 });
  assert.equal(await queue.replayPending(), true);
  assert.deepEqual(delivered, ['recover me']);
});

test('two queue instances sharing an identity never dispatch a record concurrently', async t => {
  let release;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const delivered = [];
  const { create } = await fixture(t);
  const first = create({ handler: async value => { delivered.push(value.index); started(); await new Promise(resolve => { release = resolve; }); } });
  const second = create({ handler: async () => assert.fail('another live owner holds queue lease') });
  first.enqueue({ index: 1 });
  const drain = first.flush();
  await waiting;
  assert.equal(await second.flush(), false);
  release();
  assert.equal(await drain, true);
  assert.deepEqual(delivered, [1]);
});

const syncKey = payload => payload.kind === 'sync' ? payload.sessionId : null;
async function pendingRecords(queue) {
  const files = (await readdir(queue.pendingDirectory)).filter(file => file.endsWith('.json')).sort();
  return Promise.all(files.map(async file => JSON.parse(await readFile(join(queue.pendingDirectory, file), 'utf8')).payload));
}

test('consecutive sync snapshots coalesce per session without crossing hook or session boundaries', async t => {
  const { create } = await fixture(t, { coalesceKey: syncKey, handler: async () => { throw new Error('offline'); } });
  const queue = create();
  const records = [
    {kind: 'sync', sessionId: 'a', revision: 1}, {kind: 'sync', sessionId: 'a', revision: 2},
    {kind: 'hook', sessionId: 'a'}, {kind: 'sync', sessionId: 'a', revision: 3},
    {kind: 'sync', sessionId: 'b', revision: 1}, {kind: 'sync', sessionId: 'b', revision: 2},
  ];
  for (const record of records) queue.enqueue(record);
  await queue.flush();
  assert.deepEqual(await pendingRecords(queue), [records[1], records[2], records[3], records[5]]);
  assert.equal(queue.status.pending, 4);
});

test('byte and age budgets drop oldest syncs with an observable counter during an outage', async t => {
  const errors = [];
  const { create } = await fixture(t, {coalesceKey: syncKey, maxBytes: 1500, maxAgeMs: 60_000,
    onError: code => errors.push(code), handler: async () => { throw new Error('offline'); }});
  const queue = create();
  queue.enqueue({kind: 'sync', sessionId: 'old', text: 'a'.repeat(800)});
  queue.enqueue({kind: 'hook', event: 'barrier'});
  queue.enqueue({kind: 'sync', sessionId: 'new', text: 'b'.repeat(800)});
  await queue.flush();
  assert.deepEqual((await pendingRecords(queue)).map(record => record.sessionId ?? record.event), ['barrier', 'new']);
  assert.equal(queue.status.dropped, 1);
  assert.ok(queue.status.bytes <= 1500);
  assert.ok(errors.includes('spool_budget_drop'));
  await queue.dispose(50);
  const { writeFile } = await import('node:fs/promises');
  const id = '0001750000000000-0000000001-01234567-1234-4321-9876-123456789abc';
  await writeFile(join(queue.pendingDirectory, `${id}.json`), JSON.stringify({version: 1, id, payload: {kind: 'sync', sessionId: 'expired'}}));
  const restarted = create();
  await restarted.replayPending();
  assert.equal(restarted.status.dropped, 1);
  assert.equal((await pendingRecords(restarted)).some(record => record.sessionId === 'expired'), false);
});
