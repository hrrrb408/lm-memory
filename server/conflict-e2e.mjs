#!/usr/bin/env node
// conflict-e2e.mjs — v0.14 冲突/过时检测端到端测试（独立临时库，不碰真实数据）
// 手工构造嵌入向量：取代信号对必抓 / 显式引用不要求相似 / 无信号不误报 /
// 双完结词不误报 / deleted 排除 / 扫描只读性。
// 用法: LM_MEMORY_DIR=<空目录> node conflict-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findConflictPairs, buildReviewPrompt, parseReview } from "./conflict.mjs";

import { rmEvalDir } from "../scripts/eval/eval-dir-guard.mjs";
const MEM_DIR = process.env.LM_MEMORY_DIR;
if (!MEM_DIR || MEM_DIR === path.join(process.env.HOME, ".dsh", "memory")) { console.error("拒绝在真实库上跑测试"); process.exit(2); }
rmEvalDir(MEM_DIR); // 守卫：realpath 级拒绝生产路径（v0.15.1 收敛）
fs.mkdirSync(MEM_DIR, { recursive: true });

const c = new Client({ name: "conflict-e2e", version: "0.14" });
await c.connect(new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./memory-server.mjs", import.meta.url))],
  env: { ...process.env, LM_MEMORY_DIR: MEM_DIR, LM_EMBED: "0" },
}));
const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content[0].text;
const idOf = (s) => Number(String(s).match(/id=(\d+)/)[1]);
let pass = 0, fail = 0;
const t = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "✅" : "❌") + " " + name + (extra ? " — " + extra : "")); };

// 1) 写入测试条目（LM_EMBED=0，嵌入留空，稍后手工造）
//    old1/new1：语义相近 + new 带取代词 → supersede_signal
//    old2/new2：new2 显式引用 old2 的 id（与 old2 正交）→ explicit_ref
//    C：完全无关正交条 → 不出现在任何对
//    both-done：早条晚条都带完结词 → 不出对（词信号要求早条干净）
const idOld1 = idOf(await call("memory_remember", { content: "旧方案：记忆只在会话启动时加载一次，运行中会话感知不到新记忆", kind: "fact" }));
const idNew1 = idOf(await call("memory_remember", { content: "新方案：记忆变更热流已上线，运行中会话可实时感知其他会话写入的记忆", kind: "fact" }));
const idOld2 = idOf(await call("memory_remember", { content: "渲染管线 v1：用 ffmpeg 拼接片段出片", kind: "procedure" }));
const idNew2 = idOf(await call("memory_remember", { content: `管线更新记录：v0.14 方案详见 id=${idOld2} 的旧管线，该方案已废弃，本条为其接棒演进`, kind: "procedure" }));
const idUnrel = idOf(await call("memory_remember", { content: "完全无关的独立事项：今天天气不错", kind: "episode" }));
const idDoneOld = idOf(await call("memory_remember", { content: "旧流程A：豆包改稿（已废弃，留档）", kind: "procedure" }));
const idDoneNew = idOf(await call("memory_remember", { content: "新流程B：三轮独立评审（已上线，替代旧流程）", kind: "procedure" }));

// 2) 手工造嵌入（5 维：前 4 维给前两组，第 5 维单独隔离 done 对，杜绝跨组相似）
const setEmb = (id, arr) => {
  const f = new Float32Array(arr);
  const norm = Math.hypot(...f);
  for (let i = 0; i < f.length; i++) f[i] /= norm;
  new DatabaseSync(path.join(MEM_DIR, "memory.db"))
    .prepare("UPDATE memories SET emb=? WHERE id=?")
    .run(Buffer.from(f.buffer, f.byteOffset, f.byteLength), id);
};
// 注意：updated_at 同秒写入时排序不稳定，用 updated_at 显式分先后
const dbw = new DatabaseSync(path.join(MEM_DIR, "memory.db"));
const setSeq = (id, seq) => dbw.prepare("UPDATE memories SET updated_at=? WHERE id=?").run(`2026-11-0${seq}T00:00:00.000Z`, id);
setSeq(idOld1, 1); setSeq(idNew1, 2); setSeq(idOld2, 1); setSeq(idNew2, 2); setSeq(idUnrel, 3); setSeq(idDoneOld, 1); setSeq(idDoneNew, 2);

setEmb(idOld1, [1, 0, 0, 0, 0]);
setEmb(idNew1, [0.92, 0.392, 0, 0, 0]);           // cos(old1,new1) ≈ 0.92
setEmb(idOld2, [0, 0, 1, 0, 0]);
setEmb(idNew2, [0, 0, 0, 1, 0]);                   // cos(old2,new2) = 0（正交），纯靠 explicit_ref
setEmb(idUnrel, [0, 1, 0, 0, 0]);                  // 与所有条正交
setEmb(idDoneOld, [0, 0, 0, 0, 1]);               // 第 5 维独立方向：与所有前组条正交
setEmb(idDoneNew, [0, 0, 0, 0.0999, 0.995]);      // 主分量在第 5 维：与 new2(第4维) sim≈0.1，双完结词也不出对
dbw.close();

// 3) 删除无关条目的孪生验证：deleted 条目不参与（新建后 forget）
const idGone = idOf(await call("memory_remember", { content: "旧方案：记忆只在会话启动时加载一次的另一个副本", kind: "fact" }));
setEmb(idGone, [0.99, 0.141, 0, 0, 0]);
await call("memory_forget", { id: idGone });

// 4) 只读性取证：扫描前抓全表指纹
const ro = new DatabaseSync(path.join(MEM_DIR, "memory.db"), { readOnly: true });
const fingerprint = () => ro.prepare("SELECT id, status, updated_at, content FROM memories ORDER BY id").all();
const before = JSON.stringify(fingerprint());

const r = findConflictPairs(ro, { simMin: 0.72, maxPairs: 100 });

const after = JSON.stringify(fingerprint());
t("扫描只读：全表指纹不变", before === after);

t("扫描计数正确（7 条 active 有嵌入）", r.scanned === 7, `scanned=${r.scanned}`);

const pair = (a, b) => r.pairs.find((p) => (p.old.id === a && p.new.id === b) || (p.old.id === b && p.new.id === a));
const p1 = pair(idOld1, idNew1);
const p2 = pair(idOld2, idNew2);

t("取代信号对被抓（old1→new1）", !!p1, JSON.stringify(r.pairs.map((p) => [p.old.id, p.new.id])));
t("new1→old1 方向正确（old 是早条）", !!p1 && p1.old.id === idOld1 && p1.new.id === idNew1);
t("取代信号对标注 supersede-review", !!p1 && p1.suggestion === "supersede-review", p1?.suggestion);
t("取代信号 sim ≈0.92", !!p1 && Math.abs(p1.sim - 0.92) < 0.01, `sim=${p1?.sim}`);

t("显式引用对被抓（old2→new2）", !!p2, JSON.stringify(r.pairs.map((p) => [p.old.id, p.new.id])));
t("显式引用零相似也触发（正交向量 sim=0）", !!p2 && Math.abs(p2.sim) < 0.01, `sim=${p2?.sim}`);
t("显式引用对标注 annotate", !!p2 && p2.suggestion === "annotate", p2?.suggestion);

t("无关正交条不出现在任何对", !JSON.stringify(r.pairs).includes(`"id":${idUnrel}`));
t("双完结词对不误报（doneOld↔doneNew）", !pair(idDoneOld, idDoneNew));
t("deleted 条目不参与", !JSON.stringify(r.pairs).includes(`"id":${idGone}`) && !r.pairs.some((p) => p.old.id === idGone || p.new.id === idGone));

t("总对数恰好 2", r.total === 2, `total=${r.total} pairs=${JSON.stringify(r.pairs.map((p) => [p.old.id, p.new.id, p.signals]))}`);

// 5) 高阈值不消灭取代性引用（引用信号独立于 sim；纯关联引用不算——另起对照）
const idPlainRef = idOf(await call("memory_remember", { content: `背景资料：管线历史可回看 id=${idOld2} 的记录`, kind: "episode" }));
setEmb(idPlainRef, [0, 0, 0, 1, 0]);
new DatabaseSync(path.join(MEM_DIR, "memory.db"))
  .prepare("UPDATE memories SET updated_at=? WHERE id=?")
  .run("2026-11-04T00:00:00.000Z", idPlainRef);

// 5b) 版本发布条互撞不出对（v0.14.1：版本时间线互不推翻——真库 14 误报的主源）
const idRelOld = idOf(await call("memory_remember", { content: "lm-memory v0.13.0 发布（commit af5b415，tag 已推）：recall 语义精修", kind: "procedure" }));
const idRelNew = idOf(await call("memory_remember", { content: "lm-memory v0.14.0 发布（commit f172f05，tag 已推）：冲突消解扫描上线", kind: "procedure" }));
setEmb(idRelOld, [1, 0, 0, 0, 0]);
setEmb(idRelNew, [0.92, 0.392, 0, 0, 0]); // 与 old1 高相似且带「发布」完结词
new DatabaseSync(path.join(MEM_DIR, "memory.db"))
  .prepare("UPDATE memories SET updated_at=? WHERE id IN (?, ?)")
  .run("2026-11-05T00:00:00.000Z", idRelOld, idRelNew);
const rRel = findConflictPairs(ro, { simMin: 0.72, maxPairs: 100 });
t("版本发布条互撞不出对", !rRel.pairs.some((p) => [p.old.id, p.new.id].includes(idRelOld) && [p.old.id, p.new.id].includes(idRelNew)), JSON.stringify(rRel.pairs.map((p) => [p.old.id, p.new.id])));

// 5c) Level 2 复核纯函数
const rStrict = findConflictPairs(ro, { simMin: 0.999, maxPairs: 100 });
t("simMin 拉满仍保留取代性引用对", rStrict.pairs.some((p) => p.signals.includes("explicit_ref")), `total=${rStrict.total}`);
const prompt = buildReviewPrompt([{ old: { id: 1, updated_at: "2026-11-01", snippet: "旧" }, new: { id: 2, updated_at: "2026-11-02", snippet: "新" } }]);
t("复核 prompt 含候选对与判断标准", prompt.includes("[0]") && prompt.includes("superseded") && prompt.includes("related"));
t("parseReview 正常解析", JSON.stringify(parseReview('[{"i":0,"verdict":"superseded"},{"i":1,"verdict":"related"}]', 2)) === '[{"i":0,"verdict":"superseded"},{"i":1,"verdict":"related"}]');
t("parseReview 拒绝越界与非法 verdict", parseReview('[{"i":9,"verdict":"superseded"},{"i":0,"verdict":"haha"}]', 1) === null || parseReview('[{"i":9,"verdict":"superseded"},{"i":0,"verdict":"haha"}]', 1).length === 0);
t("parseReview 坏输出返回 null", parseReview("模型胡言乱语", 2) === null);
t("纯关联引用（无取代语境）不出对", !rStrict.pairs.some((p) => p.old.id === idOld2 && p.new.id === idPlainRef));

console.log(`\n${pass} passed, ${fail} failed`);
await c.close();
process.exit(fail ? 1 : 0);
