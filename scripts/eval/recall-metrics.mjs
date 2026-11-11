// Metrics consume full returned evidence, not session coincidence or truncated snippets.
export function measureCase(question, returned) {
  const relevant = new Set(question.relevant_ids);
  const ids = new Set(returned.map(r => r.id));
  const supported = new Set(returned.filter(r => r.complete).map(r => r.id));
  const groups = question.required_groups;
  const groupsFound = groups.filter(group => group.some(id => supported.has(id))).length;
  return {
    positive: groups.length > 0,
    hit: [...ids].some(id => relevant.has(id)),
    evidence_complete: groups.length > 0 && groupsFound === groups.length,
    groups_found: groupsFound, groups_total: groups.length,
    false_hits: returned.filter(r => !relevant.has(r.id)).length,
    returned: returned.length,
    abstention_false_positive: groups.length === 0 && returned.length > 0,
  };
}
export function summarize(rows, k) {
  const positives = rows.filter(r => r.positive), negatives = rows.filter(r => !r.positive);
  const ratio = (n, d) => d ? n / d : null;
  const latency = rows.map(r => r.latency_ms).sort((a, b) => a - b);
  const percentile = p => latency[Math.max(0, Math.ceil(latency.length * p) - 1)] ?? null;
  return { k, questions: rows.length, positives: positives.length, negatives: negatives.length,
    hit_at_k: ratio(positives.filter(r => r.hit).length, positives.length),
    evidence_complete_rate: ratio(positives.filter(r => r.evidence_complete).length, positives.length),
    evidence_group_coverage: ratio(rows.reduce((s,r) => s+r.groups_found,0), rows.reduce((s,r) => s+r.groups_total,0)),
    false_recall_rate: ratio(rows.reduce((s,r) => s+r.false_hits,0), rows.reduce((s,r) => s+r.returned,0)),
    abstention_false_positive_rate: ratio(negatives.filter(r => r.abstention_false_positive).length, negatives.length),
    latency_ms: { p50: percentile(.5), p95: percentile(.95), max: latency.at(-1) ?? null } };
}
