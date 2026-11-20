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

// A pointer counts as used only when explicit feedback follows it for that id.
const feedback = new Map();
for (const row of audit) if (row.op === 'feedback' && Number.isSafeInteger(row.id)) {
  const entry = feedback.get(row.id) ?? { useful: 0, notUseful: 0, first: row.ts };
  if (row.useful === true) entry.useful++; else entry.notUseful++;
  feedback.set(row.id, entry);
}
const pointers = events.filter(e => e.outcome === 'pointer');
const offered = new Map();
for (const p of pointers) offered.set(p.id, (offered.get(p.id) ?? 0) + 1);
let useful = 0, notUseful = 0, answered = 0;
for (const id of offered.keys()) {
  const f = feedback.get(id);
  if (!f) continue;
  answered++;
  if (f.useful) useful++; else notUseful++;
}
const metrics = {
  events: events.length,
  pointers: pointers.length,
  distinctCandidates: offered.size,
  noMatch: events.filter(e => e.outcome === 'no-match').length,
  aborted: events.filter(e => e.outcome === 'aborted').length,
  sessions: new Set(events.map(e => e.session)).size,
  candidatesWithFeedback: answered,
  useful,
  notUseful,
};
// Pre-registered gate: real use must show mostly useful candidates, no
// observed misleading candidate, and enough evidence to mean something.
const rules = [
  { rule: 'pointers >= 20', pass: metrics.pointers >= 20 },
  { rule: 'candidates with feedback >= 10', pass: metrics.candidatesWithFeedback >= 10 },
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
