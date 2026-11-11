#!/usr/bin/env node
// Every legacy suite receives its own temporary directory; never reuse caller's LM_MEMORY_DIR.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-suite-'));
const suites = ['sleep-e2e','dream-e2e','graph-e2e','current-md-e2e','refresh-e2e','viewer-e2e','e2e-test','recall-eval'];
const results = [];
for (const suite of ['contracts', ...suites, 'fixed-regression']) {
  const args = suite === 'contracts' ? ['--test', ...fs.readdirSync(path.join(root,'tests')).filter(f => f.endsWith('.test.mjs')).map(f => `tests/${f}`)]
    : suite === 'fixed-regression' ? ['scripts/eval/recall-regression.mjs'] : [`server/${suite}.mjs`];
  const start = performance.now();
  const env = {...process.env, LM_EMBED:'0', LM_MEMORY_DIR:path.join(runDir,suite)};
  delete env.NODE_OPTIONS; // No inherited model doubles or external loaders.
  const r = spawnSync(process.execPath, args, {cwd:root, env, encoding:'utf8',timeout:180000,maxBuffer:10*1024*1024});
  const output = (r.stdout ?? '') + (r.stderr ?? '');
  const log = path.join(runDir, `${suite}.log`); fs.writeFileSync(log, output);
  const passed = r.status === 0 && !r.error && !/❌|\b[1-9]\d* failed\b|✗/.test(output);
  results.push({suite, passed, exit_code:r.status, duration_ms:performance.now()-start, log, error:r.error?.message,
    evidence:output.split('\n').filter(line => /passed|failed|SUMMARY|SUMMARY:|全部|通过|✅|✓/.test(line)).slice(-3)});
  console.log(`${passed ? 'PASS':'FAIL'} ${suite} (${((performance.now()-start)/1000).toFixed(2)}s) ${log}`);
}
const summary = {node:process.version, created_at:new Date().toISOString(), results};
fs.writeFileSync(path.join(runDir,'summary.json'),JSON.stringify(summary,null,2));
console.log(`Summary: ${path.join(runDir,'summary.json')}`);
if (results.some(r => !r.passed)) process.exitCode=1;
