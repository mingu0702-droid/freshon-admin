import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountProductionMapApi} from '../src/opsmap-abc/productionMapIntegration.js';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';

test('current Customer basic lookup is code-only; dated protected notes retain their date and auth',async()=>{
 const calls=[];
 const env={MAP_STAFF_ID:'fixture',MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash('synthetic-password'),MAP_STAFF_SESSION_SECRET:'a'.repeat(43),MAP_STAFF_ORIGIN:'https://localhost:3000',OPSMAP_PREPARED_DETAILS_ENABLED:'0',OPSMAP_PRIVATE_DETAIL_CACHE_ENABLED:'0',OPSMAP_ROAD_ROUTE_ENABLED:'0'};
 const app=express(),previous=process.env.RENDER_EXTERNAL_URL;delete process.env.RENDER_EXTERNAL_URL;
 try{mountProductionMapApi(app,{previewEnabled:()=>true,requireView:(_q,_r,next)=>next(),readPhase2bSnapshot:async()=>({rows:[]}),getSnapshotMemory:()=>({latestDate:'2026-10-23'}),phase2bKstDate:()=> '2026-10-31',normalizeCell:v=>String(v||'').trim(),normalizeDateValue:v=>String(v||''),phase2bSnapshotMeta:()=>({}),phase2bTodayStatus:async()=>({}),authOptions:{env},callHub:async(action,params,options)=>{calls.push({action,params,privateRead:options.privateRead});return {ok:true,data:{customerCode:params.customerCode,customerName:'SYNTHETIC_ONLY',customerAddress:'서울특별시 가상로 10',detailAddress:'2층',password:'fixture-password'},meta:{}};}});}finally{if(previous===undefined)delete process.env.RENDER_EXTERNAL_URL;else process.env.RENDER_EXTERNAL_URL=previous;}
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),base='http://127.0.0.1:'+server.address().port;
 try{
  const path='/api/map-phase2b/private/customer-detail?customerCode=S970001&date=2026-10-23';
  assert.equal((await fetch(base+path+'&view=store')).status,401);assert.equal(calls.length,0);
  const login=await fetch(base+'/api/map-phase2b/auth/login',{method:'POST',headers:{origin:env.MAP_STAFF_ORIGIN,'content-type':'application/json'},body:JSON.stringify({id:'fixture',password:'synthetic-password'})});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const basic=await fetch(base+path+'&view=store',{headers:{cookie}});assert.equal(basic.status,200);const body=await basic.json();
  assert.deepEqual(calls[0],{action:'customerDetail',params:{customerCode:'S970001'},privateRead:true});assert.equal(body.data.address,'서울특별시 가상로 10');assert.equal(body.data.detailDate,null);assert.equal(body.data.password,undefined);assert.match(basic.headers.get('cache-control'),/no-store/);
  const notes=await fetch(base+path,{headers:{cookie}});assert.equal(notes.status,200);await notes.json();assert.deepEqual(calls[1],{action:'staffCustomerDetail',params:{customerCode:'S970001',date:'2026-10-23'},privateRead:true});
 }finally{await new Promise(resolve=>server.close(resolve));}
});
