#!/usr/bin/env node
// sleep-e2e.mjs — v0.7 sleep-time 衰减端到端测试（独立临时库，不碰真实数据）
// 用法: LM_MEMORY_DIR=<空目录> node sleep-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const MEM_DIR = process.env.LM_MEMORY_DIR;
if (!MEM_DIR || MEM_DIR === path.join(process.env.HOME, ".dsh", "memory")) { console.error("拒绝在真实库上跑测试"); process.exit(2); }
const DB = path.join(MEM_DIR, "memory.db");
fs.rmSync(MEM_DIR, { recursive: true, force: true });
fs.mkdirSync(MEM_DIR, { recursive: true });

const c = new Client({ name: "sleep-e2e", version: "0.7" });
await c.connect(new StdioClientTransport({
  command: process.execPath,
  args: [new URL("./memory-server.mjs", import.meta.url).pathname],
  env: { ...process.env, LM_MEMORY_DIR: MEM_DIR, LM_EMBED: "0" },
}));
const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content[0].text;
const db = () => new DatabaseSync(DB, { readOnly: true });
const idOf = (s) => Number(String(s).match(/id=(\d+)/)[1]);
const ageDays = (id, d) => {
  const t = new Date(Date.now() - d * 86400000).toISOString();
  new DatabaseSync(DB).prepare("UPDATE memories SET updated_at=?, last_hit_at=CASE WHEN last_hit_at IS NOT NULL THEN ? ELSE last_hit_at END WHERE id=?").run(t, t, id);
};
let pass = 0, fail = 0;
const t = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "✅" : "❌") + " " + name + (extra ? " — " + extra : "")); };

// 1) 写入四类
const rPref = await call("memory_remember", { content: "测试偏好：喜欢深色主题", kind: "preference" });
const rFact = await call("memory_remember", { content: "测试事实：记忆服务跑在 7640 端口", kind: "fact" });
const rEpi = await call("memory_remember", { content: "测试会话：某天调试了休眠逻辑", kind: "episode" });
const rTodo = await call("memory_remember", { content: "测试待办：给大肥鱼买鱼粮", kind: "todo" });
t("四类记忆写入", [rPref, rFact, rEpi, rTodo].every((s) => s.startsWith("OK")));
const P = idOf(rPref), F = idOf(rFact), E = idOf(rEpi), T = idOf(rTodo);

// 2) 召回埋点（fact 命中）
await call("memory_recall", { query: "记忆服务 端口" });
const h = db().prepare("SELECT hit_count, last_hit_at FROM memories WHERE id=?").get(F);
t("recall 命中埋点", h.hit_count >= 1 && !!h.last_hit_at, `hit_count=${h.hit_count}`);

// 3) 年龄设定：pref 200d(<240 存活) / fact 125d(>120 但命中延期7d → 存活) / epi 61d(>60 休眠) / todo 46d(>45 但置顶保护)
ageDays(P, 200); ageDays(F, 125); ageDays(E, 61); ageDays(T, 46);
const pinR = await call("memory_pin", { id: T, action: "pin" });
t("置顶待办", pinR.startsWith("OK"), pinR);

// 4) 手动 sleep pass
const sl = await call("memory_sleep", {});
t("sleep pass 只休眠 episode", new RegExp("休眠 1 条").test(sl) && sl.includes(String(E)), sl);
const st = (id) => db().prepare("SELECT status, pinned, hit_count FROM memories WHERE id=?").get(id);
t("episode → dormant", st(E).status === "dormant");
t("fact 靠命中延期存活", st(F).status === "active", JSON.stringify(st(F)));
t("preference 宽限内存活", st(P).status === "active");
t("todo 置顶保护存活", st(T).status === "active" && st(T).pinned === 1);

// 5) dormant 不被召回
const rc2 = await call("memory_recall", { query: "测试会话" });
t("休眠条目不再被召回", !String(rc2).includes(String(E)), String(rc2).slice(0, 50));

// 6) 唤醒
const wk = await call("memory_pin", { id: E, action: "wake" });
t("唤醒 episode", wk.startsWith("OK") && st(E).status === "active", wk);
const rc3 = await call("memory_recall", { query: "测试会话" });
t("唤醒后可再次召回", String(rc3).includes(String(E)), String(rc3).slice(0, 50));

// 7) 取消置顶 → 二次 sleep → todo 休眠；current.md 同步移除
await call("memory_pin", { id: T, action: "unpin" });
const sl2 = await call("memory_sleep", {});
t("取消置顶后 todo 休眠", new RegExp("休眠 1 条").test(sl2) && sl2.includes(String(T)), sl2);
const cur = fs.readFileSync(path.join(MEM_DIR, "current.md"), "utf8");
t("current.md 移除休眠条目", !cur.includes("鱼粮"));

// 8) 对休眠记忆置顶 = 唤醒 + 置顶
const pinD = await call("memory_pin", { id: T, action: "pin" });
const stT = st(T);
t("置顶休眠记忆=唤醒+置顶", pinD.startsWith("OK") && stT.status === "active" && stT.pinned === 1, pinD);

// 9) 审计日志
const log = fs.readFileSync(path.join(MEM_DIR, "log.jsonl"), "utf8");
t("审计含 sleep_pass/pin/wake", ["sleep_pass", '"op":"pin"', '"op":"wake"'].every((k) => log.includes(k)));

// 10) schema 校验
const sql = db().prepare("SELECT sql FROM sqlite_master WHERE name='memories'").get().sql;
t("schema 含 dormant 与新列", sql.includes("dormant") && sql.includes("hit_count") && sql.includes("pinned"));

console.log(`\n${pass} passed, ${fail} failed`);
await c.close();
process.exit(fail ? 1 : 0);
