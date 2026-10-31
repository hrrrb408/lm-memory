#!/usr/bin/env node
// 闭环测评：记忆是否让 agent 的回答真正变好
// 对照：A=无记忆裸答  B=memory_recall 证据注入后作答；glm-5.3-flash 三方判卷（金标盲评）
// 用法: node closed-loop.mjs [题数=30] [/tmp/longmemeval_s]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] || 30);
const DATA = process.argv[3] || "/tmp/longmemeval_s";
const SERVER = path.join(__dirname, "../../server/memory-server.mjs");
const BASE = "https://open.bigmodel.cn/api/coding/paas/v4";
const MODEL = "glm-5.3-flash";
const KEY = process.env.ZAI_CODING_CN_API_KEY || fs.readFileSync(path.join(os.homedir(), ".dsh/.credentials.yaml"), "utf8").match(/ZAI_CODING_CN_API_KEY:\s*(\S+)/)?.[1];

async function llm(prompt, maxTokens = 300) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0 }),
      });
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content ?? "";
      if (text) return text;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  return "";
}

const all = JSON.parse(fs.readFileSync(DATA, "utf8"));
const items = all.slice(0, N);
console.log(`闭环测评：${items.length} 题 × 2 条件 × ${MODEL} 判卷\n`);

const results = [];
for (let i = 0; i < items.length; i++) {
  const item = items[i];
  // 1) 建库 + 检索证据
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-loop-"));
  let evidence = [], evidenceHit = false;
  try {
    const client = new Client({ name: "loop", version: "0.1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, LM_MEMORY_DIR: dir } }));
    const call = (n, a) => client.callTool({ name: n, arguments: a }).then((r) => r.content[0].text);
    const dates = item.haystack_dates ?? [], ids = item.haystack_session_ids ?? [];
    const CHUNK = 1800, OVERLAP = 300;
    for (let s = 0; s < (item.haystack_sessions?.length ?? 0); s++) {
      const text = (item.haystack_sessions[s] ?? []).map((t) => `${t.role}: ${t.content}`).join("\n");
      const tag = String(ids[s] ?? `s${s}`);
      for (let c = 0; c < text.length; c += CHUNK - OVERLAP) {
        const piece = text.slice(c, c + CHUNK);
        if (piece.trim().length >= 20) await call("memory_remember", { content: `会话 ${dates[s] ?? ""}｜${piece}`, kind: "episode", tags: `lmeval,${tag}` });
      }
    }
    const raw = await call("memory_recall", { query: item.question, limit: 5 });
    try { const p = JSON.parse(raw); if (Array.isArray(p)) evidence = p; } catch {}
    const goldTags = new Set((item.answer_session_ids ?? []).map(String));
    evidenceHit = evidence.some((h) => String(h.tags ?? "").split(",").some((t) => goldTags.has(t)));
    await client.close();
  } catch {} finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const Q = `问题：${item.question}\n（无法确定时只回答 UNKNOWN）`;
  const ctx = evidence.length
    ? `以下是检索到的记忆片段（可能无关，自行取舍）：\n\n${evidence.map((e, k) => `[片段${k + 1}] ${e.content.slice(0, 1800)}`).join("\n\n")}\n\n${Q}`
    : `（检索无结果）\n\n${Q}`;
  const [ansA, ansB] = await Promise.all([
    llm(`用一句英文或UNKNOWN直接回答，不要解释。\n\n${Q}`),
    llm(`先从片段中找出包含答案的句子（内部引用，不输出），再用一句英文或UNKNOWN直接回答，不要解释。\n\n${ctx}`),
  ]);
  const judgeRaw = await llm(`金标答案：${item.answer}\n回答A（无记忆）：${ansA || "(空)"}\n回答B（带记忆检索）：${ansB || "(空)"}\n\n分别判定 A 和 B 与金标是否一致。只输出 JSON：{"A":"correct|partial|wrong","B":"correct|partial|wrong"}`, 120);
  const pick = (m) => (m && m[1] ? m[1] : "wrong");
  const verdict = {
    A: pick(judgeRaw.match(/"A"\s*:\s*"(correct|partial|wrong)"/i)),
    B: pick(judgeRaw.match(/"B"\s*:\s*"(correct|partial|wrong)"/i)),
  };
  results.push({ q: item.question.slice(0, 60), type: item.question_type, gold: item.answer, ansA: ansA.slice(0, 80), ansB: ansB.slice(0, 80), A: verdict.A, B: verdict.B, evidenceHit });
  const done = results.length;
  console.log(`[${done}/${items.length}] ${verdict.A}/${verdict.B} ev=${evidenceHit ? "✓" : "✗"} ${item.question.slice(0, 40)}`);
}

const score = (v) => (v === "correct" ? 1 : v === "partial" ? 0.5 : 0);
const accA = results.reduce((a, r) => a + score(r.A), 0) / results.length;
const accB = results.reduce((a, r) => a + score(r.B), 0) / results.length;
const evHit = results.filter((r) => r.evidenceHit).length / results.length;
const evAndB = results.filter((r) => r.evidenceHit && score(r.B) > 0).length / Math.max(1, results.filter((r) => r.evidenceHit).length);
console.log(`\n══════ 闭环测评（${items.length} 题）══════`);
console.log(`无记忆裸答 A 准确率: ${(accA * 100).toFixed(1)}%`);
console.log(`带记忆检索 B 准确率: ${(accB * 100).toFixed(1)}%`);
console.log(`记忆带来的增量: ${((accB - accA) * 100).toFixed(+1)} 个百分点`);
console.log(`证据命中率: ${(evHit * 100).toFixed(0)}% | 命中证据时 B 答对率: ${(evAndB * 100).toFixed(0)}%`);
fs.writeFileSync(path.join(__dirname, "closed-loop-report.json"), JSON.stringify({ n: items.length, accA, accB, evHit, evAndB, results }, null, 2));
console.log("明细已存: scripts/eval/closed-loop-report.json");
process.exit(0);
