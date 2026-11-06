import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createProductionRoadBudget} from '../src/opsmap-abc/productionRoadBudget.js';
import {createRoadRouteService} from '../src/opsmap-abc/roadRouteService.js';
import fs from 'node:fs';
import vm from 'node:vm';
const key='synthetic-monthly-test',env={OPSMAP_ROAD_BUDGET_STORE_ENABLED:'1',OPSMAP_AUTH_STORE_REPO:'mingu0702-droid/freshon-cache',OPSMAP_AUTH_STORE_BRANCH:'production/opsmap-auth',KAKAO_REST_API_KEY:key};
const start=Date.parse('2026-11-03T03:00:00Z'),next=start+86400000;
function ledger(){return {schema:1,roadBudget:{accountHash:createHash('sha256').update(key).digest('hex'),scope:'CUMULATIVE_APPROVED_ACCOUNT',policy:'FREE_ONLY',providerPaidDisabled:true,servicePermissionVerified:true,approvalId:'synthetic-monthly-approval',verifiedAt:new Date(start).toISOString(),expiresAt:'2026-11-30T15:00:00Z',limit:30000,used:9,monthlyFreeRemainingAtApproval:30000,apis:{directions:{freeRemainingAtApproval:10000,used:7},waypoints:{freeRemainingAtApproval:5000,used:2}},monthlyApproval:{period:'2026-11',exclusiveDirectionsUsage:true,usedBeforeWindow:{directions:5,waypoints:1},dailyUsage:{'2026-11-03':{directions:2,waypoints:1}}}}};}
function remote(initial=ledger()){
 let state=structuredClone(initial),revision=1,writes=0;
 const response=(status,value)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 const fetchImpl=async(url,options={})=>{
  assert(url.startsWith('https://api.github.com/repos/mingu0702-droid/freshon-cache'));
  if(!url.includes('/contents/'))return response(200,{private:true,permissions:{push:true}});
  if(options.method==='PUT'){
   const body=JSON.parse(options.body);if(body.sha!==String(revision).padStart(40,'0'))return response(409,{});
   state=JSON.parse(Buffer.from(body.content,'base64'));revision++;writes++;return response(200,{});
  }
  return response(200,{sha:String(revision).padStart(40,'0'),encoding:'base64',content:Buffer.from(JSON.stringify(state)).toString('base64')});
 };
 return {fetchImpl,get state(){return state;},get writes(){return writes;}};
}
const budget=(r,time)=>createProductionRoadBudget({env,token:'synthetic-token',fetchImpl:r.fetchImpl,now:()=>time});
const reserve=b=>b.reserve({cost:1,provider:'kakao-directions',api:'directions'});
test('monthly opt-in continues next KST day and restart without changing old usage or approval',async()=>{
 const r=remote(),before=structuredClone(r.state.roadBudget),first=budget(r,start);
 assert.equal((await first.status()).remaining,14997);await reserve(first);
 const restarted=budget(r,next),status=await restarted.status();assert.equal(status.approvalWindow,'KST_MONTH');assert.equal(status.remaining,15000);assert.equal(status.apiRemaining.directions,10000);
 await reserve(restarted);const b=r.state.roadBudget;
 assert.equal(b.used,11);assert.equal(b.apis.directions.used,9);assert.equal(b.apis.waypoints.used,2);assert.equal(b.approvalId,before.approvalId);assert.equal(b.limit,30000);assert.equal(b.expiresAt,before.expiresAt);
 assert.deepEqual(b.monthlyApproval.usedBeforeWindow,before.monthlyApproval.usedBeforeWindow);assert.deepEqual(b.monthlyApproval.dailyUsage,{'2026-11-03':{directions:3,waypoints:1},'2026-11-04':{directions:1,waypoints:0}});
});
test('verified first-day remaining and official later daily limit are independent of cumulative count',async()=>{
 const state=ledger();state.roadBudget.apis.directions.freeRemainingAtApproval=2;const r=remote(state);
 assert.equal((await budget(r,start).status()).apiRemaining.directions,0);await assert.rejects(reserve(budget(r,start)),e=>e.code==='QUOTA_EXCEEDED');
 assert.equal((await budget(r,next).status()).apiRemaining.directions,10000);await reserve(budget(r,next));assert.equal(r.state.roadBudget.used,10);
 const exhausted=ledger();exhausted.roadBudget.used=10007;exhausted.roadBudget.apis.directions.used=10005;exhausted.roadBudget.monthlyApproval.dailyUsage['2026-11-03'].directions=0;exhausted.roadBudget.monthlyApproval.dailyUsage['2026-11-04']={directions:10000,waypoints:0};
 await assert.rejects(reserve(budget(remote(exhausted),next)),e=>e.code==='QUOTA_EXCEEDED');
});
test('basic-only approval keeps waypoints closed after KST rollover and preserves earlier usage',async()=>{
 const state=ledger();state.roadBudget.approvedApis=['directions'];const r=remote(state);
 const denyWaypoints=b=>assert.rejects(b.reserve({cost:1,provider:'kakao-directions',api:'waypoints'}),e=>e.code==='ROAD_BUDGET_API_UNVERIFIED');
 for(const time of [start,next]){
  const b=budget(r,time),status=await b.status();assert.equal(status.apiRemaining.waypoints,0);await denyWaypoints(b);
 }
 assert.equal(r.writes,0);
 await reserve(budget(r,next));
 assert.deepEqual(r.state.roadBudget.approvedApis,['directions']);
 assert.equal(r.state.roadBudget.apis.waypoints.used,2);
 assert.equal(r.state.roadBudget.used,10);
 await denyWaypoints(budget(r,next));assert.equal(r.writes,1);
});
test('no monthly inference, no month reset and no unverified usage/accounting upgrade',async()=>{
 for(const mutate of [b=>delete b.monthlyApproval,b=>b.monthlyApproval.exclusiveDirectionsUsage=false,b=>b.monthlyApproval.period='2026-10',b=>b.monthlyApproval.usedBeforeWindow.directions=0,b=>b.monthlyApproval.dailyUsage['2026-11-04']={directions:10001,waypoints:0},b=>b.providerPaidDisabled=false,b=>b.servicePermissionVerified=false,b=>b.expiresAt='2026-12-02T00:00:00Z']){
  const state=ledger();mutate(state.roadBudget);const r=remote(state);await assert.rejects(reserve(budget(r,next)));assert.equal(r.writes,0);
 }
 const r=remote();await assert.rejects(reserve(budget(r,Date.parse('2026-11-30T15:00:00Z'))),e=>e.code==='ROAD_BUDGET_APPROVAL_EXPIRED');assert.equal(r.writes,0);
});
test('two processes race through CAS without overwriting reservations',async()=>{
 const r=remote();const result=await Promise.allSettled([reserve(budget(r,next)),reserve(budget(r,next))]);
 assert.equal(result.filter(row=>row.status==='fulfilled').length,1);assert.equal(r.writes,1);assert.equal(r.state.roadBudget.used,10);
});
test('a CAS readback crossing KST midnight retains the debit on its original day and blocks dispatch',async()=>{
 const midnight=Date.parse('2026-11-03T15:00:00Z'),r=remote();let time=midnight-1;
 const b=createProductionRoadBudget({env,token:'synthetic-token',now:()=>time,fetchImpl:async(url,options)=>{
  const result=await r.fetchImpl(url,options);
  if(options.method==='PUT')time=midnight;
  return result;
 }});
 await assert.rejects(reserve(b),e=>e.code==='ROAD_BUDGET_RESERVATION_DAY_CHANGED');
 assert.equal(r.writes,1);assert.equal(r.state.roadBudget.used,10);
 assert.equal(r.state.roadBudget.updatedAt,'2026-11-03T14:59:59.999Z');
 assert.deepEqual(r.state.roadBudget.monthlyApproval.dailyUsage,{'2026-11-03':{directions:3,waypoints:1}});
 const status=await b.status();assert.equal(status.usageDate,'2026-11-04');assert.equal(status.apiRemaining.directions,10000);
});
test('obsolete 100-call environment setting cannot impose a process quota',()=>{
 for(const oldLimit of ['0','1','100','300']){
  const service=createRoadRouteService({env:{...env,OPSMAP_ROAD_ROUTE_REQUEST_LIMIT:oldLimit}});assert.equal(service.configuration().requestLimit,30000);
 }
});
test('saved visit import sorts verified order and rejects mixed or unknown visits',()=>{
 const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../public/opsmap/navigation-ui.js',import.meta.url),'utf8'),ctx);
 const rows=[{customerCode:'SYN_1',lat:37,lng:127,vehicle:'101',order:2},{customerCode:'SYN_2',lat:37.01,lng:127.01,vehicle:'101',order:1}];
 assert.deepEqual(Array.from(ctx.MapNavigationLookup.recordedVisitCodes(rows,rows,'101')),['SYN_2','SYN_1']);
 const center={customerCode:'CENTER_osan',lat:37,lng:127};assert.deepEqual(Array.from(ctx.MapNavigationLookup.recordedVisitCodes(rows,[...rows,center],'101',center)),['CENTER_osan','SYN_2','SYN_1']);
 assert.deepEqual(Array.from(ctx.MapNavigationLookup.recordedVisitCodes([rows[0]],[...rows,center],'101',center)),['CENTER_osan','SYN_1']);
 for(const changed of [rows.map(row=>({...row,order:1})),rows.map(row=>({...row,order:null})),rows.map(row=>({...row,vehicle:'102'}))])assert.throws(()=>ctx.MapNavigationLookup.recordedVisitCodes(changed,rows,'101'));
 assert.deepEqual(rows.map(row=>row.order),[2,1]);
});
