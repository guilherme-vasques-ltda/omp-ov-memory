import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecallLedger } from '../src/ledger.ts';

test('historical recall is byte-stable across reloads and does not mutate source', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ov-ledger-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const a=new RecallLedger(dir,['tenant','session']);
  const first=[{role:'user',content:'hello',timestamp:1}];
  const firstKey=[...a.turnKeys(first).values()][0]; a.record(firstKey,'<context>exact\n bytes</context>');
  const initial=a.apply(first); assert.equal(first[0].content,'hello');
  assert.deepEqual(a.apply(initial),initial); await a.flush();
  const b=new RecallLedger(dir,['tenant','session']);await b.load();
  const second=[...first,{role:'assistant',content:[]},{role:'user',content:[{type:'text',text:'hello'},{type:'image',data:'unchanged'}],timestamp:2}];
  const keys=[...b.turnKeys(second).values()];b.record(keys[1],'new context');
  const applied=b.apply(second);assert.equal(applied[0].content,initial[0].content);assert.equal(applied[2].content[1].data,'unchanged');
  assert.equal(b.record(firstKey,'different retrieval'),'<context>exact\n bytes</context>');
  await b.flush(); assert.equal((await stat(a.directory)).mode&0o777,0o700);
  for(const name of await readdir(a.directory))assert.equal((await stat(join(a.directory,name))).mode&0o777,0o600);
  const other=new RecallLedger(dir,['other-tenant','session']); await other.load(); assert.equal(other.get(firstKey),undefined);
});
test('empty retrieval stays empty, repeated prompts have distinct identity',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'ov-empty-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const a=new RecallLedger(dir,'x'), messages=[{role:'user',content:'again'},{role:'user',content:'again'}];
  const keys=[...a.turnKeys(messages).values()]; assert.notEqual(keys[0],keys[1]); a.record(keys[0],'');
  assert.equal(a.record(keys[0],'late'), ''); await a.flush();
});
