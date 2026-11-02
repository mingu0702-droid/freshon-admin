import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountMapDataFreshness} from '../src/mapDataFreshness.js';
import {phase2bSnapshotMeta} from '../src/phase2bOperations.js';
import {snapshotProjection,materializeSnapshot} from '../src/productionSnapshotStore.js';
import {buildSelectedDateCheckpoint} from '../src/snapshotSelectedDateCheckpoint.js';
import {deliverySourceObservation} from '../src/snapshotRefreshEvidence.js';

test('legacy status failure isolation retains its existing authorization boundary',async t=>{
 const app=express();let calls=0;
 mountMapDataFreshness(app,{requireView:(q,r,n)=>q.get('x-test-authorized')==='yes'?n():r.sendStatus(401),previewEnabled:()=>true,modelStatus:()=>({ready:false}),callHub:async()=>{calls++;throw Object.assign(Error('HUB_INVALID_ACTION'),{upstreamStatus:404,failureType:'upstream'});},env:{},baseStore:null});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}/api/map-phase2b/preview/data-status`;
 assert.equal((await fetch(url)).status,401);assert.equal(calls,0);
 const response=await fetch(url,{headers:{'x-test-authorized':'yes'}}),body=await response.json();
 assert.equal(response.status,200);assert.equal(body.data.partial,true);assert.equal(body.data.automatic,'UNKNOWN');
 assert.equal(body.data.sources[0].errorCode,'HUB_INVALID_ACTION');assert.equal(body.data.sources[0].upstreamStatus,404);
 assert.equal(body.data.publicationConnection.sourceBoundCompletionVerified,false);
});

test('snapshot metadata exposes selected-date storage evidence without declaring historical completion',()=>{
 const date='2026-11-02',time='2026-11-02T00:00:00.000Z';
 const snap=snapshotProjection({version:'phase2b-map-snapshot-v1',rows:[{customerCode:'T900001',vehicle:'101',lastDeliveryDate:date,lat:37.5,lng:127}],sourceFreshness:{targetDate:date,checkedThrough:null,sourceDateVerified:true,sourceReadComplete:true,phase:'CHECKPOINT_UNVERIFIED'}});
 const source={date,generatedAt:time,vehicles:[{vehicle:'101',stops:[{customerCode:'T900001'}]}],sourceObservation:deliverySourceObservation([{deliveryDate:date}],{date,complete:true,pages:1,resolveVehicle:()=> '101'})};
 const checkpoint=buildSelectedDateCheckpoint(source,snap),meta=phase2bSnapshotMeta(materializeSnapshot(snap,{selectedDateCheckpoint:checkpoint}));
 assert.equal(meta.selectedDateCheckpoint.selectedDateStorageVerified,true);
 assert.equal(meta.selectedDateCheckpoint.automaticSyncVerified,false);assert.equal(meta.selectedDateCheckpoint.historicalCompletenessVerified,false);
 assert.equal(meta.refreshedThrough,null);assert.equal(meta.stale,true);assert.equal(meta.sourceVerified,false);
 assert.equal(meta.preservation.version,snap.sha256);
});
