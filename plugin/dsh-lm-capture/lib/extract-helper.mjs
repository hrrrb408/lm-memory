#!/usr/bin/env node
// dsh-lm-capture 提炼助手：独立进程，读任务文件 → LLM 提炼 → 直接入库 → 删任务
// 用法: node extract-helper.mjs <job.json>
// job.json: { sessionId, date, cwd, texts: [用户原始发言...] }
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const jobPath = process.argv[2];
if (!jobPath || !fs.existsSync(jobPath)) { console.error("usage: extract-helper.mjs <job.json>"); process.exit(1); }
const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
const MEM_DIR = process.env.LM_MEMORY_DIR || path.join(os.homedir(), ".lm-memory");
const DB = path.join(MEM_DIR, "memory.db");
const LOG = path.join(MEM_DIR, "log.jsonl");
const BASE = "https://open.bigmodel.cn/api/coding/paas/v4";
const MODEL = "glm-5.3-flash";
const KEY = process.env.ZAI_CODING_CN_API_KEY
  || fs.readFileSync(path.join(os.homedir(), ".dsh/.credentials.yaml"), "utf8").match(/ZAI_CODING_CN_API_KEY:\s*(\S+)/)?.[1];
if (!KEY) { console.error("no key"); process.exit(1); }

const audit = (op, data = {}) => {
  try { fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), op, by: "extract-helper", ...data }) + "\n"); } catch {}
};
const SECRET = [/sk-[A-Za-z0-9]{16,}/i, /(api[_-]?key|passwd|password|secret|bearer)\s*[:=]\s*\S{6,}/i, /(ghp|gho|xox[baprs]|AKIA)[A-Za-z0-9]{16,}/];

async function llm(prompt) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 2500, temperature: 0 }),
      });
      const t = (await r.json()).choices?.[0]?.message?.content ?? "";
      if (t) return t;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return "";
}

const transcript = job.texts.slice(0, 30).map((t, i) => `${i + 1}. ${t.slice(0, 500)}`).join("\n").slice(0, 8000);
const prompt = `以下是用户与 AI 助手的一次会话中，用户的原始发言（按顺序）：

${transcript}

从中提炼「值得跨会话记住」的持久记忆，规则：
- kind 只能是 preference(用户明确偏好)/fact(稳定事实)/procedure(带前提的经验)/todo(用户提到的事关未来的待办或承诺)
- 只提炼明确的，不推测；寒暄、临时状态、一次性问题不提炼
- 每条 content 一句原子主张，中文，≤120字，自包含（不知道会话上下文也能懂）
- todo 必须含时间线索（如"明天""下周"），并换算出绝对日期（今天是 ${job.date}）
- 最多 4 条，没有就输出空数组
- 输出纯 JSON 数组，如 [{"kind":"preference","content":"..."}]`;

const raw = await llm(prompt);
let items = [];
try { items = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? "[]"); } catch {}

const db = new DatabaseSync(DB);
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
db.exec(`CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL CHECK (kind IN ('preference','fact','episode','procedure','todo')),
  content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'agent',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','deleted')),
  supersedes INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
let inserted = 0, skipped = 0;
for (const it of items) {
  if (!it?.content || !["preference", "fact", "procedure", "todo"].includes(it.kind)) continue;
  if (SECRET.some((p) => p.test(it.content))) { audit("extract_rejected", { sessionId: job.sessionId, reason: "secret-like" }); continue; }
  const dup = db.prepare("SELECT id FROM memories WHERE status='active' AND content = ?").get(it.content);
  if (dup) { skipped++; continue; }
  const t = new Date().toISOString();
  db.prepare("INSERT INTO memories (kind, content, tags, source, status, created_at, updated_at) VALUES (?,?,?,'auto-extract','active',?,?)")
    .run(it.kind, String(it.content).slice(0, 2000), `auto,session:${job.sessionId}`, t, t);
  inserted++;
}
audit("extract_done", { sessionId: job.sessionId, llmItems: items.length, inserted, skipped });
fs.rmSync(jobPath, { force: true });
console.error(`[extract] ${job.sessionId}: ${items.length} 条提炼, ${inserted} 入库, ${skipped} 重复跳过`);
process.exit(0);
