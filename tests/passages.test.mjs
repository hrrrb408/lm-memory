import {test} from 'node:test';
import assert from 'node:assert/strict';
import {passageWindows} from '../server/passages.mjs';
test('windows cover the tail and overlap without splitting surrogate pairs',()=>{
 const text='😀'.repeat(700)+'TAIL-CITY';const windows=passageWindows(text);
 assert.ok(windows.at(-1).endsWith('TAIL-CITY'));assert.ok(windows.every(w=>Array.from(w).length<=384));
 assert.equal(windows[0].slice(-128),windows[1].slice(0,128));
 assert.throws(()=>passageWindows('x',5,5));
});
