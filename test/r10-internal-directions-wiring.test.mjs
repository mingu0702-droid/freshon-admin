import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import express from 'express';
import {fileURLToPath} from 'node:url';
import {mountProductionOpsmapCandidate} from '../src/productionOpsmapCandidate.js';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';
const origin='https://production.synthetic.test',key='synthetic-rest-key';
const realFetch=globalThis.fetch;
async function fixture(extra={}){
 const app=express(),sessions=new Map(),calls=[];let state=null,revision=1;
 if(extra.jsonReplacer)app.set('json replacer',extra.jsonReplacer);
 const now=Date.now(),expiry=Math.min(now+600000,Math.floor((now+9*3600000)/86400000)*86400000+86400000-9*3600000);
 const approved={schema:1,roadBudget:{accountHash:createHash('sha256').update(key).digest('hex'),scope:'CUMULATIVE_APPROVED_ACCOUNT',policy:'FREE_ONLY',providerPaidDisabled:true,servicePermissionVerified:true,approvalId:'synthetic-approval',verifiedAt:new Date(now).toISOString(),expiresAt:new Date(expiry).toISOString(),limit:1,used:0,monthlyFreeRemainingAtApproval:10,apis:{directions:{freeRemainingAtApproval:10,used:0},waypoints:{freeRemainingAtApproval:0,used:0}}}};
 if(extra.ledger)state=approved;
 const env={OPSMAP_PRODUCTION_CANDIDATE_ENABLED:'1',OPSMAP_AUTH_ID:'fixture',OPSMAP_AUTH_PASSWORD_HASH:await createStaffPasswordHash('synthetic-password'),OPSMAP_AUTH_SESSION_SECRET:'a'.repeat(43),OPSMAP_AUTH_STORE_REPO:'mingu0702-droid/freshon-cache',OPSMAP_AUTH_STORE_BRANCH:'production/opsmap-auth',OPSMAP_AUTH_STORE_TOKEN:'synthetic-cache-token',OPSMAP_AUTH_ORIGIN:origin,RENDER_EXTERNAL_URL:origin,KAKAO_MOBILITY_REST_API_KEY:key,...extra.env};
 const snapshot={rows:[],latestDate:'2026-11-03'};
 globalThis.fetch=async(url,options={})=>{
  calls.push({url,method:options.method||'GET'});const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  if(url==='https://api.github.com/repos/mingu0702-droid/freshon-cache')return response({private:true,permissions:{push:true}});
  if(url.startsWith('https://api.github.com/repos/mingu0702-droid/freshon-cache/contents/opsmap-production/road-budget-v1.json')){
   if(options.method==='PUT'){const update=JSON.parse(options.body);assert.equal(update.branch,'production/opsmap-auth');assert.equal(update.sha,String(revision).padStart(40,'0'));state=JSON.parse(Buffer.from(update.content,'base64'));revision++;return response({});}
   return state?response({sha:String(revision).padStart(40,'0'),encoding:'base64',content:Buffer.from(JSON.stringify(state)).toString('base64')}):response({},404);
  }
  if(url.startsWith('https://apis-navi.kakaomobility.com/v1/directions?')){
   const expectedWaypoints=extra.points?.waypoints.map(point=>point.lng+','+point.lat).join('|')||null;
   assert.equal(new URL(url).searchParams.get('waypoints'),expectedWaypoints);
   return extra.providerResponse?.()??response({routes:[{result_code:0,summary:{distance:100,duration:60},sections:[{distance:100,duration:60,roads:[{vertexes:[127,37,127.01,37.01]}]}]}]},extra.providerHttp??200);
  }
  assert.fail('Unexpected synthetic outbound surface');
 };
 try{mountProductionOpsmapCandidate(app,{env,publicDir:fileURLToPath(new URL('../public/',import.meta.url)),sessionStore:{get:async k=>sessions.get(k),set:async(k,v)=>sessions.set(k,v),touch:async(k,v)=>{if(!sessions.has(k))return false;sessions.set(k,v);return true;},delete:async k=>sessions.delete(k)},readPhase2bSnapshot:async()=>snapshot,getSnapshotMemory:()=>snapshot,phase2bKstDate:()=> '2026-11-03',normalizeCell:v=>String(v||''),normalizeDateValue:v=>v,phase2bSnapshotMeta:()=>({}),phase2bTodayStatus:async()=>({vehicles:[]}),callHub:async action=>assert.fail('Hub call forbidden: '+action)});}finally{globalThis.fetch=realFetch;}
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/opsmap';
 const login=await realFetch(base+'/api/map-phase2b/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({id:'fixture',password:'synthetic-password'})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0],headers={cookie,origin,'content-type':'application/json'};
 const get=async()=>{const r=await realFetch(base+'/api/map-phase2b/private/road-route/config',{headers});assert.equal(r.status,200);return (await r.json()).data;};
 const route=async(requestId=1)=>realFetch(base+'/api/map-phase2b/private/manual-road-route',{method:'POST',headers,body:JSON.stringify({mode:'MANUAL_WAYPOINTS',requestId,origin:{id:'o',lat:37,lng:127},waypoints:[],destination:{id:'d',lat:37.01,lng:127.01},...extra.points})});
 return {base,headers,get,route,calls,get state(){return state;},close:()=>new Promise(r=>server.close(r))};
}
test('Production defaults OFF with no inferred Hub budget backend',async()=>{
 const f=await fixture({env:{OPSMAP_ROAD_ROUTE_ENABLED:'1'}});try{assert.equal((await realFetch(f.base+'/api/map-phase2b/private/road-route/config')).status,401);const s=await f.get();assert.equal(s.enabled,false);assert.equal(s.persistentBudgetConfigured,false);assert.equal(s.budgetBackend,'NONE');assert.equal(s.approvedRemaining,null);assert(s.blockedReasons.includes('FEATURE_DISABLED'));assert(s.blockedReasons.includes('PERSISTENT_BUDGET_REQUIRED'));assert.equal((await f.route()).status,503);assert.equal(f.calls.length,0);}finally{await f.close();}
});
test('Production explicit flag alone cannot enable calls without an existing approved ledger',async()=>{
 for(const enabled of [false,true]){const f=await fixture({env:{OPSMAP_ROAD_BUDGET_STORE_ENABLED:'1',OPSMAP_PRODUCTION_ROAD_ROUTE_ENABLED:enabled?'1':'0'}});try{const s=await f.get();assert.equal(s.canRequest,false);assert.equal(s.budgetVerified,false);assert.equal(s.budgetError,'ROAD_BUDGET_LEDGER_MISSING');assert.equal(s.enabled,enabled);assert.equal((await f.route()).status,enabled?429:503);assert(f.calls.every(c=>c.url.startsWith('https://api.github.com/')&&c.method==='GET'));}finally{await f.close();}}
});
test('approved free ledger can be inspected while OFF and a guarded one-call sample preserves auth, cache and quota',async()=>{
 const off=await fixture({ledger:true,env:{OPSMAP_ROAD_BUDGET_STORE_ENABLED:'1'}});try{const s=await off.get();assert.equal(s.budgetVerified,true);assert.equal(s.approvedRemaining,1);assert.deepEqual(s.blockedReasons,['FEATURE_DISABLED']);assert(off.calls.every(c=>c.method==='GET'));}finally{await off.close();}
 const f=await fixture({ledger:true,env:{OPSMAP_ROAD_BUDGET_STORE_ENABLED:'1',OPSMAP_PRODUCTION_ROAD_ROUTE_ENABLED:'1'}});try{
  assert.equal((await f.get()).canRequest,true);const first=await f.route();assert.equal(first.status,200);const fetched=await first.json();assert.equal(fetched.data.distanceMeters,100);assert.equal(fetched.data.durationSeconds,60);assert.deepEqual(fetched.data.chunks[0].geometry[0].latLngs,[[37,127],[37.01,127.01]]);assert.equal(fetched.meta.providerHttp,200);
  const second=await f.route(2);assert.equal(second.status,200);const cached=await second.json();assert.equal(cached.meta.cache,'HIT');assert.equal(cached.meta.providerHttp,null);assert.equal(f.state.roadBudget.used,1);assert.equal(f.calls.filter(c=>c.url.startsWith('https://apis-navi.')).length,1);assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
  const config=await f.get();assert.equal(config.approvedRemaining,0);assert.equal(config.canRequest,false);assert(config.blockedReasons.includes('QUOTA_EXCEEDED'));assert(!JSON.stringify(config).includes(key));
  const recorded=await realFetch(f.base+'/api/map-phase2b/private/road-route',{method:'POST',headers:f.headers,body:'{}'});assert.equal(recorded.status,400);assert.equal((await recorded.json()).error,'INVALID_MANUAL_ROUTE');
 }finally{await f.close();}
});
test('provider rejection status differs from the local quota refusal after reservation',async()=>{
 const f=await fixture({ledger:true,providerHttp:403,env:{OPSMAP_ROAD_BUDGET_STORE_ENABLED:'1',OPSMAP_PRODUCTION_ROAD_ROUTE_ENABLED:'1'}});try{
  const rejected=await f.route();assert.equal(rejected.status,502);assert.deepEqual(await rejected.json(),{ok:false,error:'PERMISSION_DENIED',providerHttp:403,failureStage:'FETCH',responseBytes:0});
  const exhausted=await f.route(2);assert.equal(exhausted.status,429);assert.deepEqual(await exhausted.json(),{ok:false,error:'QUOTA_EXCEEDED',providerHttp:null});
  assert.equal(f.state.roadBudget.used,1);assert.equal(f.calls.filter(c=>c.url.startsWith('https://apis-navi.')).length,1);
 }finally{await f.close();}
});
test('staff diagnostics distinguish provider transport, body reads and JSON parsing without exposing upstream text',async t=>{
 const warn=t.mock.method(console,'warn',()=>{});
 const malformed='{"message":"합성 비공개 응답 '+key;
 const partial=Buffer.from('{"routes":[');
 const interrupted=()=>{
  let sent=false;
  const body=new ReadableStream({pull(controller){
   if(!sent){sent=true;controller.enqueue(partial);return;}
   controller.error(Error(key));
  }});
  return new Response(body,{headers:{'content-type':'application/json'}});
 };
 const cases=[
  [()=>{throw Object.assign(Error(key),{code:key,status:599});},'PROVIDER_UNAVAILABLE',null,'TRANSPORT','FETCH',0],
  [()=>new Response(key),'INVALID_RESPONSE',200,'CONTENT_TYPE','READ_BODY',0],
  [interrupted,'PROVIDER_UNAVAILABLE',200,'RESPONSE_STREAM','READ_BODY',partial.byteLength],
  [()=>new Response(malformed,{headers:{'content-type':'application/json'}}),'INVALID_RESPONSE',200,'MALFORMED_JSON','JSON_PARSE',Buffer.byteLength(malformed)]
 ];
 for(const [providerResponse,error,providerHttp,providerFailure,failureStage,responseBytes] of cases){
  const f=await fixture({ledger:true,providerResponse,env:{OPSMAP_ROAD_BUDGET_STORE_ENABLED:'1',OPSMAP_PRODUCTION_ROAD_ROUTE_ENABLED:'1'}});
  try{
   const result=await f.route();
   assert.equal(result.status,502);
   assert.match(result.headers.get('cache-control'),/\bno-store\b/);
   const expected={ok:false,error,providerHttp,providerFailure,failureStage,responseBytes};
   assert.deepEqual(await result.json(),expected);
   assert.deepEqual(JSON.parse(warn.mock.calls.at(-1).arguments[0]),{component:'opsmap-road-route',httpStatus:502,...expected});
   assert.equal(f.state.roadBudget.used,1);
  }finally{await f.close();}
 }
 assert.equal(warn.mock.callCount(),cases.length);
});

// Reduced public example. Keep the documented two sections, totals and X/Y
// vertex order. No operational coordinates or recorded provider traffic.
// https://developers.kakaomobility.com/guide/navi-api/directions#response
const documentedPoints={
 origin:{id:'o',lat:37.402464820205246,lng:127.10764191124568},
 waypoints:[{id:'via',order:1,lat:37.36629687436494,lng:127.17354989857544}],
 destination:{id:'d',lat:37.39419693653072,lng:127.11056336672839}
};
function documentedDirections(){
 const point=({lng,lat})=>({name:'',x:lng,y:lat});
 const road=(distance,duration,vertexes)=>({name:'',distance,duration,traffic_speed:16,traffic_state:0,vertexes});
 return {trans_id:'public-example',routes:[{
  result_code:0,result_msg:'길찾기 성공',
  summary:{
   origin:point(documentedPoints.origin),destination:point(documentedPoints.destination),
   waypoints:documentedPoints.waypoints.map(point),priority:'RECOMMEND',
   fare:{taxi:22200,toll:0},distance:19032,duration:3494
  },
  sections:[
   {distance:10035,duration:1880,roads:[road(186,47,[127.10763122680424,37.40241072822385,127.10645821495126,37.40322184743522])]},
   {distance:8997,duration:1614,roads:[road(14,3,[127.10966790676201,37.394469584427156,127.10982600539788,37.39447077471427])]}
  ]
 }]};
}
const enabled={OPSMAP_ROAD_BUDGET_STORE_ENABLED:'1',OPSMAP_PRODUCTION_ROAD_ROUTE_ENABLED:'1'};

test('public Kakao Directions example format preserves section geometry, distance and duration',async()=>{
 const payload=documentedDirections();
 const f=await fixture({ledger:true,points:documentedPoints,providerResponse:()=>Response.json(payload),env:enabled});
 try{
  const result=await f.route();
  assert.equal(result.status,200);
  const {data,meta}=await result.json();
  assert.equal(data.state,'success');
  assert.deepEqual(data.legs.map(leg=>[leg.distanceMeters,leg.durationSeconds]),[[10035,1880],[8997,1614]]);
  assert.deepEqual([data.distanceMeters,data.durationSeconds],[19032,3494]);
  assert.deepEqual(data.chunks[0].geometry[0].latLngs[0],[37.40241072822385,127.10763122680424]);
  assert.equal(meta.providerHttp,200);
  assert.equal(meta.responseBytes,Buffer.byteLength(JSON.stringify(payload)));
 }finally{await f.close();}
});

test('HTTP 200 route validation identifies the rejected section, road, vertex or total check',async t=>{
 const warn=t.mock.method(console,'warn',()=>{});
 const cases=[
  ['SECTION_COUNT','INVALID_ROAD_ROUTE_RESPONSE',route=>route.sections.pop()],
  ['ROADS_ARRAY','INVALID_ROAD_GEOMETRY',route=>delete route.sections[0].roads],
  ['ROAD_COUNT','INVALID_ROAD_GEOMETRY',route=>route.sections[0].roads=[]],
  ['VERTEX_ARRAY','INVALID_ROAD_GEOMETRY',route=>delete route.sections[0].roads[0].vertexes],
  ['VERTEX_LENGTH','INVALID_ROAD_GEOMETRY',route=>route.sections[0].roads[0].vertexes.pop()],
  ['VERTEX_COORDINATE','INVALID_COORDINATE',route=>route.sections[0].roads[0].vertexes[1]=127],
  ['DISTANCE_SUM','INCOMPLETE_ROAD_ROUTE',route=>route.summary.distance+=10],
  ['DURATION_SUM','INCOMPLETE_ROAD_ROUTE',route=>route.summary.duration+=10]
 ];
 for(const [validationCheck,providerFailure,mutate] of cases){
  const payload=documentedDirections();
  mutate(payload.routes[0]);
  const f=await fixture({ledger:true,points:documentedPoints,providerResponse:()=>Response.json(payload),env:enabled});
  try{
   const result=await f.route();
   assert.equal(result.status,502,validationCheck);
   const expected={ok:false,error:'INVALID_RESPONSE',providerHttp:200,providerFailure,
    failureStage:'VALIDATE_ROUTE',responseBytes:Buffer.byteLength(JSON.stringify(payload)),validationCheck};
   assert.deepEqual(await result.json(),expected);
   assert.deepEqual(JSON.parse(warn.mock.calls.at(-1).arguments[0]),{component:'opsmap-road-route',httpStatus:502,...expected});
   assert.equal(f.state.roadBudget.used,1);
  }finally{await f.close();}
 }
 assert.equal(warn.mock.callCount(),cases.length);
});

test('HTTP serialization failure after a valid provider response reports its own stage',async t=>{
 const warn=t.mock.method(console,'warn',()=>{});
 const payload=documentedDirections();
 const f=await fixture({ledger:true,points:documentedPoints,providerResponse:()=>Response.json(payload),env:enabled,
  jsonReplacer:(property,value)=>{if(property==='calculatedAt')throw Error(key);return value;}});
 try{
  const result=await f.route();
  assert.equal(result.status,502);
  const expected={ok:false,error:'ROAD_ROUTE_FAILED',providerHttp:200,providerFailure:'SERIALIZATION_FAILED',
   failureStage:'SERIALIZE',responseBytes:Buffer.byteLength(JSON.stringify(payload))};
  assert.deepEqual(await result.json(),expected);
  assert.deepEqual(warn.mock.calls.map(call=>JSON.parse(call.arguments[0])),[{component:'opsmap-road-route',httpStatus:502,...expected}]);
  assert.equal(f.state.roadBudget.used,1);
 }finally{await f.close();}
});
