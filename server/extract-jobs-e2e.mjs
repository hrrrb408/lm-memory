#!/usr/bin/env node
// extract-jobs-e2e.mjs — v0.16 提炼任务状态机回归（第七轮外审四项实锤）。
// 覆盖：LLM 失败保留任务+非零退出 / 恢复重跑恰好一次 / 窗口保两头（尾部纠正进 prompt）/
//       任务账本 done / 本地时区日期 / current.md EXISTS 自愈 / dispatch 文件名带 rev（竞态消除）。
// 用法: LM_MEMORY_DIR=<空目录> node extract-jobs-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const httpMod = http; // 场景7 原始请求复用

const MEM_DIR = process.env.LM_MEMORY_DIR;
if (!MEM_DIR || MEM_DIR === path.join(process.env.HOME, ".dsh", "memory") || MEM_DIR === path.join(process.env.HOME, ".lm-memory")) {
  console.error("拒绝在真实库上跑测试"); process.exit(2);
}
process.env.LM_TEST_KEY = "test"; // 让 server spawn 的 helper 继承测试 key（生产从 env/credentials 读取）
const DB = path.join(MEM_DIR, "memory.db");
import { rmEvalDir } from "../scripts/eval/eval-dir-guard.mjs";
rmEvalDir(MEM_DIR);
fs.mkdirSync(MEM_DIR, { recursive: true });

const c = new Client({ name: "extract-jobs-e2e", version: "0.16" });
await c.connect(new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./memory-server.mjs", import.meta.url))],
  env: { ...process.env, LM_MEMORY_DIR: MEM_DIR, LM_EMBED: "0" },
}));
const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content[0].text;
const db = () => new DatabaseSync(DB, { readOnly: true });
const dbw = () => new DatabaseSync(DB);
let pass = 0, fail = 0;
const t = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "✅" : "❌") + " " + name + (extra ? " — " + extra : "")); };

// —— mock LLM：可切换模式；记录最近请求体（验证窗口内容用）——
// healthy: 正常 | broken: HTTP 500 | truncated: 200 + finish_reason=length + 截断 JSON | zero: 合法 [] + 空摘要
let mockMode = "healthy";
let lastBody = "";
const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", (ch) => (body += ch));
  req.on("end", () => {
    lastBody = body;
    if (mockMode === "broken") { res.writeHead(500); return res.end("broken"); }
    if (mockMode === "truncated") { // 第八轮复核实锤：HTTP 200 + length + 截断 JSON 曾被当成功
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '[{"kind":"fact","content":"TRUNC' } }] }));
    }
    if (mockMode === "zero") { // 真空会话：提炼合法 []（空串是坏输出）、摘要空串
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: body.includes("提炼") ? "[]" : "" } }] }));
    }
    res.setHeader("Content-Type", "application/json");
    const pf = body.includes("PFMARK"); // 3b 部分失败场景：内容必须唯一（与场景3同文会走 EXISTS 绕过注入）
    const fact = pf ? "EJ_PF_FACT 部分失败场景事实" : "EJ_LLM_OK 提炼成功";
    const summ = pf ? "EJ_PF_SUMMARY_PARTIAL_FAIL 部分失败场景摘要" : "EJ_SUMMARY_OK 摘要成功";
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: body.includes("提炼") ? `[{"kind":"fact","content":"${fact}"}]` : summ } }] }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mockPort = mock.address().port;

const jobsDir = path.join(MEM_DIR, "extraction-jobs");
fs.mkdirSync(jobsDir, { recursive: true });
const helperPath = fileURLToPath(new URL("../plugin/lib/extract-helper.mjs", import.meta.url));
const queuePath = path.join(MEM_DIR, "pending-memories.jsonl");
const runHelper = (jp) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [helperPath, jp], { env: { ...process.env, LM_MEMORY_DIR: MEM_DIR, LM_TEST_KEY: "test", LM_EMBED: "0" } });
  let done = false;
  const timer = setTimeout(() => { if (!done) { done = true; ch.kill("SIGKILL"); resolve({ status: null }); } }, 60000);
  ch.on("exit", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ status: code }); } });
});
const mkJob = (name, texts, extra = {}) => {
  const p = path.join(jobsDir, name);
  fs.writeFileSync(p, JSON.stringify({
    sessionId: "s-ej", rev: extra.rev || "2026-11-17T03:00:00.000Z", date: "2026-11-17", cwd: "", texts,
    llm: { model: "mock", baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKeyEnv: "LM_TEST_KEY" }, ...extra,
  }));
  return p;
};

// —— 场景 1：长消息尾部纠正进 prompt（窗口保两头）——
const tailFix = "更正：最终结论是 B 方案，前面说的 A 方案作废。".padStart(0, "");
const longMsg = "背景介绍：".padEnd(600, "背景内容填充。") + tailFix; // 600+ 字，纠正在尾部（旧版 500 字截断必丢）
const j1 = mkJob("ej-tail.json", ["短消息一", "短消息二", longMsg], { rev: "2026-11-17T03:00:01.000Z" });
const r1 = await runHelper(j1);
t("场景1 helper 成功", r1.status === 0, `exit=${r1.status}`);
t("尾部纠正进入 LLM prompt（先选窗后截断，保两头）", lastBody.includes("B 方案"), `含尾部=${lastBody.includes("B 方案")} 含头部=${lastBody.includes("背景介绍")}`);

// —— 场景 2：LLM 连续失败 → 保留 job + 非零退出（第七轮实锤：旧版 exit 0 删任务 = 永久漏记）——
mockMode = "broken";
const j2 = mkJob("ej-fail.json", ["消息甲", "消息乙"], { rev: "2026-11-17T03:00:02.000Z" });
const before = fs.existsSync(queuePath) ? fs.readFileSync(queuePath, "utf8") : "";
const r2 = await runHelper(j2);
t("场景2 LLM 失败非零退出", r2.status !== 0, `exit=${r2.status}`);
t("LLM 失败保留 job（重试依据不丢）", fs.existsSync(j2));
t("LLM 失败不产候选（不当空结果）", (fs.existsSync(queuePath) ? fs.readFileSync(queuePath, "utf8") : "") === before);

// —— 场景 2b：HTTP 200 + finish_reason=length + 截断 JSON → 同样失败保留（第八轮复核实锤曾当成功）——
mockMode = "truncated";
const j2b = mkJob("ej-trunc.json", ["消息丙", "消息丁"], { rev: "2026-11-17T03:00:03.000Z" });
const r2b = await runHelper(j2b);
t("场景2b 截断 JSON 输出非零退出", r2b.status !== 0, `exit=${r2b.status}`);
t("截断输出保留 job", fs.existsSync(j2b));

// —— 场景 3：恢复 → 重跑成功 → 消费 → 账本 done（v0.16.1：全部候选处置完毕才 done）——
mockMode = "healthy";
const r3 = await runHelper(j2);
t("场景3 恢复重跑成功且 job 清理", r3.status === 0 && !fs.existsSync(j2), `exit=${r3.status}`);
await call("memory_recall", { query: "EJ_LLM_OK 触发消费" });
t("重跑候选恰好入库一次", db().prepare("SELECT count(*) n FROM memories WHERE content LIKE '%EJ_LLM_OK%'").get().n === 1);
const ledger = db().prepare("SELECT status, last_note FROM extract_jobs WHERE session_id='s-ej' AND revision='2026-11-17T03:00:02.000Z'").get();
t("任务账本 done（回执全量核对）", ledger?.status === "done", JSON.stringify(ledger));

// —— 场景 3b：双候选部分失败 → 账本不得 done；恢复后全部处置 → done（第八轮复核实锤：任意一条成功就 done）——
const j3b = mkJob("ej-partial.json", ["部分失败场景消息 PFMARK"], { rev: "2026-11-17T03:00:04.000Z" });
const r3b = await runHelper(j3b);
t("场景3b job 运行成功", r3b.status === 0, `exit=${r3b.status}`);
{ // 注入：拦截 PF summary 的写库——fact 成功、summary 失败留重试队列（内容唯一，不会被 EXISTS 绕过）
  const inj = new DatabaseSync(DB);
  inj.exec("CREATE TRIGGER inj_partial BEFORE INSERT ON memories WHEN NEW.content LIKE '%EJ_PF_SUMMARY_PARTIAL_FAIL%' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  await call("memory_recall", { query: "PARTIAL 触发部分失败消费" });
  const mid = db().prepare("SELECT status FROM extract_jobs WHERE session_id='s-ej' AND revision='2026-11-17T03:00:04.000Z'").get();
  t("一条候选失败时任务不得 done", mid?.status !== "done", JSON.stringify(mid));
  t("失败候选留在重试队列", fs.readFileSync(queuePath, "utf8").includes("EJ_PF_SUMMARY_PARTIAL_FAIL"));
  inj.exec("DROP TRIGGER inj_partial"); inj.close();
}
await call("memory_recall", { query: "PARTIAL 恢复后消费" });
const done3b = db().prepare("SELECT status FROM extract_jobs WHERE session_id='s-ej' AND revision='2026-11-17T03:00:04.000Z'").get();
t("全部候选处置完毕后 done", done3b?.status === "done", JSON.stringify(done3b));

// —— 场景 3c：零候选任务有明确终态（第八轮复核实锤：删文件后无账本记录）——
mockMode = "zero";
const j3c = mkJob("ej-zero.json", ["寒暄消息一", "寒暄消息二"], { rev: "2026-11-17T03:00:05.000Z" });
const r3c = await runHelper(j3c);
t("场景3c 零候选 job 成功清理", r3c.status === 0 && !fs.existsSync(j3c), `exit=${r3c.status}`);
await call("memory_recall", { query: "ZERO 触发结算" });
const zero = db().prepare("SELECT status, last_note FROM extract_jobs WHERE session_id='s-ej' AND revision='2026-11-17T03:00:05.000Z'").get();
t("零候选任务终态 done(zero)，账本可查询", zero?.status === "done" && /zero/.test(zero?.last_note || ""), JSON.stringify(zero));
mockMode = "healthy";

// —— 场景 3d：领取原子性（第八轮复核实锤：双 worker 同 revision，账本 running+attempts=2）——
// 双连接模拟 MCP 与 viewer 子 server 的两个回收器：lease 内第二个 claim 必须失败；lease 过期后方可重领
{
  const c1 = new DatabaseSync(DB), c2 = new DatabaseSync(DB);
  for (const x of [c1, c2]) x.exec("PRAGMA busy_timeout=5000");
  const revX = "2026-11-17T03:00:06.000Z";
  c1.prepare("INSERT OR REPLACE INTO extract_jobs (session_id, revision, status, attempts, updated_at) VALUES ('s-ej', ?, 'pending', 0, ?)").run(revX, new Date().toISOString());
  const CLAIM = `UPDATE extract_jobs SET status='running', attempts=attempts+1, owner=?, updated_at=?
    WHERE session_id='s-ej' AND revision=? AND (status='pending' OR (status='running' AND updated_at < ?))`;
  const leaseAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  const rA = c1.prepare(CLAIM).run("srv-A", new Date().toISOString(), revX, leaseAgo);
  const rB = c2.prepare(CLAIM).run("srv-B", new Date().toISOString(), revX, leaseAgo); // lease 内 → 必须抢不到
  const rowA = c1.prepare("SELECT owner, attempts FROM extract_jobs WHERE revision=?").get(revX);
  t("lease 内第二 server 抢不到（原子领取）", rA.changes === 1 && rB.changes === 0 && rowA.owner === "srv-A" && rowA.attempts === 1, `A=${rA.changes} B=${rB.changes} owner=${rowA.owner}`);
  c1.prepare("UPDATE extract_jobs SET updated_at=? WHERE revision=?").run(new Date(Date.now() - 15 * 60 * 1000).toISOString(), revX); // 拨回租约外（与 leaseAgo 差 4 分钟，避免同毫秒生成导致严格小于不成立）
  const rC = c2.prepare(CLAIM).run("srv-B", new Date().toISOString(), revX, leaseAgo);
  const rowC = c1.prepare("SELECT owner, attempts FROM extract_jobs WHERE revision=?").get(revX);
  t("lease 过期后可重领（attempts 递增）", rC.changes === 1 && rowC.owner === "srv-B" && rowC.attempts === 2, `C=${rC.changes} owner=${rowC.owner} attempts=${rowC.attempts}`);
  c1.close(); c2.close();
}

// —— 场景 4：本地时区日期（UTC 实锤：东八区凌晨 UTC 截断回退一天）——
await call("memory_remember", { content: "EJ_DATECHECK 时区测试条目", kind: "fact" });
const localExpect = new Date().toLocaleDateString("sv");
const edRow = db().prepare("SELECT event_date FROM memories WHERE content LIKE '%EJ_DATECHECK%'").get();
t("默认 event_date 为本地时区日期", edRow?.event_date === localExpect, `got=${edRow?.event_date} expect=${localExpect}`);
{ // v0.16.1（P2-4）：主路径 remember 事件必须带 eid（复核实锤：commitMemoryTx 事务内 INSERT 曾漏 eid）
  const evLine = fs.readFileSync(path.join(MEM_DIR, "changes.jsonl"), "utf8").split("\n").filter(Boolean).reverse().find((l) => l.includes("EJ_DATECHECK"));
  t("remember 事件带 eid（主路径）", !!evLine && !!JSON.parse(evLine).eid, evLine ? evLine.slice(0, 90) : "none");
}

// —— 场景 5：current.md 写失败 → EXISTS 自愈（第七轮实锤：索引永久缺）——
const currentMd = path.join(MEM_DIR, "current.md");
fs.writeFileSync(currentMd, ""); // 确保文件存在可 chmod
fs.chmodSync(currentMd, 0o444);
const r5a = await call("memory_remember", { content: "EJ_HEAL 自愈测试条目", kind: "fact" });
t("current.md 只读时 DB 提交仍成功", r5a.startsWith("OK"), r5a.slice(0, 40));
fs.chmodSync(currentMd, 0o644);
const r5b = await call("memory_remember", { content: "EJ_HEAL 自愈测试条目", kind: "fact" });
t("重试返回 EXISTS 并触发补修", r5b.startsWith("EXISTS"), r5b.slice(0, 40));
t("current.md 已补齐该条目（EXISTS 自愈）", fs.readFileSync(currentMd, "utf8").includes("EJ_HEAL"));

// —— 场景 6：dispatch 文件名带 rev（竞态消除，静态断言）——
const pluginSrc = fs.readFileSync(fileURLToPath(new URL("../plugin/lib/index.js", import.meta.url)), "utf8");
t("dispatch 文件名含 rev（旧 worker 删不到新任务）", /\$\{session\.id\}-\$\{rev\.replace/.test(pluginSrc));
t("插件不再直接 spawn helper（统一走 server 登记+领取入口）", !/extract-helper\.mjs/.test(pluginSrc) && pluginSrc.includes("pending-jobs.jsonl"));

// —— 场景 6b：旧表升级（第九轮复核实锤：v0.16 表 CHECK 无 pending，登记失败被静默吞、回执被删）——
{
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-olddb-"));
  const odb = new DatabaseSync(path.join(oldDir, "memory.db"));
  odb.exec("PRAGMA journal_mode=WAL");
  odb.exec(`CREATE TABLE extract_jobs (session_id TEXT NOT NULL, revision TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, last_note TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, revision))`);
  odb.prepare("INSERT INTO extract_jobs (session_id, revision, status, attempts, updated_at) VALUES (?,?,?,?,?)").run("s-old", "R-old", "running", 2, new Date().toISOString());
  fs.mkdirSync(path.join(oldDir, "extraction-jobs", "receipts"), { recursive: true });
  fs.writeFileSync(path.join(oldDir, "extraction-jobs", "receipts", "s-old2-R-old2.json"), JSON.stringify({ sessionId: "s-old2", revision: "R-old2", eids: [], at: new Date().toISOString() }));
  odb.close();
  const c2 = new Client({ name: "olddb-e2e", version: "0.16" });
  await c2.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("./memory-server.mjs", import.meta.url))], env: { ...process.env, LM_MEMORY_DIR: oldDir, LM_EMBED: "0" } }));
  await (await c2.callTool({ name: "memory_recall", arguments: { query: "触发旧库迁移结算" } }));
  const odb2 = new DatabaseSync(path.join(oldDir, "memory.db"), { readOnly: true });
  t("旧表迁移：running→pending（CHECK 含 pending 可写）", odb2.prepare("SELECT status FROM extract_jobs WHERE revision='R-old'").get()?.status === "pending");
  t("旧表迁移后零候选回执能结清 done", odb2.prepare("SELECT status, last_note FROM extract_jobs WHERE revision='R-old2'").get()?.status === "done", JSON.stringify(odb2.prepare("SELECT status, last_note FROM extract_jobs WHERE revision='R-old2'").get()));
  t("回执仅在结清后删除", !fs.existsSync(path.join(oldDir, "extraction-jobs", "receipts", "s-old2-R-old2.json")));
  await c2.close();
  fs.rmSync(oldDir, { recursive: true, force: true });
}

// —— 场景 6c：首次派发走统一入口（第九轮复核实锤：插件直接 spawn 绕过登记/领取）——
{
  const waitFor = async (cond, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };
  const dispJob = path.join(jobsDir, "s-disp-2026-11-17T04-00-00-000Z.json");
  fs.writeFileSync(dispJob, JSON.stringify({ sessionId: "s-disp", rev: "2026-11-17T04:00:00.000Z", date: "2026-11-17", cwd: "", texts: ["派发入口测试甲 PFMARK", "派发入口测试乙"], llm: { model: "mock", baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKeyEnv: "LM_TEST_KEY" } }));
  const oldT = new Date(Date.now() - 3 * 60 * 1000); fs.utimesSync(dispJob, oldT, oldT);
  fs.appendFileSync(path.join(MEM_DIR, "pending-jobs.jsonl"), JSON.stringify({ sessionId: "s-disp", rev: "2026-11-17T04:00:00.000Z", jobFile: path.basename(dispJob) }) + "\n");
  await call("memory_recall", { query: "派发入口测试" });
  const seen = await waitFor(() => !!db().prepare("SELECT 1 FROM extract_jobs WHERE revision='2026-11-17T04:00:00.000Z'").get(), 5000);
  const ledgerDisp = db().prepare("SELECT status, attempts FROM extract_jobs WHERE revision='2026-11-17T04:00:00.000Z'").get();
  t("通知被消费且任务经领取登记（attempts≥1）", seen && ledgerDisp?.attempts >= 1, JSON.stringify(ledgerDisp));
  const receiptSeen = await waitFor(() => { const d = path.join(MEM_DIR, "extraction-jobs", "receipts"); return fs.existsSync(d) && fs.readdirSync(d).some((f) => f.startsWith("s-disp")); }, 20000);
  t("server 拉起的 helper 完成后写回执", receiptSeen);
  await call("memory_recall", { query: "派发入口测试 消费候选" }); // 消费 PF 候选 + settle
  t("首次派发任务经统一入口结算 done", db().prepare("SELECT status FROM extract_jobs WHERE revision='2026-11-17T04:00:00.000Z'").get()?.status === "done");
}

// —— 场景 6d：第五次有效租约不被误杀（第九轮复核实锤：attempts 耗尽判断在租约检查之前）——
{
  const leaseJob = path.join(jobsDir, "s-lease-2026-11-17T04-01-00-000Z.json");
  fs.writeFileSync(leaseJob, JSON.stringify({ sessionId: "s-lease", rev: "2026-11-17T04:01:00.000Z", date: "2026-11-17", cwd: "", texts: ["租约测试甲", "租约测试乙"], llm: { model: "mock", baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKeyEnv: "LM_TEST_KEY" } }));
  const oldT = new Date(Date.now() - 3 * 60 * 1000); fs.utimesSync(leaseJob, oldT, oldT);
  dbw().prepare("INSERT OR REPLACE INTO extract_jobs (session_id, revision, status, attempts, owner, last_note, updated_at) VALUES ('s-lease','2026-11-17T04:01:00.000Z','running',5,'srv-other',NULL,?)").run(new Date().toISOString());
  const startSecond = () => new Promise((resolve) => {
    const ch = spawn(process.execPath, [fileURLToPath(new URL("./memory-server.mjs", import.meta.url))], { env: { ...process.env, LM_MEMORY_DIR: MEM_DIR, LM_EMBED: "0" }, stdio: ["ignore", "ignore", "ignore"] });
    setTimeout(() => { try { ch.kill("SIGTERM"); } catch {} resolve(); }, 2500); // 等 startup respawn 跑过
  });
  await startSecond();
  const alive = db().prepare("SELECT status, attempts FROM extract_jobs WHERE revision='2026-11-17T04:01:00.000Z'").get();
  t("有效租约内第五次执行不被归档（attempts=5 保留）", alive?.status === "running" && alive?.attempts === 5, JSON.stringify(alive));
  dbw().prepare("UPDATE extract_jobs SET updated_at=? WHERE session_id='s-lease'").run(new Date(Date.now() - 11 * 60 * 1000).toISOString()); // 租约过期
  await startSecond();
  const dead = db().prepare("SELECT status FROM extract_jobs WHERE revision='2026-11-17T04:01:00.000Z'").get();
  t("租约过期后才判耗尽（第 6 次领取 → failed）", dead?.status === "failed", JSON.stringify(dead));
}

// —— 场景 7：viewer Origin 边界 ——
{
  const { execFileSync } = await import("node:child_process");
  const viewerPath = fileURLToPath(new URL("./viewer.mjs", import.meta.url));
  const port = 18999 + (process.pid % 500);
  const vch = spawn(process.execPath, [viewerPath, String(port)], { env: { ...process.env, LM_MEMORY_DIR: MEM_DIR }, detached: true, stdio: "ignore" });
  vch.unref();
  await new Promise((r) => setTimeout(r, 1200));
  try {
    const evil = await fetch(`http://127.0.0.1:${port}/api/memories`, { headers: { Origin: "http://evil.example.com" } });
    t("恶意 Origin 被拒（403）", evil.status === 403, `status=${evil.status}`);
    const crossPort = await fetch(`http://127.0.0.1:${port}/api/memories`, { headers: { Origin: `http://localhost:1` } });
    t("跨端口本机 Origin 被拒（v0.16.1 同源收紧）", crossPort.status === 403, `status=${crossPort.status}`);
    const good = await fetch(`http://127.0.0.1:${port}/api/memories`, { headers: { Origin: `http://127.0.0.1:${port}` } }); // Origin 与连接 host 全等（严格同源；localhost 页面场景同理）
    t("同源 Origin（host:port 全等）放行", good.status === 200, `status=${good.status}`);
    const noOrigin = await fetch(`http://127.0.0.1:${port}/api/version`);
    t("无 Origin（curl/同源）放行", noOrigin.status === 200, `status=${noOrigin.status}`);
    // Host 头测试：fetch 不允许覆盖 Host，用原生 http.request 发原始请求
    const hostProbe = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/version", headers: { Host: "evil.example.com" }, method: "GET" }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", () => resolve(0));
      req.end();
    });
    t("非法 Host 被拒（防 DNS rebinding）", hostProbe === 403, `status=${hostProbe}`);
  } finally { try { process.kill(vch.pid, "SIGTERM"); } catch {} }
}

await c.close();
await new Promise((r) => mock.close(r));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
