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
