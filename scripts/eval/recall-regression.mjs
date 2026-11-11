#!/usr/bin/env node
// Own mkdtemp only. No remote answer model, production DB, viewer, or deployment.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from '../../tests/helpers.mjs';
import { measureCase, summarize } from './recall-metrics.mjs';
const raw = fs.readFileSync(new URL('../../tests/fixtures/recall-regression.json', import.meta.url));
const data = JSON.parse(raw);
const semantic = process.argv.includes('--semantic');
if (process.env.NODE_OPTIONS?.includes('mock-embeddings')) throw new Error('Quality evaluation refuses model doubles');
const f = await fixture({ LM_EMBED: semantic ? '1' : '0' });
const mapping = new Map(), reverse = new Map();
try {
  for (const m of data.memories) {
    const id = await f.remember(m.content, m.kind, `regression,session:${m.id}`);
    mapping.set(m.id, id); reverse.set(id, m);
    const date = new Date(Date.UTC(2026, 0, 1) + mapping.size * 1000).toISOString();
    f.db.prepare('UPDATE memories SET created_at=?, updated_at=? WHERE id=?').run(date, date, id);
  }
  const coverage = f.db.prepare('SELECT count(*) n FROM memories WHERE emb IS NOT NULL AND emb_en IS NOT NULL').get().n;
  if (semantic && coverage !== data.memories.length) throw new Error(`Incomplete real embedding coverage ${coverage}/${data.memories.length}`);
  const rows = [];
  // Measure the actual MCP roundtrip, including query embedding and result serialization; startup excluded.
  for (const k of [1, 5]) for (const q of data.queries) {
    const start = performance.now();
    const response = await f.recall({ query: q.query, limit: k });
    const latency_ms = performance.now() - start;
    const hits = Array.isArray(response) ? response : response.hits;
    const returned = hits.map(r => ({ id: reverse.get(r.id)?.id ?? `unknown:${r.id}`,
      complete: reverse.get(r.id)?.content === r.content }));
    rows.push({ question_id: q.id, category: q.category, k, ...measureCase(q, returned), returned_ids: returned.map(r => r.id), latency_ms });
  }
  const report = { schema_version: 1, corpus_sha256: createHash('sha256').update(raw).digest('hex'),
    head: execFileSync('git', ['rev-parse', 'HEAD'], {cwd:fileURLToPath(new URL('../../', import.meta.url)), encoding:'utf8'}).trim(),
    source_sha256: Object.fromEntries(['server/memory-server.mjs','server/recall-utils.mjs','scripts/eval/recall-metrics.mjs'].map(name => [name, createHash('sha256').update(fs.readFileSync(new URL('../../' + name, import.meta.url))).digest('hex')])),
    working_tree_dirty: execFileSync('git', ['status','--porcelain'], {cwd:fileURLToPath(new URL('../../', import.meta.url)),encoding:'utf8'}).trim().length > 0,
    node: process.version, platform: process.platform, mode: semantic ? 'real-bilingual-embeddings' : 'lexical-only',
    embedding_coverage: coverage, memories: data.memories.length, created_at: new Date().toISOString(),
    corpus_provenance: data.provenance, answer_accuracy: 'NOT_RUN (retrieval-only; no answer model)',
    summary: [1, 5].map(k => summarize(rows.filter(r => r.k === k), k)), rows };
  console.log(JSON.stringify(report, null, 2));
  // Freeze quality, not just process exit: any aggregate degradation fails the local gate.
  if (!semantic) {
    const baseline = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/recall-baseline.json', import.meta.url)));
    if (baseline.corpus_sha256 !== report.corpus_sha256) throw new Error('Corpus changed: review annotations and explicitly renew the baseline');
    for (const expected of baseline.summary) {
      const actual = report.summary.find(s => s.k === expected.k);
      for (const key of ['hit_at_k','evidence_complete_rate','evidence_group_coverage']) {
        if (actual[key] + 1e-12 < expected[key]) process.exitCode = 1;
      }
      for (const key of ['false_recall_rate','abstention_false_positive_rate']) {
        if (actual[key] - 1e-12 > expected[key]) process.exitCode = 1;
      }
    }
  }
} finally { await f.close(); }
