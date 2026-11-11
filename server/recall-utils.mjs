import { createHash } from 'node:crypto';
// Include the complete input, model and query/passage role; never truncate cache identity.
export function embeddingCacheKey(model, text, isQuery, prefix = '') {
  return createHash('sha256').update(JSON.stringify([model, isQuery, prefix, text])).digest('hex');
}

export function rrfScore(id, rankings, k = 60) {
  return rankings.reduce((sum, ranks) => sum + (ranks.has(id) ? 1 / (k + 1 + ranks.get(id)) : 0), 0);
}
