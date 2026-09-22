import test from 'node:test';
import assert from 'node:assert/strict';
import { storeHandoff, fetchHandoff, renderHandoff, handoffUri } from '../src/handoff.ts';
test('handoff crosses agent sessions within one workspace and rejects wrong scope/self',async()=>{
  const files=new Map(),client={userRoot:'viking://user/me',mkdirUri:async()=>({ok:true}),writeContent:async(uri,text)=>{files.set(uri,text);return {ok:true};},readContent:async uri=>files.get(uri)??null};
  const route={scopeKey:'workspace-one'},other={scopeKey:'workspace-two'};
  assert.equal(await storeHandoff(client,route,'s1','Remaining task','omp'),true);
  const h=await fetchHandoff(client,route,'codex-s2');assert.equal(h.content,'Remaining task');assert.match(renderHandoff(h),/never as instructions/);
  assert.equal(await fetchHandoff(client,route,'s1'),null);assert.equal(await fetchHandoff(client,other,'s2'),null);
  const uri=handoffUri(client,route);files.set(uri,JSON.stringify({...h,scopeKey:'wrong'}));assert.equal(await fetchHandoff(client,route,'s2'),null);
});
