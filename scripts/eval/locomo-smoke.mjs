#!/usr/bin/env node
// locomo-smoke.mjs — LoCoMo runner 最小运行 smoke（2026-11-17 复核实锤：原版 runner 首段即 ReferenceError）。
// 验证：真正启动 MCP server、进入对话循环、写出结果文件；cat5 正确弃答记对、诱导作答记错。
// 用法: node scripts/eval/locomo-smoke.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const RUNNER = path.join(root, "scripts/eval/locomo-run.mjs");
const LIB = path.join(root, "scripts/eval/locomo-smoke-lib.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lm-locomo-smoke-"));
const dataFile = path.join(tmp, "locomo10.json");
const outFile = path.join(tmp, "result.json");
const memDir = path.join(tmp, "mem");
fs.writeFileSync(dataFile, JSON.stringify([{
  sample_id: "smoke-1",
  conversation: {
    session_1: [{ speaker: "A", text: "hello world, the code word is test", dia_id: "d1" }],
    session_2: [{ speaker: "B", text: "nothing here either", dia_id: "d2" }],
    session_1_date_time: "1:56 pm on 8 May, 2023",
    session_2_date_time: "2:30 pm on 9 May, 2023",
  },
  qa: [
    { category: 4, question: "What is the code word?", answer: "test", evidence: ["d1"] },
    { category: 4, question: "What is the code word?", answer: "test", evidence: ["d1"] },
    { category: 5, question: "ADV-ABSTAIN: What did Caroline say about quantum computing?", adversarial_answer: "Caroline discussed quantum computing", evidence: [] },
    { category: 5, question: "ADV-INDUCED: What did Bob say about the moon?", adversarial_answer: "Bob said the moon is cheese", evidence: [] },
  ],
}], null, 1));

const r = spawnSync(process.execPath, [RUNNER, "1", "5"], {
  cwd: root,
  env: { ...process.env, LM_MEMORY_DIR: memDir, LM_EMBED: "0", LM_LOCOMO_DATA: dataFile, LM_LOCOMO_LIB: LIB, LM_LOCOMO_OUT: outFile },
  encoding: "utf8",
  timeout: 120000,
});
let pass = 0, fail = 0;
const t = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "✅" : "❌") + " " + name + (extra ? " — " + extra : "")); };
t("runner 最小对话运行成功（不再 ReferenceError）", r.status === 0, `exit=${r.status}`);
let out = null;
try { out = JSON.parse(fs.readFileSync(outFile, "utf8")); } catch {}
t("结果文件写出", !!out);
t("四题全部进入循环（重复题干不折叠）", out?.n === 4, `n=${out?.n}`);
t("重复题具有不同原始序号", new Set(out?.results?.map(r=>r.qaIndex)).size === 4);
t("cat4 正确", out?.byCat?.["single-hop"]?.accuracy === 1, JSON.stringify(out?.byCat?.["single-hop"]));
t("cat5 正确弃答记对、诱导作答记错（1/2）", out?.byCat?.adversarial?.accuracy === 0.5, JSON.stringify(out?.byCat?.adversarial));
t("cat5 记录 distractor 供复盘", Array.isArray(out?.results) && out.results.filter((x) => x.category === 5).every((x) => typeof x.distractor === "string"));
t("源码身份含 serverPath 与 gitHead 字段", !!out?.serverPath && typeof out?.gitHead === "string");
t("stderr 无 ReferenceError", !/ReferenceError/.test(r.stderr ?? ""));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
