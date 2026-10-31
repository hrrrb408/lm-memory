#!/usr/bin/env node
// LongMemEval_S 外部基准：证据检索 Recall@1/@5（按题型分项）
// 每题独立世界：把该题 haystack_sessions 全部入库为 episode，用问题检索，金标=answer_session_ids
// 用法: node longmemeval-run.mjs [题数=100] [/tmp/longmemeval_s]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] || 100);
const DATA = process.argv[3] || "/tmp/longmemeval_s";
const SERVER = path.join(__dirname, "../../server/memory-server.mjs");

console.log(`加载 LongMemEval_S（${DATA}）…`);
const all = JSON.parse(fs.readFileSync(DATA, "utf8"));
const items = all.slice(0, N);
console.log(`取前 ${items.length} 题\n`);

const results = [];
const t0 = Date.now();
for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-eval-"));
  const client = new Client({ name: "lmeval", version: "0.1" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [SERVER],
      env: { ...process.env, LM_MEMORY_DIR: dir },
    }));
    const call = (name, args) => client.callTool({ name, arguments: args }).then((r) => r.content[0].text);
    // 入库：每个 haystack session 切成 ≤1800 字符块（同 session 同 tag，金标按 tag 命中）
    const dates = item.haystack_dates ?? [];
    const ids = item.haystack_session_ids ?? [];
    const CHUNK = 1800;
    let memCount = 0;
    for (let s = 0; s < (item.haystack_sessions?.length ?? 0); s++) {
      const turns = item.haystack_sessions[s] ?? [];
      const text = turns.map((t) => `${t.role}: ${t.content}`).join("\n");
      if (!text.trim()) continue;
      const tag = String(ids[s] ?? `s${s}`);
      for (let c = 0; c < text.length; c += CHUNK) {
        const piece = text.slice(c, c + CHUNK);
        if (piece.trim().length < 20) continue;
        const out = await call("memory_remember", {
          content: `会话 ${dates[s] ?? ""}｜${piece}`,
          kind: "episode", tags: `lmeval,${tag}`,
        });
        if (out.startsWith("OK:")) memCount++;
      }
    }
    // 检索 + 计分
    const ts = Date.now();
    const raw = await call("memory_recall", { query: item.question, limit: 5 });
    const latency = Date.now() - ts;
    let hits = [];
    try { const p = JSON.parse(raw); if (Array.isArray(p)) hits = p; } catch {}
    const goldTags = new Set((item.answer_session_ids ?? []).map(String));
    const hitTags = (h) => String(h.tags ?? "").split(",").filter((t) => t !== "lmeval");
    const top1 = hits.length > 0 && hitTags(hits[0]).some((t) => goldTags.has(t));
    const top5 = hits.some((h) => hitTags(h).some((t) => goldTags.has(t)));
    results.push({ type: item.question_type, top1, top5, latency, sessions: memCount });
    await client.close();
  } catch (e) {
    results.push({ type: item.question_type, top1: false, top5: false, latency: 0, sessions: 0, error: e.message });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if ((i + 1) % 20 === 0) console.log(`  进度 ${i + 1}/${items.length}`);
}

// 汇总
const byType = {};
for (const r of results) {
  const c = (byType[r.type] ??= { n: 0, top1: 0, top5: 0, lat: [] });
  c.n++; c.top1 += r.top1 ? 1 : 0; c.top5 += r.top5 ? 1 : 0; c.lat.push(r.latency);
}
const totalMs = Date.now() - t0;
console.log(`\n══════ LongMemEval_S 外部基准（${items.length} 题）══════`);
console.log(`题型                      \tRecall@1\tRecall@5\t延迟p50`);
for (const [t, c] of Object.entries(byType)) {
  const p50 = c.lat.sort((a, b) => a - b)[Math.floor(c.lat.length / 2)];
  console.log(`${t.padEnd(24)}\t${(c.top1 / c.n).toFixed(2)}    \t${(c.top5 / c.n).toFixed(2)}    \t${p50}ms`);
}
const agg = Object.values(byType).reduce((a, c) => ({ n: a.n + c.n, t1: a.t1 + c.top1, t5: a.t5 + c.top5 }), { n: 0, t1: 0, t5: 0 });
console.log(`${"总计".padEnd(24)}\t${(agg.t1 / agg.n).toFixed(2)}    \t${(agg.t5 / agg.n).toFixed(2)}`);
console.log(`总耗时 ${(totalMs / 1000).toFixed(1)}s（含建库）`);
fs.writeFileSync(path.join(__dirname, "longmemeval-report.json"), JSON.stringify({ n: items.length, byType, results, totalMs }, null, 2));
console.log("明细已存: scripts/eval/longmemeval-report.json");
process.exit(0);
