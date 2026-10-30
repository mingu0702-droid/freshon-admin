import test from 'node:test';
import assert from 'node:assert/strict';
import * as original from '../src/phase2bAssignments.js';
import * as abc from '../src/opsmap-abc/phase2bAssignments.js';
const date='2026-11-01',bounds={south:33,north:39,west:124,east:132};
function page(offset,version='42690'){
 const more=offset===0;
 return {ok:true,data:[{sourceKey:'r'+offset,customerCode:'S97000'+offset,deliveryDate:date,vehicle:offset?'':'101',lat:null,lng:null}],meta:{contract:'dated-assignments-v1',date,totalCount:2,sourceCount:2,pageOffset:offset,count:1,pageSize:1,hasMore:more,nextCursor:more?'1':null,complete:!more,truncated:false,sourceVersion:version}};
}
for(const [label,reader] of [['legacy',original],['abc',abc]]){
 test(label+' pages reject version mixing even when row counts and cursors agree',async()=>{
  await assert.rejects(reader.readPaginatedDatedAssignments(date,async({cursor})=>page(cursor?1:0,cursor?'42691':'42690'),{pageSize:1}),/SOURCE_VERSION_CHANGED/);
  await assert.rejects(reader.readPaginatedDatedAssignments(date,async({cursor})=>{const p=page(cursor?1:0);if(!cursor)delete p.meta.sourceVersion;return p;},{pageSize:1}),/SOURCE_VERSION_CHANGED/);
  await assert.rejects(reader.readPaginatedDatedAssignments(date,async()=>page(0,42690),{pageSize:1}),/SOURCE_IDENTITY_INVALID/);
 });
 test(label+' future scheduled dates and unassigned unlocated customers remain explicit, not invented current data',async()=>{
  const r=await reader.readPaginatedDatedAssignments(date,async({cursor})=>page(cursor?1:0),{pageSize:1});
  assert.equal(r.data.length,2);assert.equal(r.meta.date,date);assert.equal(r.meta.missingCoordinate,2);assert.equal(r.data[1].vehicle,'');assert.equal(r.meta.sourceIdentity.sourceVersion,'42690');
  const unknown=reader.uniqueAssignments([{customerCode:'S970002',deliveryDate:date,lat:null,lng:null,baseVehicle:'202'}],date);assert.equal(unknown.length,1);assert.equal(unknown[0].vehicle,'');assert.equal(unknown[0].lat,null);
 });
 test(label+' explicit partial tiles cannot become complete because geographic result is small',async()=>{
  for(const meta of [{hasMore:true},{truncated:true},{partial:true},{complete:false},{returnedCount:2},{date:'2026-10-31'}])await assert.rejects(reader.readDatedAssignments(date,bounds,async()=>({ok:true,data:[],meta})),/TRUNCATED|COUNT_MISMATCH|DATE_MISMATCH/);
 });
 test(label+' recursive tile reads share one source version and retain duplicate counts in pagination',async()=>{
  let n=0;await assert.rejects(reader.readDatedAssignments(date,bounds,async()=>++n===1?{ok:true,data:Array(2000).fill({customerCode:'CAP',vehicle:'101'}),meta:{sourceVersion:'42690'}}:{ok:true,data:[],meta:{sourceVersion:'42691'}}),/SOURCE_VERSION_CHANGED/);
  const r=await reader.readPaginatedDatedAssignments(date,async({cursor})=>{const p=page(cursor?1:0);p.data[0].customerCode='S970001';p.data[0].vehicle='101';return p;},{pageSize:1});assert.equal(r.meta.rawCount,2);assert.equal(r.meta.rowCount,1);assert.equal(r.meta.duplicateCount,1);
 });
}
