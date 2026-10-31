#!/usr/bin/env node
// 记忆系统周检：库状态、队列积压、噪音率、错误扫描、体积增长
// 用法: node health-check.mjs [LM_MEMORY_DIR=~/.dsh/memory]
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dir = process.argv[2] || process.env.LM_MEMORY_DIR || path.join(os.homedir(), ".dsh", "memory");
const db = new DatabaseSync(path.join(dir, "memory.db"), { readOnly: true });

const active = db.prepare("SELECT kind, count(*) n FROM memories WHERE status='active' GROUP BY kind").all();
const counts = Object.fromEntries(active.map((r) => [r.kind, r.n]));
const totalActive = active.reduce((a, r) => a + r.n, 0);
const superseded = db.prepare("SELECT count(*) n FROM memories WHERE status='superseded'").get().n;
const deleted = db.prepare("SELECT count(*) n FROM memories WHERE status='deleted'").get().n;
const lastWeek = db.prepare("SELECT count(*) n FROM memories WHERE status='active' AND updated_at > datetime('now', '-7 days')").get().n;

let pending = 0, pendingAge = "-";
try {
  const st = fs.statSync(path.join(dir, "pending-episodes.jsonl"));
  pending = fs.readFileSync(path.join(dir, "pending-episodes.jsonl"), "utf8").split("\n").filter(Boolean).length;
  if (pending) pendingAge = `${Math.round((Date.now() - st.mtimeMs) / 3600000)}h`;
} catch {}

let errors7d = [];
try {
  errors7d = fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && /error|failed|rejected|malformed/i.test(JSON.stringify(r)) && r.ts > new Date(Date.now() - 7 * 864e5).toISOString());
} catch {}

// 噪音率粗估：auto-capture episode 占比
const episodes = counts.episode ?? 0;
const noiseRatio = totalActive ? (episodes / totalActive) : 0;
const dbMB = (fs.statSync(path.join(dir, "memory.db")).size / 1048576).toFixed(1);

console.log(`══════ 记忆系统体检（${new Date().toISOString().slice(0, 16)}）══════`);
console.log(`记忆总数: ${totalActive}（${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" ")}）`);
console.log(`近 7 天新增: ${lastWeek} | 历史: superseded ${superseded}, deleted ${deleted}`);
console.log(`待处理队列: ${pending} 条 ${pending ? `（积压 ${pendingAge}）` : "✓"}`);
console.log(`episode 占比: ${(noiseRatio * 100).toFixed(0)}%${noiseRatio > 0.6 ? " ⚠️ 噪音偏高，考虑清理" : ""}`);
console.log(`库体积: ${dbMB}MB`);
console.log(`近 7 天错误/拦截: ${errors7d.length} 条`);
for (const e of errors7d.slice(-3)) console.log(`  - ${e.ts?.slice(0, 16)} ${e.op} ${JSON.stringify(e).slice(60, 140)}`);
console.log(pending > 5 ? "⚠️ 队列积压：MCP server 下次启动会消化，若持续积压喊 agent 检查" : "\n结论: 健康 ✓");
