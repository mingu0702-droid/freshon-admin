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
