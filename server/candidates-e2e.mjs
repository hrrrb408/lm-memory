#!/usr/bin/env node
// candidates-e2e.mjs — v0.15 统一提交入口回归：采集卡与提炼候选队列经同一 commitMemoryTx 消费。
// 覆盖：候选入库 / 精确查重 / 凭据拒收 / 摘要卡会话幂等 / 崩溃恢复(.processing 并回) / 坏行重试保留 / 热流 announce。
// 用法: LM_MEMORY_DIR=<空目录> node candidates-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MEM_DIR = process.env.LM_MEMORY_DIR;
if (!MEM_DIR || MEM_DIR === path.join(process.env.HOME, ".dsh", "memory") || MEM_DIR === path.join(process.env.HOME, ".lm-memory")) {
  console.error("拒绝在真实库上跑测试"); process.exit(2);
}
const DB = path.join(MEM_DIR, "memory.db");
fs.rmSync(MEM_DIR, { recursive: true, force: true });
fs.mkdirSync(MEM_DIR, { recursive: true });

// 预置队列文件（server 启动时 ingestAll 消化）
const card = { sessionId: "s-card-1", kind: "episode", content: "会话 2026-11-17｜测试目录｜3 条用户输入｜首问「造测试卡」｜末问「收尾」", tags: "auto-capture", eventDate: "2026-11-17", capturedAt: "2026-11-17T00:00:00.000Z" };
const fact = { sessionId: "s-ext-1", date: "2026-11-17", kind: "fact", content: "候选事实：lm-memory 用 SQLite+FTS5", tags: "auto,session:s-ext-1", capturedAt: "2026-11-17T00:00:01.000Z", eventDate: "2026-11-17" };
const factDup = { ...fact, capturedAt: "2026-11-17T00:00:02.000Z" }; // 与上一条同 content → 查重跳过
const secret = { sessionId: "s-ext-1", date: "2026-11-17", kind: "fact", content: "我的 key 是 sk-abcdefghijklmnopqrstuvwx 别弄丢", tags: "auto,session:s-ext-1", capturedAt: "2026-11-17T00:00:03.000Z", eventDate: "2026-11-17" };
const summary = { sessionId: "s-ext-1", date: "2026-11-17", kind: "episode", content: "会话摘要 2026-11-17：测试统一提交入口", tags: "summary,session:s-ext-1", capturedAt: "2026-11-17T00:00:04.000Z", eventDate: "2026-11-17" };
const summaryDup = { ...summary, capturedAt: "2026-11-17T00:00:05.000Z" }; // 同会话第二张摘要卡 → 幂等跳过
fs.writeFileSync(path.join(MEM_DIR, "pending-episodes.jsonl"), JSON.stringify(card) + "\n");
fs.writeFileSync(path.join(MEM_DIR, "pending-memories.jsonl"), [fact, factDup, secret, summary, summaryDup].map((r) => JSON.stringify(r)).join("\n") + "\n");

const c = new Client({ name: "candidates-e2e", version: "0.15" });
await c.connect(new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./memory-server.mjs", import.meta.url))],
  env: { ...process.env, LM_MEMORY_DIR: MEM_DIR, LM_EMBED: "0" },
}));
const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content[0].text;
const db = () => new DatabaseSync(DB, { readOnly: true });
const rows = (sql, ...p) => db().prepare(sql).all(...p);
let pass = 0, fail = 0;
const t = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "✅" : "❌") + " " + name + (extra ? " — " + extra : "")); };

await call("memory_recall", { query: "SQLite" }); // 触发一次 ingestAll（幂等，此时应已消化完）

t("采集卡入库（统一入口）", rows("SELECT 1 FROM memories WHERE tags LIKE '%session:s-card-1%'").length === 1);
t("候选 fact 入库", rows("SELECT 1 FROM memories WHERE content LIKE '候选事实%'").length === 1);
t("同内容候选查重去重", rows("SELECT 1 FROM memories WHERE content LIKE '候选事实%'").length === 1);
t("凭据候选被拒收", rows("SELECT 1 FROM memories WHERE content LIKE '%sk-abc%'").length === 0);
t("摘要卡入库", rows("SELECT 1 FROM memories WHERE tags LIKE 'summary,%' AND tags LIKE '%session:s-ext-1%'").length === 1);
t("第二张摘要卡被会话幂等跳过", rows("SELECT 1 FROM memories WHERE tags LIKE 'summary,%'").length === 1);
t("队列文件已消费清空", !fs.existsSync(path.join(MEM_DIR, "pending-episodes.jsonl")) && !fs.existsSync(path.join(MEM_DIR, "pending-memories.jsonl")));
const audits = fs.readFileSync(path.join(MEM_DIR, "log.jsonl"), "utf8");
t("审计含 ingest_pending/ingest_candidates/commit_rejected", ["ingest_pending", "ingest_candidates", "commit_rejected"].every((k) => audits.includes(k)));
const changes = fs.readFileSync(path.join(MEM_DIR, "changes.jsonl"), "utf8");
t("热流含 auto-extract 的 remember", changes.includes("auto-extract"));
t("event_date 取会话日期而非 capturedAt 时间戳", rows("SELECT event_date FROM memories WHERE content LIKE '候选事实%'")[0]?.event_date === "2026-11-17");

// 崩溃恢复：残留 .processing 文件应在下次消费时并回处理
const recovery = { sessionId: "s-ext-2", date: "2026-11-17", kind: "fact", content: "崩溃恢复候选：队列协议断点续传", tags: "auto,session:s-ext-2", capturedAt: "2026-11-17T01:00:00.000Z", eventDate: "2026-11-17" };
fs.writeFileSync(path.join(MEM_DIR, "pending-memories.jsonl.processing"), JSON.stringify(recovery) + "\n");
await call("memory_recall", { query: "断点续传" });
t("崩溃残留 .processing 并回并消费", rows("SELECT 1 FROM memories WHERE content LIKE '%断点续传%'").length === 1);
t("恢复后 .processing 清理", !fs.existsSync(path.join(MEM_DIR, "pending-memories.jsonl.processing")));

// 坏行重试保留：半截 JSON 不丢弃，留在队列里等修复
fs.writeFileSync(path.join(MEM_DIR, "pending-memories.jsonl"), '{"sessionId":"s-bad","kind":"fact","content":"半截\n');
await call("memory_recall", { query: "半截" });
t("坏行保留待重试", fs.existsSync(path.join(MEM_DIR, "pending-memories.jsonl")) && fs.readFileSync(path.join(MEM_DIR, "pending-memories.jsonl"), "utf8").includes("半截"));
t("坏行未入库", rows("SELECT 1 FROM memories WHERE content LIKE '%半截%'").length === 0);

// helper 不再直连写库：静态检查 extract-helper.mjs 不含 DatabaseSync
const helper = fs.readFileSync(fileURLToPath(new URL("../plugin/lib/extract-helper.mjs", import.meta.url)), "utf8");
t("helper 已无独立写库权（无 DatabaseSync/INSERT）", !helper.includes("DatabaseSync") && !/INSERT INTO/.test(helper));

console.log(`\n${pass} passed, ${fail} failed`);
await c.close();
process.exit(fail ? 1 : 0);
