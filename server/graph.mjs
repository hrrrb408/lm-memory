// graph.mjs — 记忆图谱边表构建（v0.12）
// 思路对齐 Mem0 Graph Memory（2026，native co-occurrence graph）：不声明类型化关系，
// 用三类确定性信号建边——similar（嵌入余弦）/ co_tag（低频标签共现）/ ref（正文引用）。
// 纯函数式：不自己开连接、事务由本函数管理（跟 dream.mjs 分工：dream 找重复，graph 建关联）。
// 高频 tag（df > tagDfMax）不参与共现——「lifeos」出现在 97 条里，共现边会是垃圾 supernode。

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
const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// 正文引用模式：#272 / 记忆 275 / id=258（目标必须在 active 集内才算边）。
// 教训（graph-e2e 实抓）：「条目N」式序号文本会误匹配，已剔除——引用惯用式只留这三种。
const REF_RE = [/#(\d+)/g, /记忆\s*(\d+)/g, /id=(\d+)/g];

export function rebuildEdges(db, { simThreshold = 0.82, tagDfMax = 20, maxDeg = 32 } = {}) {
  const rows = db
    .prepare("SELECT id, kind, tags, content, emb FROM memories WHERE status='active'")
    .all();
  const active = new Set(rows.map((r) => r.id));
  const pairs = new Map(); // "a-b|rel" -> weight

  const addPair = (a, b, rel, w) => {
    if (a === b || !active.has(a) || !active.has(b)) return;
    const k = `${pairKey(a, b)}|${rel}`;
    pairs.set(k, (pairs.get(k) ?? 0) + w);
  };

  // 1) co_tag：低频标签共现（df 2..tagDfMax 才是信号；df=1 无共现，df 过高是背景噪声）
  const tagDf = new Map();
  const parsed = rows.map((r) => ({
    row: r,
    tags: String(r.tags || "").split(",").map((t) => t.trim()).filter(Boolean),
  }));
  for (const p of parsed) for (const t of p.tags) tagDf.set(t, (tagDf.get(t) ?? 0) + 1);
  const signalTags = [...tagDf.entries()].filter(([, n]) => n >= 2 && n <= tagDfMax).map(([t]) => t);
  const byTag = new Map(signalTags.map((t) => [t, []]));
  for (const p of parsed) for (const t of p.tags) byTag.get(t)?.push(p.row.id);
  for (const [, ids] of byTag) {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) addPair(ids[i], ids[j], "co_tag", 1);
  }

  // 2) similar：嵌入余弦 ≥ simThreshold（emb 为 zh 主嵌入；NULL 跳过）
  const vecs = rows.map((r) => ({ id: r.id, v: blobToF32(r.emb) })).filter((e) => e.v && e.v.length);
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const sim = cos(vecs[i].v, vecs[j].v);
      if (sim >= simThreshold) addPair(vecs[i].id, vecs[j].id, "similar", Number(sim.toFixed(3)));
    }
  }

  // 3) ref：正文显式引用同库条目 id
  for (const r of rows) {
    for (const re of REF_RE) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(String(r.content))) !== null) {
        const target = Number(m[1]);
        if (active.has(target)) addPair(r.id, target, "ref", 1);
      }
    }
  }

  // 4) 聚合 + supernode 防护：每节点按累计权重只保前 maxDeg 条边
  const flat = [...pairs.entries()].map(([k, w]) => {
    const [ab, rel] = [k.slice(0, k.lastIndexOf("|")), k.slice(k.lastIndexOf("|") + 1)];
    const [a, b] = ab.split("-").map(Number);
    return { a, b, rel, w };
  });
  const deg = new Map();
  for (const e of flat) {
    deg.set(e.a, (deg.get(e.a) ?? 0) + e.w);
    deg.set(e.b, (deg.get(e.b) ?? 0) + e.w);
  }
  const kept = [];
  const keptDeg = new Map();
  for (const e of flat.sort((x, y) => y.w - x.w)) {
    if ((keptDeg.get(e.a) ?? 0) >= maxDeg || (keptDeg.get(e.b) ?? 0) >= maxDeg) continue;
    kept.push(e);
    keptDeg.set(e.a, (keptDeg.get(e.a) ?? 0) + 1);
    keptDeg.set(e.b, (keptDeg.get(e.b) ?? 0) + 1);
  }

  // 5) 事务写回
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM edges");
    const ins = db.prepare("INSERT OR REPLACE INTO edges (src, dst, rel, weight) VALUES (?,?,?,?)");
    for (const e of kept) ins.run(e.a, e.b, e.rel, e.w);
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    throw err;
  }
  const byRel = {};
  for (const e of kept) byRel[e.rel] = (byRel[e.rel] ?? 0) + 1;
  return { nodes: rows.length, edges: kept.length, byRel };
}

// 一跳邻居：recall 图谱扩展用。返回 [{ id, rel, weight, via }]，按权重降序，排除 exclude 集。
export function neighbors(db, ids, { limit = 6, exclude = new Set() } = {}) {
  if (!ids.length) return [];
  const out = [];
  const seen = new Set(exclude);
  const q = db.prepare("SELECT src, dst, rel, weight FROM edges WHERE src=? OR dst=? ORDER BY weight DESC");
  for (const id of ids) {
    for (const r of q.all(id, id)) {
      const nid = r.src === id ? r.dst : r.src;
      if (seen.has(nid)) continue;
      seen.add(nid);
      out.push({ id: nid, rel: r.rel, weight: r.weight, via: id });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
