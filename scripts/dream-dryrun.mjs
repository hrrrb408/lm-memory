#!/usr/bin/env node
// dream-dryrun.mjs — 对真实记忆库只读扫描疑似重复条目，出报告不写库（v0.11）
// 用法: node scripts/dream-dryrun.mjs [db路径] [--threshold=0.88]
// 只读打开（readOnly:true），绝不写库；重复条目的合并由人审后走 memory_correct/memory_forget。
import { DatabaseSync } from "node:sqlite";
import { findDuplicatePairs } from "../server/dream.mjs";
import os from "node:os";
import path from "node:path";

const argDb = process.argv.slice(2).find((a) => !a.startsWith("--"));
const thresholdArg = process.argv.find((a) => a.startsWith("--threshold="));
const dbPath = argDb || path.join(os.homedir(), ".dsh", "memory", "memory.db");
const threshold = thresholdArg ? Number(thresholdArg.split("=")[1]) : 0.88;

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch (e) {
  console.error(`打不开库 ${dbPath}: ${e.message}`);
  process.exit(2);
}

const cnt = db.prepare("SELECT status, count(*) n FROM memories GROUP BY status").all();
console.log(`库: ${dbPath}`);
console.log(`状态分布: ${cnt.map((r) => `${r.status}=${r.n}`).join(" / ")}\n`);

// 多档阈值概览（帮助选默认阈值）
const r88 = findDuplicatePairs(db, { threshold: 0.88, maxPairs: 1000 });
const r92 = findDuplicatePairs(db, { threshold: 0.92, maxPairs: 1000 });
const r96 = findDuplicatePairs(db, { threshold: 0.96, maxPairs: 1000 });
console.log(`阈值概览: ≥0.88 → ${r88.total} 对 | ≥0.92 → ${r92.total} 对 | ≥0.96 → ${r96.total} 对 (扫描 ${r88.scanned} 条，无嵌入 ${r88.noEmb} 条)\n`);

const r = findDuplicatePairs(db, { threshold, maxPairs: 100 });
if (!r.total) {
  console.log(`阈值 ${threshold} 下无疑似重复。`);
} else {
  console.log(`阈值 ${threshold} 下疑似重复 ${r.total} 对（显示前 ${r.pairs.length}，相似度降序）:\n`);
  let i = 0;
  for (const p of r.pairs) {
    i++;
    console.log(`#${i} sim=${p.sim}`);
    console.log(`  A #${p.a.id} [${p.a.kind} ${p.a.updated_at}] ${p.a.snippet}${p.a.pinned ? " 📌" : ""}`);
    console.log(`  B #${p.b.id} [${p.b.kind} ${p.b.updated_at}] ${p.b.snippet}${p.b.pinned ? " 📌" : ""}`);
  }
  console.log(`\n处置建议：保留信息量最大的一条做正文，其余用 memory_forget 收编（或 memory_correct 改为指针条目）。pinned 条目优先保留。`);
}
