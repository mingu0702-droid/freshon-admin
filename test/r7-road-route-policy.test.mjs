import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoadRouteService,roadRouteEnabledSetting} from '../src/opsmap-abc/roadRouteService.js';

const draft={mode:'MANUAL_WAYPOINTS',requestId:1,origin:{id:'origin',lat:37.5,lng:127},waypoints:[],destination:{id:'destination',lat:37.51,lng:127.01}};
const env={OPSMAP_ROAD_ROUTE_ENABLED:'1',KAKAO_MOBILITY_REST_API_KEY:'synthetic-key',OPSMAP_ROAD_ROUTE_REQUEST_LIMIT:'2'};
const provider=()=>new Response(JSON.stringify({routes:[{result_code:0,summary:{distance:100,duration:20},sections:[{distance:100,duration:20,roads:[{vertexes:[127,37.5,127.01,37.51]}]}]}]}),{headers:{'content-type':'application/json'}});

test('explicit activation defaults OFF; no key or budget inspection can activate it',async()=>{
 assert.equal(roadRouteEnabledSetting({}),'0');assert.equal(roadRouteEnabledSetting({OPSMAP_ROAD_ROUTE_ENABLED:'0'}),'0');assert.equal(roadRouteEnabledSetting(env),'1');
 let calls=0;
 const service=createRoadRouteService({env:{...env,OPSMAP_ROAD_ROUTE_ENABLED:'0'},fetchImpl:()=>assert.fail('external call forbidden'),budget:{durable:true,reserve:()=>calls++},requireDurableBudget:true});
 await assert.rejects(service.route(draft),{code:'FEATURE_DISABLED'});assert.equal(calls,0);
});

test('durable label does not authorize calls when reservation contract is invalid',async()=>{
 for(const reservation of [undefined,{reserved:false},{reserved:true,scope:'PROCESS_ONLY',remaining:1},{reserved:true,scope:'CUMULATIVE_APPROVED_ACCOUNT',remaining:-1}]){
  const service=createRoadRouteService({env,fetchImpl:()=>assert.fail('unapproved external call'),budget:{durable:true,reserve:async()=>reservation},requireDurableBudget:true});
  await assert.rejects(service.route(draft),{code:'CALL_POLICY_BLOCKED'});assert.equal(service.configuration().used,0);
 }
});

test('approved durable reservation bounds usage and coalesces concurrent/cached requests',async()=>{
 let reservations=0,calls=0;
 const budget={durable:true,status:async()=>({durable:true,scope:'CUMULATIVE_APPROVED_ACCOUNT',remaining:2-reservations}),reserve:async()=>({reserved:true,scope:'CUMULATIVE_APPROVED_ACCOUNT',remaining:2-++reservations})};
 const service=createRoadRouteService({env,budget,requireDurableBudget:true,fetchImpl:async()=>{calls++;return provider();}});
 assert.equal((await service.readiness()).canRequest,true);
 const results=await Promise.all([service.route(draft),service.route({...draft,requestId:2})]);
 assert.equal(calls,1);assert.equal(reservations,1);assert.equal(results[1].data.requestId,2);assert.equal(results[0].data.distanceMeters,100);
 assert.equal((await service.route({...draft,requestId:3})).meta.cache,'HIT');assert.equal(calls,1);
});

test('missing/unverified/exhausted durable budget fails closed without provider calls',async()=>{
 const missing=createRoadRouteService({env,requireDurableBudget:true,fetchImpl:()=>assert.fail('external call forbidden')});
 await assert.rejects(missing.route(draft),{code:'PERSISTENT_BUDGET_REQUIRED'});
 const denied=createRoadRouteService({env,requireDurableBudget:true,budget:{durable:true,reserve:async()=>{throw Object.assign(Error(),{code:'QUOTA_EXCEEDED'});}},fetchImpl:()=>assert.fail('external call forbidden')});
 await assert.rejects(denied.route(draft),{code:'QUOTA_EXCEEDED'});
});
