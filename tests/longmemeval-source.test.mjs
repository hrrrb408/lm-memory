import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildCorpus,expandSourceMessages} from '../scripts/eval/longmemeval-source.mjs';

test('parent messages preserve original snippets, respect budget and deduplicate hits', () => {
  const text = '中文'.repeat(240) + ' target fact';
  const {locations} = buildCorpus({
    haystack_sessions: [[{role:'user',content:text}], [{role:'user',content:'Unrelated session'}]],
    haystack_session_ids: ['a','b'], haystack_dates: ['2024-01-02','2024-01-03'],
  });
  const hits = [1, 2].map(id => ({id,content:locations.get(id).content}));
  const original = hits.map(hit => hit.content).join('\n');
  const result = expandSourceMessages(hits, locations, 4096);
  assert.ok(result.snippets.startsWith(original + '\n'));
  assert.ok(result.snippets.includes('turn:0] user: ' + text));
  assert.ok(!result.snippets.includes('Unrelated session'));
  assert.equal(result.refs.length, 1);
  assert.equal(result.bytes, Buffer.byteLength(result.snippets));
  assert.equal(expandSourceMessages(hits, locations, Buffer.byteLength(original)).snippets, original);
  assert.equal(expandSourceMessages([{id:1,content:'wrong mapping'}], locations, 4096).refs.length, 0);
});

test('parent expansion cannot reconstruct a credential from split chunks', () => {
  const text = 'x'.repeat(550) + '\napi_key=syntheticTestValue123\n';
  const {locations,privacyFiltered} = buildCorpus({
    haystack_sessions: [[{role:'user',content:text}]],
    haystack_session_ids: ['a'],
  });
  assert.ok(privacyFiltered > 0);
  const hit = {id:1,content:locations.get(1).content};
  assert.equal(expandSourceMessages([hit], locations, 4096).snippets, hit.content);
});

test('query reranks complete user messages only in matched sessions', () => {
  const {locations} = buildCorpus({
    haystack_sessions: [
      [{role:'assistant',content:'a'.repeat(1000)}, {role:'user',content:'Quinoa is my favorite.'}],
      [{role:'user',content:'I purchased quinoa yesterday.'}],
    ],
    haystack_session_ids: ['matched','unmatched'],
  });
  const hits = [{id:1,content:locations.get(1).content}];
  const expanded = expandSourceMessages(hits, locations, 4096, 'What do I like about quinoa?');
  assert.ok(expanded.snippets.includes('Quinoa is my favorite.'));
  assert.ok(!expanded.snippets.includes('I purchased quinoa yesterday.'));
  assert.deepEqual(expanded.refs, [{
    session:'matched', session_index:0, turn:1, hit_id:1, method:'session-user-rank',
  }]);
});
