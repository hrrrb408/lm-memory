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
// 严格取代词：只有「替换/作废」类动作能证明"这条取代那条"。
// 「已上线/已修复/已完成/已交付」只描述状态，引用处出现它们不构成取代。
// 真库实证（2026-11-21）：#360 写「变更热流已上线（#262）」是在给 #262 作证，
// 被 explicit_ref 分支的宽泛完结词误判成"#262 已被取代"；同时 cos=0.796 低于 0.85 阈值，
// 说明这一对完全由引用规则的词命中撑起来，属于纯误报。
const SUPERSEDE_RE = /取代|替代|作废|弃用|废弃|下线|不再使用|收编|退役/;
// 显式指针引用：#339 先例格式「相关：id=319（Agnes 弃用）、id=338（幻影规则）」。
const refPattern = (id) => new RegExp(`(?:id\\s*=\\s*|#)${id}(?![0-9])`);

// 版本发布条（「vX.Y 发布/收官」式时间线记录）：新版本不推翻旧版本的记录，
// 其与任何条目的相似都属同主题文档相似，不出 supersede 对。
// 依据：2026-11-16 真库首轮复核，15 对候选 14 对误报中过半源于版本条互撞（#388）。
const RELEASE_RE = /发布|收官|发版/;
const isReleaseNote = (row) => {
  const head = String(row?.content || "").slice(0, 80);
  return /v\d+\.\d+/.test(head) && RELEASE_RE.test(head);
};

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
      if (isReleaseNote(hi) || isReleaseNote(lo)) continue; // 版本时间线互不推翻
      if (hiDone && !loDone) addPair(lo, hi, sim, "supersede_signal");
    }
  }

  // 信号 2：取代性引用（引用点 ±refWindow 字符窗口内含严格取代词才算；不要求相似）
  const vecById = new Map(entries.map((e) => [e.row.id, e.v]));
  for (const e of entries) {
    const text = String(e.row.content || "");
    // 取代词必须"贴着"这条引用：
    //   a) 引用之后的括注段（到下一条引用为止）——「id=319（Agnes 弃用）」式；
    //   b) 引用之前、且中间不含其他 id 的同一从句——「取代旧方案 id=1」式。
    // 真库实证（2026-11-21）：#339 的「相关：id=319（Agnes 弃用）、id=320 v3（配图惯例）、
    // id=338、id=336」用固定 ±40 窗口时，319 的「弃用」会同时命中后面每一条 id，
    // 凭空造出三对误报；限定从句后不再跨条目泄漏。
    const refs = [...text.matchAll(/(?:id\s*=\s*|#)(\d+)(?![0-9])/g)];
    for (let k = 0; k < refs.length; k++) {
      const m = refs[k];
      const refId = Number(m[1]);
      if (refId === e.row.id) continue;
      const target = byId.get(refId);
      if (!target) continue;
      const segStart = m.index ?? 0;
      const segEnd = Math.min(refs[k + 1]?.index ?? text.length, segStart + m[0].length + refWindow);
      const prevEnd = k > 0 ? (refs[k - 1].index ?? 0) + refs[k - 1][0].length : 0;
      const segBefore = text.slice(prevEnd, segStart);
      const segAfter = text.slice(segStart + m[0].length, segEnd);
      // 前从句两个条件都满足才可用：中间没有别的 id，且去掉括注后仍有取代词
      // （「（Agnes 弃用）、id=13」的括注属于上一条，不能借给 13）。
      const beforeClean = !/(?:id\s*=\s*|#)\d+/.test(segBefore);
      const beforeBare = segBefore.replace(/（[^）]*）/g, '，').replace(/\([^)]*\)/g, ',');
      if (!(SUPERSEDE_RE.test(segAfter) || (beforeClean && SUPERSEDE_RE.test(beforeBare)))) continue;
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

// ---- v0.14.1 Level 2 语义复核（纯函数部分，供单测；fetch 薄壳在调用方）----
// 规则式信号只产候选对（真库实证误报率高），真伪判定交给模型：逐对判
// superseded（旧条已被接棒）/ related（相关但都有效）/ unrelated（纯属相似）。

/** 构造复核 prompt：候选对摘要+两侧更多上下文，要求纯 JSON 输出。 */
export function buildReviewPrompt(pairs) {
  const list = pairs.map((p, i) =>
    `[${i}] 旧#${p.old.id}（${p.old.updated_at}）：${p.old.snippet}\n` +
    `    新#${p.new.id}（${p.new.updated_at}）：${p.new.snippet}`
  ).join("\n");
  return `以下是记忆库中「疑似旧条已被新条接棒」的候选对（规则式粗筛，误报率高）。请逐对判断：

${list}

判断标准：
- superseded：旧条描述的状态/流程确实已被新条取代或解决，旧条继续被当现行会误导
- related：两条相关但各自仍然有效（版本时间线、历史事件、经验沉淀、互为补充都算 related）
- unrelated：只是文本相似，实质无关

只输出 JSON 数组，如 [{"i":0,"verdict":"related"},{"i":1,"verdict":"superseded"}]，不要解释。`;
}

/** 解析模型复核输出；解析失败返回 null（调用方降级为候选对播报）。 */
export function parseReview(text, pairCount) {
  let arr;
  try { arr = JSON.parse(String(text ?? "").match(/\[[\s\S]*\]/)?.[0] ?? "null"); }
  catch { return null; }
  if (!Array.isArray(arr)) return null;
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const i = Number(v?.i);
    if (!Number.isInteger(i) || i < 0 || i >= pairCount || seen.has(i)) continue;
    if (v?.verdict === "superseded" || v?.verdict === "related" || v?.verdict === "unrelated") {
      seen.add(i);
      out.push({ i, verdict: v.verdict });
    }
  }
  return out;
}
