import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createProjectBackends } from '../plugin/lib/project-backends.mjs';
import catalog from '../plugin/lib/project-tool-catalog.json' with { type: 'json' };

test('real stdio backends isolate equal numeric IDs, and never route on absent scope', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lm-project-mcp-'));
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  const pool = createProjectBackends({ command: process.execPath,
    server: fileURLToPath(new URL('../server/memory-server.mjs', import.meta.url)), maxOpen: 1,
    env: { HOME: root, USERPROFILE: root, LM_EMBED: '0', LM_REMOTE_DISABLED: '1' } });
  t.after(async () => { await pool.close(); await rm(root, { recursive: true, force: true }); });
  await Promise.all([mkdir(a), mkdir(b)]);
  const call = async (dir, name, args) => (await pool.call(dir, name, args)).content[0].text;
  const { tools } = await pool.list(a);
  assert.equal(tools.length, 10);
  assert.deepEqual(tools.map(({name,description,inputSchema}) => ({name,description,inputSchema})), catalog);
  assert.match(await call(a, 'memory_remember', { kind: 'fact', content: 'Project A anchor ROCK-A98' }), /id=1/);
  assert.match(await call(b, 'memory_remember', { kind: 'fact', content: 'Project B anchor ROCK-B98' }), /id=1/);
  assert.match(await call(a, 'memory_recall', { id: 1 }), /ROCK-A98/);
  assert.doesNotMatch(await call(b, 'memory_recall', { id: 1 }), /ROCK-A98/);
  assert.match(await call(b, 'memory_recall', { id: 1 }), /ROCK-B98/);
  await call(b, 'memory_forget', { id: 1 });
  assert.match(await call(a, 'memory_recall', { id: 1 }), /ROCK-A98/);
  await assert.rejects(pool.list(''), /not bound/);
  await assert.rejects(pool.list(b, AbortSignal.abort()), /abort/i);
  await pool.close();
  await assert.rejects(pool.list(b), /closed/);
});
