import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspace, deriveMemoryNamespace, isBypassed } from '../src/workspace.ts';

test('nearest marker routes monorepo children and validates capture TOML', t => {
  const root = mkdtempSync(join(tmpdir(), 'ov-routing-')); t.after(() => rmSync(root, { recursive:true, force:true }));
  mkdirSync(join(root, '.git')); mkdirSync(join(root,'apps','web'),{recursive:true});
  writeFileSync(join(root,'.ov-memory.toml'), 'workspace="team"\nproject="app"\n[capture]\nignore_paths=["secrets/**"]\n');
  const a=resolveWorkspace(root), b=resolveWorkspace(join(root,'apps','web'));
  assert.equal(a.scopeKey,b.scopeKey); assert.equal(a.peerId,b.peerId); assert.deepEqual(a.capture.ignorePaths,['secrets/**']);
  writeFileSync(join(root,'apps','.ov-memory.toml'),'workspace="team"\nproject="frontend"');
  assert.notEqual(resolveWorkspace(join(root,'apps','web')).scopeKey,a.scopeKey);
  assert.notEqual(deriveMemoryNamespace('me','session-a',a),deriveMemoryNamespace('me','session-b',a));
});

test('linked worktrees share repository scope but unrelated same basenames do not', t => {
  const root=mkdtempSync(join(tmpdir(),'ov-worktrees-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const main=join(root,'repo'), work=join(root,'work'); mkdirSync(join(main,'.git','worktrees','work'),{recursive:true}); mkdirSync(work);
  writeFileSync(join(work,'.git'),`gitdir: ${join(main,'.git','worktrees','work')}\n`);
  writeFileSync(join(main,'.git','worktrees','work','commondir'),'../..\n');
  assert.equal(resolveWorkspace(main).scopeKey,resolveWorkspace(work).scopeKey);
  const other=join(root,'other','repo'); mkdirSync(join(other,'.git'),{recursive:true});
  assert.notEqual(resolveWorkspace(main).scopeKey,resolveWorkspace(other).scopeKey);
});

test('malformed routing fails closed and explicit peer wins', t => {
  const root=mkdtempSync(join(tmpdir(),'ov-marker-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  assert.equal(resolveWorkspace(root,{peerId:'explicit'}).peerId,'explicit');
  writeFileSync(join(root,'.ov-memory.toml'),'workspace="../bad"'); assert.throws(()=>resolveWorkspace(root),/Invalid/);
  assert.equal(isBypassed('/tmp/private/project',['/tmp/private']),true);
  assert.equal(isBypassed('/tmp/private-ish',['/tmp/private']),false);
});
