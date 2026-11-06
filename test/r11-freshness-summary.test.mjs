import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/opsmap/map-data-sync.js';
const summarize=globalThis.MapFreshnessSummary.summarize;
const now=Date.parse('2026-11-02T20:00:00Z');
const base={startDate:'2026-07-22',latestDate:'2026-11-03',stale:true,generatedAt:'2026-11-02T19:00:00Z'};
const checkpoint={date:'2026-11-03',sourceReadComplete:true,sourceDateVerified:true,selectedDateStorageVerified:true,checkedAt:'2026-11-02T19:30:00Z',historicalCompletenessVerified:false};
test('a current stored date is separate from unverified history and uses KST source time',()=>{
 const v=summarize({partial:true},{...base,selectedDateCheckpoint:checkpoint},{now});
 assert.equal(v.state,'TODAY_STORED');assert.match(v.text,/2026\.07\.22 ~ 2026\.11\.03/);assert.match(v.text,/04:30/);assert.match(v.text,/당일 저장 확인 · 일부 기간 검증 미완료/);assert.equal(v.publicationVerified,false);
});
test('an observed date or restart-generated timestamp alone cannot certify sync',()=>{
 const v=summarize({},base,{now});assert.equal(v.state,'INCOMPLETE');assert.equal(v.lastSync,null);assert.match(v.text,/동기화 미확인/);
});
test('a prior-day checkpoint cannot masquerade as current business data',()=>{
 const v=summarize({}, {...base,selectedDateCheckpoint:{...checkpoint,date:'2026-11-02'}},{now});assert.equal(v.selectedDateStored,false);assert.equal(v.state,'INCOMPLETE');
});
test('a verified older checkpoint retains its KST timestamp during a query failure',()=>{
 const previous={...checkpoint,date:'2026-11-02',checkedAt:'2026-11-02T09:20:00Z'};
 const saved={...base,selectedDateCheckpoint:previous};
 const v=summarize({},saved,{now,failed:true});
 assert.equal(v.state,'QUERY_FAILED');assert.equal(v.lastSync,null);assert.equal(v.lastVerified,previous.checkedAt);
 assert.match(v.text,/마지막 검증 2026\.11\.02 18:20/);
 assert.equal(summarize({}, {...saved,selectedDateCheckpoint:{...previous,selectedDateStorageVerified:false}},{now}).lastVerified,null);
});
test('active work and query failure do not say completed or erase the known range',()=>{
 assert.equal(summarize({job:{phase:'VERIFY'}},base,{now}).state,'UPDATING');
 const v=summarize({},base,{now,failed:true});assert.equal(v.state,'QUERY_FAILED');assert.equal(v.startDate,base.startDate);assert.match(v.text,/조회 실패/);
});
test('a same-generation stage pointer without Production proof is insufficient',()=>{
 const d={published:{endDate:'2026-11-03'},publicationConnection:{servingGenerationMatch:true,rollingRootVerified:false,sourceBoundCompletionVerified:false,privateSealedBindingVerified:false}};
 assert.equal(summarize(d,base,{now}).publicationVerified,false);
});
test('only independently complete publication proof produces latest-published state',()=>{
 const d={partial:false,published:{endDate:'2026-11-03'},automation:{lastSuccess:'2026-11-02T19:00:00Z'},publicationConnection:{servingGenerationMatch:true,rollingRootVerified:true,sourceBoundCompletionVerified:true,privateSealedBindingVerified:true}};
 const v=summarize(d,{...base,sourceCompletenessVerified:true,selectedDateCheckpoint:{historicalCompletenessVerified:true}},{now});assert.equal(v.state,'PUBLISHED_VERIFIED');assert.equal(v.partial,false);
});
