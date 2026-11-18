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
// onDecay(ids)：状态更新的事务内回调——server 用它在同一事务写 outbox 事件（v0.15.2：
// 复核实锤 sleep 的事件与状态变更不在同一事务）。返回 { checked, decayed, ids }。
export function runSleepPass(db, audit = () => {}, onDecay = () => {}) {
  const usage = db.prepare("PRAGMA table_info(memories)").all().some(c=>c.name === "used_count");
  const rows = db.prepare(
    `SELECT id, kind, ${usage ? "used_count AS hit_count, last_used_at AS last_hit_at" : "hit_count, last_hit_at"}, pinned, updated_at FROM memories WHERE status='active'`
  ).all();
  const ids = [];
  const t = new Date().toISOString();
  for (const r of rows) {
    if (r.pinned) continue;
    if (msUntilDormant(r) > 0) continue;
    ids.push(r.id);
  }
  if (ids.length) {
    db.exec("BEGIN");
    try {
      const upd = db.prepare("UPDATE memories SET status='dormant', updated_at=? WHERE id=? AND status='active'");
      for (const id of ids) upd.run(t, id);
      onDecay(ids); // 调用方在事务内写事件（事件失败→整体回滚，状态不落）
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      throw e;
    }
  }
  audit("sleep_pass", { checked: rows.length, decayed: ids.length, ids });
  return { checked: rows.length, decayed: ids.length, ids };
}
