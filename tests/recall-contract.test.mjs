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
