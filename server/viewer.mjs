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

const PORT = Number(process.argv[2] || 7640);
const MEM_DIR = process.env.LM_MEMORY_DIR || path.join(os.homedir(), ".dsh", "memory");
const SERVER = path.join(path.dirname(new URL(import.meta.url).pathname), "memory-server.mjs");
const DB_PATH = path.join(MEM_DIR, "memory.db");

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
        body: JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: prompt }], max_tokens: 2500, temperature: 0.2 }),
      });
      const t = (await r.json()).choices?.[0]?.message?.content ?? "";
      if (t) return t;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "";
}
async function genProfile() {
  const all = await call("memory_list", { limit: 100 });
  const body = all.map((m) => `[${m.kind}] ${m.content}`).join("\n").slice(0, 9000);
  const out = await llm(`以下是一个记忆系统中关于某用户的全部记忆。请生成一份克制的用户画像：
- 第一段：一句话概括这个人（客观，不吹捧，50字内）
- 然后四个小节：**身份与环境** / **偏好与沟通风格** / **正在做的事** / **待办提醒**（有的话）
- 只用记忆里有的信息，不推测；信息少就少写
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
<nav><a id="tabList" class="on" onclick="showView('list')">记忆库</a><a id="tabProfile" onclick="showView('profile')">画像</a></nav>
<div class="bar" id="searchbar"><input id="q" type="search" placeholder="搜索记忆（走完整检索管线：词法 + 中文语义）…"></div>
<main id="list"></main>
<div id="profile"></div>
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
    <span class="meta">v\${m.version} · \${(m.date || "").slice(0, 10)} \${m.source === "auto-extract" ? "· 自动提炼" : m.source === "auto-capture" ? "· 自动采集" : ""}</span></div>
    <div class="content">\${esc(m.content)}</div>
    \${m.tags ? \`<div class="meta" style="margin-top:4px">#\${esc(m.tags.split(",").filter(t=>!t.startsWith("session:")).join(" #"))}</div>\` : ""}
    <div class="acts"><a onclick="correct(\${m.id})">修正</a><a class="danger" onclick="forget(\${m.id})">忘记</a><a onclick="hist(\${m.id})">历史</a></div>
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
$("#stats").addEventListener("click", (e) => { const k = e.target.closest(".chip")?.dataset.k; if (k === undefined) return; filter = k || null; load(); });
window.showView = (v) => {
  const isList = v === "list";
  $("#tabList").classList.toggle("on", isList);
  $("#tabProfile").classList.toggle("on", !isList);
  $("#searchbar").style.display = isList ? "flex" : "none";
  $("#list").style.display = isList ? "flex" : "none";
  $("#profile").style.display = isList ? "none" : "flex";
  if (!isList) loadProfile();
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
    if (req.method === "GET" && u.pathname === "/api/memories") {
      const q = u.searchParams.get("q")?.trim();
      const kind = u.searchParams.get("kind");
      let items = [];
      if (q) {
        const r = await call("memory_recall", { query: q, limit: 20 });
        items = Array.isArray(r) ? r.map((x) => ({ ...x, version: x.v })) : [];
      } else {
        const r = await call("memory_list", { limit: 100 });
        items = (Array.isArray(r) ? r : []).filter((x) => !kind || x.kind === kind);
      }
      const all = Array.isArray(await call("memory_list", { limit: 100 })) ? await call("memory_list", { limit: 100 }) : [];
      const counts = {};
      for (const m of all) counts[m.kind] = (counts[m.kind] ?? 0) + 1;
      for (const m of items) m.date = m.date ?? m.updated_at;
      return json({ items, total: all.length, counts });
    }
    if (req.method === "GET" && u.pathname === "/api/profile") {
      const all = Array.isArray(await call("memory_list", { limit: 100 })) ? await call("memory_list", { limit: 100 }) : [];
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
    }
    json({ error: "not found" }, 404);
  } catch (e) { json({ error: String(e.message) }, 500); }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`lm-memory viewer → http://127.0.0.1:${PORT}  (dir: ${MEM_DIR})`);
});
