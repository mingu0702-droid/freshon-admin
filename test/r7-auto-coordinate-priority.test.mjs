import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runIncremental,createCoordinateState,coordinateAddressHash} from '../src/opsmap-abc/opsmapAutoCoordinates.js';
import {createCoordinateIngestion,createMemoryCoordinateStore,createFileCoordinateStore,applyCoordinateCandidates} from '../src/opsmap-abc/opsmapCoordinateIngestion.js';
const address='서울특별시 가상구 가상로 10', date='2026-10-31';
const event=(code='S970001',a=address)=>({customerCode:code,customerAddress:a,deliveryDate:date});
const evidence=(source,lat=37.5,code='S970001')=>({customerCode:code,addressHash:coordinateAddressHash(address),source,lat,lng:127,geocodeStatus:'OK'});
const manual=(code='S970001')=>({customerCode:code,revision:7,originalAddressHash:coordinateAddressHash(address),latitude:37.51,longitude:127.01,coordinateSource:'MANUAL_PIN',resolutionStatus:'MANUAL_CONFIRMED'});

test('authenticated manual projection outranks GPS/cache and is preserved across a fresh ingestion adapter',async()=>{
 const store=createMemoryCoordinateStore();
 let worker=createCoordinateIngestion({store,manualCoordinates:[manual()],verifiedCoordinates:[evidence('RAW_GPS'),evidence('GEOCODE_EXACT',37.6)]});
 let r=await worker.afterDailyCollection({rows:[event()],failed:0});
 assert.equal(r.candidates[0].source,'MANUAL_PIN');assert.equal(r.candidates[0].lat,37.51);assert.equal(r.metrics.requests,0);
 worker=createCoordinateIngestion({store,verifiedCoordinates:[evidence('RAW_GPS')]});r=await worker.ingest([event()]);
 assert.equal(r.candidates[0].lat,37.51);assert.equal(r.candidates[0].source,'MANUAL_PIN');assert.equal(r.metrics.requests,0);
 assert(!JSON.stringify(store.snapshot()).includes(address));
});
test('old manual point is not reused for changed basic address, conflicting manual evidence is review-only',async()=>{
 const state=createCoordinateState();let r=await runIncremental({state,events:[event()],verifiedCoordinates:[manual()]});
 r=await runIncremental({state,events:[{...event('S970001',address+'1'),deliveryDate:'2026-11-01'}],verifiedCoordinates:[manual()]});
 assert.equal(r.candidates.length,0);assert.equal(r.review[0].reason,'GEOCODER_NOT_APPROVED');assert.equal(r.metrics.requests,0);
 r=await runIncremental({events:[event()],verifiedCoordinates:[manual(),{...manual(),latitude:37.7}]});
 assert.equal(r.review[0].reason,'VERIFIED_COORDINATE_CONFLICT');
});
test('unconfirmed manual evidence cannot override existing verified GPS; GPS outranks building cache',async()=>{
 let r=await runIncremental({events:[event()],verifiedCoordinates:[{...manual(),resolutionStatus:'ADDRESS_CHANGED_REVIEW_REQUIRED'},evidence('RAW_GPS'),evidence('GEOCODE_EXACT',37.6)]});
 assert.equal(r.candidates[0].source,'RAW_GPS');assert.equal(r.candidates[0].coordinateAccuracy,'GPS');
 r=await runIncremental({state:r.state,events:[event()],verifiedCoordinates:[evidence('GEOCODE_EXACT',37.6)]});
 assert.equal(r.candidates[0].lat,37.5);assert.equal(r.candidates[0].source,'RAW_GPS');
});
test('basic building query separates units, deduplicates different customers and preserves original hash',async()=>{
 let calls=0,query;const basic=address+' 2층 201호';
 const r=await runIncremental({events:[event('S970001',basic),event('S970002',basic)],geocoder:{kind:'mock',lookup:async({address:a})=>{calls++;query=a;return {lat:37.5,lng:127,exact:true,matchedAddress:a};}},policy:{maxRequestsPerRun:1,minIntervalMs:0}});
 assert.equal(calls,1);assert.equal(query,address);assert.equal(r.candidates.length,2);assert.equal(r.candidates[0].addressHash,coordinateAddressHash(basic));assert.equal(r.candidates[0].coordinateAccuracy,'BUILDING');assert.equal(r.metrics.geocoded,1);assert.equal(r.metrics.deduplicated,1);
});
test('saved exact address requests survive adapter restart and do not consume a second provider call',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'opsmap-r7-coordinate-')),file=path.join(dir,'state.json');let calls=0;
 try{
  const geocoder={kind:'mock',lookup:async({address:a})=>{calls++;return {lat:37.5,lng:127,exact:true,matchedAddress:a};}};
  let worker=createCoordinateIngestion({store:createFileCoordinateStore({filePath:file}),geocoder,policy:{minIntervalMs:0}});
  await worker.ingest([event()]);
  worker=createCoordinateIngestion({store:createFileCoordinateStore({filePath:file}),geocoder,policy:{minIntervalMs:0}});
  const r=await worker.ingest([event('S970002')]);assert.equal(calls,1);assert.equal(r.metrics.requests,0);assert.equal(r.candidates.length,1);
 }finally{assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});}
});
test('failed request resumes after backoff; quota cannot reset by creating a new adapter',async()=>{
 let clock=Date.parse('2026-10-31T00:00:00Z'),calls=0;const store=createMemoryCoordinateStore();
 const make=()=>createCoordinateIngestion({store,now:()=>clock,policy:{minIntervalMs:0,retryBaseMs:10,maxDailyRequests:1},geocoder:{kind:'mock',lookup:async()=>{calls++;throw Error('synthetic failure');}}});
 await make().ingest([event()]);clock+=20;const r=await make().ingest([event()]);assert.equal(calls,1);assert.equal(r.review[0].reason,'BUDGET_LIMIT');assert.equal(r.metrics.requests,0);
});
test('unapproved external geocoding never calls provider and manual map point remains unchanged',async()=>{
 let calls=0;const r=await runIncremental({events:[event()],geocoder:{kind:'external',lookup:async()=>{calls++;}},policy:{externalEnabled:true,externalApproved:false}});assert.equal(calls,0);assert.equal(r.review[0].reason,'GEOCODER_NOT_APPROVED');
 const row={customerCode:'S970001',address,lat:37.51,lng:127.01,coordinateSource:'MANUAL_PIN',resolutionStatus:'MANUAL_CONFIRMED',originalAddressHash:coordinateAddressHash(address)};
 assert.deepEqual(applyCoordinateCandidates([row],r)[0],row);
 const changed=applyCoordinateCandidates([{...row,address:address+'1'}],r)[0];assert.equal(changed.lat,null);assert.equal(row.lat,37.51);
});

test('external cumulative allowance is explicit and never resets at KST day rollover',async()=>{
 let clock=Date.parse('2026-10-31T14:59:00Z'),calls=0;const state=createCoordinateState(),geocoder={kind:'external',lookup:async({address:a})=>{calls++;return {lat:37.5,lng:127,exact:true,matchedAddress:a};}};
 let r=await runIncremental({state,events:[event()],geocoder,policy:{externalEnabled:true,externalApproved:true,minIntervalMs:0},now:()=>clock});
 assert.equal(calls,0);assert.equal(r.review[0].reason,'GEOCODER_BUDGET_UNVERIFIED');
 r=await runIncremental({state,events:[event()],geocoder,policy:{externalEnabled:true,externalApproved:true,maxTotalRequests:1,minIntervalMs:0},now:()=>clock});assert.equal(calls,1);
 clock+=120000;const restarted=JSON.parse(JSON.stringify(state));r=await runIncremental({state:restarted,events:[{...event('S970002',address+'1'),deliveryDate:'2026-11-01'}],geocoder,policy:{externalEnabled:true,externalApproved:true,maxTotalRequests:1,minIntervalMs:0},now:()=>clock});assert.equal(calls,1);assert.equal(r.review[0].reason,'BUDGET_LIMIT');
});
