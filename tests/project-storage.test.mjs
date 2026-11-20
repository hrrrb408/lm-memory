import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bindProjectSession, projectDirectory } from '../plugin/lib/project-storage.mjs';

test('separate project stores; no fallback on an invalid binding or an alias', async t => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lm-project-store-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const a = { id: 'a'.repeat(64) }, b = { id: 'b'.repeat(64) }, c = { id: 'c'.repeat(64) };
  const storeA = await projectDirectory(base, a), storeB = await projectDirectory(base, b);
  assert.equal(storeA, path.join(base, 'projects-v1', a.id));
  assert.equal(storeB, path.join(base, 'projects-v1', b.id));
  assert.equal(await projectDirectory(base, a), storeA);
  await symlink(storeA, path.join(base, 'projects-v1', c.id), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await projectDirectory(base, c), null);
  assert.equal(await projectDirectory(base, { id: '../../' }), null);
  assert.equal(await projectDirectory(base, null), null);
  const other = path.join(base, 'untrusted');
  await mkdir(other);
  await symlink(path.join(base, 'projects-v1'), path.join(other, 'projects-v1'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await projectDirectory(other, a), null);
});

test('session binding is durable, restart-readable and first-writer-wins', async t => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lm-project-bind-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sid = 'session-00000000-0000-0000-0000-000000000001';
  const a = { id: 'a'.repeat(64) }, b = { id: 'b'.repeat(64) };
  assert.equal(await bindProjectSession(base, sid, a), null);
  const [resultA, resultB] = await Promise.all([
    bindProjectSession(base, sid, a, { create: true }),
    bindProjectSession(base, sid, b, { create: true }),
  ]);
  assert.notEqual(Boolean(resultA), Boolean(resultB));
  const [winner, loser] = resultA ? [a,b] : [b,a];
  assert.equal(await bindProjectSession(base, sid, winner), resultA ?? resultB);
  assert.equal(await bindProjectSession(base, sid, loser, { create: true }), null);
  assert.equal(await bindProjectSession(base, '../' + sid, winner, { create: true }), null);
});
