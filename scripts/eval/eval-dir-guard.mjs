// eval-dir-guard.mjs — 评测脚本的数据目录守卫（2026-11-17 外审指出的误操作风险修复）。
// 背景：旧 run-eval.mjs 直接 rmSync(LM_MEMORY_DIR)，而该 env 与生产 server 共用——
// 一个手滑的导出就会递归删除 ~/.dsh/memory 或 ~/.lm-memory。
// 用法：所有会清空/删除目录的评测脚本在删除前调用 assertSafeEvalDir(dir)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROTECTED = [ // 只读枚举，逐个与目标做 realpath 级比较
  path.join(os.homedir(), ".dsh", "memory"),
  path.join(os.homedir(), ".lm-memory"),
  os.homedir(),
  path.join(os.homedir(), ".dsh"),
  path.join(os.homedir(), "项目"),
  path.join(os.homedir(), "Documents"),
  path.join(os.homedir(), "Desktop"),
];

export function isSafeEvalDir(dir) {
  const p = path.resolve(String(dir));
  if (p === path.parse(p).root) return false;
  for (const prot of PROTECTED) {
    if (p === prot || p.startsWith(prot + path.sep)) return false; // 保护目录及其子树
  }
  const tmp = os.tmpdir();
  if (p === tmp || p.startsWith(tmp + path.sep)) return true;          // 系统临时目录内随意
  if (p.includes("lm-eval") || p.includes("lm-bench") || p.includes("lm-suite")) return true; // 明确的评测命名
  return false; // 其余位置：要求显式确认
}

/** 不安全时直接退出（评测脚本语境：宁可拒绝跑，不可误删库）。 */
export function assertSafeEvalDir(dir, { label = "评测目录" } = {}) {
  if (isSafeEvalDir(dir)) return;
  console.error(`[${label}] 拒绝使用不安全目录: ${dir}\n` +
    `它不是临时目录，也没有 lm-eval/lm-bench/lm-suite 命名标记；删除它可能波及生产数据。\n` +
    `请改用 os.tmpdir() 下的路径或带评测命名的目录。`);
  process.exit(2);
}

/** 受保护的清空：目录存在则守卫校验后递归删除重建。 */
export function rmEvalDir(dir) {
  assertSafeEvalDir(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}
