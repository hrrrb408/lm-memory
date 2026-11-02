// sleep.mjs — sleep-time 价值衰减核心逻辑（v0.7）
// 独立模块：memory-server.mjs 启动时/定时调用；测试脚本直接 import。
// 策略：按 kind 宽限期 + 命中延期，超期未置顶的 active 记忆转 dormant（休眠，
// 不再被召回但可唤醒）。全部走 audit 可回滚。纯函数式：不自己开连接。
export const GRACE_DAYS = { episode: 60, todo: 45, fact: 120, procedure: 120, preference: 240 };
export const HIT_EXT_DAYS = 7;   // 每次召回命中延期天数
export const HIT_EXT_CAP = 90;   // 命中延期上限

const DAY_MS = 86400000;

export function decayGraceMs(kind, hitCount = 0) {
  const base = GRACE_DAYS[kind] ?? 120;
  const ext = Math.min((hitCount || 0) * HIT_EXT_DAYS, HIT_EXT_CAP);
  return (base + ext) * DAY_MS;
}

// 计算单条记忆的价值判定：还需多少毫秒才休眠（负数 = 已超期应休眠）
export function msUntilDormant(row, nowMs = Date.now()) {
  const lastActive = Math.max(
    Date.parse(row.updated_at || "") || 0,
    Date.parse(row.last_hit_at || "") || 0
  );
  return decayGraceMs(row.kind, row.hit_count) - (nowMs - lastActive);
}

// 执行一轮 sleep pass。db: node:sqlite DatabaseSync；audit(op, data) 复用服务端审计。
// 返回 { checked, decayed, ids }。只处理 active 且未置顶的条目。
export function runSleepPass(db, audit = () => {}) {
  const rows = db.prepare(
    "SELECT id, kind, hit_count, pinned, updated_at, last_hit_at FROM memories WHERE status='active'"
  ).all();
  const ids = [];
  const t = new Date().toISOString();
  for (const r of rows) {
    if (r.pinned) continue;
    if (msUntilDormant(r) > 0) continue;
    ids.push(r.id);
  }
  if (ids.length) {
    const upd = db.prepare("UPDATE memories SET status='dormant', updated_at=? WHERE id=? AND status='active'");
    for (const id of ids) upd.run(t, id);
  }
  audit("sleep_pass", { checked: rows.length, decayed: ids.length, ids });
  return { checked: rows.length, decayed: ids.length, ids };
}
