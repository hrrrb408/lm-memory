import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.mjs';

test('current.md enforces limits under a real pinned backlog and pointers still resolve', async () => {
  const f = await fixture();
  try {
    const id = await f.remember('置顶预算测试');
    const insert = f.db.prepare("INSERT INTO memories(kind,content,status,created_at,updated_at,pinned) VALUES('fact',?,'active',?,?,1)");
    const date = new Date().toISOString();
    for (let i=0; i<100; i++) insert.run(`预算条目${i}：${'😀中文证据'.repeat(200)}`, date, date);
    await f.call('memory_pin', {id,action:'pin'});
    const index = fs.readFileSync(path.join(f.dir,'current.md'),'utf8');
    assert.ok(Buffer.byteLength(index) <= 25*1024);
    assert.ok(index.trimEnd().split('\n').length <= 200);
    assert.match(index,/注入预算已满/);
    assert.equal((await f.recall({id:100}))[0].content, f.db.prepare('SELECT content FROM memories WHERE id=100').get().content);
  } finally { await f.close(); }
});

test('refresh injection has a hard UTF-8 budget in an isolated plugin session', async () => {
  const f = await fixture();
  try {
    const plugin = (await import('../plugin/lib/index.js')).default;
    const handlers = {};
    plugin({on:(name,fn) => {handlers[name]=fn;}},{memoryDir:f.dir,refresh:true});
    const file=path.join(f.dir,'changes.jsonl'); fs.writeFileSync(file,'');
    const payload={agent:{session:{id:'budget-test'}},signal:{aborted:false}};
    const step=()=>handlers['agent/pre-step'](payload,async()=>({kind:'enter',messages:[]}));
    await step();
    for(let i=0;i<20;i++) fs.appendFileSync(file,JSON.stringify({op:'remember',id:i,kind:'fact',content:'😀'.repeat(200),reason:'😀'.repeat(100)})+'\n');
    const result=await step();
    const text=result.messages[0].content[0].text;
    assert.ok(Buffer.byteLength(text)<=8192);
    assert.ok(text.trimEnd().split('\n').length<=40);
    assert.match(text,/另有 12 条/);
    assert.equal((await step()).messages.length,0);
  } finally { await f.close(); }
});
