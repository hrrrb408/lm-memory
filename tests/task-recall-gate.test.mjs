import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/eval/task-recall-gate.mjs', import.meta.url));
const line = value => JSON.stringify(value) + '\n';
const setup = (events, audit) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lm-task-gate-'));
  writeFileSync(path.join(dir, 'task-recall-events.jsonl'), events.map(line).join(''));
  writeFileSync(path.join(dir, 'log.jsonl'), audit.map(line).join(''));
  return dir;
};
const pointer = id => ({ ts: '2026-11-20T00:00:00.000Z', session: 's', id, outcome: 'pointer' });
const feedbackRow = (id, useful, ts = '2026-11-20T01:00:00.000Z') => ({ ts, op: 'feedback', id, useful });

test('gate stays closed without real evidence and opens only on the pre-registered thresholds', async t => {
  const empty = setup([{ session: 's', outcome: 'no-match' }], []);
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  await assert.rejects(run(process.execPath, [script, empty]), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /NOT MET/);
    return true;
  });

  const weak = setup(Array.from({ length: 25 }, (_, i) => pointer(i + 1)),
    Array.from({ length: 12 }, (_, i) => feedbackRow(i + 1, i < 8)));
  t.after(() => rmSync(weak, { recursive: true, force: true }));
  await assert.rejects(run(process.execPath, [script, weak]), error => {
    assert.match(error.stdout, /FAIL  not-useful <= 1/);
    return true;
  });

  const strong = setup(Array.from({ length: 25 }, (_, i) => pointer(i + 1)),
    Array.from({ length: 12 }, (_, i) => feedbackRow(i + 1, i < 11)));
  t.after(() => rmSync(strong, { recursive: true, force: true }));
  const { stdout } = await run(process.execPath, [script, strong, '--json']);
  const result = JSON.parse(stdout);
  assert.equal(result.passed, true);
  assert.equal(result.useful, 11);
  assert.equal(result.notUseful, 1);
  // 复审实锤：提示之前就存在的反馈不能归因给这次实验
  const stale = setup(Array.from({ length: 25 }, (_, i) => pointer(i + 1)),
    Array.from({ length: 12 }, (_, i) => feedbackRow(i + 1, true, '2026-11-19T00:00:00.000Z')));
  t.after(() => rmSync(stale, { recursive: true, force: true }));
  await assert.rejects(run(process.execPath, [script, stale, '--json']), error => {
    const m = JSON.parse(error.stdout);
    assert.equal(m.candidatesWithFeedback, 0);
    assert.equal(m.candidatesWithoutAttributableFeedback, 25); // 全部候选无可归因反馈
    assert.equal(m.passed, false); // 不可归因的反馈一律不算成功
    return true;
  });

  await assert.rejects(run(process.execPath, [script, 'relative']), error => error.code === 2);
});
