// Real-model isolated capture -> dispatch -> helper -> candidates acceptance.
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from '../../tests/helpers.mjs';
const f=await fixture({LM_REMOTE_DISABLED:'0'});
const plugin=(await import('../../plugin/lib/index.js')).default,handlers={};
const message=(date,text)=>({type:'user/message',ts:date+'T12:00:00Z',data:{source:{kind:'user'},content:[{type:'text',text}]}});
const events=[message('2026-11-01','请记住：合成测试项目代号为松石，当前部署区域为东京。'),message('2026-11-01','松石项目昨天完成测试迁移。此处全是合成验收数据。')];
const session={id:'live-synthetic-lifecycle',ownEvents:()=>events},observations=[];
async function settle(){
 const end=Date.now()+300000;
 while(Date.now()<end){
  await f.recall({query:'松石'});
  const jobs=f.db.prepare('SELECT status FROM extract_jobs').all();
  if(jobs.length && jobs.every(x=>x.status==='done'))return;
  if(jobs.some(x=>x.status==='failed'))throw new Error('Extraction job failed');
  await new Promise(r=>setTimeout(r,500));
 }
 throw new Error('Lifecycle timeout');
}
try{
 plugin({on:(n,fn)=>handlers[n]=fn},{memoryDir:f.dir,llm:{model:process.env.BENCH_LLM,baseURL:process.env.BENCH_BASE_URL,apiKeyEnv:'BENCH_API_KEY'}});
 handlers['session/created'](session);handlers['workspace/session-stop']({sessionId:session.id});await settle();
 observations.push({stage:'initial',memories:f.db.prepare('SELECT id,kind,content,status FROM memories').all()});
 events.push(message('2026-11-03','纠正前面的记录：松石项目当前部署区域已从东京改为新加坡，东京不再是当前部署区域。'));
 handlers['workspace/session-stop']({sessionId:session.id});await settle();
 observations.push({stage:'corrected',memories:f.db.prepare('SELECT id,kind,content,status FROM memories').all(),sources:f.db.prepare('SELECT memory_id,session_id,revision FROM provenance').all()});
 const report={model:process.env.BENCH_LLM,synthetic:true,realDSHHost:false,observations};
 fs.mkdirSync(path.dirname(process.env.LM_LIVE_OUT),{recursive:true});fs.writeFileSync(process.env.LM_LIVE_OUT,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{globalThis.__lmCaptureSessions?.delete(session);await f.close();}
