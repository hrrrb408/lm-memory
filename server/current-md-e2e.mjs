#!/usr/bin/env node
// current-md-e2e.mjs — v0.11 索引形态 current.md 端到端测试（独立临时库，不碰真实数据）
// 断言：长条目截断成一行指针 / 短条目全文 / pinned 全文 / episode 不进 / 25KB 线 / 换行折叠
// 用法: LM_MEMORY_DIR=<空目录> node current-md-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MEM_DIR = process.env.LM_MEMORY_DIR;
if (!MEM_DIR || MEM_DIR === path.join(process.env.HOME, ".dsh", "memory")) { console.error("拒绝在真实库上跑测试"); process.exit(2); }
fs.rmSync(MEM_DIR, { recursive: true, force: true });
fs.mkdirSync(MEM_DIR, { recursive: true });

const c = new Client({ name: "current-md-e2e", version: "0.11" });
await c.connect(new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./memory-server.mjs", import.meta.url))],
  env: { ...process.env, LM_MEMORY_DIR: MEM_DIR, LM_EMBED: "0" },
}));
const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content[0].text;
const readCur = () => fs.readFileSync(path.join(MEM_DIR, "current.md"), "utf8");
let pass = 0, fail = 0;
const t = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log((cond ? "✅" : "❌") + " " + name + (extra ? " — " + extra : "")); };

// 1) 短条目：≤32 字全文保留
const rShort = await call("memory_remember", { content: "短条目测试：喜欢深色主题", kind: "preference" });
const idShort = Number(String(rShort).match(/id=(\d+)/)[1]);

// 2) 长条目：>32 字应截断（一段明显的长文）
const longBody = "这是一条非常长的记忆内容，详细描述了某个复杂操作流程的第一步、第二步、第三步以及诸多的注意事项和边界条件，远超一行指针所需要的信息量。";
const rLong = await call("memory_remember", { content: longBody, kind: "procedure" });
const idLong = Number(String(rLong).match(/id=(\d+)/)[1]);

// 3) 多行 content：换行必须折叠，指针只占一行
const rMulti = await call("memory_remember", { content: "多行条目第一行\n第二行细节\n第三行更多细节", kind: "fact" });
const idMulti = Number(String(rMulti).match(/id=(\d+)/)[1]);

// 4) episode：不进基线文件
await call("memory_remember", { content: "episode测试：某天调试了索引逻辑", kind: "episode" });

// 5) pinned 条目：全文出现
const rPin = await call("memory_remember", { content: "置顶条目：这是一条必须全文出现在注入层的长期偏好，写得比较长一些以验证全文保留逻辑。", kind: "preference" });
const idPin = Number(String(rPin).match(/id=(\d+)/)[1]);
await call("memory_pin", { id: idPin, action: "pin" });

const cur = readCur();

t("短条目全文保留", cur.includes("短条目测试：喜欢深色主题"));
t("短条目带 #id 指针", cur.includes(`#${idShort}`));
t("长条目被截断（全文不在）", !cur.includes("远超一行指针所需要的信息量"), "全文尾句未出现");
t("长条目指针带省略号", cur.includes("…"));
t("长条目指针可定位（#id 在）", cur.includes(`#${idLong}`));
t("多行条目折叠成一行", !/\n第二行细节/.test(cur) && cur.includes("多行条目第一行 第二行细节"));
t("episode 不进 current.md", !cur.includes("episode测试"));
t("pinned 全文保留", cur.includes("以验证全文保留逻辑"));
t("pinned 段标题在", cur.includes("置顶（全文）"));
t("头部指引提到 memory_recall", cur.includes("memory_recall"));

// 6) 25KB 线：灌 60 条长条目，总大小不得超过 25KB
for (let i = 0; i < 60; i++) {
  await call("memory_remember", { content: `压测条目${i}：${"压测内容填充文本，用于验证注入层体积控制。".repeat(3)}`, kind: "fact" });
}
const final = readCur();
const size = Buffer.byteLength(final, "utf8");
t("注入层 ≤ 25KB（60+5 条）", size <= 25 * 1024, `${(size / 1024).toFixed(1)}KB`);
t("注入层为索引形态（行数受限）", final.split("\n").length < 120, `${final.split("\n").length} 行`);

console.log(`\n${pass} passed, ${fail} failed`);
await c.close();
process.exit(fail ? 1 : 0);
