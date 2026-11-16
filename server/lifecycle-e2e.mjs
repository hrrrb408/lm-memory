#!/usr/bin/env node
// lifecycle-e2e.mjs — v0.15 生命周期修复回归（外审实锁三项 + 统一提交入口）。
// 覆盖：correct 保留 pinned / forget 可删 dormant / hard 物理擦除 / event_date 不被管理操作推移。
// 用法: LM_MEMORY_DIR=<空目录> node lifecycle-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rmEvalDir } from "../scripts/eval/eval-dir-guard.mjs";
const MEM_DIR = process.env.LM_MEMORY_DIR;
if (!MEM_DIR || MEM_DIR === path.join(process.env.HOME, ".dsh", "memory") || MEM_DIR === path.join(process.env.HOME, ".lm-memory")) {
  console.error("拒绝在真实库上跑测试"); process.exit(2);
}
const DB = path.join(MEM_DIR, "memory.db");
rmEvalDir(MEM_DIR); // 守卫：realpath 级拒绝生产路径（v0.15.1 收敛）
fs.mkdirSync(MEM_DIR, { recursive: true });

const c = new Client({ name: "lifecycle-e2e", version: "0.15" });
await c.connect(new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./memory-server.mjs", import.meta.url))],
  env: { ...process.env, LM_MEMORY_DIR: MEM_DIR, LM_EMBED: "0" },
}));
const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content[0].text;
const db = () => new DatabaseSync(DB, { readOnly: true });
const idOf = (s) => Number(String(s).match(/id=(\d+)/)[1]);
let pass = 0, fail = 0;
const t = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "✅" : "❌") + " " + name + (extra ? " — " + extra : "")); };

// 1) 写入并置顶
const r1 = await call("memory_remember", { content: "雷区条目：不猜、诚实直说", kind: "preference" });
const id = idOf(r1);
await call("memory_pin", { id, action: "pin" });
t("写入并置顶", db().prepare("SELECT pinned FROM memories WHERE id=?").get(id).pinned === 1);

// 2) correct 必须继承 pinned（外审实锤：曾静默重置为 0）
const r2 = await call("memory_correct", { id, expected_version: 1, content: "雷区条目：不猜、诚实直说、讨论不等于指令" });
const nid = idOf(r2);
const nv = db().prepare("SELECT pinned, event_date, supersedes FROM memories WHERE id=?").get(nid);
t("correct 新版本继承 pinned", nv.pinned === 1, `pinned=${nv.pinned}`);
t("correct 新版本指向旧条", nv.supersedes === id);

// 3) event_date 稳定性：correct / wake 都不推移事件锚
const ed1 = nv.event_date;
const today = new Date().toISOString().slice(0, 10);
t("event_date 回填自 created_at", !!ed1 && ed1.length === 10, `event_date=${ed1}`);

// 4) 制造 dormant：把一条 todo 年龄改到超期再跑 sleep pass
const r3 = await call("memory_remember", { content: "测试待办：旧事一桩", kind: "todo" });
const tid = idOf(r3);
const old = new Date(Date.now() - 60 * 86400000).toISOString();
new DatabaseSync(DB).prepare("UPDATE memories SET created_at=?, updated_at=? WHERE id=?").run(old, old, tid);
const sl = await call("memory_sleep", {});
t("超期 todo 转入休眠", db().prepare("SELECT status FROM memories WHERE id=?").get(tid).status === "dormant", sl);

// 5) dormant 可直接 forget（外审实锤：曾报「不存在或已删除」）
const f1 = await call("memory_forget", { id: tid, reason: "测试休眠删除" });
t("dormant 可逻辑删除", f1.startsWith("OK"), f1);

// 6) dormant（再造一条）可 hard 物理擦除
const r4 = await call("memory_remember", { content: "测试待办：另一桩旧事", kind: "todo" });
const tid2 = idOf(r4);
new DatabaseSync(DB).prepare("UPDATE memories SET created_at=?, updated_at=? WHERE id=?").run(old, old, tid2);
await call("memory_sleep", {});
const f2 = await call("memory_forget", { id: tid2, reason: "测试物理擦除", hard: true });
const gone = db().prepare("SELECT id FROM memories WHERE id=?").get(tid2);
t("hard=true 物理擦除（行消失）", f2.startsWith("OK") && !gone, f2);
const log = fs.readFileSync(path.join(MEM_DIR, "log.jsonl"), "utf8");
t("hard 删除进审计", log.includes('"hard":true'));

// hard 擦除契约（复核实锤旧版被 active/dormant 过滤挡住）：
const r6 = await call("memory_remember", { content: "擦除链测试：先软删再硬删的条目", kind: "fact" });
const sid1 = idOf(r6);
await call("memory_forget", { id: sid1, reason: "先软删" });
const f3 = await call("memory_forget", { id: sid1, reason: "软删后硬删", hard: true });
t("soft 删除后 hard=true 可擦除", f3.startsWith("OK") && !db().prepare("SELECT id FROM memories WHERE id=?").get(sid1), f3);
const r7 = await call("memory_remember", { content: "擦除链测试：原版将被修正接棒", kind: "fact" });
const sid2 = idOf(r7);
await call("memory_correct", { id: sid2, expected_version: 1, content: "擦除链测试：修正版已接棒" });
const f4 = await call("memory_forget", { id: sid2, reason: "历史版本擦除", hard: true });
t("superseded 历史行可 hard 擦除", f4.startsWith("OK") && !db().prepare("SELECT id FROM memories WHERE id=?").get(sid2), f4);
const chLines = fs.readFileSync(path.join(MEM_DIR, "changes.jsonl"), "utf8").split("\n").filter(Boolean).reverse();
const lastHard = chLines.find((l) => l.includes('"hard":true'));
t("hard 删除事件不携带被删原文（复核实锤旧版重新复制内容）", !!lastHard && !("content" in JSON.parse(lastHard)), lastHard ? lastHard.slice(0, 90) : "none");
const lastSoft = chLines.find((l) => l.includes('"op":"forget"') && !l.includes('"hard":true'));
t("soft 删除事件不携带被删原文（v0.15.2 收窄）", !!lastSoft && !("content" in JSON.parse(lastSoft)), lastSoft ? lastSoft.slice(0, 90) : "none");

// correct 事务原子性（复核实锤：correct 内容提交却事件为零）：
// 注入 BEFORE INSERT trigger 让 op=correct 的 outbox 写入失败 → 内容变更必须一起回滚
{
  const inj = new DatabaseSync(DB);
  inj.exec("CREATE TRIGGER inject_correct_outbox_fail BEFORE INSERT ON outbox WHEN NEW.op='correct' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  const r8 = await call("memory_remember", { content: "原子性测试：将被修正的条目", kind: "fact" });
  const aid = idOf(r8);
  const resp = await call("memory_correct", { id: aid, expected_version: 1, content: "原子性测试：修正后的条目" });
  t("correct 事件失败 → 内容回滚（旧行仍 active、无新行）",
    !String(resp).startsWith("OK") && db().prepare("SELECT status FROM memories WHERE id=?").get(aid)?.status === "active"
    && db().prepare("SELECT 1 FROM memories WHERE content='原子性测试：修正后的条目'").get() === undefined,
    String(resp).slice(0, 60));
  t("correct 事件失败 → outbox 无 correct 事件", db().prepare("SELECT count(*) n FROM outbox WHERE op='correct'").get().n === 0);
  inj.exec("DROP TRIGGER inject_correct_outbox_fail");
  const resp2 = await call("memory_correct", { id: aid, expected_version: 1, content: "原子性测试：修正后的条目" });
  t("移除注入后 correct 成功且事件在场", String(resp2).startsWith("OK") && db().prepare("SELECT count(*) n FROM outbox WHERE op='correct'").get().n === 0 && fs.readFileSync(path.join(MEM_DIR, "changes.jsonl"), "utf8").includes('"op":"correct"'));
  inj.close();
}

// 7) recall 的 date 字段 = event_date（管理操作后不变）
const rec = await call("memory_recall", { id: nid });
let dateField = null;
try { dateField = JSON.parse(rec)[0].date; } catch {}
t("recall date=event_date", dateField === ed1, `date=${dateField} event_date=${ed1}`);

// 8) 唤醒不推移事件锚：解除置顶 → 年龄改到 300 天前并清 last_hit_at（recall 会续租，须一并老化）→ sleep 休眠 → wake，event_date 应保持
const old300 = new Date(Date.now() - 300 * 86400000).toISOString();
await call("memory_pin", { id: nid, action: "unpin" });
new DatabaseSync(DB).prepare("UPDATE memories SET updated_at=?, last_hit_at=NULL WHERE id=?").run(old300, nid);
await call("memory_sleep", {});
t("偏好条目超期休眠", db().prepare("SELECT status FROM memories WHERE id=?").get(nid).status === "dormant");
const wk = await call("memory_pin", { id: nid, action: "wake" });
const afterWake = db().prepare("SELECT event_date, status FROM memories WHERE id=?").get(nid);
t("wake 后 event_date 不变", wk.startsWith("OK") && afterWake.status === "active" && afterWake.event_date === ed1, `event_date=${afterWake.event_date}`);

// 9) event_date 列存在（schema）
const sql = db().prepare("SELECT sql FROM sqlite_master WHERE name='memories'").get().sql;
t("schema 含 event_date", sql.includes("event_date"));

// 10) 零命中召回带休眠馆提示（发现死角缓解）：先制造一条保持休眠的条目
const r5 = await call("memory_remember", { content: "测试待办：休眠留守员", kind: "todo" });
const tid3 = idOf(r5);
new DatabaseSync(DB).prepare("UPDATE memories SET created_at=?, updated_at=? WHERE id=?").run(old, old, tid3);
await call("memory_sleep", {});
t("留守员保持休眠", db().prepare("SELECT status FROM memories WHERE id=?").get(tid3).status === "dormant");
const empty = await call("memory_recall", { query: "完全无关的天文黑洞词汇表" });
t("零命中提示休眠馆", empty.includes("休眠") || empty.includes("dormant"), empty.slice(0, 80));

console.log(`\n${pass} passed, ${fail} failed`);
await c.close();
process.exit(fail ? 1 : 0);
