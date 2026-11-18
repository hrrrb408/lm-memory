import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retrievePlan} from '../server/retrieval-plan.mjs';
test('subqueries recover complementary evidence within a shared output budget',async()=>{
 const rows={main:[{id:1,content:'first evidence'}],detail:{hits:[{id:2,content:'second evidence'},{id:1,content:'first evidence'}]}};
 const r=await retrievePlan(async({query})=>rows[query],'main',['detail','detail']);
 assert.deepEqual(new Set(r.hits.map(x=>x.id)),new Set([1,2]));assert.equal(r.queries.length,2);
 const small=await retrievePlan(async()=>[{id:1,content:'x'.repeat(2000)}],'main',[],{maxBytes:512});assert.deepEqual(small.hits,[]);
});
