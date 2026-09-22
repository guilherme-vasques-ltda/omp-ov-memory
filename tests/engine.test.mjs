import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPiEntries, recordedEventBytes, reconstructPiEntry } from '../src/shared/recorded-event.mjs';
import { verifyRecordedEventBytes, recordedEventStorageLocation } from '../src/shared/recorded-event-adapter.mjs';
import { buildArchiveManifest, archiveManifestBytes, parseArchiveManifest } from '../src/shared/archive.mjs';
import { buildCheckpointRequestEvent, buildCheckpointEvent, parseCheckpointEvent, validateCheckpointOverview, embeddedImages } from '../src/shared/checkpoint.mjs';
import { OpenVikingCheckpointProcessor } from '../src/shared/checkpoint-processor.mjs';
import { preservesRecentTurns, compactionKeepsRecentTurns } from '../src/takeover.ts';

const entry={id:'entry-a',parentId:null,type:'message',timestamp:'2026-09-21T00:00:00Z',message:{role:'user',content:[{type:'text',text:'Continue task'},{type:'image',mimeType:'image/png',data:Buffer.from('image-bytes').toString('base64')}]}};
test('Apache event/archive engine preserves multimodal bytes and rejects tampering',()=>{
  const events=projectPiEntries('session-a',[entry]);assert.deepEqual(reconstructPiEntry(events),entry);
  const bytes=recordedEventBytes(events[0]);assert.deepEqual(verifyRecordedEventBytes(bytes,events[0].eventId),events[0]);
  const tampered=JSON.parse(bytes);tampered.payload.part.value.text='changed';assert.throws(()=>verifyRecordedEventBytes(Buffer.from(JSON.stringify(tampered)),events[0].eventId),/hash|canonical/);
  const manifest=buildArchiveManifest('session-a',events);assert.deepEqual(parseArchiveManifest(archiveManifestBytes(manifest)),manifest);
  assert.throws(()=>parseArchiveManifest(Buffer.from(JSON.stringify({...manifest,eventCount:100}))),/Archive/);
  assert.equal(embeddedImages(events)[0].bytes.toString(),'image-bytes');
  const scoped='viking://user/me/omp-ov-memory/sessions/'+ 'a'.repeat(24);
  assert.ok(recordedEventStorageLocation(scoped,'session-a',events[0].eventId).directUri.startsWith(scoped+'/resources/'));
});

test('checkpoint integrity binds validated continuation to exact source archive',()=>{
  const events=projectPiEntries('session-a',[entry]), manifest=buildArchiveManifest('session-a',events);
  const overview=['# Working Memory','## Task & Goals\n- Complete memory plugin integration.','## Current State\n- Transport and capture tests pass.','## Key Facts & Decisions\n- Use authenticated user paths.','## Open Issues\n- Verify native loader.','## Files & Context\n- src/runtime.ts coordinates hooks.','## Errors & Corrections\n- Fixed synthetic-user permissions.'].join('\n\n');
  const request=buildCheckpointRequestEvent({manifest,attempt:1,submittedAt:'2026-09-21T00:00:00Z'});
  const checkpoint=buildCheckpointEvent({manifest,requestEvent:request,overview,completedAt:'2026-09-21T00:01:00Z'});
  assert.match(parseCheckpointEvent(checkpoint,manifest).narrative,/Next Action/);
  assert.throws(()=>parseCheckpointEvent(checkpoint,{...manifest,contentHash:'sha256:'+'0'.repeat(64)}),/checkpoint/);
  assert.throws(()=>validateCheckpointOverview('unsupported model response'),/Working Memory/);
});

test('checkpoint media uses compatible immutable batch adapter, never raw unsupported preconditions',async()=>{
  const calls=[];const client={userRoot:'viking://user/me',statUri:async()=>({ok:true,exists:true,isDir:true}),batchWrite:async body=>{calls.push(body);return {ok:true,result:{root_uri:body.root_uri,created:body.operations.map(o=>o.uri),updated:[],unchanged:[]}};},abstract:async()=> 'A screenshot',fetchJSON:async()=>{throw new Error('raw API bypass');}};
  const processor=new OpenVikingCheckpointProcessor(client);const media=await processor.prepareMedia('task',projectPiEntries('session-a',[entry]));
  assert.equal(calls.length,1);assert.equal(calls[0].wait,false);assert.equal(media.length,1);
});

test('takeover and compaction preserve the requested recent user turns or decline replacement',()=>{
  const messages=[{role:'user',content:'old'},{role:'assistant',content:'old answer'},{role:'user',content:'latest'},{role:'assistant',content:'latest answer'}];
  const replacement=[{role:'custom',content:'checkpoint'},...messages.slice(2)];
  assert.equal(preservesRecentTurns(messages,replacement,1),true);assert.equal(preservesRecentTurns(messages,replacement,2),false);
  const branch=messages.map((message,i)=>({id:String(i),message}));
  assert.equal(compactionKeepsRecentTurns(branch,'2',1),true);assert.equal(compactionKeepsRecentTurns(branch,'2',2),false);
});

test('checkpoint restart reconciles a timed-out native append before guarded commit without resubmitting',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const stateDir=await mkdtemp(join(tmpdir(),'omp-checkpoint-recovery-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const taskId='cptask_'+'c'.repeat(64), messages=[];let appends=0, commits=0, loads=0, taskCreated=false;
  const metadata=()=>({session_id:taskId,uri:`viking://user/me/sessions/${taskId}`,created_at:'2026-09-21T00:00:00Z',updated_at:String(appends),message_count:taskCreated?0:messages.length,total_message_count:messages.length,commit_count:0});
  const client={cfg:{stateDir,peerId:'omp-test'},userRoot:'viking://user/me/omp-ov-memory/sessions/'+'a'.repeat(24),baseUserRoot:'viking://user/me',recordedEventTarget:{endpoint:'http://localhost:1933',account:'test',user:'me',scope:'a'.repeat(24)},
    getSession:async()=>({ok:true,result:metadata()}),
    listTasks:async()=>({ok:true,result:taskCreated?[{task_id:'native-task',created_at:1}]:[]}),
    getTask:async()=>({ok:true,result:{task_id:'native-task',status:'processing',created_at:1}}),
    fetchJSON:async(path,init)=>{
      if(path.endsWith('/messages')&&init?.method==='POST'){const body=JSON.parse(init.body);appends++;messages.push({...body,id:'native-message',parts:[{type:'text',text:body.content}]});return {ok:false,status:0,result:null};}
      if(path.endsWith('/commit')&&init?.method==='POST'){commits++;taskCreated=true;return {ok:true,result:{status:'accepted',session_id:taskId,task_id:'native-task'}};}
      if(path.startsWith(`/api/v1/sessions/${taskId}/context`))return {ok:true,result:{messages,stats:{totalArchives:0,failedArchives:0}}};
      if(path===`/api/v1/sessions/${taskId}`)return {ok:true,result:metadata()};
      if(path.startsWith('/api/v1/fs/ls?'))return {ok:true,result:[]};
      throw new Error(`unexpected checkpoint test request ${path}`);
    },
  };
  const events=projectPiEntries('session-a',[{...entry,message:{role:'user',content:[{type:'text',text:'Continue this task safely.'}]}}]);
  const manifest=buildArchiveManifest('session-a',events);
  const input={taskId,manifest,previousCheckpoint:null,loadEvents:async()=>{loads++;return events;}};
  const initial=await new OpenVikingCheckpointProcessor(client).advance(input);
  assert.equal(initial.status,'pending');assert.equal(initial.error.errorCode,'message_add');assert.equal(appends,1);assert.equal(commits,0);
  const recovered=await new OpenVikingCheckpointProcessor(client).advance(input);
  assert.equal(recovered.status,'processing');assert.equal(appends,1,'positive source-id readback must avoid a duplicate append');assert.equal(commits,1);assert.equal(loads,1,'recovery must not reload archived checkpoint input');
  const polling=await new OpenVikingCheckpointProcessor(client).advance(input);
  assert.equal(polling.status,'processing');assert.equal(loads,1,'pending native archive already contains the input');assert.equal(commits,1);assert.equal(appends,1);
});

test('checkpoint cleanup removes only its scoped media root and verifies deletion',async()=>{
  const taskId='cptask_'+'d'.repeat(64), root='viking://user/me/omp-ov-memory/sessions/'+'b'.repeat(24), calls=[];
  const client={userRoot:root,
    listTasks:async()=>({ok:true,result:[{task_id:'pending-task',status:'processing'}]}),
    cancelTask:async id=>{calls.push(['cancel',id]);return {ok:true};},
    deleteSession:async id=>{calls.push(['session',id]);return {ok:true};},
    delete:async(uri,recursive)=>{calls.push(['media',uri,recursive]);return true;},
    getSession:async()=>({ok:false,status:404}),statUri:async uri=>{calls.push(['verify',uri]);return {ok:true,exists:false};},
  };
  assert.equal(await new OpenVikingCheckpointProcessor(client).cleanup(taskId),true);
  const media=`${root}/resources/.pi-openviking/checkpoint-inputs/v1/${taskId}`;
  assert.deepEqual(calls,[['cancel','pending-task'],['session',taskId],['media',media,true],['verify',media]]);
  await assert.rejects(new OpenVikingCheckpointProcessor({...client,userRoot:'viking://user/me/../../other'}).cleanup(taskId),/bound user root/);
});
