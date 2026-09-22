import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CapturePolicy} from '../src/capture-policy.ts';
import {resolveWorkspace} from '../src/workspace.ts';

const route={root:'/repo',capture:{allowPaths:[],ignorePaths:[]}};
test('review: shell secret-file reads suppress paired opaque output',()=>{
  const policy=new CapturePolicy({captureMode:'denylist'},route);
  for(const command of ['cat /repo/.env','cat /repo/config/credentials.json']) assert.equal(policy.allows({command}),false);
  assert.equal(policy.filterEntry({message:{role:'assistant',content:[{type:'toolCall',id:'opaque-secret',name:'bash',arguments:{command:'cat /repo/.env'}}]}}),null);
  assert.equal(policy.filterEntry({message:{role:'toolResult',toolCallId:'opaque-secret',content:[{type:'text',text:'opaque-value-with-no-key-label'}]}}),null);
});
test('review: allowed shell working directory cannot authorize unknown command paths',()=>{
  const policy=new CapturePolicy({captureMode:'allowlist',captureAllowlist:['src/**']},route);
  assert.equal(policy.allows({cwd:'/repo/src/lib',command:'cat /private/unlisted.txt'}),false);
});
test('review: custom denied paths also apply to shell captures',()=>{
  const policy=new CapturePolicy({captureMode:'denylist',captureDenylist:['sensitive/**']},route);
  assert.equal(policy.allows({command:'cat /repo/sensitive/customer-export.csv'}),false);
});
test('review: directory strategy keeps equal basenames in different folders isolated',t=>{
  const dir=mkdtempSync(join(tmpdir(),'ov-directory-isolation-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'.git'));mkdirSync(join(dir,'apps','client'),{recursive:true});mkdirSync(join(dir,'examples','client'),{recursive:true});
  writeFileSync(join(dir,'.ov-memory.toml'),'project_strategy="directory"\n');
  assert.notEqual(resolveWorkspace(join(dir,'apps','client')).scopeKey,resolveWorkspace(join(dir,'examples','client')).scopeKey);
});
