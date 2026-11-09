// lm-refresh E2E — 变更热流（server announce）→ 插件 pre-step 注入 全链路
// 用临时 MEM_DIR + LM_EMBED=0，不碰真实记忆库。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lm-refresh-e2e-"));
const plugin = (await import("file://" + path.join(INSTALL_DIR, "plugin/lib/index.js"))).default;

// mock cordis ctx：捕获事件注册
const handlers = {};
const ctx = { on: (ev, fn) => { (handlers[ev] ??= []).push(fn); } };
plugin(ctx, { memoryDir: TMP, refresh: true });

const preStep = handlers["agent/pre-step"][0];
if (!preStep) { console.error("FAIL: agent/pre-step 未注册"); process.exit(1); }

let passed = 0, failed = 0;
const ok = (cond, label, extra = "") => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} ${extra}`); }
};

// 模拟一次 pre-step：返回 {injected: text|null, decision}
const step = async () => {
  const decision = { kind: "enter", messages: [{ role: "user", id: "m0", content: [{ type: "text", text: "hi" }] }] };
  const out = await preStep({ agent: { session: { id: "sess-A" } }, turn: 1, step: 1, signal: { aborted: false } }, async () => decision);
  const last = out?.messages?.[out.messages.length - 1];
  const injected = out?.messages?.length === decision.messages.length + 1 && last?.source?.kind === "lm-memory-refresh"
    ? last.content[0].text : null;
  return { out, injected };
};

// MCP client 起 server（写侧）
const client = new Client({ name: "refresh-e2e", version: "0.1" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(INSTALL_DIR, "server/memory-server.mjs")],
  env: { ...process.env, LM_MEMORY_DIR: TMP, LM_EMBED: "0" },
}));
const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;

console.log("== 1. 无热流文件：基线建立，不注入 ==");
let r = await step();
ok(r.injected === null, "无文件不注入");

console.log("== 2. 部署语义：文件已存在的历史变更不算新（首次 stat 建基线）==");
// server 启动会写 server_started 审计行但 announce 不写 changes.jsonl；先手工制造"历史"
fs.appendFileSync(path.join(TMP, "changes.jsonl"), JSON.stringify({ ts: new Date().toISOString(), op: "remember", id: 999, kind: "fact", content: "历史变更-不应推送" }) + "\n");
r = await step();
ok(r.injected === null, "历史变更不推送（首次 stat 建基线）");

console.log("== 3. remember → 注入 delta ==");
const memOut = await call("memory_remember", { content: "REFRESH-E2E-记账流程 v2：落账后必看 post-commit 对账行", kind: "procedure", tags: "e2e" });
r = await step();
ok(r.injected !== null, "有变更时注入");
ok(r.injected?.includes("记忆库实时更新"), "含标题");
ok(r.injected?.includes("REFRESH-E2E-记账流程"), "含新记忆内容");
ok(r.injected?.includes("新增") && r.injected?.includes("经验"), "含操作+种类标签");
ok(r.out.messages.at(-1).source.kind === "lm-memory-refresh", "source.kind 正确");
ok(r.out.messages.at(-1).role === "user", "role=user");

console.log("== 4. offset 幂等：无新变更不重复注入 ==");
r = await step();
ok(r.injected === null, "无新变更不重复注入");

console.log("== 5. correct → 注入修正 delta ==");
const memId = Number(memOut.match(/id=(\d+)/)?.[1]);
await call("memory_correct", { id: memId, expected_version: 1, content: "REFRESH-E2E-记账流程 v2 修正版：对账行+时间格式 HH:MMx", reason: "e2e 修正" });
r = await step();
ok(r.injected?.includes("修正") && r.injected?.includes("HH:MMx"), "修正注入含新内容");
const newId = Number(r.injected?.match(/id=(\d+)/)?.[1]);

console.log("== 6. forget → 注入删除通知 ==");
await call("memory_forget", { id: newId, reason: "e2e cleanup" });
r = await step();
ok(r.injected?.includes("删除"), "删除通知注入");
ok(r.injected?.includes("不要再引用"), "含勿引用提示");

console.log("== 7. episode 行不注入正文 ==");
fs.appendFileSync(path.join(TMP, "changes.jsonl"), JSON.stringify({ ts: new Date().toISOString(), op: "episode", id: 500, kind: "episode", content: "会话摘要-不应注入" }) + "\n");
r = await step();
ok(r.injected === null, "episode 不注入");

console.log("== 8. dormant 折叠提示 ==");
fs.appendFileSync(path.join(TMP, "changes.jsonl"), JSON.stringify({ ts: new Date().toISOString(), op: "dormant", ids: [11, 12, 13] }) + "\n");
r = await step();
ok(r.injected?.includes("转入休眠") && r.injected?.includes("3 条"), "dormant 计数折叠", r.injected ?? "null");

console.log("== 9. 半行安全：不完整行不消费，坏行跳过不崩 ==");
const fd = fs.openSync(path.join(TMP, "changes.jsonl"), "a");
fs.writeSync(fd, JSON.stringify({ ts: new Date().toISOString(), op: "remember", id: 600, kind: "fact", content: "半行测试" }).slice(0, 30)); // 故意截断
fs.closeSync(fd);
r = await step();
ok(r.injected === null, "半行不消费不注入");
fs.appendFileSync(path.join(TMP, "changes.jsonl"), "\n"); // 半行补上换行 → 成为坏行
r = await step();
ok(r.injected === null, "坏行跳过不崩");
fs.appendFileSync(path.join(TMP, "changes.jsonl"), JSON.stringify({ ts: new Date().toISOString(), op: "remember", id: 601, kind: "fact", content: "坏行之后的合法新行" }) + "\n");
r = await step();
ok(r.injected?.includes("坏行之后的合法新行"), "坏行之后正常注入", r.injected ?? "null");

console.log("== 10. pin 生命周期 → 注入 ==");
const pinOut = await call("memory_remember", { content: "REFRESH-E2E-pin目标条目", kind: "fact" });
const pinId = Number(pinOut.match(/id=(\d+)/)?.[1]);
await step(); // 消费掉 remember 的 delta
await call("memory_pin", { id: pinId, action: "pin", reason: "e2e" });
r = await step();
ok(r.injected?.includes("置顶"), "pin 注入");

console.log("== 11. 多会话隔离：sess-B 有自己的基线 ==");
const stepB = async () => {
  const decision = { kind: "enter", messages: [] };
  const out = await preStep({ agent: { session: { id: "sess-B" } }, turn: 1, step: 1, signal: { aborted: false } }, async () => decision);
  return out?.messages?.length ?? 0;
};
const before = (await call("memory_remember", { content: "REFRESH-E2E-B会话期间写入", kind: "fact" })).length;
const lenB = await stepB(); // sess-B 首次：基线=当时文件尾（含刚才 B 的写入）→ 不注入
ok(lenB === 0, "sess-B 首次建基线不吃历史", `len=${lenB}`);
fs.appendFileSync(path.join(TMP, "changes.jsonl"), JSON.stringify({ ts: new Date().toISOString(), op: "remember", id: 700, kind: "fact", content: "REFRESH-E2E-B之后的新写入" }) + "\n");
const decisionB = { kind: "enter", messages: [] };
const outB = await preStep({ agent: { session: { id: "sess-B" } }, turn: 1, step: 2, signal: { aborted: false } }, async () => decisionB);
ok(outB.messages.length === 1 && outB.messages[0].source.kind === "lm-memory-refresh", "sess-B 能收到自己的 delta");

console.log("== 12. refresh=false 关闭 ==");
const handlers2 = {};
plugin({ on: (ev, fn) => { (handlers2[ev] ??= []).push(fn); } }, { memoryDir: TMP, refresh: false });
fs.appendFileSync(path.join(TMP, "changes.jsonl"), JSON.stringify({ ts: new Date().toISOString(), op: "remember", id: 800, kind: "fact", content: "关闭开关测试" }) + "\n");
const offDecision = { kind: "enter", messages: [] };
const offOut = await handlers2["agent/pre-step"][0]({ agent: { session: { id: "sess-C" } }, signal: { aborted: false } }, async () => offDecision);
ok(offOut.messages.length === 0, "refresh=false 不注入");

console.log("== 13. reject 透传 ==");
const rej = { kind: "reject", reason: "x" };
const rejOut = await preStep({ agent: { session: { id: "sess-A" } }, signal: { aborted: false } }, async () => rej);
ok(rejOut === rej || rejOut?.kind === "reject", "reject 原样透传");

await client.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
