// 验收器自检（外审 P0 回归）：record 的 pass 参数必须是真布尔。
// 背景：0.19.7 的 runner 多处把 actual/pass 写反，字符串真值把 10 个 FAIL 记成了 PASS。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRecorder } from '../scripts/eval/lib/stageb-record.mjs';

test('record 接受 boolean pass 并落盘字符串化 actual', () => {
  const { record, report } = createRecorder({ log: () => {} });
  record(2, '写入 remember', 'store 内可见 MARK-A1', 'store=/tmp/x', true);
  assert.equal(report.length, 1);
  assert.equal(report[0].pass, true);
  assert.equal(report[0].actual, 'store=/tmp/x');
  assert.equal(typeof report[0].at, 'string'); // 时间戳在证据链里
  record(2, '遗忘版本校验', 'VERSION_CONFLICT', 'conflict detail', false);
  assert.equal(report[1].pass, false);
});

test('record 拒绝非 boolean pass（字符串真值陷阱）', () => {
  // 复现外审发现的原始 bug 形态：第五参传了非空字符串
  const { record } = createRecorder({ log: () => {} });
  assert.throws(() => record(2, '反馈 feedback', 'OK', false, '非空字符串'), TypeError);
  assert.throws(() => record(2, '反馈 feedback', 'OK', '实际值', 'store=/tmp/x'), TypeError);
  assert.throws(() => record(2, '图谱节点', '>=2', 0, `nodes=${0}`), TypeError);
});

test('record 拒绝 number/undefined/null pass', () => {
  const { record } = createRecorder({ log: () => {} });
  assert.throws(() => record(1, '启动耗时', '<=45s', '602ms', 1), TypeError);
  assert.throws(() => record(1, '启动耗时', '<=45s', '602ms', undefined), TypeError);
  assert.throws(() => record(1, '启动耗时', '<=45s', '602ms', null), TypeError);
});

test('record 拒绝假 pass=true 写死（探测写死 PASS 的回归位）', () => {
  const { record, report } = createRecorder({ log: () => {} });
  // 写死 true 本身在类型上是合法 boolean——靠评审与.actual 对照发现；
  // 这里锁定的是：报告行必须带 expected/actual，供外审 diff 审计
  record(8, '外发禁用下不出网', '0 次外呼', 'sinkHits=0', true, '代理汇点+pid 采样');
  assert.equal(report[0].expected, '0 次外呼');
  assert.equal(report[0].actual, 'sinkHits=0');
});

// ---------- 静态审计（外审 P2-2）：类型检查拦不住字面量布尔，扫描器补位 ----------
const root = fileURLToPath(new URL('../', import.meta.url));

// 把字符串/模板字面量（${} 插值内部除外）/注释全部抹成空格，保留代码结构与换行——
// 之后在掩码上找 record( 与拆参数，模板里出现 "record(" 字样、注释里的示例都不会误报。
function maskSource(src) {
  const out = []; const stack = [];
  let i = 0; const n = src.length;
  while (i < n) {
    const ch = src[i]; const next = src[i + 1];
    const state = stack[stack.length - 1] ?? 'code';
    if (state === 'code') {
      if (ch === "'" || ch === '"' || ch === '`') { stack.push(ch); out.push(' '); i++; }
      else if (ch === '/' && next === '/') { stack.push('//'); out.push('  '); i += 2; }
      else if (ch === '/' && next === '*') { stack.push('/*'); out.push('  '); i += 2; }
      else { out.push(ch); i++; }
    } else if (state === "'" || state === '"') {
      if (ch === '\\') { out.push('  '); i += 2; }
      else if (ch === state) { stack.pop(); out.push(' '); i++; }
      else { out.push(' '); i++; }
    } else if (state === '`') {
      if (ch === '\\') { out.push('  '); i += 2; }
      else if (ch === '`') { stack.pop(); out.push(' '); i++; }
      else if (ch === '$' && next === '{') { stack.push('${'); out.push('  '); i += 2; }
      else { out.push(' '); i++; }
    } else if (state === '${') {
      if (ch === '}') { stack.pop(); out.push(' '); i++; }
      else if (ch === "'" || ch === '"' || ch === '`') { stack.push(ch); out.push(' '); i++; }
      else if (ch === '/' && next === '/') { stack.push('//'); out.push('  '); i += 2; }
      else if (ch === '/' && next === '*') { stack.push('/*'); out.push('  '); i += 2; }
      else { out.push(ch); i++; }
    } else if (state === '//') {
      if (ch === '\n') { stack.pop(); out.push(ch); i++; } else { out.push(' '); i++; }
    } else if (state === '/*') {
      if (ch === '*' && next === '/') { stack.pop(); out.push('  '); i += 2; }
      else { out.push(ch === '\n' ? '\n' : ' '); i++; }
    }
  }
  return out.join('');
}

// 在掩码上做括号配平拆参（字符串已消失，顶层逗号即参数分隔符）
function extractRecordCalls(maskedSrc) {
  const calls = [];
  let i = 0;
  while ((i = maskedSrc.indexOf('record(', i)) !== -1) {
    const line = maskedSrc.slice(0, i).split('\n').length;
    let depth = 1; const args = []; let cur = '';
    let j = i + 'record('.length;
    for (; j < maskedSrc.length; j++) {
      const ch = maskedSrc[j];
      if (ch === '(') { depth++; cur += ch; }
      else if (ch === ')') { depth--; if (depth === 0) { args.push(cur); break; } cur += ch; }
      else if (ch === ',' && depth === 1) { args.push(cur); cur = ''; }
      else cur += ch;
    }
    calls.push({ line, args: args.map(a => a.trim()) });
    i = j + 1;
  }
  return calls;
}

function literalPassViolations(relFile) {
  const masked = maskSource(fs.readFileSync(path.join(root, relFile), 'utf8'));
  const bad = [];
  for (const c of extractRecordCalls(masked)) {
    const passArg = c.args.length >= 5 ? c.args[4] : c.args.length === 4 ? c.args[3] : null;
    if (passArg === null || passArg === '') continue;
    const t = passArg.replace(/\s+/g, ' ');
    if (t === 'true' || t === 'false' || /^-?\d+(\.\d+)?$/.test(t)) {
      bad.push({ file: relFile, line: c.line, name: String(c.args[1] ?? '').slice(0, 40), pass: t });
    }
  }
  return bad;
}

test('静态审计：验收脚本的 record(...) pass 实参不得是字面量布尔/数字（写死 PASS 零容忍）', () => {
  const files = ['scripts/eval/dsh-stageb.mjs', 'scripts/eval/dsh-stageb-m6.mjs'];
  const violations = files.flatMap(literalPassViolations);
  assert.deepEqual(violations, []);
});

test('静态审计扫描器自检：能识别出写死的 pass 实参且不误报模板/注释（扫描器自身也要被验收）', () => {
  const src = [
    "record(2, 'a', 'b', 'c', true);",                                      // 违规：5 参字面量
    "record('x', 'b', 'c', false);",                                        // 违规：4 参字面量
    "record(2, 'a', 'b', 'c', flag && ok);",                                // 合规：表达式
    "const s = `模板 ${f(a, b)} 继续 record(1, 'x', 'y', 'z', true)`;",     // 模板内不算
    "// record(9, '注释里的', 'x', 'y', true)",                             // 行注释内不算
    "record(1, '带模板参', `x${join(', ')}y`, 'c', ms <= 5);",              // 合规：模板参数含逗号不破坏拆参
  ].join('\n');
  const calls = extractRecordCalls(maskSource(src));
  const bad = calls.filter(c => {
    const passArg = c.args.length >= 5 ? c.args[4] : c.args.length === 4 ? c.args[3] : null;
    const t = String(passArg ?? '');
    return t === 'true' || t === 'false';
  });
  assert.equal(calls.length, 4);   // 模板内与注释里的不算调用
  assert.equal(bad.length, 2);     // 恰好抓到两处字面量
  assert.equal(calls[3].args.length, 5); // 模板参数里的逗号没有破坏第 5 参定位
});
