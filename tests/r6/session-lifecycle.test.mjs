import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createMapStaffAuth,createStaffPasswordHash,STAFF_IDLE_MS} from '../../src/mapStaffAuth.js';

test('refresh preserves a valid session, expiry never renews it, reconstructed process requires authentication',async()=>{
  let time=Date.now();
  const env={MAP_STAFF_ID:'fixture',MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash('synthetic-password-only'),MAP_STAFF_SESSION_SECRET:'a'.repeat(43),MAP_STAFF_ORIGIN:'https://localhost:3000'};
  async function start(){const app=express();app.use('/auth',createMapStaffAuth({env,now:()=>time}).router);const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});return {server,url:'http://127.0.0.1:'+server.address().port};}
  const first=await start();let second;
  try{
    const login=await fetch(first.url+'/auth/login',{method:'POST',headers:{origin:env.MAP_STAFF_ORIGIN,'content-type':'application/json'},body:JSON.stringify({id:env.MAP_STAFF_ID,password:'synthetic-password-only'})});assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];const headers={cookie,origin:env.MAP_STAFF_ORIGIN};
    const read=async origin=>(await fetch(origin+'/auth/session',{headers})).json();
    const before=await read(first.url);assert.equal(before.authenticated,true);assert.equal(before.policy.persistence,'PROCESS_MEMORY');
    assert.equal((await read(first.url)).authenticated,true);
    second=await start();const restarted=await read(second.url);assert.equal(restarted.authenticated,false);assert.equal(restarted.reason,'SESSION_UNAVAILABLE');
    time+=STAFF_IDLE_MS+1;const expired=await read(first.url);assert.equal(expired.authenticated,false);assert.equal(expired.reason,'SESSION_EXPIRED');assert.equal(expired.expiresAt,null);
  }finally{await Promise.all([first.server,second?.server].filter(Boolean).map(s=>new Promise(resolve=>s.close(resolve))));}
});
