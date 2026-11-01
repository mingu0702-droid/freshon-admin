import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotStopCoordinates,snapshotProjection} from '../src/productionSnapshotStore.js';
const projected=(lat,lng)=>snapshotProjection({version:'phase2b-map-snapshot-v1',rowCount:1,rows:[{customerCode:'T900001',lastDeliveryDate:'2026-11-02',lat,lng}]}).rows[0];

test('independent QA: whitespace, booleans and container values cannot create zero coordinates',()=>{
 for(const missing of ['  ','\t\n',false,true,[],{},null,undefined]){
  const fresh=snapshotStopCoordinates({lat:missing,lng:missing});
  assert.equal(fresh.lat,null);assert.equal(fresh.lng,null);
  const row=projected(missing,missing);assert.equal(row.lat,null);assert.equal(row.lng,null);
 }
});

test('independent QA: numeric zero and trimmed numeric strings remain legitimate values',()=>{
 for(const [lat,lng] of [[0,0],[' 37.5 ',' 127 ']]){
  const expected={lat:Number(lat),lng:Number(lng)};
  const fresh=snapshotStopCoordinates({lat,lng});assert.equal(fresh.lat,expected.lat);assert.equal(fresh.lng,expected.lng);
  const row=projected(lat,lng);assert.equal(row.lat,expected.lat);assert.equal(row.lng,expected.lng);
 }
 const old={lat:37.5,lng:127,coordinateSource:'RAW_GPS'};
 assert.equal(snapshotStopCoordinates({lat:' ',lng:' '},old).lat,old.lat);
 assert.equal(snapshotStopCoordinates({lat:' ',lng:' '},old).lng,old.lng);
});
