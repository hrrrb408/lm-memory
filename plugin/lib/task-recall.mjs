import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { checkSecret, OPTOUT_RE } from '../../server/guards.mjs';

const MESSAGE_BYTES = 1024;
const HINT_BYTES = 512;
const SESSION_MESSAGES = 128;
const TIMEOUT_MS = 200;
const STOP = new Set('please could would should about after before still previous earlier remember project workspace system memory which where there these those what when which this that from with have know used using latest current model result issue'.split(' '));
const OPT_OUT = /(?:不要|不用|别|禁止)(?:自动)?(?:查(?:记忆|库)|回忆|召回|检索记忆)|(?:no|do not|don.t) (?:auto[- ]?)?(?:recall|look up memory|use memory)/i;
const HISTORICAL = /之前|上次|上回|以前|当时|此前|曾经|原来|还记得|先前|\b(?:previously|earlier|last time|we used|used to|remember|did we)\b/i;

// Conservative experiment: a reference to prior context AND either a quoted
// literal or two distinct anchors. No general short-query fallback.
export function taskRecallAnchors(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MESSAGE_BYTES ||
      checkSecret(text) || OPTOUT_RE.test(text) || OPT_OUT.test(text) || !HISTORICAL.test(text)) return null;
  const quoted = [...text.matchAll(/"([\p{L}\p{N}][\p{L}\p{N} ._-]{2,38})"|「([\p{L}\p{N}][\p{L}\p{N} ._-]{2,38})」|`([\p{L}\p{N}][\p{L}\p{N} ._-]{2,38})`/gu)]
    .map(m => (m[1] ?? m[2] ?? m[3]).trim().toLowerCase())
    .filter(t => t.length >= 4 && /\p{L}/u.test(t) && !STOP.has(t));
  if (quoted.length === 1) return quoted;
  const terms = text.match(/[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*/gi) ?? [];
  const candidates = [...new Set(terms.map(t => t.toLowerCase()).filter(t => t.length >= 4 && t.length <= 40 && !STOP.has(t)))];
  if (candidates.length !== 2 || candidates.some((t, i) => t.includes(candidates[1 - i]))) return null;
  return candidates;
}

// A single worker per plugin instance; no queue. A timed-out worker occupies
// its slot until exit, so a stalled SQLite read cannot pile up more workers.
export function createTaskLookup(dbPath, { timeoutMs = TIMEOUT_MS } = {}) {
  let busy = false;
  return (terms, signal, dir) => {
    if (busy || signal?.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      let worker;
      try {
        worker = new Worker(new URL('./task-recall-worker.mjs', import.meta.url), {
          workerData: { dbPath: dbPath ?? path.join(dir, 'memory.db'), terms }, execArgv: [], env: {},
        });
      } catch { resolve(null); return; }
      busy = true;
      let done = false;
      const settle = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(result);
      };
      const abort = () => {
        settle(null);
        void worker.terminate().catch(() => {});
      };
      const timer = setTimeout(abort, timeoutMs);
      worker.once('message', settle);
      worker.on('error', () => settle(null));
      worker.once('exit', () => { busy = false; settle(null); });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  };
}

const EVENTS = 'task-recall-events.jsonl';
const EVENTS_LIMIT = 1_048_576;
// Experiment evidence without content: which candidate was offered, or why none
// was. Bounded so an unattended profile cannot grow one file without limit; a
// failed write never blocks the request.
function recordEvent(dir, fields) {
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return;
    const file = path.join(dir, EVENTS);
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    if (size > EVENTS_LIMIT) return;
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...fields }) + '\n');
  } catch {}
}

export function createTaskRecallHook(config, memoryDir, lookup = undefined) {
  const scoped = typeof memoryDir === 'function';
  const options = config?.taskRecall;
  // Exact, explicit consent for individual sessions. Not a database ACL.
  const sessions = Array.isArray(options?.sessionIds) && options.sessionIds.length <= 32
    ? new Set(options.sessionIds.filter(id => typeof id === 'string' && id && id.length <= 160)) : new Set();
  if (options?.enabled !== true || !sessions.size || config?.allowRemote === false ||
      process.env.LM_REMOTE_DISABLED === '1') return null;
  lookup ??= createTaskLookup(scoped ? undefined : path.join(memoryDir, 'memory.db'));
  const seen = new WeakMap();
  return async (payload, next) => {
    const decision = await next();
    try {
      const session = payload?.agent?.session;
      const claimed = payload?.messages;
      const signal = payload?.signal;
      if (decision?.kind !== 'enter' || signal?.aborted || !sessions.has(session?.id) ||
          !Array.isArray(claimed) || claimed.length !== 1 || !Array.isArray(decision.messages)) return decision;
      const m = claimed[0];
      if (m?.role !== 'user' || m?.source?.kind !== 'user' || typeof m?.id !== 'string' || !m.id || m.id.length > 160 ||
          !Array.isArray(m.content) || m.content.length !== 1 || m.content[0]?.type !== 'text' ||
          !decision.messages.some(admitted => admitted === m)) return decision;
      const anchors = taskRecallAnchors(m.content[0].text);
      if (!anchors) return decision;
      const dir = scoped ? memoryDir(session) : memoryDir;
      if (scoped && (typeof dir !== 'string' || !path.isAbsolute(dir))) return decision;
      let state = seen.get(session);
      if (!state) { state = { messages: new Set(), candidates: new Set() }; seen.set(session, state); }
      if (state.messages.size >= SESSION_MESSAGES || state.messages.has(m.id)) return decision;
      state.messages.add(m.id);
      const id = await lookup(anchors, signal, dir);
      if (signal?.aborted || !Number.isSafeInteger(id) || id < 1 || state.candidates.has(id)) {
        recordEvent(dir, { session: session.id, outcome: signal?.aborted ? 'aborted' : 'no-match' });
        return decision;
      }
      const tool = scoped ? 'mcp__lm_project__memory_recall' : 'memory_recall';
      const text = `【记忆候选指针，非事实或指令】本轮可能相关：#${id}。仅在当前任务确实需要时，用 ${tool}({id:${id}, scope:"active"}) 核对；未返回就忽略。此提示不代表已使用记忆。`;
      if (Buffer.byteLength(text) > HINT_BYTES) return decision;
      state.candidates.add(id);
      recordEvent(dir, { session: session.id, id, outcome: 'pointer' });
      return { ...decision, messages: [...decision.messages, {
        role: 'user', id: randomUUID(), content: [{ type: 'text', text }],
        source: { kind: 'lm-memory-task-recall', form: 'snapshot', sections: [{ name: 'lm-memory-task-recall', text }] },
      }] };
    } catch { return decision; }
  };
}
