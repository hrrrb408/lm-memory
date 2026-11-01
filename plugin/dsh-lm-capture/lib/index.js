// dsh-lm-capture v0.1 — cordis 纯函数插件，零依赖。
// 监听 workspace/session-stop 与 session/disposed，把会话里「真实用户输入」
// （source.kind === 'user'，排除 runtime-context 等注入）提炼成一条 episode，
// 追加到 ~/.dsh/memory/pending-episodes.jsonl；由 lm-memory MCP server 在启动/召回时入库。
// 纪律：任何异常都不得抛出宿主进程；只写 stderr；幂等（同一 session 只采一次）。
import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

let MEM_DIR = process.env.LM_MEMORY_DIR || path.join(os.homedir(), ".lm-memory");
const PENDING = path.join(MEM_DIR, "pending-episodes.jsonl");
const MARKER = path.join(MEM_DIR, "captured-sessions.jsonl");
const seen = new Set();

const log = (msg) => { try { console.error(`[lm-capture] ${msg}`); } catch {} };

function alreadyCaptured(sessionId) {
  if (seen.has(sessionId)) return true;
  try {
    return fs.existsSync(MARKER) && fs.readFileSync(MARKER, "utf8").includes(sessionId);
  } catch { return false; }
}
function markCaptured(sessionId) {
  seen.add(sessionId);
  try { fs.appendFileSync(MARKER, JSON.stringify({ ts: new Date().toISOString(), sessionId }) + "\n"); } catch {}
}

function extractUserTexts(session) {
  let events;
  try { events = session.ownEvents(); } catch (e) { log(`ownEvents failed: ${e.message}`); return null; }
  const texts = [];
  for (const e of events) {
    if (e?.type !== "user/message") continue;
    if (e?.data?.source?.kind !== "user") continue; // 排除 runtime-context / time-context 等注入
    const text = (e.data.content || []).filter((c) => c?.type === "text").map((c) => c.text).join(" ").trim();
    if (text.length >= 2) texts.push(text);
  }
  return texts;
}

function resolveNode() {
  const candidates = [
    process.env.DSH_NODE,
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ].filter(Boolean);
  if (process.execPath && /\/node(\.exe)?$/.test(process.execPath)) return process.execPath;
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return "node";
}
function dispatchExtraction(session, texts, config) {
  try {
    if (config?.extract === false || texts.length < 2) return;
    const jobsDir = path.join(MEM_DIR, "extraction-jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    const jobFile = path.join(jobsDir, `${session.id}.json`);
    fs.writeFileSync(jobFile, JSON.stringify({
      sessionId: session.id,
      date: new Date().toISOString().slice(0, 10),
      cwd: session.header?.cwd ?? "",
      texts,
    }));
        const child = spawn(resolveNode(), [path.join(path.dirname(new URL(import.meta.url).pathname), "extract-helper.mjs"), jobFile], {
      detached: true, stdio: "ignore",
      env: { ...process.env, LM_MEMORY_DIR: MEM_DIR },
    });
    child.unref();
    log(`extraction dispatched: ${session.id} (${texts.length} msgs)`);
  } catch (e) {
    log(`extract dispatch error: ${e?.message ?? e}`);
  }
}

function capture(session, config) {
  try {
    if (!session?.id || alreadyCaptured(session.id)) return;
    const texts = extractUserTexts(session);
    if (!texts) return;
    const min = Number.isFinite(config?.minUserMessages) ? config.minUserMessages : 2;
    if (texts.length < min) return;
    const cwd = session.header?.cwd ?? session.meta?.cwd ?? "";
    const date = new Date().toISOString().slice(0, 10);
    const first = texts[0].replace(/\s+/g, " ").slice(0, 120);
    const last = texts[texts.length - 1].replace(/\s+/g, " ").slice(0, 80);
    const rec = {
      sessionId: session.id,
      kind: "episode",
      content: `会话 ${date}｜${cwd || "未知目录"}｜${texts.length} 条用户输入｜首问「${first}」｜末问「${last}」`,
      tags: "auto-capture",
      capturedAt: new Date().toISOString(),
    };
    fs.mkdirSync(MEM_DIR, { recursive: true });
    fs.appendFileSync(PENDING, JSON.stringify(rec) + "\n");
    markCaptured(session.id);
    log(`captured ${session.id} (${texts.length} user msgs)`);
    dispatchExtraction(session, texts, config);
  } catch (e) {
    log(`capture error: ${e?.message ?? e}`);
  }
}

// DSH Web 界面入口：左下角「记忆」按钮（经 webserver/index-inject，与鲸鱼挂件同协议）
const PANEL_ROW_TEXT = `
(function(){
  if (window.__lmPanelLoaded) return; window.__lmPanelLoaded = true;
  var URL = 'http://127.0.0.1:7640';
  var b = document.createElement('div');
  b.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483000;display:flex;align-items:center;gap:7px;'
    + 'padding:8px 14px;border-radius:999px;cursor:pointer;font-size:13px;user-select:none;'
    + 'background:rgba(28,25,23,.82);color:#fafaf9;backdrop-filter:blur(8px);'
    + 'box-shadow:0 2px 10px rgba(0,0,0,.18);transition:transform .15s;font-family:-apple-system,"PingFang SC",sans-serif';
  b.innerHTML = '<span style="font-size:15px">🧠</span><span>记忆</span>';
  var n = document.createElement('span');
  n.style.cssText = 'font-size:11.5px;opacity:.55';
  b.appendChild(n);
  b.onmouseenter = function(){ b.style.transform = 'translateY(-2px)'; };
  b.onmouseleave = function(){ b.style.transform = ''; };
  b.onclick = function(){ window.open(URL, '_blank'); };
  var boot = function(){ if (document.body) { document.body.appendChild(b); fetch(URL + '/api/memories').then(function(r){return r.json();}).then(function(d){ n.textContent = d.total || ''; }).catch(function(){ n.textContent = '·'; }); } else setTimeout(boot, 300); };
  boot();
})();`.trim();

export default function apply(ctx, config) {
  try {
    if (config?.memoryDir) MEM_DIR = String(config.memoryDir);
    // viewer 自启（config.viewer = 端口号；先探测端口，活着就不重复拉起）
    if (config?.viewer) {
      const port = Number(config.viewer);
      fetch("http://127.0.0.1:" + port + "/api/memories").catch(() => {
        try {
          const viewerPath = path.join(path.dirname(new URL(import.meta.url).pathname), "../../../server/viewer.mjs");
          if (fs.existsSync(viewerPath)) {
            import("node:child_process").then(({ spawn: sp }) => {
              const ch = sp(resolveNode(), [viewerPath, String(port)], { detached: true, stdio: "ignore", env: { ...process.env, LM_MEMORY_DIR: MEM_DIR } });
              ch.unref();
              log("viewer spawned on " + port);
            });
          }
        } catch (e) { log("viewer spawn error: " + (e?.message ?? e)); }
      });
    }
    // Web 界面按钮注入（鲸鱼同款通道；行内含 __lmPanelLoaded 去重）
    const rowDisposers = [];
    if (typeof ctx.effect === "function") ctx.effect(() => () => { for (const d of rowDisposers) { try { d?.(); } catch {} } });
    if (typeof ctx.on === "function") rowDisposers.push(ctx.on("webserver/index-inject", (table) => {
      try {
        if (!Array.isArray(table)) return;
        for (const row of table) {
          if (row?.kind === "script" && typeof row.text === "string" && row.text.indexOf("__lmPanelLoaded") >= 0) return;
        }
        table.push({ kind: "script", placement: "body", text: PANEL_ROW_TEXT });
      } catch {}
    }));
    const sessions = new Map();
    const byId = (sessionId) => {
      try { return ctx.sessions?.get?.(sessionId) ?? sessions.get(sessionId) ?? null; } catch { return sessions.get(sessionId) ?? null; }
    };
    const track = (session) => {
      if (!session?.id) return;
      sessions.set(session.id, session);
      if (globalThis.__lmCaptureSessions) globalThis.__lmCaptureSessions.add(session);
    };
    globalThis.__lmCaptureSessions ??= new Set();
    globalThis.__lmCaptureConfig ??= config;
    ctx.on("session/created", (session) => { track(session); log(`event: session/created ${session?.id}`); });
    ctx.on("workspace/session-stop", ({ sessionId } = {}) => {
      log(`event: workspace/session-stop ${sessionId}`);
      const session = sessionId ? byId(sessionId) : null;
      if (session) capture(session, config);
    });
    ctx.on("session/disposed", (session) => {
      log(`event: session/disposed ${session?.id}`);
      capture(session, config);
    });
    // headless/一次性进程：进程退出时同步落盘（桌面常驻进程下由上面的实时事件覆盖）
    if (!globalThis.__lmCaptureExitHooked) {
      globalThis.__lmCaptureExitHooked = true;
      process.on("exit", () => {
        try {
          for (const session of globalThis.__lmCaptureSessions) capture(session, globalThis.__lmCaptureConfig);
        } catch {}
      });
    }
    log("plugin loaded");
  } catch (e) {
    log(`apply error: ${e?.message ?? e}`);
  }
}
