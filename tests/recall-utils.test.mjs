import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embeddingCacheKey } from '../server/recall-utils.mjs';
test('embedding identity covers tail, role, model and prefix', () => {
  const text = 'x'.repeat(400);
  const base = embeddingCacheKey('zh', text + 'A', false);
  for (const key of [embeddingCacheKey('zh', text + 'B', false), embeddingCacheKey('en', text + 'A', false),
    embeddingCacheKey('zh', text + 'A', true), embeddingCacheKey('zh', text + 'A', false, 'prefix')]) assert.notEqual(key, base);
  assert.equal(base, embeddingCacheKey('zh', text + 'A', false));
});

test('RRF missing ranks contribute zero, with symmetric lexical/semantic treatment', async () => {
  const { rrfScore } = await import('../server/recall-utils.mjs');
  const lex = new Map([[1, 0], [3, 1]]), sem = new Map([[2, 0], [3, 1]]);
  assert.equal(rrfScore(1, [lex, sem]), 1 / 61);
  assert.equal(rrfScore(2, [lex, sem]), 1 / 61);
  assert.equal(rrfScore(3, [lex, sem]), 2 / 62);
  assert.equal(rrfScore(4, [lex, sem]), 0);
  assert.ok(rrfScore(3, [lex, sem]) > rrfScore(2, [lex, sem]));
});

test('index limits multibyte text and line count, including oversized pinned content', async () => {
  const { boundedIndex, boundedRecall } = await import('../server/recall-utils.mjs');
  const text = '# current\n' + Array.from({length: 500}, (_, i) => `- #${i} 中文正文😀${'很长'.repeat(200)}`).join('\n');
  const result = boundedIndex(text);
  assert.ok(Buffer.byteLength(result) <= 25 * 1024);
  assert.ok(result.trimEnd().split('\n').length <= 200);
  assert.match(result, /注入预算已满/);
  assert.ok(!result.includes('�'));
  const small = '- #1 短文本\n'; assert.equal(boundedIndex(small), small);
  const budget = boundedRecall([{id: 1, content: '中'.repeat(300)}], [{id: 2, content: '短'}], 512, true);
  assert.equal(budget.related[0].id, 2); assert.equal(budget.budget.omitted, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(budget, null, 1)) <= 512);
});
