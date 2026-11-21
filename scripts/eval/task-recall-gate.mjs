// Quality gate for the opt-in task-recall experiment. Reads only local
// experiment evidence; prints a verdict and exits non-zero when not met.
// Usage: node scripts/eval/task-recall-gate.mjs <memory-dir> [--json]
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir || !path.isAbsolute(dir)) {
  console.error('usage: node scripts/eval/task-recall-gate.mjs <absolute-memory-dir> [--json]');
  process.exit(2);
}
const lines = file => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch { return []; }
};
const events = lines(path.join(dir, 'task-recall-events.jsonl'));
const audit = lines(path.join(dir, 'log.jsonl'));

// v0.19.4 复审加固：反馈必须发生在某次指针提示之后才归因给这次实验。
// 提示之前就存在的反馈（实验前旧数据）与提示后无反馈的候选都列为 unknown，
// 不计入分母，避免历史好评把门禁抬过线。
const pointers = events.filter(e => e.outcome === 'pointer');
const firstPointerAt = new Map();
for (const p of pointers) {
  const t = Date.parse(p.ts);
  if (!Number.isFinite(t)) continue;
  if (!firstPointerAt.has(p.id) || t < firstPointerAt.get(p.id)) firstPointerAt.set(p.id, t);
}
const feedback = new Map();
for (const row of audit) if (row.op === 'feedback' && Number.isSafeInteger(row.id)) {
  const entry = feedback.get(row.id) ?? [];
  entry.push({ useful: row.useful === true, ts: Date.parse(row.ts) });
  feedback.set(row.id, entry);
}
const offered = new Map();
for (const p of pointers) offered.set(p.id, (offered.get(p.id) ?? 0) + 1);
let useful = 0, notUseful = 0, answered = 0, unknown = 0;
for (const [id, count] of offered) {
  const afterPointer = (feedback.get(id) ?? []).filter(f => Number.isFinite(f.ts) && f.ts >= (firstPointerAt.get(id) ?? Infinity));
  if (!afterPointer.length) { unknown++; continue; }
  answered++;
  if (afterPointer.some(f => f.useful)) useful++; else notUseful++;
}
const metrics = {
  events: events.length,
  pointers: pointers.length,
  distinctCandidates: offered.size,
  noMatch: events.filter(e => e.outcome === 'no-match').length,
  aborted: events.filter(e => e.outcome === 'aborted').length,
  sessions: new Set(events.map(e => e.session)).size,
  candidatesWithFeedback: answered,
  candidatesWithoutAttributableFeedback: unknown,
  useful,
  notUseful,
};
// Pre-registered gate: real use must show mostly useful candidates, no
// observed misleading candidate, and enough evidence to mean something.
const rules = [
  { rule: 'pointers >= 20', pass: metrics.pointers >= 20 },
  { rule: 'attributable feedback >= 10 (post-pointer only)', pass: metrics.candidatesWithFeedback >= 10 },
  { rule: 'useful / feedback >= 0.8', pass: metrics.candidatesWithFeedback > 0 && useful / metrics.candidatesWithFeedback >= 0.8 },
  { rule: 'not-useful <= 1', pass: metrics.notUseful <= 1 },
];
const passed = rules.every(r => r.pass);
if (process.argv.includes('--json')) console.log(JSON.stringify({ ...metrics, rules, passed }, null, 2));
else {
  console.log(`task-recall gate — ${dir}`);
  for (const [key, value] of Object.entries(metrics)) console.log(`  ${key}: ${value}`);
  console.log('');
  for (const r of rules) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.rule}`);
  console.log(`\nverdict: ${passed ? 'MET — default may be reconsidered by an explicit decision' : 'NOT MET — keep taskRecall disabled by default'}`);
}
process.exit(passed ? 0 : 1);
