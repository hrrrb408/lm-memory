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
import { createHash } from "node:crypto";
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
// v0.16.4（第十一轮复核实锤：无 key 的提前返回在禁外发检查之前 → 禁外发+无 key 时 job 被删）：
// 禁外发检查必须排在所有可能删除任务的提前返回之前——保留 job，恢复远程后可重跑。
if (process.env.LM_REMOTE_DISABLED === "1") {
  audit("extract_skipped_remote_disabled", { sessionId: job.sessionId, model: MODEL });
  console.error(`[extract] ${job.sessionId}: LM_REMOTE_DISABLED=1，跳过外呼（job 保留）`);
  process.exit(0);
}
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
// v0.16.3 网络入口防守（第十轮复核实锤：禁外发开关曾被通知入口绕过）：任何 spawn 路径拉起的 helper
// 都在这里兜底——禁外发时不外呼、保留 job（恢复远程后可重跑），绝不因上游漏检而发请求。
// （v0.16.4：本检查已前移到无 key 等提前返回之前，此处保留注释说明语义。）

async function llm(prompt) {
  // v0.16 失败感知（第七轮外审实锤：LLM 连续失败返回空串 → items=[] → exit 0 删任务 = 永久漏记）：
  // 失败返回 null（与「成功返回空内容」严格区分），调用方必须将 null 视为任务失败保留重跑。
  // v0.16.1（第八轮复核实锤：HTTP 200 + finish_reason=length + 截断 JSON 被当成功）：
  // finish_reason=length 的输出对纯 JSON 提炼是坏输出 → 同样按失败处理（重试后仍坏 → null）。
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 2500, temperature: 0 }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const ch = j?.choices?.[0];
      if (!ch) throw new Error("no choices");
      if (ch.finish_reason === "length") throw new Error("finish_reason=length (truncated)"); // 截断输出不可信
      if (typeof ch.message?.content === "string") return ch.message.content; // 空串也是合法响应（模型判空）
      throw new Error("no content");
    } catch {}
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return null; // 3 次重试后仍失败
}
// 任务失败：保留 job 文件（server 孤儿回收会重跑；幂等由候选 eid 保证）+ 非零退出。
// 覆盖：LLM 调用失败 / rev 写回失败 / 候选入队失败——绝不把「没提炼成」伪装成「成功跑完」（第七轮外审 §4）。
const failJob = (op, detail) => {
  audit(op, { sessionId: job.sessionId, ...detail });
  console.error(`[extract] ${job.sessionId}: ${op} ${JSON.stringify(detail)} —— job 保留待重跑`);
  process.exit(1);
};

// —— v0.15 外发前防线（单一事实源 server/guards.mjs）：剔除「别记」消息、脱敏疑似凭据消息。
// 修复外审实锤：「原始文本先写 job → 直接进远程 prompt，SECRET 正则只查输出」。
const filt = filterTextsForLLM(job.texts || [], (op, d) => audit(op, d));
const texts = filt.texts;
if (filt.dropped || filt.redacted) audit("extract_input_filtered", { sessionId: job.sessionId, dropped: filt.dropped, redacted: filt.redacted });
if (!texts.length) { audit("extract_skipped_all_filtered", { sessionId: job.sessionId }); fs.rmSync(jobPath, { force: true }); process.exit(0); }

// —— v0.16 窗口策略：先选窗、后截断（第七轮外审实锤：旧版先对每条取前 500 字再选窗，
// 尾部纠正若落在单条 500 字之后照样丢失）。预算按原文长度从最新往回收，保证末尾在场；
// 选中条目的截断保两头（头 400 + 尾 800）——纠正语境常在尾部；头部保留首条做背景；中间省略显式标注。
function clipTwoEnds(t, head = 400, tail = 800) {
  const s = String(t);
  return s.length <= head + tail ? s : `${s.slice(0, head)}……（中段省略）……${s.slice(-tail)}`;
}
function pickWindow(arr, budget = 8000) {
  const items = arr.map((t, i) => ({ i, len: String(t).length }));
  if (!items.length) return "";
  const kept = [];
  let used = 0;
  for (let j = items.length - 1; j >= 0; j--) {
    const cost = items[j].len + 8;
    if (used + cost > budget && kept.length) break;
    kept.unshift(items[j]); used += cost;
  }
  if (kept[0] && kept[0].i !== 0 && used + items[0].len + 8 <= budget + 500) { kept.unshift(items[0]); used += items[0].len + 8; } // 头部背景
  const parts = [];
  let prev = null;
  for (const k of kept) {
    if (prev !== null && k.i > prev + 1) parts.push(`……（第 ${prev + 2}-${k.i} 条省略）……`);
    parts.push(`${k.i + 1}. ${clipTwoEnds(arr[k.i])}`);
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
if (raw === null) failJob("extract_llm_failed", { stage: "facts" }); // v0.16：LLM 失败≠空结果，任务保留重跑
if (raw.trim() === "") failJob("extract_llm_bad_output", { stage: "facts", reason: "empty-content" }); // v0.16.1：空串对「输出 JSON 数组」的 prompt 是坏输出（合法空 = "[]"）
const arrMatch = raw.match(/\[[\s\S]*\]/);
if (!arrMatch) failJob("extract_llm_bad_output", { stage: "facts", reason: "no-json-array" }); // 截断/非 JSON 输出（复核实锤曾当成功）
let items;
try { items = JSON.parse(arrMatch[0]); } catch (e) { failJob("extract_llm_bad_output", { stage: "facts", reason: "json-parse-failed" }); }
if (!Array.isArray(items)) failJob("extract_llm_bad_output", { stage: "facts", reason: "not-array" }); // 条目级 schema 在入队循环校验（无效条目忽略，数组本身必须合法）

// —— 会话摘要卡（v0.9）：1-2 句带日期感的自包含总结，作为 episode 候选入库 ——
const summaryPrompt = `以下是用户与 AI 助手的一次会话中，用户的原始发言（按顺序编号，中间可能有省略标注）：

${transcript}

用 1-2 句中文总结这次会话：做了什么、决定了什么、关键结果。要求：
- 自包含（不知道上下文也能懂），≤100 字
- 保留人名/项目名/数字/日期等实体
- 相对时间（昨天/上周/明天等）必须换算成绝对日期再写入（以会话日期 ${job.date} 为锚）
- 直接输出总结正文，不要任何前缀、引号或解释`;
let summary = "";
{
  const s = await llm(summaryPrompt);
  if (s === null) failJob("extract_llm_failed", { stage: "summary" }); // 摘要失败同样保留重跑（提炼候选 eid 幂等，重跑不重复入库）
  summary = s.trim().replace(/^["'「『]|["'」』]$/g, "").slice(0, 500); // 空串=模型判无摘要，合法（零候选终态）
}

// —— 产出候选（不碰库）：追加 pending-memories.jsonl，server 统一提交入口消费。
// v0.15.3 身份连续性（复核实锤：旧 job 重跑换新 eid+刷新时间 → 退回新摘要）：
//   rev   = job 创建时固定的来源 revision（派发方写入；旧 job 缺失时兜底为当前时间）
//   eid   = sha256(sessionId|rev|kind|content) 确定性派生——同一 job 重跑、LLM 输出不变 → 同一 eid，
//           server 侧 meta 记录直接丢弃；LLM 输出变了 → eid 变，但 rev 更旧，版本序约束仍然拦下
//   capturedAt = rev（版本序锚=派发时间，非提炼完成时间）；extractedAt = 完成时间仅审计
// 凭据模式出队前再拦一道（防御纵深，与 server 同源）。
// v0.15.4 升级兼容（第五轮复核实锤：兜底时间戳不写回 → 旧 job 每次重跑换身份+换时间，仍会退回新摘要）：
// 无 rev 的旧任务首次运行即把迁移 revision 写回 job 文件——此后重跑与新格式 job 等价（身份稳定）。
// 写回失败（权限等）降级为内存 rev：本次运行身份仍一致，重跑可能换身份（旧格式边界，见 README）。
let JOB_REV = job.rev;
if (!JOB_REV) {
  JOB_REV = new Date().toISOString();
  // v0.16（第六轮收尾验收边界收口）：写回失败不再降级内存身份——保留 job + 失败退出，
  // 下次运行重新尝试写回（复核实锤：内存身份重跑即换，不是安全恢复）。
  try { fs.writeFileSync(jobPath, JSON.stringify({ ...job, rev: JOB_REV })); }
  catch (e) { failJob("extract_rev_writeback_failed", { error: String(e.message || e).slice(0, 80) }); }
}
const candEid = (kind, content) => "h-" + createHash("sha256").update(`${job.sessionId}|${JOB_REV}|${kind}|${content}`).digest("hex").slice(0, 24);
const appendCandidate = (kind, content, tags) => {
  const eid = candEid(kind, content);
  try {
    fs.appendFileSync(CANDIDATES, JSON.stringify({ eid, sessionId: job.sessionId, date: job.date, kind, content: String(content).slice(0, 2000), tags, capturedAt: JOB_REV, extractedAt: new Date().toISOString(), eventDate: job.date }) + "\n");
    producedEids.push(eid);
    return true;
  } catch (e) { console.error(`[extract] candidate enqueue failed: ${e.message}`); return false; }
};
const producedEids = []; // v0.16.1 任务交接：receipt 向 server 声明「本任务产出的全部候选 eid」，done 以全部处置完毕为准
let candidates = 0, rejected = 0, enqueueFailed = 0;
for (const it of items) {
  if (!it?.content || !["preference", "fact", "procedure", "todo"].includes(it.kind)) continue;
  if (checkSecret(it.content)) { rejected++; audit("extract_rejected", { sessionId: job.sessionId, reason: "secret-like" }); continue; }
  if (appendCandidate(it.kind, it.content, `auto,session:${job.sessionId}`)) candidates++;
  else enqueueFailed++;
}
let summaryQueued = false;
if (summary && !checkSecret(summary)) {
  summaryQueued = appendCandidate("episode", `会话摘要 ${job.date}：${summary}`, `summary,session:${job.sessionId}`);
  if (summaryQueued) candidates++; else enqueueFailed++;
}
audit("extract_done", { sessionId: job.sessionId, llmItems: items.length, candidates, rejected, enqueueFailed, summary: summaryQueued ? 1 : 0, filteredIn: texts.length, filteredOut: (job.texts || []).length - texts.length });
if (enqueueFailed > 0) { // 未安全落盘的候选：保留 job 供重跑，非零退出（绝不假装成功）
  failJob("extract_enqueue_failed_job_preserved", { enqueueFailed });
}
// —— v0.16.1 任务回执：向 server 声明本任务的候选交接清单（全部 eid / 零候选）。
// server 的 settleLedger 以「清单内全部 eid 已处置（meta 在场）」为 done 条件——
// 修复复核实锤「任意一条候选成功就 done」；零候选任务由此获得明确终态（不再无账本记录）。
const safeName = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
const receiptsDir = path.join(MEM_DIR, "extraction-jobs", "receipts");
try {
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.writeFileSync(path.join(receiptsDir, `${safeName(job.sessionId)}-${safeName(JOB_REV)}.json`),
    JSON.stringify({ sessionId: job.sessionId, revision: JOB_REV, eids: producedEids, at: new Date().toISOString() }));
} catch (e) { failJob("extract_receipt_write_failed", { error: String(e.message || e).slice(0, 80) }); } // 回执写失败=任务未交接，保留重跑（候选 eid 幂等）
fs.rmSync(jobPath, { force: true });
console.error(`[extract] ${job.sessionId}: ${items.length} 条提炼, ${candidates} 候选入队, ${rejected} 凭据拒收`);
process.exit(0);
