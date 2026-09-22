import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CapturePolicy } from '../src/capture-policy.ts';
import { RecallManager } from '../src/recall.ts';
import { RecallLedger } from '../src/ledger.ts';
import { loadConfig } from '../src/config.ts';

const route = { root: '/repo', capture: { allowPaths: [], ignorePaths: [] } };

test('review integration: standard authorization schemes never reach captured hooks or paired results', () => {
  for (const authorization of ['Bearer opaque_token_1234567890', 'Basic dXNlcjpwYXNzd29yZA==']) {
    const policy = new CapturePolicy({ captureMode: 'denylist' }, route);
    for (const value of [{ content: `Authorization: ${authorization}` }, { headers: { Authorization: authorization } }, { command: `curl -H "Authorization: ${authorization}" https://example.com` }]) {
      assert.equal(policy.allows(value), false, 'standard Authorization credentials must be excluded');
    }
    assert.equal(policy.filterHook({ toolCallId: 'credential-request', input: { headers: { Authorization: authorization } } }), null);
    assert.equal(policy.filterHook({ toolCallId: 'credential-request', content: 'opaque response' }), null);
  }
});

test('review integration: recall rejects malformed URI prefixes before content is injected', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ov-review-scope-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cfg = loadConfig(undefined, { home, env: {} });
  const root = 'viking://user/me/omp-ov-memory/sessions/1234567890abcdef';
  const client = {
    userRoot: root, memorySpace: root.slice('viking://user/'.length), recordedEventTarget: {},
    fetchJSON: async () => ({ ok: true, result: { entries: [
      { uri: `${root}/../other/memories/secret`, text: 'OUTSIDE_DOT_SEGMENT', category: 'events', score: .9 },
      { uri: `${root}/%2e%2e/other/memories/secret`, text: 'OUTSIDE_ENCODED_SEGMENT', category: 'events', score: .9 },
      { uri: `${root}/memories/good`, text: 'VALID_SCOPED_NOTE', category: 'events', score: .9 },
    ] } }),
  };
  const ledger = new RecallLedger(home, 'scope-review');
  const recall = new RecallManager(client, cfg, () => 'test-session', undefined, ledger);
  const messages = [{ role: 'user', content: 'explain project', timestamp: 1 }];
  recall.queueSearch('explain project');
  await recall.searchPending(messages);
  const result = JSON.stringify(recall.injectRecall(messages));
  await ledger.flush();
  assert.doesNotMatch(result, /OUTSIDE_DOT_SEGMENT|OUTSIDE_ENCODED_SEGMENT/);
  assert.match(result, /VALID_SCOPED_NOTE/);
});

test('review integration: equal harness IDs in different scoped workspaces have different native sessions', async t => {
  const { OVClient } = await import('../src/client.ts');
  const { SyncManager } = await import('../src/sync.ts');
  const home = await mkdtemp(join(tmpdir(), 'ov-review-native-session-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cfg = loadConfig(undefined, { home, env: { OPENVIKING_USER: 'same-authenticated-user' }, config: { stateDir: join(home, 'state') } });
  const clientA = new OVClient(cfg), clientB = new OVClient(cfg);
  clientA.bindScope('a'.repeat(24)); clientB.bindScope('b'.repeat(24));
  const syncA = new SyncManager(clientA), syncB = new SyncManager(clientB);
  try {
    await syncA.ensureSession('shared-explicit-session-id');
    await syncB.ensureSession('shared-explicit-session-id');
    assert.notEqual(clientA.userRoot, clientB.userRoot);
    assert.notEqual(syncA.sessionId, syncB.sessionId, 'native context/mirror/commit must retain the same isolation as scoped content');
  } finally {
    await Promise.all([syncA.stopBackground(), syncB.stopBackground(), clientA.close(true), clientB.close(true)]);
  }
});
