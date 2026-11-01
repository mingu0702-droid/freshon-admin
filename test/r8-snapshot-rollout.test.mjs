import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotStopCoordinates} from '../src/productionSnapshotStore.js';
test('incremental delivery observations preserve an established point without source address-change evidence',()=>{
 const known={lat:37.5,lng:127,coordinateSource:'',coordinateAccuracy:''};
 assert.deepEqual(snapshotStopCoordinates({lat:36,lng:128},known,{preserveObserved:true}),known);
 const moved=snapshotStopCoordinates({lat:36,lng:128,originalAddressHash:'b'.repeat(64)},known,{preserveObserved:true});
 assert.equal(moved.lat,36);
 const unresolved=snapshotStopCoordinates({lat:null,lng:null,originalAddressHash:'b'.repeat(64)},known,{preserveObserved:true});
 assert.equal(unresolved.lat,null);assert.equal(unresolved.coordinateSource,'UNRESOLVED');
});
