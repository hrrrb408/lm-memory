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

test('gate stays closed without real evidence and opens only on the pre-registered thresholds', async t => {
  const empty = setup([{ session: 's', outcome: 'no-match' }], []);
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  await assert.rejects(run(process.execPath, [script, empty]), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /NOT MET/);
    return true;
  });

  const weak = setup(Array.from({ length: 25 }, (_, i) => pointer(i + 1)),
    Array.from({ length: 12 }, (_, i) => ({ op: 'feedback', id: i + 1, useful: i < 8 })));
  t.after(() => rmSync(weak, { recursive: true, force: true }));
  await assert.rejects(run(process.execPath, [script, weak]), error => {
    assert.match(error.stdout, /FAIL  not-useful <= 1/);
    return true;
  });

  const strong = setup(Array.from({ length: 25 }, (_, i) => pointer(i + 1)),
    Array.from({ length: 12 }, (_, i) => ({ op: 'feedback', id: i + 1, useful: i < 11 })));
  t.after(() => rmSync(strong, { recursive: true, force: true }));
  const { stdout } = await run(process.execPath, [script, strong, '--json']);
  const result = JSON.parse(stdout);
  assert.equal(result.passed, true);
  assert.equal(result.useful, 11);
  assert.equal(result.notUseful, 1);
  await assert.rejects(run(process.execPath, [script, 'relative']), error => error.code === 2);
});
