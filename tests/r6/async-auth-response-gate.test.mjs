import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
import {mountMapStaffEntryGate} from '../../src/mapStaffEntryGate.js';
test('async session revocation before final response sends one 401 without recursive checks',async()=>{
 const app=express();let checks=0;
 const requireStaff=async(_q,r,next)=>{await new Promise(resolve=>setTimeout(resolve,5));if(++checks===1)return next();return r.status(401).json({error:'STAFF_LOGIN_REQUIRED'});};
 mountMapStaffEntryGate(app,requireStaff);app.get('/api/map-phase2b/private/fixture',(_q,r)=>r.json({protected:'SYNTHETIC_ONLY'}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/map-phase2b/private/fixture',{signal:AbortSignal.timeout(2000)});assert.equal(r.status,401);assert.deepEqual(await r.json(),{error:'STAFF_LOGIN_REQUIRED'});assert.equal(checks,2);}
 finally{await new Promise(resolve=>server.close(resolve));}
});


test('real staff middleware propagates its async completion to response guard',async()=>{
 const {createMapStaffAuth}=await import('../../src/mapStaffAuth.js');
 const {requireStaff}=createMapStaffAuth({env:{}});let status;
 const req={headers:{},get:()=>undefined};
 const res={locals:{},set:()=>res,status:value=>{status=value;return res;},json:()=>res};
 const pending=requireStaff(req,res,()=>{throw Error('UNAUTHENTICATED_NEXT');});
 assert.equal(typeof pending?.then,'function');await pending;assert.equal(status,401);
});


test('real authentication and response gate deny revoked in-flight data and finish logout',async()=>{
 const {createMapStaffAuth,createStaffPasswordHash}=await import('../../src/mapStaffAuth.js');
 const origin='https://localhost:3000';let saved;
 const store={kind:'SYNTHETIC',get:async()=>saved,set:async(_k,v)=>{saved=v;},touch:async()=>true,delete:async()=>{saved=null;}};
 const auth=createMapStaffAuth({env:{MAP_STAFF_ID:'fixture',MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash('synthetic-password-only'),MAP_STAFF_SESSION_SECRET:'a'.repeat(43),MAP_STAFF_ORIGIN:origin},sessionStore:store});
 const app=express();app.use('/auth',auth.router);mountMapStaffEntryGate(app,auth.requireStaff);
 app.get('/api/map-phase2b/private/fixture',(_q,r)=>{saved=null;r.json({protected:'SYNTHETIC_ONLY'});});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const url='http://127.0.0.1:'+server.address().port;
 try{
 const login=await fetch(url+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({id:'fixture',password:'synthetic-password-only'})});assert.equal(login.status,200);
 const headers={origin,cookie:login.headers.get('set-cookie').split(';')[0]};
 const denied=await fetch(url+'/api/map-phase2b/private/fixture',{headers,signal:AbortSignal.timeout(2000)});assert.equal(denied.status,401);
 const logout=await fetch(url+'/auth/logout',{method:'POST',headers,signal:AbortSignal.timeout(2000)});assert.equal(logout.status,200);assert.equal(saved,null);
 assert.equal((await fetch(url+'/auth/session',{headers})).status,200);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
