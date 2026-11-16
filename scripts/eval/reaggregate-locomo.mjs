#!/usr/bin/env node
// reaggregate-locomo.mjs — LoCoMo 历史结果按官方类别映射重聚合（2026-11-17 勘误工具）。
// 外审实锤：harness 的 CATS = {1:single-hop,2:multi-hop,3:temporal,4:adversarial} 全错，
// 官方 evaluation.py / snap-research/locomo#29 为 {1:multi-hop,2:temporal,3:open-domain,4:single-hop,5:adversarial}。
// 本脚本读历史 per-question 结果（含原始 category id 才可重算），输出正确分项与覆盖率三口径。
// 只读：不碰库、不调 LLM、不修改输入文件。
// 用法: node reaggregate-locomo.mjs <result.json> [输出.json]
import fs from "node:fs";
import path from "node:path";

const OFFICIAL = { 1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial" };
// 旧 harness 的错误映射（双射，可逆）：结果文件若存的是 label 而非 id，可反解回 id 再按官方映射重排
const HARNESS_REVERSE = { "single-hop": 1, "multi-hop": 2, "temporal": 3, "adversarial": 4 };

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error("用法: node reaggregate-locomo.mjs <result.json> [输出.json]"); process.exit(1); }
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const results = data.results || [];
if (!results.length) { console.error("结果文件没有 results 数组"); process.exit(1); }

const acc = (a) => (a.length ? a.filter(Boolean).length / a.length : null);
const byCat = {};
for (const r of results) {
  const cat = r.category ?? (typeof r.cat === "string" ? HARNESS_REVERSE[r.cat] : r.cat); // 优先原始 id；旧文件存 label 则反解
  if (cat === undefined) { console.error(`结果缺 category 信息（label=${r.cat}），无法重算`); process.exit(1); }
  (byCat[cat] ??= { ok: [], cov: [] });
  byCat[cat].ok.push(r.ok);
  if (typeof r.turnCov === "number") byCat[cat].cov.push(r.turnCov);
}

console.log(`\n===== LoCoMo 重聚合（官方类别映射） · ${path.basename(file)} · ${results.length} 题 =====`);
const out = { file: path.resolve(file), n: results.length, correct: results.filter((r) => r.ok).length, byCategory: {}, evidence: null };
let covAll = [], evQ = 0;
for (const [cat, v] of Object.entries(byCat)) {
  const label = OFFICIAL[cat] ?? `unknown(cat${cat})`;
  const a = acc(v.ok);
  out.byCategory[label] = { n: v.ok.length, correct: v.ok.filter(Boolean).length, accuracy: a == null ? null : +a.toFixed(3) };
  console.log(`  ${label.padEnd(12)} ${v.ok.filter(Boolean).length}/${v.ok.length} = ${a?.toFixed(3)}`);
  covAll.push(...v.cov);
}
const overall = acc(results.map((r) => r.ok));
out.overall = +overall.toFixed(4);
console.log(`  总计          ${results.filter(Boolean).length ? results.filter((r) => r.ok).length : 0}/${results.length} = ${overall?.toFixed(3)}`);
if (covAll.length) {
  const meanCov = covAll.reduce((s, v) => s + v, 0) / covAll.length;
  const anyHit = covAll.filter((v) => v > 0).length;
  const fullHit = covAll.filter((v) => v === 1).length;
  out.evidence = { questions: covAll.length, anyHit, anyHitRate: +(anyHit / covAll.length).toFixed(4), meanCoverage: +meanCov.toFixed(4), fullHit, fullHitRate: +(fullHit / covAll.length).toFixed(4), legacyFilterBooleanRate: data.turnRecall ?? null };
  console.log(`  证据覆盖率（${covAll.length} 题带标注）: 任一命中 ${anyHit}/${covAll.length}=${(anyHit / covAll.length).toFixed(3)} · 真均值 ${meanCov.toFixed(3)} · 全齐 ${fullHit}/${covAll.length}=${(fullHit / covAll.length).toFixed(3)}（旧 filter(Boolean) 口径存档: ${data.turnRecall}）`);
}
if (!byCat[5]) console.log(`  adversarial（cat5）: 未进入当年测试循环，无数据——不要引用任何 adversarial 数字`);
const outFile = process.argv[3] || file.replace(/\.json$/, ".official.json");
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(`  已写出: ${outFile}`);
