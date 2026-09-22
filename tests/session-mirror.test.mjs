import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionMirror } from '../src/session-mirror.ts';

const entry = (id, text, role = 'user') => ({id, type:'message', timestamp:'2026-09-21T00:00:00.000Z', message:{role,content:[{type:'text',text}]}});
const ok = result => ({ok:true,status:200,result});
const fail = status => ({ok:false,status,result:null});
async function fixture(t) {
 const stateDir=await mkdtemp(join(tmpdir(),'omp-mirror-test-'));
 t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const remote={messages:[],archives:new Map(),posts:0,unknownWrite:false,omitWrite:false,contextOffline:false,archivesOffline:false,mutation:0,trace:[],commitRequests:0,unknownCommit:false,omitCommit:false};
 const client={cfg:{peerId:'omp-test'},baseUserRoot:'viking://user/test',recordedEventTarget:{endpoint:'http://localhost:1933',account:'test',user:'test'},async fetchJSON(path,init){
  remote.trace.push(path);
  const url=new URL(path,'http://localhost');
  if(path.endsWith('/commit')&&init?.method==='POST') {
   remote.commitRequests++;
   if(!remote.omitCommit&&remote.messages.length){remote.archives.set('archive_'+String(remote.archives.size+1).padStart(3,'0'),remote.messages);remote.messages=[];remote.mutation++;}
   return remote.unknownCommit?fail(0):ok({session_id:'ov-test',status:'accepted',archived:true});
  }
  if(path.endsWith('/messages')&&init?.method==='POST') {
   remote.posts++;const body=JSON.parse(init.body);
   if(!remote.omitWrite) remote.messages.push({...body,id:`remote-${++remote.mutation}`,parts:[{type:'text',text:body.content}]});
   return remote.unknownWrite?fail(0):ok({message_count:remote.messages.length});
  }
  if(url.pathname.endsWith('/context')) return remote.contextOffline?fail(0):ok({messages:url.searchParams.get('token_budget')==='0'||remote.contextTruncated?[]:remote.messages,stats:{totalArchives:remote.archives.size,failedArchives:0}});
  if(url.pathname==='/api/v1/content/read') {
   const uri=url.searchParams.get('uri');const archive=/history\/(archive_\d+)\/messages.jsonl/.exec(uri);
   return ok((archive?remote.archives.get(archive[1]):remote.messages).map(message=>JSON.stringify(message)).join('\n'));
  }
  if(url.pathname==='/api/v1/fs/ls') return remote.archivesOffline?fail(0):ok([...remote.archives.keys()].map(name=>({name,isDir:true})));
  if(url.pathname.includes('/archives/')) return remote.archivePending?fail(404):remote.archivesOffline?fail(0):ok({archive_id:url.pathname.split('/').at(-1),messages:remote.archives.get(url.pathname.split('/').at(-1))});
  if(url.pathname==='/api/v1/sessions/ov-test') return ok({session_id:'ov-test',uri:'viking://user/test/sessions/ov-test',created_at:'2026-09-21T00:00:00Z',updated_at:String(remote.mutation),message_count:remote.messages.length,total_message_count:remote.messages.length+[...remote.archives.values()].reduce((n,a)=>n+a.length,0),commit_count:remote.archives.size});
  throw new Error(`unexpected test request ${path}`);
 }};
 const create=()=>new SessionMirror(client,stateDir,'ov-test');
 return {stateDir,create,remote,client};
}

test('native mirror appends text once and persists only private hashed metadata',async t=>{
 const {create,remote}=await fixture(t);const mirror=create();
 const entries=[entry('a','private transcript text'),entry('b','reply','assistant')];
 assert.equal(await mirror.sync(entries),true);assert.equal(remote.posts,2);
 assert.equal(await mirror.sync(entries),true);assert.equal(remote.posts,2);
 assert.equal(remote.messages[0].message_kind,'user_query');assert.equal(remote.messages[1].message_kind,'assistant_step');
 assert.equal(remote.messages[0].turn_id,remote.messages[1].turn_id);
 assert.equal(mirror.status.unknown,0);
 assert.equal((await stat(mirror.directory)).mode&0o777,0o700);
 for(const file of await readdir(mirror.directory)){const p=join(mirror.directory,file);assert.equal((await stat(p)).mode&0o777,0o600);assert.doesNotMatch(await readFile(p,'utf8'),/private transcript text|reply/);}
});

test('uncertain committed append reconciles after restart without another append',async t=>{
 const {create,remote}=await fixture(t);remote.unknownWrite=true;
 assert.equal(await create().sync([entry('a','one')]),false);assert.equal(remote.posts,1);
 remote.unknownWrite=false;const restarted=create();
 assert.equal(await restarted.sync([entry('a','one')]),true);assert.equal(remote.posts,1);assert.equal(restarted.status.unknown,0);
});

test('absence after uncertain append remains UNKNOWN and never blindly retries',async t=>{
 const {create,remote}=await fixture(t);remote.unknownWrite=true;remote.omitWrite=true;
 assert.equal(await create().sync([entry('a','one')]),false);
 remote.unknownWrite=false;remote.omitWrite=false;
 const restarted=create();assert.equal(await restarted.sync([entry('a','one')]),false);
 assert.equal(remote.posts,1);assert.equal(restarted.status.unknown,1);assert.equal(restarted.status.lastError,'MIRROR_OUTCOME_UNKNOWN');
 assert.equal(await restarted.sync([]),false,'a removed branch cannot hide an unresolved native append');
});

test('positive HTTP append with interrupted readback is reconciled from archive on restart',async t=>{
 const {create,remote,client}=await fixture(t);const original=client.fetchJSON;
 client.fetchJSON=async(path,init)=>{const response=await original.call(client,path,init);if(init?.method==='POST') remote.contextOffline=true;return response;};
 assert.equal(await create().sync([entry('a','archived')]),false);assert.equal(remote.posts,1);
 remote.archives.set('archive_001',remote.messages);remote.messages=[];remote.mutation++;remote.contextOffline=false;
 const restarted=create();assert.equal(await restarted.sync([entry('a','archived')]),true);assert.equal(remote.posts,1);
 assert.ok(remote.trace.some(path=>path.includes('/archives/archive_001')));
});

test('incomplete archive coverage prevents a new append',async t=>{
 const {create,remote}=await fixture(t);remote.archives.set('archive_001',[]);remote.archivesOffline=true;
 assert.equal(await create().sync([entry('a','one')]),false);assert.equal(remote.posts,0);
});

test('source ID reuse with different content fails closed',async t=>{
 const {create,remote}=await fixture(t);const mirror=create();
 assert.equal(await mirror.sync([entry('a','one')]),true);
 assert.equal(await mirror.sync([entry('a','changed')]),false);assert.equal(remote.posts,1);
 assert.equal(mirror.status.lastError,'MIRROR_CONTENT_CONFLICT');
});

test('concurrent instances use exclusive intent to prevent duplicate native append',async t=>{
 const {create,remote}=await fixture(t);const entries=[entry('a','one')];
 await Promise.all([create().sync(entries),create().sync(entries)]);
 assert.equal(remote.posts,1);assert.equal(await create().sync(entries),true);
});

test('guarded commit persists one confirmed source watermark and skips duplicate extraction',async t=>{
 const {create,remote}=await fixture(t);const mirror=create();
 assert.equal(await mirror.sync([entry('a','one')]),true);
 assert.equal(await mirror.commit(),true);assert.equal(remote.commitRequests,1);
 assert.equal(await create().commit(),true);assert.equal(remote.commitRequests,1);
 assert.equal(await mirror.sync([entry('a','one'),entry('b','two')]),true);
 assert.equal(await mirror.commit(),true);assert.equal(remote.commitRequests,2);
});

test('uncertain applied commit resolves only from observed native commit_count increase',async t=>{
 const {create,remote}=await fixture(t);const mirror=create();
 assert.equal(await mirror.sync([entry('a','one')]),true);remote.unknownCommit=true;
 assert.equal(await mirror.commit(),false);assert.equal(mirror.status.commitUnknown,true);
 remote.unknownCommit=false;const restarted=create();
 assert.equal(await restarted.commit(),true);assert.equal(remote.commitRequests,1);assert.equal(restarted.status.commitUnknown,false);
});

test('unresolved commit blocks repeated commits and newer appends',async t=>{
 const {create,remote}=await fixture(t);const mirror=create();
 assert.equal(await mirror.sync([entry('a','one')]),true);remote.unknownCommit=true;remote.omitCommit=true;
 assert.equal(await mirror.commit(),false);remote.unknownCommit=false;remote.omitCommit=false;
 const restarted=create();assert.equal(await restarted.commit(),false);
 assert.equal(await restarted.sync([entry('a','one'),entry('b','two')]),false);
 assert.equal(remote.commitRequests,1);assert.equal(remote.posts,1);assert.equal(restarted.status.commitUnknown,true);
});

test('truncated assembled context uses complete native messages JSONL before deciding absence',async t=>{
 const {create,remote}=await fixture(t);remote.unknownWrite=true;
 assert.equal(await create().sync([entry('a','one')]),false);remote.unknownWrite=false;remote.contextTruncated=true;
 assert.equal(await create().sync([entry('a','one')]),true);assert.equal(remote.posts,1);
 assert.ok(remote.trace.some(path=>path.startsWith('/api/v1/content/read?')));
});

test('pending archive unavailable through archive API reconciles its raw messages safely',async t=>{
 const {create,remote}=await fixture(t);remote.unknownWrite=true;
 assert.equal(await create().sync([entry('a','one')]),false);remote.unknownWrite=false;
 remote.archives.set('archive_001',remote.messages);remote.messages=[];remote.mutation++;remote.archivePending=true;
 assert.equal(await create().sync([entry('a','one')]),true);assert.equal(remote.posts,1);
 assert.ok(remote.trace.some(path=>path.startsWith('/api/v1/content/read?')));
});
