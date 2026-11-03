import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoadRouteService} from '../src/opsmap-abc/roadRouteService.js';
const env={OPSMAP_ROAD_ROUTE_ENABLED:'1',KAKAO_REST_API_KEY:'synthetic-only'};
const request={mode:'MANUAL_WAYPOINTS',requestId:1,origin:{id:'o',lat:37,lng:127},waypoints:[],destination:{id:'d',lat:37.01,lng:127.01}};
test('long-lived durable service follows renewed ledger allowance beyond 30000 local dispatches',async()=>{
 let remaining=30000,reservations=0,providerCalls=0;
 const budget={durable:true,status:async()=>({durable:true,scope:'CUMULATIVE_APPROVED_ACCOUNT',remaining}),reserve:async()=>{if(!remaining)throw Object.assign(Error('QUOTA_EXCEEDED'),{code:'QUOTA_EXCEEDED'});remaining--;reservations++;}};
 const service=createRoadRouteService({env,budget,requireDurableBudget:true,fetchImpl:async()=>{providerCalls++;return {ok:false,status:503,body:null};}});
 for(let index=0;index<30000;index++)await assert.rejects(service.route(request),e=>e.code==='PROVIDER_UNAVAILABLE');
 assert.equal(service.configuration().used,30000);assert.equal(providerCalls,30000);assert.equal(reservations,30000);
 const exhausted=await service.readiness();assert.equal(exhausted.canRequest,false);assert.deepEqual(exhausted.blockedReasons,['QUOTA_EXCEEDED']);
 await assert.rejects(service.route(request),e=>e.code==='QUOTA_EXCEEDED');assert.equal(providerCalls,30000);
 // The verified ledger supplies a new period; the same service keeps running.
 remaining=30000;
 const renewed=await service.readiness();assert.equal(renewed.canRequest,true);assert.equal(renewed.approvedRemaining,30000);assert.equal(renewed.used,30000);assert.equal(renewed.requestLimit,null);assert.equal(renewed.remaining,null);assert.equal(renewed.processLimitEnforced,false);assert.equal(renewed.usageScope,'PROCESS_OBSERVABILITY_COUNTER_NOT_PROVIDER_QUOTA');assert.equal(renewed.budgetScope,'DURABLE_APPROVED_ACCOUNT_LEDGER');
 await assert.rejects(service.route(request),e=>e.code==='PROVIDER_UNAVAILABLE');assert.equal(providerCalls,30001);assert.equal(reservations,30001);assert.equal(remaining,29999);assert.equal(service.configuration().used,30001);
});
test('non-durable fallback still enforces the process safety ceiling',async()=>{
 let calls=0;const service=createRoadRouteService({env,fetchImpl:async()=>{calls++;return {ok:false,status:503,body:null};}});
 for(let index=0;index<30000;index++)await assert.rejects(service.route(request),e=>e.code==='PROVIDER_UNAVAILABLE');
 await assert.rejects(service.route(request),e=>e.code==='QUOTA_EXCEEDED');assert.equal(calls,30000);
 const config=service.configuration();assert.equal(config.requestLimit,30000);assert.equal(config.remaining,0);assert.equal(config.processLimitEnforced,true);assert.equal(config.usageScope,'PROCESS_SAFETY_COUNTER_NOT_PROVIDER_QUOTA');
});
