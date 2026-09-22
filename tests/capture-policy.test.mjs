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

test('filtering seen immutable IDs serializes only new entries and keeps late tool denials', t => {
  const policy = new CapturePolicy({captureMode: 'denylist'}, route);
  let serialized = 0;
  const entry = id => ({id, type: 'message', message: {role: 'user', content: 'ordinary text'},
    toJSON() { serialized++; return {id: this.id, type: this.type, message: this.message}; }});
  const entries = Array.from({length: 1000}, (_, i) => entry(String(i)));
  entries.forEach(value => assert.ok(policy.filterEntry(value)));
  const firstPass = serialized;
  const stringify = t.mock.method(JSON, 'stringify');
  entries.forEach(value => assert.ok(policy.filterEntry(value)));
  assert.equal(serialized, firstPass, 'already-seen entries must not stringify or rescan');
  assert.equal(stringify.mock.callCount(), 0);
  policy.filterEntry(entry('new'));
  assert.equal(serialized, firstPass + 1);
  assert.equal(stringify.mock.callCount(), 1);
  const result = {id: 'result', message: {role: 'toolResult', toolCallId: 'later', content: 'opaque'}};
  assert.ok(policy.filterEntry(result));
  policy.filterHook({toolCallId: 'later', input: {path: '.env'}});
  assert.equal(policy.filterEntry(result), null);
  const stricter = new CapturePolicy({captureMode: 'off'}, route);
  assert.equal(stricter.filterEntry(entries[0]), null, 'cache cannot survive a policy change');
});

test('default capture denies credential files and common provider token formats', () => {
  const policy = new CapturePolicy({captureMode: 'denylist'}, route);
  for (const path of ['.netrc', '.npmrc', '.pgpass', '.kube/config', '.docker/config.json', 'cert.pem', 'cert.p12', 'private.key']) {
    assert.equal(policy.allows({path: `/repo/${path}`}), false, path);
    assert.equal(policy.allows({command: `cat /repo/${path}`}), false, path);
  }
  for (const content of ['_authToken=fixturetoken123', 'xoxb-123456789-abcdef', 'xoxp-123456789-abcdef', `AKIA${'A'.repeat(16)}`, `AIza${'a'.repeat(35)}`, 'glpat-abcdefghijklmnopqrst']) {
    assert.equal(policy.allows({content}), false, 'provider credential must be denied');
  }
  for (const path of ['src/key.ts', 'docs/npmrc.md', 'config/docker.json']) assert.equal(policy.allows({path}), true);
});
