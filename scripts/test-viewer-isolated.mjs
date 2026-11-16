// Isolated viewer regression: node scripts/test-viewer-isolated.mjs
// Runs a temporary copy of the real viewer against a deterministic MCP stub.
// It never opens the user's memory directory or calls an external model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-viewer-test-'));
const long = '长记忆🐋'.repeat(50) + '\n<script>alert("x")</script> & 完整结尾';
const rows = [
  { id: 1, version: 1, kind: 'fact', content: long, updated_at: '2026-01-01T00:00:00Z' },
  { id: 2, version: 1, kind: 'fact', content: '项目事实不应成为待办', updated_at: '2026-01-02T00:00:00Z' },
  { id: 3, version: 1, kind: 'todo', content: '唯一待办', updated_at: '2026-01-03T00:00:00Z' },
  ...[1, 7, 3, 5, 2, 6, 4].map((n) => ({ id: 10+n, version: 1, kind: 'episode', content: '足迹'+n, updated_at: `2026-02-0${n}T00:00:00Z` })),
  ...Array.from({ length: 7 }, (_, n) => ({ id: 30+n, version: 1, kind: 'preference', content: '偏好'+n, updated_at: '2026-01-01T00:00:00Z' })),
];
let child;
try {
  fs.mkdirSync(path.join(tmp, 'server'));
  fs.copyFileSync(path.join(root, 'server/viewer.mjs'), path.join(tmp, 'server/viewer.mjs'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"version":"test"}');
  // The viewer starts this stub in place of memory-server; no real MCP/database mutations.
  fs.writeFileSync(path.join(tmp, 'server/memory-server.mjs'), `
import readline from 'node:readline';
const rows = ${JSON.stringify(rows)};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  let result = {};
  if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  if (m.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});`);
  const mem = path.join(tmp, 'memory'); fs.mkdirSync(mem);
  const db = new DatabaseSync(path.join(mem, 'memory.db'));
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); db.close();
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
  child = spawn(process.execPath, [path.join(tmp, 'server/viewer.mjs'), String(port)], { env: { ...process.env, LM_MEMORY_DIR: mem, HOME: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', (b) => { err += b; });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(([code]) => { throw Error(`viewer exited ${code}: ${err}`); })]);
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(base + '/'); assert.equal(response.status, 200);
  const html = await response.text(); assert.match(html, /<title>记忆库/);
  const profile = await (await fetch(base + '/api/profile')).json();
  assert.deepEqual(profile.todos.map((m) => m.id), [3]);
  assert.deepEqual(profile.episodes.map((m) => m.content), ['足迹7','足迹6','足迹5','足迹4','足迹3']);
  const memories = await (await fetch(base + '/api/memories')).json();
  assert.equal(memories.items.find((m) => m.id === 1).content, long);

  // Execute the actual returned client script with a tiny DOM harness. It exercises
  // rendering and the correction UI, not browser layout or keyboard behavior.
  const els = new Map();
  function element(selector) {
    if (!els.has(selector)) els.set(selector, { innerHTML: '', textContent: '', style: {}, dataset: {}, classList: { toggle() {} }, addEventListener() {} });
    return els.get(selector);
  }
  const ctx = { document: { querySelector: element }, URLSearchParams, Map, setTimeout, clearTimeout, console,
    fetch: (url, options) => fetch(base + url, options), alert() {}, confirm: () => false };
  ctx.window = ctx; vm.createContext(ctx);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]; assert.ok(script);
  vm.runInContext(script, ctx);
  await ctx.load();
  const list = element('#list').innerHTML;
  assert.match(list, /<details class="content-more">/);
  assert.ok(list.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; 完整结尾'));
  assert.ok(!list.includes('<script>alert("x")</script>'));
  await ctx.correct(1);
  const editor = element('#extra1').innerHTML;
  const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[c]);
  assert.ok(editor.includes('<textarea class="editbox" rows="2">' + escape(long) + '</textarea>'), 'editor must contain exact full text, not preview');
  await ctx.loadProfile();
  const p = element('#profile').innerHTML;
  assert.match(p, /画像概览/); assert.match(p, /原始记忆条目/);
  assert.match(p, /展开其余 2 条/); assert.match(p, /外部模型/);
  const todoSection = p.match(/<h3>待办[^]*?<\/section>/)?.[0];
  assert.ok(todoSection?.includes('唯一待办')); assert.ok(!todoSection.includes('项目事实'));
  console.log('PASS: isolated HTTP, MCP fixture, client rendering, full-text edit, escaping, profile grouping and recent order');
} finally {
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  fs.rmSync(tmp, { recursive: true, force: true });
}
