// Full S QA (not Oracle). Frozen chronological sample order; failures stop with checkpoints.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {checkSecret} from '../../server/guards.mjs';
import {fixture} from '../../tests/helpers.mjs';
import {glm,judgePrompt} from './model-lib.mjs';
import {buildCorpus,expandSourceMessages,readerPrompt} from './longmemeval-source.mjs';
const input=process.env.LM_LME_DATA,output=process.env.LM_LME_OUT;
if(!input||!output)throw new Error('LM_LME_DATA and LM_LME_OUT required');
const raw=fs.readFileSync(input),data=JSON.parse(raw).slice(0,Number(process.env.LM_LME_LIMIT??500));
const protocol={dataset:createHash('sha256').update(raw).digest('hex'),model:process.env.BENCH_LLM,context_bytes:16384,limit:15,oracle:false,graph:false,privacy:"production-credential-pattern-withholding",chunk_chars:384,overlap:64};
const sourceExpansion=process.env.LM_LME_SOURCE_EXPANSION==='1';
if(sourceExpansion)protocol.source_expansion='ranked-session-user-messages-v2';
const protocolHash=createHash('sha256').update(JSON.stringify(protocol)).digest('hex');
let results=[];
if(fs.existsSync(output+'.checkpoint.json')){const saved=JSON.parse(fs.readFileSync(output+'.checkpoint.json'));if(saved.protocolHash!==protocolHash){
  if(sourceExpansion||saved.protocol.source_expansion||process.env.LM_LME_IMPORT_CLEAN_CHECKPOINT!=="1")throw new Error('Protocol mismatch');
  for(const record of saved.results){const source=data.find(q=>q.question_id===record.qid);if(!source)throw new Error('Checkpoint question missing');for(const turns of source.haystack_sessions){const text=turns.map(t=>`${t.role}: ${t.content}`).join('\n');for(let i=0;i<text.length;i+=320)if(checkSecret(text.slice(i,i+384)))throw new Error('Old result used a now-filtered input; rescore required');}}
 }results=saved.results;}
const save=complete=>{fs.mkdirSync(path.dirname(output),{recursive:true});const target=complete?output:output+'.checkpoint.json';fs.writeFileSync(target+'.tmp',JSON.stringify({protocol,protocolHash,complete,n:results.length,results,accuracy:results.length?results.filter(r=>r.ok).length/results.length:null},null,2));fs.renameSync(target+'.tmp',target);};
for(const q of data){
 if(results.some(r=>r.qid===q.question_id))continue;
 const f=await fixture({LM_EMBED:'1',LM_REMOTE_DISABLED:'1',LM_GRAPH_ENABLED:'0'});
 try{
  const {batch,locations,privacyFiltered}=buildCorpus(q);
  for(let i=0;i<batch.length;i+=50){
   const outcomes=JSON.parse(await f.call('memory_batch_remember',{items:batch.slice(i,i+50)}));
   if(outcomes.some(r=>!r.ok&&r.reason!=='exists'))throw new Error('Rejected benchmark input');
  }
  const response=await f.recall({query:q.question,limit:15,max_bytes:16384}),hits=Array.isArray(response)?response:response.hits;
  const evidence=sourceExpansion?expandSourceMessages(hits,locations,protocol.context_bytes,q.question):null;
  const snippets=evidence?.snippets??hits.map(r=>r.content).join('\n');
  const hypothesis=await glm([{role:'user',content:readerPrompt(q,snippets)}],{maxTokens:1024});
  const judge=await glm([{role:'user',content:judgePrompt(q.question_type,q.question,String(q.answer),hypothesis,q.question_id.endsWith('_abs'))}],{maxTokens:64});
  if(!/^(yes|no)[.!]?$/i.test(judge.trim()))throw new Error('Invalid judge verdict');
  const gold=q.answer_session_ids??[],got=new Set(hits.map(r=>r.tags.match(/sid:([^,]+)/)?.[1]));
  results.push({qid:q.question_id,type:q.question_type,ok:/^yes[.!]?$/i.test(judge),question:q.question,hypothesis,answer:q.answer,judge,session_coverage:gold.length?gold.filter(x=>got.has(String(x))).length/gold.length:null,records:batch.length,privacy_filtered_records:privacyFiltered,retrieved_ids:hits.map(r=>r.id),...(evidence?{source_refs:evidence.refs,context_bytes:evidence.bytes}:{})});
  save(false);console.log(`${results.length}/${data.length} ${q.question_id} ${results.at(-1).ok?'PASS':'FAIL'}`);
 }finally{await f.close();}
}
save(true);
