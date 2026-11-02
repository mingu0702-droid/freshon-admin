import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSelectedDateCheckpoint,selectedDateCheckpointEnvelope,validateSelectedDateCheckpointEnvelope} from '../src/snapshotSelectedDateCheckpoint.js';
import {snapshotProjection,materializeSnapshot,createProductionSnapshotStore,validateSnapshotProjection} from '../src/productionSnapshotStore.js';
import {deliverySourceObservation} from '../src/snapshotRefreshEvidence.js';
const date='2026-11-02',start=Date.parse('2026-11-02T00:00:00.000Z');
const env={OPSMAP_SNAPSHOT_STORE_ENABLED:'1',OPSMAP_PRODUCTION_CANDIDATE_ENABLED:'1',OPSMAP_SNAPSHOT_STORE_REPO:'mingu0702-droid/freshon-cache',OPSMAP_SNAPSHOT_STORE_BRANCH:'production/opsmap-snapshots'};
const row=(customerCode='T900001',vehicle='101')=>({customerCode,vehicle,lastDeliveryDate:date,lat:37.5,lng:127,coordinateSource:'RAW_GPS'});
const snap=(rows=[row()])=>({version:'phase2b-map-snapshot-v1',rowCount:rows.length,rows,startDate:'2026-09-01',sourceFreshness:{targetDate:date,checkedThrough:null,phase:'CHECKPOINT_UNVERIFIED',sourceDateVerified:true,sourceReadComplete:true}});
const live=(generatedAt=new Date(start).toISOString(),vehicles=[{vehicle:'101',stops:[{customerCode:'T900001'}]}])=>({date,generatedAt,vehicles,sourceObservation:deliverySourceObservation(vehicles.flatMap(v=>v.stops.map(()=>({deliveryDate:date}))),{date,complete:true,pages:1,resolveVehicle:()=> '101'})});
function repository(){
 const files=new Map();let puts=0,failCheckpointReadback=false,conflictCheckpoint=false;
 const fetchImpl=async(url,options={})=>{
  if(url.endsWith('/freshon-cache'))return new Response(JSON.stringify({private:true}));
  const name=new URL(url).pathname.split('/').at(-1),old=files.get(name);
  if(options.method==='PUT'){
   if(name==='map-date-checkpoint-v1.json'&&conflictCheckpoint)return new Response('{}',{status:409});
   const body=JSON.parse(options.body);assert.equal(body.sha??null,old?.sha??null);
   files.set(name,{value:JSON.parse(Buffer.from(body.content,'base64')),sha:String(++puts).padStart(40,'0')});return new Response('{}');
  }
  if(name==='map-date-checkpoint-v1.json'&&old&&failCheckpointReadback)return new Response('{}',{status:500});
  return old?new Response(JSON.stringify({sha:old.sha,content:Buffer.from(JSON.stringify(old.value)).toString('base64')})):new Response('{}',{status:404});
 };
 return {fetchImpl,files,get puts(){return puts;},set failCheckpointReadback(value){failCheckpointReadback=value;},set conflictCheckpoint(value){conflictCheckpoint=value;}};
}
test('selected-date evidence preserves the unknown historical cursor and contains no customer rows',()=>{
 const projection=snapshotProjection(snap(),{now:()=>start}),before=JSON.stringify(projection);
 const checkpoint=buildSelectedDateCheckpoint(live(),projection,{checkedAt:new Date(start+1000).toISOString()});
 assert.equal(checkpoint.selectedDateStorageVerified,true);assert.equal(checkpoint.automaticSyncVerified,false);assert.equal(checkpoint.mapDisplayVerified,false);assert.equal(checkpoint.historicalCompletenessVerified,false);
 assert.equal(checkpoint.uniqueCustomerCount,1);assert.equal(JSON.stringify(checkpoint).includes('T900001'),false);
 assert.equal(JSON.stringify(projection),before);assert.equal(projection.schema,1);assert.equal(projection.checkpointDate,null);
 const materialized=materializeSnapshot(projection,{selectedDateCheckpoint:checkpoint});assert.equal(materialized.sourceFreshness.automaticSyncVerified,false);assert.equal(materialized.refreshedThrough,null);assert.equal(materialized.selectedDateCheckpoint.date,date);
 assert.equal(validateSnapshotProjection(projection),projection);
});
test('multiple source visits and vehicles remain separate from last-per-customer snapshot projection',()=>{
 const source=live(undefined,[{vehicle:'101호',stops:[{customerCode:'T900001'},{customerCode:'T900001'}]},{vehicle:'122',stops:[{customerCode:'T900001'}]}]);
 const checkpoint=buildSelectedDateCheckpoint(source,snapshotProjection(snap([row('T900001','122')]),{now:()=>start}),{checkedAt:new Date(start+1000).toISOString()});
 assert.equal(checkpoint.sourceVisitCount,3);assert.equal(checkpoint.uniqueCustomerCount,1);assert.equal(checkpoint.uniqueCustomerVehicleCount,2);assert.equal(checkpoint.multiVehicleCustomerCount,1);assert.equal(checkpoint.projectionPolicy,'LAST_LIVE_VEHICLE_GROUP_STOP_PER_CUSTOMER');
});
test('partial source, missing customer, dropped stops and wrong stored projection never certify storage',()=>{
 const projection=snapshotProjection(snap(),{now:()=>start}),options={checkedAt:new Date(start+1000).toISOString()};
 const partial=live();partial.sourceObservation.complete=false;assert.throws(()=>buildSelectedDateCheckpoint(partial,projection,options),{code:'DELIVERY_SOURCE_INCOMPLETE'});
 const missing=live();missing.vehicles[0].stops[0].customerCode='';assert.throws(()=>buildSelectedDateCheckpoint(missing,projection,options),{code:'SNAPSHOT_DATE_CHECKPOINT_CUSTOMER'});
 const dropped=live();dropped.vehicles[0].stops=[];assert.throws(()=>buildSelectedDateCheckpoint(dropped,projection,options),{code:'SNAPSHOT_DATE_CHECKPOINT_SOURCE_COUNT'});
 assert.throws(()=>buildSelectedDateCheckpoint(live(),snapshotProjection(snap([row('T900001','122')]),{now:()=>start}),options),{code:'SNAPSHOT_DATE_CHECKPOINT_PROJECTION'});
});
test('two fresh observations survive process reconstruction while cached repeats are a checkpoint NOOP',async()=>{
 const github=repository();let clock=start+1000;const create=()=>createProductionSnapshotStore({env,token:'SYNTHETIC_ONLY',fetchImpl:github.fetchImpl,now:()=>clock});
 const firstStore=create(),projection=await firstStore.save(snap()),mainBefore=JSON.stringify(github.files.get('map-snapshot-v1.json'));
 assert.equal(await firstStore.loadSelectedDateCheckpoint(projection),null);
 const first=await firstStore.recordSelectedDateCheckpoint(live(),projection);assert.equal(first.consecutiveObservations,1);
 const puts=github.puts;assert.deepEqual(await firstStore.recordSelectedDateCheckpoint(live(),projection),first);assert.equal(github.puts,puts);
 clock+=3600000;const restarted=create(),reloaded=await restarted.load();assert.equal((await restarted.loadSelectedDateCheckpoint(reloaded)).membershipSha256,first.membershipSha256);
 const second=await restarted.recordSelectedDateCheckpoint(live(new Date(clock-1000).toISOString()),reloaded);assert.equal(second.consecutiveObservations,2);assert.equal(second.snapshotSha256,first.snapshotSha256);
 assert.equal(JSON.stringify(github.files.get('map-snapshot-v1.json')),mainBefore);assert.equal((await restarted.load()).checkpointDate,null);
 const sidecar=github.files.get('map-date-checkpoint-v1.json').value;assert.equal(sidecar.previous.sourceObservedAt,first.sourceObservedAt);validateSelectedDateCheckpointEnvelope(sidecar);
 const again=create();assert.equal((await again.loadSelectedDateCheckpoint(await again.load())).consecutiveObservations,2);
});
test('checkpoint CAS conflict and readback failure never return a verified checkpoint',async()=>{
 const github=repository(),store=createProductionSnapshotStore({env,token:'SYNTHETIC_ONLY',fetchImpl:github.fetchImpl,now:()=>start+1000}),projection=await store.save(snap());
 github.conflictCheckpoint=true;await assert.rejects(store.recordSelectedDateCheckpoint(live(),projection),{code:'FIXED_STORE_CONFLICT'});assert.equal(github.files.has('map-date-checkpoint-v1.json'),false);
 github.conflictCheckpoint=false;github.failCheckpointReadback=true;await assert.rejects(store.recordSelectedDateCheckpoint(live(),projection),{code:'FIXED_STORE_READ'});
 assert.equal((await store.load()).sha256,projection.sha256);
});
test('corruption, older source observations and superseded snapshot hashes fail closed without rewriting data',async()=>{
 const github=repository();let clock=start+2000;const store=createProductionSnapshotStore({env,token:'SYNTHETIC_ONLY',fetchImpl:github.fetchImpl,now:()=>clock}),projection=await store.save(snap());
 const current=await store.recordSelectedDateCheckpoint(live(new Date(start+1000).toISOString()),projection),puts=github.puts;
 await assert.rejects(store.recordSelectedDateCheckpoint(live(),projection),{code:'SNAPSHOT_DATE_CHECKPOINT_SOURCE_SUPERSEDED'});assert.equal(github.puts,puts);
 const updated=await store.save(snap([{...row(),customerName:'SYNTHETIC UPDATE'}]));await assert.rejects(store.recordSelectedDateCheckpoint(live(),projection),{code:'SNAPSHOT_DATE_CHECKPOINT_SUPERSEDED'});assert.equal(await store.loadSelectedDateCheckpoint(updated),null);
 const envelope=selectedDateCheckpointEnvelope(current);envelope.current.sourceVisitCount++;assert.throws(()=>validateSelectedDateCheckpointEnvelope(envelope),{code:'SNAPSHOT_DATE_CHECKPOINT_INTEGRITY'});
});
