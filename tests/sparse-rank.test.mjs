import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sparseRank,searchTokens} from '../server/sparse-rank.mjs';
test('word matching separates punctuation and possessives and downweights common names',()=>{
 const rows=[{id:1,content:"Mira's school is in Sweden."},{id:2,content:'Mira enjoys cooking every evening.'},{id:3,content:'Mira is cooking and cooking with friends.'}];
 assert.equal(sparseRank("Where was Mira's school?",rows)[0].id,1);
 assert.ok(searchTokens("Mira's school?").includes('school'));
 assert.deepEqual(sparseRank('quantum computers',rows),[]);
});
test('scores do not depend on input iteration order',()=>{
 const rows=[{id:2,content:'same fact'},{id:1,content:'same fact'}];
 assert.deepEqual(sparseRank('fact',rows),sparseRank('fact',[...rows].reverse()));
});
