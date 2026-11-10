// dream.mjs — dream-time 整理核心逻辑（v0.11）
// 依据 Anthropic《The components of agent memory》：dreaming 的库内可做部分 = 去重检测。
// 对照 transcript 的校对依赖会话原文留底，属后续版本；本模块只做纯库内、只读扫描。
// 纯函数式：不自己开连接、不写库（跟随 sleep.mjs 惯例）。调用方负责 audit/announce。
// 嵌入约定：memory-server 写入时已 normalize（pooling mean + normalize），cos 即点积。

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
  snippet: String(r.content || "").replace(/\s+/g, " ").trim().slice(0, 60),
});

// 扫描 active 且有嵌入的条目，返回相似度 ≥ threshold 的条目对（按相似度降序）。
// 只读：SELECT 之外不发任何写语句。跨 kind 也参与比对（重复常跨 fact/episode 发生）。
export function findDuplicatePairs(db, { threshold = 0.88, maxPairs = 100 } = {}) {
  const rows = db
    .prepare("SELECT id, kind, hit_count, pinned, updated_at, content, emb FROM memories WHERE status='active' AND emb IS NOT NULL")
    .all();
  const vecs = rows.map((r) => ({ row: r, v: blobToF32(r.emb) })).filter((e) => e.v && e.v.length);
  const pairs = [];
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const sim = cos(vecs[i].v, vecs[j].v);
      if (sim >= threshold) pairs.push({ a: clip(vecs[i].row), b: clip(vecs[j].row), sim: Number(sim.toFixed(4)) });
    }
  }
  pairs.sort((x, y) => y.sim - x.sim);
  return { scanned: rows.length, noEmb: rows.length - vecs.length, total: pairs.length, pairs: pairs.slice(0, maxPairs) };
}
