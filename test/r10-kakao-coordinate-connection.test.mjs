import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import express from 'express';
import {createMemoryCoordinateStore} from '../src/opsmap-abc/opsmapCoordinateIngestion.js';
import {kakaoCoordinateResult} from '../src/opsmap-abc/opsmapAutoCoordinates.js';
import {createKakaoCoordinateConnection,createKakaoGeocodeLedger,KAKAO_DIAGNOSTIC_ADDRESS,mountKakaoCoordinateConnection} from '../src/opsmap-abc/kakaoCoordinateConnection.js';
import {createProductionGeocodeBudgetGithubStore} from '../src/opsmap-abc/manualPinGithubStore.js';
// All credentials, staff sessions, sources and provider responses are synthetic.
const hash=text=>createHash('sha256').update(text).digest('hex'),stamp=Date.parse('2026-11-03T06:00:00Z');
const doc=address=>({address_name:address,x:'127.01',y:'37.51'}),body=address=>({documents:[doc(address)],meta:{is_end:true,total_count:1}});
function fixture({ledger=createKakaoGeocodeLedger(),reply,enabled='0'}={}){
 const env={KAKAO_REST_API_KEY:'a'.repeat(32),KAKAO_MAP_APP_ID:'1464792',OPSMAP_KAKAO_REST_KEY_SHA256:hash('a'.repeat(32)),
  OPSMAP_KAKAO_FREE_QUOTA_VERIFIED:'1',OPSMAP_KAKAO_PAID_API_DISABLED:'1',OPSMAP_KAKAO_DIAGNOSTIC_ENABLED:'1',OPSMAP_KAKAO_GEOCODING_ENABLED:enabled};
 const calls=[],store={...createMemoryCoordinateStore(ledger),durable:true};let clock=stamp;
 const service=createKakaoCoordinateConnection({env,store,now:()=>clock,fetchImpl:async(url,options)=>{calls.push({url,options});return reply?reply(url,options):{ok:true,json:async()=>body(url.searchParams.get('query'))};}});
 return {env,calls,store,service,advance:ms=>clock+=ms};
}
test('initial OFF permits only one exact allowlist diagnostic, without resetting historical250',async()=>{
 const f=fixture();assert.equal((await f.service.status()).enabled,false);
 await assert.rejects(f.service.lookup(KAKAO_DIAGNOSTIC_ADDRESS),/GEOCODING_DISABLED/);
 await assert.rejects(f.service.lookup('경기도 오산시 원동 1',{diagnostic:true}),/DIAGNOSTIC_ADDRESS_REJECTED/);
 const r=await f.service.lookup(KAKAO_DIAGNOSTIC_ADDRESS,{diagnostic:true});assert.equal(r.data.providerHttp,200);assert.equal(r.data.exact,true);assert.equal(f.calls.length,1);
 await assert.rejects(f.service.lookup(KAKAO_DIAGNOSTIC_ADDRESS,{diagnostic:true}),/DIAGNOSTIC_ALREADY_USED/);
 const saved=f.store.snapshot();assert.equal(saved.historicalConsumed,250);assert.equal(saved.used,1);assert(saved.diagnosticPassed);assert(!JSON.stringify(saved).includes('원동'));assert(!JSON.stringify(saved).includes('127.01'));
});
test('success plus explicit enable connects later live requests, retaining no API result cache',async()=>{
 const f=fixture();await f.service.lookup(KAKAO_DIAGNOSTIC_ADDRESS,{diagnostic:true});f.env.OPSMAP_KAKAO_GEOCODING_ENABLED='1';assert.equal((await f.service.status()).enabled,true);
 const r=await f.service.lookup(KAKAO_DIAGNOSTIC_ADDRESS);assert.equal(r.data.retention,'REQUEST_ONLY');assert.equal(r.data.coordinatePersistence,false);assert.equal(f.calls.length,2);
 assert.equal(f.calls[0].url.searchParams.get('analyze_type'),'exact');assert.equal(f.calls[0].options.redirect,'error');assert.equal(f.calls[0].options.method,'GET');
});
test('free app proof and matching REST key are required, without a five minute expiry',async()=>{
 const f=fixture();f.advance(86400000);assert.equal((await f.service.status()).diagnosticAvailable,true);
 for(const field of ['OPSMAP_KAKAO_FREE_QUOTA_VERIFIED','OPSMAP_KAKAO_PAID_API_DISABLED','OPSMAP_KAKAO_REST_KEY_SHA256']){const prior=f.env[field];f.env[field]='';await assert.rejects(f.service.lookup(KAKAO_DIAGNOSTIC_ADDRESS,{diagnostic:true}),/TARGET_APP_FREE_QUOTA_UNVERIFIED/);f.env[field]=prior;}
 assert.equal(f.calls.length,0);
});

test('configuration reports only key hashes, source setting and user-console evidence',async()=>{
 const f=fixture(),value=await f.service.configuration({javascriptKey:'b'.repeat(32)});
 assert.equal(value.expectedAppId,'1464792');assert.equal(value.restKeySha256,hash('a'.repeat(32)));assert.equal(value.javascriptKeySha256,hash('b'.repeat(32)));
 assert.equal(value.evidence.addressDailyUsed,0);assert(!JSON.stringify(value).includes('a'.repeat(32)));assert(!JSON.stringify(value).includes('b'.repeat(32)));
 delete f.env.OPSMAP_KAKAO_REST_KEY_SHA256;assert((await f.service.configuration()).missingGateSettings.includes('OPSMAP_KAKAO_REST_KEY_SHA256'));
});

test('official province aliases and number spacing preserve exact building identity',()=>{
 assert(kakaoCoordinateResult(body('경기 오산시 원동 380-38'),'경기도 오산시 원동380-38'));
 assert.equal(kakaoCoordinateResult(body('경기 오산시 원동 380-380'),'경기도 오산시 원동380-38'),null);
 assert.equal(kakaoCoordinateResult(body('경기 오산시 원동 38038'),'경기도 오산시 원동380-38'),null);
});
test('missing durable ledger never falls back to a fresh allowance',async()=>{
 const f=fixture(),service=createKakaoCoordinateConnection({env:f.env,fetchImpl:async()=>{throw Error('MUST_NOT_RUN');}});
 await assert.rejects(service.lookup(KAKAO_DIAGNOSTIC_ADDRESS,{diagnostic:true}),/GEOCODE_DURABLE_LEDGER_REQUIRED/);
});
test('same-address in-flight requests share exactly one reservation and REST call',async()=>{
 let release;const gate=new Promise(r=>release=r),ledger=createKakaoGeocodeLedger();ledger.diagnosticPassed=true;
 const f=fixture({ledger,enabled:'1',reply:async url=>{await gate;return {ok:true,json:async()=>body(url.searchParams.get('query'))};}});
 const a=f.service.lookup('경기도 오산시 원동 18'),b=f.service.lookup('경기도  오산시 원동 18');await new Promise(r=>setTimeout(r,10));release();await Promise.all([a,b]);assert.equal(f.calls.length,1);assert.equal(f.store.snapshot().used,1);
});
test('daily100 cap survives process replacement and counts diagnostic reservations',async()=>{
 const ledger=createKakaoGeocodeLedger();ledger.diagnosticPassed=true;ledger.days['2026-11-03']=100;ledger.used=100;
 const f=fixture({ledger,enabled:'1'});await assert.rejects(f.service.lookup('경기도 오산시 원동 18'),/GEOCODE_DAILY_LIMIT/);assert.equal(f.calls.length,0);assert.equal(f.store.snapshot().used,100);
 f.advance(86400000);await f.service.lookup('경기도 오산시 원동 18');assert.equal(f.store.snapshot().used,101);assert.equal(f.store.snapshot().historicalConsumed,250);
});
test('HTTP errors automatically close the shared circuit and are never retried',async()=>{
 const f=fixture({reply:async()=>({ok:false,status:429})});await assert.rejects(f.service.lookup(KAKAO_DIAGNOSTIC_ADDRESS,{diagnostic:true}),/KAKAO_HTTP_REJECTED/);
 await assert.rejects(f.service.lookup(KAKAO_DIAGNOSTIC_ADDRESS,{diagnostic:true}),/GEOCODE_AUTOMATICALLY_BLOCKED/);assert.equal(f.calls.length,1);assert(f.store.snapshot().blocked);assert.equal(f.store.snapshot().used,1);
});
test('multiple results, partial pagination and invalid Korea coordinates remain unresolved',()=>{
 for(const response of [{documents:[doc(KAKAO_DIAGNOSTIC_ADDRESS),doc(KAKAO_DIAGNOSTIC_ADDRESS)],meta:{is_end:true,total_count:2}},
  {documents:[doc(KAKAO_DIAGNOSTIC_ADDRESS)],meta:{is_end:false,total_count:1}},
  {documents:[{...doc(KAKAO_DIAGNOSTIC_ADDRESS),x:'0',y:'0'}],meta:{is_end:true,total_count:1}}])assert.equal(kakaoCoordinateResult(response,KAKAO_DIAGNOSTIC_ADDRESS),null);
});
test('only isolated hash/count ledger file is read/written; coordinates are rejected',async()=>{
 let value=createKakaoGeocodeLedger();const paths=[];
 const store=createProductionGeocodeBudgetGithubStore({repo:'mingu0702-droid/freshon-cache',token:'SYNTHETIC',branch:'production/opsmap-manual-pins',fetchImpl:async(url,o)=>{
  paths.push(url);if(url.endsWith('/freshon-cache'))return {ok:true,json:async()=>({private:true,permissions:{push:true}})};
  if(o.method==='PUT'){value=JSON.parse(Buffer.from(JSON.parse(o.body).content,'base64'));return {ok:true};}
  return {ok:true,json:async()=>({sha:'a'.repeat(40),encoding:'base64',content:Buffer.from(JSON.stringify(value)).toString('base64')})};
 }});
 await store.transaction(async(state,commit)=>{state.used++;await commit(state);});assert.equal(value.used,1);assert(paths.every(p=>!p.includes('manual-pins-v1.json')));
 await assert.rejects(store.transaction(async(state,commit)=>{state.lat=37.5;await commit(state);}),/GEOCODE_RESULT_RETENTION_FORBIDDEN/);
});
test('staff and same-origin are enforced before reservation, and expired sessions cannot call REST',async()=>{
 const f=fixture(),app=express();let current=true;
 const requireStaff=(q,r,next)=>{if(q.get('x-synthetic-staff')!=='1')return r.status(401).json({error:'STAFF'});r.locals.staffSession={key:'SYNTHETIC'};return next();};
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),origin='http://127.0.0.1:'+server.address().port;
 mountKakaoCoordinateConnection({app,requireStaff,isSessionCurrent:(_q,key)=>current&&key==='SYNTHETIC',service:f.service,jsonBody:express.json(),origin});
 const url=origin+'/api/map-phase2b/private/address-lookup-diagnostic',options={method:'POST',headers:{'content-type':'application/json','x-synthetic-staff':'1',origin},body:JSON.stringify({query:KAKAO_DIAGNOSTIC_ADDRESS})};
 try{assert.equal((await fetch(url,{...options,headers:{'content-type':'application/json',origin}})).status,401);assert.equal((await fetch(url,{...options,headers:{...options.headers,origin:'https://wrong.invalid'}})).status,403);current=false;assert.equal((await fetch(url,options)).status,401);assert.equal(f.calls.length,0);}
 finally{await new Promise(r=>server.close(r));}
});
