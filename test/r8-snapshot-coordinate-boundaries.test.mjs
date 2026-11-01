import test from 'node:test';import assert from 'node:assert/strict';
import {snapshotStopCoordinates} from '../src/productionSnapshotStore.js';
test('missing or half coordinates never become zero or mixed coordinate pairs',()=>{
 const old={lat:37.5,lng:127,coordinateSource:'RAW_GPS',addressHash:'a'};
 for(const stop of [{lat:null,lng:null},{lat:'',lng:''},{lat:38},{lng:128}])assert.deepEqual(snapshotStopCoordinates(stop,old),{lat:37.5,lng:127,coordinateSource:'RAW_GPS',coordinateAccuracy:undefined});
 assert.deepEqual(snapshotStopCoordinates({lat:null,lng:null}),{lat:null,lng:null,coordinateSource:'UNRESOLVED',coordinateAccuracy:'UNVERIFIED'});
});
test('an address hash change prevents fallback to the old location',()=>{
 const old={lat:37.5,lng:127,coordinateSource:'MANUAL_PIN',originalAddressHash:'old'};
 const next=snapshotStopCoordinates({lat:null,lng:null,originalAddressHash:'new'},old);assert.equal(next.lat,null);assert.equal(next.coordinateSource,'UNRESOLVED');
 const fresh=snapshotStopCoordinates({lat:38,lng:128,originalAddressHash:'new'},old);assert.equal(fresh.lat,38);assert.equal(fresh.coordinateSource,'DELIVERY_RECORDED');
});
