// lm-memory standalone E2E v2 — 全部用唯一标记 E2EUNIQ，避免与种子记忆碰撞
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "lm-test", version: "0.2" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(__dirname, "memory-server.mjs")],
}));

const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
const t = async (label, name, args) => {
  const out = await call(name, args);
  console.log(`[${label}] ${out.slice(0, 110).replace(/\n/g, " ")}`);
  return out;
};

await t("remember", "memory_remember", { content: "E2EUNIQ-测试记忆：用户喜欢先看最简可跑版本", kind: "preference", tags: "e2e" });
await t("dedupe", "memory_remember", { content: "E2EUNIQ-测试记忆：用户喜欢先看最简可跑版本", kind: "preference" });
await t("secret拦截", "memory_remember", { content: "我的 sk-abcdefgh12345678 是这个", kind: "fact" });
const r1 = JSON.parse(await call("memory_recall", { query: "E2EUNIQ" }));
console.log(`[recall标记] ${r1.length} 条, id=${r1[0]?.id}`);
const mine = r1[0];
await t("correct错误版本", "memory_correct", { id: mine.id, expected_version: 99, content: "改不动" });
await t("correct正确", "memory_correct", { id: mine.id, expected_version: mine.v, content: "E2EUNIQ-已修正：用户要求先给最简可跑版本再谈优化", reason: "e2e" });
const r2 = JSON.parse(await call("memory_recall", { query: "E2EUNIQ-已修正" }));
console.log(`[recall改后] ${r2.length} 条 | ${r2[0]?.content.slice(0, 24)}`);
await t("forget", "memory_forget", { id: r2[0].id, reason: "e2e cleanup" });
const r3 = await call("memory_recall", { query: "E2EUNIQ-已修正" });
console.log(`[recall已删] ${r3.startsWith("[]") ? "空 ✓" : r3}`);
const fin = JSON.parse(await call("memory_list", { limit: 100 }));
console.log(`[清理校验] 残留E2EUNIQ: ${fin.filter((x) => x.content.includes("E2EUNIQ")).length} 条, active 总数: ${fin.length}`);
await client.close();
process.exit(0);
