// Re-score existing predictions. Never call a model or mutate the original report.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {abstains} from './locomo-scoring.mjs';
const [input,dataset,output]=process.argv.slice(2);
if(!input||!dataset||!output||input===output)throw new Error('input dataset new-output required');
const raw=fs.readFileSync(input),old=JSON.parse(raw),data=JSON.parse(fs.readFileSync(dataset));
const results=[];
for(const conv of data) for(const [qaIndex,q] of conv.qa.entries()) {
 const key=r=>r.conv===conv.sample_id&&r.category===Number(q.category)&&r.q===q.question.slice(0,200);
 const r=old.results.find(key);
 if(!r)throw new Error(`Missing prediction: ${conv.sample_id}:${qaIndex}`);
 const repeated=results.find(x=>key(x));
 if(repeated){
  const first=conv.qa[repeated.qaIndex];
  if(JSON.stringify([first.answer,first.adversarial_answer,first.evidence])!==JSON.stringify([q.answer,q.adversarial_answer,q.evidence]))throw new Error('Duplicate is not identical; requires independent scoring');
 }
 results.push({...r,qaIndex,reused_identical_duplicate:!!repeated,ok:Number(q.category)===5?abstains(r.hypothesis):r.ok});
}
const summarize=rs=>({n:rs.length,correct:rs.filter(r=>r.ok).length,accuracy:rs.filter(r=>r.ok).length/rs.length});
const byCat=Object.fromEntries([...new Set(results.map(r=>r.catLabel))].map(k=>[k,summarize(results.filter(r=>r.catLabel===k))]));
const nonAdversarial=summarize(results.filter(r=>r.category!==5));
const report={...old,n:results.length,overall:summarize(results).accuracy,byCat,nonAdversarial,results,
 correction:{input,input_sha256:createHash('sha256').update(raw).digest('hex'),original_predictions:old.results.length,reused_identical_duplicates:results.filter(r=>r.reused_identical_duplicate).length,cat5_rule:'official markers extended to recognize the exact reader abstention instruction; NOT unmodified official scorer',original_report_preserved:true},
 evidence:{...old.evidence,note:'Original unique-prediction evidence statistics; not reweighted for repeated dataset rows'}};
fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({n:report.n,overall:report.overall,byCat,nonAdversarial,correction:report.correction},null,2));
