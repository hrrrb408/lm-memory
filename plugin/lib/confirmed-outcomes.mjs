import { createHash } from 'node:crypto';
import { checkSecret, OPTOUT_RE } from '../../server/guards.mjs';

const confirmation = /^(确认结论|确认修复)：([^\r\n]+)$/u;
const textBlocks = content => (Array.isArray(content) ? content : []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text);
export const isOutcomeConfirmation = text => /^(确认结论|确认修复)：/u.test(text);

// Only a complete, literal quote from the last assistant message, confirmed
// in the next real user message. No tool output or unconfirmed assistant text.
export function confirmedOutcomes(session) {
  if (!/^session-[a-f\d-]{36}$/.test(session?.id ?? '')) return [];
  let previous = [];
  const result = [];
  for (const event of session.ownEvents()) {
    if (event.type === 'assistant/message') {
      previous = event.data?.interrupted || event.data?.message?.content?.some?.(block => block.type === 'tool-call')
        ? [] : textBlocks(event.data?.message?.content).flatMap(text => text.split(/\r?\n/u)).map(text => text.trim());
      continue;
    }
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') continue;
    const [line, ...others] = textBlocks(event.data.content);
    const match = !others.length && event.data?.content?.length === 1 && confirmation.exec(line ?? '');
    const content = match?.[2]?.trim();
    const stamp = event.time ?? event.timestamp ?? event.ts ?? event.data?.timestamp;
    const when = new Date(stamp ?? NaN);
    if (content && content.length >= 4 && Buffer.byteLength(content) <= 1500 && previous.includes(content) &&
        !OPTOUT_RE.test(line) && !checkSecret(line) && Number.isFinite(when.getTime())) {
      const kind = match[1] === '确认修复' ? 'procedure' : 'fact';
      const capturedAt = when.toISOString();
      const eid = 'confirmed-' + createHash('sha256').update(JSON.stringify([session.id, event.seq ?? capturedAt, kind, content])).digest('hex');
      result.push({ eid, sessionId: session.id, kind, content, capturedAt, eventDate: when.toLocaleDateString('sv'),
        tags: `confirmed-outcome,session:${session.id}`, evidence: [{ message_index: Number.isSafeInteger(event.seq) ? event.seq : null, text: line }] });
    }
    previous = [];
  }
  return result;
}
