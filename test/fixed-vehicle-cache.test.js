import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {fixedEnvelope,validateFixedEnvelope,createFixedVehicleStore} from '../src/fixedVehicleStore.js';
import {createFixedVehicleCache} from '../src/fixedVehicleCache.js';
import {mountMapDataFreshness} from '../src/mapDataFreshness.js';
import '../public/map-period-ui.js';
const at=Date.now()-86400000;
const row=(code='S99731',vehicle='221',group='osan')=>({customerCode:code,baseVehicle:vehicle,baseVehicleGroup:group,baseVehicleState:vehicle?'VERIFIED_MASTER':'UNASSIGNED'});
const env=data=>fixedEnvelope(data,new Date(at).toISOString());
function memoryStore(initial){let value=initial,lease=null;return {load:async()=>value,save:async v=>{value=structuredClone(v);},acquire:async owner=>{if(lease)return false;lease=owner;return true;},renew:async owner=>assert.equal(owner,lease),release:async owner=>{assert.equal(owner,lease);lease=null;},value:()=>value};}

test('compact durable envelope only contains allowlisted values and UTF8 checksum',()=>{
 const saved=env([{...row(),password:'DO_NOT_STORE',phone:'DO_NOT_STORE',raw:{memo:'DO_NOT_STORE'},weekdays:{Mon:'222'}}]);
 assert(!JSON.stringify(saved).includes('DO_NOT_STORE'));assert.equal(saved.rows[0][4][0],'222');
 assert.equal(validateFixedEnvelope(saved).data[0].baseVehicle,'221');
 const changed=structuredClone(saved);changed.rows[0][1]='999';assert.throws(()=>validateFixedEnvelope(changed),/INTEGRITY/);
 assert.throws(()=>fixedEnvelope([row(),row()],new Date(at).toISOString()),/INVALID/);
});
test('cold memory uses durable snapshot without master read, reconnect is same version',async()=>{
 let reads=0;const store=memoryStore(env([row()]));
 const one=createFixedVehicleCache({store,now:()=>at+1000,reader:async()=>{reads++;throw Error();}});
 const first=await one.get(['S99731']),again=await one.get(['S99731']);
 assert.equal(first.data[0].baseVehicle,'221');assert.equal(first.meta.version,again.meta.version);assert.equal(reads,0);
 const restart=createFixedVehicleCache({store,now:()=>at+2000,reader:async()=>{reads++;}});
 assert.equal((await restart.get(['S99731'])).meta.version,first.meta.version);assert.equal(reads,0);
});
test('expired snapshot returns immediately while exactly one refresh runs',async()=>{
 let resolve,reads=0;const store=memoryStore(env([row()]));
 const api=createFixedVehicleCache({store,now:()=>at+3600000,reader:()=>{reads++;return new Promise(r=>resolve=r);}});
 const results=await Promise.all(Array.from({length:12},()=>api.get(['S99731'])));
 assert(results.every(r=>r.ok&&r.meta.stale&&r.data[0].baseVehicle==='221'));assert.equal(reads,1);
 resolve({data:[row('S99731','222')]});await api.settled();assert.equal((await api.get(['S99731'])).data[0].baseVehicle,'222');
});
test('refresh failure preserves version, verification time and values',async()=>{
 const snapshot=env([row()]),store=memoryStore(snapshot);
 const api=createFixedVehicleCache({store,now:()=>at+3600000,reader:async()=>{throw Object.assign(Error('SECRET'),{code:'FIXED_MASTER_FORBIDDEN'});}});
 await api.get(['S99731']);await api.settled();const p=await api.get(['S99731']);
 assert.equal(p.data[0].baseVehicle,'221');assert.equal(p.meta.version,snapshot.version);assert.equal(p.meta.checkedAt,snapshot.checkedAt);assert.equal(p.meta.refresh,'ERROR');assert(!JSON.stringify(p).includes('SECRET'));
});
test('persistence write failure never swaps the last verified result',async()=>{
 const store=memoryStore(env([row()]));store.save=async()=>{throw Object.assign(Error(),{code:'FIXED_STORE_WRITE'});};
 const api=createFixedVehicleCache({store,now:()=>at+3600000,reader:async()=>({data:[row('S99731','222')]})});
 await api.get(['S99731']);await api.settled();assert.equal((await api.get(['S99731'])).data[0].baseVehicle,'221');
});
test('complete replacement reflects explicit unassignment and deletion, not rental history',async()=>{
 const store=memoryStore(env([row(),row('S2','838')]));
 const api=createFixedVehicleCache({store,now:()=>at+3600000,reader:async()=>({data:[row('S99731','')]})});
 await api.get(['S99731']);await api.settled();const p=await api.get(['S99731','S2']);
 assert.equal(p.data[0].baseVehicleState,'UNASSIGNED');assert.equal(p.data[1].baseVehicleState,'NOT_IN_MASTER');assert(p.data.every(r=>r.baseVehicle===''));
 const merged=MapPeriodUi.mergeBaseVehicles(new Map([['S99731',row()],['S2',row('S2','838')]]),p.data);assert.equal(merged.get('S99731').baseVehicle,'');assert.equal(merged.get('S2').baseVehicle,'');
});
test('competing server instances share lease and never launch a second source read',async()=>{
 let reads=0,resolve;const store=memoryStore(env([row()])),reader=()=>{reads++;return new Promise(r=>resolve=r);};
 const a=createFixedVehicleCache({store,reader,now:()=>at+3600000}),b=createFixedVehicleCache({store,reader,now:()=>at+3600000});
 await Promise.all([a.get(['S99731']),b.get(['S99731'])]);assert.equal(reads,1);assert.equal((await b.get(['S99731'])).data[0].baseVehicle,'221');
 resolve({data:[row()]});await a.settled();await b.settled();
});
test('invalid or partial master does not replace last good projection',async()=>{
 for(const data of [[],[row(),row()],[{...row(),baseVehicleState:'UNKNOWN'}]]){
 const store=memoryStore(env([row()]));const api=createFixedVehicleCache({store,now:()=>at+3600000,reader:async()=>({data})});await api.get(['S99731']);await api.settled();assert.equal((await api.get(['S99731'])).data[0].baseVehicle,'221');
 }
});
test('private store permission failure does not trigger a new full master read',async()=>{
 let reads=0;const store=memoryStore(null);store.load=async()=>{throw Object.assign(Error(),{code:'FIXED_STORE_PERMISSION'});};
 const api=createFixedVehicleCache({store,reader:async()=>{reads++;}});const p=await api.get(['S99731']);assert.equal(p.phase,'ERROR');assert.equal(reads,0);
});
test('read-only subset API keeps all centers, unassigned and outside-period customer lookup',async t=>{
 const store=memoryStore(env([row(),row('S2','333','yeongnam'),row('S3','','honam')]));
 const app=express();mountMapDataFreshness(app,{baseStore:store,readBaseVehicleMaster:async()=>new Promise(()=>{}),callHub:()=>{throw Error();},requireView:(_q,_r,n)=>n(),previewEnabled:()=>true,modelStatus:()=>({})});
 const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));t.after(()=>s.close());const url=`http://127.0.0.1:${s.address().port}/api/map-phase2b/preview/base-vehicles`;
 const post=codes=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customerCodes:codes})});
 assert.equal((await(await fetch(url)).json()).data.length,0);
 const p=await(await post(['S2','S3'])).json();assert.equal(p.data.length,2);assert.equal(p.data[0].baseVehicleGroup,'yeongnam');assert.equal(p.data[1].baseVehicleGroup,'honam');assert.equal(p.data[1].baseVehicleState,'UNASSIGNED');
 const exact=await(await fetch(url+'?customerCode=S99731')).json();assert.equal(exact.data.length,1);assert.equal(exact.data[0].baseVehicle,'221');assert.equal((await post(['INVALID'])).status,400);
});

function githubMock(isPrivate=true){
 const files=new Map(),blobs=new Map();let next=0;const writes=[];
 const fetchImpl=async(url,options={})=>{
   if(!url.includes('/contents/')&&!url.includes('/git/blobs/'))return Response.json({private:isPrivate});
   if(url.includes('/git/blobs/'))return Response.json({content:blobs.get(url.split('/').at(-1))});
   const key=url.split('/contents/')[1].split('?')[0],old=files.get(key);
   if(options.method==='PUT'){const p=JSON.parse(options.body);if(p.sha!==old?.sha)return Response.json({}, {status:409});const sha=(++next).toString(16).padStart(40,'0');files.set(key,{sha,content:p.content});blobs.set(sha,p.content);writes.push(key);return Response.json({content:{sha}});}
   return old?Response.json({sha:old.sha,content:old.content.length>100?'':old.content}):Response.json({}, {status:404});
 };return {fetchImpl,files,writes};
}
const gitEnv={GITHUB_TOKEN:'synthetic',GITHUB_CACHE_REPO:'synthetic/private'};
test('Git store verifies privacy, exact blob, atomic CAS and durable read-back',async()=>{
 const g=githubMock(),store=createFixedVehicleStore({env:gitEnv,fetchImpl:g.fetchImpl});
 await store.save(env([row()]));assert.equal((await store.load()).rows[0][1],'221');assert.equal(g.writes.length,1);
 await store.save(env([row()]));assert.equal(g.writes.length,1);
});
test('public repository is rejected before any cache write',async()=>{
 const g=githubMock(false),store=createFixedVehicleStore({env:gitEnv,fetchImpl:g.fetchImpl});await assert.rejects(()=>store.save(env([row()])),/NOT_PRIVATE/);assert.equal(g.writes.length,0);
});
test('persistent lease expires after crash but cannot be stolen while current',async()=>{
 let clock=at;const g=githubMock(),store=createFixedVehicleStore({env:gitEnv,fetchImpl:g.fetchImpl,now:()=>clock});
 assert.equal(await store.acquire('a'),true);assert.equal(await store.acquire('b'),false);await store.renew('a');clock+=600001;assert.equal(await store.acquire('b'),true);await assert.rejects(()=>store.renew('a'),/LEASE_LOST/);await store.release('a');assert.equal(await store.acquire('c'),false);await store.release('b');assert.equal(await store.acquire('c'),true);
});
test('older snapshot cannot overwrite a newer verified projection',async()=>{
 const g=githubMock(),store=createFixedVehicleStore({env:gitEnv,fetchImpl:g.fetchImpl});
 const newer=fixedEnvelope([row('S99731','222')],new Date(at+1000).toISOString());await store.save(newer);await assert.rejects(()=>store.save(env([row()])),/SUPERSEDED/);assert.equal((await store.load()).version,newer.version);
});
