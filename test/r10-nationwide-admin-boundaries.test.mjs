import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import express from 'express';
import {createOfficialAdminBoundaryQuery,validateBoundaryQuery} from '../src/officialAdminBoundaryQuery.js';
import {mountOfficialAdminBoundaries} from '../src/officialAdminBoundaries.js';
import {prepareAdminBoundaries,pointInGeometry} from '../public/opsmap/admin-boundaries.mjs';
const directory=new URL('../integrations/official-boundaries/sgis-adm-20250630-nationwide/',import.meta.url);
const manifest=JSON.parse(await fs.readFile(new URL('manifest.json',directory),'utf8'));

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

test('invalid coordinate payloads and altered source proofs fail closed',async()=>{
 for(const body of [{points:[{lat:37,lng:127,customerCode:'S1'}]},{points:[{lat:NaN,lng:127}]},{points:[{lat:31,lng:127}]},{points:[],geometry:'false'},{points:[],extra:true},{points:Array(15001).fill({lat:37,lng:127})}])assert.throws(()=>validateBoundaryQuery(body),/QUERY_INVALID/);
 await assert.rejects(createOfficialAdminBoundaryQuery({expectedManifestHash:'a'.repeat(64)})([]),/ADMIN_BOUNDARIES_INVALID/);
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
