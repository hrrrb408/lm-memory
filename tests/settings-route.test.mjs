import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import apply from '../plugin/lib/index.js';

function harness(memoryDir) {
  const routes = new Map();
  let disposed = false;
  const ctx = {
    on() {},
    provide() {},
    inject(names, callback) {
      if (names.includes('connection')) callback({
        connection: { fetch: { register: (value) => { routes.set(value.path, value); return Promise.resolve(() => { disposed = true; }); } } },
        effect: (fn) => fn(),
      });
    },
    effect: (fn) => fn(),
  };
  apply(ctx, { memoryDir, allowRemote: false });
  return { route: routes.get('/api/lm-memory-settings'), disposed: () => disposed };
}

test('the settings page reads and writes switches through the owner-only bridge', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lm-settings-route-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { route } = harness(dir);
  assert.equal(route.path, '/api/lm-memory-settings');
  assert.deepEqual([...route.methods], ['GET', 'POST']);
  assert.equal(route.requestBody, 'buffered');

  const initial = await (await route.fetch(new Request('http://host/api/lm-memory-settings'))).json();
  assert.equal(initial.settings.projectMemory, false);
  assert.equal(initial.restartRequired, false);
  assert.equal(initial.file, path.join(dir, 'settings.json'));

  const saved = await route.fetch(new Request('http://host/api/lm-memory-settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectMemory: true, allowRemote: true, taskRecall: { enabled: true, sessionIds: ['session-abc'] } }),
  }));
  assert.equal(saved.status, 200);
  const after = await saved.json();
  assert.equal(after.settings.projectMemory, true);
  assert.equal(after.settings.taskRecall.enabled, true);
  assert.equal(after.restartRequired, true);

  const bad = await route.fetch(new Request('http://host/api/lm-memory-settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectMemory: 'si' }),
  }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).fields.projectMemory.length > 0, true);

  const malformed = await route.fetch(new Request('http://host/api/lm-memory-settings', { method: 'POST', body: 'not json' }));
  assert.equal(malformed.status, 400);

  const reset = await (await route.fetch(new Request('http://host/api/lm-memory-settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }),
  }))).json();
  assert.equal(reset.settings.projectMemory, false);
  assert.deepEqual(reset.settings.taskRecall.sessionIds, []);
});

test('a settings file already on disk is reported as applied after the next start', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lm-settings-route2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ projectMemory: false, confirmedOutcomes: true, allowRemote: false, taskRecall: { enabled: false, sessionIds: [] } }));
  const { route } = harness(dir);
  const state = await (await route.fetch(new Request('http://host/api/lm-memory-settings'))).json();
  assert.equal(state.settings.confirmedOutcomes, true);
  assert.equal(state.restartRequired, false);
});
