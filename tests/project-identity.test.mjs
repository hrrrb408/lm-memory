import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveProjectIdentity } from '../plugin/lib/project-identity.mjs';

test('project identity follows the physical Git root, not syntax, names or ambient Git overrides', async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lm-project-id-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const a = path.join(base, '甲', 'same'), b = path.join(base, '乙', 'same');
  for (const root of [a,b]) {
    await mkdir(path.join(root,'sub'), { recursive: true });
    execFileSync('git',['init','-q',root]);
  }
  const identity = await resolveProjectIdentity(a);
  assert.equal(identity.root, a);
  assert.match(identity.id,/^[a-f\d]{64}$/);
  assert.deepEqual(await resolveProjectIdentity(path.join(a,'sub')),identity);
  assert.notEqual((await resolveProjectIdentity(b)).id,identity.id);
  const alias = path.join(base,'alias');
  await symlink(a,alias,process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await resolveProjectIdentity(alias),identity);
  const prev = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = path.join(b,'.git');
    assert.deepEqual(await resolveProjectIdentity(a),identity);
  } finally {
    if (prev === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = prev;
  }
  assert.equal(await resolveProjectIdentity(base),null);
  assert.equal(await resolveProjectIdentity('sub'),null);
  assert.equal(await resolveProjectIdentity(a,{signal:AbortSignal.abort()}),null);
});
