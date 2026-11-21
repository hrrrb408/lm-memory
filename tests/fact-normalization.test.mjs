import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture } from './helpers.mjs';

const sid = n => `session-00000000-0000-0000-0000-00000000000${n}`;
const candidate = (n, content, evidence, kind = 'fact') => JSON.stringify({
  eid: `confirmed-${n}-${kind}-${content.length}-${content.charCodeAt(0)}`, sessionId: sid(n), kind, content, capturedAt: new Date(Date.UTC(2026,10,n,9)).toISOString(),
  eventDate: `2026-11-0${n}`, tags: `confirmed-outcome,session:${sid(n)}`,
  evidence: [{ message_index: 4, text: `确认结论：${evidence}` }],
});

test('the same confirmed fact from two sessions stays one row and gains corroborating evidence', async t => {
  const f = await fixture({ LM_EMBED: '0', LM_REMOTE_DISABLED: '1' });
  t.after(() => f.close());
  const file = path.join(f.dir, 'pending-memories.jsonl');
  appendFileSync(file, candidate(1, 'Viewer port is 7640.', 'Viewer port is 7640.') + '\n');
  appendFileSync(file, candidate(2, 'ｖｉｅｗｅｒ port is 7640', 'Viewer port is 7640.') + '\n');
  const hits = await f.recall({ query: 'Viewer port 7640' });
  assert.equal(hits.length, 1);
  const source = JSON.parse(await f.call('memory_source', { id: hits[0].id }));
  assert.equal(source.session_id, sid(1));
  assert.equal(source.corroborations.length, 1);
  assert.equal(source.corroborations[0].session_id, sid(2));
  assert.match(source.corroborations[0].evidence[0].text, /确认结论/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM memories WHERE status=?').get('active').n, 1);
  await f.call('memory_forget', { id: hits[0].id, hard: true });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM corroboration').get().n, 0);
});

test('different wording, a different kind, or the same session does not fabricate corroboration', async t => {
  const f = await fixture({ LM_EMBED: '0', LM_REMOTE_DISABLED: '1' });
  t.after(() => f.close());
  const file = path.join(f.dir, 'pending-memories.jsonl');
  appendFileSync(file, candidate(1, 'Viewer port is 7640', 'Viewer port is 7640') + '\n');
  appendFileSync(file, candidate(1, 'Viewer port is 7640 now', 'Viewer port is 7640 now') + '\n');
  appendFileSync(file, candidate(3, 'viewer port is 7640', 'viewer port is 7640', 'procedure') + '\n');
  appendFileSync(file, candidate(1, 'Viewer port is 7640', 'Viewer port is 7640') + '\n');
  const hits = await f.recall({ query: 'Viewer port 7640', limit: 20 });
  // fact 归一为 1 条（宽半角并入），procedure 是独立 kind（复审实锤：跨类型不是 EXISTS）
  assert.equal(hits.length, 3);
  assert.equal(hits.filter(h => h.kind === 'fact').length, 2);
  assert.equal(hits.filter(h => h.kind === 'procedure').length, 1);
  for (const hit of hits) assert.equal(JSON.parse(await f.call('memory_source', { id: hit.id })).corroborations.length, 0);
});
