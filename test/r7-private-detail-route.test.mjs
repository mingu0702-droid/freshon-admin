import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountProductionMapApi} from '../src/opsmap-abc/productionMapIntegration.js';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';

const code='S970001',day='2026-10-23',today='2026-10-31',future='2026-11-01';
const sourceRow={customerCode:code,customerName:'SYNTHETIC_ONLY',customerAddress:'서울특별시 가상로 10',accessInfo:'SYNTHETIC_AUTHORISED_ONLY',password:'synthetic-password'};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const bounded=(promise,label)=>Promise.race([promise,new Promise((_resolve,reject)=>{const t=setTimeout(()=>reject(Error('FIXTURE_WAIT_'+label)),2000);t.unref();})]);

async function fixture({source=async()=>({ok:true,data:{...sourceRow},meta:{sourceVersion:'SYNTHETIC_VERSION'}}),cache=false}={}){
 const calls=[],sessions=new Map();let getPause=null,reads=0;
 const sessionStore={kind:'ISOLATED_ROUTE_TEST',async get(key){
   if(getPause&&++reads===getPause.after){getPause.reached.resolve();await getPause.release.promise;}
   return sessions.get(key)||null;
  },async set(key,value){sessions.set(key,value);},async touch(key,value){if(!sessions.has(key))return false;sessions.set(key,value);return true;},async delete(key){sessions.delete(key);}};
 const origin='https://localhost:3000',env={MAP_STAFF_ID:'synthetic-employee',MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash('synthetic-password'),MAP_STAFF_SESSION_SECRET:'synthetic-only-session-secret-00000000000000000000000',MAP_STAFF_ORIGIN:origin,
  OPSMAP_PRIVATE_DETAIL_CACHE_ENABLED:cache?'1':'0',OPSMAP_PREPARED_DETAILS_ENABLED:'0',OPSMAP_ROAD_ROUTE_ENABLED:'0'};
 const app=express(),previous=process.env.RENDER_EXTERNAL_URL;delete process.env.RENDER_EXTERNAL_URL;
 try{mountProductionMapApi(app,{previewEnabled:()=>true,requireView:(_q,_r,next)=>next(),authOptions:{env,sessionStore},
  readPhase2bSnapshot:async()=>({rows:[],latestDate:day}),getSnapshotMemory:()=>({latestDate:day}),phase2bKstDate:()=>today,
  normalizeCell:v=>String(v||'').trim(),normalizeDateValue:v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v))?String(v):null,
  phase2bSnapshotMeta:()=>({}),phase2bTodayStatus:async()=>assert.fail('REMOTE_COLLECTOR_FORBIDDEN'),
  callHub:async(action,params,options)=>{calls.push({action,params,options});return source(action,params,options);}});
 }finally{if(previous===undefined)delete process.env.RENDER_EXTERNAL_URL;else process.env.RENDER_EXTERNAL_URL=previous;}
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const base='http://127.0.0.1:'+server.address().port;
 const login=await fetch(base+'/api/map-phase2b/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({id:env.MAP_STAFF_ID,password:'synthetic-password'})});
 assert.equal(login.status,200);await login.json();const cookie=login.headers.get('set-cookie').split(';')[0],headers={cookie,origin};
 return {calls,sessions,
  read:(date=day,view='',options={})=>fetch(base+'/api/map-phase2b/private/customer-detail?customerCode='+code+'&date='+date+(view?'&view='+view:''),{...options,headers:{...headers,...options.headers}}),
  session:async()=>{const r=await fetch(base+'/api/map-phase2b/auth/session',{headers});assert.equal(r.status,200);return r.json();},
  logout:()=>fetch(base+'/api/map-phase2b/auth/logout',{method:'POST',headers}),
  pauseRecheck:()=>{reads=0;getPause={after:3,reached:deferred(),release:deferred()};return getPause;},
  close:async()=>{getPause?.release.resolve();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}

test('cached protected detail is reauthorized before response after concurrent logout',async()=>{
 const f=await fixture({cache:true});try{
  const warm=await f.read();assert.equal(warm.status,200);assert.equal((await warm.json()).meta.cache.cache,'MISS');assert.equal(f.calls.length,1);
  // The two existing entry guards pass; pause the after-cache session recheck.
  const pause=f.pauseRecheck(),pending=f.read();await bounded(pause.reached.promise,'CACHE_RECHECK');assert.equal(f.calls.length,1);
  const logout=await f.logout();assert.equal(logout.status,200);await logout.json();pause.release.resolve();
  const denied=await pending;assert.equal(denied.status,401);assert.doesNotMatch(await denied.text(),/SYNTHETIC_AUTHORISED_ONLY|synthetic-password/);assert.equal(f.calls.length,1);
 }finally{await f.close();}
});

test('caller disconnect aborts the actual source signal and does not log out the employee',async()=>{
 const started=deferred(),aborted=deferred();
 const f=await fixture({source:async(_action,_params,options)=>{
  started.resolve(options);return new Promise((_resolve,reject)=>{options.signal?.addEventListener('abort',()=>{aborted.resolve();reject(new DOMException('fixture cancelled','AbortError'));},{once:true});});
 }});try{
  const controller=new AbortController(),pending=f.read(day,'',{signal:controller.signal});
  const options=await bounded(started.promise,'SOURCE_START');assert(options.signal instanceof AbortSignal);assert(options.deadline>Date.now());assert(options.deadline<=Date.now()+20000);
  controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');await bounded(aborted.promise,'SOURCE_ABORT');
  assert.equal((await f.session()).authenticated,true);assert.equal(f.sessions.size,1);assert.equal(f.calls.length,1);
 }finally{await f.close();}
});

test('upstream authentication failure is a source 502, not employee 401 or a logout',async()=>{
 const f=await fixture({source:async()=>{throw Object.assign(Error('SYNTHETIC_SOURCE_AUTH'),{upstreamStatus:401,failureType:'auth'});}});try{
  const r=await f.read();assert.equal(r.status,502);const body=await r.json();assert.equal(body.error,'DETAIL_SOURCE_AUTH_REQUIRED');assert.equal(body.data,null);
  assert.equal((await f.session()).authenticated,true);assert.equal(f.sessions.size,1);assert.equal(f.calls.length,1);
 }finally{await f.close();}
});

test('HTTP200 internal error and mismatching customer or explicit source date never expose protected fields',async()=>{
 const payloads=[{ok:false,data:{...sourceRow},error:{code:'INTERNAL_ERROR'},meta:{}},
  {ok:true,data:{...sourceRow,customerCode:'S970002'},meta:{}},
  {ok:true,data:{...sourceRow,deliveryDate:'2026-10-22'},meta:{}},
  {ok:true,data:{...sourceRow,memoDate:'2026-10-22'},meta:{}}];
 let index=0;const f=await fixture({source:async()=>payloads[index++]});try{
  for(const _payload of payloads){const r=await f.read();assert.equal(r.status,502);const text=await r.text();assert.match(text,/DETAIL_INVALID_RESPONSE/);assert.doesNotMatch(text,/SYNTHETIC_AUTHORISED_ONLY|synthetic-password/);}
  assert.equal((await f.session()).authenticated,true);assert.equal(f.calls.length,payloads.length);
 }finally{await f.close();}
});

test('current Customer basic detail accepts future display context without inventing a source date',async()=>{
 const f=await fixture();try{
  const r=await f.read(future,'store');assert.equal(r.status,200);const body=await r.json();assert.equal(body.data.detailDate,null);assert.equal(body.data.sourceBasis,'CURRENT_CUSTOMER_LOOKUP');assert.equal(body.data.password,undefined);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].action,'customerDetail');assert.deepEqual(f.calls[0].params,{customerCode:code});assert.equal(f.calls[0].options.privateRead,true);assert.equal(f.calls[0].options.maxResponseBytes,65536);assert(f.calls[0].options.signal instanceof AbortSignal);
 }finally{await f.close();}
});

test('future protected notes stay PENDING until dated source evidence exists; no guessed source request',async()=>{
 const f=await fixture();try{
  const r=await f.read(future);assert.equal(r.status,202);const body=await r.json();assert.equal(body.error,'PLANNED_SOURCE_UNOBSERVED');assert.equal(body.data,null);assert.equal(body.meta.date,future);assert.equal(body.meta.planned,true);assert.equal(body.meta.sourceObserved,false);assert.equal(f.calls.length,0);
  assert.equal((await f.session()).authenticated,true);
 }finally{await f.close();}
});
