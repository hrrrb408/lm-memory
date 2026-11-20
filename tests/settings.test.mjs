import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mergeConfig, readSettings, saveSettings, settingsPath } from '../plugin/lib/settings.mjs';

const temp = t => { const dir = mkdtempSync(path.join(tmpdir(), 'lm-settings-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('absent settings keep the declared config, and only the four switches are overridden', t => {
  const dir = temp(t);
  const declared = { memoryDir: dir, viewer: 7640, allowRemote: true, taskRecall: { enabled: true, sessionIds: ['session-1'] } };
  assert.equal(readSettings(dir).present, false);
  assert.deepEqual(mergeConfig(declared, readSettings(dir)), declared);

  const saved = saveSettings(dir, { projectMemory: true, confirmedOutcomes: true, allowRemote: false, taskRecall: { enabled: true, sessionIds: ['session-1'] } });
  assert.equal(saved.ok, true);
  const merged = mergeConfig(declared, readSettings(dir));
  assert.deepEqual(merged, { memoryDir: dir, viewer: 7640, projectMemory: true, confirmedOutcomes: true, allowRemote: false, taskRecall: { enabled: true, sessionIds: ['session-1'] } });
  assert.equal(fs.statSync(settingsPath(dir)).mode & 0o777, 0o600);
});

test('invalid values are refused instead of written, and a broken file never silently enables anything', t => {
  const dir = temp(t);
  const refused = saveSettings(dir, { projectMemory: 'true', taskRecall: { enabled: true, sessionIds: Array.from({ length: 33 }, (_, i) => `session-${i}`) } });
  assert.equal(refused.ok, false);
  assert.deepEqual(Object.keys(refused.fields).sort(), ['projectMemory', 'taskRecall.sessionIds']);
  assert.equal(fs.existsSync(settingsPath(dir)), false);

  fs.writeFileSync(settingsPath(dir), '{"projectMemory": true');
  const broken = readSettings(dir);
  assert.equal(broken.present, true);
  assert.equal(broken.settings.projectMemory, false);
  assert.match(broken.error, /不是合法 JSON/);

  fs.writeFileSync(settingsPath(dir), JSON.stringify({ projectMemory: 'yes' }));
  const wrongType = readSettings(dir);
  assert.equal(wrongType.settings.projectMemory, false);
  assert.match(wrongType.error, /字段无效/);
});

test('a partial save keeps the other switches and deduplicates session ids', t => {
  const dir = temp(t);
  saveSettings(dir, { projectMemory: true, allowRemote: true });
  const second = saveSettings(dir, { taskRecall: { enabled: true, sessionIds: ['a-1', 'a-1', 'b-2'] } });
  assert.equal(second.ok, true);
  assert.equal(second.settings.projectMemory, true);
  assert.equal(second.settings.allowRemote, true);
  assert.deepEqual(second.settings.taskRecall, { enabled: true, sessionIds: ['a-1', 'b-2'] });
  assert.equal(readSettings(dir).error, null);
});
