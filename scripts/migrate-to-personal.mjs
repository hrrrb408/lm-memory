// One-shot, opt-in copy of the existing global memory library into the
// project-mode personal store. Public MCP writes only: no schema copying, no
// direct SQLite edits, no deletion of the source. Re-running is safe because
// the target store drops identical content.
//
// Usage: node scripts/migrate-to-personal.mjs [--memory-dir DIR] [--dry-run]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const argValue = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const dryRun = argv.includes('--dry-run');
const memoryDir = path.resolve(argValue('--memory-dir')
  ?? process.env.LM_MEMORY_DIR
  ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'memory'));
const source = path.join(memoryDir, 'memory.db');
const target = path.join(memoryDir, 'personal-v1');

if (!fs.existsSync(source)) {
  console.error(`no legacy database at ${source}`);
  process.exit(2);
}

const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
const legacy = new DatabaseSync(source, { readOnly: true });
const rows = legacy.prepare(`SELECT id,kind,content,tags,event_date,pinned FROM memories
  WHERE status='active' ORDER BY id`).all();
legacy.close();

console.log(`source: ${source}`);
console.log(`target: ${target}`);
console.log(`active rows to copy: ${rows.length}`);
if (dryRun) { console.log('dry run: nothing written'); process.exit(0); }

fs.mkdirSync(target, { recursive: true, mode: 0o700 });
const client = new Client({ name: 'lm-memory-migrate', version: '1' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../server/memory-server.mjs', import.meta.url))],
  env: { ...process.env, LM_MEMORY_DIR: target, LM_EMBED: '0' },
  stderr: 'ignore',
}));

let copied = 0, existing = 0, refused = 0;
const failures = [];
for (const row of rows) {
  const args = { content: row.content, kind: row.kind, tags: row.tags ?? '' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(row.event_date ?? '')) args.event_date = row.event_date;
  let text;
  try {
    text = (await client.callTool({ name: 'memory_remember', arguments: args }, undefined, { timeout: 30_000 }))
      .content?.[0]?.text ?? '';
  } catch (error) { failures.push({ id: row.id, error: String(error.message).slice(0, 120) }); continue; }
  const id = Number(/id=(\d+)/.exec(text)?.[1]);
  if (text.startsWith('OK:') && id) {
    copied++;
    if (row.pinned) await client.callTool({ name: 'memory_pin', arguments: { id, action: 'pin' } });
  } else if (text.startsWith('EXISTS')) existing++;
  else if (text.startsWith('REFUSED')) refused++;
  else failures.push({ id: row.id, error: text.slice(0, 120) });
}
await client.close();

console.log(`copied ${copied}, already present ${existing}, refused ${refused}, failed ${failures.length}`);
if (failures.length) {
  for (const failure of failures.slice(0, 10)) console.error(`  legacy #${failure.id}: ${failure.error}`);
  process.exitCode = 1;
}
console.log('source database untouched; delete it yourself only after checking the target store');
