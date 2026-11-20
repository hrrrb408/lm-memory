// Actual installed DSH tool execution; only provider requests use a loopback fixture.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, access } from 'node:fs/promises';
import { resolveProjectIdentity } from '../../plugin/lib/project-identity.mjs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const { DSH_NODE_EXECUTABLE: node, DSH_INSTALL_DIR: install } = process.env;
assert.ok(node && install, 'Installed DSH paths required');
const run = promisify(execFile), repo = fileURLToPath(new URL('../../',import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'lm-dsh-project-')), home = path.join(temp,'.dsh');
const patch = path.join(temp,'fixture.json'), mem = path.join(home,'memory');
const bundle = path.join(repo,'cordis.patch.yml');
const errors = [];
let step = {}, emitted = 0;
const server = createServer(async (req,res) => {
  try {
    assert.equal(req.method,'POST'); assert.match(req.url,/\/messages$/);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks));
    const packet = JSON.stringify(data.messages);
    if (!step.callId && step.expectPointer) assert.match(packet,/记忆候选指针[^]*mcp__lm_project__memory_recall\(\{id:1,/);
    if (!step.callId && step.forbidPointer) assert.doesNotMatch(packet,/记忆候选指针/);
    const available = (data.tools ?? []).map(t => t.name);
    assert.ok(!available.some(n=>n.startsWith('mcp__lm_memory__')), 'unscoped route still available');
    assert.ok(available.includes(step.name), `scoped tool absent: ${step.name}`);
    const result = step.callId && data.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(c=>c.type==='tool_result' && c.tool_use_id===step.callId);
    if (!result) step.callId = `toolu_fixture_${++emitted}`;
    const item = result ? { type:'text',text:'' } : { type:'tool_use', id:step.callId,name:step.name,input:{} };
    if (result) {
      assert.match(JSON.stringify(result.content), step.expect);
      const packet = JSON.stringify(data.messages);
      if (step.expectRefresh) assert.match(packet,/记忆库实时更新[^]*SCOPED-DELTA-A/);
      if (step.forbidRefresh) assert.doesNotMatch(packet,/SCOPED-DELTA-A/);
    }
    const delta = result ? {type:'text_delta',text:step.reply ?? 'SCOPED_OK'} : {type:'input_json_delta',partial_json:JSON.stringify(step.args)};
    const events = [
      {type:'message_start',message:{id:`msg_fixture_${emitted}`,type:'message',role:'assistant',model:data.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:50,output_tokens:0}}},
      {type:'content_block_start',index:0,content_block:item}, {type:'content_block_delta',index:0,delta},
      {type:'content_block_stop',index:0}, {type:'message_delta',delta:{stop_reason:result?'end_turn':'tool_use',stop_sequence:null},usage:{output_tokens:5}}, {type:'message_stop'} ];
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  } catch(error) { errors.push(String(error.message)); res.writeHead(400).end(); }
});
try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const A=path.join(temp,'a'), B=path.join(temp,'b'), mods=path.join(home,'profiles','headless','node_modules');
  await mkdir(mods,{recursive:true});
  await symlink(repo,path.join(mods,'dsh-lm-memory'),'dir');
  for(const root of [A,B]) { await mkdir(root); execFileSync('git',['init','-q',root]); }
  const configure = ids => writeFile(patch,JSON.stringify([
    {id:'llm-deepseek',config:{baseURL:`http://127.0.0.1:${server.address().port}`}},
    {id:'llm-deepseek-account',disabled:true},{id:'session-title-llm',disabled:true},
    {id:'dsh-lm-memory',config:{projectMemory:true,memoryDir:mem,confirmedOutcomes:true, ...(ids ? {allowRemote:true,extract:false,taskRecall:{enabled:true,sessionIds:ids}} : {})}},
  ]));
  await configure();
  async function call(cwd, scope, tool, args, expect, prompt = 'Fixture tool request.', resume, injection = {}) {
    step = { name:`mcp__lm_${scope}__memory_${tool}`, args, expect, ...injection };
    try {
      const {stdout} = await run(node,[path.join(install,'lib/bin.js'),'--profile','headless','--patch',bundle,'--patch',patch,'--json',...(resume ? ['--session-id',resume] : []),prompt],{
        cwd,timeout:20000,env:{HOME:temp,USERPROFILE:temp,DSH_HOME:home,PATH:process.env.PATH,
          ELECTRON_RUN_AS_NODE:'1',DSH_NODE:process.execPath,DEEPSEEK_API_KEY:'test-only-fixture-key'},
      });
      assert.ok(stdout.includes(step.reply ?? 'SCOPED_OK'));
      return JSON.parse(stdout.split('\n').find(line=>line.includes('"type":"session"'))).sessionId;
    } catch(error) { throw Error(`${error.message}\n${error.stderr ?? ''}\n${errors.join('\n')}`); }
  }
  const sidA = await call(A,'project','remember',{content:'Alpha project marker ISOLATED-A',kind:'fact'},/id=1/,'Alpha source marker ONLY-CAPTURE-A.');
  const sidB = await call(B,'project','remember',{content:'Beta project marker ISOLATED-B',kind:'fact'},/id=1/);
  await call(A,'personal','remember',{content:'Shared personal marker SHARED-P',kind:'preference'},/id=1/);
  await call(A,'project','recall',{id:1},/ISOLATED-A/);
  await call(B,'project','recall',{id:1},/ISOLATED-B/);
  await call(B,'personal','recall',{id:1},/SHARED-P/);
  assert.equal(await call(A,'project','recall',{id:1},/ISOLATED-A/,'Confirmed ONLY-CAPTURE-A after resume.',sidA),sidA);
  const store = async root => path.join(mem,'projects-v1',(await resolveProjectIdentity(root)).id);
  const queued = path.join(await store(A),'pending-episodes.jsonl');
  assert.match(await readFile(queued,'utf8'),/ONLY-CAPTURE-A/);
  await assert.rejects(access(path.join(await store(B),'pending-episodes.jsonl')), {code:'ENOENT'});
  await assert.rejects(access(path.join(mem,'memory.db')), {code:'ENOENT'});
  await assert.rejects(access(path.join(mem,'pending-episodes.jsonl')), {code:'ENOENT'});
  await call(A,'project','remember',{kind:'fact',content:'Scoped notification marker SCOPED-DELTA-A'},/id=3/,undefined,undefined,{expectRefresh:true});
  await call(B,'project','recall',{id:1},/ISOLATED-B/,undefined,undefined,{forbidRefresh:true});
  await configure([sidA,sidB]);
  await call(A,'project','recall',{id:1},/ISOLATED-A/,'上次「ISOLATED-A」记的是什么？',sidA,{expectPointer:true});
  await call(B,'project','recall',{id:1},/ISOLATED-B/,'上次「ISOLATED-A」记的是什么？',sidB,{forbidPointer:true});
  await configure();
  const finding = 'Verify deployment by comparing the BRONZE-CHECK checksum.';
  const confirming = await call(A,'project','recall',{id:1},/ISOLATED-A/,'What did the verification show?',undefined,{reply:finding});
  await call(A,'project','recall',{id:1},/ISOLATED-A/,`确认修复：${finding}`,confirming);
  await call(A,'project','recall',{kind:'procedure',query:'BRONZE-CHECK'},/BRONZE-CHECK/);
  await call(B,'project','recall',{kind:'procedure',query:'BRONZE-CHECK'},/无相关记忆/);
  await call(A,'project','correct',{id:1, expected_version:1, content:'Alpha marker CORRECTED-A'},/新版本/);
  await call(A,'project','recall',{query:'CORRECTED-A',kind:'fact'},/CORRECTED-A/);
  await call(B,'project','recall',{id:1},/ISOLATED-B/);
  console.log('PASS installed DSH: scoped tools, capture, refresh, opt-in pointers, confirmed repair and cross-session correction');
} finally {
  server.close(); server.closeAllConnections(); await rm(temp,{recursive:true,force:true});
}
