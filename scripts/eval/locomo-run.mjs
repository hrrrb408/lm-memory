#!/usr/bin/env node
// locomo-run.mjs — LoCoMo × lm-memory 修正版 runner（v0.15.1：cat5 修入 + 源码身份固定）。
// 相对 v0.15.0 的修正（2026-11-17 复核实锤）：
//   1. cat5（adversarial）取题改用 `adversarial_answer` 字段——标准数据 446 道只有 2 道带 truthy `answer`，
//      旧 `.filter(q => q.answer)` 实际把第五类整体排除；judge 同样改用正确答案字段
//   2. startServer 内置：被测 server 硬编码为本仓库当前提交的 server/memory-server.mjs（旧版用外置
//      lib 的 startServer，其内部硬编码旧部署路径，无法保证跑的是当前提交）
//   3. 输出记录 serverPath / libPath（源码身份可追溯）；judge 原始输出逐题留档
// 口径声明：官方 cat5 计分是弃答判定（输出含 'no information available' 即得分）；本 runner 仍用统一
// LLM judge（以 adversarial_answer 为金标）并留原始输出供重判——两种口径不可混用，结果文件已标注。
// 用法: node locomo-run.mjs [对话数=3] [每类题数=5]
//   env: LM_LOCOMO_DATA=locomo10.json；LM_LOCOMO_LIB=lib.mjs（judgePrompt/glm/summarizeSessionPack/ANSWER_PROMPT_V2）；
//        LM_MEMORY_DIR 临时库目录（须通过 eval-dir-guard）；LM_LOCOMO_OUT 输出路径
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { rmEvalDir, assertSafeEvalDir } from "./eval-dir-guard.mjs";

const N_CONV = Number(process.argv[2] || 3);
const PER_CAT = Number(process.argv[3] || 5);
const OFFICIAL = { 1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial" };
const SERVER_PATH = fileURLToPath(new URL("../../server/memory-server.mjs", import.meta.url)); // 被测对象=当前提交
const DATA = process.env.LM_LOCOMO_DATA || path.join(os.homedir(), ".dsh/profiles/desktop/lm-bench/data/locomo10.json");
const LIB = process.env.LM_LOCOMO_LIB || path.join(os.homedir(), ".dsh/profiles/desktop.crashed-20261102/lm-bench/lib.mjs");
const MEM = process.env.LM_MEMORY_DIR || path.join(os.tmpdir(), "lm-bench", "tmp-locomo");
if (!fs.existsSync(DATA)) { console.error(`找不到数据文件: ${DATA}（可用 LM_LOCOMO_DATA 指定）`); process.exit(1); }
if (!fs.existsSync(LIB)) { console.error(`找不到模型库 lib.mjs: ${LIB}（可用 LM_LOCOMO_LIB 指定）`); process.exit(1); }
assertSafeEvalDir(MEM, { label: "LoCoMo 临时库" });
const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
const { judgePrompt, glm, summarizeSessionPack, ANSWER_PROMPT_V2 } = await import(LIB);

// 内置 startServer：MCP stdio 连当前提交的 server；clearAll 用 DB 直连清空（FTS 触发器联动）
async function startServer(memDir) {
  const c = new Client({ name: "locomo-run", version: "0.15.1" });
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: { ...process.env, LM_MEMORY_DIR: memDir, LM_EMBED: process.env.LM_EMBED ?? "1" },
  }));
  const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content[0].text;
  const db = new DatabaseSync(path.join(memDir, "memory.db"));
  const clearAll = () => db.exec("DELETE FROM memories"); // 触发器同步清 FTS
  return { c, call, db };
}
// cat5 金标在 adversarial_answer（标准数据无 answer 字段）；其余类别用 answer
const goldOf = (q) => String((Number(q.category) === 5 ? (q.adversarial_answer ?? q.answer) : q.answer) ?? "").trim();

const { c, call, db } = await startServer(MEM);
const t0 = Date.now();
const results = [];

for (let ci = 0; ci < N_CONV; ci++) {
  const conv = data[ci];
  clearAll();
  const sessionKeys = Object.keys(conv.conversation).filter((k) => /^session_\d+$/.test(k)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  let nTurns = 0;
  const sessTexts = [];
  for (const sk of sessionKeys) {
    const rawDT = String(conv.conversation[`${sk}_date_time`] ?? "");
    const date = (rawDT.match(/\d{1,2}\s+\w+,?\s+\d{4}/) ?? [rawDT.slice(0, 10)])[0];
    const sid = sk.replace("session_", "s");
    const lines = [];
    for (const turn of conv.conversation[sk]) {
      const text = String(turn.text ?? "").trim();
      if (text.length < 4) continue;
      const line = `${turn.speaker}: ${text.slice(0, 400)}`;
      lines.push(line);
      await call("memory_remember", { content: `[${date} ${sid}] ${line}`, kind: "episode", tags: `bench,sid:${sid},dia:${turn.dia_id}` });
      nTurns++;
    }
    if (lines.length) sessTexts.push({ sid, date, text: lines.join("\n").slice(0, 2500) });
  }
  const timeline = [];
  for (let p = 0; p < sessTexts.length; p += 3) {
    try { timeline.push(...await summarizeSessionPack(sessTexts.slice(p, p + 3))); } catch (e) { console.error("摘要失败(跳过):", e.message); }
  }
  const timelineStr = timeline.join("\n");

  const byCat = {};
  for (const q of conv.qa) (byCat[q.category] ??= []).push(q);
  for (const [cat, label] of Object.entries(OFFICIAL)) {
    const take = (byCat[cat] ?? []).filter((q) => goldOf(q)).slice(0, PER_CAT); // cat5 依赖 adversarial_answer
    for (const q of take) {
      const gold = goldOf(q);
      const raw = await call("memory_recall", { query: q.question, limit: 15 });
      let rows = []; try { rows = JSON.parse(raw); } catch {}
      const snippets = rows.map((r) => r.content).join("\n");
      const hypothesis = await glm([{ role: "user", content: ANSWER_PROMPT_V2(timelineStr, snippets, q.question) }], { maxTokens: 260 });
      const judgeRaw = await glm([{ role: "user", content: judgePrompt("single-session-user", q.question, gold, hypothesis) }], { maxTokens: 64 });
      const ok = judgeRaw.toLowerCase().includes("yes");
      let turnCov = null;
      if (q.evidence?.length) {
        const got = new Set(rows.map((r) => r.tags.match(/dia:([^,]+)/)?.[1]).filter(Boolean));
        turnCov = q.evidence.filter((d) => got.has(String(d))).length / q.evidence.length;
      }
      results.push({ conv: conv.sample_id, category: Number(cat), catLabel: label, ok, judgeRaw: judgeRaw.slice(0, 300), turnCov, q: q.question.slice(0, 200), hypothesis: hypothesis.slice(0, 400), answer: gold.slice(0, 200) });
      console.log(`${ok ? "✅" : "❌"} [conv${ci + 1} ${label}] turnCov=${turnCov === null ? "-" : turnCov.toFixed(2)} | ${hypothesis.slice(0, 66).replace(/\n/g, " ")}`);
    }
  }
  console.log(`—— 对话${ci + 1} 完成（${nTurns} turns）`);
}

const acc = (a) => (a.length ? a.filter(Boolean).length / a.length : null);
const byCatR = {};
for (const r of results) (byCatR[r.catLabel] ??= []).push(r);
console.log(`\n===== LoCoMo（前${N_CONV}段 · 官方类别映射 · v0.15.1 runner） =====`);
const outByCat = {};
for (const [k, arr] of Object.entries(byCatR)) {
  const a = acc(arr.map((r) => r.ok));
  outByCat[k] = { n: arr.length, correct: arr.filter((r) => r.ok).length, accuracy: a == null ? null : +a.toFixed(3) };
  console.log(`  ${k.padEnd(12)} ${outByCat[k].correct}/${arr.length} = ${a?.toFixed(3)}`);
}
if (!byCatR.adversarial) console.log("  adversarial 0 题（数据中无带 adversarial_answer 的 cat5 题进入本轮）");
const overall = acc(results.map((r) => r.ok));
const covs = results.map((r) => r.turnCov).filter((v) => v !== null);
const ev = covs.length ? { questions: covs.length, anyHitRate: +(covs.filter((v) => v > 0).length / covs.length).toFixed(4), meanCoverage: +(covs.reduce((s, v) => s + v, 0) / covs.length).toFixed(4), fullHitRate: +(covs.filter((v) => v === 1).length / covs.length).toFixed(4) } : null;
console.log(`  总正确率: ${overall?.toFixed(3)} (${results.length} 题)`);
if (ev) console.log(`  证据覆盖率: 任一命中 ${ev.anyHitRate} · 真均值 ${ev.meanCoverage} · 全齐 ${ev.fullHitRate}（${ev.questions} 题带标注）`);
console.log(`  注意: judge/答题同一模型；cat5 采用 LLM judge（金标=adversarial_answer），与官方弃答判定口径不同；本分数无跨系统排名资格`);
const outFile = process.env.LM_LOCOMO_OUT || path.join(os.tmpdir(), "lm-bench", `result-LoCoMo-official-${new Date().toISOString().slice(0, 10)}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({
  benchmark: "LoCoMo-official-mapping", runner: "scripts/eval/locomo-run.mjs", runnerVersion: "0.15.1",
  serverPath: SERVER_PATH, libPath: LIB, dataPath: DATA, // 源码身份
  scoringNote: "cat5 gold=adversarial_answer, LLM judge (includes yes); official cat5 metric is abstention-based — 不混用",
  overall, byCat: outByCat, evidence: ev, n: results.length, results,
}, null, 1));
console.log(`  结果: ${outFile}（含每题原始 category id、金标来源与 judge 原始输出）`);
await c.close();
process.exit(0);
