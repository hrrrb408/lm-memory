import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmedOutcomes } from '../plugin/lib/confirmed-outcomes.mjs';

const answer = 'Use the project checksum to verify the repaired deployment.';
const time = Date.UTC(2026,10,20,12);
const assistant = (text=answer, extra={}) => ({type:'assistant/message',data:{message:{content:[{type:'text',text}]},...extra}});
const human = (text, kind='user', stamp=time) => ({type:'user/message',seq:21,time:stamp,data:{source:{kind},content:[{type:'text',text}]}});
const resolve = (...events) => confirmedOutcomes({id:'session-00000000-0000-0000-0000-000000000001',ownEvents:()=>events});

test('confirmation stores only the full stated line and its human evidence',()=>{
  const line = '确认修复：'+answer;
  const rows = resolve(assistant(answer+'\nExtra unconfirmed detail.'),human(line));
  assert.equal(rows.length,1);
  assert.equal(rows[0].kind,'procedure');
  assert.equal(rows[0].content,answer);
  assert.deepEqual(rows[0].evidence,[{message_index:21,text:line}]);
  assert.equal(rows[0].eid,resolve(assistant(answer),human(line))[0].eid);
  assert.equal(resolve(assistant(answer),human('确认结论：'+answer))[0].kind,'fact');
});

test('skips tools, old or interrupted assistant turns, synthetic approval, secrets and opt-outs',()=>{
  for (const events of [
    [assistant()], [assistant(),human('确认修复：Use the project checksum')],
    [assistant(),human('Different question'),human('确认修复：'+answer)],
    [assistant(answer,{interrupted:true}),human('确认修复：'+answer)],
    [assistant(),human('确认修复：'+answer,'runtime-context')],
    [assistant(),human('确认修复：'+answer,'user',NaN)],
    [{type:'tool/result',data:{content:[{type:'text',text:answer}]}},human('确认修复：'+answer)],
    [assistant('password=abcdefghijkl'),human('确认结论：password=abcdefghijkl')],
    [assistant('这句不要记，这是测试'),human('确认结论：这句不要记，这是测试')],
  ]) assert.deepEqual(resolve(...events),[]);
});
