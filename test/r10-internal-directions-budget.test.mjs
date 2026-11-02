import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createProductionRoadBudget,productionRoadRouteFlag} from '../src/opsmap-abc/productionRoadBudget.js';
import {createRoadRouteService} from '../src/opsmap-abc/roadRouteService.js';
const time=Date.parse('2026-11-03T03:00:00Z'),key='synthetic-fixture-key',token='synthetic-fixture-token';
const env={OPSMAP_ROAD_BUDGET_STORE_ENABLED:'1',OPSMAP_AUTH_STORE_REPO:'mingu0702-droid/freshon-cache',OPSMAP_AUTH_STORE_BRANCH:'production/opsmap-auth',KAKAO_MOBILITY_REST_API_KEY:key};
const request={mode:'MANUAL_WAYPOINTS',requestId:1,origin:{id:'p0',lat:37,lng:127},waypoints:[],destination:{id:'p1',lat:37.01,lng:127.01}};
const ledger=()=>({schema:1,roadBudget:{accountHash:createHash('sha256').update(key).digest('hex'),scope:'CUMULATIVE_APPROVED_ACCOUNT',policy:'FREE_ONLY',providerPaidDisabled:true,servicePermissionVerified:true,approvalId:'synthetic-approval-1',verifiedAt:'2026-11-03T02:59:00Z',expiresAt:'2026-11-03T03:10:00Z',limit:1,used:0,monthlyFreeRemainingAtApproval:100,apis:{directions:{freeRemainingAtApproval:100,used:0},waypoints:{freeRemainingAtApproval:100,used:0}}}});
function remote(initial=ledger(),options={}){
 let state=structuredClone(initial),revision=1,writes=0;const calls=[];
 const fetchImpl=async(url,init={})=>{
  calls.push({url,method:init.method||'GET'});assert.equal(init.redirect,'error');
  const body=(status,data)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
  if(url==='https://api.github.com/repos/mingu0702-droid/freshon-cache')return body(200,{private:options.private!==false,permissions:{push:options.push!==false}});
  assert.equal(url.split('?')[0],'https://api.github.com/repos/mingu0702-droid/freshon-cache/contents/opsmap-production/road-budget-v1.json');
  if(init.method==='PUT'){
   writes++;const update=JSON.parse(init.body);assert.equal(update.branch,'production/opsmap-auth');
   if(options.conflict||update.sha!==String(revision).padStart(40,'0'))return body(409,{});
   state=JSON.parse(Buffer.from(update.content,'base64'));revision++;
   if(options.unknown)throw Error('synthetic lost acknowledgement');return body(200,{});
  }
  assert(url.endsWith('?ref=production%2Fopsmap-auth'));
  if(options.missing)return body(404,{});
  return body(200,{sha:String(revision).padStart(40,'0'),encoding:'base64',content:Buffer.from(JSON.stringify(options.readback&&writes?ledger():state)).toString('base64')});
 };
 return {fetchImpl,calls,get writes(){return writes;},get state(){return state;}};
}
const budget=(r,extra={})=>createProductionRoadBudget({env,token,fetchImpl:r.fetchImpl,now:()=>time,...extra});
function service(b,fetchImpl,more={}){return createRoadRouteService({env:{...env,OPSMAP_ROAD_ROUTE_ENABLED:'1'},budget:b,requireDurableBudget:true,fetchImpl,now:()=>time,...more});}
const payload=()=>new Response(JSON.stringify({routes:[{result_code:0,summary:{distance:100,duration:60},sections:[{distance:100,duration:60,roads:[{vertexes:[127,37,127.01,37.01]}]}]}]}),{headers:{'content-type':'application/json'}});

test('Production flag defaults OFF and rejects the generic/Stage flag',()=>{
 assert.equal(productionRoadRouteFlag({}),'0');assert.equal(productionRoadRouteFlag({OPSMAP_ROAD_ROUTE_ENABLED:'1'}),'0');assert.equal(productionRoadRouteFlag({OPSMAP_PRODUCTION_ROAD_ROUTE_ENABLED:'true'}),'0');assert.equal(productionRoadRouteFlag({OPSMAP_PRODUCTION_ROAD_ROUTE_ENABLED:'1'}),'1');
 let calls=0;assert.equal(createProductionRoadBudget({env:{},fetchImpl:async()=>{calls++;}}),null);assert.equal(calls,0);
});
test('readiness separates local count, actual ledger verification and feature flag without provider requests',async()=>{
 const r=remote(),b=budget(r);let providerCalls=0;
 const s=service(b,async()=>{providerCalls++;return payload();},{env:{...env,OPSMAP_ROAD_ROUTE_ENABLED:'0'}});
 const status=await s.readiness();assert.equal(status.enabled,false);assert.equal(status.keyConfigured,true);assert.equal(status.keySource,'KAKAO_MOBILITY_REST_API_KEY');assert.equal(status.remaining,30000);assert.equal(status.approvedRemaining,1);assert.equal(status.budgetVerified,true);assert.equal(status.canRequest,false);assert.deepEqual(status.blockedReasons,['FEATURE_DISABLED']);assert.match(status.usageScope,/NOT_PROVIDER_QUOTA/);
 assert.equal(r.writes,0);assert.equal(providerCalls,0);assert(!JSON.stringify(status).includes(key));assert(!JSON.stringify(status).includes(token));assert(!JSON.stringify(status).includes(ledger().roadBudget.accountHash));
});
test('missing ledger, private/write denial and unapproved branch never create or reserve anything',async()=>{
 for(const options of [{missing:true},{private:false},{push:false}]){
  const r=remote(ledger(),options),s=service(budget(r),()=>assert.fail('PROVIDER_FORBIDDEN'));const ready=await s.readiness();assert.equal(ready.canRequest,false);assert(ready.blockedReasons.includes('ROAD_BUDGET_UNVERIFIED'));assert.match(ready.budgetError,/^ROAD_BUDGET_/);await assert.rejects(s.route(request),e=>e.code==='CALL_POLICY_BLOCKED');assert.equal(r.writes,0);
 }
 const r=remote(),b=budget(r,{env:{...env,OPSMAP_AUTH_STORE_BRANCH:'stage/opsmap-manual-pins'}});assert.equal(b.durable,false);await assert.rejects(b.status(),e=>e.code==='ROAD_BUDGET_STORE_CONFIG');assert.equal(r.calls.length,0);
});
test('free-only approval, matching account, real quota snapshot and expiry are mandatory before provider dispatch',async()=>{
 const changes=[b=>b.providerPaidDisabled=false,b=>b.servicePermissionVerified=false,b=>b.policy='PAID',b=>b.accountHash='a'.repeat(64),b=>b.expiresAt='2026-11-03T02:00:00Z',b=>b.verifiedAt='2026-11-04T00:00:00Z',b=>b.expiresAt='2026-11-04T00:00:00Z',b=>b.monthlyFreeRemainingAtApproval=0,b=>b.apis.directions.freeRemainingAtApproval=10001,b=>b.apis.directions.used=1];
 for(const change of changes){const state=ledger();change(state.roadBudget);const r=remote(state),s=service(budget(r),()=>assert.fail('PROVIDER_FORBIDDEN'));assert.equal((await s.readiness()).canRequest,false);await assert.rejects(s.route(request),e=>e.code==='CALL_POLICY_BLOCKED');assert.equal(r.writes,0);}
});
test('one approved call is durable across restart and a concurrent duplicate plus cache hit consumes one slot',async()=>{
 const r=remote(),b=budget(r);let providerCalls=0;
 const s=service(b,async(url,options)=>{providerCalls++;assert(url.startsWith('https://apis-navi.kakaomobility.com/v1/directions?'));assert.equal(options.method,'GET');assert.equal(r.state.roadBudget.used,1);return payload();});
 const [first,second]=await Promise.all([s.route(request),s.route({...request,requestId:2})]);assert.equal(providerCalls,1);assert.equal(r.writes,1);assert.equal(first.data.requestId,1);assert.equal(second.data.requestId,2);assert.equal(first.data.distanceMeters,100);
 const cached=await s.route({...request,requestId:3});assert.equal(cached.meta.cache,'HIT');assert.equal(providerCalls,1);assert.equal(r.writes,1);
 const restarted=service(budget(r),()=>assert.fail('PROVIDER_FORBIDDEN'));assert.equal((await restarted.readiness()).approvedRemaining,0);await assert.rejects(restarted.route({...request,requestId:4}),e=>e.code==='QUOTA_EXCEEDED');assert.equal(r.writes,1);
});
test('quota and CAS conflicts across instances allow at most one provider request',async()=>{
 const r=remote();let calls=0;const fetchImpl=async()=>{calls++;return payload();};
 const result=await Promise.allSettled([service(budget(r),fetchImpl).route(request),service(budget(r),fetchImpl).route(request)]);
 assert.equal(result.filter(v=>v.status==='fulfilled').length,1);assert.equal(calls,1);assert.equal(r.state.roadBudget.used,1);
});
test('unknown write outcome, CAS conflict and readback mismatch never dispatch or retry/refund',async()=>{
 for(const options of [{unknown:true},{conflict:true},{readback:true}]){const r=remote(ledger(),options),s=service(budget(r),()=>assert.fail('PROVIDER_FORBIDDEN'));await assert.rejects(s.route(request),e=>e.code==='CALL_POLICY_BLOCKED');assert.equal(r.writes,1);if(!options.conflict)assert.equal(r.state.roadBudget.used,1);}
});
test('endpoint-specific free quotas are reserved separately and provider failures retain consumed allowance',async()=>{
 const state=ledger();state.roadBudget.apis.directions.freeRemainingAtApproval=0;const r=remote(state),s=service(budget(r),()=>assert.fail('PROVIDER_FORBIDDEN'));await assert.rejects(s.route(request),e=>e.code==='QUOTA_EXCEEDED');assert.equal(r.writes,0);
 const r2=remote();let calls=0;const s2=service(budget(r2),async()=>{calls++;return new Response('{}',{status:503});});await assert.rejects(s2.route(request),e=>e.code==='PROVIDER_UNAVAILABLE');assert.equal(r2.state.roadBudget.used,1);await assert.rejects(s2.route(request),e=>e.code==='QUOTA_EXCEEDED');assert.equal(calls,1);
});
test('6 to 30 via points select the multi-waypoint allowance and keep the existing 30-point contract',async()=>{
 const points=Array.from({length:32},(_,i)=>({id:'p'+i,lat:37+i*.001,lng:127+i*.001}));
 const body={...request,origin:points[0],destination:points.at(-1),waypoints:points.slice(1,-1).map((p,i)=>({...p,order:i+1}))};
 const r=remote();let calls=0;const s=service(budget(r),async(url,options)=>{calls++;assert.equal(url,'https://apis-navi.kakaomobility.com/v1/waypoints/directions');assert.equal(options.method,'POST');assert.equal(JSON.parse(options.body).waypoints.length,30);return new Response('{}',{status:503});});
 await assert.rejects(s.route(body),e=>e.code==='PROVIDER_UNAVAILABLE');assert.equal(calls,1);assert.equal(r.state.roadBudget.apis.waypoints.used,1);assert.equal(r.state.roadBudget.apis.directions.used,0);
});
