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
const audit = (op, data = {}) => {
  try { fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), op, by: "extract-helper", ...data }) + "\n"); } catch {}
};

// LLM 选择优先级：llm 块显式 model（用户接管） > 会话真实模型（provider 可映射时整体跟随） > env > 默认 glm-5.3-flash
// key 解析：apiKeyEnv 环境变量 → ~/.dsh/.credentials.yaml 同名条目
const PROVIDER_MAP = {
  "zai-coding-cn": { baseURL: "https://open.bigmodel.cn/api/coding/paas/v4", apiKeyEnv: "ZAI_CODING_CN_API_KEY" },
  "deepseek-official": { baseURL: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" },
  "deepseek-api-key": { baseURL: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" },
  "agnes": { baseURL: "https://apihub.agnes-ai.com/v1", apiKeyEnv: "AGNES_API_KEY" },
};
const SESS = job.sessionModel && PROVIDER_MAP[job.sessionModel.provider] ? job.sessionModel : null;
let BASE, MODEL, KEY_ENV, MODEL_SRC;
if (job.llm?.model) {
  MODEL = job.llm.model; MODEL_SRC = "config";
  BASE = job.llm.baseURL || process.env.LM_LLM_BASE || PROVIDER_MAP["zai-coding-cn"].baseURL;
  KEY_ENV = job.llm.apiKeyEnv || "ZAI_CODING_CN_API_KEY";
} else if (SESS) {
  MODEL = SESS.model; MODEL_SRC = `session(${SESS.provider})`;
  BASE = PROVIDER_MAP[SESS.provider].baseURL;
  KEY_ENV = PROVIDER_MAP[SESS.provider].apiKeyEnv;
} else {
  MODEL = process.env.LM_LLM_MODEL || "glm-5.3-flash"; MODEL_SRC = job.sessionModel ? `default(session provider ${job.sessionModel.provider} 不可映射)` : "default";
  BASE = process.env.LM_LLM_BASE || PROVIDER_MAP["zai-coding-cn"].baseURL;
  KEY_ENV = "ZAI_CODING_CN_API_KEY";
}
console.error(`[extract] LLM: ${MODEL} @ ${BASE.replace(/^https?:\/\//, "").split("/")[0]} (来源: ${MODEL_SRC})`);
let KEY = process.env[KEY_ENV];
if (!KEY) {
  try {
    KEY = fs.readFileSync(path.join(os.homedir(), ".dsh/.credentials.yaml"), "utf8")
      .match(new RegExp(KEY_ENV + ":\\s*(\\S+)"))?.[1];
  } catch {}
}
if (!KEY) { // 无 key：优雅降级——跳过提炼（检索不受影响），不留死任务
  audit("extract_skipped_no_key", { sessionId: job.sessionId, model: MODEL, keyEnv: KEY_ENV });
  fs.rmSync(jobPath, { force: true });
  console.error(`[extract] ${job.sessionId}: 无 ${KEY_ENV}（env 或 ~/.dsh/.credentials.yaml），跳过 LLM 提炼`);
  process.exit(0);
}

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
- 【纠错语境】用户后文否定、更正过的事实，必须按最终表述提炼或直接跳过（例如"学生，中南大学"后面若出现"我是帮别人查的"，绝不能提炼成用户本人是中南大学的）
- 拿不准主体归属（是用户本人还是提到的人/朋友）时，宁可不提炼
- 每条 content 一句原子主张，中文，≤120字，自包含（不知道会话上下文也能懂）
- todo 必须含时间线索（如"明天""下周"）
- 任何条目出现相对时间（昨天/上周/上个月等）都换算出绝对日期（今天是 ${job.date}）——bench 实测：相对时间不锚定是 multi-hop/时间题的最大失分源
- 最多 4 条，没有就输出空数组
- 输出纯 JSON 数组，如 [{"kind":"preference","content":"..."}]`;

const raw = await llm(prompt);
let items = [];
try { items = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? "[]"); } catch {}

// —— 会话摘要卡（v0.9）：1-2 句带日期感的自包含总结，作为 episode 入库 ——
// 作用：为跨会话联合与时间线推理提供 session 粒度上下文（bench 验证：时间推理 0.60→1.00）
const summaryPrompt = `以下是用户与 AI 助手的一次会话中，用户的原始发言（按顺序）：

${transcript}

用 1-2 句中文总结这次会话：做了什么、决定了什么、关键结果。要求：
- 自包含（不知道上下文也能懂），≤100 字
- 保留人名/项目名/数字/日期等实体
- 相对时间（昨天/上周/明天等）必须换算成绝对日期再写入（以会话日期 ${job.date} 为锚）
- 直接输出总结正文，不要任何前缀、引号或解释`;
let summary = "";
try { summary = (await llm(summaryPrompt)).trim().replace(/^["'「『]|["'」』]$/g, "").slice(0, 500); } catch {}
let summaryInserted = false;

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
if (summary && !SECRET.some((p) => p.test(summary))) {
  const dupSum = db.prepare("SELECT id FROM memories WHERE status != 'deleted' AND tags LIKE 'summary,%' AND tags LIKE ?").get(`%session:${job.sessionId}%`);
  const dupContent = db.prepare("SELECT id FROM memories WHERE status='active' AND content = ?").get(summary);
  if (!dupSum && !dupContent) {
    const ts = new Date().toISOString();
    db.prepare("INSERT INTO memories (kind, content, tags, source, status, created_at, updated_at) VALUES ('episode',?,?,'auto-extract','active',?,?)")
      .run(`会话摘要 ${job.date}：${summary}`, `summary,session:${job.sessionId}`, ts, ts);
    summaryInserted = true;
  }
}
audit("extract_done", { sessionId: job.sessionId, llmItems: items.length, inserted, skipped, summary: summaryInserted ? 1 : 0 });
fs.rmSync(jobPath, { force: true });
console.error(`[extract] ${job.sessionId}: ${items.length} 条提炼, ${inserted} 入库, ${skipped} 重复跳过`);
process.exit(0);
