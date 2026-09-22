// Explicit live integration check. Creates only disposable fixture objects and removes them.
// Uses normal credential discovery; never prints configuration or authentication headers.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { OVClient } from '../src/client.ts';
import { SyncManager } from '../src/sync.ts';
import { SessionMirror } from '../src/session-mirror.ts';
import { createTools } from '../src/tools.ts';
import { resolveWorkspace, deriveSessionScope } from '../src/workspace.ts';
import { fetchHandoff, handoffUri, storeHandoff } from '../src/handoff.ts';
import { textFromContext } from '../src/runtime.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { openVikingApiPath } from '../src/shared/openviking-api.mjs';

const stateDir = await mkdtemp(join(tmpdir(), 'omp-ov-live-'));
const sessionId = `fixture-${randomUUID()}`;
const config = loadConfig(undefined, {config: {stateDir}});
const shared = new OVClient(config), client = new OVClient(config);
// OV v0.4.20 accepts resource ingestion only in its canonical resources namespace.
const resourceClient = new OVClient({...config, sessionScopedMemory: false});
const route = {...resolveWorkspace(process.cwd()), scopeKey: createHash('sha256').update(sessionId).digest('hex').slice(0,24)};
client.bindScope(deriveSessionScope(sessionId, route));
const sync = new SyncManager(client, {stateDir, namespaceKey: route.scopeKey});
let scopeRoot, handoffRoot, resourceRoot, nativeId;
const checks = {};
async function run() {
try {
  if (!await client.health()) {
    console.log(JSON.stringify({liveSmoke: 'skipped', reason: 'OpenViking is unavailable'}));
    return;
  }
  checks.health = true;
  const user = await shared.resolveUserSpace();
  assert.ok(user, 'authenticated user discovery failed');
  shared.bindUser(user); client.bindUser(user); resourceClient.bindUser(user);
  scopeRoot = client.userRoot;
  handoffRoot = handoffUri(shared, route).replace(/\/latest\.json$/, '');
  checks.authenticatedIdentity = true;

  const tools = new Map(createTools(client, sync).map(tool => [tool.name, tool]));
  const invoke = async (name, args) => {
    const result = await tools.get(name).execute('fixture', args);
    assert.notEqual(result.isError, true, `${name} failed: ${result.content?.[0]?.text}`);
    return result;
  };
  const uri = `${scopeRoot}/notes/fixture.txt`;
  await invoke('viking_write', {uri, content: 'Inert integration fixture alpha.'});
  await invoke('viking_edit', {uri, old_text: 'alpha', new_text: 'beta'});
  const read = await invoke('viking_read', {uri,level:'full'});
  assert.match(JSON.stringify(read), /fixture beta/);
  await invoke('viking_tree', {uri: scopeRoot, depth: 3, limit: 50});
  checks.writeEditReadTree = true;

  // Both writes happen once; only read-only search is polled while OV indexes.
  const remembered = await invoke('viking_remember', {content: `Disposable lunar greenhouse fixture ${sessionId}: violet basil requires ceramic pots.`, category: 'event'});
  const rememberedUri = remembered.details.uri;
  const deadline = Date.now() + 90_000;
  let searchable = false;
  do {
    const found = await invoke('viking_search', {query: `lunar greenhouse violet basil ceramic pots ${sessionId}`, limit: 100});
    searchable = JSON.stringify(found).includes(rememberedUri);
    if (!searchable) await delay(1000);
  } while (!searchable && Date.now() < deadline);
  assert.equal(searchable, true, 'scoped remembered note must be retrievable by semantic search');
  checks.scopedRememberSearch = true;

  await resourceClient.health();
  const upload = resourceClient.uploadResource.bind(resourceClient);
  resourceClient.uploadResource = (bytes, filename, options) => {
    resourceRoot = options.to; // Retain the exact disposable target even on an uncertain write.
    return upload(bytes, filename, options);
  };
  const resourceTools = new Map(createTools(resourceClient, null).map(tool => [tool.name, tool]));
  const imported = await resourceTools.get('viking_add_resource').execute('fixture', {url: 'https://example.com/', reason: 'Disposable integration fixture'});
  assert.notEqual(imported.isError, true, 'multipart resource import must succeed');
  assert.equal(imported.details.root_uri, resourceRoot);
  const importDeadline = Date.now() + 90_000;
  let importedText = false;
  do {
    for (const file of await resourceClient.ls(resourceRoot)) {
      if (file.isDir) continue;
      const read = await resourceTools.get('viking_read').execute('fixture', {uri: file.uri, level: 'full'});
      if (!read.isError && JSON.stringify(read).includes('Example Domain')) importedText = true;
    }
    if (!importedText) await delay(1000);
  } while (!importedText && Date.now() < importDeadline);
  assert.equal(importedText, true, 'multipart uploaded bytes must be readable before cleanup');
  checks.multipartResourceRead = {unscoped: true};

  assert.equal(await storeHandoff(shared, route, sessionId, 'Disposable cross-agent handoff.'), true);
  assert.equal(await fetchHandoff(shared, route, sessionId), null);
  const handoff = await fetchHandoff(shared, route, `${sessionId}-next`);
  assert.equal(handoff?.content, 'Disposable cross-agent handoff.');
  checks.crossSessionHandoff = true;

  await sync.ensureSession(sessionId); nativeId = sync.sessionId;
  const entries = [{type:'message',id:'fixture-entry',parentId:null,timestamp:new Date().toISOString(),message:{role:'user',content:'Inert native mirror fixture.'}}];
  const source = {isPersisted:()=>false,getEntries:()=>entries,getBranch:()=>entries,getLeafId:()=>entries[0].id};
  const first = await sync.syncBranch(source);
  assert.equal(first.allDelivered, true); assert.equal(first.added, 1);
  const replay = await sync.syncBranch(source);
  assert.equal(replay.allDelivered, true); assert.equal(replay.added, 0);
  checks.immutableSync = {firstAdded:first.added,replayAdded:replay.added};

  assert.equal(await client.createSession(nativeId), true);
  const mirror = new SessionMirror(client, stateDir, nativeId);
  assert.equal(await mirror.sync(entries), true);
  const restarted = new SessionMirror(client, stateDir, nativeId);
  assert.equal(await restarted.sync(entries), true);
  const native = await client.getSession(nativeId);
  assert.equal(native.result?.message_count, 1); assert.equal(native.result?.commit_count, 0);
  const context = await client.getSessionContext(nativeId);
  assert.match(textFromContext(context.result), /Inert native mirror fixture/);
  checks.nativeMirror = {messageCount:1,commitCount:0,restartConfirmed:restarted.status.confirmed};
  await invoke('viking_forget', {uri});
  assert.equal(await client.readContent(uri), null);
  checks.forget = true;
  console.log(JSON.stringify({liveSmoke:checks}));
} finally {
  await sync.stopBackground();
  let cleanup = true;
  if (resourceRoot) {
    // Search can succeed while ingestion still owns the resource. Cancel only
    // tasks for this exact disposable target before deleting it.
    const tasks = await resourceClient.fetchJSON(openVikingApiPath(`/tasks?${new URLSearchParams({task_type: 'add_resource', resource_id: resourceRoot, limit: '100'})}`));
    cleanup &&= tasks.ok && Array.isArray(tasks.result);
    for (const task of (Array.isArray(tasks.result) ? tasks.result : [])) {
      if (task.resource_id !== resourceRoot || task.task_type !== 'add_resource') continue;
      const terminal = ['completed', 'failed', 'cancelled'];
      if (!terminal.includes(task.status)) {
        await resourceClient.cancelTask(task.task_id);
        const deadline = Date.now() + 10_000;
        let status;
        do {
          status = (await resourceClient.getTask(task.task_id)).result?.status;
          if (!terminal.includes(status)) await delay(250);
        } while (!terminal.includes(status) && Date.now() < deadline);
        cleanup &&= terminal.includes(status);
      }
    }
  }
  if (nativeId) {
    await client.deleteSession(nativeId);
    const result = await client.getSession(nativeId);
    cleanup &&= !result.ok && result.status === 404;
  }
  for (const root of [scopeRoot,handoffRoot,resourceRoot].filter(Boolean)) {
    await shared.delete(root, true);
    const result = await shared.statUri(root);
    cleanup &&= result.ok && result.exists === false;
  }
  await Promise.all([client.close(true),shared.close(true),resourceClient.close(true)]);
  await rm(stateDir,{recursive:true,force:true});
  console.log(JSON.stringify({cleanupConfirmed:cleanup, ...(!cleanup ? {fixtureRoots: [scopeRoot,handoffRoot,resourceRoot].filter(Boolean)} : {})}));
  if (!cleanup) process.exitCode = 1;
}
}
await run();
