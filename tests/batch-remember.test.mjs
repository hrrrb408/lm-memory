import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';
test('batch preserves per-item secret rejection, dedup, source dates and searchable commits',async()=>{
 const f=await fixture();try{
 const result=JSON.parse(await f.call('memory_batch_remember',{items:[{content:'批次里的有效证据',event_date:'2026-01-02'},{content:'api_key=sk-abcdefghijklmnopqrstuv'},{content:'批次里的有效证据'}]}));
 assert.equal(result[0].ok,true);assert.equal(result[1].reason,'secret');assert.equal(result[2].reason,'exists');
 const hits=await f.recall({query:'有效证据'});assert.equal(hits.length,1);assert.equal(hits[0].date,'2026-01-02');
 }finally{await f.close();}
});
