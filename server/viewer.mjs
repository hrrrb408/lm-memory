#!/usr/bin/env node
// lm-memory viewer —— 本地记忆管理页（薄壳：业务逻辑全部经 MCP 走 memory-server）
// 用法: node viewer.mjs [端口=7640]   只绑 127.0.0.1，本机个人工具
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { findConflictPairs, buildReviewPrompt, parseReview } from "./conflict.mjs";

const PORT = Number(process.argv[2] || 7640);
const MEM_DIR = process.env.LM_MEMORY_DIR || path.join(os.homedir(), ".dsh", "memory");
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "memory-server.mjs");
const DB_PATH = path.join(MEM_DIR, "memory.db");
// v0.10：包版本（读包根 package.json），/api/version 端点暴露——插件据此自动升级旧 viewer
const PKG_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version || "0.0.0"; } catch { return "0.0.0"; } })();

let mcp = null;
async function call(name, args) {
  if (!mcp) {
    mcp = new Client({ name: "viewer", version: "0.1" });
    await mcp.connect(new StdioClientTransport({
      command: process.execPath, args: [SERVER],
      env: { ...process.env, LM_MEMORY_DIR: MEM_DIR },
    }));
  }
  try {
    const r = await mcp.callTool({ name, arguments: args });
    const t = r.content?.[0]?.text ?? "[]";
    try { return JSON.parse(t); } catch { return t; }
  } catch (e) { mcp = null; throw e; }
}
const ro = () => new DatabaseSync(DB_PATH, { readOnly: true });
const rw = () => { const d = new DatabaseSync(DB_PATH); d.exec("PRAGMA busy_timeout=5000;"); return d; };
const ZAI_KEY = () => fs.readFileSync(path.join(os.homedir(), ".dsh/.credentials.yaml"), "utf8").match(/ZAI_CODING_CN_API_KEY:\s*(\S+)/)?.[1];
async function llm(prompt) {
  if (process.env.LM_REMOTE_DISABLED === "1") return ""; // v0.15.1 系统级禁外发：本地模式下画像/冲突复核降级为空结果，不外呼
  const key = ZAI_KEY(); if (!key) return "";
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: prompt }], max_tokens: 8000, temperature: 0.2 }),
      });
      const t = (await r.json()).choices?.[0]?.message?.content ?? "";
      if (t) return t;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "";
}
async function genProfile() {
  const all = await call("memory_list", { limit: 1000 });
  const body = all.map((m) => `[${m.kind}] ${m.content}`).join("\n").slice(0, 30000);
  const out = await llm(`以下是一个记忆系统中关于某用户的全部记忆。请生成一份克制的用户画像：
- 第一段：一句话概括这个人（客观，不吹捧，50字内）
- 然后四个小节：**身份与环境** / **偏好与沟通风格** / **正在做的事** / **待办提醒**（有的话）
- 只用记忆里有的信息，不推测；信息少就少写
- 学业/学位表述必须逐字对齐记忆原文（如「大四」「延毕」「答辩通过」），**严禁升格或脑补学位**（禁止把本科大四写成硕士/研究生毕业）；人名/署名同理逐字对齐
- 结尾列 6-12 个关键词 chips（用、分隔）

记忆库：
${body}`);
  const rec = { summary: out.trim(), generated_at: new Date().toISOString() };
  try { const d = rw(); d.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('profile', ?)").run(JSON.stringify(rec)); } catch {}
  return rec;
}
function cachedProfile() {
  try { return JSON.parse(ro().prepare("SELECT value FROM meta WHERE key='profile'").get()?.value ?? "null"); } catch { return null; }
}

// ---- v0.14.2 冲突候选复核（结论缓存于 meta 表，误报对只复核一次）----
// 扫描走只读连接（conflict.mjs 纯函数）；复核走 viewer 自己的 llm 通道；
// 结论 key=conflict_review:<loId>-<hiId>，附两侧 updated_at——任一侧内容变更即缓存失效重审。
const CONFLICT_CACHE_PREFIX = "conflict_review:";
const conflictReviewVerdict = (oldR, newR) => {
  const key = CONFLICT_CACHE_PREFIX + Math.min(oldR.id, newR.id) + "-" + Math.max(oldR.id, newR.id);
  try {
    const v = JSON.parse(ro().prepare("SELECT value FROM meta WHERE key=?").get(key)?.value ?? "null");
    if (!v || v.verdict === undefined) return null;
    if (v.old_at !== String(oldR.updated_at) || v.new_at !== String(newR.updated_at)) return null; // 内容变过，重审
    return v.verdict;
  } catch { return null; }
};
const saveConflictReview = (oldR, newR, verdict) => {
  const key = CONFLICT_CACHE_PREFIX + Math.min(oldR.id, newR.id) + "-" + Math.max(oldR.id, newR.id);
  try {
    rw().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, JSON.stringify({
      verdict, old_at: String(oldR.updated_at), new_at: String(newR.updated_at), reviewed_at: new Date().toISOString(),
    }));
  } catch {}
};
// 带缓存的复核：返回 { total, needAction, pairs:[{...p, verdict}] }；llm 不可用时 verdict 全为 null（未复核）
async function conflictCandidates() {
  const r = findConflictPairs(ro(), { maxPairs: 20 });
  const pairs = r.pairs.map((p) => ({ ...p, verdict: conflictReviewVerdict(p.old, p.new) }));
  const pending = pairs.filter((p) => p.verdict === null);
  if (pending.length && llmAvailable()) {
    const raw = await llm(buildReviewPrompt(pending));
    const verdicts = parseReview(raw, pending.length);
    if (verdicts) {
      verdicts.forEach((v, idx) => {
        const p = pending[idx];
        if (!p) return;
        p.verdict = v.verdict;
        saveConflictReview(p.old, p.new, v.verdict);
      });
      // 未拿到判定的残余（模型漏答）保持 null
    }
  }
  return {
    total: pairs.length,
    needAction: pairs.filter((p) => p.verdict === "superseded").length,
    unreviewed: pairs.filter((p) => p.verdict === null).length,
    pairs,
  };
}
function llmAvailable() { try { return !!ZAI_KEY(); } catch { return false; } }

const KIND_META = {
  preference: ["偏好", "#c8402e"], fact: ["事实", "#2563eb"], procedure: ["经验", "#0f766e"],
  todo: ["待办", "#b45309"], episode: ["会话索引", "#71717a"],
};

const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆库 · lm-memory</title><style>
:root{--ink:#1c1917;--muted:#78716c;--line:#e7e5e4;--bg:#fafaf9;--card:#fff;--accent:#c8402e}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"PingFang SC","Helvetica Neue",sans-serif;background:var(--bg);color:var(--ink);padding:36px clamp(16px,4vw,56px);line-height:1.6}
header{max-width:860px;margin:0 auto 28px}
h1{font-family:"Songti SC",Georgia,serif;font-size:30px;font-weight:500;letter-spacing:.02em}
.sub{color:var(--muted);font-size:13px;margin-top:6px}
.stats{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.chip{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:4px 12px;font-size:12.5px;color:var(--muted)}
.chip b{font-weight:600}
.chip.on{border-color:var(--ink);color:var(--ink)}
.bar{max-width:860px;margin:0 auto 18px;display:flex;gap:10px}
input[type=search]{flex:1;border:1px solid var(--line);background:var(--card);border-radius:10px;padding:10px 14px;font-size:14px;outline:none}
input[type=search]:focus{border-color:var(--ink)}
main{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:10px}
.mem{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.mem .top{display:flex;gap:8px;align-items:center;margin-bottom:6px}
.badge{font-size:11px;padding:2px 8px;border-radius:999px;color:#fff;font-weight:500}
.meta{font-size:11.5px;color:var(--muted)}
.mem .content{font-size:14.5px;white-space:pre-wrap;overflow-wrap:anywhere}
.content-more summary,.group-more summary{cursor:pointer;color:var(--muted);font-size:12.5px;margin-top:5px}
summary:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.section-title{font-family:"Songti SC",Georgia,serif;font-size:19px;font-weight:600;margin:8px 0 0}.section-note{font-size:12.5px;color:var(--muted)}
.profile-content{min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}.group-more .plist{margin-top:8px}
@media(max-width:680px){body{padding:24px 16px}nav{flex-wrap:wrap}.acts{flex-wrap:wrap}.prow{flex-wrap:wrap}.genbar{flex-wrap:wrap}}
.mem .acts{margin-top:10px;display:flex;gap:12px;font-size:12.5px}
.acts a{color:var(--muted);cursor:pointer;text-decoration:underline dotted}
.acts a:hover{color:var(--ink)}
.acts .danger:hover{color:var(--accent)}
.editbox{width:100%;margin-top:8px;border:1px solid var(--ink);border-radius:8px;padding:8px 10px;font:inherit;font-size:14px}
.hist{margin-top:10px;border-top:1px dashed var(--line);padding-top:8px;font-size:13px;color:var(--muted)}
.hist .old{text-decoration:line-through;opacity:.6}
.sleep-note{background:#f0e9d8;border:1px solid #e0d6bd;border-radius:8px;padding:9px 13px;font-size:13px;color:#5c5546;margin-bottom:12px;overflow-wrap:anywhere}
.empty{max-width:860px;margin:40px auto;text-align:center;color:var(--muted);font-size:14px}
footer{max-width:860px;margin:28px auto 0;color:var(--muted);font-size:12px;text-align:center}
nav{max-width:860px;margin:-14px auto 16px;display:flex;gap:2px;font-size:13.5px}
nav a{padding:6px 14px;border-radius:8px;cursor:pointer;color:var(--muted)}
nav a.on{background:var(--ink);color:#fff}
#profile{max-width:860px;margin:0 auto;display:none;flex-direction:column;gap:14px}
#dormant{max-width:860px;margin:0 auto;display:none;flex-direction:column;gap:10px}
.pcard{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px}
.pcard h3{font-family:"Songti SC",Georgia,serif;font-size:16px;font-weight:600;margin-bottom:10px;color:var(--ink)}
.psummary{white-space:pre-wrap;font-size:14.5px;line-height:1.8}
.psummary strong{font-family:"Songti SC",Georgia,serif}
.pchips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.pchips span{border:1px solid var(--line);border-radius:999px;padding:3px 12px;font-size:12.5px;color:var(--muted)}
.plist{display:flex;flex-direction:column;gap:8px}
.prow{display:flex;gap:10px;font-size:14px;align-items:baseline}
.prow .dot{width:6px;height:6px;border-radius:50%;flex:none;position:relative;top:-2px}
.prow .when{color:var(--muted);font-size:12px;flex:none}
.genbar{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.genbar button{background:var(--ink);color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer}
.genbar .meta{font-size:12px;color:var(--muted)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:680px){.two{grid-template-columns:1fr}}
button{font:inherit}
/* 图谱：沿用纸感色系，信息清晰优先于装饰。 */
.graph-head{display:flex;justify-content:space-between;align-items:end;gap:16px;margin:8px 0 18px}
.graph-head h2{font:600 25px/1.3 "Songti SC",Georgia,serif;letter-spacing:.04em}.graph-head p{color:#777267;font-size:13px;margin-top:5px}.graph-count{font-size:12px;color:#746f65;font-variant-numeric:tabular-nums;white-space:nowrap}
.graph-tools{display:flex;align-items:center;flex-wrap:wrap;gap:10px 14px;margin-bottom:12px}.graph-tools input[type=search]{min-width:180px;padding:9px 12px}.graph-relations{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.graph-relations label,.graph-min{font-size:12px;color:#625f58;display:inline-flex;align-items:center;gap:4px}.graph-tools button,.graph-min select{border:1px solid #e2ded4;background:#fffefa;border-radius:8px;padding:7px 10px;color:#514d46;cursor:pointer}.graph-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:0 0 12px;color:#716d64;font-size:12px}.graph-legend span{display:inline-flex;align-items:center;gap:6px}.graph-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dot)}
#gcanvas{overflow:auto;border:1px solid #e4ded1;border-radius:14px;background:#f7f4ee}#gcanvas svg{display:block;max-width:none}.graph-foot{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;color:#777267;font-size:12px;margin-top:9px}#gbar{padding:10px 12px;background:#f2eee5;border-radius:8px;margin-top:10px}
@media(max-width:680px){.graph-head{align-items:start;flex-direction:column;gap:5px}.graph-tools input[type=search]{flex-basis:100%}}
</style></head><body>
<header><h1>记忆库</h1><div class="sub" id="sub"></div><div class="stats" id="stats"></div></header>
<nav><a id="tabList" class="on" onclick="showView('list')">记忆库</a><a id="tabProfile" onclick="showView('profile')">画像</a><a id="tabDormant" onclick="showView('dormant')">休眠馆</a><a id="tabGraph" onclick="showView('graph')">图谱</a></nav>
<div class="bar" id="searchbar"><input id="q" type="search" placeholder="搜索记忆（走完整检索管线：词法 + 中文语义）…"></div>
<main id="list"></main>
<div id="profile"></div>
<div id="dormant"></div>
<div id="graph" style="max-width:860px;margin:0 auto;display:none"></div>
<div class="empty" id="empty" style="display:none">没有匹配的记忆</div>
<footer>lm-memory viewer · 数据在 ${MEM_DIR} · 操作走 MCP 同一套业务逻辑</footer>
<script>
const K = ${JSON.stringify(KIND_META)};
let filter = null, query = "";
const fullContents = new Map();
const $ = (s) => document.querySelector(s);
async function load() {
  const p = new URLSearchParams();
  if (filter) p.set("kind", filter);
  if (query) p.set("q", query);
  const r = await fetch("/api/memories?" + p);
  const d = await r.json();
  $("#sub").textContent = d.total + " 条有效记忆 · 版本化 · 逻辑删除可审计";
  $("#stats").innerHTML = Object.entries(d.counts).map(([k, n]) =>
    \`<span class="chip \${filter === k ? "on" : ""}" data-k="\${k}"><b style="color:\${K[k]?.[1]}">\${K[k]?.[0] ?? k}</b> \${n}</span>\`).join("")
    + \`<span class="chip \${!filter ? "on" : ""}" data-k="">全部 \${d.total}</span>\`;
  d.items.forEach((m) => { versions[m.id] = m.version ?? m.v; fullContents.set(m.id, m.content); });
  $("#list").innerHTML = d.items.map((m) => memCard(m)).join("");
  $("#empty").style.display = d.items.length ? "none" : "block";
}
const memCard = (m) => {
  const [label, color] = K[m.kind] ?? [m.kind, "#666"];
  return \`<div class="mem" id="m\${m.id}">
    <div class="top"><span class="badge" style="background:\${color}">\${label}</span>
    <span class="meta">v\${m.version} · \${(m.date || "").slice(0, 10)} \${m.source === "auto-extract" ? "· 自动提炼" : m.source === "auto-capture" ? "· 自动采集" : ""}\${m.pinned ? " · 📌" : ""}\${m.hit_count ? " · 召回×" + m.hit_count : ""}</span></div>
    <div class="content">\${foldContent(m.content)}</div>
    \${m.tags ? \`<div class="meta" style="margin-top:4px">#\${esc(m.tags.split(",").filter(t=>!t.startsWith("session:")).join(" #"))}</div>\` : ""}
    <div class="acts"><a onclick="correct(\${m.id})">修正</a><a class="danger" onclick="forget(\${m.id})">忘记</a><a onclick="hist(\${m.id})">历史</a><a onclick="pin(\${m.id}, \${m.pinned ? 0 : 1})">\${m.pinned ? "取消置顶" : "📌 置顶"}</a></div>
    <div id="extra\${m.id}"></div>
  </div>\`;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const foldContent = (text) => {
  const chars = Array.from(String(text));
  if (chars.length <= 180) return esc(text);
  return esc(chars.slice(0, 180).join("")) + '<details class="content-more"><summary>展开余下内容</summary>' + esc(chars.slice(180).join("")) + "</details>";
};
window.correct = async (id) => {
  const el = $("#extra" + id);
  if (el.dataset.on) { el.innerHTML = ""; delete el.dataset.on; return; }
  el.dataset.on = "1";
  const m = fullContents.get(id) ?? "";
  el.innerHTML = \`<textarea class="editbox" rows="2">\${esc(m)}</textarea><div style="margin-top:6px"><button onclick="doCorrect(\${id})">保存新版本</button> <span class="meta">（生成 v+1，旧版保留可审计）</span></div>\`;
};
window.doCorrect = async (id) => {
  const box = $("#extra" + id).querySelector("textarea");
  const r = await (await fetch("/api/correct", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, expected_version: curVersion(id), content: box.value }) })).json();
  alert(r.ok ? "已修正：" + r.msg : "失败：" + r.msg);
  load();
};
const versions = {};
window.curVersion = (id) => versions[id];
window.forget = async (id) => {
  if (!confirm("逻辑删除这条记忆？（不再被召回，保留审计）")) return;
  await fetch("/api/forget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
  load();
};
window.hist = async (id) => {
  const el = $("#extra" + id);
  if (el.dataset.h) { el.innerHTML = ""; delete el.dataset.h; return; }
  el.dataset.h = "1";
  const h = await (await fetch("/api/history/" + id)).json();
  el.innerHTML = h.length <= 1 ? '<div class="hist">无历史版本</div>' :
    h.map((v) => \`<div class="hist \${v.status === "superseded" ? "old" : ""}">v\${v.version} · \${v.status} · \${v.updated_at.slice(0, 10)}<br>\${foldContent(v.content)}</div>\`).join("");
};
window.pin = async (id, to) => { await fetch("/api/lifecycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: to ? "pin" : "unpin" }) }); if ($("#dormant").style.display !== "none") loadDormant(); else load(); };
window.wake = async (id) => { await fetch("/api/lifecycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: "wake" }) }); loadDormant(); };
let sleepNote = "";
window.runSleep = async () => {
  try {
    const r = await (await fetch("/api/sleep", { method: "POST" })).json();
    sleepNote = r.msg || "整理完成";
  } catch (e) {
    sleepNote = "整理失败：" + (e?.message ?? e);
  }
  loadDormant(); // 渲染时统一带上提示条，避免先插后冲
};
// 冲突候选复核（异步填充 #conflictbox；结论缓存在 meta，误报对只复核一次）
window.loadConflicts = async () => {
  const box = $("#conflictbox");
  if (!box) return;
  try {
    const d = await (await fetch("/api/conflicts")).json();
    if (!d.total) { box.innerHTML = '<div class="content"><span class="meta">冲突扫描：没有疑似过时的候选对，库是干净的。</span></div>'; return; }
    if (d.unreviewed > 0) { box.innerHTML = '<div class="content"><span class="meta">冲突扫描：' + d.total + ' 对候选，其中 ' + d.unreviewed + ' 对待复核（无模型通道，稍后再试）。</span></div>'; return; }
    const superseded = d.pairs.filter((p) => p.verdict === "superseded");
    const row = (p) => '<div class="prow"><span class="dot" style="background:' + (KCOL[p.old.kind] ?? "#666") + '"></span><div class="profile-content">#' + p.old.id + " " + esc(p.old.snippet) + " → 建议 #" + p.new.id + " 接棒</div></div>";
    box.innerHTML = d.needAction === 0
      ? '<div class="content"><span class="meta">冲突扫描：' + d.total + " 对候选已复核，均无需处置（相关或纯相似，非过时）。</span></div>"
      : '<div class="content"><span class="meta">冲突扫描：复核后 ' + d.needAction + " 对疑似真过时：</span><div class='plist'>" + superseded.map(row).join("") + "</div><span class='meta'>确认后可在记忆库列表给旧条补「已过时，见新条」指针。</span></div>";
  } catch (e) {
    box.innerHTML = '<div class="content"><span class="meta">冲突复核失败：' + esc(String(e?.message ?? e)) + "</span></div>";
  }
};
window.loadDormant = async () => {
  const d = await (await fetch("/api/dormant")).json();
  const el = $("#dormant");
  // 冲突区块：先渲染占位（复核中），复核完成后替换为结论
  const conflictHtml = '<div class="mem" id="conflictbox"><div class="content"><span class="meta">冲突扫描复核中…</span></div></div>';
  el.innerHTML = (sleepNote ? '<div class="sleep-note">' + esc(sleepNote) + '</div>' : '')
    + conflictHtml
    + '<div class="mem"><div class="content">休眠馆：长期未被召回的记忆自动转到这里，不再参与检索与 current.md 基线，但随时可唤醒。宽限期：待办45天 · 会话60天 · 事实/经验120天 · 偏好240天（命中延期+7天/次）<div class="acts"><a onclick="runSleep()">🔄 跑一次整理</a></div></div></div>'
    + (d.items.length ? d.items.map((m) => {
      const [label, color] = K[m.kind] ?? [m.kind, "#666"];
      return \`<div class="mem" style="opacity:.75"><div class="top"><span class="badge" style="background:\${color}">\${label}</span><span class="meta">休眠于 \${(m.updated_at || "").slice(0, 10)}\${m.hit_count ? " · 曾召回×" + m.hit_count : ""}</span></div><div class="content">\${foldContent(m.content)}</div><div class="acts"><a onclick="wake(\${m.id})">☀️ 唤醒</a><a onclick="pin(\${m.id}, 1)">📌 置顶并唤醒</a></div></div>\`;
    }).join("") : '<div class="empty">没有休眠记忆 🎉</div>');
  loadConflicts(); // 异步填充冲突复核区块
};
$("#stats").addEventListener("click", (e) => { const k = e.target.closest(".chip")?.dataset.k; if (k === undefined) return; filter = k || null; load(); });
window.showView = (v) => {
  for (const t of ["List", "Profile", "Dormant", "Graph"]) $("#tab" + t).classList.toggle("on", v === t.toLowerCase());
  $("#searchbar").style.display = v === "list" ? "flex" : "none";
  $("#list").style.display = v === "list" ? "flex" : "none";
  $("#profile").style.display = v === "profile" ? "flex" : "none";
  $("#dormant").style.display = v === "dormant" ? "flex" : "none";
  $("#graph").style.display = v === "graph" ? "block" : "none";
  if (v === "profile") loadProfile();
  if (v === "dormant") loadDormant();
  if (v === "graph") loadGraph();
};
// v0.12.2 图谱视觉（纸感路线，对齐爹 proven 审美：LifeOS 文人版/rushdeck 文人版的宣纸墨字系）
// 画布=暖米白宣纸，节点=莫兰迪低饱和，边=墨色细线（铅笔稿感），分区聚簇+hover 聚焦保留
const REL_COLOR = { similar: "#9a8fb8", co_tag: "#7a9e8e", ref: "#c9a227" };
const PAPER = "#f7f4ee";       // 画布宣纸底（比页面 #fafaf9 深半档，卡片感）
const INK_SOFT = "#8a8578";    // 墨灰（边）
const INK_TXT = "#57534e";     // 墨字（标签）
// 莫兰迪节点色（只用于图谱页，不碰全页共用 KIND_META——列表页 badge 保持原色）
const NODE_COLOR = { preference: "#c26d5c", fact: "#5b7fa6", procedure: "#6f9c8a", todo: "#d9a05b", episode: "#b3ada0" };
window.loadGraph = async () => {
  const d = await (await fetch("/api/graph")).json();
  const el = $("#graph");
  const statsTxt = d.nodes.length + " 节点 · " + d.links.length + " 边";
  const relNames = { similar: "语义相似", co_tag: "共同标签", ref: "相互引用" };
  el.innerHTML = '<div class="graph-head"><div><h2>记忆之间</h2><p>一条记忆，可能连接着另一段故事。</p></div><span class="graph-count">' + statsTxt + '</span></div>'
    + '<div class="graph-tools"><input id="gq" type="search" aria-label="搜索图谱节点" placeholder="搜索节点摘要，点亮关联节点…">'
    + '<span id="grep" class="graph-relations">' + ["similar", "co_tag", "ref"].map((r) =>
        '<label><input type="checkbox" checked data-rel="' + r + '" style="accent-color:' + REL_COLOR[r] + '">' + relNames[r] + '</label>').join("") + '</span>'
    + '<label class="graph-min">最少连接 <select id="gmin"><option>0</option><option>1</option><option>2</option><option>3</option></select></label>'
    + '<button id="greset" type="button">复位视图</button></div>'
    + '<div class="graph-legend">' + ["fact", "procedure", "episode", "preference", "todo"].map((k) => '<span><i style="--dot:' + NODE_COLOR[k] + '"></i>' + K[k][0] + '</span>').join("") + '</div>'
    + '<div id="gcanvas"></div>'
    + '<div class="graph-foot"><span>拖动节点或背景 · 滚轮缩放 · 点击节点查看关联</span><span>节点大小代表连接数量</span></div>'
    + '<div id="gbar" style="display:none"><span class="meta" id="gtip"></span></div>';
  const wrap = $("#gcanvas");
  const W = Math.max(wrap.clientWidth - 2 || 858, 600), H = 680;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", W); svg.setAttribute("height", H);
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.style.cssText = "background:" + PAPER + ";touch-action:pan-y;display:block";
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "记忆关系图，节点按记忆类型着色");

  // 初始布局：kind 五簇分区（簇心均匀分布在大圆上，簇内高斯散布）→ 聚簇感先于力导
  const kinds = ["fact", "procedure", "episode", "preference", "todo"];
  const centers = {};
  kinds.forEach((k, i) => { const a = 2 * Math.PI * i / kinds.length - Math.PI / 2; centers[k] = { x: W / 2 + (Math.min(W, H) * 0.33) * Math.cos(a), y: H / 2 + (Math.min(W, H) * 0.33) * Math.sin(a) }; });
  const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 2;
  const nodes = d.nodes.map((n) => {
    const c0 = centers[n.kind] || { x: W / 2, y: H / 2 };
    return { ...n, x: Math.max(20, Math.min(W - 20, c0.x + gauss() * W * 0.16)), y: Math.max(20, Math.min(H - 20, c0.y + gauss() * H * 0.20)), deg: 0 };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = d.links.map((l) => ({ ...l, s: byId.get(l.source), t: byId.get(l.target) })).filter((l) => l.s && l.t);
  for (const l of links) { l.s.deg++; l.t.deg++; }
  // 力导降温（弱斥力+弹簧，保分区感；仅高权重边参与弹簧）
  for (let step = 0; step < 260; step++) {
    const cool = 1 - step / 300;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      const d2 = dx * dx + dy * dy + 0.01;
      if (d2 > 36000) continue;
      const f = (620 / d2) * cool, dist = Math.sqrt(d2);
      dx /= dist; dy /= dist;
      a.x += dx * f; a.y += dy * f; b.x -= dx * f; b.y -= dy * f;
    }
    for (const l of links) {
      if ((l.weight || 1) < 1.5 && l.rel !== "similar") continue;
      let dx = l.t.x - l.s.x, dy = l.t.y - l.s.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (dist - 105) * 0.014 * cool;
      dx /= dist; dy /= dist;
      l.s.x += dx * f; l.s.y += dy * f; l.t.x -= dx * f; l.t.y -= dy * f;
    }
    for (const n of nodes) {
      const c0 = centers[n.kind]; // 向本簇心收拢（分区不散）
      n.x += (c0.x - n.x) * 0.012 * cool; n.y += (c0.y - n.y) * 0.012 * cool;
      n.x = Math.max(16, Math.min(W - 16, n.x)); n.y = Math.max(16, Math.min(H - 16, n.y));
    }
  }
  // 边分层：weight≥1.5 正常可见；低权重退到近隐形（信息在，视觉退后）
  const edgeLevel = (l) => ((l.weight || 1) >= 1.5 || l.rel === "similar" && (l.weight || 1) >= 0.9) ? 1 : 0;
  const lineEls = links.map((l) => {
    const ln = document.createElementNS(NS, "line");
    ln.setAttribute("x1", l.s.x); ln.setAttribute("y1", l.s.y);
    ln.setAttribute("x2", l.t.x); ln.setAttribute("y2", l.t.y);
    ln.setAttribute("stroke", REL_COLOR[l.rel] || INK_SOFT);
    ln.setAttribute("stroke-width", Math.min(0.5 + (l.weight || 1) * 0.5, 2.6));
    ln.setAttribute("stroke-opacity", edgeLevel(l) ? Math.min(0.1 + (l.weight || 1) * 0.1, 0.38) : 0.04); // 铅笔稿感：细+低透
    svg.appendChild(ln);
    return { l, el: ln, base: Number(ln.getAttribute("stroke-opacity")) };
  });
  // hub 标签：度数 top 6，左右交错挂 + 深色描边防重叠糊团
  const hubs = [...nodes].sort((a, b) => b.deg - a.deg).slice(0, 6);
  const hubSet = new Set(hubs);
  const hubSide = new Map(hubs.map((n, i) => [n.id, i % 2 === 0 ? -1 : 1]));
  // dnd/pan 手势状态在 nodeEls 构建后的交互段统一声明（闭包引用，运行时已初始化）
  const nodeEls = nodes.map((n) => {
    const g = document.createElementNS(NS, "g");
    const r = Math.min(3.5 + Math.sqrt(n.deg) * 1.9, 13);
    const cEl = document.createElementNS(NS, "circle");
    cEl.setAttribute("cx", n.x); cEl.setAttribute("cy", n.y); cEl.setAttribute("r", r);
    cEl.setAttribute("fill", NODE_COLOR[n.kind] || "#999");
    cEl.setAttribute("fill-opacity", n.kind === "episode" ? 0.6 : 0.92);
    if (n.pinned) { cEl.setAttribute("stroke", "#1c1917"); cEl.setAttribute("stroke-width", "1.6"); cEl.setAttribute("stroke-opacity", "0.85"); }
    cEl.style.cursor = "grab";
    const tip = document.createElementNS(NS, "title");
    tip.textContent = "#" + n.id + " [" + (K[n.kind]?.[0] || n.kind) + "] " + n.tip;
    g.appendChild(cEl); g.appendChild(tip); svg.appendChild(g);
    let lbl = null;
    if (hubSet.has(n)) {
      const side = hubSide.get(n.id);
      lbl = document.createElementNS(NS, "text");
      lbl.setAttribute("x", n.x + side * (r + 5)); lbl.setAttribute("y", n.y + 3.5);
      lbl.setAttribute("text-anchor", side < 0 ? "end" : "start");
      lbl.setAttribute("font-size", "11");
      lbl.setAttribute("fill", INK_TXT);
      lbl.setAttribute("paint-order", "stroke");
      lbl.setAttribute("stroke", PAPER);
      lbl.setAttribute("stroke-width", "2.6");
      lbl.textContent = n.label;
      g.appendChild(lbl);
    }
    const setPos = (x, y) => {
      cEl.setAttribute("cx", x); cEl.setAttribute("cy", y);
      if (lbl) { lbl.setAttribute("x", x + hubSide.get(n.id) * (r + 5)); lbl.setAttribute("y", y + 3.5); }
      for (const { l, el: ln } of lineEls) {
        if (l.s === n) { ln.setAttribute("x1", x); ln.setAttribute("y1", y); }
        if (l.t === n) { ln.setAttribute("x2", x); ln.setAttribute("y2", y); }
      }
    };
    cEl.addEventListener("mousedown", (ev) => { dnd.n = { n, setPos }; dnd.sx = ev.clientX; dnd.sy = ev.clientY; dnd.moved = false; ev.preventDefault(); ev.stopPropagation(); });
    cEl.addEventListener("click", () => { // 点击（非拖拽）→ 局部图谱模式切换
      if (!dnd.moved) { st.focusId = st.focusId === n.id ? null : n.id; applyState(); }
    });
    // hover 聚焦：点亮一跳，其余退场
    const focus = (on) => {
      const near = new Set([n.id]);
      for (const { l } of lineEls) {
        if (!st.relOn[l.rel]) continue;
        if (l.s === n) near.add(l.t.id);
        if (l.t === n) near.add(l.s.id);
      }
      for (const { n: o, cEl: oc } of nodeEls) {
        if (o === n) continue;
        oc.setAttribute("fill-opacity", on ? (near.has(o.id) ? 0.95 : 0.1) : (o.kind === "episode" ? 0.6 : 0.92));
      }
      for (const { l, el: ln, base } of lineEls) {
        const touch = l.s === n || l.t === n;
        ln.setAttribute("stroke-opacity", !st.relOn[l.rel] ? 0 : on ? (touch ? 0.8 : 0.03) : base);
      }
    };
    cEl.addEventListener("mouseenter", () => { if (st.focusId == null && !st.q) focus(true); });
    cEl.addEventListener("mouseleave", () => { if (st.focusId == null && !st.q) focus(false); else applyState(); });
    return { n, cEl, setPos };
  });
  // ---- v0.13 交互状态与视图（Obsidian 图谱三件套：缩放平移 / 搜索过滤 / 局部图谱）----
  const view = { k: 1, tx: 0, ty: 0 };
  const applyView = () => svg.setAttribute("viewBox", view.tx + " " + view.ty + " " + (W / view.k) + " " + (H / view.k));
  applyView();
  const toSvg = (cx, cy) => {
    const r = svg.getBoundingClientRect();
    return [view.tx + (cx - r.left) * (W / view.k) / r.width, view.ty + (cy - r.top) * (H / view.k) / r.height];
  };
  const st = { minDeg: 0, relOn: { similar: true, co_tag: true, ref: true }, q: "", focusId: null };
  const nById = new Map(nodeEls.map((x) => [x.n.id, x.n]));
  const adj = new Map();
  for (const l of links) {
    if (!adj.has(l.s.id)) adj.set(l.s.id, new Set());
    if (!adj.has(l.t.id)) adj.set(l.t.id, new Set());
    adj.get(l.s.id).add(l.t.id); adj.get(l.t.id).add(l.s.id);
  }
  const applyState = () => {
    const q = st.q.trim().toLowerCase();
    const visibleAdj = new Map();
    for (const l of links) {
      if (!st.relOn[l.rel]) continue;
      if (!visibleAdj.has(l.s.id)) visibleAdj.set(l.s.id, new Set());
      if (!visibleAdj.has(l.t.id)) visibleAdj.set(l.t.id, new Set());
      visibleAdj.get(l.s.id).add(l.t.id); visibleAdj.get(l.t.id).add(l.s.id);
    }
    const searching = q.length > 0;
    let hit = null;
    if (searching) {
      hit = new Set(nodes.filter((n) => (n.label + " " + n.tip).toLowerCase().includes(q)).map((n) => n.id));
      for (const id of [...hit]) for (const m of visibleAdj.get(id) || []) hit.add(m);
    }
    const fN = st.focusId != null ? new Set([st.focusId, ...(visibleAdj.get(st.focusId) || [])]) : null;
    for (const { n, cEl } of nodeEls) {
      const hard = n.deg < st.minDeg;
      let op;
      if (hard) op = 0.05;
      else if (fN) op = fN.has(n.id) ? 0.95 : 0.05;
      else if (hit) op = hit.has(n.id) ? 0.95 : 0.07;
      else op = n.kind === "episode" ? 0.6 : 0.92;
      cEl.setAttribute("fill-opacity", op);
      cEl.style.pointerEvents = hard ? "none" : "auto";
    }
    for (const { l, el: ln, base } of lineEls) {
      let op = base;
      if (!st.relOn[l.rel] || l.s.deg < st.minDeg || l.t.deg < st.minDeg) op = 0;
      else if (fN) op = (l.s.id === st.focusId || l.t.id === st.focusId || (fN.has(l.s.id) && fN.has(l.t.id))) ? 0.7 : 0.02;
      else if (hit) op = hit.has(l.s.id) && hit.has(l.t.id) ? Math.max(base, 0.3) : 0.03;
      ln.setAttribute("stroke-opacity", op);
    }
    const bar = $("#gbar"), tip = $("#gtip");
    if (st.focusId != null) {
      const n = nById.get(st.focusId);
      bar.style.display = "block";
      tip.innerHTML = "📍 局部图谱 · #" + n.id + " [" + (K[n.kind]?.[0] || n.kind) + "] " + esc(n.tip) + ' · <a style="cursor:pointer;text-decoration:underline dotted" onclick="window.__graphExit()">返回全图</a>';
    } else if (searching) {
      bar.style.display = "block";
      tip.textContent = "🔍 过滤「" + st.q + "」· 邻域 " + hit.size + " 节点";
    } else bar.style.display = "none";
  };
  window.__graphExit = () => { st.focusId = null; applyState(); };

  const dnd = { n: null, sx: 0, sy: 0, moved: false };
  const pan = { on: false, x: 0, y: 0 };
  svg.addEventListener("mousedown", (ev) => { // 背景按下 = 平移；节点按下走自己的 handler
    if (ev.target === svg) { pan.on = true; pan.x = ev.clientX; pan.y = ev.clientY; }
  });
  svg.addEventListener("mousemove", (ev) => {
    if (dnd.n && dnd.moved) {
      const [x, y] = toSvg(ev.clientX, ev.clientY);
      dnd.n.n.x = Math.max(16, Math.min(W - 16, x)); dnd.n.n.y = Math.max(16, Math.min(H - 16, y));
      dnd.n.setPos(dnd.n.n.x, dnd.n.n.y);
    } else if (dnd.n) {
      if (Math.abs(ev.clientX - dnd.sx) + Math.abs(ev.clientY - dnd.sy) > 4) dnd.moved = true;
    } else if (pan.on) {
      const r = svg.getBoundingClientRect();
      view.tx -= (ev.clientX - pan.x) * (W / view.k) / r.width;
      view.ty -= (ev.clientY - pan.y) * (H / view.k) / r.height;
      pan.x = ev.clientX; pan.y = ev.clientY;
      applyView();
    }
  });
  const endGesture = () => { dnd.n = null; pan.on = false; };
  svg.addEventListener("mouseup", endGesture);
  svg.addEventListener("mouseleave", endGesture);
  svg.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const f = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    const kNew = Math.max(0.5, Math.min(5, view.k * f));
    const [px, py] = toSvg(ev.clientX, ev.clientY);
    view.tx = px - (px - view.tx) * (view.k / kNew); // 鼠标下的点保持不动
    view.ty = py - (py - view.ty) * (view.k / kNew);
    view.k = kNew;
    applyView();
  }, { passive: false });
  svg.addEventListener("dblclick", () => { view.k = 1; view.tx = 0; view.ty = 0; st.focusId = null; applyView(); applyState(); });
  $("#greset").addEventListener("click", () => { view.k = 1; view.tx = 0; view.ty = 0; st.focusId = null; st.q = ""; $("#gq").value = ""; applyView(); applyState(); });
  let sTimer;
  $("#gq").addEventListener("input", (e) => { clearTimeout(sTimer); sTimer = setTimeout(() => { st.q = e.target.value; applyState(); }, 200); });
  for (const cb of document.querySelectorAll('#grep input[type="checkbox"]'))
    cb.addEventListener("change", () => { st.relOn[cb.dataset.rel] = cb.checked; applyState(); });
  $("#gmin").addEventListener("change", (e) => { st.minDeg = Number(e.target.value); applyState(); });
  wrap.appendChild(svg);
  applyState();
};
const KCOL = { preference: "#c8402e", fact: "#2563eb", todo: "#b45309", procedure: "#0f766e", episode: "#71717a" };
// Only format bold after HTML escaping; never interpret the model output as HTML.
const fmt = (t) => esc(t).replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");
window.loadProfile = async () => {
  const d = await (await fetch("/api/profile")).json();
  const el = $("#profile");
  const chip = (m) => {
    const c = KCOL[m.kind] ?? "#666";
    const when = m.updated_at ? '<span class="when">' + esc(m.updated_at.slice(0, 10)) + "</span>" : "";
    return '<div class="prow"><span class="dot" style="background:' + c + '"></span><div class="profile-content">' + foldContent(m.content) + "</div>" + when + "</div>";
  };
  const card = (title, items) => {
    const first = items.slice(0, 5).map(chip).join("") || '<span class="meta">暂无</span>';
    const rest = items.slice(5);
    return '<section class="pcard"><h3>' + title + ' · ' + items.length + '</h3><div class="plist">' + first + '</div>'
      + (rest.length ? '<details class="group-more"><summary>展开其余 ' + rest.length + ' 条</summary><div class="plist">' + rest.map(chip).join("") + '</div></details>' : '') + '</section>';
  };
  const c = d.cached;
  const notice = '<p class="section-note">画像是生成时的快照，可能过期或不准确，请以原始条目为准。生成或重新生成时，最多 1000 条有效记忆的类别与内容（截取前 30000 字符）会发送至智谱开放平台外部模型，请确认隐私风险。</p>';
  const llmBlock = '<section class="pcard"><div class="genbar"><button onclick="regenProfile(this)">' + (c && c.summary ? '重新生成' : '生成 LLM 画像') + '</button><span class="meta">' + (c && c.summary ? '生成于 ' + esc((c.generated_at || "").slice(0, 16).replace("T", " ")) : '尚未生成') + '</span></div>' + notice + (c && c.summary ? '<div class="psummary">' + fmt(c.summary) + '</div>' : '') + '</section>';
  el.innerHTML = '<h2 class="section-title">画像概览</h2>' + llmBlock
    + '<h2 class="section-title">原始记忆条目</h2><p class="section-note">按记忆类别分组；每组默认显示 5 条，可展开查看更多。</p>'
    + '<div class="two">' + card("偏好", d.preferences) + card("待办", d.todos) + '</div>'
    + card("事实与环境", d.identity) + card("经验教训", d.procedures)
    + (d.episodes.length ? card("最近足迹", d.episodes) : '');
};
window.regenProfile = async (btn) => {
  btn.disabled = true; btn.textContent = "蒸馏中…";
  await fetch("/api/profile/refresh", { method: "POST" });
  loadProfile();
};
let t; $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { query = e.target.value.trim(); load(); }, 300); });
load();
</script></body></html>`;

const CONSOLE_PAGE = (() => {
  try { return fs.readFileSync(new URL("./console.html", import.meta.url), "utf8"); }
  catch { return null; }
})();
const tailLines = (file, n) => {
  try { return fs.readFileSync(file, "utf8").trim().split("\n").slice(-n); } catch { return []; }
};
const parseLines = (lines) => lines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });

http.createServer(async (req, res) => {
  const json = (d, code = 200) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(d)); };
  try {
    const u = new URL(req.url, "http://x");
    // v0.16 访问边界：恶意网页可跨站 POST 删除记忆 → 写操作需要本机同源。
    // v0.16.1 曾把整个校验收紧为严格同源——第十+一轮复核实锤误伤 DSH 设置面板的跨端口 GET 探测
    // （设置面板在宿主 GUI 端口，fetch viewer API 被 403，管理页显示「viewer 未运行」假故障）。
    // v0.17.1 读写分级：
    //   GET/HEAD（只读）→ 本机 hostname 任意端口放行（DSH 面板跨端口探测恢复；
    //     无 ACAO 响应头，浏览器默认策略下恶意网页读不到响应体，泄露被 CORS 覆盖）
    //   写方法（POST/PUT/DELETE/PATCH）→ 严格同源（CSRF 写防护不回退，第八轮 P2-5 语义保留）
    const origin = req.headers.origin;
    const host = String(req.headers.host || "");
    const hostName = host.replace(/:\d+$/, "");
    const hostPort = host.includes(":") ? host.slice(host.lastIndexOf(":") + 1) : "";
    const isWrite = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    // v0.17.3（诊断实锤）：DSH 桌面 App 以自定义协议 dsh-app://app 加载页面，面板探测的 Origin
    // 就是它——hostname 解析不出本机地址，被白名单 403（「viewer 未运行」真根因）。
    // 宿主 App 自身是第一方可信来源：读写都放行，读响应回显 ACAO（自定义协议页面同样需要）。
    const TRUSTED_APP = origin === "dsh-app://app";
    if (origin) {
      let oHost = "", oPort = "";
      try { const uo = new URL(origin); oHost = uo.hostname; oPort = uo.port; } catch {}
      const localHost = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(oHost);
      const sameOrigin = oHost === hostName && oPort === hostPort;
      if (isWrite && !sameOrigin && !TRUSTED_APP) { res.writeHead(403, { "Content-Type": "text/plain" }); return res.end("forbidden origin"); }
      if (!isWrite && !localHost && !TRUSTED_APP) { res.writeHead(403, { "Content-Type": "text/plain" }); return res.end("forbidden origin"); }
      // v0.17.2：本机 hostname 只读回显 ACAO（本机内互信可读；远程域上一行已 403；写严格同源）。
      if (!isWrite && (localHost || TRUSTED_APP) && !sameOrigin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
    }
    if (!["127.0.0.1", "localhost", "[::1]", ""].includes(hostName)) { res.writeHead(403, { "Content-Type": "text/plain" }); return res.end("forbidden host"); }
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/classic")) {
      const body = u.pathname === "/classic" || !CONSOLE_PAGE ? PAGE : CONSOLE_PAGE;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(body);
    }
    // v0.10 版本端点：供插件探测旧版 viewer 并自动升级重启（detached 进程 app 重启杀不掉）
    if (req.method === "GET" && u.pathname === "/api/version") {
      return json({ version: PKG_VERSION, pid: process.pid, startupKey: process.env.LM_VIEWER_STARTUP_KEY ?? null });
    }
    if (req.method === "GET" && u.pathname === "/api/memories") {
      const q = u.searchParams.get("q")?.trim();
      const kind = u.searchParams.get("kind");
      let items = [];
      if (q) {
        const r = await call("memory_recall", { query: q, limit: 20 });
        items = Array.isArray(r) ? r.map((x) => ({ ...x, version: x.v })) : [];
      } else {
        const r = await call("memory_list", { limit: 1000 });
        items = (Array.isArray(r) ? r : []).filter((x) => !kind || x.kind === kind);
      }
      const all = Array.isArray(await call("memory_list", { limit: 1000 })) ? await call("memory_list", { limit: 1000 }) : [];
      const counts = {};
      for (const m of all) counts[m.kind] = (counts[m.kind] ?? 0) + 1;
      for (const m of items) m.date = m.date ?? m.updated_at;
      return json({ items, total: all.length, counts });
    }
    if (req.method === "GET" && u.pathname === "/api/graph") { // v0.12 图谱页数据：active 节点 + edges 边
      const d = ro();
      const nodes = d.prepare("SELECT id, kind, content, pinned FROM memories WHERE status='active'").all()
        .map((m) => ({ id: m.id, kind: m.kind, pinned: !!m.pinned, label: String(m.content).replace(/\s+/g, " ").trim().slice(0, 18), tip: String(m.content).replace(/\s+/g, " ").trim().slice(0, 90) }));
      const links = d.prepare("SELECT src AS source, dst AS target, rel, weight FROM edges").all();
      const byRel = {};
      for (const l of links) byRel[l.rel] = (byRel[l.rel] ?? 0) + 1;
      return json({ nodes, links, byRel });
    }
    if (req.method === "GET" && u.pathname === "/api/dormant") {
      const rows = ro().prepare("SELECT id, version, kind, content, tags, updated_at, hit_count, pinned FROM memories WHERE status='dormant' ORDER BY updated_at DESC LIMIT 200").all();
      return json({ items: rows, total: rows.length });
    }
    if (req.method === "GET" && u.pathname === "/api/conflicts") { // v0.14.2 候选对 + 缓存化复核结果
      return json(await conflictCandidates());
    }
    if (req.method === "GET" && u.pathname === "/api/profile") {
      const all = Array.isArray(await call("memory_list", { limit: 1000 })) ? await call("memory_list", { limit: 1000 }) : [];
      const by = (k) => all.filter((m) => m.kind === k);
      return json({
        cached: cachedProfile(),
        identity: by("fact"), preferences: by("preference"), todos: by("todo"),
        procedures: by("procedure"), episodes: by("episode").sort((a, b) => String(b.updated_at || b.date || "").localeCompare(String(a.updated_at || a.date || "")) || b.id - a.id).slice(0, 5),
      });
    }
    if (req.method === "POST" && u.pathname === "/api/profile/refresh") {
      return json(await genProfile());
    }
    if (req.method === "GET" && u.pathname.startsWith("/api/history/")) {
      const id = Number(u.pathname.split("/").pop());
      const db = ro();
      const rows = db.prepare("SELECT id, version, status, content, updated_at FROM memories WHERE id = ? OR supersedes = ? OR (supersedes IS NOT NULL AND supersedes IN (SELECT id FROM memories WHERE id = ?)) ORDER BY version").all(id, id, id);
      return json(rows);
    }
    if (req.method === "POST") {
      const body = await new Promise((r) => { let d = ""; req.on("data", (c) => d += c); req.on("end", () => r(JSON.parse(d || "{}"))); });
      if (u.pathname === "/api/correct") {
        const cur = ro().prepare("SELECT version FROM memories WHERE id = ?").get(body.id);
        if (!cur || cur.version !== body.expected_version) return json({ ok: false, msg: "版本冲突，请刷新重试" });
        const r = await call("memory_correct", { id: body.id, expected_version: body.expected_version, content: body.content, reason: "viewer" });
        return json({ ok: String(r).includes("OK"), msg: String(r).slice(0, 80) });
      }
      if (u.pathname === "/api/forget") {
        const r = await call("memory_forget", { id: body.id, reason: "viewer" });
        return json({ ok: String(r).includes("OK"), msg: String(r).slice(0, 80) });
      }
      if (u.pathname === "/api/lifecycle") {
        const r = await call("memory_pin", { id: body.id, action: body.action, reason: "viewer" });
        return json({ ok: String(r).includes("OK"), msg: String(r).slice(0, 80) });
      }
      if (u.pathname === "/api/conflict/resolve") {
        const oldId = Number(body.old), newId = Number(body.new);
        const oldRow = ro().prepare("SELECT id, kind, content, updated_at FROM memories WHERE id = ? AND status = 'active'").get(oldId);
        const newRow = ro().prepare("SELECT id, kind, content, updated_at FROM memories WHERE id = ? AND status = 'active'").get(newId);
        if (!oldRow || !newRow) return json({ ok: false, msg: "候选对已变化，请刷新后重试" });
        if (body.verdict === "adopt") {
          // 旧说法被接棒：逻辑删除旧条（保留审计），并把这对记为 superseded
          const r = await call("memory_forget", { id: oldId, reason: "conflict-adopt" });
          saveConflictReview(oldRow, newRow, "superseded");
          return json({ ok: String(r).includes("OK"), msg: "已采纳新说法，旧条转为历史（可审计）" });
        }
        // 保留旧说法 / 两条无关：只记录判定，不动任何内容
        const verdict = body.verdict === "keep" ? "related" : "unrelated";
        saveConflictReview(oldRow, newRow, verdict);
        return json({ ok: true, msg: verdict === "related" ? "已记录：两条都保留" : "已记录：判为无关，不再提示" });
      }
      if (u.pathname === "/api/sleep") {
        const r = await call("memory_sleep", {});
        return json({ ok: true, msg: String(r).slice(0, 200) });
      }
    }
    if (req.method === "GET" && u.pathname === "/api/events") {
      const changes = parseLines(tailLines(path.join(MEM_DIR, "changes.jsonl"), 400));
      const log = parseLines(tailLines(path.join(MEM_DIR, "log.jsonl"), 400));
      const nowMs = Date.now();
      const hours = [];
      for (let i = 23; i >= 0; i--) {
        const start = new Date(nowMs - i * 3600e3);
        hours.push({
          hour: start.toLocaleTimeString("zh-CN", { hour: "2-digit", hour12: false }),
          n: changes.filter((c) => { const t = new Date(c.ts); return t >= start && t < new Date(start.getTime() + 3600e3); }).length,
        });
      }
      const dayAgo = new Date(nowMs - 864e5);
      const last24 = changes.filter((c) => new Date(c.ts) >= dayAgo);
      const failures = log.filter((l) => /failed|error/i.test(String(l.op ?? "")));
      return json({
        version: PKG_VERSION, pid: process.pid, db: path.join(MEM_DIR, "memory.db"),
        hours,
        events: changes.slice(-40).reverse().map((c) => ({
          ts: c.ts, op: c.op, id: c.new_id ?? c.id ?? null, kind: c.kind ?? null,
          clip: String(c.content ?? c.reason ?? (c.total ? c.total + " 组冲突" : "") ?? "").slice(0, 90),
        })),
        failures: failures.slice(-6).reverse().map((l) => ({ ts: l.ts, op: l.op, session: String(l.sessionId ?? "").slice(8, 16), attempts: l.attempts ?? null })),
        last24: last24.length,
        writes24: last24.filter((c) => ["remember", "episode", "ingest"].includes(c.op)).length,
        corrections24: last24.filter((c) => c.op === "correct").length,
        failures24: failures.filter((l) => new Date(l.ts) >= dayAgo).length,
      });
    }
    if (req.method === "GET" && u.pathname === "/api/audit") {
      const log = parseLines(tailLines(path.join(MEM_DIR, "log.jsonl"), 400));
      const rows = log.slice(-300).reverse().map((l) => ({
        ts: l.ts, op: String(l.op ?? ""),
        by: String(l.by ?? "").replace("mcp:lm-memory", "mcp").replace("extract-helper", "helper"),
        detail: String(l.reason ?? l.error ?? l.sessionId ?? l.id ?? l.patch ?? "").slice(0, 70),
      }));
      const opCount = {};
      for (const row of rows) opCount[row.op] = (opCount[row.op] ?? 0) + 1;
      return json({ rows, ops: Object.entries(opCount).sort((a, b) => b[1] - a[1]) });
    }
    json({ error: "not found" }, 404);
  } catch (e) { json({ error: String(e.message) }, 500); }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`lm-memory viewer → http://127.0.0.1:${PORT}  (dir: ${MEM_DIR})`);
});
