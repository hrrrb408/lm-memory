import {boundedRecall,rrfScore} from './recall-utils.mjs';
// Reusable multi-query retrieval; no gold answers, category IDs or dataset fields.
// The host supplies query planning and the recall transport.
export async function retrievePlan(recall,query,subqueries=[],{limit=15,maxBytes=16384}={}){
 const queries=[...new Set([query,...subqueries].filter(q=>typeof q==='string'&&q.trim()).map(q=>q.trim()))].slice(0,4);
 const rankings=[],records=new Map();
 for(const q of queries){
  const response=await recall({query:q,limit,max_bytes:maxBytes});
  const rows=Array.isArray(response)?response:(response?.hits??[]);
  rankings.push(new Map(rows.map((r,i)=>[r.id,i])));
  for(const row of rows)records.set(row.id,row);
 }
 const scored=[...records.values()].map(row=>({row,score:rrfScore(row.id,rankings)})).sort((a,b)=>b.score-a.score||a.row.id-b.row.id).map(x=>x.row).slice(0,limit);
 const bounded=boundedRecall(scored,[],maxBytes);
 return {queries,hits:Array.isArray(bounded)?bounded:bounded.hits,budget:Array.isArray(bounded)?null:bounded.budget};
}
