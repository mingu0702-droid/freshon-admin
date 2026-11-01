import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
import {createMapStaffAuth,createStaffPasswordHash,staffSessionPolicy} from '../src/opsmap-abc/mapStaffAuth.js';
test('longer Production lease remains bounded; legacy defaults and invalid settings stay safe',()=>{
 assert.deepEqual(staffSessionPolicy(),{idleMs:8*3600000,maxMs:12*3600000});
 assert.deepEqual(staffSessionPolicy({MAP_STAFF_IDLE_HOURS:'24',MAP_STAFF_MAX_HOURS:'168'}),{idleMs:24*3600000,maxMs:168*3600000});
 for(const env of [{MAP_STAFF_IDLE_HOURS:'0'},{MAP_STAFF_IDLE_HOURS:'24'},{MAP_STAFF_MAX_HOURS:'169'},{MAP_STAFF_MAX_HOURS:'Infinity'},{MAP_STAFF_IDLE_HOURS:'2.5'}])assert.throws(()=>staffSessionPolicy(env),/POLICY_INVALID/);
});
test('longer authenticated lease survives reconstruction but idle expiry and logout never resurrect it',async()=>{
 let time=Date.now();const records=new Map(),servers=[],origin='https://localhost:3000';
 const env={MAP_STAFF_ID:'synthetic',MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash('synthetic-password'),MAP_STAFF_SESSION_SECRET:'s'.repeat(43),MAP_STAFF_ORIGIN:origin,MAP_STAFF_IDLE_HOURS:'24',MAP_STAFF_MAX_HOURS:'168'};
 const store={kind:'SYNTHETIC_DURABLE',get:async(k,fp)=>records.get(k)?.fp===fp?records.get(k).session:null,set:async(k,session,fp)=>records.set(k,{session,fp}),touch:async(k,session,fp)=>{if(records.get(k)?.fp!==fp)return false;records.set(k,{session,fp});return true;},delete:async k=>records.delete(k)};
 const start=async()=>{const auth=createMapStaffAuth({env,now:()=>time,sessionStore:store}),app=express();app.use('/auth',auth.router);app.get('/protected',auth.requireStaff,(_q,r)=>r.json({ok:true}));const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));servers.push(s);return 'http://127.0.0.1:'+s.address().port;};
 try{const a=await start();const r=await fetch(a+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({id:'synthetic',password:'synthetic-password'})});assert.equal(r.status,200);const cookie=r.headers.get('set-cookie'),session=await r.json();assert.match(cookie,/Max-Age=604800/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.equal(session.expiresAt-time,168*3600000);assert.equal(session.idleExpiresAt-time,24*3600000);
 const headers={origin,cookie:cookie.split(';')[0]};time+=13*3600000;const b=await start();assert.equal((await fetch(b+'/protected',{headers})).status,200);
 const touched=await(await fetch(b+'/auth/session',{headers:{...headers,'x-map-staff-activity':'1'}})).json();assert.equal(touched.authenticated,true);assert.equal(touched.idleExpiresAt,time+24*3600000);assert.equal(touched.expiresAt,session.expiresAt);
 time+=24*3600000+1;const expired=await(await fetch(b+'/auth/session',{headers:{...headers,'x-map-staff-activity':'1'}})).json();assert.equal(expired.authenticated,false);assert.equal((await fetch(b+'/protected',{headers})).status,401);
 await fetch(b+'/auth/logout',{method:'POST',headers});assert.equal(records.size,0);const c=await start();assert.equal((await fetch(c+'/protected',{headers})).status,401);
 }finally{await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));}
});
