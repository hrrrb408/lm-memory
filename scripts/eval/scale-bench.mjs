#!/usr/bin/env node
// 规模与延迟基准：合成 10k 记忆（中英混合），测 recall 延迟分位与库体积
// 用法: node scale-bench.mjs [记忆数=10000] [查询数=200]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] || 10000);
const Q = Number(process.argv[3] || 200);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-scale-"));

const ZH_SUBJ = ["项目", "服务器", "数据库", "部署", "模型", "插件", "会话", "配置", "脚本", "测试"];
const ZH_VERB = ["使用了", "修复了", "记录了", "调整了", "验证了", "重构了", "部署了", "审查了", "缓存了", "迁移了"];
const ZH_OBJ = ["SQLite 索引", "MCP 工具", "FTS5 分词", "虚拟机", "GitHub 仓库", "npm 包", "系统提示词", "会话日志", "凭据存储", "备份策略"];
const EN = ["deployed", "fixed", "cached", "refactored", "verified", "migrated"];

const client = new Client({ name: "scale", version: "0.1" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(__dirname, "../../server/memory-server.mjs")],
  env: { ...process.env, LM_MEMORY_DIR: dir },
}));
const call = (name, args) => client.callTool({ name, arguments: args }).then((r) => r.content[0].text);

console.log(`灌入 ${N} 条合成记忆…`);
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const zh = `${ZH_SUBJ[i % 10]}${ZH_VERB[(i * 7) % 10]}${ZH_OBJ[(i * 3) % 10]}，编号 ${i}，附带细节 ${(i * 37) % 1000}`;
  const en = `Task #${i}: ${EN[i % 6]} the ${(i * 3) % 10}-th component on shard ${(i * 7) % 10}`;
  const out = await call("memory_remember", { content: i % 2 ? zh : en, kind: i % 3 ? "fact" : "procedure", tags: `bench,${i % 50}` });
  if (!out.startsWith("OK:") && !out.startsWith("EXISTS")) throw new Error("ingest failed: " + out);
}
console.log(`建库 ${(Date.now() - t0) / 1000}s`);

const queries = [];
for (let i = 0; i < Q; i++) {
  queries.push(i % 3 === 0
    ? `${ZH_SUBJ[i % 10]} ${ZH_OBJ[(i * 3) % 10]}`
    : i % 3 === 1 ? `${EN[i % 6]} component shard` : `${ZH_SUBJ[i % 10]}${ZH_VERB[i % 10]}什么 编号 ${(i * 11) % N}`);
}
const lat = [];
for (const q of queries) {
  const s = performance.now();
  await call("memory_recall", { query: q, limit: 5 });
  lat.push(performance.now() - s);
}
lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.floor(lat.length * p)].toFixed(1);
const dbSize = fs.statSync(path.join(dir, "memory.db")).size / 1048576;
let wal = 0;
try { wal = fs.statSync(path.join(dir, "memory.db-wal")).size / 1048576; } catch {}
console.log(`\n══════ 规模基准（${N} 条 / ${Q} 查询）══════`);
console.log(`recall p50: ${pct(0.5)}ms  p95: ${pct(0.95)}ms  p99: ${pct(0.99)}ms`);
console.log(`库体积: ${dbSize.toFixed(1)}MB (+WAL ${wal.toFixed(1)}MB)`);
console.log(`吞吐: 建库 ${Math.round(N / ((Date.now() - t0) / 1000))} 条/s`);
fs.writeFileSync(path.join(__dirname, "scale-report.json"), JSON.stringify({ n: N, q: Q, p50: +pct(0.5), p95: +pct(0.95), p99: +pct(0.99), dbMB: +dbSize.toFixed(1) }, null, 2));
await client.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
