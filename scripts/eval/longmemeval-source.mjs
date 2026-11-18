import {checkSecret} from '../../server/guards.mjs';
import {sparseRank} from '../../server/sparse-rank.mjs';

export const chunkSize = 384;
export const chunkStride = 320;

export function buildCorpus(question) {
  const batch = [];
  const locations = new Map();
  const seen = new Set();
  let privacyFiltered = 0;
  for (const [session, turns] of question.haystack_sessions.entries()) {
    const sid = String(question.haystack_session_ids[session]);
    const date = String(question.haystack_dates?.[session] ?? '').slice(0, 10);
    const prefix = `[${date} sid:${sid}]`;
    let offset = 0;
    const messages = turns.map((turn, index) => {
      const text = `${turn.role}: ${turn.content}`;
      const start = offset;
      offset += text.length + 1;
      return {text, role: turn.role, start, end: start + text.length, index};
    });
    const text = messages.map(message => message.text).join('\n');
    for (let start = 0; start < text.length; start += chunkStride) {
      const part = text.slice(start, start + chunkSize);
      if (part.trim().length < 3) continue;
      const original = `${prefix} ${part}`;
      const withheld = Boolean(checkSecret(original));
      const content = withheld ? `${prefix} [credential-pattern content withheld]` : original;
      if (withheld) {
        privacyFiltered++;
        for (const message of messages) {
          if (message.start < start + part.length && message.end > start) message.withheld = true;
        }
      }
      batch.push({
        content,
        kind: 'episode',
        tags: `lme,sid:${sid}`,
        ...(/^\d{4}-\d{2}-\d{2}$/.test(date) ? {event_date: date} : {}),
      });
      const normalized = content.trim();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      locations.set(seen.size, {content: normalized, session, sid, date, start,
        end: start + part.length, messages, withheld});
    }
  }
  return {batch, locations, privacyFiltered};
}

export function expandSourceMessages(hits, locations, maxBytes, query) {
  const blocks = hits.map(hit => hit.content);
  let bytes = Buffer.byteLength(blocks.join('\n'));
  if (bytes > maxBytes) throw new Error('Baseline context exceeds budget');
  const candidates = hits.map(hit => {
    const origin = locations.get(hit.id);
    if (!origin || origin.content !== hit.content || origin.withheld) return [];
    return origin.messages
      .map(message => ({message, overlap: Math.min(origin.end, message.end) -
        Math.max(origin.start, message.start)}))
      .filter(({message, overlap}) => overlap > 0 && !message.withheld && !checkSecret(message.text))
      .sort((a, b) => Number(b.message.role === 'user') - Number(a.message.role === 'user') ||
        b.overlap - a.overlap)
      .map(({message}) => ({message, origin, hit}));
  });
  const refs = [];
  const included = new Set();
  const unavailable = ({message, origin}) =>
    included.has(`${origin.session}:${message.index}`) || hits.some(other => {
      const location = locations.get(other.id);
      return location?.session === origin.session && other.content.includes(message.text);
    });
  const append = (candidate, method) => {
    if (unavailable(candidate)) return;
    const {message, origin, hit} = candidate;
    const block = `[${origin.date} sid:${origin.sid} turn:${message.index}] ${message.text}`;
    const size = Buffer.byteLength(block) + Number(blocks.length > 0);
    if (bytes + size > maxBytes) return;
    blocks.push(block);
    bytes += size;
    included.add(`${origin.session}:${message.index}`);
    refs.push({session: origin.sid, session_index: origin.session, turn: message.index, hit_id: hit.id, method});
  };
  if (query) {
    // Search full user turns only inside sessions represented by a real, safe hit.
    const sessions = new Set();
    const userTurns = [];
    for (const hit of hits) {
      const origin = locations.get(hit.id);
      if (!origin || origin.content !== hit.content || origin.withheld || sessions.has(origin.session)) continue;
      sessions.add(origin.session);
      for (const message of origin.messages) {
        const candidate = {message, origin, hit};
        if (message.role !== 'user' || message.withheld || checkSecret(message.text) ||
            unavailable(candidate) || Buffer.byteLength(message.text) > maxBytes - bytes) continue;
        userTurns.push(candidate);
      }
    }
    const ranked = sparseRank(query, userTurns.map(({message}, id) => ({
      id, content: message.text,
    })), {limit: userTurns.length});
    const perSession = new Map();
    for (const {id} of ranked) {
      const candidate = userTurns[id];
      const session = candidate.origin.session;
      if ((perSession.get(session) ?? 0) >= 2) continue;
      const before = refs.length;
      append(candidate, 'session-user-rank');
      if (refs.length > before) perSession.set(session, (perSession.get(session) ?? 0) + 1);
      if (refs.length >= hits.length) break;
    }
  }
  const rounds = Math.max(0, ...candidates.map(group => group.length));
  for (let round = 0; round < rounds && (!query || refs.length < hits.length); round++) {
    for (const group of candidates) {
      if (query && refs.length >= hits.length) break;
      const candidate = group[round];
      if (candidate) append(candidate, 'overlap');
    }
  }
  return {snippets: blocks.join('\n'), refs, bytes};
}

export function readerPrompt(question, snippets) {
  return `Answer the question from these past conversation records only. Resolve conflicting current facts using their event dates. Relative dates refer to the conversation date. If information is missing say "I don't have enough information." Give a direct answer in at most 80 words.\nQuestion date: ${question.question_date ?? ''}\nRecords:\n${snippets}\nQuestion: ${question.question}`;
}
