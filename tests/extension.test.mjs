import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import openviking from '../extensions/openviking.ts';
import { loadConfig } from '../src/config.ts';
import { OVClient } from '../src/client.ts';
import { SyncManager } from '../src/sync.ts';
import { textFromContext } from '../src/runtime.ts';

test('native session resume includes archive overview and text message parts',()=>{
  assert.equal(textFromContext({latest_archive_overview:'Previous work',messages:[
    {role:'user',parts:[{type:'text',text:'Next step'},{type:'image',url:'private image'}]},
    {role:'assistant',parts:[{type:'text',text:'Ready'}]},
  ]}),'Previous work\n\nNext step\n\nReady');
  assert.equal(textFromContext({latest_archive_overview:'Archived only',messages:[]}),'Archived only');
  assert.equal(textFromContext({content:[{type:'text',text:'OMP turn'}]}),'OMP turn');
});

async function fixture(t) {
  const home=await mkdtemp(join(tmpdir(),'ov-extension-'));
  const calls=[];
  class OfflineClient extends OVClient {
    async fetchJSON(path,init) {calls.push({path,init,user:this.authenticatedUser,root:this.userRoot});return {ok:false,result:null,status:503};}
    async resolveUserSpace(){return 'real-user';}
  }
  const config=loadConfig(undefined,{home,env:{},config:{stateDir:join(home,'state'),requestTimeoutMs:25,handoff:{enabled:false}}});
  const handlers=new Map(),tools=new Map(),commands=new Map();
  const api={on:(name,fn)=>handlers.set(name,fn),registerTool:tool=>tools.set(tool.name,tool),registerCommand:(name,command)=>commands.set(name,command),getAllTools:()=>[...tools.values()],getActiveTools:()=>[...tools.keys()]};
  const entries=[];let sessionId='session-a';const notices=[];
  const ctx={cwd:home,ui:{notify:m=>notices.push(m),setStatus:()=>{}},sessionManager:{getSessionId:()=>sessionId,getEntries:()=>entries,getBranch:()=>entries,getLeafId:()=>entries.at(-1)?.id??null,isPersisted:()=>false},getSystemPrompt:()=>'',model:{contextWindow:100000,maxTokens:1000}};
  openviking(api,{config,dependencies:{Client:OfflineClient,Sync:SyncManager}});
  t.after(async()=>{await handlers.get('session_shutdown')?.({},ctx);await rm(home,{recursive:true,force:true});});
  return {home,config,handlers,tools,commands,ctx,entries,calls,notices,setSession:id=>{sessionId=id;}};
}

test('extension registers all tools/commands immediately and offline hooks do not break coding',async t=>{
  const f=await fixture(t);assert.equal(f.tools.size,11);assert.deepEqual([...f.commands.keys()],['ov','viking']);
  const start=f.handlers.get('session_start')({},f.ctx);assert.equal(start,undefined);
  await new Promise(resolve=>setTimeout(resolve,30));const before=f.calls.length;
  assert.equal(f.handlers.get('before_agent_start')({prompt:'build app'},f.ctx),undefined);
  assert.equal(f.calls.length,before,'prompt hook does no network IO');
  const messages=[{role:'user',content:'build app',timestamp:1}];const now=Date.now();const context=await f.handlers.get('context')({messages},f.ctx);
  assert.ok(Date.now()-now<300);assert.deepEqual(context.messages,messages);
  const result=await f.tools.get('viking_read').execute('tool',{uri:'viking://user/real-user/memories/x'},undefined,undefined,f.ctx);assert.equal(result.isError,true);
  const shutdown=Date.now();await f.handlers.get('session_shutdown')({},f.ctx);assert.ok(Date.now()-shutdown<2100);
});

test('URI guard routes local tools and denied tool payload never reaches durable pending files',async t=>{
  const f=await fixture(t);f.handlers.get('session_start')({},f.ctx);
  for(const name of ['read','bash','glob','grep']) {
    const result=f.handlers.get('tool_call')({toolName:name,input:{path:'viking://user/me/memories/x'}},f.ctx);
    assert.equal(result.block,true);assert.match(result.reason,/viking_read|viking_search/);
  }
  f.handlers.get('tool_call')({toolName:'bash',toolCallId:'private',input:{command:'cat /repo/.env'}},f.ctx);
  f.handlers.get('tool_result')({toolName:'bash',toolCallId:'private',content:'unique-secret-body'},f.ctx);
  f.entries.push({id:'a',parentId:null,type:'message',timestamp:'2026-09-21T00:00:00Z',message:{role:'assistant',content:[{type:'toolCall',id:'private',name:'bash',arguments:{command:'cat /repo/.env'}}]}});
  f.entries.push({id:'b',parentId:'a',type:'message',timestamp:'2026-09-21T00:00:01Z',message:{role:'toolResult',toolCallId:'private',content:'unique-secret-body'}});
  f.handlers.get('turn_end')({},f.ctx);await f.handlers.get('session_shutdown')({},f.ctx);
  const files=await readdir(f.config.stateDir,{recursive:true});const records=[];
  for(const file of files.filter(file=>file.endsWith('.json')))records.push(await readFile(join(f.config.stateDir,file),'utf8'));
  assert.ok(records.length>0);assert.equal(records.join('').includes('unique-secret-body'),false);assert.equal(records.join('').includes('cat /repo/.env'),false);
});

test('same extension instance isolates session switch without rebinding authenticated identity',async t=>{
  const f=await fixture(t);f.handlers.get('session_start')({},f.ctx);await new Promise(resolve=>setTimeout(resolve,30));
  f.setSession('session-b');f.handlers.get('session_start')({},f.ctx);await new Promise(resolve=>setTimeout(resolve,40));
  f.handlers.get('before_agent_start')({prompt:'new session'},f.ctx);await f.handlers.get('context')({messages:[{role:'user',content:'new session',timestamp:4}]},f.ctx);
  assert.ok(f.calls.length>0);assert.ok(f.calls.every(c=>c.user==='real-user'));
  const roots=new Set(f.calls.map(c=>c.root));assert.ok(roots.size>=2);
  assert.ok([...roots].every(root=>root.startsWith('viking://user/real-user/omp-ov-memory/sessions/')));
});
