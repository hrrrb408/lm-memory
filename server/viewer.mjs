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
.mem .content{font-size:14.5px}
.mem .acts{margin-top:10px;display:flex;gap:12px;font-size:12.5px}
.acts a{color:var(--muted);cursor:pointer;text-decoration:underline dotted}
.acts a:hover{color:var(--ink)}
.acts .danger:hover{color:var(--accent)}
.editbox{width:100%;margin-top:8px;border:1px solid var(--ink);border-radius:8px;padding:8px 10px;font:inherit;font-size:14px}
.hist{margin-top:10px;border-top:1px dashed var(--line);padding-top:8px;font-size:13px;color:var(--muted)}
.hist .old{text-decoration:line-through;opacity:.6}
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
.psummary b{font-family:"Songti SC",Georgia,serif}
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
  d.items.forEach((m) => { versions[m.id] = m.version ?? m.v; });
  $("#list").innerHTML = d.items.map((m) => memCard(m)).join("");
  $("#empty").style.display = d.items.length ? "none" : "block";
}
const memCard = (m) => {
  const [label, color] = K[m.kind] ?? [m.kind, "#666"];
  return \`<div class="mem" id="m\${m.id}">
    <div class="top"><span class="badge" style="background:\${color}">\${label}</span>
    <span class="meta">v\${m.version} · \${(m.date || "").slice(0, 10)} \${m.source === "auto-extract" ? "· 自动提炼" : m.source === "auto-capture" ? "· 自动采集" : ""}\${m.pinned ? " · 📌" : ""}\${m.hit_count ? " · 召回×" + m.hit_count : ""}</span></div>
    <div class="content">\${esc(m.content)}</div>
    \${m.tags ? \`<div class="meta" style="margin-top:4px">#\${esc(m.tags.split(",").filter(t=>!t.startsWith("session:")).join(" #"))}</div>\` : ""}
    <div class="acts"><a onclick="correct(\${m.id})">修正</a><a class="danger" onclick="forget(\${m.id})">忘记</a><a onclick="hist(\${m.id})">历史</a><a onclick="pin(\${m.id}, \${m.pinned ? 0 : 1})">\${m.pinned ? "取消置顶" : "📌 置顶"}</a></div>
    <div id="extra\${m.id}"></div>
  </div>\`;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
window.correct = async (id) => {
  const el = $("#extra" + id);
  if (el.dataset.on) { el.innerHTML = ""; delete el.dataset.on; return; }
  el.dataset.on = "1";
  const m = el.closest(".mem").querySelector(".content").textContent;
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
    h.map((v) => \`<div class="hist \${v.status === "superseded" ? "old" : ""}">v\${v.version} · \${v.status} · \${v.updated_at.slice(0, 10)}<br>\${esc(v.content.slice(0, 120))}</div>\`).join("");
};
window.pin = async (id, to) => { await fetch("/api/lifecycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: to ? "pin" : "unpin" }) }); if ($("#dormant").style.display !== "none") loadDormant(); else load(); };
window.wake = async (id) => { await fetch("/api/lifecycle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action: "wake" }) }); loadDormant(); };
window.runSleep = async () => { const r = await (await fetch("/api/sleep", { method: "POST" })).json(); alert(r.msg || "done"); loadDormant(); };
window.loadDormant = async () => {
  const d = await (await fetch("/api/dormant")).json();
  const el = $("#dormant");
  el.innerHTML = '<div class="mem"><div class="content">休眠馆：长期未被召回的记忆自动转到这里，不再参与检索与 current.md 基线，但随时可唤醒。宽限期：待办45天 · 会话60天 · 事实/经验120天 · 偏好240天（命中延期+7天/次）<div class="acts"><a onclick="runSleep()">🔄 跑一次整理</a></div></div></div>'
    + (d.items.length ? d.items.map((m) => {
      const [label, color] = K[m.kind] ?? [m.kind, "#666"];
      return \`<div class="mem" style="opacity:.75"><div class="top"><span class="badge" style="background:\${color}">\${label}</span><span class="meta">休眠于 \${(m.updated_at || "").slice(0, 10)}\${m.hit_count ? " · 曾召回×" + m.hit_count : ""}</span></div><div class="content">\${esc(m.content)}</div><div class="acts"><a onclick="wake(\${m.id})">☀️ 唤醒</a><a onclick="pin(\${m.id}, 1)">📌 置顶并唤醒</a></div></div>\`;
    }).join("") : '<div class="empty">没有休眠记忆 🎉</div>');
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
// v0.12 图谱页：零依赖 SVG 力导图（深色星图画布 · kind 分区聚簇 · 边分级退后 · hover 聚焦一跳）
const REL_COLOR = { similar: "#b48cff", co_tag: "#4fd1a5", ref: "#f5a524" };
window.loadGraph = async () => {
  const d = await (await fetch("/api/graph")).json();
  const el = $("#graph");
  const stats = d.nodes.length + " 节点 · " + d.links.length + " 边（" +
    ["similar", "co_tag", "ref"].map((r) => '<span style="color:' + (REL_COLOR[r] || "#666") + '">'+ r + ' ' + (d.byRel[r] || 0) + "</span>").join(" · ") + "）· 悬停聚焦一跳，节点可拖拽";
  const legend = Object.entries(K).map(([k, v]) =>
    '<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:#a8a29e"><i style="width:8px;height:8px;border-radius:50%;background:' + v[1] + '"></i>' + v[0] + "</span>").join("");
  el.innerHTML = '<div class="meta" style="margin-bottom:10px;display:flex;gap:14px;flex-wrap:wrap;align-items:baseline;justify-content:space-between">'
    + '<span>' + stats + '</span><span style="display:inline-flex;gap:12px">' + legend + "</span></div>";
  const W = Math.max(el.clientWidth - 2, 600), H = 680;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", W); svg.setAttribute("height", H);
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.style.cssText = "background:#14110d;border:1px solid #2e2a24;border-radius:14px;touch-action:none;display:block";
  // 深底微光：中心径向渐变，星图质感
  const defs = document.createElementNS(NS, "defs");
  defs.innerHTML = '<radialGradient id="gGlow" cx="50%" cy="46%" r="65%">'
    + '<stop offset="0%" stop-color="#221d15"/><stop offset="100%" stop-color="#14110d"/></radialGradient>';
  svg.appendChild(defs);
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", W); bg.setAttribute("height", H); bg.setAttribute("fill", "url(#gGlow)");
  svg.appendChild(bg);

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
      const f = (dist - 64) * 0.03 * cool;
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
    ln.setAttribute("stroke", REL_COLOR[l.rel] || "#666");
    ln.setAttribute("stroke-width", Math.min(0.5 + (l.weight || 1) * 0.6, 3.2));
    ln.setAttribute("stroke-opacity", edgeLevel(l) ? Math.min(0.16 + (l.weight || 1) * 0.14, 0.55) : 0.05);
    svg.appendChild(ln);
    return { l, el: ln, base: Number(ln.getAttribute("stroke-opacity")) };
  });
  // hub 标签：度数 top 6，左右交错挂 + 深色描边防重叠糊团
  const hubs = [...nodes].sort((a, b) => b.deg - a.deg).slice(0, 6);
  const hubSet = new Set(hubs);
  const hubSide = new Map(hubs.map((n, i) => [n.id, i % 2 === 0 ? -1 : 1]));
  const drag = { n: null };
  const nodeEls = nodes.map((n) => {
    const g = document.createElementNS(NS, "g");
    const r = Math.min(3.5 + Math.sqrt(n.deg) * 1.9, 13);
    const cEl = document.createElementNS(NS, "circle");
    cEl.setAttribute("cx", n.x); cEl.setAttribute("cy", n.y); cEl.setAttribute("r", r);
    cEl.setAttribute("fill", K[n.kind]?.[1] || "#888");
    cEl.setAttribute("fill-opacity", n.kind === "episode" ? 0.55 : 0.9);
    if (n.pinned) { cEl.setAttribute("stroke", "#f5e9d0"); cEl.setAttribute("stroke-width", "1.6"); cEl.setAttribute("stroke-opacity", "0.9"); }
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
      lbl.setAttribute("font-size", "9.5");
      lbl.setAttribute("fill", "#c9c2b4");
      lbl.setAttribute("paint-order", "stroke");
      lbl.setAttribute("stroke", "#14110d");
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
    cEl.addEventListener("mousedown", (ev) => { drag.n = { n, setPos }; ev.preventDefault(); });
    // hover 聚焦：点亮一跳，其余退场
    const focus = (on) => {
      const near = new Set([n.id]);
      for (const { l } of lineEls) {
        if (l.s === n) near.add(l.t.id);
        if (l.t === n) near.add(l.s.id);
      }
      for (const { n: o, cEl: oc } of nodeEls) {
        if (o === n) continue;
        oc.setAttribute("fill-opacity", on ? (near.has(o.id) ? 0.95 : 0.07) : (o.kind === "episode" ? 0.55 : 0.9));
      }
      for (const { l, el: ln, base } of lineEls) {
        const touch = l.s === n || l.t === n;
        ln.setAttribute("stroke-opacity", on ? (touch ? 0.85 : 0.02) : base);
      }
    };
    cEl.addEventListener("mouseenter", () => focus(true));
    cEl.addEventListener("mouseleave", () => focus(false));
    return { n, cEl, setPos };
  });
  svg.addEventListener("mousemove", (ev) => {
    if (!drag.n) return;
    const rect = svg.getBoundingClientRect();
    drag.n.setPos(Math.max(16, Math.min(W - 16, ev.clientX - rect.left)), Math.max(16, Math.min(H - 16, ev.clientY - rect.top)));
  });
  svg.addEventListener("mouseup", () => { drag.n = null; });
  svg.addEventListener("mouseleave", () => { drag.n = null; });
  el.appendChild(svg);
};
const KCOL = { preference: "#c8402e", fact: "#2563eb", todo: "#b45309", procedure: "#0f766e", episode: "#71717a" };
const fmt = (t) => esc(t).split("\\n").join("<br>");
window.loadProfile = async () => {
  const d = await (await fetch("/api/profile")).json();
  const el = $("#profile");
  const chip = (m) => {
    const c = KCOL[m.kind] ?? "#666";
    const when = m.updated_at ? '<span class="when">' + m.updated_at.slice(0, 10) + "</span>" : "";
    return '<div class="prow"><span class="dot" style="background:' + c + '"></span><span>' + esc(m.content) + "</span>" + when + "</div>";
  };
  const card = (title, rows) => '<div class="pcard"><h3>' + title + '</h3><div class="plist">' + (rows || '<span class="meta">暂无</span>') + "</div></div>";
  const c = d.cached;
  let llmBlock;
  if (c && c.summary) {
    llmBlock = '<div class="pcard"><div class="genbar"><button onclick="regenProfile(this)">重新生成</button><span class="meta">LLM 画像 · ' + (c.generated_at || "").slice(0, 16).replace("T", " ") + '</span></div><div class="psummary">' + fmt(c.summary) + "</div></div>";
  } else {
    llmBlock = '<div class="pcard"><div class="genbar"><button onclick="regenProfile(this)">生成 LLM 画像</button><span class="meta">把 ' + (d.identity.length + d.preferences.length + d.procedures.length) + " 条记忆交给模型蒸馏成一段肖像</span></div></div>";
  }
  const ongoing = d.identity.filter((m) => /lm-memory|项目|dsh-ui/.test(m.content));
  el.innerHTML = llmBlock
    + '<div class="two">'
    + card("偏好", d.preferences.map(chip).join(""))
    + card("待办与正在做的事", d.todos.concat(ongoing).map(chip).join(""))
    + "</div>"
    + card("事实与环境", d.identity.map(chip).join(""))
    + card("经验教训", d.procedures.map(chip).join(""))
    + (d.episodes.length ? card("最近足迹", d.episodes.map(chip).join("")) : "");
};
window.regenProfile = async (btn) => {
  btn.disabled = true; btn.textContent = "蒸馏中…";
  await fetch("/api/profile/refresh", { method: "POST" });
  loadProfile();
};
let t; $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { query = e.target.value.trim(); load(); }, 300); });
load();
</script></body></html>`;

http.createServer(async (req, res) => {
  const json = (d, code = 200) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(d)); };
  try {
    const u = new URL(req.url, "http://x");
    if (req.method === "GET" && u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    // v0.10 版本端点：供插件探测旧版 viewer 并自动升级重启（detached 进程 app 重启杀不掉）
    if (req.method === "GET" && u.pathname === "/api/version") {
      return json({ version: PKG_VERSION, pid: process.pid });
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
    if (req.method === "GET" && u.pathname === "/api/profile") {
      const all = Array.isArray(await call("memory_list", { limit: 1000 })) ? await call("memory_list", { limit: 1000 }) : [];
      const by = (k) => all.filter((m) => m.kind === k);
      return json({
        cached: cachedProfile(),
        identity: by("fact"), preferences: by("preference"), todos: by("todo"),
        procedures: by("procedure"), episodes: by("episode").slice(-5).reverse(),
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
      if (u.pathname === "/api/sleep") {
        const r = await call("memory_sleep", {});
        return json({ ok: true, msg: String(r).slice(0, 200) });
      }
    }
    json({ error: "not found" }, 404);
  } catch (e) { json({ error: String(e.message) }, 500); }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`lm-memory viewer → http://127.0.0.1:${PORT}  (dir: ${MEM_DIR})`);
});
