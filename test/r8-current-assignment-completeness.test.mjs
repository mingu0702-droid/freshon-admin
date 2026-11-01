import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountProductionMapApi} from '../src/productionMapIntegration.js';
import {createStaffPasswordHash} from '../src/mapStaffAuth.js';
import {deliverySourceObservation} from '../src/snapshotRefreshEvidence.js';
const date='2026-11-02';
const verified=()=>deliverySourceObservation([{enteringDatedAt:date}],{date,pages:1,complete:true,resolveVehicle:()=> '101'});
const live=observation=>({date,generatedAt:'2026-11-02T00:00:00Z',sourceObservation:observation,vehicles:[{vehicle:'101',stops:[{customerCode:'S970001',customerName:'SYNTHETIC_ONLY',lat:37,lng:127}]}]});
const hubPage=()=>({ok:true,data:[{customerCode:'S970002',vehicle:'122',deliveryDate:date,sourceKey:'SYNTHETIC_SOURCE'}],meta:{contract:'dated-assignments-v1',date,totalCount:1,sourceCount:1,pageOffset:0,count:1,pageSize:1000,truncated:false,hasMore:false,complete:true,nextCursor:null}});

test('current assignment HTTP loader accepts only complete date-verified live observations or verified paginated fallback',async t=>{
 const passwordHash=await createStaffPasswordHash('synthetic-test-password');
 const cases=[
  {name:'complete source is accepted directly',observation:verified(),hub:'FORBIDDEN',status:200,source:'Delivery Admin current dispatch',calls:0},
  {name:'partial live source needs a complete paginated fallback',observation:{...verified(),complete:false},hub:'VALID',status:200,source:'Hub datedAssignments pagination',calls:1},
  {name:'missing observation and failed fallback are never cached as complete',observation:undefined,hub:'FAIL',status:502,calls:2,repeat:true},
  {name:'partial live rows and incomplete fallback fail closed',observation:{...verified(),complete:false},hub:'INCOMPLETE',status:502,calls:1},
  {name:'wrong requested date cannot become a complete live result',observation:{...verified(),requestedDate:'2026-11-01'},hub:'FAIL',status:502,calls:1},
  {name:'complete flag without date verification cannot become a complete live result',observation:{...verified(),dateVerified:false},hub:'FAIL',status:502,calls:1}
 ];
 for(const scenario of cases)await t.test(scenario.name,async()=>{
  const env={MAP_STAFF_ID:'fixture',MAP_STAFF_PASSWORD_HASH:passwordHash,MAP_STAFF_SESSION_SECRET:'s'.repeat(43),MAP_STAFF_ORIGIN:'https://localhost:3000',OPSMAP_PRIVATE_DETAIL_CACHE_ENABLED:'0',OPSMAP_ROAD_ROUTE_ENABLED:'0'};
  const calls=[],app=express(),previous=process.env.RENDER_EXTERNAL_URL;delete process.env.RENDER_EXTERNAL_URL;
  try{mountProductionMapApi(app,{previewEnabled:()=>true,requireView:(_req,_res,next)=>next(),readPhase2bSnapshot:async()=>({rows:[]}),getSnapshotMemory:()=>null,phase2bKstDate:()=>date,normalizeCell:v=>String(v||'').trim(),normalizeDateValue:v=>String(v||''),phase2bSnapshotMeta:()=>({stale:true}),phase2bTodayStatus:async()=>live(scenario.observation),authOptions:{env},hybridEnabled:()=>false,callHub:async(action)=>{
   calls.push(action);assert.equal(action,'datedAssignments');
   if(scenario.hub==='VALID')return hubPage();
   if(scenario.hub==='INCOMPLETE'){const page=hubPage();page.meta.complete=false;return page;}
   throw new Error(scenario.hub==='FORBIDDEN'?'UNEXPECTED_HUB_CALL':'SYNTHETIC_SOURCE_UNAVAILABLE');
  }});}finally{if(previous===undefined)delete process.env.RENDER_EXTERNAL_URL;else process.env.RENDER_EXTERNAL_URL=previous;}
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),base='http://127.0.0.1:'+server.address().port;
  try{
   const login=await fetch(base+'/api/map-phase2b/auth/login',{method:'POST',headers:{origin:env.MAP_STAFF_ORIGIN,'content-type':'application/json'},body:JSON.stringify({id:'fixture',password:'synthetic-test-password'})});assert.equal(login.status,200);
   const cookie=login.headers.get('set-cookie').split(';')[0];
   for(let i=0;i<(scenario.repeat?2:1);i++){
    const response=await fetch(base+'/api/map-phase2b/preview/assignments?date='+date,{headers:{cookie}});assert.equal(response.status,scenario.status);const body=await response.json();
    if(scenario.status===200){assert.equal(body.meta.complete,true);assert.equal(body.meta.source,scenario.source);assert.equal(body.data[0].customerCode,scenario.calls?'S970002':'S970001');}
    else{assert.equal(body.ok,false);assert.equal(body.data,null);}
   }
   assert.equal(calls.length,scenario.calls);
  }finally{await new Promise(resolve=>server.close(resolve));}
 });
});
