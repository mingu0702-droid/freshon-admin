import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import express from 'express';
import {createOfficialAdminBoundaryQuery,validateBoundaryQuery} from '../src/officialAdminBoundaryQuery.js';
import {mountOfficialAdminBoundaries} from '../src/officialAdminBoundaries.js';
import {prepareAdminBoundaries,pointInGeometry,matchingAdminFeatures} from '../public/opsmap/admin-boundaries.mjs';
import {buildBaseTerritories} from '../public/opsmap/territory-policy.mjs';
import {boundaries} from './fixtures/admin-boundaries.mjs';
const directory=new URL('../integrations/official-boundaries/sgis-adm-20250630-nationwide/',import.meta.url);
const manifest=JSON.parse(await fs.readFile(new URL('manifest.json',directory),'utf8'));
const overviewDirectory=new URL('../integrations/official-boundaries/sgis-adm-20250630-overview/',import.meta.url);

test('all 3559 official source records and every regional checksum validate with original islands and holes',async()=>{
 assert.equal(manifest.featureCount,3559);assert.equal(manifest.shards.length,286);
 assert.deepEqual(manifest.verification,{dbfRecords:3559,shxRecords:3559,shpRecords:3559,polygonCount:17214,ringCount:17221,holeCount:7,vertexCount:8421798,allSourceRecordsConverted:true,originalRingTopologyRetained:true});
 assert.deepEqual(manifest.sourceFiles.map(f=>f.name.split('.').at(-1)),['shp','shx','dbf','prj','cpg']);
 const codes=new Set();let holes=0,vertices=0;
 for(const proof of manifest.shards){
  const bytes=await fs.readFile(new URL(proof.file,directory));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),proof.sha256);
  assert.equal(bytes.length,proof.gzipBytes);const raw=gunzipSync(bytes);assert.equal(raw.length,proof.jsonBytes);
  const prepared=prepareAdminBoundaries(JSON.parse(raw));assert.equal(prepared.features.length,proof.featureCount);
  for(const {feature,code} of prepared.features){assert(!codes.has(code));codes.add(code);assert.equal(feature.properties.base_date,'2025-06-30');const parts=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.coordinates;for(const rings of parts){holes+=rings.length-1;for(const ring of rings)vertices+=ring.length;}}
 }
 assert.equal(codes.size,3559);assert.equal(holes,7);assert.equal(vertices,8421798);
});

test('indexed reads are lazy, cross-region count queries do not return geometry, and sea has no invented boundary',async()=>{
 const reads=[];const query=createOfficialAdminBoundaryQuery({readFile:async(...args)=>{reads.push(args[0]);return fs.readFile(...args);}});
 assert.equal(reads.length,0);
 const points=[{lat:37.5665,lng:126.978},{lat:35.1796,lng:129.0756},{lat:33.4996,lng:126.5312},{lat:35,lng:124.1}];
 const data=await query(points,{geometry:false});assert.equal(data.metadata.sourceCoverage,'NATIONWIDE');assert.equal(data.metadata.partialCoverage,false);assert.equal(data.metadata.sourceFeatureCount,3559);assert.equal(data.metadata.matchedPointCount,3);assert.equal(data.features.length,0);assert.deepEqual(data.matches.map(m=>m.adminCodes),[['11020550'],['21130590'],['39010540'],[]]);assert(reads.length<10);
 const regional=await query(points.slice(0,1));assert.equal(regional.features.length,1);assert(pointInGeometry([points[0].lng,points[0].lat],regional.features[0].geometry));
 assert.equal((await query([])).features.length,0);
});

test('geometry response limit explicitly rejects a wide query while count queries still complete',async()=>{
 const query=createOfficialAdminBoundaryQuery({maxGeometryBytes:1});
 await assert.rejects(query([{lat:37.5665,lng:126.978}]),error=>error.status===413&&error.message==='ADMIN_BOUNDARIES_QUERY_TOO_WIDE');
 assert.equal((await query([{lat:37.5665,lng:126.978}],{geometry:false})).metadata.matchedPointCount,1);
});

test('identical in-flight count queries share work and only distinct jobs consume queue slots',async()=>{
 const query=createOfficialAdminBoundaryQuery(),options={geometry:false,detail:'detail'};
 const seoul={lat:37.5665,lng:126.978},busan={lat:35.1796,lng:129.0756};
 const points=[seoul,busan],first=query(points,options);
 const orderedDifferently=query([busan,seoul],options);
 const otherDetail=query(points,{geometry:false,detail:'overview'});
 assert.notEqual(first,orderedDifferently);assert.notEqual(first,otherDetail);
 const duplicates=Array.from({length:3},()=>query(points.map(({lat,lng})=>({lng,lat})),options));
 assert(duplicates.every(pending=>pending===first));
 await assert.rejects(query([seoul],options),{status:503,message:'ADMIN_BOUNDARIES_BUSY'});
 await assert.rejects(query(points,{geometry:true}),{status:503,message:'ADMIN_BOUNDARIES_BUSY'});
 const [joined,reordered]=await Promise.all([first,orderedDifferently,otherDetail,...duplicates]);
 assert.deepEqual(joined.matches.map(m=>m.adminCodes),[['11020550'],['21130590']]);
 assert.deepEqual(reordered.matches.map(m=>m.adminCodes),[['21130590'],['11020550']]);
 const next=query(points,options);assert.notEqual(next,first);assert.deepEqual(await next,joined);
});

test('failed shared count queries release their key for retry',async()=>{
 let fail=true;
 const query=createOfficialAdminBoundaryQuery({readFile:async(...args)=>{
  if(fail){fail=false;throw Error('LOCAL_READ_FAILURE');}
  return fs.readFile(...args);
 }});
 const points=[{lat:37.5665,lng:126.978}],options={geometry:false};
 const failed=query(points,options);assert.equal(query(points,options),failed);
 await assert.rejects(failed,/LOCAL_READ_FAILURE/);
 const retry=query(points,options);assert.notEqual(retry,failed);
 assert.equal((await retry).metadata.matchedPointCount,1);
});

test('a complex coastal feature keeps exact joins, names and every original polygon',async()=>{
 const entry=manifest.entries.find(e=>e.code==='36670360');
 const [feature]=JSON.parse(gunzipSync(await fs.readFile(new URL(entry.shard,directory)))).features;
 const [lng,lat]=feature.geometry.coordinates[0][0][0],points=[{lat,lng}];
 const query=createOfficialAdminBoundaryQuery();
 const joined=await query(points,{geometry:false});
 assert.deepEqual(joined.matches,[{index:0,adminCodes:[entry.code]}]);
 assert.deepEqual(joined.features,[]);
 const detail=await query(points);
 assert.deepEqual(detail.matches,joined.matches);
 assert.deepEqual(detail.features,[feature]);
 const overviewSource=JSON.parse(gunzipSync(await fs.readFile(new URL(entry.shard,overviewDirectory))));
 const overview=await query(points,{detail:'overview'});
 assert.deepEqual(overview.matches,joined.matches);
 assert.deepEqual(overview.features,overviewSource.features);
});

test('invalid coordinate payloads and altered source proofs fail closed',async()=>{
 for(const body of [{points:[{lat:37,lng:127,customerCode:'S1'}]},{points:[{lat:NaN,lng:127}]},{points:[{lat:31,lng:127}]},{points:[],geometry:'false'},{points:[],detail:'hull'},{points:[],extra:true},{points:Array(15001).fill({lat:37,lng:127})}])assert.throws(()=>validateBoundaryQuery(body),/QUERY_INVALID/);
 await assert.rejects(createOfficialAdminBoundaryQuery({expectedManifestHash:'a'.repeat(64)})([]),/ADMIN_BOUNDARIES_INVALID/);
});

test('display-only overview preserves every original polygon, island and hole without introducing triangular rings',async()=>{
 const overview=JSON.parse(await fs.readFile(new URL('manifest.json',overviewDirectory),'utf8'));
 assert.equal(overview.sourceManifestSha256,'36e2325be7867461450314b0f3071e11f3e67dce556879b5d5846fa7649a6e2a');assert.equal(overview.featureCount,3559);assert.equal(overview.toleranceMeters,75);assert.equal(overview.metadata.geometryRole,'DISPLAY_ONLY');
 let polygons=0,holes=0,vertices=0,count=0;
 for(const proof of overview.shards){
  const bytes=await fs.readFile(new URL(proof.file,overviewDirectory));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),proof.sha256);assert.equal(bytes.length,proof.gzipBytes);const raw=gunzipSync(bytes);assert.equal(raw.length,proof.jsonBytes);
  const reduced=JSON.parse(raw),full=JSON.parse(gunzipSync(await fs.readFile(new URL(proof.file,directory))));prepareAdminBoundaries(reduced);const byCode=new Map(full.features.map(f=>[f.properties.adm_cd,f]));
  for(const f of reduced.features){count++;const source=byCode.get(f.properties.adm_cd);assert(source);assert.equal(f.geometry.type,source.geometry.type);const old=source.geometry.type==='Polygon'?[source.geometry.coordinates]:source.geometry.coordinates,next=f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates;assert.equal(next.length,old.length);polygons+=next.length;
   for(let i=0;i<next.length;i++){assert.equal(next[i].length,old[i].length);holes+=next[i].length-1;for(let j=0;j<next[i].length;j++){const ring=next[i][j];assert(ring.length>=4);assert(!(ring.length<5&&old[i][j].length>=5));vertices+=ring.length;}}
  }
 }
 assert.equal(count,3559);assert.equal(polygons,17214);assert.equal(holes,7);assert.equal(vertices,overview.verification.vertexCount);assert(vertices<manifest.verification.vertexCount);assert.equal(overview.verification.noIntroducedTriangleRings,true);
});

test('overview reuses full-resolution point matches and never determines membership from display geometry',async()=>{
 const reads=[],query=createOfficialAdminBoundaryQuery({readFile:async(...args)=>{reads.push(args[0]);return fs.readFile(...args);}}),points=[{lat:37.5665,lng:126.978},{lat:35.1796,lng:129.0756}];
 const exact=await query(points,{geometry:false}),at=reads.length,overview=await query(points,{detail:'overview'});assert.deepEqual(overview.matches,exact.matches);assert.equal(overview.metadata.geometryRole,'DISPLAY_ONLY');assert.equal(overview.metadata.pointJoinGeometry,'FULL_RESOLUTION');assert(reads.slice(at).every(name=>name.includes('sgis-adm-20250630-overview')));assert.equal(overview.features.length,2);const prepared=prepareAdminBoundaries(overview);assert(points.every(p=>matchingAdminFeatures(p,prepared).length===1));
 const display=structuredClone(boundaries),p={lat:37.1,lng:127.1};display.metadata={...display.metadata,coverage:'QUERY',geometryRole:'DISPLAY_ONLY',pointJoinGeometry:'FULL_RESOLUTION'};display.queryPoints=[p];display.matches=[{index:0,adminCodes:[display.features[0].properties.adm_cd]}];display.features[0].geometry.coordinates[0]=display.features[0].geometry.coordinates[0].map(([lng,lat])=>[lng+.2,lat]);
 assert.equal(pointInGeometry([p.lng,p.lat],display.features[0].geometry),false);assert.equal(matchingAdminFeatures(p,prepareAdminBoundaries(display)).length,1);assert.equal(matchingAdminFeatures({lat:37.3,lng:127.3},prepareAdminBoundaries(display)).length,0);
 const model=buildBaseTerritories([{...p,customerCode:'S1',baseVehicle:'101',baseVehicleGroup:'osan',baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:'a'.repeat(64),baseVehicleStale:false}],display);assert.equal(model.groups[0].state,'ready');assert.equal(model.groups[0].matchedCount,1);
 delete display.matches;assert.throws(()=>prepareAdminBoundaries(display),/ADMIN_BOUNDARIES_INVALID/);
 await assert.rejects(createOfficialAdminBoundaryQuery({expectedOverviewHash:'a'.repeat(64)})(points,{detail:'overview'}),/ADMIN_BOUNDARIES_INVALID/);
});

test('private POST checks authentication and origin before query, limits input, and rechecks the session',async t=>{
 const app=express();let queries=0,guards=0;
 const guard=(q,r,n)=>{guards++;if(q.get('x-test-staff')!=='1')return r.status(401).json({error:'STAFF_LOGIN_REQUIRED'});n();};
 mountOfficialAdminBoundaries({app,requireStaff:guard,origin:'https://maps.example',queryBoundaries:async(points,options)=>{queries++;return {points,options};}});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>server.close());const url=`http://127.0.0.1:${server.address().port}/api/map-phase2b/private/admin-boundaries/query`;
 const request=(body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await request({points:[]})).status,401);assert.equal(queries,0);
 assert.equal((await request({points:[]},{'x-test-staff':'1',origin:'https://evil.example'})).status,403);assert.equal(queries,0);
 const headers={'x-test-staff':'1',origin:'https://maps.example','sec-fetch-site':'same-origin'};
 assert.equal((await request({points:[],extra:true},headers)).status,400);assert.equal(queries,0);
 const response=await request({points:[{lat:37,lng:127}],geometry:false},headers);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal((await response.json()).data.options.geometry,false);assert.equal(queries,1);assert.equal(guards,5);
 assert.equal((await request({points:[],extra:'a'.repeat(1024*1024)},headers)).status,413);assert.equal(queries,1);
});
