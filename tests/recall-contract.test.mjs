import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
test('ID pointers read full active text with strict argument and lifecycle boundaries', async () => {
  const f = await fixture();
  try {
    const content = '索引长条目：' + '完整内容不能截断。'.repeat(80);
    const id = await f.remember(content);
    for (const args of [{ id }, { query: `#${id}` }]) assert.equal((await f.recall(args))[0].content, content);
    assert.deepEqual(await f.recall({ id, kind: 'todo' }), []);
    assert.deepEqual(await f.recall({ id: 99999 }), []);
    assert.match(await f.call('memory_recall', {}), /ERROR/);
    assert.match(await f.call('memory_recall', { id, query: '混合参数' }), /ERROR/);
    for (const status of ['dormant', 'superseded', 'deleted']) {
      f.db.prepare('UPDATE memories SET status=? WHERE id=?').run(status, id);
      assert.deepEqual(await f.recall({ id }), []);
    }
  } finally { await f.close(); }
});
test('kind applies to lexical, semantic-only, exact ID and graph-related results', async () => {
  const f = await fixture({ LM_EMBED: '1', NODE_OPTIONS: `--import=${new URL('./mock-embeddings.mjs', import.meta.url).pathname}` });
  try {
    const fact = await f.remember('alpha lexical anchor', 'fact', 'shared');
    await f.remember('wrong type semantic distractor', 'todo', 'shared');
    assert.deepEqual((await f.recall({ query: 'semantic-query', kind: 'fact' })).map(r => r.id), [fact]);
    const result = await f.recall({ query: 'alpha', kind: 'fact', expand: true });
    assert.equal(result.hits.length, 1);
    assert.ok([...result.hits, ...result.related].every(r => r.kind === 'fact'));
    assert.deepEqual(await f.recall({ query: 'semantic-query', kind: 'episode' }), []);
  } finally { await f.close(); }
});
test('long passages with the same 400-character prefix store different bilingual vectors', async () => {
  const f = await fixture({ LM_EMBED: '1', NODE_OPTIONS: `--import=${new URL('./mock-embeddings.mjs', import.meta.url).pathname}` });
  try {
    const a = await f.remember('x'.repeat(401) + 'TailA');
    const b = await f.remember('x'.repeat(401) + 'TailB');
    for (const col of ['emb', 'emb_en']) {
      const read = id => Buffer.from(f.db.prepare(`SELECT ${col} v FROM memories WHERE id=?`).get(id).v);
      assert.notDeepEqual(read(a), read(b));
    }
  } finally { await f.close(); }
});
