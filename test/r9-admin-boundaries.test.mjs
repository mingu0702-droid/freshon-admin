import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {boundaries} from './fixtures/admin-boundaries.mjs';
import {prepareAdminBoundaries,pointInGeometry,matchingAdminFeatures} from '../public/opsmap/admin-boundaries.mjs';
import {buildBaseTerritories,buildTerritories} from '../public/opsmap/territory-policy.mjs';
import {createOfficialAdminBoundaryReader,mountOfficialAdminBoundaries} from '../src/officialAdminBoundaries.js';
const version='a'.repeat(64);
const store=(code='S1',vehicle='101',lat=37.1,lng=127.1)=>({customerCode:code,baseVehicle:vehicle,baseVehicleGroup:'osan',baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:version,baseVehicleStale:false,lat,lng});
const ring=(x,y,size)=>[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]];
const geometry={type:'MultiPolygon',coordinates:[[ring(127,37,.4),ring(127.1,37.1,.1)],[ring(128,37,.1)]]};
test('point-in-polygon preserves island membership and excludes holes and surrounding water',()=>{
 assert.equal(pointInGeometry([127.05,37.05],geometry),true);
 assert.equal(pointInGeometry([127.15,37.15],geometry),false);
 assert.equal(pointInGeometry([128.05,37.05],geometry),true);
 assert.equal(pointInGeometry([127.7,37.05],geometry),false);
 assert.equal(pointInGeometry([127,37.2],geometry),true);
 assert.equal(pointInGeometry([127.1,37.15],geometry),false);
});
test('source CRS, code system, geometry type and finite closed rings fail closed',()=>{
 for(const edit of [d=>d.metadata.crs='EPSG:5179',d=>d.metadata.codeSystem='KAKAO_H_10',d=>d.features[0].properties.adm_cd='1111053000',d=>d.features[0].geometry.type='Point',d=>d.features[0].geometry.coordinates[0].pop(),d=>d.features[0].geometry.coordinates[0][0][0]=NaN]){
  const data=structuredClone(boundaries);edit(data);assert.throws(()=>prepareAdminBoundaries(data),/ADMIN_BOUNDARIES_INVALID/);
  const model=buildBaseTerritories([store()],data);assert.equal(model.groups[0].state,'unconfirmed');assert.equal(model.groups[0].features.length,0);
 }
});
test('verified customer joins are per customer and allow multiple vehicles in one administrative area',()=>{
 const model=buildBaseTerritories([store(),store('S2','122'),{...store('S3','172'),coordinateStatus:'CONFLICT'},{...store('S4','202'),baseVehicleStale:true}],boundaries);
 assert.deepEqual(model.groups.map(g=>[g.vehicle,g.features.length]),[['101',1],['122',1],['172',0]]);
 assert.deepEqual(model.groups[0].joins,[{customerCode:'S1',adminCodes:['11010530']}]);
 assert.deepEqual(model.groups[0].sharedAdminCodes,['11010530']);assert.deepEqual(model.groups[1].sharedAdminCodes,['11010530']);
 assert(model.groups.every(g=>g.boundary.length===0));
});
test('missing geometry and dated facts never produce a surrogate customer hull',()=>{
 const stores=[store(),store('S2','101',37.2,127.1),store('S3','101',37.1,127.2)];
 const model=buildBaseTerritories(stores);assert.equal(model.boundaryReason,'ADMIN_BOUNDARIES_UNAVAILABLE');assert.equal(model.groups[0].boundary.length,0);assert.equal(model.groups[0].state,'unconfirmed');
 const facts=stores.map(r=>({customerCode:r.customerCode,confirmedVehicle:'101',deliveryDate:'2026-11-02',count:1}));
 const dated=buildTerritories(facts,stores,{startDate:'2026-10-24',endDate:'2026-11-02'});assert.equal(dated[0].boundary.length,0);assert.equal(dated[0].state,'unconfirmed');
});
test('islands and hole rings remain untouched through policy joins',()=>{
 const data=structuredClone(boundaries);data.features[0].geometry=geometry;
 const model=buildBaseTerritories([store(),store('S2','101',37.05,128.05)],data);
 assert.equal(model.groups[0].features[0].geometry,geometry);assert.equal(model.groups[0].matchedCount,1); // first point lies on hole edge
 assert.equal(matchingAdminFeatures({lat:37.05,lng:128.05},prepareAdminBoundaries(data)).length,1);
});
test('bundled official subset passes its checksum, source proof, CRS and geometry validation',async()=>{
 const reader=createOfficialAdminBoundaryReader(),data=await reader();assert.equal(await reader(),data);
 assert.equal(data.features.length,43);assert.equal(data.metadata.coverage,'SUBSET');assert.equal(data.metadata.baseDate,'2025-06-30');
 assert(data.features.every(f=>Object.keys(f.properties).sort().join(',')==='adm_cd,adm_nm,base_date'));
 assert.doesNotMatch(JSON.stringify(data),/customerCode|customerName|baseVehicle|masterVersion|snapshotSha256/);
});
test('private read endpoint denies unauthenticated access before reading and rechecks the session before sending',async t=>{
 let reads=0,guards=0;const app=express();const requireStaff=(q,r,n)=>{guards++;if(q.get('x-test-staff')!=='1')return r.status(401).json({error:'STAFF_LOGIN_REQUIRED'});n();};
 mountOfficialAdminBoundaries({app,requireStaff,readBoundaries:async()=>{reads++;return boundaries;}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());const url=`http://127.0.0.1:${server.address().port}/api/map-phase2b/private/admin-boundaries`;
 const denied=await fetch(url);assert.equal(denied.status,401);assert.equal(reads,0);
 const response=await fetch(url,{headers:{'x-test-staff':'1'}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal((await response.json()).data.features.length,1);assert.equal(reads,1);assert.equal(guards,3);
 assert.equal((await fetch(url,{method:'POST'})).status,404);
});
