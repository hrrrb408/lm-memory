// 阶段 B 验收记录器（外审 P0 修复，0.19.8）。
// 原则：验收系统本身也要被验收——
// - pass 必须是 boolean，非 boolean 直接抛 TypeError（宁可炸掉整场验收，也不许字符串真值混成假 PASS）
// - actual/detail 一律转字符串落盘，报告表格不再出现裸布尔
// - 每行带 at 时间戳，证据链可回放
export function createRecorder({ log = console.log } = {}) {
  const report = [];
  function record(module, name, expected, actual, pass, detail = '') {
    if (typeof pass !== 'boolean') {
      throw new TypeError(
        `[M${module}] ${name}: pass 必须是 boolean，收到 ${typeof pass}（${String(pass).slice(0, 60)}）— 请检查 actual/pass 参数顺序`
      );
    }
    if (typeof name !== 'string' || name.length === 0) throw new TypeError(`[M${module}] name 必须是非空字符串`);
    if (typeof expected !== 'string' || expected.length === 0) throw new TypeError(`[M${module}] ${name}: expected 必须是非空字符串`);
    const row = { module, name, expected, actual: String(actual), pass, detail: String(detail), at: new Date().toISOString() };
    report.push(row);
    log(`${pass ? 'PASS' : 'FAIL'} [M${module}] ${name} — ${row.actual}${detail ? ' | ' + detail : ''}`);
    return row;
  }
  return { record, report };
}
