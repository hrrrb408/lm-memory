// BM25 over word tokens, independent of FTS trigram phrase matching.
// Stateless and deterministic: can score isolated corpora without model calls.
const STOP=new Set('a an the is are was were be been being am do does did have has had what which who when where why how would could should can may might will shall of for to from in on at by with and or as than that this these those it its his her their our your my i you he she they we according'.split(' '));
export function searchTokens(text){
 const words=String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
 return words.flatMap(w=>/^[\p{Script=Han}]+$/u.test(w)&&w.length>2?Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2)):[w]).filter(w=>w.length>1&&!STOP.has(w));
}
export function sparseRank(query,rows,{limit=60,k1=1.2,b=0.75}={}){
 const terms=[...new Set(searchTokens(query))];if(!terms.length||!rows.length)return [];
 const docs=rows.map(row=>{const tokens=searchTokens(row.content),tf=new Map();for(const t of tokens)tf.set(t,(tf.get(t)??0)+1);return {row,tf,len:tokens.length};});
 const avg=docs.reduce((s,d)=>s+d.len,0)/docs.length||1;
 const df=new Map(terms.map(t=>[t,docs.filter(d=>d.tf.has(t)).length]));
 return docs.map(d=>({id:d.row.id,score:terms.reduce((sum,t)=>{const f=d.tf.get(t)??0;if(!f)return sum;const idf=Math.log(1+(docs.length-df.get(t)+0.5)/(df.get(t)+0.5));return sum+idf*f*(k1+1)/(f+k1*(1-b+b*d.len/avg));},0)})).filter(r=>r.score>0).sort((a,b)=>b.score-a.score||a.id-b.id).slice(0,limit);
}
