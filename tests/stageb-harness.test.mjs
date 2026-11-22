// 验收器自检（外审 P0 回归）：record 的 pass 参数必须是真布尔。
// 背景：0.19.7 的 runner 多处把 actual/pass 写反，字符串真值把 10 个 FAIL 记成了 PASS。
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
