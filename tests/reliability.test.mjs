import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fixture} from './helpers.mjs';

test('capture retries failed dispatch and preserves message dates',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lm-capture-fault-'));
  const handlers={}, plugin=(await import('../plugin/lib/index.js')).default;
  plugin({on:(n,f)=>handlers[n]=f},{memoryDir:dir});
  const session={id:'retry-fault',ownEvents:()=>['第一条消息','第二条消息'].map(text=>({type:'user/message',ts:'2026-11-01T12:00:00Z',data:{source:{kind:'user'},content:[{type:'text',text}]}}))};
  handlers['session/created'](session);
  fs.writeFileSync(path.join(dir,'extraction-jobs'),'fault');
  handlers['workspace/session-stop']({sessionId:session.id});
  assert.equal(fs.existsSync(path.join(dir,'captured-sessions.jsonl')),false);
  fs.unlinkSync(path.join(dir,'extraction-jobs'));
  handlers['workspace/session-stop']({sessionId:session.id});
  assert.ok(fs.existsSync(path.join(dir,'pending-jobs.jsonl')));
  const job=JSON.parse(fs.readFileSync(path.join(dir,'extraction-jobs',fs.readdirSync(path.join(dir,'extraction-jobs'))[0])));
  assert.match(job.texts[0],/message_date=2026-11-01/);
  globalThis.__lmCaptureSessions.delete(session);
});

test('automatic replay cannot resurrect forgotten or corrected exact claims',async()=>{
  const f=await fixture();
  try {
    const content='测试居住地目前是城市甲';
    const id=await f.remember(content);
    await f.call('memory_forget',{id,hard:true});
    fs.writeFileSync(path.join(f.dir,'pending-memories.jsonl'),JSON.stringify({eid:'fresh-revision',kind:'fact',content,sessionId:'s',tags:'auto,session:s'})+'\n');
    await f.recall({query:'城市甲'});
    assert.equal(f.db.prepare("SELECT count(*) n FROM memories WHERE status='active' AND content=?").get(content).n,0);
    const old=await f.remember('测试旧的工作城市是城市乙');
    await f.call('memory_correct',{id:old,expected_version:1,content:'测试新的工作城市是城市丙'});
    fs.writeFileSync(path.join(f.dir,'pending-memories.jsonl'),JSON.stringify({eid:'old-recapture',kind:'fact',content:'测试旧的工作城市是城市乙',sessionId:'s',tags:'auto,session:s'})+'\n');
    await f.recall({query:'城市乙'});
    assert.equal(f.db.prepare("SELECT count(*) n FROM memories WHERE status='active' AND content=?").get('测试旧的工作城市是城市乙').n,0);
  } finally {await f.close();}
});

test('candidate source is persisted and hard deletion removes its source row',async()=>{
 const f=await fixture();
 try {
  fs.writeFileSync(path.join(f.dir,'pending-memories.jsonl'),JSON.stringify({eid:'with-source',kind:'fact',content:'证据测试用户使用工具甲',sessionId:'evidence-session',tags:'auto',evidence:[{message_index:1,text:'我使用工具甲'}]})+'\n');
  const [hit]=await f.recall({query:'工具甲'});
  assert.equal(hit.evidence_available,true);
  assert.match(await f.call('memory_source',{id:hit.id}),/我使用工具甲/);
  await f.call('memory_forget',{id:hit.id,hard:true});
  assert.equal(f.db.prepare('SELECT count(*) n FROM provenance').get().n,0);
 }finally{await f.close();}
});

test('online backup contains WAL changes and can be opened independently',async()=>{
 const f=await fixture();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lm-backup-test-'));
 try {
  await f.remember('备份恢复的独立证据');
  const {backupMemory}=await import('../server/backup.mjs');
  const file=path.join(dir,'restored.db');
  const result=await backupMemory(path.join(f.dir,'memory.db'),file);
  assert.equal(result.integrity,'ok');assert.equal(result.memories,1);
  await assert.rejects(backupMemory(path.join(f.dir,'memory.db'),file),/must be new/);
 } finally {await f.close(); fs.rmSync(dir,{recursive:true,force:true});}
});

test('queue writers serialize across processes and lock releases on process death',async()=>{
 const {spawn}=await import('node:child_process');
 const {pathToFileURL}=await import('node:url');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lm-lock-test-')), file=path.join(dir,'queue.jsonl');
 const moduleURL=pathToFileURL(path.resolve('server/file-lock.mjs')).href;
 const worker=()=>new Promise((resolve,reject)=>{
  const c=spawn(process.execPath,['--input-type=module','-e',`import {appendQueue} from ${JSON.stringify(moduleURL)}; for(let i=0;i<20;i++)appendQueue(${JSON.stringify(file)},{pid:process.pid,i});`],{stdio:['ignore','ignore','pipe']});
  let err='';c.stderr.on('data',x=>err+=x);c.on('error',reject);c.on('exit',code=>code===0?resolve():reject(new Error(err)));
 });
 try {
  await Promise.all([worker(),worker(),worker()]);
  const lines=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length,60);assert.equal(new Set(lines.map(r=>r.pid+':'+r.i)).size,60);
  const c=spawn(process.execPath,['--input-type=module','-e',`import {withFileLock} from ${JSON.stringify(moduleURL)};withFileLock(${JSON.stringify(file)},()=>{process.stdout.write('ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000)});`],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{c.stdout.once('data',resolve);c.once('error',reject);c.once('exit',()=>reject(new Error('holder exited before ready')));});
  const exited=new Promise(r=>c.once('exit',r));c.kill('SIGKILL');await exited;
  const {appendQueue}=await import('../server/file-lock.mjs');appendQueue(file,{afterCrash:true});
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8').trim().split('\n').at(-1)).afterCrash,true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('exposure does not renew TTL; explicit useful feedback does',async()=>{
 const f=await fixture();
 try {
  const id=await f.remember('反馈与遗忘验收');
  await f.recall({id});
  assert.equal(f.db.prepare('SELECT used_count FROM memories WHERE id=?').get(id).used_count,0);
  await f.call('memory_feedback',{id,useful:false});
  assert.equal(f.db.prepare('SELECT used_count FROM memories WHERE id=?').get(id).used_count,0);
  await f.call('memory_feedback',{id,useful:true});
  assert.equal(f.db.prepare('SELECT used_count FROM memories WHERE id=?').get(id).used_count,1);
 }finally{await f.close();}
});

test('evidence-backed same-session revision supersedes old fact; cross-session update is rejected',async()=>{
 const f=await fixture();
 const enqueue=r=>fs.writeFileSync(path.join(f.dir,'pending-memories.jsonl'),JSON.stringify(r)+'\n');
 try {
  enqueue({eid:'r1',sessionId:'s',kind:'fact',content:'修订测试用户住城市甲',tags:'auto,session:s',capturedAt:'2026-11-01T00:00:00Z'});
  const [old]=await f.recall({query:'修订测试'});
  enqueue({eid:'r2',sessionId:'s',kind:'fact',content:'修订测试用户住城市乙',tags:'auto,session:s',capturedAt:'2026-11-02T00:00:00Z',supersedesId:old.id,evidenceQuote:'搬到城市乙',evidence:[{message_index:2,text:'我搬到城市乙'}]});
  await f.recall({query:'修订测试'});
  assert.equal(f.db.prepare('SELECT status FROM memories WHERE id=?').get(old.id).status,'superseded');
  const current=f.db.prepare("SELECT id FROM memories WHERE status='active'").get();
  enqueue({eid:'r3',sessionId:'other',kind:'fact',content:'非法跨会话取代',tags:'auto,session:other',capturedAt:'2026-11-03T00:00:00Z',supersedesId:current.id,evidenceQuote:'任何文字',evidence:[{text:'任何文字'}]});
  await f.recall({query:'修订测试'});
  assert.equal(f.db.prepare("SELECT count(*) n FROM memories WHERE status='active'").get().n,1);
 }finally{await f.close();}
});

test('reclaimed helper cannot publish candidates with a stale owner',async()=>{
 const f=await fixture();
 const http=await import('node:http'), {spawn}=await import('node:child_process');
 const mock=http.createServer((req,res)=>{req.resume();req.on('end',()=>res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'[{"kind":"fact","content":"stale worker fact"}]'}}]})));});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 try {
  f.db.prepare("INSERT INTO extract_jobs(session_id,revision,status,owner,updated_at) VALUES ('lease','rev','running','new-owner',?)").run(new Date().toISOString());
  const job=path.join(f.dir,'job.json');
  fs.writeFileSync(job,JSON.stringify({sessionId:'lease',rev:'rev',date:'2026-11-17',texts:['合成输入甲','合成输入乙'],llm:{model:'fake',baseURL:'http://127.0.0.1:'+mock.address().port,apiKeyEnv:'LM_LEASE_TEST_KEY'}}));
  const child=spawn(process.execPath,['plugin/lib/extract-helper.mjs',job],{env:{...process.env,LM_MEMORY_DIR:f.dir,LM_LEASE_TEST_KEY:'synthetic',LM_JOB_OWNER:'old-owner'},stdio:'ignore'});
  const code=await new Promise((r,j)=>{child.on('exit',r);child.on('error',j)});
  assert.equal(code,1);assert.equal(fs.existsSync(path.join(f.dir,'pending-memories.jsonl')),false);
  assert.equal(fs.existsSync(job),true);
 }finally{await new Promise(r=>mock.close(r));await f.close();}
});
