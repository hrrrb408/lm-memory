import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abstains,questionIdentity} from '../scripts/eval/locomo-scoring.mjs';
test('cat5 recognizes the abstention instruction supplied to the real reader',()=>{
 for(const s of ["I don't have enough information.",'I don’t have enough information.','No information available.','Not mentioned.'])assert.equal(abstains(s),true);
 assert.equal(abstains('The plausible distractor says it is true.'),false);
});
test('repeated question wording does not collapse distinct dataset records',()=>{
 assert.notEqual(questionIdentity('conv',1),questionIdentity('conv',2));
});
