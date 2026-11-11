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
