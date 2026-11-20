import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/migrate-to-personal.mjs', import.meta.url));

test('migrates active memories into the personal store idempotently and never deletes the source', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lm-migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, 'memory.db'));
  db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL, content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'agent',
    status TEXT NOT NULL DEFAULT 'active', supersedes INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    emb BLOB, hit_count INTEGER NOT NULL DEFAULT 0, last_hit_at TEXT, pinned INTEGER NOT NULL DEFAULT 0,
    emb_en BLOB, event_date TEXT, used_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT);`);
  const insert = db.prepare(`INSERT INTO memories (kind,content,tags,status,created_at,updated_at,pinned,event_date)
    VALUES (?,?,?,?,?,?,?,?)`);
  insert.run('preference', 'MIGRATE-KEEP 用户偏好简洁回答', 'a', 'active', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 1, '2026-11-01');
  insert.run('fact', 'MIGRATE-KEEP 用户的时区是东八区', '', 'active', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 0, '2026-11-02');
  insert.run('fact', 'MIGRATE-DROP 已经被取代的旧说法', '', 'superseded', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z', 0, null);
  insert.run('fact', 'MIGRATE-DROP 已删除的说法', '', 'deleted', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z', 0, null);
  db.close();

  const dry = await run(process.execPath, [script, '--memory-dir', dir, '--dry-run']);
  assert.match(dry.stdout, /active rows to copy: 2/);

  const first = await run(process.execPath, [script, '--memory-dir', dir]);
  assert.match(first.stdout, /copied 2, already present 0/);
  const second = await run(process.execPath, [script, '--memory-dir', dir]);
  assert.match(second.stdout, /copied 0, already present 2/);

  const target = new DatabaseSync(path.join(dir, 'personal-v1', 'memory.db'), { readOnly: true });
  const rows = target.prepare("SELECT content,pinned,event_date FROM memories WHERE status='active' ORDER BY id").all();
  target.close();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.content.startsWith('MIGRATE-KEEP')).sort(), [true, true]);
  assert.equal(rows.every(r => /^2026-11-\d{2}$/.test(r.event_date)), true);
  assert.equal(rows.filter(r => r.pinned === 1).length, 1);
  const source = new DatabaseSync(path.join(dir, 'memory.db'), { readOnly: true });
  assert.equal(source.prepare('SELECT count(*) n FROM memories').get().n, 4);
  source.close();
});
