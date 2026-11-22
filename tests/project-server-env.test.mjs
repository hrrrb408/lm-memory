// 0.19.8 回归：项目 server 子进程环境白名单。
// 背景：外审复审发现 M4 嵌入态失败——LM_EMBED_CACHE 不在转发白名单里，
// 项目库各自找 <store>/models 放模型，隔离/共享部署场景必然翻车。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectServerEnv } from '../plugin/lib/index.js';

test('转发 LM_EMBED_CACHE，显式设置嵌入开关，白名单外不透传', () => {
  const base = { HOME: '/h', PATH: '/p', USERPROFILE: '/u', LM_EMBED_CACHE: '/cache', SECRET_TOKEN: 'x' };
  const on = projectServerEnv(base, { allowRemote: false, embed: true });
  assert.equal(on.LM_EMBED, '1');
  assert.equal(on.LM_EMBED_CACHE, '/cache');
  assert.equal(on.LM_REMOTE_DISABLED, '1');
  assert.equal(on.SECRET_TOKEN, undefined); // 白名单外一律不透传
});

test('嵌入关闭时 LM_EMBED 显式为 0，不继承宿主任意值', () => {
  const off = projectServerEnv({ HOME: '/h', LM_EMBED: 'whatever' }, { allowRemote: false, embed: false });
  assert.equal(off.LM_EMBED, '0');
});

test('apiKeyEnv 仅在 allowRemote 时转发，且键名必须合法', () => {
  const env = { HOME: '/h', MY_KEY: 'k' };
  const remote = projectServerEnv(env, { allowRemote: true, keyEnv: 'MY_KEY', embed: false });
  assert.equal(remote.MY_KEY, 'k');
  assert.equal(remote.LM_REMOTE_DISABLED, undefined);
  const badKey = projectServerEnv(env, { allowRemote: true, keyEnv: 'BAD KEY', embed: false });
  assert.equal(badKey['BAD KEY'], undefined);
  const noRemote = projectServerEnv(env, { allowRemote: false, keyEnv: 'MY_KEY', embed: false });
  assert.equal(noRemote.MY_KEY, undefined);
});
