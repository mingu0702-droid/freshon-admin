import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {EventEmitter} from 'node:events';
import {createStoredStaffDriverHistoryReader} from '../src/storedStaffDriverHistory.js';
import {createReadDeadline,historyDeadline} from '../src/opsmap-abc/readDeadline.js';
import {deliverySourceObservation} from '../src/snapshotRefreshEvidence.js';
import {mountProductionOpsmapCandidate} from '../src/productionOpsmapCandidate.js';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';

const date='2026-11-02',customerCode='S990001';
const snapshot=()=>({rows:[{customerCode,vehicle:'용15',baseVehicle:'205',lastDeliveryDate:date,isActualDateStop:true,driverName:'CURRENT_MASTER_MUST_NOT_BE_USED'}]});
const live=(changes={})=>({date,generatedAt:'2026-11-02T01:00:00Z',sourceObservation:deliverySourceObservation([{enteringDatedAt:date}],{date,pages:1,complete:true,resolveVehicle:()=> '용15'}),
  vehicles:[{date,vehicle:'용15',driverName:'ROUTE_LABEL_MUST_NOT_BE_USED',stops:[{customerCode,vehicle:'용15호',driverName:'SYNTHETIC_DATED_DRIVER',status:'COMPLETED'}]}],...changes});
async function read(value=live(),query={},options={}){
 const calls=[],budget=createReadDeadline({milliseconds:500});
 const reader=createStoredStaffDriverHistoryReader({readSnapshot:async()=>options.snapshot||snapshot(),readObservedDeliveryDate:async d=>{calls.push(d);if(value instanceof Error)throw value;return value;}});
 try{return {result:await reader({customerCode,startDate:date,endDate:date,...query},{budget}),calls};}finally{budget.dispose();}
}

test('dated task identity wins over a different fixed vehicle and current driver',async()=>{
 const {result,calls}=await read();assert.deepEqual(calls,[date]);assert.equal(result.data.length,1);
 assert.equal(result.data[0].vehicle,'용15');assert.equal(result.data[0].driverName,'SYNTHETIC_DATED_DRIVER');assert.equal(result.data[0].driverPhone,null);
 assert.equal(result.meta.coverageComplete,false);assert.equal(result.meta.dateReadCount,1);assert.equal(result.meta.recordState,'DATED_RECORDS_OBSERVED');
 assert(!JSON.stringify(result).includes('CURRENT_MASTER_MUST_NOT_BE_USED'));assert(!JSON.stringify(result).includes('ROUTE_LABEL_MUST_NOT_BE_USED'));
});
test('sixty-day query reads only the last observed actual date, not all dates',async()=>{
 const {result,calls}=await read(live(),{startDate:'2026-09-04'});assert.deepEqual(calls,[date]);assert.equal(result.meta.projectionLimited,true);assert.equal(result.meta.coverageComplete,false);
});
test('an unrelated unconfirmed vehicle never changes this customer or becomes its driver',async()=>{
 const source=live();source.vehicles.push({date,vehicle:'UNCONFIRMED_LABEL',stops:[{customerCode:'S990002',driverName:'UNRELATED'}]});
 const {result}=await read(source);assert.equal(result.data.length,1);assert.equal(result.data[0].vehicle,'용15');assert.equal(result.data[0].driverName,'SYNTHETIC_DATED_DRIVER');
});
test('missing/redacted dated driver stays unknown without current route/master substitution',async()=>{
 const source=live();source.vehicles[0].stops[0].driverName='';source.vehicles[0].stops[0].driverPhone='010-0000-0000';
 const {result}=await read(source);assert.equal(result.data[0].driverName,null);assert.equal(result.data[0].driverPhone,null);assert.equal(result.data[0].driverState,'UNOBSERVED');
});
test('wrong date, incomplete source, conflicting route and conflicting stop are rejected',async t=>{
 for(const kind of ['observation-date','incomplete','route-date','stop-vehicle','null-route','null-stop'])await t.test(kind,async()=>{
  const value=live();if(kind==='observation-date')value.sourceObservation.requestedDate='2026-11-01';if(kind==='incomplete')value.sourceObservation.complete=false;if(kind==='route-date')value.vehicles[0].date='2026-11-01';if(kind==='stop-vehicle')value.vehicles[0].stops[0].vehicle='205';
  if(kind==='null-route')value.vehicles=[null];if(kind==='null-stop')value.vehicles[0].stops=[null];
  await assert.rejects(()=>read(value),e=>e.code==='HISTORY_SOURCE_IDENTITY_MISMATCH'&&e.status===409);
 });
});
test('verified date without this customer is distinct from a failed source read',async()=>{
 const value=live();value.vehicles[0].stops[0].customerCode='S990002';const {result}=await read(value);assert.equal(result.data.length,0);assert.equal(result.meta.recordState,'NO_MATCHING_RECORD');assert.equal(result.meta.coverageComplete,false);
 await assert.rejects(()=>read(new Error('SYNTHETIC_PRIVATE_BODY_MUST_NOT_LEAK')),e=>e.code==='HISTORY_DELIVERY_SOURCE_UNAVAILABLE'&&!e.message.includes('SYNTHETIC_PRIVATE_BODY'));
});
test('unknown range and missing customer never fabricate a current vehicle or scan dates',async()=>{
 const {result,calls}=await read(live(),{startDate:'2026-09-04'},{snapshot:{rows:[{customerCode,baseVehicle:'205',driverName:'CURRENT_ONLY'}]}});
 assert.deepEqual(calls,[]);assert.equal(result.data.length,0);assert.equal(result.meta.recordState,'NO_DATED_ASSIGNMENT_EVIDENCE');
 const missing=await read(live(),{}, {snapshot:{rows:[]}});assert.deepEqual(missing.calls,[]);assert.equal(missing.result.meta.recordState,'CUSTOMER_NOT_IN_SNAPSHOT');
});
test('shared deadline stops a slow source instead of returning an empty success',async()=>{
 const budget=createReadDeadline({milliseconds:20});
 const reader=createStoredStaffDriverHistoryReader({readSnapshot:async()=>snapshot(),readObservedDeliveryDate:()=>new Promise(resolve=>setTimeout(()=>resolve(live()),60))});
 try{await assert.rejects(()=>reader({customerCode,startDate:date,endDate:date},{budget}),e=>e.name==='AbortError');}finally{budget.dispose();}
});
test('fallback-specific shared deadline is capped at twenty seconds; other histories keep five seconds',()=>{
 for(const [configured,limit]of [[undefined,5000],[20000,20000],[60000,20000]]){
  const req=new EventEmitter(),res=new EventEmitter();historyDeadline(req,res,()=>{},configured?{milliseconds:configured}:undefined);
  assert(req.historyBudget.remaining()<=limit);assert(req.historyBudget.remaining()>limit-500);res.emit('finish');
 }
});
test('Production fallback is employee-only, non-cacheable, range-unconfirmed, and does not call Hub or photos',async()=>{
 const origin='https://production.example.test',env={OPSMAP_PRODUCTION_CANDIDATE_ENABLED:'1',OPSMAP_AUTH_ID:'fixture',OPSMAP_AUTH_PASSWORD_HASH:await createStaffPasswordHash('synthetic-test-password'),OPSMAP_AUTH_SESSION_SECRET:'s'.repeat(43),OPSMAP_AUTH_ORIGIN:origin};
 const sessions=new Map(),sessionStore={kind:'ISOLATED_TEST_STORE',get:async k=>sessions.get(k),set:async(k,v)=>sessions.set(k,v),touch:async(k,v)=>{if(!sessions.has(k))return false;sessions.set(k,v);return true;},delete:async k=>sessions.delete(k)};
 const app=express(),calls=[];let source=live();const previous=process.env.RENDER_EXTERNAL_URL;delete process.env.RENDER_EXTERNAL_URL;
 try{mountProductionOpsmapCandidate(app,{env,sessionStore,publicDir:new URL('../public',import.meta.url).pathname.replace(/^\/(C:)/,'$1'),readPhase2bSnapshot:async()=>snapshot(),getSnapshotMemory:snapshot,
  phase2bKstDate:()=> '2026-11-03',normalizeCell:v=>String(v||'').trim(),normalizeDateValue:v=>String(v||''),phase2bSnapshotMeta:()=>({stale:true}),phase2bTodayStatus:async d=>{calls.push(d);if(source instanceof Error)throw source;return source;},callHub:()=>assert.fail('HUB_READ_FORBIDDEN')});
 }finally{if(previous===undefined)delete process.env.RENDER_EXTERNAL_URL;else process.env.RENDER_EXTERNAL_URL=previous;}
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port,path='/opsmap/api/map-phase2b/private/driver-history?customerCode='+customerCode+'&startDate='+date+'&endDate='+date;
 try{
  assert.equal((await fetch(base+path)).status,401);assert.deepEqual(calls,[]);
  const login=await fetch(base+'/opsmap/api/map-phase2b/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({id:'fixture',password:'synthetic-test-password'})});assert.equal(login.status,200);
  const headers={origin,cookie:login.headers.get('set-cookie').split(';')[0]};
  const response=await fetch(base+path,{headers}),body=await response.json();assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/(?:^|,)\s*no-store(?:,|$)/);assert.equal(body.data[0].vehicle,'용15');assert.equal(body.data[0].driverName,'SYNTHETIC_DATED_DRIVER');assert.equal(body.meta.coverageComplete,false);assert.deepEqual(body.meta.availableRecordDates,[date]);assert.deepEqual(body.meta.unconfirmedDates,[date]);assert.deepEqual(calls,[date]);
  source=new Error('SYNTHETIC_PRIVATE_BODY_MUST_NOT_LEAK');const failed=await fetch(base+path,{headers});assert.equal(failed.status,503);const failureText=await failed.text();assert.match(failureText,/HISTORY_DELIVERY_SOURCE_UNAVAILABLE/);assert(!failureText.includes('SYNTHETIC_PRIVATE_BODY'));
  assert.equal((await fetch(base+'/opsmap/api/map-phase2b/private/delivery-photos',{headers})).status,503);assert.equal(calls.length,2);
  assert.equal((await fetch(base+'/opsmap/api/map-phase2b/auth/logout',{method:'POST',headers})).status,200);assert.equal((await fetch(base+path,{headers})).status,401);assert.equal(calls.length,2);
 }finally{await new Promise(r=>server.close(r));}
});
