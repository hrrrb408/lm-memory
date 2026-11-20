import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './helpers.mjs';

test('explicit dated replacement and correction distinguish a former truth from an erroneous claim', async t => {
  const f = await fixture({LM_EMBED:'0',LM_REMOTE_DISABLED:'1'});
  t.after(() => f.close());
  const call = (name,args) => f.call(`memory_${name}`,args);
  const id = text => Number(text.match(/id=(\d+)/)?.[1]);
  const original = id(await call('remember',{kind:'fact',content:'Release channel is amber.',event_date:'2024-01-09',valid_from:'2024-01-01'}));
  assert.ok(original);
  const changed = id(await call('correct',{id:original,expected_version:1,content:'Release channel is blue.',effective_from:'2024-02-01'}));
  assert.ok(changed && changed !== original);
  assert.match(await call('recall',{id:changed,as_of:'2024-01-31'}), /amber.*valid_until":"2024-02-01/);
  assert.match(await call('recall',{id:changed,as_of:'2024-02-01'}), /blue/);
  assert.match(await call('recall',{id:changed,as_of:'2023-12-31'}), /^\[\]/);
  assert.match(await call('correct',{id:changed,expected_version:2,content:'Release channel is a wrong date.',effective_from:'2024-01-01'}), /^ERROR/);
  const fixed = id(await call('correct',{id:changed,expected_version:2,content:'Release channel is cobalt.'}));
  assert.match(await call('recall',{id:fixed,as_of:'2024-03-01'}), /cobalt/);
  assert.match(await call('recall',{id:fixed,as_of:'2024-01-31'}), /amber/);
  assert.doesNotMatch(await call('recall',{id:fixed}), /amber|blue/);
  assert.match(await call('recall',{id:original,as_of:'2024-01-31'}), /^\[\]/);
  await call('forget',{id:original,hard:true});
  assert.match(await call('recall',{id:fixed,as_of:'2024-01-31'}), /^\[\]/);
});
