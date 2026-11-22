// 阶段 B：DSH 真实环境验收（外审批准的九模块清单 + M10 隔离指纹与全程监测）。
// 0.19.8（外审复审重跑）：验收系统本身先过验收——
//   P0  record() 强制 boolean 断言（假 PASS 直接炸场），全部错序调用修复，验收器有自检测试
//   P1  M2 直连生命周期真实化（修 id 提取 + DB 状态核对）；M4 嵌入态走 DSH 项目模式 + 显式 LM_EMBED=1；
//       M5 图谱查 A 项目库（不再查空 legacy 库）；M7 viewer 对准 A 项目库 + 崩溃标记回归；
//       M8 外发监测真实化（探测器自检 + 全程 lsof pid 采样 + 代理汇点），不再写死 PASS
//   P2  每行断言带时间戳；隔离指纹（生产库 sha256 前后一致 / 项目库哈希互异）；summary 由真布尔生成
// 隔离：临时 HOME / DSH_HOME / LM_MEMORY_DIR，绝不触碰 ~/.dsh/memory（sha256 双重校验）。
// 插件来源：GitHub Release tgz（外审指定，不用 npm 旧版）。
// 用法：node scripts/eval/dsh-stageb.mjs <accept-home> <release.tgz> <report-dir>
import assert from 'node:assert/strict';
import { spawn, execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveProjectIdentity } from '../../plugin/lib/project-identity.mjs';
import { createRecorder } from './lib/stageb-record.mjs';
import { fileURLToPath } from 'node:url';

const [acceptHome, tgzArg, reportDir] = process.argv.slice(2);
assert.ok(acceptHome && tgzArg && reportDir, 'usage: dsh-stageb.mjs <accept-home> <release.tgz> <report-dir>');
const node = process.execPath;
const DSH_INSTALL_DIR = process.env.DSH_INSTALL_DIR;
const DSH_NODE = process.env.DSH_NODE_EXECUTABLE;
assert.ok(DSH_INSTALL_DIR && DSH_NODE, '需要已安装 DSH 环境（DSH_INSTALL_DIR / DSH_NODE_EXECUTABLE）');
// bin.js 位于 app.asar 内：必须用 Electron 提供的 node 运行才能读取 asar 路径
const dshBin = path.join(DSH_INSTALL_DIR, 'lib/bin.js');
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const repoNodeModules = path.join(repoRoot, 'node_modules');

fs.mkdirSync(reportDir, { recursive: true });
const { record, report } = createRecorder();
const evidence = (file, content) => fs.writeFileSync(path.join(reportDir, file), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 环境搭建 ----------
const tgz = path.resolve(tgzArg);
const modDir = path.join(acceptHome, 'profiles/accept/node_modules/dsh-lm-memory');
fs.rmSync(modDir, { recursive: true, force: true });
fs.mkdirSync(modDir, { recursive: true });
execFileSync('tar', ['xzf', tgz, '-C', modDir, '--strip-components', '1']);
// 依赖落位：真实 file:/pnpm 安装会在 profile 根解析依赖；验收环境用仓库内已装副本
// 以符号链接放到 profile node_modules，等价于 pnpm 的链接布局（不联网）。
// "accept" 不是内置模板名：profile 目录存在 package.json（含 bundles）即视为已初始化，
// 等价于 `dsh plugin --profile accept add <pkg>` 的落盘形态。
fs.mkdirSync(path.join(acceptHome, 'profiles/accept'), { recursive: true });
fs.writeFileSync(path.join(acceptHome, 'profiles/accept/package.json'), JSON.stringify({
  name: 'dsh-profile-accept', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
}, null, 2));
const pluginPkg = JSON.parse(fs.readFileSync(path.join(modDir, 'package.json'), 'utf8'));
for (const dep of Object.keys(pluginPkg.dependencies ?? {})) {
  const from = path.join(repoNodeModules, dep);
  const to = path.join(acceptHome, 'profiles/accept/node_modules', dep);
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true }); // scoped 包需要先建 scope 目录
    if (fs.existsSync(path.join(from, 'package.json')) && !fs.existsSync(to)) fs.symlinkSync(from, to, 'dir');
  } catch (e) { if (e.code !== 'EEXIST') console.error('dep link failed:', dep, e.code); }
}
const pluginVersion = pluginPkg.version;
const sha = (f) => execFileSync('shasum', ['-a', '256', f]).toString().split(' ')[0];
const tgzSha = sha(tgz);

const memDir = path.join(acceptHome, 'data/memory');
const repos = { A: path.join(acceptHome, 'repos/a'), B: path.join(acceptHome, 'repos/b') };
for (const repo of Object.values(repos)) {
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'stageb@local']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'stageb']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init']);
}
// worktree：与 A 同仓库的另一物理目录（按物理路径识别 → 独立项目库）
const worktree = path.join(acceptHome, 'repos/a-worktree');
fs.rmSync(worktree, { recursive: true, force: true });
execFileSync('git', ['-C', repos.A, 'worktree', 'prune']);
// -B：分支存在则重置、不存在则新建（全新 HOME 首跑也不会炸）
execFileSync('git', ['-C', repos.A, 'worktree', 'add', '-q', worktree, '-B', 'wt']);

// 生产记忆目录指纹：整个 ~/.dsh/memory（含 WAL/SHM 等持久化文件），外审 P2-1
// 注意：若运行期间有其他会话写入记忆，本指纹会如实变化并 FAIL——请在无并发记忆写入时复跑。
const prodDir = path.join(os.homedir(), '.dsh/memory');
const dirFingerprint = (dir) => {
  const out = {};
  // Node v26.13.1 实测：readdirSync({withFiletypes:true}) 回退成字符串数组（Dirent 缺失），
  // 因此用 lstatSync 自行判类型；lstat 不跟随符号链接，目录指纹不会递归出界。
  const walk = (d, prefix) => {
    let names;
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      const rel = prefix + name;
      const full = path.join(d, name);
      let st = null;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, rel + '/');
      else { try { out[rel] = `${sha(full).slice(0, 16)}:${st.size}`; } catch {} }
    }
  };
  walk(dir, '');
  return out;
};
const prodFpPre = fs.existsSync(prodDir) ? dirFingerprint(prodDir) : null;

// ---------- 代理汇点：整场验收的 DSH/server 进程若尝试代理外呼，都会落在这里 ----------
let sinkHits = 0;
const sink = http.createServer((req, res) => {
  sinkHits += 1;
  fs.appendFileSync(path.join(reportDir, 'egress-attempts.log'),
    JSON.stringify({ at: new Date().toISOString(), url: req.url }) + '\n');
  res.writeHead(403); res.end('blocked-by-stageb');
});
await new Promise(r => sink.listen(0, '127.0.0.1', r));
const sinkPort = sink.address().port;
const proxyEnv = {
  HTTP_PROXY: `http://127.0.0.1:${sinkPort}`, HTTPS_PROXY: `http://127.0.0.1:${sinkPort}`,
  ALL_PROXY: `http://127.0.0.1:${sinkPort}`, NO_PROXY: '127.0.0.1,localhost,::1',
};

// ---------- 全程外发监测（进程级 lsof 采样 + PID 身份核验）：验收器自身也受监督 ----------
// 外审 P1-2 修复：取消"基线清零"（旧版把探针前的命中整体排除）；每条命中归属 pid/命令/远端；
// 自检探针连接单独标记（kind=probe），判定只认精确 pid+remote 匹配；
// 采样前核验进程身份，进程退出或 PID 被系统复用即摘除，防止把无关进程的连接算到验收头上。
const monitoredPids = new Map(); // pid -> { label, cmd }（watch 时记录身份）
const egressHits = [];           // { at, pid, label, cmd, remote, kind: 'probe'|'monitored' }
let probePid = null;
let firstWatchAt = null;
let expiredPids = 0;
let suspectPidHits = 0;          // 身份翻转前已有命中 → 可能误归因，如实 FAIL
const seenConns = new Set();     // 同一连接跨采样轮去重
const isLoopback = (h) => {
  const n = h.replace(/^::ffff:/i, '').replace(/^::(127\.\d+\.\d+\.\d+)$/, '$1'); // v4-mapped 归一
  return n === '127.0.0.1' || n === 'localhost' || n === '::1' || n.startsWith('127.') || n === '[::1]';
};
const parseAddr = (a) => {
  const m = a.match(/^\[([^\]]+)\]:\d+$/) ?? a.match(/^([^:]+):\d+$/);
  return m ? m[1] : a;
};
const psOne = (pid) => { try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 10000 }).trim().slice(0, 200); } catch { return ''; } };
function watch(pid, label) {
  if (!pid) return;
  monitoredPids.set(pid, { label, cmd: psOne(pid) });
  if (!firstWatchAt) firstWatchAt = new Date().toISOString();
  expansionAt = 0; // 强制下个采样轮立即重建集合：短命进程（如自检探针，<1s）不至整窗漏采
}
const childPids = (pid) => {
  try { return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean); }
  catch { return []; }
};
function psCmds(pids) {
  const m = new Map();
  if (!pids.length) return m;
  try {
    const out = execFileSync('ps', ['-p', pids.join(','), '-o', 'pid=,command='], { encoding: 'utf8', timeout: 15000 });
    for (const line of out.split('\n')) {
      const t = line.trim(); if (!t) continue;
      const sp = t.indexOf(' '); if (sp > 0) m.set(Number(t.slice(0, sp)), t.slice(sp + 1).trim().slice(0, 200));
    }
  } catch {}
  return m;
}
function sampleEgress(pids) {
  if (!pids.length) return [];
  let out = '';
  try { out = execFileSync('lsof', ['-a', '-p', pids.join(','), '-i', '-n', '-P', '-F', 'n'], { encoding: 'utf8', timeout: 15000 }); }
  catch (e) { out = e.stdout ?? ''; } // lsof 退出码 1 = 无匹配 socket
  // -a 必须带上：lsof 的 -p 与 -i 默认 OR 语义，漏了它会把全系统进程的连接都算进来（第五轮实测教训）
  // macOS lsof -F n 会混入非 INET 条目（如 n0x句柄->0x句柄 的共享内存/Unix 域套接字），
  // 双端必须形如 地址:端口（v4 或 [v6]）且不以 0x 开头才算网络连接（第四轮实测教训）。
  const isInetEndpoint = (s) => /^(?:\[[^\]]+\]|[^:\s]+):\d+$/.test(s) && !/^0x/i.test(s);
  const found = []; let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) { cur = Number(line.slice(1)); continue; } // lsof -F：p<pid> 开始一个进程块
    if (!line.startsWith('n') || !line.includes('->')) continue;         // 只看已建立连接，监听不算
    const body = line.slice(1);
    const [local, remote] = body.split('->');
    if (!local || !remote || !isInetEndpoint(local.trim()) || !isInetEndpoint(remote.trim())) continue;
    const rHost = parseAddr(remote.trim());
    if (rHost && !isLoopback(rHost)) found.push({ pid: cur, remote: remote.trim(), line: body });
  }
  return found;
}
let expansionCache = [], expansionAt = 0;
const samplerStartedAt = new Date().toISOString();
const sampler = setInterval(() => {
  const now = Date.now();
  if (now - expansionAt > 1000) { // 每秒展开子进程树（dsh → 插件 server / m6 runner → 其 dsh 子进程）
    const seen = new Set(); const q = [...monitoredPids.keys()];
    while (q.length) {
      const p = q.pop();
      if (seen.has(p)) continue;
      seen.add(p);
      const kids = childPids(p);
      for (const c of kids) if (!monitoredPids.has(c)) watch(c, `${monitoredPids.get(p)?.label ?? '?'}/child`);
      q.push(...kids);
    }
    expansionCache = [...seen]; expansionAt = now;
  }
  if (!expansionCache.length) return;
  const cmds = psCmds(expansionCache);
  const alive = [];
  for (const p of expansionCache) {
    const cur = cmds.get(p) ?? '';
    const info = monitoredPids.get(p);
    if (!cur || (info?.cmd && cur !== info.cmd)) { // 进程退出或 PID 被复用
      monitoredPids.delete(p); expiredPids += 1;
      if (egressHits.some(h => h.pid === p && h.kind === 'monitored')) suspectPidHits += 1;
      continue;
    }
    alive.push(p);
  }
  expansionCache = alive;
  for (const h of sampleEgress(alive)) {
    const key = `${h.pid}|${h.line}`;
    if (seenConns.has(key)) continue;
    seenConns.add(key);
    egressHits.push({
      at: new Date().toISOString(), pid: h.pid,
      label: monitoredPids.get(h.pid)?.label ?? '?', cmd: (cmds.get(h.pid) ?? '').slice(0, 160),
      remote: h.remote, kind: h.pid === probePid ? 'probe' : 'monitored',
    });
  }
}, 400);
sampler.unref?.();

const env = {
  ...process.env,
  HOME: acceptHome,
  USERPROFILE: acceptHome,
  DSH_HOME: acceptHome,
  LM_EMBED: '0', // 模块 4 单独控制
  LM_REMOTE_DISABLED: '1',
  PATH: process.env.PATH,
  DEEPSEEK_API_KEY: 'stageb-fixture-key',
  ...proxyEnv,
};
delete env.NODE_OPTIONS;

// ---------- loopback 模型桩：计划文件驱动 ----------
function startStub(plan, logFile) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks)); } catch {}
    const toolNames = (body.tools ?? []).map(t => (typeof t === 'string' ? t : t?.name));
    fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), lmTools: toolNames.filter(n => n?.startsWith('mcp__lm_')), nTools: toolNames.length }) + '\n');
    const emit = (obj) => res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    emit({ type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model: body.model ?? 'stub', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
    const idx = (server.calls = (server.calls ?? 0) + 1) - 1;
    const step = (Array.isArray(plan) ? plan : [])[idx];
    const toolId = `toolu_${idx}`;
    if (step && step.name) {
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: step.name, input: {} } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input ?? {}) } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } });
    } else {
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step?.text ?? 'STAGE-B' } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    }
    emit({ type: 'message_stop' });
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// execFile 包装：保留子进程 pid（注册进外发监测），超时 SIGKILL，失败附带 stdout 尾巴
function dshExec(file, args, opts, label) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, opts, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`${err.message}\n--stdout tail--\n${String(stdout).slice(-2000)}`);
        e.stdout = stdout; reject(e);
      } else resolve({ stdout, stderr, pid: child.pid });
    });
    watch(child.pid, label);
  });
}

async function dshRun({ cwd, prompt, plan, timeoutMs = 60000, extraEnv = {}, memoryDir: runMemDir = memDir }) {
  const planFile = path.join(acceptHome, `plan-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const stubLog = planFile + '.stub.log';
  const { server, port } = await startStub(plan, stubLog);
  const patch = [
    { id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${port}` } },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'session-title-llm', disabled: true },
    // 关键：projectMemory 必须显式开启，否则插件落回 legacy 全局库模式（复审教训）
    { id: 'dsh-lm-memory', config: { projectMemory: true, memoryDir: runMemDir, ...(extraEnv.LM_STAGEB_EMBED === '1' ? { projectEmbed: true } : {}) } },
  ];
  const patchFile = path.join(acceptHome, `patch-${port}.json`);
  fs.writeFileSync(patchFile, JSON.stringify(patch));
  const started = Date.now();
  try {
    const runEnv = Object.fromEntries(Object.entries({
      ...env, ...extraEnv,
      // M6 等需要临时允许外发的运行：去掉 LM_REMOTE_DISABLED
      ...(extraEnv.LM_STAGEB_ALLOW_REMOTE === '1' ? { LM_REMOTE_DISABLED: undefined } : {}),
      LM_MEMORY_DIR: runMemDir, ELECTRON_RUN_AS_NODE: '1',
    }).filter(([, v]) => v !== undefined));
    const { stdout, pid } = await dshExec(DSH_NODE, [dshBin, '--profile', 'accept', '--patch', path.join(modDir, 'cordis.patch.yml'), '--patch', patchFile, '--json', prompt], {
      cwd, timeout: timeoutMs, killSignal: 'SIGKILL',
      env: runEnv, maxBuffer: 16 * 1024 * 1024,
    }, `dsh:${path.basename(cwd)}`);
    const stubTools = fs.readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean)
      .flatMap(l => { try { return [JSON.parse(l).lmTools ?? []]; } catch { return []; } }).flat();
    return { stdout, ms: Date.now() - started, sessionId: JSON.parse(stdout.split('\n').find(l => l.includes('"type":"session"')) || '{}').sessionId ?? null, stubTools, pid };
  } finally {
    server.close(); server.closeAllConnections();
    try { fs.unlinkSync(planFile); } catch {}
    try { fs.unlinkSync(patchFile); } catch {}
  }
}

const extract = (stdout, re) => { const m = stdout.match(re); return m ? m[1] : null; };
// 项目库路径：与会话绑定同一套身份解析（Git 根哈希）
const identityCache = new Map();
async function projectStoreFor(cwd, base = memDir) {
  let id = identityCache.get(cwd);
  if (!id) { const identity = await resolveProjectIdentity(cwd); id = identity?.id ?? null; identityCache.set(cwd, id); }
  return id ? path.join(base, 'projects-v1', id) : null;
}
function storeHas(store, substring) {
  const dbPath = path.join(store, 'memory.db');
  if (!fs.existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return !!db.prepare("SELECT 1 FROM memories WHERE status='active' AND content LIKE ? LIMIT 1").get(`%${substring}%`); }
  finally { db.close(); }
}
function waitPort(child, what = '进程') {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => {
      buf += String(d);
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { child.stdout.off('data', onData); resolve(`http://127.0.0.1:${m[1]}`); }
    };
    child.stdout.on('data', onData);
    setTimeout(() => { child.stdout.off('data', onData); reject(new Error(`${what} 10s 未监听: ${buf.slice(0, 120)}`)); }, 10000);
  });
}

// ================= M1 插件启动 =================
{
  const t0 = Date.now();
  const m1 = await dshRun({ cwd: repos.A, prompt: 'M1 启动检查。', plan: [{ text: 'M1-OK' }] });
  const ms = Date.now() - t0;
  record(1, 'DSH 加载并进入对话', '输出 M1-OK', m1.stdout.includes('M1-OK') ? 'M1-OK' : '缺失', m1.stdout.includes('M1-OK'));
  record(1, '旧 MCP 未注册（项目模式收口）', '不出现 mcp__lm_memory__', m1.stdout.includes('mcp__lm_memory__') ? '出现（应无）' : '未出现', !m1.stdout.includes('mcp__lm_memory__'));
  record(1, '启动耗时', '<=45s', `${ms}ms`, ms <= 45000);
}
// M1b 会话（供 M7 复用）+ scoped 注册证据
const s1 = await dshRun({ cwd: repos.A, prompt: 'M1b 工具发现。', plan: [{ name: 'mcp__lm_project__memory_remember', input: { kind: 'fact', content: 'M1B 工具发现标记' } }, { text: 'M1B-DONE' }] });
const storeA = await projectStoreFor(repos.A);
{
  const registered = s1.stubTools.includes('mcp__lm_project__memory_remember');
  record(1, 'scoped 工具注册（stub 请求证据）', '请求含 mcp__lm_project__memory_remember', registered ? '已注册' : '未注册', registered);
  evidence('m1-stub-tools.json', s1.stubTools);
  const called = s1.stdout.includes('M1B-DONE');
  const landed = storeHas(storeA, 'M1B 工具发现标记');
  record(1, 'MCP 握手：项目写入工具可用', '工具被调用且副作用落库', `called=${called} landed=${landed}`, called && landed);
}

// ================= M2 基础记忆（经真实 MCP 会话 + 直连生命周期） =================
const sidA = await dshRun({ cwd: repos.A, prompt: 'M2a 写入标记。', plan: [{ name: 'mcp__lm_project__memory_remember', input: { kind: 'fact', content: 'M2 记忆标记 MARK-A1' } }, { text: 'M2A-DONE' }] });
record(2, '写入 remember（副作用在 A 项目库）', 'store 内可见 MARK-A1', `store=${storeA}`, !!storeA && storeHas(storeA, 'MARK-A1'));

const r2 = await dshRun({ cwd: repos.A, prompt: 'M2b 读取。', plan: [{ name: 'mcp__lm_project__memory_recall', input: { query: 'M2 记忆标记 MARK-A1' } }, { text: 'M2B-DONE' }] });
record(2, '检索 recall', '会话输出含 MARK-A1', /MARK-A1/.test(r2.stdout) ? '命中' : '未命中', /MARK-A1/.test(r2.stdout));
// 直连 MCP 验证 correct/forget/source/feedback（viewer 外的真实工具链）
let m2Id = null;
{
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: node, args: [path.join(modDir, 'server/memory-server.mjs')],
    env: { ...process.env, ...proxyEnv, LM_MEMORY_DIR: storeA, LM_EMBED: '0', LM_REMOTE_DISABLED: '1' }, stderr: 'ignore',
  });
  watch(transport.pid, 'm2-server');
  const c = new Client({ name: 'stageb-m2', version: '1' });
  await c.connect(transport);
  const text = async (name, args) => (await c.callTool({ name, arguments: args })).content?.[0]?.text ?? '';
  const recallA1 = await text('memory_recall', { query: 'MARK-A1' });
  // 0.19.8 修复：recall 返回美化 JSON（冒号带空格），旧正则 /"id":(\d+)/ 提取失败 → NaN 级联假 false
  const idM = recallA1.match(/"id":\s*(\d+)/);
  m2Id = idM ? Number(idM[1]) : NaN;
  record(2, 'recall 返回可解析 id', 'id 为正整数', `id=${m2Id}`, Number.isInteger(m2Id) && m2Id > 0);
  const corrected = await text('memory_correct', { id: m2Id, expected_version: 1, content: 'M2 记忆标记 MARK-A2（已修正）' });
  // 产品语义：correct 不原地改版本——新增版本行（version+1, supersedes=旧id），旧行记 superseded
  const cM = corrected.match(/id=(\d+) v(\d+)/);
  const newId = cM ? Number(cM[1]) : NaN;
  record(2, '修正 correct（乐观并发）', 'OK 且返回新版本 id', corrected.slice(0, 80), /OK/.test(corrected) && Number.isInteger(newId) && newId !== m2Id);
  const dbA2 = new DatabaseSync(path.join(storeA, 'memory.db'), { readOnly: true });
  const oldRow = dbA2.prepare('SELECT status, version FROM memories WHERE id=?').get(m2Id);
  const newRow = dbA2.prepare('SELECT status, version, supersedes FROM memories WHERE id=?').get(newId);
  dbA2.close();
  record(2, '修正 supersede 链（DB 级）', '旧行 superseded；新行 active、v=2、指向旧行',
    `old=${oldRow?.status} new=${newRow?.status} v${newRow?.version} supersedes=${newRow?.supersedes}`,
    oldRow?.status === 'superseded' && newRow?.status === 'active' && newRow?.version === 2 && newRow?.supersedes === m2Id);
  const reread = await text('memory_recall', { id: newId });
  record(2, '新版本直读', 'id 直读返回 MARK-A2', reread.slice(0, 80), reread.includes('MARK-A2'));
  const src = await text('memory_source', { id: newId });
  record(2, '来源回查 source', '返回非空（NOT_PROVEN 或证据）', src.slice(0, 60), src.length > 0);
  const fb = await text('memory_feedback', { id: newId, useful: true });
  record(2, '反馈 feedback', 'OK', fb.slice(0, 60), /OK/.test(fb));
  const list = await text('memory_list', {});
  record(2, '列表 list', '含修正后内容 MARK-A2', list.slice(0, 80), list.includes('MARK-A2'));
  const wrongForget = await text('memory_forget', { id: newId, expected_version: 99 });
  record(2, '遗忘版本校验', '错误版本返回 VERSION_CONFLICT', wrongForget.slice(0, 60), wrongForget.includes('VERSION_CONFLICT'));
  const softForget = await text('memory_forget', { id: newId, expected_version: newRow?.version });
  record(2, '逻辑遗忘 forget（正确版本）', 'OK', softForget.slice(0, 60), /OK/.test(softForget));
  // DB 级核对：软删后新版本行保留且 status=deleted
  const dbA = new DatabaseSync(path.join(storeA, 'memory.db'), { readOnly: true });
  const rowA = dbA.prepare('SELECT status, version FROM memories WHERE id=?').get(newId);
  dbA.close();
  record(2, '删除后数据库状态', '新版本行保留且 status=deleted', `status=${rowA?.status} version=${rowA?.version}`, rowA?.status === 'deleted');
  const afterDefault = await text('memory_recall', { query: 'MARK-A2' });
  const afterAll = await text('memory_recall', { query: 'MARK-A2', scope: 'all' });
  record(2, '删除后默认与 all 均不可召回', '两口径都不返回 MARK-A2', afterAll.slice(0, 60), !afterDefault.includes('MARK-A2') && !afterAll.includes('MARK-A2'));
  await c.close();
}

// ================= M3 项目隔离与身份 =================
let storeB = null, storeWt = null;
let bPersonalStdout = '', subReadStdout = '';
const personalStore = path.join(memDir, 'personal-v1');
{
  await dshRun({ cwd: repos.B, prompt: 'M3 B 项目写入。', plan: [{ name: 'mcp__lm_project__memory_remember', input: { kind: 'fact', content: 'M3 B 项目专属标记 B-ONLY' } }, { text: 'M3B-DONE' }] });
  storeB = await projectStoreFor(repos.B);
  record(3, 'B 项目写入（副作用在 B 项目库）', 'B 库可见 B-ONLY', `store=${storeB}`, !!storeB && storeHas(storeB, 'B-ONLY'));
  await dshRun({ cwd: repos.A, prompt: 'M3 A 项目读取。', plan: [{ name: 'mcp__lm_project__memory_recall', input: { query: 'B 项目专属标记' } }, { text: 'M3A-DONE' }] });
  record(3, 'A 看不到 B 的记忆（DB 级隔离）', 'A 库无 B-ONLY', `storeA=${storeA}`, !storeHas(storeA, 'B-ONLY'));
  await dshRun({ cwd: repos.A, prompt: 'M3 个人库写入。', plan: [{ name: 'mcp__lm_personal__memory_remember', input: { kind: 'preference', content: 'M3 个人偏好 PERSONAL-X' } }, { text: 'M3P-DONE' }] });
  // WAL 可见性：写入方提交后，跨进程读者偶发需要等待 checkpoint（有界重试，非放宽断言）
  let personalSeen = false, lastErr = '';
  for (let i = 0; i < 8 && !personalSeen; i++) {
    try { personalSeen = storeHas(personalStore, 'PERSONAL-X'); }
    catch (e) { lastErr = e.message; }
    if (!personalSeen) await sleep(250);
  }
  record(3, '个人库写入（副作用在 personal-v1）', 'personal 库可见 PERSONAL-X', lastErr || `store=${personalStore}`, personalSeen);
  const bPersonal = await dshRun({ cwd: repos.B, prompt: 'M3 B 读个人库。', plan: [{ name: 'mcp__lm_personal__memory_recall', input: { query: 'PERSONAL-X' } }, { text: 'M3PB-DONE' }] });
  bPersonalStdout = bPersonal.stdout;
  record(3, '个人库跨项目可见', '命中 PERSONAL-X', /PERSONAL-X/.test(bPersonalStdout) ? '命中' : '未命中', /PERSONAL-X/.test(bPersonalStdout));
  // 子目录：与 A 同仓库
  const sub = path.join(repos.A, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const subRead = await dshRun({ cwd: sub, prompt: 'M3 子目录读取。', plan: [{ name: 'mcp__lm_project__memory_recall', input: { query: 'MARK-A2' } }, { text: 'M3SUB-DONE' }] });
  subReadStdout = subRead.stdout;
  record(3, '子目录绑定同一仓库根', '命中 A 的记忆 MARK-A2', /MARK-A2/.test(subReadStdout) ? '命中' : '未命中', /MARK-A2/.test(subReadStdout));
  // worktree：同仓库不同物理路径 → 独立项目库
  await dshRun({ cwd: worktree, prompt: 'M3 worktree 写入。', plan: [{ name: 'mcp__lm_project__memory_remember', input: { kind: 'fact', content: 'M3 worktree 独立标记 WT-X' } }, { text: 'M3WT-DONE' }] });
  storeWt = await projectStoreFor(worktree);
  record(3, 'worktree 视为独立项目（副作用在独立库）', 'WT 库可见且 ≠ A', `store=${storeWt}`, !!storeWt && storeWt !== storeA && storeHas(storeWt, 'WT-X'));
  await dshRun({ cwd: repos.A, prompt: 'M3 A 不见 worktree。', plan: [{ name: 'mcp__lm_project__memory_recall', input: { query: 'WT-X' } }, { text: 'M3AW-DONE' }] });
  record(3, 'A 看不到 worktree 的记忆（DB 级隔离）', 'A 库无 WT-X', `storeA=${storeA}`, !storeHas(storeA, 'WT-X'));
  // 物理证据：三个库目录
  const projDir = path.join(memDir, 'projects-v1');
  const storeCount = fs.existsSync(projDir) ? fs.readdirSync(projDir).length : 0;
  const personalExists = fs.existsSync(path.join(memDir, 'personal-v1/memory.db'));
  record(3, '物理库数量', 'projects-v1 >= 3 且 personal-v1 存在', `${storeCount} 个项目库 / 个人库 ${personalExists ? '存在' : '缺失'}`, storeCount >= 3 && personalExists);
  evidence('m3-stores.json', { storeCount, stores: fs.existsSync(projDir) ? fs.readdirSync(projDir) : [] });
}

// ================= M4 向量检索双态 =================
{
  // 预热：搭建期联网下载双模型到验收缓存；此后所有测试进程离线（LM_REMOTE_DISABLED=1 + 缓存命中自动禁远端）
  const embCacheDir = path.join(acceptHome, 'data/embed-models');
  fs.rmSync(embCacheDir, { recursive: true, force: true });
  fs.mkdirSync(embCacheDir, { recursive: true });
  let warmOk = false, warmDetail = '';
  try {
    const { pipeline, env: hfEnv } = await import('@huggingface/transformers');
    hfEnv.cacheDir = embCacheDir;
    hfEnv.allowRemoteModels = true;
    for (const model of ['Xenova/bge-small-zh-v1.5', 'Xenova/bge-small-en-v1.5']) {
      const p = await pipeline('feature-extraction', model, { dtype: 'q8' });
      await p('阶段B嵌入模型预热', { pooling: 'mean', normalize: true });
      await p.dispose?.();
    }
    warmOk = true; warmDetail = '双模型缓存就绪';
  } catch (e) { warmDetail = String(e).slice(0, 160); }
  record(4, '嵌入模型预热（搭建期联网，测试期离线）', '双模型缓存就绪', warmDetail, warmOk);

  // false 态（主链路）：M2/M3 的 recall 真实跑在 projectEmbed=false 的项目库上，此处汇总断言（不再写死 true）
  const falseRecalls = { m2: /MARK-A1/.test(r2.stdout), bPersonal: /PERSONAL-X/.test(bPersonalStdout), sub: /MARK-A2/.test(subReadStdout) };
  record(4, 'projectEmbed=false：字面检索可用', 'M2/M3 的 recall 真实命中（非写死）', JSON.stringify(falseRecalls), falseRecalls.m2 && falseRecalls.bPersonal && falseRecalls.sub);

  // true 态（主链路）：DSH 项目模式 + projectEmbed:true + 共享模型缓存（0.19.8 起插件转发 LM_EMBED_CACHE）
  const embMem = path.join(acceptHome, 'data/memory-embed');
  fs.rmSync(embMem, { recursive: true, force: true });
  fs.mkdirSync(embMem, { recursive: true });
  const embRun = await dshRun({
    cwd: repos.A, prompt: 'M4 嵌入态写入。',
    plan: [{ name: 'mcp__lm_project__memory_remember', input: { kind: 'fact', content: '嵌入态标记 EMB-A：语义检索目标' } }, { text: 'M4-EMB-DONE' }],
    extraEnv: { LM_STAGEB_EMBED: '1', LM_EMBED: '1', LM_EMBED_CACHE: embCacheDir }, memoryDir: embMem, timeoutMs: 90000,
  });
  const embStore = await projectStoreFor(repos.A, embMem);
  let embCount = -1, embDetail = `store=${embStore}`;
  try {
    const db = new DatabaseSync(path.join(embStore, 'memory.db'), { readOnly: true });
    embCount = db.prepare('SELECT count(*) n FROM memories WHERE emb IS NOT NULL').get().n;
    db.close();
  } catch (e) { embCount = 0; embDetail += ` err=${String(e).slice(0, 60)}`; }
  record(4, 'projectEmbed=true（DSH 项目模式）：向量真实生成', '项目库 emb 非空 1 条', `${embDetail} emb=${embCount}`, embCount === 1);

  // true 态（备援）：独立 server 直接 LM_EMBED=1 运行，验证管线本身（不依赖插件转发）
  const embMem2 = path.join(acceptHome, 'data/memory-embed-direct');
  fs.rmSync(embMem2, { recursive: true, force: true });
  fs.mkdirSync(embMem2, { recursive: true });
  let directOk = false, directDetail = '';
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: node, args: [path.join(modDir, 'server/memory-server.mjs')],
      env: { ...process.env, ...proxyEnv, LM_MEMORY_DIR: embMem2, LM_EMBED: '1', LM_EMBED_CACHE: embCacheDir, LM_REMOTE_DISABLED: '1' }, stderr: 'ignore',
    });
    watch(transport.pid, 'm4-direct-server');
    const c = new Client({ name: 'stageb-embed-direct', version: '1' });
    await c.connect(transport);
    await (await c.callTool({ name: 'memory_remember', arguments: { kind: 'fact', content: '独立管线嵌入标记 EMB-B' } })).content?.[0]?.text ?? '';
    const db = new DatabaseSync(path.join(embMem2, 'memory.db'), { readOnly: true });
    const n = db.prepare('SELECT count(*) n FROM memories WHERE emb IS NOT NULL').get().n;
    db.close();
    directOk = n === 1; directDetail = `emb=${n}`;
    await c.close();
  } catch (e) { directDetail = '异常：' + String(e).slice(0, 120); }
  record(4, '独立 server LM_EMBED=1：嵌入管线', 'emb 非空 1 条', directDetail, directOk);

  const docsText = fs.readFileSync(path.join(modDir, 'docs/project-memory.md'), 'utf8');
  const declared = docsText.includes('项目库默认不加载本地双语嵌入') || docsText.includes('默认不加载本地双语嵌入');
  record(4, '双态文档声明', '打包 docs 写明默认关嵌入与能力边界', declared ? '声明存在' : '声明缺失', declared);
}

// ================= M5 图谱（检查对象：A 项目库，不再查空 legacy 库） =================
{
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: node, args: [path.join(modDir, 'server/memory-server.mjs')],
    env: { ...process.env, ...proxyEnv, LM_MEMORY_DIR: storeA, LM_EMBED: '0', LM_REMOTE_DISABLED: '1' }, stderr: 'ignore',
  });
  watch(transport.pid, 'm5-server');
  const c = new Client({ name: 'stageb-graph', version: '1' });
  await c.connect(transport);
  const text = async (name, args) => (await c.callTool({ name, arguments: args })).content?.[0]?.text ?? '';
  const g1 = await text('memory_remember', { kind: 'fact', content: '图谱节点 N1：co_tag 测试', tags: '图谱标签A,图谱标签B' });
  const g2 = await text('memory_remember', { kind: 'fact', content: '图谱节点 N2：与 N1 共享标签', tags: '图谱标签A,图谱标签C' });
  await c.close();
  const db = new DatabaseSync(path.join(storeA, 'memory.db'), { readOnly: true });
  const nodes = db.prepare("SELECT count(*) n FROM memories WHERE status='active'").get().n;
  const edges = { co_tag: 0, similar: 0, ref: 0 };
  try { for (const rel of Object.keys(edges)) edges[rel] = db.prepare('SELECT count(*) n FROM edges WHERE rel=?').get(rel).n; } catch {}
  db.close();
  record(5, '带标签记忆写入（A 项目库）', '两条写入 OK', `g1=${/OK/.test(g1)} g2=${/OK/.test(g2)}`, /OK/.test(g1) && /OK/.test(g2));
  record(5, '图谱节点（A 项目库）', '活跃记忆 >= 3', `nodes=${nodes}`, nodes >= 3);
  record(5, '关系类型存在', 'co_tag >= 1（共享标签）', JSON.stringify(edges), edges.co_tag >= 1);
  record(5, 'similar 边在关闭嵌入的库为 0（诚实降级）', 'similar=0', `similar=${edges.similar}`, edges.similar === 0);
  evidence('m5-graph.json', { store: storeA, nodes, edges });
}

// ================= M6 自动召回（默认关闭；实机验证由本包 M6 runner 当场重跑并绑定版本，外审 P1-1） =================
{
  const { stdout } = await dshRun({ cwd: repos.A, prompt: 'M6 自动召回注册检查。', plan: [{ text: 'M6-OK' }], extraEnv: { LM_STAGEB_ALLOW_REMOTE: '1' } });
  const leaked = stdout.includes('记忆候选指针');
  record(6, 'taskRecall 需显式开启（默认关闭）', '默认运行无候选指针注入', leaked ? '出现指针（应无）' : '无指针', !leaked);
  // M6 证据必须是"本次运行 × 本安装包"：当场重跑 dsh-stageb-m6.mjs，报告落在本 reportDir，
  // 并核对报告内 pluginVersion/tgzSha 与本验收安装包完全一致；其 dsh 子进程经子进程树展开纳入同一外发监测。
  const m6 = spawn(node, [path.join(repoRoot, 'scripts/eval/dsh-stageb-m6.mjs'), acceptHome, tgz, reportDir], { env: process.env, cwd: repoRoot, stdio: 'inherit' });
  watch(m6.pid, 'm6-runner');
  const m6Exit = await new Promise(res => m6.on('close', res).on('error', () => res(-1)));
  const m6Path = path.join(reportDir, 'stage-b-m6-optin.json');
  let m6Ok = false, m6Detail = '报告缺失';
  try {
    const j = JSON.parse(fs.readFileSync(m6Path, 'utf8'));
    const bound = j.pluginVersion === pluginPkg.version && j.tgzSha === tgzSha;
    m6Ok = m6Exit === 0 && typeof j.pass === 'number' && j.pass === j.total && j.fail === 0 && bound;
    m6Detail = `${j.pass}/${j.total} v=${j.pluginVersion} sha=${String(j.tgzSha).slice(0, 8)} 版本绑定=${bound}`;
  } catch (e) { m6Detail = e.message.slice(0, 60); }
  record(6, '指针注入与门禁（本包实机重跑）', 'M6 runner 全 PASS 且 pluginVersion/tgzSha 与本验收安装包一致', m6Detail, m6Ok);
}

// ================= M7 故障恢复（数据对象：A 项目库 + 崩溃标记回归） =================
{
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: node, args: [path.join(modDir, 'server/memory-server.mjs')],
    env: { ...process.env, ...proxyEnv, LM_MEMORY_DIR: storeA, LM_EMBED: '0', LM_REMOTE_DISABLED: '1' }, stderr: 'ignore',
  });
  watch(transport.pid, 'm7-server');
  const c = new Client({ name: 'stageb-crash', version: '1' });
  await c.connect(transport);
  await (await c.callTool({ name: 'memory_remember', arguments: { kind: 'fact', content: 'M7 崩溃恢复标记 MARK-CRASH' } })).content?.[0]?.text ?? '';
  await c.close();

  const spawnViewer = () => {
    const v = spawn(node, [path.join(modDir, 'server/viewer.mjs'), '0'], {
      env: { ...process.env, ...proxyEnv, LM_MEMORY_DIR: storeA, LM_EMBED: '0', LM_REMOTE_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    watch(v.pid, 'viewer');
    return v;
  };
  const viewer = spawnViewer();
  const base1 = await waitPort(viewer, 'viewer1');
  const alive1 = await fetch(base1 + '/api/version').then(r => r.ok, () => false);
  const before = await fetch(base1 + '/api/memories').then(r => r.text(), () => '');
  const markerBefore = before.includes('MARK-CRASH');
  viewer.kill('SIGKILL');
  await sleep(500);
  const dead = !(await fetch(base1 + '/api/version').then(r => r.ok, () => false).catch(() => false));
  const viewer2 = spawnViewer();
  const base2 = await waitPort(viewer2, 'viewer2');
  const alive2 = await fetch(base2 + '/api/memories').then(r => r.ok, () => false);
  const after = await fetch(base2 + '/api/memories').then(r => r.text(), () => '');
  const markerAfter = after.includes('MARK-CRASH');
  record(7, 'viewer SIGKILL 后重启', '崩溃前可访问 / 确认死亡 / 重启后可访问', `alive1=${alive1} dead=${dead} alive2=${alive2}`, alive1 && dead && alive2);
  record(7, '崩溃前标记可见', 'API 返回 MARK-CRASH', markerBefore ? '可见' : '不可见', markerBefore);
  record(7, '重启后标记仍在', 'API 返回 MARK-CRASH', markerAfter ? '可见' : '不可见', markerAfter);
  viewer2.kill();
  // 数据完整性：A 项目库 integrity_check + 标记行在库
  const db = new DatabaseSync(path.join(storeA, 'memory.db'), { readOnly: true });
  const integ = db.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown';
  const rows = db.prepare("SELECT count(*) n FROM memories WHERE status='active' AND content LIKE '%MARK-CRASH%'").get().n;
  db.close();
  record(7, '崩溃后项目库完好', 'integrity_check=ok 且标记行在库', `integrity=${integ} rows=${rows}`, integ === 'ok' && rows === 1);
}

// ================= M8 隐私（凭据拦截 + 监测器自检；外联/汇点判定在 M10 汇总） =================
{
  // 监测器自检：验收器自己的外发探测器必须先证明能精确抓到探针连接（验收系统也要被验收）。
  // 外审 P1-2 修复：不再用"字符串包含 lanIp"判断（公网连接的本地地址也会包含 lanIp），
  // 必须是探针 pid 命中且远端精确等于 lanIp:port；探针命中单独标记，不参与最终判定。
  const lanIp = Object.values(os.networkInterfaces()).flat().find(i => i && !i.internal && i.family === 'IPv4')?.address ?? null;
  let detectorOk = false, detectorDetail = '无非 loopback 网卡，无法自检';
  if (lanIp) {
    const srv = net.createServer(() => {});
    await new Promise(r => srv.listen(0, lanIp, r));
    const port = srv.address().port;
    const probe = spawn('curl', ['-s', '--max-time', '3', `http://${lanIp}:${port}/`], { stdio: 'ignore' });
    watch(probe.pid, 'detector-probe');
    probePid = probe.pid;
    await sleep(900);
    const probeHits = egressHits.filter(h => h.kind === 'probe');
    const exact = probeHits.find(h => h.pid === probe.pid && h.remote === `${lanIp}:${port}`);
    detectorOk = !!exact;
    detectorDetail = `lan=${lanIp}:${port} probeHits=${probeHits.length} exactMatch=${!!exact}`;
    probe.kill('SIGKILL');
    srv.close();
    monitoredPids.delete(probe.pid); // 探针退场：命中保留在证据（kind=probe），不再参与判定
    probePid = null;
    await sleep(600);
  }
  record(8, '外发监测器自检', '探针 pid 精确命中 lan-ip:port', detectorDetail, detectorOk);

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: node, args: [path.join(modDir, 'server/memory-server.mjs')],
    env: { ...process.env, ...proxyEnv, LM_MEMORY_DIR: memDir, LM_EMBED: '0', LM_REMOTE_DISABLED: '1' }, stderr: 'ignore',
  });
  watch(transport.pid, 'm8-server');
  const c = new Client({ name: 'stageb-privacy', version: '1' });
  await c.connect(transport);
  const text = async (n, a) => (await c.callTool({ name: n, arguments: a })).content?.[0]?.text ?? '';
  const secret = await text('memory_remember', { kind: 'fact', content: '我的 API key 是 sk-abcdefghij1234567890' });
  record(8, '凭据写入被拒', 'REFUSED', secret.slice(0, 60), /REFUSED/.test(secret));
  const db = new DatabaseSync(path.join(memDir, 'memory.db'), { readOnly: true });
  const leaked1 = db.prepare("SELECT count(*) n FROM memories WHERE content LIKE '%sk-abcdef%'").get().n;
  db.close();
  const db2 = new DatabaseSync(path.join(storeA, 'memory.db'), { readOnly: true });
  const leaked2 = db2.prepare("SELECT count(*) n FROM memories WHERE content LIKE '%sk-abcdef%'").get().n;
  db2.close();
  record(8, '库中无凭据残留', 'memDir 与 A 项目库均 0 条', `leaked=${leaked1 + leaked2}`, leaked1 === 0 && leaked2 === 0);
  await c.close();
}

// ================= M9 性能 =================
{
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: node, args: [path.join(modDir, 'server/memory-server.mjs')],
    env: { ...process.env, ...proxyEnv, LM_MEMORY_DIR: memDir, LM_EMBED: '0', LM_REMOTE_DISABLED: '1' }, stderr: 'ignore',
  });
  watch(transport.pid, 'm9-server');
  const c = new Client({ name: 'stageb-perf', version: '1' });
  await c.connect(transport);
  const batch = Array.from({ length: 30 }, (_, i) => ({ content: `性能填充条目 PERF-${i}：各种主题的短句，用于让检索有数据量`, kind: 'fact' }));
  const t0 = Date.now();
  await c.callTool({ name: 'memory_batch_remember', arguments: { items: batch } });
  const writeMs = Date.now() - t0;
  const lat = [];
  for (let i = 0; i < 10; i++) {
    const t = Date.now();
    await c.callTool({ name: 'memory_recall', arguments: { query: `性能填充条目 PERF-${i}` } });
    lat.push(Date.now() - t);
  }
  lat.sort((a, b) => a - b);
  const rss = process.memoryUsage().rss;
  record(9, '批量写入 30 条', '<=5s', `${writeMs}ms`, writeMs <= 5000);
  record(9, '召回延迟 p50/p100', 'p50<=300ms', `p50=${lat[4]}ms p100=${lat[9]}ms`, lat[4] <= 300);
  record(9, '验收进程 RSS', '<=512MB', `${Math.round(rss / 1048576)}MB`, rss <= 512 * 1048576);
  await c.close();
}

// ---------- 收尾采样 + 汇总（M10 隔离指纹与全程监测） ----------
clearInterval(sampler);
await sleep(500); // 最后一个采样窗口内的连接落地
{
  // 生产记忆目录指纹（外审 P2-1：含 WAL/SHM 全目录核验）
  const prodFpPost = fs.existsSync(prodDir) ? dirFingerprint(prodDir) : null;
  const changed = [], added = [];
  if (prodFpPre && prodFpPost) {
    for (const k of Object.keys(prodFpPost)) if (!(k in prodFpPre)) added.push(k);
    for (const k of Object.keys(prodFpPre)) {
      if (!(k in prodFpPost)) added.push(k);
      else if (prodFpPre[k] !== prodFpPost[k]) changed.push(k);
    }
  }
  const prodMutations = changed.length + added.length;
  record(10, '生产记忆目录指纹（含 WAL/SHM）', '运行期间 ~/.dsh/memory 零变更（并发会话写入会如实 FAIL）',
    `${Object.keys(prodFpPost ?? {}).length} 文件；变更 ${prodMutations} 处${changed.concat(added).length ? '：' + changed.concat(added).slice(0, 5).join(', ') : ''}`,
    !!prodFpPre && !!prodFpPost && prodMutations === 0);
  record(10, '验收数据目录在隔离 HOME 内', 'memDir 位于 acceptHome 下', memDir, memDir.startsWith(acceptHome));
  const fA = sha(path.join(storeA, 'memory.db'));
  const fB = sha(path.join(storeB, 'memory.db'));
  const fWt = sha(path.join(storeWt, 'memory.db'));
  record(10, '项目库指纹互异', 'A/B/WT 三库 sha256 互不相同', `${fA.slice(0, 8)}/${fB.slice(0, 8)}/${fWt.slice(0, 8)}`, new Set([fA, fB, fWt]).size === 3);
  // 外联判定（外审 P1-2）：无基线清零。探针命中（kind=probe）不参与判定；
  // 记忆组件（memory-server/viewer）任何非 loopback 命中即 FAIL；宿主进程命中逐条归属披露。
  const liveHits = egressHits.filter(h => h.kind === 'monitored');
  const memCompHits = liveHits.filter(h => /memory-server\.mjs|viewer\.mjs/.test(h.cmd));
  const hostHits = liveHits.filter(h => !/memory-server\.mjs|viewer\.mjs/.test(h.cmd));
  const distinctRemotes = [...new Set(hostHits.map(h => h.remote))];
  // PTR 反查尽力而为（搭建期环境允许 DNS；查不到就如实标 no-ptr）
  const ptrOf = {};
  for (const r of distinctRemotes) {
    const host = parseAddr(r);
    try { ptrOf[r] = execFileSync('dig', ['+time=2', '+tries=1', '-x', host, '+short'], { encoding: 'utf8', timeout: 6000 }).trim().split('\n')[0] || 'no-ptr'; }
    catch { ptrOf[r] = 'no-ptr'; }
  }
  record(10, '记忆组件零外联', 'memory-server/viewer 全程无非 loopback 连接', `hits=${memCompHits.length}`, memCompHits.length === 0);
  record(10, '宿主进程外联归类披露', '每条命中归属 pid/命令/远端，附 PTR 反查（宿主基础设施，非记忆组件）',
    `hits=${hostHits.length} 远端 ${distinctRemotes.length} 种：` + distinctRemotes.slice(0, 4).map(r => `${r}(${ptrOf[r]})`).join(' ; '),
    hostHits.every(h => h.cmd && h.pid));
  record(10, 'PID 身份核验', '采样前核验进程身份，防 PID 复用误归因', `expired=${expiredPids} suspect=${suspectPidHits}`, suspectPidHits === 0);
  record(10, '监测覆盖窗口', '采样器先于首个被监视进程启动', `sampler=${samplerStartedAt} firstWatch=${firstWatchAt}`, !!firstWatchAt && samplerStartedAt <= firstWatchAt);
  record(10, '代理汇点零命中', 'HTTP(S)_PROXY 指向本地汇点，全程 0 请求', `sinkHits=${sinkHits}`, sinkHits === 0);
  evidence('egress-monitor.json', { samplerStartedAt, monitored: [...monitoredPids.entries()].map(([pid, v]) => ({ pid, ...v })), hits: egressHits, sinkHits, expiredPids, suspectPidHits, hostHitRemotes: distinctRemotes, hostRemotePtr: ptrOf });
  evidence('isolation-fingerprints.json', { prodDir, prodFiles: Object.keys(prodFpPost ?? {}).length, prodMutations, prodChanged: changed.concat(added), storeA: fA, storeB: fB, storeWt: fWt, memDir, acceptHome });
}
sink.close();

// ---------- 汇总 ----------
const pass = report.filter(r => r.pass).length;
const summary = {
  pluginVersion, tgzSha, generated: new Date().toISOString(),
  runner: 'dsh-stageb.mjs@0.19.8（验收器修复后重跑：boolean 断言强制 + 测试对象对齐 + 真实外发监测）',
  harnessSelfTest: 'tests/stageb-harness.test.mjs',
  env: {
    node: process.version, platform: `${os.platform()}/${os.arch()} ${os.release()}`, host: os.hostname(),
    dshInstallDir: DSH_INSTALL_DIR, acceptHome, memDir,
    prodDirMonitored: !!prodFpPre,
    monitoredPids: monitoredPids.size,
  },
  total: report.length, pass, fail: report.length - pass,
};
evidence('summary.json', summary);
evidence('report.json', report);
const lines = ['# lm-memory 阶段 B 验收报告（0.19.8 重跑）', '',
  `- 插件版本：${pluginVersion}（tgz sha256 ${tgzSha.slice(0, 16)}…）`,
  `- 验收环境：Node ${process.version} · ${os.platform()}/${os.arch()} · 主机 ${os.hostname()} · DSH ${DSH_INSTALL_DIR}`,
  `- 隔离 HOME：${acceptHome} · 数据目录 ${memDir} · 生产目录指纹核验：${summary.env.prodDirMonitored ? '已执行' : '生产目录缺失'}`,
  `- 验收器自检：tests/stageb-harness.test.mjs（record 强制 boolean，杜绝假 PASS）`,
  `- M6 自动召回实机验证独立执行：scripts/eval/dsh-stageb-m6.mjs（见 docs/acceptance/stage-b-m6-optin.md）`,
  '', '| 模块 | 检查 | 预期 | 实际 | 结果 |', '|---|---|---|---|---|'];
for (const r of report) lines.push(`| M${r.module} | ${r.name} | ${r.expected} | ${r.actual} | ${r.pass ? 'PASS' : 'FAIL'} |`);
lines.push('', `**结果：${pass}/${report.length} PASS**`, '',
  '> 外审复审说明：0.19.7 的 38/38 存在验收器假阳性（actual/pass 错序 + 写死 PASS），真实成绩 28/38；',
  '> 本报告由修复后的验收器生成，每一行 pass 均为真实布尔断言。');
evidence('STAGE-B-REPORT.md', lines.join('\n'));
console.log(`\n阶段 B：${pass}/${report.length} PASS — 报告在 ${reportDir}`);
if (pass !== report.length) process.exitCode = 1;
