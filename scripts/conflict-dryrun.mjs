#!/usr/bin/env node
// conflict-dryrun.mjs — 对真实记忆库只读扫描疑似过时/冲突候选对，出报告不写库（v0.14）
// 用法: node scripts/conflict-dryrun.mjs [db路径] [--sim=0.85]
// 只读打开（readOnly:true），绝不写库；处置由人审后走 memory_correct（标注/指针）或
// memory_forget（收编）。与 dream-dryrun.mjs 分工：dedup 管「语义相同该归并」，
// 本工具管「旧条疑似已被新事实接棒」。
// ⚠️ 已知特性（2026-11-16 真库实证）：本工具是 Level 1 候选对粗筛。记忆条目为高密度
// 决策文体（拍板/发布/已上线词频高），词面信号误报率天然偏高——输出对象是人工复核
// 或后续 LLM 语义复核（v0.15 规划），不要把候选对当成结论。
import { DatabaseSync } from "node:sqlite";
import { findConflictPairs } from "../server/conflict.mjs";
import os from "node:os";
import path from "node:path";

const argDb = process.argv.slice(2).find((a) => !a.startsWith("--"));
const simArg = process.argv.find((a) => a.startsWith("--sim="));
const dbPath = argDb || path.join(os.homedir(), ".dsh", "memory", "memory.db");
const simMin = simArg ? Number(simArg.split("=")[1]) : 0.85;

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

const r = findConflictPairs(db, { simMin, maxPairs: 100 });
console.log(`扫描 ${r.scanned} 条 active（无嵌入 ${r.noEmb} 条），simMin=${simMin}，候选对 ${r.total} 个（粗筛，误报率高，需人工/LLM 复核）。\n`);
if (!r.total) {
  console.log("未发现疑似过时候选对。旧的完结/取代记录若仍以叙事形式存在，属正常教训留档，不构成冲突。");
} else {
  const annotate = r.pairs.filter((p) => p.suggestion === "annotate");
  const supersede = r.pairs.filter((p) => p.suggestion === "supersede-review");
  const show = (p, i) => {
    console.log(`#${i} sim=${p.sim} [${p.signals.join("+")}] → ${p.suggestion}`);
    console.log(`  旧 #${p.old.id} [${p.old.kind} ${p.old.updated_at}] ${p.old.snippet}${p.old.pinned ? " 📌" : ""}`);
    console.log(`  新 #${p.new.id} [${p.new.kind} ${p.new.updated_at}] ${p.new.snippet}${p.new.pinned ? " 📌" : ""}`);
  };
  if (annotate.length) {
    console.log(`── 取代性引用（引用点附近带取代语境，建议复核旧条是否已接棒）──`);
    annotate.forEach((p, i) => show(p, i + 1));
    console.log("");
  }
  if (supersede.length) {
    console.log(`── 取代信号（语义相近 + 新条带完结词 + 旧条干净，建议人工复核是否已被接棒）──`);
    supersede.forEach((p, i) => show(p, i + 1));
    console.log("");
  }
  console.log("处置建议：复核属实的旧条用 memory_correct 在正文追加「【已过时 MM-DD】见 #新id」指针（保留历史脉络），");
  console.log("或由新条走 memory_correct 正式接棒；不要直接 memory_forget 教训类条目——叙事里的完结词不是状态声明。");
}
