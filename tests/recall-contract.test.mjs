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
test('dormant scope is explicit, filtered and read-only for lifecycle statistics', async () => {
  for (const semantic of [false, true]) {
    const f = await fixture(semantic ? { LM_EMBED: '1', NODE_OPTIONS: `--import=${new URL('./mock-embeddings.mjs', import.meta.url).pathname}` } : {});
    try {
      const id = await f.remember('sleepneedle 历史流程', 'procedure');
      f.db.prepare("UPDATE memories SET status='dormant' WHERE id=?").run(id);
      const before = f.db.prepare('SELECT status, hit_count, last_hit_at, updated_at FROM memories WHERE id=?').get(id);
      assert.deepEqual(await f.recall({ query: 'sleepneedle' }), []);
      for (const args of [{ query: 'sleepneedle' }, { id }, ...(semantic ? [{ query: 'semantic-query' }] : [])]) {
        const rows = await f.recall({ ...args, scope: 'dormant', kind: 'procedure' });
        assert.equal(rows[0].id, id); assert.equal(rows[0].status, 'dormant');
        assert.deepEqual(await f.recall({ ...args, scope: 'dormant', kind: 'fact' }), []);
        assert.equal((await f.recall({ ...args, scope: 'all' }))[0].id, id);
      }
      assert.deepEqual(f.db.prepare('SELECT status, hit_count, last_hit_at, updated_at FROM memories WHERE id=?').get(id), before);
      for (const status of ['deleted', 'superseded']) {
        f.db.prepare('UPDATE memories SET status=? WHERE id=?').run(status, id);
        assert.deepEqual(await f.recall({ id, scope: 'all' }), []);
      }
    } finally { await f.close(); }
  }
});

test('search budgets preserve whole evidence, while ID lookup returns complete text', async () => {
  const f = await fixture();
  try {
    const content = 'budgetneedle ' + '预算内不能把证据截成半条。'.repeat(100);
    const id = await f.remember(content);
    const response = await f.recall({ query: 'budgetneedle', max_bytes: 512 });
    assert.ok(Buffer.byteLength(JSON.stringify(response, null, 1)) <= 512);
    assert.equal(response.budget.omitted, 1);
    assert.deepEqual(response.hits, []);
    assert.equal((await f.recall({ id, max_bytes: 512 }))[0].content, content);
  } finally { await f.close(); }
});
