import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
import {createMapStaffAuth,createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';
async function fixture(){
 let clock=Date.now();const entries=new Map(),servers=[];
 const env={MAP_STAFF_ID:'QA_SYNTHETIC',MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash('SYNTHETIC_PASSWORD_ONLY'),MAP_STAFF_SESSION_SECRET:'q'.repeat(43),MAP_STAFF_ORIGIN:'https://localhost:3000',MAP_STAFF_IDLE_HOURS:'24',MAP_STAFF_MAX_HOURS:'168'};
 const store={kind:'SYNTHETIC_DURABLE',get:async(key,fp)=>entries.get(key)?.fp===fp?structuredClone(entries.get(key).session):null,set:async(key,session,fp)=>entries.set(key,{session:structuredClone(session),fp}),touch:async(key,session,fp)=>{if(entries.get(key)?.fp!==fp)return false;entries.set(key,{session:structuredClone(session),fp});return true;},delete:async(key)=>entries.delete(key)};
 async function start(){const app=express(),auth=createMapStaffAuth({env,sessionStore:store,now:()=>clock});app.use('/auth',auth.router);app.get('/protected',auth.requireStaff,(_q,res)=>res.json({ok:true}));const s=app.listen(0,'127.0.0.1');await new Promise(resolve=>s.once('listening',resolve));servers.push(s);return 'http://127.0.0.1:'+s.address().port;}
 const base=await start();const login=await fetch(base+'/auth/login',{method:'POST',headers:{origin:env.MAP_STAFF_ORIGIN,'content-type':'application/json'},body:JSON.stringify({id:env.MAP_STAFF_ID,password:'SYNTHETIC_PASSWORD_ONLY'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],initial=await login.json();
 return {env,initial,base,start,headers:{origin:env.MAP_STAFF_ORIGIN,cookie},advance:ms=>clock+=ms,time:()=>clock,close:()=>Promise.all(servers.map(s=>new Promise(r=>s.close(r))))};
}
test('independent QA: active 7-day session hits absolute expiry and cannot be extended after expiry',async()=>{
 const f=await fixture();try{
  let url=f.base;for(let day=0;day<7;day++){f.advance(23*3600000);const status=await(await fetch(url+'/auth/session',{headers:{...f.headers,'x-map-staff-activity':'1'}})).json();assert.equal(status.authenticated,true);assert.equal(status.expiresAt,f.initial.expiresAt);assert(status.idleExpiresAt<=status.expiresAt);if(day===3)url=await f.start();}
  f.advance(f.initial.expiresAt-f.time());assert.equal((await fetch(url+'/protected',{headers:f.headers})).status,401);const expired=await(await fetch(url+'/auth/session',{headers:{...f.headers,'x-map-staff-activity':'1'}})).json();assert.equal(expired.authenticated,false);const afterRestart=await f.start();assert.equal((await fetch(afterRestart+'/protected',{headers:f.headers})).status,401);
 }finally{await f.close();}
});
test('independent QA: idle background reads do not renew and credential rotation denies old session',async()=>{
 const f=await fixture();try{
  f.advance(23*3600000);assert.equal((await fetch(f.base+'/protected',{headers:f.headers})).status,200);const before=await(await fetch(f.base+'/auth/session',{headers:f.headers})).json();assert.equal(before.idleExpiresAt,f.initial.idleExpiresAt);
  f.env.MAP_STAFF_PASSWORD_HASH=await createStaffPasswordHash('DIFFERENT_SYNTHETIC_PASSWORD_ONLY');assert.equal((await fetch(f.base+'/protected',{headers:f.headers})).status,401);const afterRestart=await f.start();assert.equal((await fetch(afterRestart+'/protected',{headers:f.headers})).status,401);
 }finally{await f.close();}
});
