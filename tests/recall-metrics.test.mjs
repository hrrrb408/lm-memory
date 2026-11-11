import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureCase, summarize } from '../scripts/eval/recall-metrics.mjs';
test('one gold hit cannot pass a multi-evidence question; incomplete text cannot pass completeness', () => {
  const q = {relevant_ids: ['a','b','c'], required_groups: [['a','b'],['c']]};
  const one = measureCase(q, [{id:'a',complete:true}]);
  assert.equal(one.hit,true); assert.equal(one.evidence_complete,false);
  assert.equal(measureCase(q,[{id:'b',complete:true},{id:'c',complete:true}]).evidence_complete,true);
  assert.equal(measureCase(q,[{id:'a',complete:true},{id:'c',complete:false}]).evidence_complete,false);
  const negative = measureCase({relevant_ids:[],required_groups:[]}, [{id:'wrong',complete:true}]);
  const metrics = summarize([{...one,latency_ms:1},{...negative,latency_ms:3}],5);
  assert.equal(metrics.hit_at_k,1); assert.equal(metrics.evidence_complete_rate,0);
  assert.equal(metrics.false_recall_rate,.5); assert.equal(metrics.abstention_false_positive_rate,1);
  assert.equal(metrics.latency_ms.p95,3);
});
