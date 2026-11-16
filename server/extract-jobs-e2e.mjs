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
import path from "node:path";
import { fileURLToPath } from "node:url";
const httpMod = http; // 场景7 原始请求复用

const MEM_DIR = process.env.LM_MEMORY_DIR;
if (!MEM_DIR || MEM_DIR === path.join(process.env.HOME, ".dsh", "memory") || MEM_DIR === path.join(process.env.HOME, ".lm-memory")) {
  console.error("拒绝在真实库上跑测试"); process.exit(2);
}
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

// —— mock LLM：可切换 healthy/broken；记录最近请求体（验证窗口内容用）——
let mockHealthy = true;
let lastBody = "";
const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", (ch) => (body += ch));
  req.on("end", () => {
    lastBody = body;
    if (!mockHealthy) { res.writeHead(500); return res.end("broken"); }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: body.includes("提炼") ? '[{"kind":"fact","content":"EJ_LLM_OK 提炼成功"}]' : "EJ_SUMMARY_OK 摘要成功" } }] }));
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
mockHealthy = false;
const j2 = mkJob("ej-fail.json", ["消息甲", "消息乙"], { rev: "2026-11-17T03:00:02.000Z" });
const before = fs.existsSync(queuePath) ? fs.readFileSync(queuePath, "utf8") : "";
const r2 = await runHelper(j2);
t("场景2 LLM 失败非零退出", r2.status !== 0, `exit=${r2.status}`);
t("LLM 失败保留 job（重试依据不丢）", fs.existsSync(j2));
t("LLM 失败不产候选（不当空结果）", (fs.existsSync(queuePath) ? fs.readFileSync(queuePath, "utf8") : "") === before);

// —— 场景 3：恢复 → 重跑成功 → 消费 → 账本 done ——
mockHealthy = true;
const r3 = await runHelper(j2);
t("场景3 恢复重跑成功且 job 清理", r3.status === 0 && !fs.existsSync(j2), `exit=${r3.status}`);
await call("memory_recall", { query: "EJ_LLM_OK 触发消费" });
t("重跑候选恰好入库一次", db().prepare("SELECT count(*) n FROM memories WHERE content LIKE '%EJ_LLM_OK%'").get().n === 1);
const ledger = db().prepare("SELECT status, attempts FROM extract_jobs WHERE session_id='s-ej' AND revision='2026-11-17T03:00:02.000Z'").get();
t("任务账本记录 done（漏记可查询）", ledger?.status === "done", JSON.stringify(ledger));

// —— 场景 4：本地时区日期（UTC 实锤：东八区凌晨 UTC 截断回退一天）——
await call("memory_remember", { content: "EJ_DATECHECK 时区测试条目", kind: "fact" });
const localExpect = new Date().toLocaleDateString("sv");
const edRow = db().prepare("SELECT event_date FROM memories WHERE content LIKE '%EJ_DATECHECK%'").get();
t("默认 event_date 为本地时区日期", edRow?.event_date === localExpect, `got=${edRow?.event_date} expect=${localExpect}`);

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
t("dispatch 文件名含 rev（旧 worker 删不到新任务）", /\$\{session\.id\}-\$\{rev\}\.json/.test(pluginSrc));

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
    const good = await fetch(`http://127.0.0.1:${port}/api/memories`, { headers: { Origin: `http://localhost:${port}` } });
    t("本机 Origin 放行", good.status === 200, `status=${good.status}`);
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
