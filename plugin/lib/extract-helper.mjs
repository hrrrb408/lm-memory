#!/usr/bin/env node
// dsh-lm-capture 提炼助手 v0.15：独立进程，读任务文件 → LLM 提炼 → 产出候选 → 删任务。
// v0.15 结构性变更（外审 §5）：本进程不再拥有任何数据库写权限——
// 旧版直连 SQLite INSERT（旧 schema、无凭据拦截、无嵌入/current.md/热流/图谱），
// 与 MCP 写入口行为不一致。现在只把候选追加到 pending-memories.jsonl，
// 由 lm-memory server 的统一提交入口（commitMemoryTx）消费：凭据拦截、查重、
// 嵌入、索引、图谱、热流全部同路径。
// job.json: { sessionId, date, cwd, texts: [用户原始发言...], llm?, sessionModel? }
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { checkSecret, filterTextsForLLM } from "../../server/guards.mjs";

const jobPath = process.argv[2];
if (!jobPath || !fs.existsSync(jobPath)) { console.error("usage: extract-helper.mjs <job.json>"); process.exit(1); }
const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
const MEM_DIR = process.env.LM_MEMORY_DIR || path.join(os.homedir(), ".lm-memory");
const LOG = path.join(MEM_DIR, "log.jsonl");
const CANDIDATES = path.join(MEM_DIR, "pending-memories.jsonl");
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

// —— v0.15 外发前防线（单一事实源 server/guards.mjs）：剔除「别记」消息、脱敏疑似凭据消息。
// 修复外审实锤：「原始文本先写 job → 直接进远程 prompt，SECRET 正则只查输出」。
const filt = filterTextsForLLM(job.texts || [], (op, d) => audit(op, d));
const texts = filt.texts;
if (filt.dropped || filt.redacted) audit("extract_input_filtered", { sessionId: job.sessionId, dropped: filt.dropped, redacted: filt.redacted });
if (!texts.length) { audit("extract_skipped_all_filtered", { sessionId: job.sessionId }); fs.rmSync(jobPath, { force: true }); process.exit(0); }

// —— v0.15 窗口策略：尾部优先。修复外审实锤「只读前 30 条，末尾纠正早先说法完全不进上下文」：
// 预算内从最新往回收集，保证末尾（含最终纠正）在场；头部保留首条做背景；中间省略并显式标注。
function pickWindow(arr, budget = 8000, per = 500) {
  const items = arr.map((t, i) => ({ i, t: String(t).slice(0, per) }));
  if (!items.length) return "";
  const kept = [];
  let used = 0;
  for (let j = items.length - 1; j >= 0; j--) {
    const cost = items[j].t.length + 8;
    if (used + cost > budget && kept.length) break;
    kept.unshift(items[j]); used += cost;
  }
  if (kept[0] && kept[0].i !== 0 && used + items[0].t.length + 8 <= budget + 500) { kept.unshift(items[0]); used += items[0].t.length + 8; } // 头部背景
  const parts = [];
  let prev = null;
  for (const k of kept) {
    if (prev !== null && k.i > prev + 1) parts.push(`……（第 ${prev + 2}-${k.i} 条省略）……`);
    parts.push(`${k.i + 1}. ${k.t}`);
    prev = k.i;
  }
  return parts.join("\n");
}
const transcript = pickWindow(texts);
const prompt = `以下是用户与 AI 助手的一次会话中，用户的原始发言（按顺序编号，中间可能有省略标注）：

${transcript}

从中提炼「值得跨会话记住」的持久记忆，规则：
- kind 只能是 preference(用户明确偏好)/fact(稳定事实)/procedure(带前提的经验)/todo(用户提到的事关未来的待办或承诺)
- 只提炼明确的，不推测；寒暄、临时状态、一次性问题不提炼
- 【纠错语境】用户后文否定、更正过的事实，必须按最终表述提炼或直接跳过（例如"学生，中南大学"后面若出现"我是帮别人查的"，绝不能提炼成用户本人是中南大学的）——若被省略的中间内容可能有纠正，以编号靠后的说法为准
- 拿不准主体归属（是用户本人还是提到的人/朋友）时，宁可不提炼
- 每条 content 一句原子主张，中文，≤120字，自包含（不知道会话上下文也能懂）
- todo 必须含时间线索（如"明天""下周"）
- 任何条目出现相对时间（昨天/上周/上个月等）都换算出绝对日期（今天是 ${job.date}）——相对时间不锚定是时间类问题的最大失分源
- 最多 4 条，没有就输出空数组
- 输出纯 JSON 数组，如 [{"kind":"preference","content":"..."}]`;

const raw = await llm(prompt);
let items = [];
try { items = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? "[]"); } catch {}

// —— 会话摘要卡（v0.9）：1-2 句带日期感的自包含总结，作为 episode 候选入库 ——
const summaryPrompt = `以下是用户与 AI 助手的一次会话中，用户的原始发言（按顺序编号，中间可能有省略标注）：

${transcript}

用 1-2 句中文总结这次会话：做了什么、决定了什么、关键结果。要求：
- 自包含（不知道上下文也能懂），≤100 字
- 保留人名/项目名/数字/日期等实体
- 相对时间（昨天/上周/明天等）必须换算成绝对日期再写入（以会话日期 ${job.date} 为锚）
- 直接输出总结正文，不要任何前缀、引号或解释`;
let summary = "";
try { summary = (await llm(summaryPrompt)).trim().replace(/^["'「『]|["'」』]$/g, "").slice(0, 500); } catch {}

// —— 产出候选（不碰库）：追加 pending-memories.jsonl，server 统一提交入口消费。
// 事件锚 eventDate=会话日期（job.date）；凭据模式在出队前再拦一道（防御纵深，与 server 同源）。
const appendCandidate = (rec) => { try { fs.appendFileSync(CANDIDATES, JSON.stringify(rec) + "\n"); return true; } catch { return false; } };
let candidates = 0, rejected = 0;
for (const it of items) {
  if (!it?.content || !["preference", "fact", "procedure", "todo"].includes(it.kind)) continue;
  if (checkSecret(it.content)) { rejected++; audit("extract_rejected", { sessionId: job.sessionId, reason: "secret-like" }); continue; }
  if (appendCandidate({ sessionId: job.sessionId, date: job.date, kind: it.kind, content: String(it.content).slice(0, 2000), tags: `auto,session:${job.sessionId}`, capturedAt: new Date().toISOString(), eventDate: job.date })) candidates++;
}
let summaryQueued = false;
if (summary && !checkSecret(summary)) {
  summaryQueued = appendCandidate({ sessionId: job.sessionId, date: job.date, kind: "episode", content: `会话摘要 ${job.date}：${summary}`, tags: `summary,session:${job.sessionId}`, capturedAt: new Date().toISOString(), eventDate: job.date });
  if (summaryQueued) candidates++;
}
audit("extract_done", { sessionId: job.sessionId, llmItems: items.length, candidates, rejected, summary: summaryQueued ? 1 : 0, filteredIn: texts.length, filteredOut: (job.texts || []).length - texts.length });
fs.rmSync(jobPath, { force: true });
console.error(`[extract] ${job.sessionId}: ${items.length} 条提炼, ${candidates} 候选入队, ${rejected} 凭据拒收`);
process.exit(0);
