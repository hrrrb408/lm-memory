#!/usr/bin/env node
// candidates-e2e.mjs — v0.15 统一提交入口回归：采集卡与提炼候选队列经同一 commitMemoryTx 消费。
// 覆盖：候选入库 / 精确查重 / 凭据拒收 / 摘要卡会话幂等 / 崩溃恢复(.processing 并回) / 坏行重试保留 / 热流 announce。
// 用法: LM_MEMORY_DIR=<空目录> node candidates-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
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

// 预置队列文件（server 启动时 ingestAll 消化）
const card = { sessionId: "s-card-1", kind: "episode", content: "会话 2026-11-17｜测试目录｜3 条用户输入｜首问「造测试卡」｜末问「收尾」", tags: "auto-capture", eventDate: "2026-11-17", capturedAt: "2026-11-17T00:00:00.000Z" };
const fact = { sessionId: "s-ext-1", date: "2026-11-17", kind: "fact", content: "候选事实：lm-memory 用 SQLite+FTS5", tags: "auto,session:s-ext-1", capturedAt: "2026-11-17T00:00:01.000Z", eventDate: "2026-11-17" };
const factDup = { ...fact, capturedAt: "2026-11-17T00:00:02.000Z" }; // 与上一条同 content → 查重跳过
const secret = { sessionId: "s-ext-1", date: "2026-11-17", kind: "fact", content: "我的 key 是 sk-abcdefghijklmnopqrstuvwx 别弄丢", tags: "auto,session:s-ext-1", capturedAt: "2026-11-17T00:00:03.000Z", eventDate: "2026-11-17" };
const summary = { sessionId: "s-ext-1", date: "2026-11-17", kind: "episode", content: "会话摘要 2026-11-17：测试统一提交入口", tags: "summary,session:s-ext-1", capturedAt: "2026-11-17T00:00:04.000Z", eventDate: "2026-11-17" };
const summaryDup = { ...summary, content: "会话摘要 2026-11-17：测试统一提交入口（续聊后更新，内容必然变化）", capturedAt: "2026-11-17T00:00:05.000Z" }; // 同会话第二张摘要（内容不同→真实续聊场景）→ supersede 取代第一张
fs.writeFileSync(path.join(MEM_DIR, "pending-episodes.jsonl"), JSON.stringify(card) + "\n");
fs.writeFileSync(path.join(MEM_DIR, "pending-memories.jsonl"), [fact, factDup, secret, summary, summaryDup].map((r) => JSON.stringify(r)).join("\n") + "\n");

const c = new Client({ name: "candidates-e2e", version: "0.15" });
await c.connect(new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./memory-server.mjs", import.meta.url))],
  env: { ...process.env, LM_MEMORY_DIR: MEM_DIR, LM_EMBED: "0" },
}));
const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content[0].text;
const db = () => new DatabaseSync(DB, { readOnly: true });
const dbw = () => new DatabaseSync(DB); // 少数测试需要写库（如手动往 outbox 塞滞留事件）
const rows = (sql, ...p) => db().prepare(sql).all(...p);
let pass = 0, fail = 0;
const t = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "✅" : "❌") + " " + name + (extra ? " — " + extra : "")); };

await call("memory_recall", { query: "SQLite" }); // 触发一次 ingestAll（幂等，此时应已消化完）

t("采集卡入库（统一入口）", rows("SELECT 1 FROM memories WHERE tags LIKE '%session:s-card-1%'").length === 1);
t("候选 fact 入库", rows("SELECT 1 FROM memories WHERE content LIKE '候选事实%'").length === 1);
t("同内容候选查重去重", rows("SELECT 1 FROM memories WHERE content LIKE '候选事实%'").length === 1);
t("凭据候选被拒收", rows("SELECT 1 FROM memories WHERE content LIKE '%sk-abc%'").length === 0);
t("摘要卡入库（active 恰一张）", rows("SELECT 1 FROM memories WHERE status='active' AND tags LIKE 'summary,%' AND tags LIKE '%session:s-ext-1%'").length === 1);
t("第二张摘要卡同事务取代第一张（supersede，复核实锤旧规则丢新摘要）",
  rows("SELECT 1 FROM memories WHERE status='active' AND tags LIKE 'summary,%' AND tags LIKE '%session:s-ext-1%'").length === 1
  && rows("SELECT 1 FROM memories WHERE status='superseded' AND tags LIKE 'summary,%'").length === 1);

// 摘要重放不倒退（复核实锤：消费 A→B 后重放 A，active 退回 A 并产生第三条）：
// ① 同一候选身份重放（旧格式无 eid → 指纹身份命中 meta）必须被丢弃
// ② 不同身份但更旧 revision（新 eid、旧 capturedAt）必须被版本序丢弃
fs.writeFileSync(path.join(MEM_DIR, "pending-memories.jsonl"), [
  JSON.stringify(summary), // ① 原样重放 A
  JSON.stringify({ ...summary, eid: "replay-old-rev", capturedAt: summary.capturedAt }), // ② 旧 revision、新身份
].join("\n") + "\n");
await call("memory_recall", { query: "触发摘要重放" });
t("重放后 active 仍为 B（不回退）", String(rows("SELECT content FROM memories WHERE status='active' AND tags LIKE 'summary,%'")[0]?.content ?? "").includes("续聊后更新"));
t("重放后摘要版本数仍为 2（不新增版本）", rows("SELECT 1 FROM memories WHERE tags LIKE 'summary,%'").length === 2);
t("旧 revision 候选被消费身份/版本序拦下", rows("SELECT 1 FROM meta WHERE key LIKE 'cand:replay-old-rev%'").length === 1 || rows("SELECT 1 FROM meta WHERE key LIKE 'cand:%'").length >= 2);
t("队列文件已消费清空", !fs.existsSync(path.join(MEM_DIR, "pending-episodes.jsonl")) && !fs.existsSync(path.join(MEM_DIR, "pending-memories.jsonl")));
const audits = fs.readFileSync(path.join(MEM_DIR, "log.jsonl"), "utf8");
t("审计含 ingest_pending/ingest_candidates/commit_rejected", ["ingest_pending", "ingest_candidates", "commit_rejected"].every((k) => audits.includes(k)));
const changes = fs.readFileSync(path.join(MEM_DIR, "changes.jsonl"), "utf8");
t("热流含 auto-extract 的 remember", changes.includes("auto-extract"));
t("event_date 取会话日期而非 capturedAt 时间戳", rows("SELECT event_date FROM memories WHERE content LIKE '候选事实%'")[0]?.event_date === "2026-11-17");

// 崩溃恢复：残留 .processing 文件应在下次消费时并回处理
const recovery = { sessionId: "s-ext-2", date: "2026-11-17", kind: "fact", content: "崩溃恢复候选：队列协议断点续传", tags: "auto,session:s-ext-2", capturedAt: "2026-11-17T01:00:00.000Z", eventDate: "2026-11-17" };
fs.writeFileSync(path.join(MEM_DIR, "pending-memories.jsonl.processing"), JSON.stringify(recovery) + "\n");
await call("memory_recall", { query: "断点续传" });
t("崩溃残留 .processing 并回并消费", rows("SELECT 1 FROM memories WHERE content LIKE '%断点续传%'").length === 1);
t("恢复后 .processing 清理", !fs.existsSync(path.join(MEM_DIR, "pending-memories.jsonl.processing")));

// outbox 补发（复核实锤：COMMIT 后热流写失败 → 事件永久丢失）：滞留事件在下次消费时补发且不重复
dbw().prepare("INSERT INTO outbox (ts, op, payload) VALUES (?, 'remember', ?)").run(new Date().toISOString(), JSON.stringify({ id: 999, kind: "fact", content: "OUTBOX_STAGED 补发事件" }));
await call("memory_recall", { query: "触发补发" });
const chText = fs.readFileSync(path.join(MEM_DIR, "changes.jsonl"), "utf8");
t("滞留事件补发到热流", chText.includes("OUTBOX_STAGED"));
t("outbox 投递成功后出队", dbw().prepare("SELECT count(*) n FROM outbox WHERE delivered=0").get().n === 0);

// 故障注入①：目录只读 → .processing 并回失败必须保留快照（复核实锤旧版吞异常后无条件删除 → 数据三无）
const rescue = { sessionId: "s-rescue", date: "2026-11-17", kind: "fact", content: "RESCUE_LINE 并回失败必须保留", tags: "auto,session:s-rescue", capturedAt: "2026-11-17T02:00:00.000Z", eventDate: "2026-11-17" };
fs.writeFileSync(path.join(MEM_DIR, "pending-memories.jsonl.processing"), JSON.stringify(rescue) + "\n");
fs.chmodSync(MEM_DIR, 0o555);
await call("memory_recall", { query: "RESCUE 触发消费" });
t("并回失败保留 .processing", fs.existsSync(path.join(MEM_DIR, "pending-memories.jsonl.processing")));
t("并回失败不丢数据不入库",
  !fs.existsSync(path.join(MEM_DIR, "pending-memories.jsonl")) && rows("SELECT 1 FROM memories WHERE content LIKE '%RESCUE_LINE%'").length === 0,
  `main=${fs.existsSync(path.join(MEM_DIR, "pending-memories.jsonl"))} rows=${rows("SELECT count(*) n FROM memories WHERE content LIKE '%RESCUE_LINE%'").length} mode=${(fs.statSync(MEM_DIR).mode & 0o777).toString(8)}`);
fs.chmodSync(MEM_DIR, 0o755);
await call("memory_recall", { query: "RESCUE 恢复后重试" });
t("恢复权限后恰好消费一次", rows("SELECT 1 FROM memories WHERE content LIKE '%RESCUE_LINE%'").length === 1 && !fs.existsSync(path.join(MEM_DIR, "pending-memories.jsonl.processing")));

// 坏行重试保留：半截 JSON 不丢弃，留在队列里等修复
fs.writeFileSync(path.join(MEM_DIR, "pending-memories.jsonl"), '{"sessionId":"s-bad","kind":"fact","content":"半截\n');
await call("memory_recall", { query: "半截" });
t("坏行保留待重试", fs.existsSync(path.join(MEM_DIR, "pending-memories.jsonl")) && fs.readFileSync(path.join(MEM_DIR, "pending-memories.jsonl"), "utf8").includes("半截"));
t("坏行未入库", rows("SELECT 1 FROM memories WHERE content LIKE '%半截%'").length === 0);

// helper 已无独立写库权：静态检查
const helper = fs.readFileSync(fileURLToPath(new URL("../plugin/lib/extract-helper.mjs", import.meta.url)), "utf8");
t("helper 已无独立写库权（无 DatabaseSync/INSERT INTO）", !helper.includes("DatabaseSync") && !/INSERT INTO/.test(helper));

// 故障注入②：helper 候选入队失败 → 保留 job + 非零退出（复核实锤旧版 job 被删 + exit 0，重试依据消失）
const http = await import("node:http");
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const mark = (body.match(/R[12]MARK|LEGACY[AB]MARK/) || [])[0] || null; // 重跑场景：按输入 mark 返回可区分的确定性输出
    res.setHeader("Content-Type", "application/json");
    const factContent = mark ? `FACT_${mark} 稳定身份测试事实` : "MOCK_HELPER_CANDIDATE 故障注入候选";
    const summaryText = mark ? `SUMMARY_${mark} 稳定身份测试摘要` : "MOCK_HELPER_SUMMARY 故障注入摘要";
    res.end(JSON.stringify({
      choices: [{ message: { content: body.includes("提炼") ? `[{"kind":"fact","content":"${factContent}"}]` : summaryText } }],
    }));
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mockPort = mock.address().port;
const job = { sessionId: "s-helper-x", date: "2026-11-17", cwd: "", texts: ["第一条：故障注入前文", "第二条：故障注入后文（纠正：以此为准）"], llm: { model: "mock", baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKeyEnv: "LM_TEST_KEY" } };
const jobsDir = path.join(MEM_DIR, "extraction-jobs");
fs.mkdirSync(jobsDir, { recursive: true });
const jobPath = path.join(jobsDir, "s-helper-x.json");
fs.writeFileSync(jobPath, JSON.stringify(job));
const helperPath = fileURLToPath(new URL("../plugin/lib/extract-helper.mjs", import.meta.url));
const helperEnv = { ...process.env, LM_MEMORY_DIR: MEM_DIR, LM_TEST_KEY: "test", LM_EMBED: "0" };
// 注意：必须用异步 spawn——spawnSync 会阻塞本进程事件循环，mock server 无法应答 helper 的 fetch。
// 故障面：候选队列是已存在文件，append 只需文件写权限——目录 chmod 挡不住，必须 chmod 文件本身。
const runHelper = (jp = jobPath) => new Promise((resolve) => {
  const ch = spawn(process.execPath, [helperPath, jp], { env: helperEnv });
  let done = false;
  const timer = setTimeout(() => { if (!done) { done = true; ch.kill("SIGKILL"); resolve({ status: null, signal: "TIMEOUT" }); } }, 60000);
  ch.on("exit", (code, signal) => { if (!done) { done = true; clearTimeout(timer); resolve({ status: code, signal }); } });
});
const queuePath = path.join(MEM_DIR, "pending-memories.jsonl");
if (!fs.existsSync(queuePath)) fs.writeFileSync(queuePath, ""); // 确保文件在，chmod 才有意义
fs.chmodSync(queuePath, 0o444); // 候选追加将 EACCES
const rFail = await runHelper();
t("helper 入队失败保留 job + 非零退出", (rFail.status !== 0 || rFail.signal) && fs.existsSync(jobPath), `exit=${rFail.status} signal=${rFail.signal}`);
fs.chmodSync(queuePath, 0o644);
t("helper 入队失败候选未落盘", !fs.readFileSync(queuePath, "utf8").includes("MOCK_HELPER_CANDIDATE"));
const rOk = await runHelper();
t("恢复权限重跑成功且 job 清理", rOk.status === 0 && !fs.existsSync(jobPath), `exit=${rOk.status} signal=${rOk.signal}`);
t("重跑候选已落盘", fs.existsSync(queuePath) && fs.readFileSync(queuePath, "utf8").includes("MOCK_HELPER_CANDIDATE"));

// 旧 job 重跑不回退（v0.15.3 复核实锤：helper 每次跑换新 eid+刷新时间 → 旧 job 重跑退回新摘要）：
// R1(rev=T1) 消费 → R2(rev=T2>T1, 同 session) 消费（B 取代 A）→ 重跑 R1 → active 必须仍是 B
{
  const mkJob = (name, rev, mark) => {
    const p = path.join(jobsDir, `${name}.json`);
    fs.writeFileSync(p, JSON.stringify({ sessionId: "s-rev-test", rev, date: "2026-11-17", cwd: "", texts: [`前文 ${mark}`, `后文（以此为准）${mark}`], llm: { model: "mock", baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKeyEnv: "LM_TEST_KEY" } }));
    return p;
  };
  const T1 = "2026-11-17T01:00:00.000Z", T2 = "2026-11-17T02:00:00.000Z";
  const j1 = mkJob("rev-r1", T1, "R1MARK"), j2 = mkJob("rev-r2", T2, "R2MARK");
  const r1run = await runHelper(j1);
  t("R1 job 运行成功", r1run.status === 0, `exit=${r1run.status}`);
  await call("memory_recall", { query: "触发 R1 消费" });
  t("R1 摘要已入库", rows("SELECT 1 FROM memories WHERE content LIKE '%SUMMARY_R1MARK%' AND status='active'").length === 1);
  const r2run = await runHelper(j2);
  t("R2 job 运行成功", r2run.status === 0, `exit=${r2run.status}`);
  await call("memory_recall", { query: "触发 R2 消费" });
  t("R2 摘要取代 R1（active=B）", rows("SELECT 1 FROM memories WHERE status='active' AND tags LIKE 'summary,%' AND tags LIKE '%session:s-rev-test%'").length === 1
    && rows("SELECT 1 FROM memories WHERE status='active' AND content LIKE '%SUMMARY_R2MARK%'").length === 1
    && rows("SELECT 1 FROM memories WHERE status='superseded' AND content LIKE '%SUMMARY_R1MARK%'").length === 1);
  // 保留 R1 的 job 副本（模拟「入队成功但 job 清理失败」的遗留），然后重跑
  fs.writeFileSync(j1, JSON.stringify({ sessionId: "s-rev-test", rev: T1, date: "2026-11-17", cwd: "", texts: ["前文 R1MARK", "后文（以此为准）R1MARK"], llm: { model: "mock", baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKeyEnv: "LM_TEST_KEY" } }));
  const r1rerun = await runHelper(j1);
  t("R1 重跑成功（job 被清理）", r1rerun.status === 0 && !fs.existsSync(j1), `exit=${r1rerun.status}`);
  await call("memory_recall", { query: "触发 R1 重放消费" });
  t("重跑后 active 仍为 B（不回退到 A）", rows("SELECT 1 FROM memories WHERE status='active' AND content LIKE '%SUMMARY_R2MARK%'").length === 1
    && rows("SELECT 1 FROM memories WHERE status='active' AND content LIKE '%SUMMARY_R1MARK%'").length === 0, JSON.stringify(rows("SELECT content, status FROM memories WHERE content LIKE '%SUMMARY_%'")));
  t("重跑后摘要版本数仍为 2（不新增版本）", rows("SELECT 1 FROM memories WHERE tags LIKE '%session:s-rev-test%' AND kind='episode'").length === 2);
  t("重跑的 fact 候选被稳定 eid 拦下（FACT_R1MARK 仍 1 条）", rows("SELECT 1 FROM memories WHERE content LIKE '%FACT_R1MARK%'").length === 1);
}

// 升级兼容：无 rev 的旧格式 job（v0.15.4 第五轮复核实锤：兜底时间戳不写回 → 重跑换身份退回新摘要）。
// 流程：legacy L(无 rev) 首跑（helper 写回迁移 rev）→ 消费 → 新格式 B(rev 更晚) 取代 → 模拟遗留重跑 L → active 必须保持 B
{
  const llmCfg = { model: "mock", baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKeyEnv: "LM_TEST_KEY" };
  const legacyPath = path.join(jobsDir, "rev-legacy.json");
  fs.writeFileSync(legacyPath, JSON.stringify({ sessionId: "s-legacy", date: "2026-11-17", cwd: "", texts: ["前文 LEGACYAMARK", "后文 LEGACYAMARK"], llm: llmCfg })); // 无 rev = 旧格式
  const rlRun = await runHelper(legacyPath);
  t("旧格式 job 首跑成功", rlRun.status === 0, `exit=${rlRun.status}`);
  // 消费前捕获迁移 rev（消费后队列文件会被 rename 清理，必须在 call recall 之前读）
  const legacyCand = fs.readFileSync(queuePath, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r?.sessionId === "s-legacy" && String(r?.tags || "").startsWith("summary,")).pop();
  t("旧格式候选携带迁移 rev 与确定性 eid", !!legacyCand?.capturedAt && /^h-/.test(legacyCand?.eid || ""), `capturedAt=${legacyCand?.capturedAt}`);
  await call("memory_recall", { query: "触发 legacy 消费" });
  t("旧格式摘要已入库", rows("SELECT 1 FROM memories WHERE status='active' AND content LIKE '%SUMMARY_LEGACYAMARK%'").length === 1);
  // 新格式 B（同 session，rev 晚于迁移 rev 1 秒）取代
  const bRev = new Date(Date.parse(legacyCand.capturedAt) + 1000).toISOString();
  const bPath = path.join(jobsDir, "rev-legacy-b.json");
  fs.writeFileSync(bPath, JSON.stringify({ sessionId: "s-legacy", rev: bRev, date: "2026-11-17", cwd: "", texts: ["前文 LEGACYBMARK", "后文 LEGACYBMARK"], llm: llmCfg }));
  const rbRun = await runHelper(bPath);
  t("新格式 B 运行成功", rbRun.status === 0, `exit=${rbRun.status}`);
  await call("memory_recall", { query: "触发 B 消费" });
  t("B 取代旧格式摘要（active=B）", rows("SELECT 1 FROM memories WHERE status='active' AND content LIKE '%SUMMARY_LEGACYBMARK%'").length === 1
    && rows("SELECT 1 FROM memories WHERE status='superseded' AND content LIKE '%SUMMARY_LEGACYAMARK%'").length === 1);
  // 模拟遗留（写回后的形态：无 rev 的原始 job 首跑时 rev 已写回文件；遗留文件即带 rev 的这份）重跑
  fs.writeFileSync(legacyPath, JSON.stringify({ sessionId: "s-legacy", rev: legacyCand.capturedAt, date: "2026-11-17", cwd: "", texts: ["前文 LEGACYAMARK", "后文 LEGACYAMARK"], llm: llmCfg }));
  const rerun = await runHelper(legacyPath);
  t("遗留旧格式 job 重跑成功", rerun.status === 0, `exit=${rerun.status}`);
  await call("memory_recall", { query: "触发 legacy 重放消费" });
  t("重跑后 active 仍为 B（迁移 rev 写回 + eid 拦截）", rows("SELECT 1 FROM memories WHERE status='active' AND content LIKE '%SUMMARY_LEGACYBMARK%'").length === 1
    && rows("SELECT 1 FROM memories WHERE status='active' AND content LIKE '%SUMMARY_LEGACYAMARK%'").length === 0);
  t("重跑后 s-legacy 摘要版本数仍为 2", rows("SELECT 1 FROM memories WHERE tags LIKE '%session:s-legacy%' AND kind='episode'").length === 2);
}
await new Promise((r) => mock.close(r));

console.log(`\n${pass} passed, ${fail} failed`);
await c.close();
process.exit(fail ? 1 : 0);
