import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotProjection,validateSnapshotProjection,mergePreservedSnapshot,materializeSnapshot,createProductionSnapshotStore} from '../src/productionSnapshotStore.js';
import {createFixedVehicleStore,fixedEnvelope} from '../src/fixedVehicleStore.js';
import {deliverySourceObservation,snapshotRefreshEvidence} from '../src/snapshotRefreshEvidence.js';
const now=()=>Date.parse('2026-11-02T00:00:00Z');
const row=(n,date='2026-08-24')=>({customerCode:'S'+(100000+n),customerName:'SYNTHETIC '+n,lastDeliveryDate:date,lat:37.4+n/100000,lng:127,vehicle:'101'});
const snapshot=(rows,extra={})=>({version:'phase2b-map-snapshot-v1',generatedAt:'2026-11-02T00:00:00.000Z',latestDate:'2026-11-02',startDate:'2026-06-26',rowCount:rows.length,rows,...extra});
test('3132->1464 regression: partial date refresh preserves all old customer codes',()=>{
 const old=snapshotProjection(snapshot(Array.from({length:3132},(_,i)=>row(i))),{now});
 const fresh=snapshot(Array.from({length:1464},(_,i)=>row(i,'2026-11-02')),{startDate:'2026-09-04',sourceFreshness:{targetDate:'2026-11-02',checkedThrough:'2026-08-24',phase:'PARTIAL',sourceDateVerified:true,sourceReadComplete:true}});
 const merged=mergePreservedSnapshot(old,fresh,{now});
 assert.equal(merged.rowCount,3132);assert.equal(merged.startDate,'2026-06-26');assert.equal(merged.latestDate,'2026-11-02');assert.equal(merged.checkpointDate,'2026-08-24');
 assert.equal(new Set(merged.rows.map(r=>r.customerCode)).size,3132);assert.equal(materializeSnapshot(merged).refreshComplete,false);assert.equal(materializeSnapshot(merged).sourceFreshness.automaticSyncVerified,false);validateSnapshotProjection(merged);
});
test('projection discards raw addresses, all secrets and source objects',()=>{
 const projected=snapshotProjection(snapshot([{...row(0),address:'SYNTHETIC ADDRESS',detailAddress:'SYNTHETIC ROOM',password:'SYNTHETIC_SECRET',phone:'SYNTHETIC_PHONE',raw:{token:'SYNTHETIC_TOKEN'}}]),{now});
 assert.equal(/SYNTHETIC_(?:ADDRESS|ROOM|SECRET|PHONE|TOKEN)/.test(JSON.stringify(projected)),false);
 assert.throws(()=>snapshotProjection(snapshot([row(0),row(0)]),{now}),{code:'SNAPSHOT_DUPLICATE_CUSTOMER'});
 const corrupt=structuredClone(projected);corrupt.rows[0].lat+=1;assert.throws(()=>validateSnapshotProjection(corrupt),{code:'SNAPSHOT_INTEGRITY'});
});
test('snapshot restore preserves a confirmed blank fixed route and rejects unrelated blank evidence',()=>{
 const base={baseVehicle:'',baseVehicleState:'UNASSIGNED',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleEmptyVerified:true};
 const projected=snapshotProjection(snapshot([{...row(0),...base},{...row(1),...base,baseVehicleState:'UNKNOWN'},
  {...row(2),...base,baseVehicleSource:'PUBLISHED_ONLY'}]),{now});
 const saved=validateSnapshotProjection(structuredClone(projected)).rows;
 assert.equal(saved[0].baseVehicleEmptyVerified,true);
 assert.equal(saved[1].baseVehicleEmptyVerified,undefined);
 assert.equal(saved[2].baseVehicleEmptyVerified,undefined);
});
test('partial source with no rows cannot delete current; newer additions union; stale rows do not overwrite',()=>{
 const old=snapshotProjection(snapshot([row(0,'2026-10-31')]),{now});
 assert.throws(()=>mergePreservedSnapshot(old,snapshot([]),{now}),{code:'SNAPSHOT_COUNT'});
 const result=mergePreservedSnapshot(old,snapshot([{...row(0,'2026-08-24'),lat:31},row(1,'2026-11-02')]),{now});assert.equal(result.rowCount,2);assert.equal(result.rows[0].lat,old.rows[0].lat);
});
test('requested November2 is not source-date evidence; actual KST date and page proof are required',()=>{
 const absent=deliverySourceObservation([{id:1}],{date:'2026-11-02',complete:true,pages:1});assert.equal(absent.dateVerified,false);
 const wrong=deliverySourceObservation([{id:1,enteringDatedAt:'2026-10-31T00:00:00+09:00'}],{date:'2026-11-02',complete:true,pages:1});assert.equal(wrong.wrongDateRows,1);
 const actual=deliverySourceObservation([{id:1,enteringDatedAt:'2026-11-01T15:00:00Z'}],{date:'2026-11-02',complete:true,pages:1});assert.equal(actual.dateVerified,true);
 const evidence=snapshotRefreshEvidence({targetDate:'2026-11-02',previousThrough:'2026-08-24',todayStatus:{date:'2026-11-02',sourceObservation:actual}});assert.equal(evidence.sourceFreshness.sourceDateVerified,true);assert.equal(evidence.sourceFreshness.phase,'PARTIAL');assert.equal(evidence.refreshComplete,false);assert.equal(evidence.sourceFreshness.automaticSyncVerified,false);
});
test('coordinates keep manual/GPS priority but changed address hash prevents stale reuse',()=>{
 const a='a'.repeat(64),b='b'.repeat(64);
 const old=snapshotProjection(snapshot([{...row(0),coordinateSource:'MANUAL_PIN',originalAddressHash:a}]),{now});
 const same=mergePreservedSnapshot(old,snapshot([{...row(0,'2026-11-02'),lat:38,coordinateSource:'KAKAO_BUILDING',originalAddressHash:a}]),{now});assert.equal(same.rows[0].lat,old.rows[0].lat);assert.equal(same.rows[0].coordinateSource,'MANUAL_PIN');
 const changed=mergePreservedSnapshot(old,snapshot([{...row(0,'2026-11-02'),lat:null,lng:null,originalAddressHash:b}]),{now});assert.equal(changed.rows[0].lat,null);
});
function fakeGithub({privateRepo=true,conflict=false,readFail=false}={}){
 let state=null,sha=null,puts=0;const requests=[];
 const fetchImpl=async(url,options={})=>{requests.push({url,method:options.method||'GET'});if(url.endsWith('/freshon-cache'))return new Response(JSON.stringify({private:privateRepo}),{status:200});
  if(options.method==='PUT'){puts++;if(conflict)return new Response('{}',{status:409});const body=JSON.parse(options.body);assert.equal(body.branch,'production/opsmap-snapshots');assert.equal(body.sha??null,sha);state=JSON.parse(Buffer.from(body.content,'base64'));sha=String(puts).padStart(40,'0');return new Response('{}',{status:200});}
  if(readFail&&puts)return new Response('{}',{status:500});if(!state)return new Response('{}',{status:404});return new Response(JSON.stringify({sha,content:Buffer.from(JSON.stringify(state)).toString('base64')}),{status:200});};
 return {fetchImpl,requests,get state(){return state;},get puts(){return puts;}};
}
const env={OPSMAP_SNAPSHOT_STORE_ENABLED:'1',OPSMAP_PRODUCTION_CANDIDATE_ENABLED:'1',OPSMAP_SNAPSHOT_STORE_REPO:'mingu0702-droid/freshon-cache',OPSMAP_SNAPSHOT_STORE_BRANCH:'production/opsmap-snapshots'};
test('existing CAS adapter: durable save, process restart load, atomic previous and no auth/pin paths',async()=>{
 const gh=fakeGithub(),create=()=>createProductionSnapshotStore({env,token:'SYNTHETIC_ONLY',fetchImpl:gh.fetchImpl,now});
 const first=await create().save(snapshot([row(0)]));const restarted=create();assert.equal((await restarted.load()).sha256,first.sha256);
 const second=await restarted.save(snapshot([row(1,'2026-11-02')]));assert.equal(second.rowCount,2);assert.equal(gh.state.previous.sha256,first.sha256);assert.equal(gh.state.current.sha256,second.sha256);assert.equal(gh.puts,2);
 assert(gh.requests.every(r=>!r.url.includes('manual-pins')&&!r.url.includes('staff-sessions')));
});
test('public repo / cross-environment / CAS conflict fail closed; current remains unchanged',async()=>{
 assert.throws(()=>createProductionSnapshotStore({env:{...env,OPSMAP_SNAPSHOT_STORE_BRANCH:'stage/opsmap-snapshots'},token:'SYNTHETIC_ONLY'}),{code:'SNAPSHOT_STORE_ENVIRONMENT'});
 const pub=fakeGithub({privateRepo:false});await assert.rejects(createProductionSnapshotStore({env,token:'SYNTHETIC_ONLY',fetchImpl:pub.fetchImpl,now}).save(snapshot([row(0)])),{code:'FIXED_STORE_NOT_PRIVATE'});assert.equal(pub.puts,0);
 const conflict=fakeGithub({conflict:true});await assert.rejects(createProductionSnapshotStore({env,token:'SYNTHETIC_ONLY',fetchImpl:conflict.fetchImpl,now}).save(snapshot([row(0)])),{code:'FIXED_STORE_CONFLICT'});assert.equal(conflict.state,null);
});
test('readback failure does not claim successful storage',async()=>{
 const gh=fakeGithub({readFail:true});await assert.rejects(createProductionSnapshotStore({env,token:'SYNTHETIC_ONLY',fetchImpl:gh.fetchImpl,now}).save(snapshot([row(0)])),{code:'FIXED_STORE_READ'});
});
test('corrupt current restores verified previous read-only and refuses blind overwrite',async()=>{
 const gh=fakeGithub(),store=createProductionSnapshotStore({env,token:'SYNTHETIC_ONLY',fetchImpl:gh.fetchImpl,now});const first=await store.save(snapshot([row(0)]));await store.save(snapshot([row(1)]));gh.state.current.rows[0].lat+=1;
 const restarted=createProductionSnapshotStore({env,token:'SYNTHETIC_ONLY',fetchImpl:gh.fetchImpl,now});assert.equal((await restarted.load()).sha256,first.sha256);await assert.rejects(restarted.save(snapshot([row(2)])),{code:'SNAPSHOT_INTEGRITY'});assert.equal(gh.puts,2);
});
test('refactored fixed master store still saves/loads with unchanged envelope contract',async()=>{
 let value=null,sha=null;const fetchImpl=async(url,options={})=>{if(url.endsWith('/freshon-cache'))return new Response(JSON.stringify({private:true}));if(options.method==='PUT'){const body=JSON.parse(options.body);value=JSON.parse(Buffer.from(body.content,'base64'));sha='1'.repeat(40);return new Response('{}');}return value?new Response(JSON.stringify({sha,content:Buffer.from(JSON.stringify(value)).toString('base64')})):new Response('{}',{status:404});};
 const store=createFixedVehicleStore({env:{GITHUB_CACHE_REPO:env.OPSMAP_SNAPSHOT_STORE_REPO,GITHUB_TOKEN:'SYNTHETIC_ONLY'},fetchImpl,now});const envelope=fixedEnvelope([{customerCode:'S100001',baseVehicle:'101',baseVehicleGroup:'osan',baseVehicleState:'VERIFIED_MASTER'}],new Date(Date.now()-1000).toISOString());await store.save(envelope);assert.equal((await store.load()).version,envelope.version);
});
