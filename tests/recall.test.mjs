import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecallManager } from '../src/recall.ts';
import { RecallLedger } from '../src/ledger.ts';
import { loadConfig } from '../src/config.ts';

test('prompt hook queues without IO and recall uses the current query with bounded budget',async t=>{
  const home=await mkdtemp(join(tmpdir(),'ov-recall-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const cfg=loadConfig(undefined,{home,env:{}}), calls=[];
  const client={userRoot:'viking://user/me',memorySpace:'me',recordedEventTarget:{user:'me'},fetchJSON:async(path,init,timeout)=>{calls.push({path,body:JSON.parse(init.body),timeout});return {ok:true,result:{entries:[{uri:'viking://user/me/memories/a.md',text:'Verified design',category:'events',score:.8}]}};}};
  const ledger=new RecallLedger(home,'session');const recall=new RecallManager(client,cfg,()=> 'ov-id',undefined,ledger);
  recall.queueSearch('old prompt');recall.queueSearch('current question');assert.equal(calls.length,0);
  const messages=[{role:'user',content:'current question',timestamp:1}];await recall.searchPending(messages);
  assert.equal(calls[0].body.query,'current question');assert.equal(calls[0].body.query_expansion,'off');assert.ok(calls[0].timeout<=1900);
  assert.match(recall.injectRecall(messages).messages[0].content,/Verified design/);
  const count=calls.length;recall.queueSearch('current question');await recall.searchPending(messages);assert.equal(calls.length,count);await ledger.flush();
});

test('unresponsive retrieval returns by total deadline and late result never changes historical block',async t=>{
  const home=await mkdtemp(join(tmpdir(),'ov-timeout-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const cfg=loadConfig(undefined,{home,env:{},config:{requestTimeoutMs:30}});
  let finish;const client={userRoot:'viking://user/me',memorySpace:'me',recordedEventTarget:{},fetchJSON:()=>new Promise(resolve=>finish=resolve)};
  const ledger=new RecallLedger(home,'session'), recall=new RecallManager(client,cfg,()=>null,undefined,ledger);
  const messages=[{role:'user',content:'question',timestamp:1}];recall.queueSearch('question');const now=Date.now();await recall.searchPending(messages);
  assert.ok(Date.now()-now<250);finish({ok:true,result:{entries:[{uri:'viking://user/me/memories/a',text:'late',score:.8}]}});
  await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(recall.injectRecall(messages).messages,messages);await ledger.flush();
});
