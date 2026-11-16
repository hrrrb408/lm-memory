// guards.mjs — v0.15 敏感信息防线单一事实源（server / 插件 / 提炼 helper 三处共用）。
// 2026-11-17 外审实锤的病灶：server 拦输出、采集拦 none、helper 只拦 LLM 输出——
// 原始用户发言在过滤前就已写盘/外发。本模块统一所有入口的判定与脱敏，纯函数零依赖。
// 已知边界（诚实声明）：模式覆盖常见凭据格式（sk- 前缀、api_key= 赋值、ghp/xox/AKIA 平台 token），
// 不能识别任意形态的秘密；它是「已知模式防线」，不是机密检测器。

export const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/i,
  /(api[_-]?key|passwd|password|secret|bearer)\s*[:=]\s*\S{6,}/i,
  /(ghp|gho|xox[baprs]|AKIA)[A-Za-z0-9]{16,}/, // 已知平台 token 前缀
];

/** 返回命中的模式 source，未命中返回 null。 */
export function checkSecret(content) {
  const s = String(content ?? "");
  for (const p of SECRET_PATTERNS) if (p.test(s)) return p.source;
  return null;
}

// 用户明示「这段不要记」的退出标记。按「单条消息」粒度生效：命中的消息整条不进提炼上下文。
// 范围语义是粗粒度的（无法解析「以下内容别记」的作用域）——宁多剔不漏发。
export const OPTOUT_RE = /(别记|不要记|不用记|无需记|勿记|跳过记录|不入库|别入库|不要入库|别存|不要存进记忆)/;

/**
 * 外发前过滤：进入远程 LLM prompt（或含原文的落盘文件）之前必须经过本函数。
 * - 命中 OPTOUT_RE 的消息整条剔除
 * - 命中 SECRET_PATTERNS 的消息整条替换为占位符（保留条数与位置，不保留内容）
 * @returns {{texts: string[], dropped: number, redacted: number}}
 */
export function filterTextsForLLM(texts, onEvent = () => {}) {
  const out = [];
  let dropped = 0, redacted = 0;
  for (const t of Array.isArray(texts) ? texts : []) {
    if (OPTOUT_RE.test(t)) { dropped++; onEvent("llm_input_optout_dropped", { len: String(t).length }); continue; }
    if (checkSecret(t)) { redacted++; onEvent("llm_input_redacted", { len: String(t).length }); out.push("[本条含疑似凭据，已脱敏]"); continue; }
    out.push(t);
  }
  return { texts: out, dropped, redacted };
}
