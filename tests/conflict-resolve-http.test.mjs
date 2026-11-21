// HTTP-level tests for POST /api/conflict/resolve (v0.19.4 复审加固):
// verdict whitelist, candidate re-check, optimistic version, audit trail.
// The handler is exercised through a minimal ctx that captures the viewer's
// HTTP server? No — the viewer's handler lives inside viewer.mjs's own
// createServer. To test it without owning port 7640, we re-implement the
// same route table by importing nothing: instead we spawn viewer.mjs on a
// scratch memory dir with a fixed port and talk real HTTP.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url));
// 复审 P2-2：端口由本进程先占一个随机免费端口再立刻释放并传给 viewer，
// 避免固定端口与其他测试/本机程序冲突，也不会误连到别人的 viewer。
const { createServer } = await import('node:http');
const probe = createServer();
const PORT = await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const base = `http://127.0.0.1:${PORT}`;
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('conflict resolve endpoint: whitelist, re-check, optimistic version, audit', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lm-resolve-e2e-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  // Seed the scratch store with a superseded-shaped pair via the real server,
  // using vectors-free text so the pair is detected by the reference signal.
  const seed = spawn(process.execPath, [path.join(root, 'server/memory-server.mjs')], {
    env: { ...process.env, LM_MEMORY_DIR: dir, LM_EMBED: '0', LM_REMOTE_DISABLED: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await new Promise(r => setTimeout(r, 1500));
  const mcp = async (name, args) => {
    // use the SDK-less path: spawn a one-shot client via the helper module
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const c = new Client({ name: 'resolve-seed', version: '1' });
    await c.connect(new StdioClientTransport({
      command: process.execPath, args: [path.join(root, 'server/memory-server.mjs')],
      env: { ...process.env, LM_MEMORY_DIR: dir, LM_EMBED: '0', LM_REMOTE_DISABLED: '1' }, stderr: 'ignore',
    }));
    const r = await c.callTool({ name, arguments: args });
    await c.close();
    return r.content?.[0]?.text ?? '';
  };
  const idOf = text => Number(text.match(/id=(\d+)/)?.[1]);
  const oldId = idOf(await mcp('memory_remember', { kind: 'procedure', content: '渲染管线 v1：ffmpeg 拼接出片' }));
  const newId = idOf(await mcp('memory_remember', { kind: 'procedure', content: `管线接棒：改用代码渲染取代旧方案 id=${oldId}，本条为其后续演进` }));
  assert.ok(oldId && newId);
  seed.kill();
  // 扫描只看带嵌入的条目；测试库没跑嵌入管线，手工造向量并固定先后
  const dbw = new DatabaseSync(path.join(dir, 'memory.db'));
  const setSeq = (id, seq) => dbw.prepare('UPDATE memories SET updated_at=? WHERE id=?').run(`2026-11-0${seq}T00:00:00.000Z`, id);
  setSeq(oldId, 1); setSeq(newId, 2);
  const setEmb = (id, arr) => {
    const f = new Float32Array(arr);
    const norm = Math.hypot(...f);
    for (let i = 0; i < f.length; i++) f[i] /= norm;
    dbw.prepare('UPDATE memories SET emb=? WHERE id=?').run(Buffer.from(f.buffer, f.byteOffset, f.byteLength), id);
  };
  setEmb(oldId, [1, 0, 0]);
  setEmb(newId, [0, 1, 0]);
  dbw.close();

  const viewer = spawn(process.execPath, [path.join(root, 'server/viewer.mjs'), String(PORT)], {
    env: { ...process.env, LM_MEMORY_DIR: dir, LM_EMBED: '0', LM_REMOTE_DISABLED: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  t.after(() => viewer.kill());
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise(r => setTimeout(r, 250));
    up = await fetch(base + '/api/version').then(r => r.ok, () => false);
  }
  assert.ok(up, 'viewer must start');

  const list = await (await fetch(base + '/api/conflicts')).json();
  const pair = list.pairs.find(p => (p.old.id === oldId && p.new.id === newId) || (p.old.id === newId && p.new.id === oldId));
  assert.ok(pair, `pair must be a current candidate: ${JSON.stringify(list.pairs.map(p => [p.old.id, p.new.id]))}`);
  const [lo, hi] = pair.old.id === oldId ? [pair.old, pair.new] : [pair.new, pair.old];

  // whitelist
  const bad = await post('/api/conflict/resolve', { old: lo.id, new: hi.id, verdict: 'haha' });
  assert.equal(bad.status, 400);

  // non-candidate pair
  const ghost = await post('/api/conflict/resolve', { old: 999999, new: hi.id, verdict: 'adopt' });
  assert.equal(ghost.status, 409);

  // 阶段 A（0.19.5）：版本号必填 + 四种场景
  const noVersion = await post('/api/conflict/resolve', { old: lo.id, new: hi.id, verdict: 'adopt' });
  assert.equal(noVersion.status, 400, '缺少版本号必须 400');

  const staleOld = await post('/api/conflict/resolve', { old: lo.id, new: hi.id, verdict: 'adopt', expected_old_version: lo.version + 99, expected_new_version: hi.version });
  assert.equal(staleOld.status, 409, '过期旧条版本必须 409');

  const staleNew = await post('/api/conflict/resolve', { old: lo.id, new: hi.id, verdict: 'adopt', expected_old_version: lo.version, expected_new_version: hi.version + 1 });
  assert.equal(staleNew.status, 409, '过期新条版本必须 409');

  const rightVersions = await post('/api/conflict/resolve', { old: lo.id, new: hi.id, verdict: 'keep', expected_old_version: lo.version, expected_new_version: hi.version });
  assert.equal(rightVersions.status, 200, '正确版本通过');
  assert.equal((await rightVersions.json()).ok, true);

  // adopt: deletes old row（并发修改模拟：先改新条内容再带正确旧版本裁决，新条版本校验应拦截）
  const bump = new DatabaseSync(path.join(dir, 'memory.db'));
  bump.prepare('UPDATE memories SET version = version + 1 WHERE id = ?').run(hi.id);
  bump.close();
  const concurrent = await post('/api/conflict/resolve', { old: lo.id, new: hi.id, verdict: 'adopt', expected_old_version: lo.version, expected_new_version: hi.version });
  assert.equal(concurrent.status, 409, '并发修改新条后裁决必须 409');
  const refreshed = await (await fetch(base + '/api/conflicts')).json();
  const freshPair = refreshed.pairs.find(p => [p.old.id, p.new.id].includes(lo.id) && [p.old.id, p.new.id].includes(hi.id));
  assert.ok(freshPair, '409 后候选仍在，可刷新重试');
  assert.equal(freshPair.new.version, hi.version + 1, 'clip 携带最新 version');
  const adopt = await post('/api/conflict/resolve', { old: lo.id, new: hi.id, verdict: 'adopt', expected_old_version: lo.version, expected_new_version: hi.version + 1 });
  assert.equal(adopt.status, 200);
  const audit = await (await fetch(base + '/api/audit')).json();
  const resolved = audit.rows.filter(r => r.op === 'conflict_resolve');
  assert.equal(resolved.length, 2, 'both verdicts audited');
  const dormant = await (await fetch(`${base}/api/dormant`)).json();
  assert.equal(dormant.total, 0);
});
