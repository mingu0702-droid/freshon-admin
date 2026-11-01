import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import {mountProductionOpsmapCandidate} from '../src/productionOpsmapCandidate.js';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';

test('independent QA: integrated Production router isolates phone and revokes access (local synthetic)',async()=>{
 const origin='https://localhost:3000',entries=new Map();
 const store={kind:'SYNTHETIC_DURABLE',get:async(k,fp)=>entries.get(k)?.fp===fp?entries.get(k).value:null,set:async(k,v,fp)=>entries.set(k,{value:v,fp}),touch:async(k,v,fp)=>{if(entries.get(k)?.fp!==fp)return false;entries.set(k,{value:v,fp});return true;},delete:async k=>entries.delete(k)};
 const customerCode='T900001',vehicle='101',date='2026-11-02';
 const name='합성기사',phone=['010','0000','0000'].join('-');
 const env={OPSMAP_PRODUCTION_CANDIDATE_ENABLED:'1',OPSMAP_AUTH_ID:'SYNTHETIC_QA',OPSMAP_AUTH_PASSWORD_HASH:await createStaffPasswordHash('SYNTHETIC_LOCAL_PASSWORD'),OPSMAP_AUTH_SESSION_SECRET:'q'.repeat(43),OPSMAP_AUTH_ORIGIN:origin,RENDER_EXTERNAL_URL:origin};
 const app=express();let masterReads=0;
 mountProductionOpsmapCandidate(app,{env,publicDir:path.resolve('public'),sessionStore:store,sharedBaseCache:{get:async()=>({ok:true,data:[{customerCode,baseVehicle:vehicle,baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:'a'.repeat(64),baseVehicleCheckedAt:'2026-09-24',baseVehicleStale:true}]})},readDriverMaster:async()=>{masterReads++;return {generatedAt:'2026-11-02T00:00:00Z',sheetName:'SYNTHETIC',vehicles:[{vehicle,driverName:name,phone,effectiveDate:date}]};},callHub:async()=>{throw Error('SYNTHETIC_NO_REMOTE_ACCESS');},phase2bKstDate:()=>date,normalizeCell:v=>String(v||''),normalizeDateValue:v=>v,readPhase2bSnapshot:async()=>null,getSnapshotMemory:()=>null,phase2bSnapshotMeta:()=>null});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port+'/opsmap';
 const privatePath='/api/map-phase2b/private/driver-contact?'+new URLSearchParams({customerCode,vehicle,date,context:'BASE'});
 try{
  assert.equal((await fetch(base+privatePath)).status,401);assert.equal(masterReads,0);
  const loggedIn=await fetch(base+'/api/map-phase2b/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({id:env.OPSMAP_AUTH_ID,password:'SYNTHETIC_LOCAL_PASSWORD'})});
  assert.equal(loggedIn.status,200);const cookie=loggedIn.headers.get('set-cookie').split(';')[0];
  const headers={origin,cookie,'sec-fetch-site':'same-origin'};
  const selected=await fetch(base+privatePath,{headers});assert.equal(selected.status,200);assert.match(selected.headers.get('cache-control'),/(?:^|,)\s*no-store(?:,|$)/);assert.match(selected.headers.get('vary'),/Cookie/);
  const contact=await selected.json();assert.deepEqual(contact.data,{driverName:name,phone});assert.equal(contact.meta.customerCode,customerCode);assert.equal(contact.meta.assignmentStale,true);
  const general=await fetch(base+'/api/vehicle-driver-master?date='+date,{headers});assert.equal(general.status,200);assert.equal((await general.json()).vehicles[0].phone,undefined);
  const logout=await fetch(base+'/api/map-phase2b/auth/logout',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{}'});assert.equal(logout.status,200);assert.equal(entries.size,0);
  const reads=masterReads;assert.equal((await fetch(base+privatePath,{headers})).status,401);assert.equal(masterReads,reads);
 }finally{await new Promise(r=>server.close(r));}
});
