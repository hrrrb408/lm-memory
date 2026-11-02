#!/usr/bin/env node
// recall-eval.mjs — 召回质量回归基准（v0.7 起常驻，改检索逻辑后必跑）
// 用法: LM_MEMORY_DIR=<空目录> [LM_EMBED_CACHE=<模型缓存>] node recall-eval.mjs
// 指标: Recall@5 / Hit@1 / MRR / 陷阱误触发率（中文语义改写 + 英文词法 + 空查询陷阱）
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MEM_DIR = process.env.LM_MEMORY_DIR;
if (!MEM_DIR || MEM_DIR === path.join(process.env.HOME, ".dsh", "memory")) { console.error("拒绝在真实库上跑评测"); process.exit(2); }
const DB = path.join(MEM_DIR, "memory.db");
// 本机已有模型缓存时默认复用：MEM_DIR 会被下方 rmSync 清空，若不独立指定 cacheDir，
// 每次评测都会重新下载双模型 ~56MB（曾表现为首轮 remember 60s 超时）。
if (!process.env.LM_EMBED_CACHE) {
  const def = path.join(process.env.HOME, ".dsh", "memory", "models");
  if (fs.existsSync(path.join(def, "Xenova"))) process.env.LM_EMBED_CACHE = def;
}
fs.rmSync(MEM_DIR, { recursive: true, force: true });
fs.mkdirSync(MEM_DIR, { recursive: true });

const c = new Client({ name: "recall-eval", version: "0.7" });
await c.connect(new StdioClientTransport({
  command: process.execPath, args: [process.env.LM_EVAL_SERVER || fileURLToPath(new URL("./memory-server.mjs", import.meta.url))],
  env: { ...process.env, LM_MEMORY_DIR: MEM_DIR },
}));
const call = async (n, a = {}) => (await c.callTool({ name: n, arguments: a })).content[0].text;

// —— 语料：20 条中文（真实记忆风格）+ 5 条英文 ——
const ZH = [
  ["fact", "用户的电脑是 MacBook M4 Pro（Apple Silicon），内存 48GB"],
  ["preference", "用户偏好 Meta、OpenAI、Apple、Anthropic 等大厂风格的网页设计"],
  ["procedure", "给 profile 装依赖要用 DSH 托管版 pnpm，避免 PATH 里的 pnpm 触发 modules purge"],
  ["fact", "记忆库管理页 viewer 跑在本机 7640 端口"],
  ["preference", "中文交流，喜欢轻松斗嘴的语气，管助手叫大肥鱼"],
  ["procedure", "命令行跑 codex exec 必须显式关闭 stdin，否则会挂起"],
  ["fact", "DevQuest 游戏化插件版本 1.3.0，事件流驱动计分"],
  ["todo", "晨报还没发（living-memory 升级后的首份报告）"],
  ["fact", "长期记忆数据存放在 ~/.dsh/memory 的 SQLite 数据库里"],
  ["procedure", "向量化用 Xenova/bge-small-zh-v1.5 本地 ONNX 模型，不调外部 API"],
  ["episode", "10月19日用户开荒 DSH Desktop，一口气装了十个插件"],
  ["preference", "警惕过度工程：给方案先给最简可用版"],
  ["fact", "用户的主要沟通渠道是微信"],
  ["procedure", "npm 缓存被 root 文件污染时用 --cache /tmp 临时目录绕过"],
  ["fact", "gh CLI 已登录 GitHub 账号 hrrrb408"],
  ["todo", "待办：用 sudo chown 修复 npm 缓存目录属主"],
  ["fact", "用户是学生；中南大学是朋友就读的学校，不是用户本人"],
  ["preference", "对话风格要轻松，可以互相开玩笑"],
  ["procedure", "改动 DSH 本体文件前必须先做备份（.bak 后缀）"],
  ["fact", "桌面软件 DSH Desktop 当前版本 0.2.1-rc.3"],
];
const EN = [
  ["fact", "The user's laptop is a MacBook M4 Pro with 48GB RAM"],
  ["fact", "gh CLI is logged into GitHub account hrrrb408"],
  ["procedure", "Always close stdin when running codex exec non-interactively"],
  ["preference", "The user prefers minimalist big-tech web design like Apple and OpenAI"],
  ["fact", "The memory database lives in ~/.dsh/memory as SQLite"],
  ["fact", "Subagent codex plugin upgraded to version 0.2.1-rc.3 to match the runtime"],
  ["procedure", "Always back up DSH core files with a .bak suffix before editing them"],
  ["fact", "The whale balance widget comes from MeteorNOX on GitHub with 6692 stars"],
  ["preference", "The user wants the simplest working version before any optimization"],
  ["todo", "Publish the morning report after the living-memory upgrade"],
];
// —— 查询：语义改写（刻意避开目标条目的字面词）——
const ZH_Q = [
  ["他平时用什么机器干活", 0], ["界面审美倾向学哪家公司", 1],
  ["装依赖时怎么避免重建 node_modules", 2], ["记忆管理页开在哪个端口", 3],
  ["聊天时怎么称呼这个助手", 4], ["命令行跑 codex 有什么坑", 5],
  ["游戏化等级插件现在是什么版本", 6], ["有什么报告一直没发", 7],
  ["跨会话记忆的数据放在哪", 8], ["向量化用的什么模型、要不要联网", 9],
  ["用户什么时候开始玩这个桌面应用的", 10], ["对复杂方案的看法是什么", 11],
  ["平时主要用什么聊天软件", 12], ["npm 缓存坏了怎么绕过去", 13],
  ["GitHub 命令行登录的是哪个账号", 14], ["还有哪些没做完的杂事", 15],
  ["在读的身份和那所学校是谁的", 16], ["希望对话是什么气氛", 17],
  ["动核心文件之前有什么好习惯", 18], ["桌面软件现在是什么版本", 19],
];
const EN_Q = [
  ["which machine does he work on", 0], ["what github account is the cli using", 1],
  ["how to avoid codex hanging in scripts", 2], ["what visual style does he like", 3],
  ["where is the long-term data stored", 4],
  ["what version is the codex subagent now", 5],
  ["what to do before touching core files", 6],
  ["where does the whale widget come from", 7],
  ["how should solutions be presented to him", 8],
  ["any report still pending", 9],
];
// 常规卷：自然口吻查询（与目标存在字面重合，日常真实使用形态）
const ZH_Q_EASY = [
  ["电脑配置怎么样", 0], ["网页设计风格有什么偏好", 1],
  ["pnpm 装依赖的注意事项", 2], ["viewer 端口是多少", 3],
  ["大肥鱼是什么称呼", 4], ["codex 命令行的坑", 5],
  ["DevQuest 现在什么版本", 6], ["晨报发了吗", 7],
  ["记忆数据库放在哪", 8], ["嵌入模型用哪个", 9],
  ["10月19日做了什么", 10], ["过度工程怎么理解", 11],
  ["微信是主通道吗", 12], ["npm 缓存污染怎么办", 13],
  ["GitHub 账号是哪个", 14], ["怎么修复 npm 缓存", 15],
  ["中南大学是谁的学校", 16], ["对话可以开玩笑吗", 17],
  ["改文件前要备份吗", 18], ["DSH Desktop 什么版本", 19],
];
const TRAPS = ["量子计算的最新进展", "明年世界杯谁夺冠", "附近有什么好吃的火锅店"];

// —— 播种 ——
const idOf = (s) => Number(String(s).match(/id=(\d+)/)[1]);
const zhIds = [], enIds = [];
for (const [kind, content] of ZH) zhIds.push(idOf(await call("memory_remember", { content, kind })));
for (const [kind, content] of EN) enIds.push(idOf(await call("memory_remember", { content, kind })));

// 等待 backfill 嵌入完成（最多 90s）
const db = new DatabaseSync(DB);
for (let i = 0; i < 90; i++) {
  const { n } = db.prepare("SELECT count(*) n FROM memories WHERE emb IS NOT NULL AND emb_en IS NOT NULL AND status='active'").get();
  if (n >= ZH.length + EN.length) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const embN = db.prepare("SELECT count(*) n FROM memories WHERE emb IS NOT NULL AND emb_en IS NOT NULL AND status='active'").get().n;

// —— 跑评测 ——
const parse = (t) => { try { return JSON.parse(t); } catch { return []; } };
async function bench(queries, ids, label) {
  let hit5 = 0, hit1 = 0, mrr = 0;
  const misses = [];
  for (const [q, idx] of queries) {
    const rows = parse(await call("memory_recall", { query: q, limit: 5 }));
    const rank = rows.findIndex((r) => r.id === ids[idx]);
    if (rank >= 0 && rank < 5) hit5++;
    if (rank === 0) hit1++;
    if (rank >= 0) mrr += 1 / (rank + 1);
    if (rank < 0 || rank >= 5) misses.push(`「${q}」→ ${rows.slice(0, 3).map((r) => r.id).join(",") || "空"}`);
  }
  const n = queries.length;
  console.log(`${label}: Recall@5 ${hit5}/${n} = ${(hit5 / n).toFixed(2)} · Hit@1 ${hit1}/${n} = ${(hit1 / n).toFixed(2)} · MRR ${(mrr / n).toFixed(2)}`);
  misses.forEach((m) => console.log("  MISS " + m));
  return { hit5, hit1, mrr, n };
}
let trapFired = 0;
for (const q of TRAPS) { const rows = parse(await call("memory_recall", { query: q, limit: 5 })); if (rows.length) { trapFired++; console.log(`  陷阱误触发「${q}」→ ${rows.map((r) => r.id).join(",")}`); } }
console.log(`陷阱: ${trapFired}/${TRAPS.length} 误触发（期望 0）`);

const zhEasy = await bench(ZH_Q_EASY, zhIds, "中文常规");const zh = await bench(ZH_Q, zhIds, "中文语义");
const en = await bench(EN_Q, enIds, "英文词法");
console.log(`\n嵌入就绪 ${embN}/${ZH.length + EN.length} · v0.7 命中埋点不影响排序（本评测即回归验证）`);
console.log(`SUMMARY zhHard@5=${(zh.hit5 / zh.n).toFixed(2)} zhEasy@5=${(zhEasy.hit5 / zhEasy.n).toFixed(2)} en@5=${(en.hit5 / en.n).toFixed(2)} traps=${trapFired}/${TRAPS.length}`);
await c.close();
process.exit(0);
