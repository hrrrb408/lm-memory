import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTaskLookup, createTaskRecallHook, taskRecallAnchors } from '../plugin/lib/task-recall.mjs';

const opts = { taskRecall: { enabled: true, sessionIds: ['only'] } };
const session = { id: 'only' };
const user = (id, text, source = 'user') => ({ role: 'user', id, content: [{ type: 'text', text }], source: { kind: source } });
const query = '上次 lm-memory Viewer 配置什么端口？';
const prompt = (message, selected = session) => ({ agent: { session: selected }, messages: [message] });
const decision = (...messages) => ({ kind: 'enter', messages, startsRequestSeries: true });

test('requires a retrospective task and literal anchors; rejects secrets, opt-outs and large messages', () => {
  assert.deepEqual(taskRecallAnchors(query), ['lm-memory', 'viewer']);
  assert.deepEqual(taskRecallAnchors('上次「部署验收」怎么做？'), ['部署验收']);
  for (const input of ['用 lm-memory 配置 Viewer', '上次用哪个？', '上次 Viewer 怎么用？',
    `别查记忆。${query}`, `这段别记：${query}`, `${query} password=abcdefgh`, `${query}${'字'.repeat(400)}`]) {
    assert.equal(taskRecallAnchors(input), null, input.slice(0, 42));
  }
});

test('disabled by default, no scope wildcard, and no automatic lookup when forbid-remote is configured', () => {
  for (const config of [{}, { taskRecall: { enabled: true } }, { ...opts, allowRemote: false },
    { taskRecall: { enabled: true, sessionIds: 'only' } }, { taskRecall: { enabled: 'true', sessionIds: ['only'] } }]) {
    assert.equal(createTaskRecallHook(config, '.'), null);
  }
});

test('only an admitted genuine message in the configured session can yield a bounded pointer, deduped for the live session', async () => {
  let calls = 0;
  const hook = createTaskRecallHook(opts, '.', async () => { calls++; return 47; });
  const msg = user('a', query);
  for (const [p, d] of [
    [prompt(msg, { id: 'outside' }), decision(msg)],
    [prompt(user('generated', query, 'runtime-context')), decision(msg)],
    [prompt(msg), decision(user('a', query))],
    [prompt(msg), { kind: 'reject' }],
    [{ ...prompt(msg), messages: [msg, user('b', query)] }, decision(msg)],
    [{ ...prompt(msg), signal: AbortSignal.abort() }, decision(msg)],
  ]) assert.equal(await hook(p, () => d), d);
  assert.equal(calls, 0);
  const d = decision(msg);
  const result = await hook(prompt(msg), () => d);
  assert.equal(result.startsRequestSeries, true);
  assert.equal(result.messages[0], msg);
  assert.equal(d.messages.length, 1);
  const hint = result.messages[1];
  assert.equal(hint.source.kind, 'lm-memory-task-recall');
  assert.ok(hint.content[0].text.includes('id:47, scope:"active"'));
  assert.ok(!hint.content[0].text.includes(query));
  assert.ok(Buffer.byteLength(hint.content[0].text) <= 512);
  assert.equal(await hook(prompt(msg), () => d), d);
  assert.equal(calls, 1);
  const newer = user('b', query), d2 = decision(newer);
  assert.equal(await hook(prompt(newer), () => d2), d2);
  assert.equal(calls, 2);
});

test('project recall uses only the bound directory and points to the project tool', async () => {
  const a = { id: 'scope-a' }, b = { id: 'scope-b' }, unbound = { id: 'scope-none' };
  const routes = new Map([[a,path.resolve('a')],[b,path.resolve('b')]]);
  const checked = [];
  const hook = createTaskRecallHook({taskRecall:{enabled:true,sessionIds:[a.id,b.id,unbound.id]}},
    session => routes.get(session), async (_terms,_signal,dir) => { checked.push(dir); return 47; });
  const msg = user('one', query), d = decision(msg);
  assert.equal(await hook(prompt(msg,unbound), () => d), d);
  for (const session of [a,b]) {
    const out = await hook(prompt(msg,session), () => d);
    assert.match(out.messages[1].content[0].text, /mcp__lm_project__memory_recall/);
    assert.doesNotMatch(out.messages[1].content[0].text, /mcp__lm_personal/);
  }
  assert.deepEqual(checked,[routes.get(a),routes.get(b)]);
});

test('records a bounded experiment trace without user text, only under an absolute store', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lm-task-trace-'));
  try {
    const msg = user('a', query), d = decision(msg);
    const sessioned = { id: 'trace' };
    const hook = createTaskRecallHook({ taskRecall: { enabled: true, sessionIds: ['trace'] } }, dir, async () => 7);
    await hook(prompt(msg, sessioned), () => d);
    const missing = await createTaskRecallHook({ taskRecall: { enabled: true, sessionIds: ['trace'] } }, dir, async () => null);
    const second = user('b', query);
    await missing(prompt(second, sessioned), () => decision(second));
    const rows = readFileSync(path.join(dir, 'task-recall-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(r => r.outcome), ['pointer', 'no-match']);
    assert.equal(rows[0].id, 7);
    assert.equal(rows[0].session, 'trace');
    assert.ok(!readFileSync(path.join(dir, 'task-recall-events.jsonl'), 'utf8').includes(query));
    await createTaskRecallHook({ taskRecall: { enabled: true, sessionIds: ['trace'] } }, '.', async () => 7)(prompt(msg, sessioned), () => d);
    assert.equal(readFileSync(path.join(dir, 'task-recall-events.jsonl'), 'utf8').trim().split('\n').length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects bad/late lookup output and fails open without rewriting host decisions', async () => {
  const msg = user('a', query), d = decision(msg);
  for (const lookup of [async () => ({ id: 2, content: 'not for prompt' }), async () => { throw new Error('not for logs'); }]) {
    assert.equal(await createTaskRecallHook(opts, '.', lookup)(prompt(msg), () => d), d);
  }
  const controller = new AbortController();
  const hook = createTaskRecallHook(opts, '.', async () => { controller.abort(); return 2; });
  assert.equal(await hook({ ...prompt(msg), signal: controller.signal }, () => d), d);
  await assert.rejects(createTaskRecallHook(opts, '.', async () => 1)(prompt(msg), () => { throw Error('host'); }), /host/);
});

test('actual SQLite worker finds one active literal match, abstains on ambiguity, and never writes or renews', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lm-task-recall-'));
  const filename = path.join(dir, 'memory.db');
  const db = new DatabaseSync(filename);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, tags TEXT, status TEXT, kind TEXT, hit_count INTEGER DEFAULT 0, used_count INTEGER DEFAULT 0);
    CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, content='memories', content_rowid='id', tokenize='trigram');`);
  function add(id, content, status = 'active', kind = 'fact') {
    db.prepare('INSERT INTO memories (id,content,status,kind) VALUES (?,?,?,?)').run(id, content, status, kind);
    db.prepare('INSERT INTO memories_fts(rowid,content) VALUES (?,?)').run(id, content);
  }
  add(1, 'lm-memory Viewer port is 7640');
  add(2, 'lm-memory Viewer port is 7040', 'superseded');
  add(3, 'lm-memory Viewer port is 7041', 'dormant');
  add(4, 'lm-memory Viewer port is 7042', 'deleted');
  add(5, 'lm-memory Viewer port was 7043', 'active', 'episode');
  add(6, '部署验收共三步');
  add(7, '星云密码 password=abcd12345');
  add(8, 'SQLite backed up via retentioner');
  async function lookup(terms, signal) { return createTaskLookup(filename, { timeoutMs: 1500 })(terms, signal); }
  assert.equal(await lookup(['lm-memory', 'viewer']), 1);
  assert.equal(await lookup(['部署验收']), 6);
  assert.equal(await lookup(['星云密码']), null);
  assert.equal(await lookup(['sqlite', 'retention']), null);
  assert.equal(await lookup(['nope']), null);
  assert.equal(await lookup(['lm-memory', 'viewer'], AbortSignal.abort()), null);
  add(9, 'another lm-memory Viewer instance');
  assert.equal(await lookup(['lm-memory', 'viewer']), null);
  assert.deepEqual({ ...db.prepare('SELECT sum(hit_count) AS hit, sum(used_count) AS used FROM memories').get() }, { hit: 0, used: 0 });
  assert.equal(await createTaskLookup(path.join(dir, 'nonexistent.db'), { timeoutMs: 1500 })(['test']), null);
  assert.equal(await createTaskLookup(filename, { timeoutMs: 0 })(['部署验收']), null);
});
