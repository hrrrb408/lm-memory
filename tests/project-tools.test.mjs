import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createProjectRouter, registerScopedTools } from '../plugin/lib/project-tools.mjs';
import { createProjectBackends } from '../plugin/lib/project-backends.mjs';

test('scoped tools use only the Host session, with distinct project and personal routes', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lm-host-router-')));
  const storage = path.join(root, 'memory'), A = path.join(root, 'a'), B = path.join(root, 'b');
  await Promise.all([mkdir(storage), mkdir(A), mkdir(B)]);
  for (const p of [A,B]) execFileSync('git', ['init','-q',p]);
  const makeSession = (n, cwd, extra = {}) => {
    const id = `session-00000000-0000-0000-0000-00000000000${n}`;
    return { id, meta: { id, cwd, isSeeded: false, createdAt: 10, ...extra } };
  };
  const a = makeSession(1,A), b = makeSession(2,B);
  const scope = createProjectRouter(storage, 10);
  const backends = createProjectBackends({ command: process.execPath,
    server: fileURLToPath(new URL('../server/memory-server.mjs', import.meta.url)),
    env: { HOME: root, USERPROFILE: root, LM_EMBED: '0', LM_REMOTE_DISABLED: '1' } });
  t.after(async () => { await backends.close(); await rm(root, { recursive:true, force:true }); });
  const registered = new Map(), lifetime = new AbortController();
  const unload = await registerScopedTools({ tools: { register(def) {
    registered.set(def.name,def);
    return () => registered.delete(def.name);
  }}}, scope, backends, lifetime.signal);
  const call = (level, tool, session, args) => registered.get(`mcp__lm_${level}__memory_${tool}`).execute(args, { agent: { session }, signal: new AbortController().signal });
  assert.equal(registered.size, 20);
  assert.match(await call('project','remember',a,{ kind:'fact',content:'Alpha private test marker LMX_A012', project: B }), /id=1/);
  assert.match(await call('project','remember',b,{ kind:'fact',content:'Beta private test marker LMX_B012', project: A }), /id=1/);
  assert.match(await call('personal','remember',a,{ kind:'preference',content:'Personal shared marker LMX_U012' }), /id=1/);
  assert.match(await call('personal','recall',b,{ id:1 }), /LMX_U012/);
  assert.match(await call('project','recall',b,{ id:1 }), /LMX_B012/);
  assert.match(await call('project','recall',a,{ id:1 }), /LMX_A012/);
  await assert.rejects(call('project','recall',makeSession(1,B),{ id:1 }), /not bound/);
  await assert.rejects(call('project','recall',makeSession(3,A,{isSeeded:true}),{ id:1 }), /not bound/);
  await assert.rejects(call('project','recall',makeSession(4,A,{createdAt:9}),{ id:1 }), /not bound/);
  await assert.rejects(call('personal','recall',null,{ id:1 }), /Host session/);
  assert.equal(await createProjectRouter(storage,20).bind(makeSession(1,A)), await scope.bind(a));
  lifetime.abort(); unload();
  assert.equal(registered.size,0);
});
