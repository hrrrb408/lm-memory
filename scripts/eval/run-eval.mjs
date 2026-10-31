#!/usr/bin/env node
// lm-memory 质量测评：Recall@1/@5、MRR、误召回率、按能力类别分项、知识更新测试
// 用法: LM_MEMORY_DIR=/tmp/lm-eval node run-eval.mjs   （会清空该目录后重建）
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEM_DIR = process.env.LM_MEMORY_DIR || "/tmp/lm-eval";
fs.rmSync(MEM_DIR, { recursive: true, force: true });
fs.mkdirSync(MEM_DIR, { recursive: true });
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "dataset.json"), "utf8"));

const client = new Client({ name: "lm-eval", version: "0.1" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(__dirname, "../../server/memory-server.mjs")],
  env: { ...process.env, LM_EMBED_CACHE: process.env.LM_EMBED_CACHE || (os.homedir() + "/.cache/lm-memory-embed"), LM_MEMORY_DIR: MEM_DIR },
}));
const call = (name, args) => client.callTool({ name, arguments: args }).then((r) => r.content[0].text);

// 1) 建库：写入全部记忆，记录 datasetId → numericId 映射
const idMap = new Map();
for (const m of data.memories) {
  const out = await call("memory_remember", { content: m.content, kind: m.kind, tags: `eval,${m.id}` });
  const id = Number(out.match(/id=(\d+)/)?.[1] ?? 0);
  idMap.set(m.id, id);
}
// 校对映射（用 tags 反查兜底）
for (const m of data.memories) {
  if (!idMap.get(m.id)) {
    const list = JSON.parse(await call("memory_list", { limit: 100 }));
    const hit = list.find((x) => x.tags.includes(m.id));
    if (hit) idMap.set(m.id, hit.id);
  }
}
console.log(`建库完成：${idMap.size}/${data.memories.length} 条记忆`);

// 2) 检索测评
const numToDs = new Map([...idMap].map(([ds, n]) => [n, ds]));
async function recallTop5(query) {
  const t = await call("memory_recall", { query, limit: 5 });
  try { const p = JSON.parse(t); return Array.isArray(p) ? p : []; } catch { return []; }
}
const rows = [];
for (const { cat, q, gold, note } of data.queries) {
  const hits = await recallTop5(q);
  const hitDs = hits.map((h) => numToDs.get(h.id)).filter(Boolean);
  const isAbstain = gold.length === 0;
  let pass, rr = 0;
  if (isAbstain) {
    pass = hitDs.length === 0;
  } else {
    const firstIdx = hitDs.findIndex((d) => gold.includes(d));
    const in5 = hitDs.some((d) => gold.includes(d));
    const in1 = firstIdx === 0;
    pass = in5;
    rr = firstIdx >= 0 ? 1 / (firstIdx + 1) : 0;
    rows.push({ cat, q, gold, hitDs, in1, in5, rr, note });
    continue;
  }
  rows.push({ cat, q, gold, hitDs, in1: pass && false, in5: pass, rr: pass ? 0 : 0, abstain: true, pass, note });
}

// 3) 汇总
const cats = {};
for (const r of rows.filter((x) => !x.abstain)) {
  const c = (cats[r.cat] ??= { n: 0, r1: 0, r5: 0, mrr: 0 });
  c.n++; c.r1 += r.in1 ? 1 : 0; c.r5 += r.in5 ? 1 : 0; c.mrr += r.rr;
}
const abstainRows = rows.filter((x) => x.abstain);
const fpRate = abstainRows.filter((x) => !x.pass).length / abstainRows.length;
const total = rows.filter((x) => !x.abstain);

// 4) 知识更新测试（D 类，改库放最后）
const D = data.correction_test;
const before = await recallTop5(D.old_query);
const targetNum = idMap.get(D.target);
const found = before.find((h) => h.id === targetNum);
let dUpdateNew, dOldAbsent;
if (found) {
  const corr = await call("memory_correct", { id: targetNum, expected_version: found.v, content: D.new_content, reason: "eval D" });
  const afterNew = await recallTop5(D.new_query);
  dUpdateNew = afterNew.some((h) => h.content.includes("修复"));
  const afterOld = await recallTop5(D.old_query);
  dOldAbsent = !afterOld.some((h) => h.id === targetNum);
  console.log(`D-知识更新: 修正=${corr.includes("OK")}, 新可检索=${dUpdateNew}, 旧版不复活=${dOldAbsent}`);
} else {
  dUpdateNew = dOldAbsent = false;
  console.log("D-知识更新: 未找到目标记忆，跳过");
}

// 5) 报告
console.log("\n════════ lm-memory 质量测评报告 ════════");
console.log(`记忆库: ${data.memories.length} 条 | 查询: ${rows.length} 个（含 ${abstainRows.length} 个空结果陷阱）\n`);
console.log("类别          \tRecall@1\tRecall@5\tMRR");
for (const [cat, c] of Object.entries(cats)) {
  console.log(`${cat.padEnd(12)}\t${(c.r1 / c.n).toFixed(2)}    \t${(c.r5 / c.n).toFixed(2)}    \t${(c.mrr / c.n).toFixed(2)}`);
}
const agg = { r1: 0, r5: 0, mrr: 0 };
for (const c of Object.values(cats)) { agg.r1 += c.r1; agg.r5 += c.r5; agg.mrr += c.mrr; }
console.log(`${"总计".padEnd(12)}\t${(agg.r1 / total.length).toFixed(2)}    \t${(agg.r5 / total.length).toFixed(2)}    \t${(agg.mrr / total.length).toFixed(2)}`);
console.log(`\n误召回率(空结果陷阱中返回了结果): ${(fpRate * 100).toFixed(0)}%  ${fpRate === 0 ? "✓" : "⚠"}`);
console.log(`知识更新: 新版可检索=${dUpdateNew ? "✓" : "✗"} 旧版不复活=${dOldAbsent ? "✓" : "✗"}\n`);

// 失败明细
const fails = rows.filter((r) => (r.abstain ? !r.pass : !r.in5));
if (fails.length) {
  console.log("── 失败/失分明细 ──");
  for (const f of fails) {
    console.log(`[${f.cat}] ${f.q}`);
    console.log(`   期望: ${JSON.stringify(f.gold)} | 实得: ${JSON.stringify(f.hitDs)}${f.note ? " | " + f.note : ""}`);
  }
}
const out = { cats, total: total.length, mrr: agg.mrr / total.length, fpRate, dUpdateNew, dOldAbsent, rows };
fs.writeFileSync(path.join(__dirname, "eval-report.json"), JSON.stringify(out, null, 2));
console.log(`\n报告已存: scripts/eval/eval-report.json`);
await client.close();
process.exit(0);
