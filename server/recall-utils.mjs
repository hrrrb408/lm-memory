import { createHash } from 'node:crypto';
// Include the complete input, model and query/passage role; never truncate cache identity.
export function embeddingCacheKey(model, text, isQuery, prefix = '') {
  return createHash('sha256').update(JSON.stringify([model, isQuery, prefix, text])).digest('hex');
}

export function rrfScore(id, rankings, k = 60) {
  return rankings.reduce((sum, ranks) => sum + (ranks.has(id) ? 1 / (k + 1 + ranks.get(id)) : 0), 0);
}

// Keep whole records, never chop evidence text. Exact ID reads bypass this search budget.
export function boundedRecall(hits, related, maxBytes, expand = false) {
  const original = expand ? { hits, related } : hits;
  if (Buffer.byteLength(JSON.stringify(original, null, 1)) <= maxBytes) return original;
  const result = { hits: [], related: [], budget: { max_bytes: maxBytes, omitted: hits.length + related.length,
    notice: '搜索预算已满；用 memory_recall id 精确读取全文。' } };
  for (const [key, rows] of [['hits', hits], ['related', related]]) {
    for (const row of rows) {
      result[key].push(row); result.budget.omitted--;
      if (Buffer.byteLength(JSON.stringify(result, null, 1)) > maxBytes) {
        result[key].pop(); result.budget.omitted++;
      }
    }
  }
  return result;
}

export function boundedIndex(text, maxBytes = 25 * 1024, maxLines = 200) {
  const lines = text.trimEnd().split('\n');
  if (Buffer.byteLength(text) <= maxBytes && lines.length <= maxLines) return text;
  const kept = [];
  let bytes = 0, omitted = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line + '\n');
    if (bytes + size <= maxBytes - 256 && kept.length < maxLines - 2) { kept.push(line); bytes += size; }
    else omitted++;
  }
  return kept.join('\n') + `\n\n> 注入预算已满，省略 ${omitted} 行；memory_list 可列出条目，memory_recall id 可取全文。\n`;
}
