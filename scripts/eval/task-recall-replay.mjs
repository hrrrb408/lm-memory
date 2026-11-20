// Deterministic retrieval-level replay of the opt-in task-recall hook against a
// temporary SQLite store built from frozen fixture memories (scripts/eval/dataset.json).
// It measures when the pointer fires, whether it points at the right row, the
// bytes it adds, and whether it stays silent on negatives. It does NOT measure
// answer quality: no model reads the pointer here.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTaskRecallHook } from '../../plugin/lib/task-recall.mjs';

const fixture = JSON.parse(readFileSync(new URL('./dataset.json', import.meta.url), 'utf8'));
const pick = ['m01', 'm02', 'm04', 'm10', 'm11', 'm14', 'm15', 'm24', 'm25'];
const dir = mkdtempSync(path.join(tmpdir(), 'lm-task-recall-eval-'));
const db = new DatabaseSync(path.join(dir, 'memory.db'));
db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, tags TEXT, status TEXT, kind TEXT, hit_count INTEGER DEFAULT 0, used_count INTEGER DEFAULT 0);
  CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, content='memories', content_rowid='id', tokenize='trigram');`);
const rowIds = new Map();
for (const memory of fixture.memories.filter(m => pick.includes(m.id))) {
  const r = db.prepare('INSERT INTO memories (content,status,kind) VALUES (?,?,?)').run(memory.content, 'active', memory.kind);
  rowIds.set(memory.id, Number(r.lastInsertRowid));
  db.prepare('INSERT INTO memories_fts (rowid,content) VALUES (?,?)').run(Number(r.lastInsertRowid), memory.content);
}
db.close();

const session = { id: 'eval-session' };
const hook = createTaskRecallHook({ taskRecall: { enabled: true, sessionIds: [session.id] } }, dir);
const settle = () => new Promise(resolve => setTimeout(resolve, 50)); // one worker slot, released on exit
const ask = async (text, id = Math.random().toString(36)) => {
  const message = { role: 'user', id, content: [{ type: 'text', text }], source: { kind: 'user' } };
  const decision = { kind: 'enter', messages: [message], startsRequestSeries: true };
  const out = await hook({ agent: { session }, messages: [message] }, () => decision);
  await settle();
  const hint = out.messages.find(m => m.source?.kind === 'lm-memory-task-recall');
  return hint ? { id: Number(/id:(\d+)/.exec(hint.content[0].text)[1]), bytes: Buffer.byteLength(hint.content[0].text) } : null;
};

// Exact literal anchors that occur verbatim in the stored memory.
const positives = [
  ['上次「MacBook M4 Pro」的配置是什么？', 'm04'],
  ['上次那个「GitHub 账号」叫什么？', 'm10'],
  ['上次「ls 不支持 --time-style」怎么处理的？', 'm24'],
  ['还记得「SQLite FTS5 外部内容表」那个坑吗？', 'm15'],
  ['之前「npm 缓存被 root 权限污染」那次怎么解决的？', 'm13'],
];
// Paraphrases the literal lookup cannot serve; abstaining here is correct, and
// the rate is reported so a weak anchor design is not hidden.
const paraphrases = [
  ['上次 lm-memory 开源到哪个 GitHub 仓库？', 'no literal anchor'],
  ['之前 DSH 网页界面 401 是怎么开的？', 'anchor not contiguous in the memory'],
];
const negatives = [
  ['用 lm-memory 配置 Viewer', 'no retrospective signal'],
  ['上次你说的那个方案怎么算了？', 'no literal anchor'],
  ['别查记忆。「MacBook M4 Pro」配置是什么？', 'explicit opt-out'],
  ['上次「GitHub 账号」token=abcdefghijkl 是多少？', 'secret-like content'],
  ['上次「中南大学 Origin」的授权方案？', 'two active rows share both anchors'],
];
let hit = 0, wrong = 0, added = 0;
for (const [text, memory] of positives) {
  const result = await ask(text);
  added = Math.max(added, result?.bytes ?? 0);
  if (result?.id === rowIds.get(memory)) hit++;
  else if (result) wrong++;
}
let falsePositive = 0;
for (const [text, why] of negatives) {
  const result = await ask(text);
  if (result) { falsePositive++; console.error(`  unexpected pointer on negative: ${why} -> #${result.id}`); }
}
let paraphraseFired = 0;
for (const [text, why] of paraphrases) {
  const result = await ask(text);
  if (result) paraphraseFired++;
  console.error(`  paraphrase ${result ? `#${result.id}` : 'abstained'}: ${why}`);
}
const report = {
  positives: positives.length,
  correct: hit,
  wrongCandidate: wrong,
  abstained: positives.length - hit - wrong,
  paraphraseCases: paraphrases.length,
  paraphraseFired,
  negatives: negatives.length,
  falsePointers: falsePositive,
  bytesAddedMax: 0,
};
report.bytesAddedMax = added;
console.log(JSON.stringify(report));
assert.equal(report.wrongCandidate, 0);
assert.equal(report.falsePointers, 0);
rmSync(dir, { recursive: true, force: true });
