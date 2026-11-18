#!/usr/bin/env node
// locomo-run.mjs — LoCoMo × lm-memory 修正版 runner（v0.15.2：修复运行错误 + cat5 判分语义）。
// 相对 v0.15.1 的修正（2026-11-17 复核实锤）：
//   1. startServer 返回值补齐 clearAll——旧版局部定义未返回，首个对话即 ReferenceError
//   2. cat5 判分语义修正：adversarial_answer 是「诱导错误作答的候选内容」，不是金标；
//      官方 evaluation.py 对 cat5 检查回答是否表达无信息/未提及（弃答判定）。
//      本 runner 对 cat5 单独判定：hypothesis 含无信息/未提及表述 → 正确，否则错误。
//      其余类别沿用 gold=answer 的 LLM judge（includes('yes')，已注明脆弱性）。
//   3. 输出记录 serverPath/libPath/dataPath + git HEAD（源码身份），cat5 记录 distractor 供复盘。
// 用法: node locomo-run.mjs [对话数=3] [每类题数=5]
//   env: LM_LOCOMO_DATA=locomo10.json；LM_LOCOMO_LIB=lib.mjs（judgePrompt/glm/summarizeSessionPack/ANSWER_PROMPT_V2）；
//        LM_MEMORY_DIR 临时库目录（须通过 eval-dir-guard）；LM_LOCOMO_OUT 输出路径
import fs from "node:fs";
import {retrievePlan} from "../../server/retrieval-plan.mjs";
import {abstains} from "./locomo-scoring.mjs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { assertSafeEvalDir } from "./eval-dir-guard.mjs";

const N_CONV = Number(process.argv[2] || 10);
const PER_CAT = Number(process.argv[3] || Infinity);
const OFFICIAL = { 1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial" };
const SERVER_PATH = fileURLToPath(new URL("../../server/memory-server.mjs", import.meta.url)); // 被测对象=当前提交
const DATA = process.env.LM_LOCOMO_DATA || path.join(os.homedir(), ".dsh/profiles/desktop/lm-bench/data/locomo10.json");
const LIB = process.env.LM_LOCOMO_LIB || fileURLToPath(new URL("./model-lib.mjs", import.meta.url));
const MEM = process.env.LM_MEMORY_DIR || path.join(os.tmpdir(), "lm-bench", "tmp-locomo");

if (!fs.existsSync(DATA)) { console.error(`找不到数据文件: ${DATA}（可用 LM_LOCOMO_DATA 指定）`); process.exit(1); }
if (!fs.existsSync(LIB)) { console.error(`找不到模型库 lib.mjs: ${LIB}（可用 LM_LOCOMO_LIB 指定）`); process.exit(1); }
assertSafeEvalDir(MEM, { label: "LoCoMo 临时库" });
const rawData = fs.readFileSync(DATA, "utf8");
const split = process.env.LM_BENCH_SPLIT || "all";
if (!["all","development","holdout"].includes(split)) throw new Error("Invalid LM_BENCH_SPLIT");
const allData = JSON.parse(rawData);
// Historical tuning used conversations 0..2. Keep whole remaining conversations separate.
const data = split === "development" ? allData.slice(0,3) : split === "holdout" ? allData.slice(3) : allData;
const { judgePrompt, glm, summarizeSessionPack, ANSWER_PROMPT_V2, decompose } = await import(LIB);

// 内置 startServer：MCP stdio 连当前提交的 server；clearAll 用 DB 直连清空（FTS 触发器联动）
async function startServer(memDir) {
  const c = new Client({ name: "locomo-run", version: "0.15.2" });
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    env: { ...process.env, LM_MEMORY_DIR: memDir, LM_EMBED: process.env.LM_EMBED ?? "1" },
  }));
  const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content[0].text;
  const db = new DatabaseSync(path.join(memDir, "memory.db"));
  const clearAll = () => db.exec("DELETE FROM memories"); // 触发器同步清 FTS
  return { c, call, db, clearAll }; // v0.15.2 修复：clearAll 必须对外返回（复核实锤 ReferenceError）
}
// cat5 金标=弃答（adversarial_answer 是诱导项，不作金标）；其余类别用 answer
const isCat5 = (q) => Number(q.category) === 5;
const goldOf = (q) => (isCat5(q) ? "" : String(q.answer ?? "").trim());
const distractorOf = (q) => (isCat5(q) ? String(q.adversarial_answer ?? "").trim() : "");

const { c, call, db, clearAll } = await startServer(MEM);
const checkpoint = process.env.LM_LOCOMO_OUT ? process.env.LM_LOCOMO_OUT + ".checkpoint.json" : null;
const t0 = Date.now();
const protocolHash = createHash("sha256").update(JSON.stringify([rawData,process.env.BENCH_LLM,ANSWER_PROMPT_V2.toString(),judgePrompt.toString(),"reader-1024-80words-judge64-bounded-expansion",process.env.LM_QUERY_PLAN??"0",process.env.LM_ALLOW_INFERENCE??"0",process.env.LM_TYPES??"all"])).digest("hex");
let results = [];
if (checkpoint && process.env.LM_BENCH_RESUME === "1" && fs.existsSync(checkpoint)) {
  const saved = JSON.parse(fs.readFileSync(checkpoint,"utf8"));
  if (saved.protocolHash !== protocolHash && !(saved.protocolHash === undefined && process.env.LM_BENCH_IMPORT_LEGACY_CHECKPOINT === "1")) throw new Error("Checkpoint protocol mismatch");
  results = saved.results;
  console.log(`Resume: ${results.length} completed questions`);
}

for (let ci = 0; ci < Math.min(N_CONV, data.length); ci++) {
  const conv = data[ci];
  conv.qa.forEach((q,index)=>q.qaIndex=index);
  clearAll();
  const sessionKeys = Object.keys(conv.conversation).filter((k) => /^session_\d+$/.test(k)).sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  let nTurns = 0;
  const sessTexts = [];
  for (const sk of sessionKeys) {
    const rawDT = String(conv.conversation[`${sk}_date_time`] ?? "");
    const date = (rawDT.match(/\d{1,2}\s+\w+,?\s+\d{4}/) ?? [rawDT.slice(0, 10)])[0];
    const sid = sk.replace("session_", "s");
    const lines = [];
    const batch=[];
    for (const turn of conv.conversation[sk]) {
      const text = String(turn.text ?? "").trim();
      if (text.length < 4) continue;
      const line = `${turn.speaker}: ${text.slice(0, 400)}`;
      lines.push(line);
      batch.push({ content: `[${date} ${sid}] ${line}`, kind: "episode", tags: `bench,sid:${sid},dia:${turn.dia_id}` });
      nTurns++;
    }
    for(let offset=0;offset<batch.length;offset+=50){const outcomes=JSON.parse(await call("memory_batch_remember",{items:batch.slice(offset,offset+50)}));if(outcomes.some(r=>!r.ok&&r.reason!=="exists"))throw new Error("Benchmark ingestion rejected a record");}
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
    if(process.env.LM_TYPES && !process.env.LM_TYPES.split(",").includes(cat)) continue;
    const take = (byCat[cat] ?? []).filter((q) => (isCat5(q) ? !!distractorOf(q) : !!goldOf(q))).slice(0, PER_CAT); // cat5 需诱导项存在才是标准题
    for (const q of take) {
      const prior=results.find(r=>r.conv===conv.sample_id && (r.qaIndex===q.qaIndex || (r.qaIndex===undefined && r.category===Number(cat) && r.q===q.question.slice(0,200))));
      if(prior){prior.qaIndex=q.qaIndex;if(isCat5(q))prior.ok=abstains(prior.hypothesis);continue;}
      const cat5 = isCat5(q);
      const gold = goldOf(q);
      const distractor = distractorOf(q);
      const raw = await call("memory_recall", { query: q.question, limit: 15 });
      let rows = []; try { const parsed = JSON.parse(raw); rows = Array.isArray(parsed) ? parsed : (parsed.hits ?? []); } catch {}
      let plannedQueries=[];
      if(process.env.LM_QUERY_PLAN === "1"){
        if(typeof decompose!=="function")throw new Error("Query planner unavailable");
        const plan=await retrievePlan(async args=>{const text=await call("memory_recall",args);try{return JSON.parse(text)}catch{return []}},q.question,await decompose(q.question));
        rows=plan.hits;plannedQueries=plan.queries;
      }
      const snippets = rows.map((r) => r.content).join("\n");
      const hypothesis = await glm([{ role: "user", content: ANSWER_PROMPT_V2(timelineStr, snippets, q.question) + (process.env.LM_ALLOW_INFERENCE === "1" ? "\nFor explicitly hypothetical questions (would, likely, might), provide a qualified inference grounded in the sources and ordinary background knowledge. Do not invent events. Do not infer an unstated event or unsupported identity. Distinguish likely conclusions from explicit facts." : "") + "\nReturn only the direct answer, at most 80 words; do not explain your reasoning." }], { maxTokens: 1024 });
      let ok, judgeRaw;
      if (cat5) {
        // v0.15.2 cat5 判分：正确弃答记对、诱导作答记错（官方口径；不用 adversarial_answer 做等价判分）
        ok = abstains(hypothesis);
        judgeRaw = ok ? "abstention:correct" : "abstention:violated";
      } else {
        judgeRaw = await glm([{ role: "user", content: judgePrompt("single-session-user", q.question, gold, hypothesis) }], { maxTokens: 64 });
        if (!/^(yes|no)[.!]?$/i.test(judgeRaw.trim())) throw new Error(`Invalid judge verdict: ${judgeRaw}`);
        ok = /^yes[.!]?$/i.test(judgeRaw.trim());
      }
      let turnCov = null;
      if (q.evidence?.length) {
        const got = new Set(rows.map((r) => r.tags.match(/dia:([^,]+)/)?.[1]).filter(Boolean));
        turnCov = q.evidence.filter((d) => got.has(String(d))).length / q.evidence.length;
      }
      results.push({ conv: conv.sample_id, qaIndex:q.qaIndex, plannedQueries, category: Number(cat), catLabel: label, ok, judgeRaw, turnCov, q: q.question.slice(0, 200), hypothesis, answer: gold, distractor: distractor.slice(0, 200) });
      if (checkpoint) { fs.mkdirSync(path.dirname(checkpoint),{recursive:true}); fs.writeFileSync(checkpoint+".tmp",JSON.stringify({complete:false,protocolHash,results})); fs.renameSync(checkpoint+".tmp",checkpoint); }
      console.log(`${ok ? "✅" : "❌"} [conv${ci + 1} ${label}] turnCov=${turnCov === null ? "-" : turnCov.toFixed(2)} | ${hypothesis.slice(0, 66).replace(/\n/g, " ")}`);
    }
  }
  console.log(`—— 对话${ci + 1} 完成（${nTurns} turns）`);
}

const acc = (a) => (a.length ? a.filter(Boolean).length / a.length : null);
const byCatR = {};
for (const r of results) (byCatR[r.catLabel] ??= []).push(r);
console.log(`\n===== LoCoMo（前${N_CONV}段 · 官方类别映射 · v0.15.2 runner） =====`);
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
console.log(`  注意: 非 cat5 用 LLM judge（gold=answer）；cat5 用官方弃答判定；judge/答题同一模型；本分数无跨系统排名资格`);
let gitHead = ""; try { gitHead = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch {}
const outFile = process.env.LM_LOCOMO_OUT || path.join(os.tmpdir(), "lm-bench", `result-LoCoMo-official-${new Date().toISOString().slice(0, 10)}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({
  benchmark: "LoCoMo-official-mapping", runner: "scripts/eval/locomo-run.mjs", runnerVersion: "0.15.2",
  serverPath: SERVER_PATH, libPath: LIB, dataPath: DATA, gitHead, model: process.env.BENCH_LLM, // 源码身份（HEAD 而非仅绝对路径）
  scoringNote: "cat5 = extended abstention markers including reader instruction I do not have enough information; adversarial_answer is a distractor, NOT gold",
  protocolHash, split, dataset_sha256: createHash("sha256").update(rawData).digest("hex"),
  model_lib_sha256: createHash("sha256").update(fs.readFileSync(LIB)).digest("hex"),
  sample_ids: data.slice(0,N_CONV).map(c=>c.sample_id), per_category_limit: Number.isFinite(PER_CAT) ? PER_CAT : "all",
  overall, byCat: outByCat, evidence: ev, n: results.length, results,
}, null, 1));
console.log(`  结果: ${outFile}（含每题原始 category id、金标来源、distractor 与 judge 原始输出）`);
await c.close();
process.exit(0);
