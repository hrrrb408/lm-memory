// eval-dir-guard.mjs — 评测脚本的数据目录守卫（2026-11-17 外审/复核两轮指出的误操作风险修复）。
// 背景：旧 run-eval.mjs 直接 rmSync(LM_MEMORY_DIR)，而该 env 与生产 server 共用——
// 一个手滑的导出就会递归删除 ~/.dsh/memory 或 ~/.lm-memory。
// v0.15.1（复核实锤）：path.resolve 不解析中间符号链接——临时目录里的 symlink 指向生产目录
// 再追加子路径即可绕过字符串前缀检查。现在对目标与保护目录都做 realpath 解析（不存在时
// 沿祖先链解析），且不再使用「名称含 lm-eval 就允许」的白名单——只允许系统临时目录内部。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROTECTED = [ // 生产与用户数据目录（只读枚举；判定时逐个 realpath 比较）
  path.join(os.homedir(), ".dsh", "memory"),
  path.join(os.homedir(), ".lm-memory"),
  os.homedir(),
  path.join(os.homedir(), ".dsh"),
  path.join(os.homedir(), "项目"),
  path.join(os.homedir(), "Documents"),
  path.join(os.homedir(), "Desktop"),
];

/** realpath 解析：路径不存在时沿祖先链向上找到第一个存在的节点做 realpath，再拼回剩余段。 */
function realPath(p) {
  let candidate = path.resolve(String(p));
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const rp = fs.realpathSync(candidate);
      return tail.length ? path.join(rp, ...tail.reverse()) : rp;
    } catch {
      const base = path.basename(candidate);
      const parent = path.dirname(candidate);
      if (parent === candidate) return null; // 到根都不存在
      tail.unshift(base);
      candidate = parent;
    }
  }
  return null;
}

export function isSafeEvalDir(dir) {
  if (!dir) return false;
  const rp = realPath(dir);
  if (!rp) return false;
  if (rp === path.parse(rp).root) return false;
  for (const prot of PROTECTED) {
    const rprot = realPath(prot);
    if (rprot && (rp === rprot || rp.startsWith(rprot + path.sep))) return false; // 保护目录及其子树（含经 symlink 的别名）
  }
  const tmpReal = realPath(os.tmpdir());
  if (!tmpReal) return false;
  if (rp === tmpReal) return false;                       // 系统临时目录根本身拒绝（防误清）
  if (rp.startsWith(tmpReal + path.sep)) return true;     // 仅允许临时目录内部
  return false;                                           // 其余一律拒绝（不设命名白名单）
}

/** 不安全时直接退出（评测脚本语境：宁可拒绝跑，不可误删库）。 */
export function assertSafeEvalDir(dir, { label = "评测目录" } = {}) {
  if (isSafeEvalDir(dir)) return;
  console.error(`[${label}] 拒绝使用不安全目录: ${dir}\n` +
    `realpath=${realPath(dir)}\n` +
    `守卫只允许 os.tmpdir() 内部的子目录（realpath 级校验，含 symlink 别名检测）。`);
  process.exit(2);
}

/** 受保护的清空：目录守卫校验通过后递归删除重建。 */
export function rmEvalDir(dir) {
  assertSafeEvalDir(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}
