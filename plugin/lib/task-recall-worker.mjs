import { parentPort, workerData } from 'node:worker_threads';
import { checkSecret, OPTOUT_RE } from '../../server/guards.mjs';

// No server startup, index rebuild, queue drain, embeddings, network or
// feedback. An unavailable SQLite/FTS index is an abstention, not a full scan.
function lookup({ dbPath, terms }) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') ?? {};
  if (!DatabaseSync || !Array.isArray(terms) || terms.length < 1 || terms.length > 2 ||
      terms.some(term => typeof term !== 'string' || !/^[\p{L}\p{N} ._-]{4,40}$/u.test(term))) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const match = `content : (${terms.map(t => `"${t}"`).join(' AND ')})`;
    const rows = db.prepare(`SELECT m.id, m.content FROM memories_fts
      JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ? AND m.status='active'
      AND m.kind IN ('fact','preference','procedure') LIMIT 2`).all(match);
    if (rows.length !== 1) return null;
    const [{ id, content }] = rows;
    if (checkSecret(content) || OPTOUT_RE.test(content)) return null;
    for (const term of terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (/^[a-z0-9 ._-]+$/i.test(term) &&
          !new RegExp(`(?:^|[^a-z0-9_-])${escaped}(?:$|[^a-z0-9_-])`, 'i').test(content)) return null;
    }
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } finally { db.close(); }
}

let id = null;
try { id = lookup(workerData); } catch {} // Never log a user query or a memory.
parentPort.postMessage(id);
