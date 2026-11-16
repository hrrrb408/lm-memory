// conflict.mjs — dream-time 冲突/过时检测核心逻辑（v0.14）
// 人脑睡眠巩固的库内可做部分之二：相似归并之外的「新旧事实冲突消解」。
//   dream.mjs 管「语义相同该归并」（dedup）；本模块管「语义相近且新条带取代信号，
//   或新条显式点名旧条」——即旧条可能已被新事实接棒，该复核补链。
// 背景案例：一条「会话只在启动时加载记忆」的 fact 被同日上线的变更热流解决后，
//   过时条目在库中躺了 7 天无人发现。缺的不是取代机制（schema 有 superseded/supersedes
//   与 memory_correct 修正链），是「主动发现旧条已过时」的定期扫描。
// 纯函数式：不自己开连接、只读扫描（SELECT 之外不发任何写语句）、不写库。
//   调用方负责 audit/announce 与人工复核后的 memory_correct。
// 嵌入约定：与 dream.mjs 相同——写侧已 normalize，cos 即点积；只用 emb 列（中文语义层）。

const blobToF32 = (b) => {
  if (!b) return null;
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return new Float32Array(ab);
};
const cos = (a, b) => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
};
const clip = (r) => ({
  id: r.id,
  kind: r.kind,
  updated_at: String(r.updated_at || "").slice(0, 10),
  hit_count: r.hit_count ?? 0,
  pinned: !!r.pinned,
  snippet: String(r.content || "").replace(/\s+/g, " ").trim().slice(0, 80),
});

// 取代信号词：新事实接棒旧事实时新条常用的完结/转向表述。
// 信号词出现在教训叙事里属正常（procedure 教程常引用「已修复」），
// 因此单凭词命中不判冲突，必须叠加语义相似或显式引用才输出。
const DONE_RE = /已(解决|上线|修复|卸载|退役|完结|完成|交付|收编|迁移|废弃|弃用|下线|取代)|(?<!已)取代|替代|作废|改用|迁移到|收编进|拍板弃用|不再使用/;
// 显式指针引用：#339 先例格式「相关：id=319（Agnes 弃用）、id=338（幻影规则）」。
const refPattern = (id) => new RegExp(`(?:id\\s*=\\s*|#)${id}(?![0-9])`);

/**
 * 扫描 active 记忆中的疑似「旧条已被新条接棒」对。只读。
 * 两类信号（可叠加）：
 *   supersede_signal — 语义相近（sim ≥ simMin）且晚条带取代信号词、早条不带；
 *   explicit_ref     — 晚条「取代性引用」早条 id：引用点附近窗口内含取代词
 *                      （纯「相关：id=N」式关联引用不算——引用=关联≠取代，真库实证）。
 * @param db node:sqlite DatabaseSync（只读或读写连接均可，本函数不发写语句）
 * @param {{ simMin?: number, refWindow?: number, maxPairs?: number }} opts
 * @returns {{ scanned: number, noEmb: number, total: number, pairs: Array<{
 *   old: object, new: object, sim: number, signals: string[], suggestion: string }> }}
 */
export function findConflictPairs(db, { simMin = 0.85, refWindow = 40, maxPairs = 100 } = {}) {
  const rows = db
    .prepare("SELECT id, kind, hit_count, pinned, updated_at, content, emb FROM memories WHERE status='active' AND emb IS NOT NULL")
    .all();
  const entries = rows.map((r) => ({ row: r, v: blobToF32(r.emb) })).filter((e) => e.v && e.v.length);
  const byId = new Map(entries.map((e) => [e.row.id, e.row]));

  // 信号 1：语义相近 + 新条取代信号词（O(n²) 相似度，规模数千条内毫秒级，与 dream 同口径）
  const found = new Map(); // key "loId-hiId" -> {old, new, sim, signals}
  const addPair = (oldR, newR, sim, signal) => {
    const key = `${oldR.id}-${newR.id}`;
    const cur = found.get(key);
    if (cur) cur.signals.push(signal);
    else found.set(key, { old: clip(oldR), new: clip(newR), sim: Number(sim.toFixed(4)), signals: [signal] });
  };
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const sim = cos(entries[i].v, entries[j].v);
      if (sim < simMin) continue;
      const [lo, hi] = String(entries[i].row.updated_at) <= String(entries[j].row.updated_at)
        ? [entries[i].row, entries[j].row]
        : [entries[j].row, entries[i].row];
      const hiDone = DONE_RE.test(String(hi.content || ""));
      const loDone = DONE_RE.test(String(lo.content || ""));
      if (hiDone && !loDone) addPair(lo, hi, sim, "supersede_signal");
    }
  }

  // 信号 2：取代性引用（引用点 ±refWindow 字符窗口内含取代词才算；不要求相似）
  const vecById = new Map(entries.map((e) => [e.row.id, e.v]));
  for (const e of entries) {
    const text = String(e.row.content || "");
    for (const m of text.matchAll(/(?:id\s*=\s*|#)(\d+)(?![0-9])/g)) {
      const refId = Number(m[1]);
      if (refId === e.row.id) continue;
      const target = byId.get(refId);
      if (!target) continue;
      const ctxStart = Math.max(0, (m.index ?? 0) - refWindow);
      const context = text.slice(ctxStart, (m.index ?? 0) + m[0].length + refWindow);
      if (!DONE_RE.test(context)) continue; // 纯关联引用，不算取代信号
      const [lo, hi] = String(target.updated_at) <= String(e.row.updated_at)
        ? [target, e.row]
        : [e.row, target];
      addPair(lo, hi, cos(vecById.get(lo.id) ?? [], vecById.get(hi.id) ?? []), "explicit_ref");
    }
  }

  const pairs = [...found.values()].map((p) => ({
    ...p,
    suggestion: p.signals.includes("explicit_ref") ? "annotate" : "supersede-review",
  }));
  // 排序：显式引用优先（证据最硬），再按相似度降序
  pairs.sort((x, y) => {
    const rx = x.signals.includes("explicit_ref") ? 1 : 0;
    const ry = y.signals.includes("explicit_ref") ? 1 : 0;
    return ry - rx || y.sim - x.sim;
  });
  return { scanned: rows.length, noEmb: rows.length - entries.length, total: pairs.length, pairs: pairs.slice(0, maxPairs) };
}
