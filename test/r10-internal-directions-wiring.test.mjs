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
  if(url.startsWith('https://apis-navi.kakaomobility.com/v1/directions?'))return response({routes:[{result_code:0,summary:{distance:100,duration:60},sections:[{distance:100,duration:60,roads:[{vertexes:[127,37,127.01,37.01]}]}]}]},extra.providerHttp??200);
  assert.fail('Unexpected synthetic outbound surface');
 };
 try{mountProductionOpsmapCandidate(app,{env,publicDir:fileURLToPath(new URL('../public/',import.meta.url)),sessionStore:{get:async k=>sessions.get(k),set:async(k,v)=>sessions.set(k,v),touch:async(k,v)=>{if(!sessions.has(k))return false;sessions.set(k,v);return true;},delete:async k=>sessions.delete(k)},readPhase2bSnapshot:async()=>snapshot,getSnapshotMemory:()=>snapshot,phase2bKstDate:()=> '2026-11-03',normalizeCell:v=>String(v||''),normalizeDateValue:v=>v,phase2bSnapshotMeta:()=>({}),phase2bTodayStatus:async()=>({vehicles:[]}),callHub:async action=>assert.fail('Hub call forbidden: '+action)});}finally{globalThis.fetch=realFetch;}
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/opsmap';
 const login=await realFetch(base+'/api/map-phase2b/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({id:'fixture',password:'synthetic-password'})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0],headers={cookie,origin,'content-type':'application/json'};
 const get=async()=>{const r=await realFetch(base+'/api/map-phase2b/private/road-route/config',{headers});assert.equal(r.status,200);return (await r.json()).data;};
 const route=async(requestId=1)=>realFetch(base+'/api/map-phase2b/private/manual-road-route',{method:'POST',headers,body:JSON.stringify({mode:'MANUAL_WAYPOINTS',requestId,origin:{id:'o',lat:37,lng:127},waypoints:[],destination:{id:'d',lat:37.01,lng:127.01}})});
 return {base,headers,get,route,calls,get state(){return state;},close:()=>new Promise(r=>server.close(r))};
}
test('staff SDK configuration projects only verified registered Osan data without outbound calls',async()=>{
 const point={verified:true,lat:37.001234567,lng:127.001234567,sourceVersion:'SYNTHETIC:v1',address:'Synthetic warehouse',ignored:'never-project'};
 const path='/api/map-phase2b/private/map-sdk-config?sdkOnly=1';
 for(const [setting,expected] of [
  [JSON.stringify(point),[{id:'osan',verified:true,lat:point.lat,lng:point.lng,sourceVersion:point.sourceVersion,address:point.address}]],
  [undefined,[{id:'osan',verified:true,lat:37.1420107,lng:127.0794408,sourceVersion:'operator-confirmed:2026-11-07',address:'경기도 오산시 동부대로 446'}]],
  ['{',undefined],
  [JSON.stringify({...point,verified:false}),undefined],
  [JSON.stringify({...point,id:'yeongnam'}),undefined],
  [JSON.stringify({...point,lat:String(point.lat)}),undefined],
  [JSON.stringify({...point,lng:150}),undefined],
  [JSON.stringify({...point,sourceVersion:' '}),undefined]
 ]){
  const f=await fixture({env:{KAKAO_MAP_JAVASCRIPT_KEY:'a'.repeat(32),OPSMAP_VERIFIED_OSAN_CENTER_JSON:setting}});
  try{
   assert.equal((await realFetch(f.base+path)).status,401);
   const response=await realFetch(f.base+path,{headers:f.headers});
   assert.equal(response.status,200);
   assert.match(response.headers.get('cache-control'),/\bno-store\b/);
   assert.deepEqual((await response.json()).centers,expected);
   assert.deepEqual(f.calls,[]);
  }finally{await f.close();}
 }
});
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
  const recorded=await realFetch(f.base+'/api/map-phase2b/private/road-route',{method:'POST',headers:f.headers,body:'{}'});assert.equal(recorded.status,409);assert.equal((await recorded.json()).error,'RECORDED_ORDER_REQUIRED');
 }finally{await f.close();}
});
test('provider rejection status differs from the local quota refusal after reservation',async()=>{
 const f=await fixture({ledger:true,providerHttp:403,env:{OPSMAP_ROAD_BUDGET_STORE_ENABLED:'1',OPSMAP_PRODUCTION_ROAD_ROUTE_ENABLED:'1'}});try{
  const rejected=await f.route();assert.equal(rejected.status,502);assert.deepEqual(await rejected.json(),{ok:false,error:'PERMISSION_DENIED',providerHttp:403});
  const exhausted=await f.route(2);assert.equal(exhausted.status,429);assert.deepEqual(await exhausted.json(),{ok:false,error:'QUOTA_EXCEEDED',providerHttp:null});
  assert.equal(f.state.roadBudget.used,1);assert.equal(f.calls.filter(c=>c.url.startsWith('https://apis-navi.')).length,1);
 }finally{await f.close();}
});
