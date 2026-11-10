#!/usr/bin/env node
// dream-e2e.mjs — v0.11 dream 去重扫描端到端测试（独立临时库，不碰真实数据）
// 手工构造嵌入向量：高相似对必抓 / 正交不误报 / deleted 排除 / 阈值敏感
// 用法: LM_MEMORY_DIR=<空目录> node dream-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findDuplicatePairs } from "./dream.mjs";

const MEM_DIR = process.env.LM_MEMORY_DIR;
if (!MEM_DIR || MEM_DIR === path.join(process.env.HOME, ".dsh", "memory")) { console.error("拒绝在真实库上跑测试"); process.exit(2); }
fs.rmSync(MEM_DIR, { recursive: true, force: true });
fs.mkdirSync(MEM_DIR, { recursive: true });

const c = new Client({ name: "dream-e2e", version: "0.11" });
await c.connect(new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./memory-server.mjs", import.meta.url))],
  env: { ...process.env, LM_MEMORY_DIR: MEM_DIR, LM_EMBED: "0" },
}));
const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content[0].text;
const idOf = (s) => Number(String(s).match(/id=(\d+)/)[1]);
let pass = 0, fail = 0;
const t = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "✅" : "❌") + " " + name + (extra ? " — " + extra : "")); };

// 1) 写入 4 条（LM_EMBED=0，嵌入留空，稍后手工造）
const idA = idOf(await call("memory_remember", { content: "条目A：复合事件完整档案指针", kind: "fact" }));
const idB = idOf(await call("memory_remember", { content: "条目B：复合事件又一条近似记录", kind: "fact" }));
const idC = idOf(await call("memory_remember", { content: "条目C：完全无关的独立事项", kind: "fact" }));
const idD = idOf(await call("memory_remember", { content: "条目D：将被删除的相似条目", kind: "fact" }));

// 2) 手工造嵌入（4 维）：A 与 B 近平行（cos≈0.995），C 正交
const setEmb = (id, arr) => {
  const f = new Float32Array(arr);
  const norm = Math.hypot(...f);
  for (let i = 0; i < f.length; i++) f[i] /= norm;
  new DatabaseSync(path.join(MEM_DIR, "memory.db"))
    .prepare("UPDATE memories SET emb=? WHERE id=?")
    .run(Buffer.from(f.buffer, f.byteOffset, f.byteLength), id);
};
setEmb(idA, [1, 0, 0, 0]);
setEmb(idB, [0.995, 0.0999, 0, 0]);
setEmb(idC, [0, 1, 0, 0]);
setEmb(idD, [1, 0.001, 0, 0]); // 与 A 高相似，但将被删除

// 3) 删除 D（逻辑删除）→ 不应参与扫描
await call("memory_forget", { id: idD });

// 4) 扫描（只读连接）
const ro = new DatabaseSync(path.join(MEM_DIR, "memory.db"), { readOnly: true });
const r = findDuplicatePairs(ro, { threshold: 0.88 });

t("扫描计数正确（3 条 active 有嵌入）", r.scanned === 3, `scanned=${r.scanned}`);
t("发现恰好 1 对", r.total === 1, `total=${r.total}`);
t("A-B 对被抓", r.pairs.length === 1 && ((r.pairs[0].a.id === idA && r.pairs[0].b.id === idB) || (r.pairs[0].a.id === idB && r.pairs[0].b.id === idA)), JSON.stringify(r.pairs));
t("相似度 ≈0.995", r.pairs.length === 1 && Math.abs(r.pairs[0].sim - 0.995) < 0.01, `sim=${r.pairs[0]?.sim}`);
t("正交条目 C 不出现在任何对", !JSON.stringify(r.pairs).includes(`"id":${idC}`));
t("deleted 条目 D 不出现", !JSON.stringify(r.pairs).includes(`"id":${idD}`));

// 5) 阈值敏感性：0.999 应为 0 对
const rStrict = findDuplicatePairs(ro, { threshold: 0.999 });
t("高阈值下无误报", rStrict.total === 0, `total=${rStrict.total}`);

// 6) 跨 kind：再插一条 episode 与 A 相似 → 仍应被抓
const idE = idOf(await call("memory_remember", { content: "条目E：会话摘要形式的复合事件记录", kind: "episode" }));
setEmb(idE, [0.999, 0.0447, 0, 0]); // cos(A,E)≈0.999
const r2 = findDuplicatePairs(ro, { threshold: 0.88 });
t("跨 kind（fact×episode）照抓", r2.pairs.some((p) => [p.a, p.b].some((s) => s.id === idE && s.kind === "episode")), JSON.stringify(r2.pairs.map((p) => [p.a.id, p.b.id, p.sim])));

console.log(`\n${pass} passed, ${fail} failed`);
await c.close();
process.exit(fail ? 1 : 0);
