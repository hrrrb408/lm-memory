// Plugin-owned switches that the Settings page can change without editing YAML.
// The file wins over cordis config only when it exists, so an untouched install
// keeps behaving exactly like its declared config.
import fs from 'node:fs';
import path from 'node:path';

export const SETTINGS_VERSION = 1;
const BOOLEANS = ['projectMemory', 'confirmedOutcomes', 'allowRemote'];
const SESSION_ID = /^[\x21-\x7e]{1,160}$/;

export const defaults = () => ({ version: SETTINGS_VERSION, projectMemory: false, confirmedOutcomes: false, allowRemote: false, taskRecall: { enabled: false, sessionIds: [] } });

export const settingsPath = memoryDir => path.join(memoryDir, 'settings.json');

function validate(input) {
  const fields = {};
  const out = {};
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return { fields: { $: '主体必须是对象' }, value: null };
  for (const key of BOOLEANS) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') { fields[key] = '必须是 true 或 false'; continue; }
    out[key] = input[key];
  }
  if (input.taskRecall !== undefined) {
    const value = input.taskRecall;
    if (value == null || typeof value !== 'object' || Array.isArray(value)) fields.taskRecall = '必须是对象';
    else {
      const next = {};
      if (value.enabled !== undefined) {
        if (typeof value.enabled !== 'boolean') fields['taskRecall.enabled'] = '必须是 true 或 false';
        else next.enabled = value.enabled;
      }
      if (value.sessionIds !== undefined) {
        if (!Array.isArray(value.sessionIds) || value.sessionIds.length > 32 || value.sessionIds.some(id => typeof id !== 'string' || !SESSION_ID.test(id)))
          fields['taskRecall.sessionIds'] = '最多 32 个会话 ID，每个 1–160 个可见字符';
        else next.sessionIds = [...new Set(value.sessionIds)];
      }
      if (!Object.keys(fields).some(key => key.startsWith('taskRecall'))) out.taskRecall = next;
    }
  }
  return { fields, value: out };
}

export function readSettings(memoryDir) {
  const file = settingsPath(memoryDir);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { present: false, settings: defaults(), error: null };
    return { present: false, settings: defaults(), error: `无法读取 ${file}` };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { present: true, settings: defaults(), error: 'settings.json 不是合法 JSON，已按默认值运行' }; }
  const { fields, value } = validate(parsed);
  if (Object.keys(fields).length) return { present: true, settings: defaults(), error: `settings.json 字段无效：${Object.keys(fields).join('、')}` };
  return { present: true, settings: { ...defaults(), ...value }, error: null };
}

export function saveSettings(memoryDir, input) {
  const current = readSettings(memoryDir).settings;
  const { fields, value } = validate(input);
  if (Object.keys(fields).length) return { ok: false, error: 'invalid', fields };
  const next = {
    version: SETTINGS_VERSION,
    ...BOOLEANS.reduce((acc, key) => ({ ...acc, [key]: value[key] ?? current[key] }), {}),
    taskRecall: {
      enabled: value.taskRecall?.enabled ?? current.taskRecall.enabled,
      sessionIds: value.taskRecall?.sessionIds ?? current.taskRecall.sessionIds,
    },
  };
  try {
    fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
    const file = settingsPath(memoryDir);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) { return { ok: false, error: `无法写入设置：${error?.message ?? error}`, fields: {} }; }
  return { ok: true, settings: next };
}

// Only the four keys above are taken from the file; everything else (llm,
// viewer port, memoryDir…) stays exactly as configured.
export function mergeConfig(config, state) {
  if (!state.present) return config;
  const merged = { ...config };
  for (const key of BOOLEANS) merged[key] = state.settings[key];
  merged.taskRecall = state.settings.taskRecall.enabled
    ? { enabled: true, sessionIds: state.settings.taskRecall.sessionIds }
    : undefined;
  return merged;
}
