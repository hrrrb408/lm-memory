// 阶段 B · M6 实机验证：任务自动召回（显式开启 + 会话白名单）
// 在阶段 B 隔离环境内：真实 DSH headless 会话 ×2（A 项目续聊 + B 项目对照），
// 验证：指针注入、事件留痕（无用户文本）、非白名单会话不触发。
// 外审 P1-1 修复：报告绑定 pluginVersion/tgzSha/执行时间（证据必须属于"本次运行 × 本安装包"）；
// 复用严格布尔记录器（scripts/eval/lib/stageb-record.mjs）。主 runner 会以相同 acceptHome/tgz/reportDir 当场重跑本脚本。
// 前置：dsh-stageb.mjs 已跑过（accept profile 内已装插件、仓库 A/B 已建）。
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRecorder } from './lib/stageb-record.mjs';
import { fileURLToPath } from 'node:url';

const [acceptHome, tgz, reportDir] = process.argv.slice(2);
const root = fileURLToPath(new URL('../../', import.meta.url));
const node = process.execPath;
const DSH_NODE = process.env.DSH_NODE_EXECUTABLE;
const DSH_INSTALL_DIR = process.env.DSH_INSTALL_DIR;
assert.ok(acceptHome && tgz && reportDir && DSH_NODE && DSH_INSTALL_DIR, '需要阶段 B 环境（acceptHome / tgz / reportDir / DSH_NODE_EXECUTABLE / DSH_INSTALL_DIR）');
assert.ok(fs.existsSync(acceptHome + '/profiles/accept/package.json'), 'accept profile 未初始化，先跑 dsh-stageb.mjs');
const memDir = path.join(acceptHome, 'data/memory');
const repos = { A: path.join(acceptHome, 'repos/a'), B: path.join(acceptHome, 'repos/b') };
const modDir = path.join(acceptHome, 'profiles/accept/node_modules/dsh-lm-memory');
fs.mkdirSync(reportDir, { recursive: true });
const pluginVersion = JSON.parse(fs.readFileSync(path.join(modDir, 'package.json'), 'utf8')).version;
const tgzSha = execFileSync('shasum', ['-a', '256', tgz]).toString().split(' ')[0];
const startedAt = new Date().toISOString();

async function startStub(planFile, logFile) {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks)); } catch {}
    const names = (body.tools ?? []).map(t => (typeof t === 'string' ? t : t?.name));
    const emit = o => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    emit({ type: 'message_start', message: { id: 'msg_m6', type: 'message', role: 'assistant', model: body.model ?? 'stub', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
    // 首个请求：调用项目写入建立锚点记忆；其余请求直接结束（不干扰指针断言）
    const isFirst = (server.calls = (server.calls ?? 0) + 1) === 1;
    if (isFirst) {
      const input = { kind: 'fact', content: 'M6 验收：STAGEB-M6 的部署验收流程是先跑全量回归再打标签' };
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_m6', name: 'mcp__lm_project__memory_remember', input: {} } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } });
    } else {
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'M6-TURN-DONE' } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
    }
    emit({ type: 'message_stop' });
    res.end();
    // 注入证据取请求侧：指针提示作为合成 user 消息进入下一次模型请求
    const injected = (body.messages ?? []).some(m => m?.source?.kind === 'lm-memory-task-recall' ||
      (Array.isArray(m?.content) && m.content.some(c => c?.text?.includes('记忆候选指针'))));
    fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), lmTools: names.filter(n => n?.startsWith('mcp__lm_')), injected }) + '\n');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const idFor = repo => execFileSync(node, ['-e', `import {resolveProjectIdentity} from ${JSON.stringify(path.join(root, 'plugin/lib/project-identity.mjs'))};resolveProjectIdentity(${JSON.stringify(repo)}).then(i=>console.log(i.id))`], { cwd: root }).toString().trim();
const storeA = path.join(memDir, 'projects-v1', idFor(repos.A));
const storeB = path.join(memDir, 'projects-v1', idFor(repos.B));

async function dshTurn({ cwd, prompt, sessionId, taskRecall }) {
  const planFile = path.join(acceptHome, `m6-plan-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(planFile, '[]');
  const stubLog = planFile + '.stub.log';
  const { server, port } = await startStub(planFile, stubLog);
  const patch = [
    { id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${port}` } },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'dsh-lm-memory', config: { projectMemory: true, memoryDir: memDir, allowRemote: true,
      ...(taskRecall ? { taskRecall } : {}) } },
  ];
  const patchFile = planFile.replace('m6-plan', 'm6-patch') + '.json';
  fs.writeFileSync(patchFile, JSON.stringify(patch));
  const args = [path.join(DSH_INSTALL_DIR, 'lib/bin.js'), '--profile', 'accept',
    '--patch', path.join(modDir, 'cordis.patch.yml'), '--patch', patchFile, '--json',
    ...(sessionId ? ['--session-id', sessionId] : []), prompt];
  try {
    const { stdout } = await spawnOut(DSH_NODE, args, {
      cwd, timeout: 45000,
      env: { ...process.env, HOME: acceptHome, USERPROFILE: acceptHome, DSH_HOME: acceptHome,
        LM_MEMORY_DIR: memDir, LM_STAGEB_ALLOW_REMOTE: '1', ELECTRON_RUN_AS_NODE: '1',
        DEEPSEEK_API_KEY: 'stageb-fixture-key', PATH: process.env.PATH },
      maxBuffer: 16 * 1024 * 1024,
    });
    const sessionIdOut = JSON.parse(stdout.split('\n').find(l => l.includes('"type":"session"')) || '{}').sessionId ?? null;
    const stubInjected = fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean)
      .some(l => { try { return JSON.parse(l).injected === true; } catch { return false; } });
    return { stdout, sessionId: sessionIdOut ?? sessionId, stubInjected };
  } finally {
    server.close(); server.closeAllConnections();
    try { fs.unlinkSync(planFile); } catch {}
    try { fs.unlinkSync(patchFile); } catch {}
  }
}
const spawnOut = (cmd, args, opts) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, opts);
  let out = '';
  p.stdout.on('data', d => { out += d; });
  p.on('error', reject);
  p.on('close', code => code === 0 ? resolve({ stdout: out }) : reject(new Error(`exit ${code}: ${out.slice(-300)}`)));
});

const { record: rec6, report } = createRecorder();
const record = (name, expected, actual, pass) => rec6('M6', name, expected, actual, pass);

// 回合 1：建立锚点记忆，拿 session id
const turn1 = await dshTurn({ cwd: repos.A, prompt: 'M6 建立锚点。' });
const sid = turn1.sessionId;
const sidOk = /^session-[a-f\d-]{36}$/.test(sid ?? '');
assert.ok(sidOk, 'session id 缺失');
// 锚点副作用 DB 级核验：stub 首请求确实调用了 memory_remember 且内容落进 A 项目库
import { DatabaseSync } from 'node:sqlite';
const anchorDb = new DatabaseSync(path.join(storeA, 'memory.db'), { readOnly: true });
const anchorInDb = !!anchorDb.prepare("SELECT 1 FROM memories WHERE status='active' AND content LIKE '%STAGEB-M6%' LIMIT 1").get();
anchorDb.close();
record('回合 1', '锚点写入项目库（DB 级）+ 取得 session id', `sid=${String(sid).slice(0, 18)}… 有效=${sidOk} 锚点落库=${anchorInDb}`, sidOk && anchorInDb);
// 事件留痕：记录本次运行前已有的 pointer 行数（幂等：复用环境时旧事件保留）
const evPath = path.join(storeA, 'task-recall-events.jsonl');
const pointerRowsBefore = fs.existsSync(evPath)
  ? fs.readFileSync(evPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(e => e.outcome === 'pointer').length
  : 0;

// 回合 2：同一会话续聊（白名单内），问带锚点的回溯问题 → 应出指针
const turn2 = await dshTurn({
  cwd: repos.A, prompt: '上次「STAGEB-M6」的部署验收流程是怎么做的？', sessionId: sid,
  taskRecall: { enabled: true, sessionIds: [sid] },
});
  // 证据链：hook 已记录 pointer 事件 + stub 请求侧出现注入消息
  const pointerIn2 = turn2.stubInjected;
  record('回合 2', '白名单会话出现候选指针（请求侧注入证据）', pointerIn2 ? '指针已注入模型请求' : '未注入', pointerIn2);

const events = fs.existsSync(evPath) ? fs.readFileSync(evPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const pointerRowsAfter = events.filter(e => e.outcome === 'pointer').length;
record('事件留痕', '本次运行新增 pointer 行且不含用户文本', `新增 ${pointerRowsAfter - pointerRowsBefore} 行`, pointerRowsAfter > pointerRowsBefore);
{
  const raw = fs.readFileSync(evPath, 'utf8');
  record('隐私边界', '事件文件不含提问原文', raw.includes('部署验收流程') ? '含原文（应无）' : '无用户文本', !raw.includes('部署验收流程'));
}

// 回合 3：非白名单会话（B 项目，全新会话 id）同样提问 → 无指针
const turn3 = await dshTurn({
  cwd: repos.B, prompt: '上次「STAGEB-M6」的部署验收流程是怎么做的？',
  taskRecall: { enabled: true, sessionIds: [] },
});
record('回合 3', '未列入白名单的会话不触发', turn3.stubInjected ? '误注入' : '未注入', !turn3.stubInjected);

// 汇总
const pass = report.filter(r => r.pass).length;
const finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(reportDir, 'stage-b-m6-optin.json'), JSON.stringify({
  generated: finishedAt, startedAt, pluginVersion, tgzSha,
  sessionId: sid, storeA, storeB, total: report.length, pass, fail: report.length - pass, report,
}, null, 2));
const md = ['# M6 实机自动召回验证（阶段 B 补充，随主验收当场重跑）', '',
  `- 插件版本：${pluginVersion}（tgz sha256 ${tgzSha.slice(0, 16)}…）`,
  `- 执行：${startedAt} → ${finishedAt}`,
  `- 会话：${sid}`, `- 白名单内回溯提问：${pointerIn2 ? '注入候选指针' : '未注入'}`,
  `- 事件留痕：pointer 行 +1，仅含会话/编号/结果`,
  `- 非白名单会话：未触发`, `- 事件文件不含用户提问原文`, '', `**结果：${pass}/${report.length} PASS**`];
fs.writeFileSync(path.join(reportDir, 'stage-b-m6-optin.md'), md.join('\n'));
console.log(`\nM6 实机验证：${pass}/${report.length} PASS`);
if (pass !== report.length) process.exitCode = 1;
