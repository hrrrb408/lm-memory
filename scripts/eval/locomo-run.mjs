#!/usr/bin/env node
// locomo-run.mjs — LoCoMo × lm-memory 修正版 runner（v0.15 入库，取代外置 crashed profile 的 run-locomo.mjs）。
// 相对旧版的修正（2026-11-17 外审逐条对应）：
//   1. 官方类别映射 {1:multi-hop,2:temporal,3:open-domain,4:single-hop,5:adversarial}（evaluation.py / snap-research#29），
//      每题结果同时保存原始 category id——以后任何重聚合都不再依赖可逆反解
//   2. adversarial（cat5）进入测试循环（官方口径是弃答判定，本 runner 仍用统一 LLM judge 并留原始输出供重判）
//   3. judge 原始输出逐题留档（旧版 includes('yes') 解析脆弱且无法追溯重判）
//   4. 数据与临时库路径参数化 + eval-dir-guard（绝不 rmSync 生产目录）
//   5. 汇总含覆盖率三口径（任一命中/真均值/全齐），不再用 filter(Boolean) 平均数值
// 用法: node locomo-run.mjs [对话数=3] [每类题数=5]
//   env: LM_LOCOMO_DATA=locomo10.json 路径；LM_MEMORY_DIR 临时库目录（须通过 eval-dir-guard）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmEvalDir, assertSafeEvalDir } from "./eval-dir-guard.mjs";

const N_CONV = Number(process.argv[2] || 3);
const PER_CAT = Number(process.argv[3] || 5);
const OFFICIAL = { 1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial" };
const DATA = process.env.LM_LOCOMO_DATA || path.join(os.homedir(), ".dsh/profiles/desktop/lm-bench/data/locomo10.json");
const MEM = process.env.LM_MEMORY_DIR || path.join(os.tmpdir(), "lm-bench", "tmp-locomo");
if (!fs.existsSync(DATA)) { console.error(`找不到数据文件: ${DATA}（可用 LM_LOCOMO_DATA 指定）`); process.exit(1); }
assertSafeEvalDir(MEM, { label: "LoCoMo 临时库" });
const data = JSON.parse(fs.readFileSync(DATA, "utf8"));

// 依赖注入：judgePrompt/glm/summarizeSessionPack/ANSWER_PROMPT_V2 在外置 lib.mjs（模型 key 相关，不入库）。
// 这里按相同导出名动态加载，保持本文件可独立评审。
const LIB = process.env.LM_LOCOMO_LIB || path.join(os.homedir(), ".dsh/profiles/desktop.crashed-20261102/lm-bench/lib.mjs");
const { startServer, clearAll, judgePrompt, glm, summarizeSessionPack, ANSWER_PROMPT_V2 } = await import(LIB);

const { c, call, db } = await startServer(MEM);
const t0 = Date.now();
const results = [];

for (let ci = 0; ci < N_CONV; ci++) {
  const conv = data[ci];
  clearAll(db);
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
    const take = (byCat[cat] ?? []).filter((q) => q.answer).slice(0, PER_CAT);
    for (const q of take) {
      const raw = await call("memory_recall", { query: q.question, limit: 15 });
      let rows = []; try { rows = JSON.parse(raw); } catch {}
      const snippets = rows.map((r) => r.content).join("\n");
      const hypothesis = await glm([{ role: "user", content: ANSWER_PROMPT_V2(timelineStr, snippets, q.question) }], { maxTokens: 260 });
      const judgeRaw = await glm([{ role: "user", content: judgePrompt("single-session-user", q.question, q.answer, hypothesis) }], { maxTokens: 64 });
      const ok = judgeRaw.toLowerCase().includes("yes");
      let turnCov = null;
      if (q.evidence?.length) {
        const got = new Set(rows.map((r) => r.tags.match(/dia:([^,]+)/)?.[1]).filter(Boolean));
        turnCov = q.evidence.filter((d) => got.has(String(d))).length / q.evidence.length;
      }
      results.push({ conv: conv.sample_id, category: Number(cat), catLabel: label, ok, judgeRaw: judgeRaw.slice(0, 200), turnCov, q: q.question.slice(0, 120), hypothesis: hypothesis.slice(0, 400), answer: String(q.answer).slice(0, 200) });
      console.log(`${ok ? "✅" : "❌"} [conv${ci + 1} ${label}] turnCov=${turnCov === null ? "-" : turnCov.toFixed(2)} | ${hypothesis.slice(0, 66).replace(/\n/g, " ")}`);
    }
  }
  console.log(`—— 对话${ci + 1} 完成（${nTurns} turns）`);
}

const acc = (a) => (a.length ? a.filter(Boolean).length / a.length : null);
const byCatR = {};
for (const r of results) (byCatR[r.catLabel] ??= []).push(r);
console.log(`\n===== LoCoMo（前${N_CONV}段 · 官方类别映射 · v0.15 runner） =====`);
const outByCat = {};
for (const [k, arr] of Object.entries(byCatR)) {
  const a = acc(arr.map((r) => r.ok));
  outByCat[k] = { n: arr.length, correct: arr.filter((r) => r.ok).length, accuracy: a == null ? null : +a.toFixed(3) };
  console.log(`  ${k.padEnd(12)} ${outByCat[k].correct}/${arr.length} = ${a?.toFixed(3)}`);
}
if (!byCatR.adversarial) console.log("  adversarial 0 题（数据中无带答案的 cat5 题）");
const overall = acc(results.map((r) => r.ok));
const covs = results.map((r) => r.turnCov).filter((v) => v !== null);
const ev = covs.length ? { questions: covs.length, anyHitRate: +(covs.filter((v) => v > 0).length / covs.length).toFixed(4), meanCoverage: +(covs.reduce((s, v) => s + v, 0) / covs.length).toFixed(4), fullHitRate: +(covs.filter((v) => v === 1).length / covs.length).toFixed(4) } : null;
console.log(`  总正确率: ${overall?.toFixed(3)} (${results.length} 题)`);
if (ev) console.log(`  证据覆盖率: 任一命中 ${ev.anyHitRate} · 真均值 ${ev.meanCoverage} · 全齐 ${ev.fullHitRate}（${ev.questions} 题带标注）`);
console.log(`  注意: judge/答题同为同一模型；本分数无跨系统排名资格（子集/类别/judge/上下文预算均与他方不同）`);
console.log(`  用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
rmEvalDir.done = true; // 标记：结果写出后保留 MEM 供检查，不自动删除
const outFile = process.env.LM_LOCOMO_OUT || path.join(os.tmpdir(), "lm-bench", `result-LoCoMo-official-${new Date().toISOString().slice(0, 10)}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ benchmark: "LoCoMo-official-mapping", runner: "scripts/eval/locomo-run.mjs v0.15", overall, byCat: outByCat, evidence: ev, n: results.length, results }, null, 1));
console.log(`  结果: ${outFile}（含每题原始 category id 与 judge 原始输出）`);
await c.close();
process.exit(0);
