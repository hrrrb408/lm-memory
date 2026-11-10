#!/usr/bin/env node
// graph-e2e.mjs — v0.12 记忆图谱端到端测试（独立临时库，不碰真实数据）
// 断言：co_tag 低频共现 / similar 嵌入边 / ref 引用边 / 高频 tag 防 supernode /
//       写后自动重建 / recall expand 一跳扩展 / 默认格式不破坏
// 用法: LM_MEMORY_DIR=<空目录> node graph-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rebuildEdges, neighbors } from "./graph.mjs";

const MEM_DIR = process.env.LM_MEMORY_DIR;
if (!MEM_DIR || MEM_DIR === path.join(process.env.HOME, ".dsh", "memory")) { console.error("拒绝在真实库上跑测试"); process.exit(2); }
fs.rmSync(MEM_DIR, { recursive: true, force: true });
fs.mkdirSync(MEM_DIR, { recursive: true });

const c = new Client({ name: "graph-e2e", version: "0.12" });
await c.connect(new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./memory-server.mjs", import.meta.url))],
  env: { ...process.env, LM_MEMORY_DIR: MEM_DIR, LM_EMBED: "0" },
}));
const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content[0].text;
const idOf = (s) => Number(String(s).match(/id=(\d+)/)[1]);
const db = () => new DatabaseSync(path.join(MEM_DIR, "memory.db"));
let pass = 0, fail = 0;
const t = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "✅" : "❌") + " " + name + (extra ? " — " + extra : "")); };

// 1) 造数据：A/B 低频 tag 共现；C 与 A 近平行嵌入；D 显式引用 A；22 条共享高频 tag（df=22 > 上限 20）
const idA = idOf(await call("memory_remember", { content: "条目A：茹的考研时间线与待办", tags: "瑞邦-dream-test,考研", kind: "fact" }));
const idB = idOf(await call("memory_remember", { content: "条目B：茹的复合档案指针", tags: "瑞邦-dream-test,考研", kind: "fact" }));
const idC = idOf(await call("memory_remember", { content: "条目C：考研时间线又一条近似记录", kind: "fact" }));
const idD = idOf(await call("memory_remember", { content: `条目D：本条与记忆 ${idA} 相关，引用测试`, kind: "fact" }));
for (let i = 0; i < 22; i++) await call("memory_remember", { content: `高频组条目${i}：内容各不相同${"填充".repeat(i % 3 + 1)}`, tags: "x高频背景tag", kind: "fact" });

// 2) 手工给 A/C 造近平行嵌入，再手动重建一次边表
const setEmb = (id, arr) => {
  const f = new Float32Array(arr);
  const norm = Math.hypot(...f);
  for (let i = 0; i < f.length; i++) f[i] /= norm;
  db().prepare("UPDATE memories SET emb=? WHERE id=?").run(Buffer.from(f.buffer, f.byteOffset, f.byteLength), id);
};
setEmb(idA, [1, 0, 0, 0]);
setEmb(idC, [0.999, 0.0447, 0, 0]); // cos(A,C)≈0.999
const g = rebuildEdges(db(), {});
t("rebuildEdges 返回统计", g.nodes === 26 && g.edges > 0, JSON.stringify(g));
t("高频 tag（df=22>20）未产生共现边", !JSON.stringify(g.byRel).includes("26") && (g.byRel.co_tag ?? 0) < 40, `byRel=${JSON.stringify(g.byRel)}`);

const E = () => db().prepare("SELECT src, dst, rel, weight FROM edges").all();
const hasEdge = (a, b, rel) => E().some((e) => e.rel === rel && ((e.src === a && e.dst === b) || (e.src === b && e.dst === a)));
const wOf = (a, b, rel) => E().find((e) => e.rel === rel && ((e.src === a && e.dst === b) || (e.src === b && e.dst === a)))?.weight;

t("A-B co_tag 边存在且权重=2（共享2个低频tag）", hasEdge(idA, idB, "co_tag") && wOf(idA, idB, "co_tag") === 2, `w=${wOf(idA, idB, "co_tag")}`);
t("A-C similar 边存在", hasEdge(idA, idC, "similar"), `w=${wOf(idA, idC, "similar")}`);
t("D→A ref 边存在", hasEdge(idD, idA, "ref"), `w=${wOf(idD, idA, "ref")}`);
const hi = db().prepare("SELECT id FROM memories WHERE tags='x高频背景tag'").all();
const hiPair = E().filter((e) => hi.some((h) => h.id === e.src) && hi.some((h) => h.id === e.dst) && e.rel === "co_tag");
t("高频组内部零共现边", hiPair.length === 0, `${hiPair.length} 条`);

// 3) neighbors 纯函数
const nb = neighbors(db(), [idA], { exclude: new Set([idA]) });
t("neighbors 返回 A 的一跳", nb.length >= 3 && nb.every((n) => n.via === idA), JSON.stringify(nb));

// 4) 写路径自动重建：新条目带同款低频 tag → 应自动与 A/B 连边
const idE = idOf(await call("memory_remember", { content: "条目E：自动重建验证", tags: "考研", kind: "fact" }));
t("remember 后 edges 自动重建", hasEdge(idE, idA, "co_tag"), `E-A co_tag=${hasEdge(idE, idA, "co_tag")}`);

// 5) recall expand：命中 A 时 related 带 B/C/D
const r1 = JSON.parse(await call("memory_recall", { query: "茹 考研时间线", expand: true }));
t("expand=true 返回对象格式", Array.isArray(r1.hits) && Array.isArray(r1.related));
t("hits 命中 A", r1.hits.some((h) => h.id === idA));
t("related 含 co_tag 邻居 B", r1.related.some((x) => x.id === idB && x.graph.includes("co_tag")), JSON.stringify(r1.related?.map((x) => ({ id: x.id, g: x.graph }))));
t("related 带 graph 建边依据", r1.related.every((x) => /co_tag|similar|ref/.test(x.graph)));

// 6) 默认不破坏老格式
const r2 = JSON.parse(await call("memory_recall", { query: "茹 考研时间线" }));
t("expand 缺省仍返回数组老格式", Array.isArray(r2));

// 7) forget 后重建：删除 B，A-B 边消失
await call("memory_forget", { id: idB });
t("forget 后 A-B 边自动消失", !hasEdge(idA, idB, "co_tag"));

console.log(`\n${pass} passed, ${fail} failed`);
await c.close();
process.exit(fail ? 1 : 0);
