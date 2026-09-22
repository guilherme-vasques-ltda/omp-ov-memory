import test from 'node:test';
import assert from 'node:assert/strict';
import { CapturePolicy, matchesCapturePattern } from '../src/capture-policy.ts';
const route={root:'/repo',capture:{allowPaths:[],ignorePaths:[]}};
test('secret files, inline credentials and denied tool result pairs never capture',()=>{
  const p=new CapturePolicy({captureMode:'denylist'},route);
  assert.equal(p.allows({path:'/repo/.env.production'}),false);
  assert.equal(p.allows({text:'api_key = abcdefghijk12345'}),false);
  assert.equal(p.filterHook({toolCallId:'secret',input:{path:'/repo/.ssh/id_rsa'}}),null);
  assert.equal(p.filterEntry({type:'message',message:{role:'toolResult',toolCallId:'secret',content:'opaque secret'}}),null);
  assert.ok(p.filterEntry({type:'message',message:{role:'user',content:'Fix the build'}}));
});
test('JSONL assistant calls enforce denial even without tool hooks',()=>{
  const p=new CapturePolicy({captureMode:'denylist'},route);
  assert.equal(p.filterEntry({type:'message',message:{role:'assistant',content:[{type:'toolCall',id:'id',name:'read',arguments:{path:'.env'}}]}}),null);
  assert.equal(p.filterEntry({type:'message',message:{role:'toolResult',toolCallId:'id',content:'raw-value'}}),null);
});
test('authorization schemes and prefixed environment secrets are denied',()=>{
  const p=new CapturePolicy({captureMode:'denylist'},route);
  for(const value of [{content:'Authorization: Bearer opaque_token_1234567890'}, {headers:{Authorization:'Bearer opaque_token_1234567890'}}, {command:'curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA==" https://example.com'}, {content:'OPENVIKING_API_KEY=opaque_token_1234567890'}]) assert.equal(p.allows(value),false);
});
test('allowlist denies unknown/missing/mixed paths and denylist always wins',()=>{
  const p=new CapturePolicy({captureMode:'allowlist',captureAllowlist:['src/**'],captureDenylist:['src/secrets/**']},route);
  assert.equal(p.allows({input:{path:'src/app.ts'}}),true);
  assert.equal(p.allows({input:{paths:['src/app.ts','outside.txt']}}),false);
  assert.equal(p.allows({input:{path:'src/secrets/key.txt'}}),false);
  assert.equal(p.allows({input:{command:'cat whatever'}}),false);
  assert.equal(matchesCapturePattern('a/.env','**/.env'),true);
  assert.equal(matchesCapturePattern('.env','**/.env'),true);
  assert.equal(matchesCapturePattern('src/a/b.ts','src/*.ts'),false);
});
