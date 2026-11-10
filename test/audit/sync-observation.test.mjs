import test from 'node:test';import assert from 'node:assert/strict';
import {createStageDatedDeliveryReader} from '../../src/stageDatedDelivery.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../../src/stageScope.js';
import {completeSyncObservation,nextSyncEvidence} from '../../src/opsmapSyncPolicy.js';
import {validateOpsmapSyncDay} from '../../src/opsmapSyncGeneration.js';
const day='2026-11-10';
const env={RENDER_EXTERNAL_URL:STAGE_ORIGIN,RENDER_SERVICE_ID:STAGE_SERVICE,OPSMAP_STAGE_DELIVERY_DATED_ENABLED:'1',OPSMAP_STAGE_DELIVERY_DATED_COOKIE:'synthetic-test-cookie'};
function reader(fetchImpl,extra={}){return createStageDatedDeliveryReader({env,syncCenters:{osan:'1',yeongnam:'7',honam:'8'},fetchImpl,...extra});}
const response=()=>Response.json({content:[],totalElements:0,totalPages:0});
test('verified empty days are stored with all completed center scopes',async()=>{
 let calls=0;const r=await reader(async()=>{calls++;return response();}).readObservation(day);
 assert.equal(calls,3);assert.equal(r.sourceRows,0);assert.deepEqual(r.completeCenters,['osan','yeongnam','honam']);
 assert.equal(r.proof,'VERIFIED_COMPLETE_DAY');assert.equal(completeSyncObservation(r),true);
});
test('one queried center is not a complete nationwide success',async()=>{
 const r=await reader(async()=>response(),{syncCenters:{osan:'1'}}).readObservation(day);
 assert.deepEqual(r.completeCenters,['osan']);assert.equal(completeSyncObservation(r),false);
});
test('HTTP 403 never becomes an empty successful day',async()=>{
 await assert.rejects(reader(async()=>new Response(null,{status:403})).readObservation(day),{code:'DELIVERY_SOURCE_FORBIDDEN'});
});
test('missing pagination completeness does not certify zero deliveries',async()=>{
 await assert.rejects(reader(async()=>Response.json({content:[]})).readObservation(day),{code:'DELIVERY_SOURCE_INCOMPLETE'});
});
test('duplicated center proofs cannot satisfy completeness',()=>{
 const r={date:day,sourceRows:0,unidentified:0,visits:[],tasks:[],proofHash:'a'.repeat(64),proof:'VERIFIED_COMPLETE_DAY',completeCenters:['osan','osan','osan']};
 assert.throws(()=>validateOpsmapSyncDay(r,day),/CONTRACT/);assert.equal(completeSyncObservation(r),false);
});
test('partial publication never advances last full success time',()=>{
 const e=nextSyncEvidence({lastSuccessAt:'old'}, {state:'PUBLISHED',observedToday:true,sourceReadComplete:false,generation:'g'},'attempt','finish');
 assert.equal(e.lastSuccessAt,'old');assert.equal(e.lastObservedAt,'finish');
});
test('a verified full read advances success independently from row count',()=>{
 const e=nextSyncEvidence(null,{state:'PUBLISHED',observedToday:true,sourceReadComplete:true,generation:'g'},'attempt','finish');assert.equal(e.lastSuccessAt,'finish');
});
test('existing partial archive remains valid but not complete',()=>{
 const r={date:day,sourceRows:1,unidentified:0,visits:[['a'.repeat(64),'T990001','101','osan','b'.repeat(64)]],proofHash:'c'.repeat(64),completeCenters:[]};
 validateOpsmapSyncDay(r,day);assert.equal(completeSyncObservation(r),false);
});
