import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoreRoadBudget} from '../../src/hubRoadBudget.js';
import {createMemoryCoordinateStore} from '../../src/opsmapCoordinateIngestion.js';
const accountHash='a'.repeat(64);
test('private CAS budget resumes existing usage, exhausts and never initializes missing approval',async()=>{
 const store=createMemoryCoordinateStore();
 await assert.rejects(createStoreRoadBudget({store,accountHash}).reserve({cost:1,provider:'kakao-directions'}),e=>e.code==='CALL_POLICY_BLOCKED');
 await store.transaction(async(s,save)=>{s.roadBudget={scope:'CUMULATIVE_APPROVED_ACCOUNT',approvalId:'synthetic-approval',accountHash,limit:3,used:2};await save(s);});
 const first=createStoreRoadBudget({store,accountHash});await first.reserve({cost:1,provider:'kakao-directions'});
 const reopened=createStoreRoadBudget({store,accountHash});assert.equal((await reopened.status()).remaining,0);
 await assert.rejects(reopened.reserve({cost:1,provider:'kakao-directions'}),e=>e.code==='QUOTA_EXCEEDED');
 await assert.rejects(createStoreRoadBudget({store,accountHash:'b'.repeat(64)}).status());
 assert.equal(store.snapshot().roadBudget.used,3);
});
