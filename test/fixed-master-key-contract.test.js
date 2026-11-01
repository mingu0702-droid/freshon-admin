import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectFixedMasterKeys,createFixedVehicleReader} from '../src/fixedVehicleProjection.js';

test('key profile classifies invalid forms without exposing identifiers or payloads',()=>{
 const rows=[{estCd:'S1'},{estCd:' s1 '},{totalCnt:7},{estCd:null},{estCd:' '},{estCd:123},{estCd:'123'},{estCd:'PRIVATE_INVALID',address:'PRIVATE_ADDRESS',mainCarSeqNm:'221'},null];
 const p=inspectFixedMasterKeys(rows);
 assert.deepEqual(p,{rows:9,valid:2,invalid:7,missing:1,nullValue:1,blank:1,nonString:1,numericOnly:1,otherFormat:1,nonObject:1,metadataOnly:1,customerFieldsPresent:1,duplicateValid:1});
 assert.ok(!/PRIVATE|S1|221/.test(JSON.stringify(p)));
});

test('paging fields on an actual customer never classify it as metadata-only',()=>{
 const p=inspectFixedMasterKeys([{estCd:'S1',totalCnt:1,isPaging:true,mainCarSeqNm:'221'}]);
 assert.equal(p.valid,1);assert.equal(p.metadataOnly,0);
});

test('invalid customer is not silently dropped and failure retains safe page and actual HTTP',async()=>{
 let calls=0;
 const reader=createFixedVehicleReader({ensureSession:async()=>{},extractRows:p=>p.data,readJson:async(_u,o)=>{
  calls++;const q=new URLSearchParams(o.body);return {status:200,data:q.get('logCd')==='011'?[{estCd:'S1',totalCnt:1}]:[{estCd:'PRIVATE_BAD',address:'PRIVATE_ADDRESS'}]};
 }});
 await assert.rejects(reader(),e=>e.code==='FIXED_MASTER_KEY_INVALID'&&e.status===200&&e.step==='KEY_CONTRACT'&&e.kind==='SOURCE_CONTRACT');
 const progress=reader.getProgress();
 assert.equal(calls,2);assert.equal(progress.center,'012');assert.equal(progress.page,0);assert.equal(progress.complete,false);assert.equal(progress.readHttp,200);
 assert.equal(progress.keyProfile.customerFieldsPresent,1);assert.equal(progress.completedCenters.length,1);
 assert.ok(!/PRIVATE/.test(JSON.stringify(progress)));
});

test('metadata-only and null source rows remain fail-closed without retries or auth changes',async()=>{
 for(const row of [{totalCnt:0},null]){
  let calls=0,sessions=0;
  const reader=createFixedVehicleReader({ensureSession:async()=>sessions++,extractRows:p=>p.data,readJson:async()=>{calls++;return {data:[row]};}});
  await assert.rejects(reader(),e=>e.code==='FIXED_MASTER_KEY_INVALID');
  assert.equal(calls,1);assert.equal(sessions,1);assert.equal(reader.getProgress().complete,false);
 }
});
