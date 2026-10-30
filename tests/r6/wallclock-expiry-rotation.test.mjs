import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import crypto from 'node:crypto';
import {createMapStaffAuth,createStaffPasswordHash} from '../../src/mapStaffAuth.js';
import {createStageStaffSessionStore} from '../../src/staffSessionStore.js';

// No clock injection: isolated signed records expire against actual elapsed time.
function remote(){let state=null,sha=0;return {snapshot:()=>state,fetch:async(url,opts={})=>{
 if(!url.includes('/contents/'))return Response.json({private:true,permissions:{push:true}});
 if(opts.method==='PUT'){const b=JSON.parse(opts.body);assert.equal(b.sha,sha?String(sha).padStart(40,'0'):undefined);state=JSON.parse(Buffer.from(b.content,'base64'));sha++;return Response.json({});}
 return state?Response.json({sha:String(sha).padStart(40,'0'),size:JSON.stringify(state).length,encoding:'base64',content:Buffer.from(JSON.stringify(state)).toString('base64')}):Response.json({},{status:404});
}};}
async function setup(){
 const origin='https://localhost:3000',g=remote(),env={OPSMAP_STAGE_VERIFY_ONLY:'1',GITHUB_CACHE_REPO:'mingu0702-droid/freshon-cache',GITHUB_TOKEN:'synthetic-only',OPSMAP_MANUAL_PIN_GITHUB_BRANCH:'stage/opsmap-manual-pins',MAP_STAFF_ID:'fixture',MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash('synthetic-old-password'),MAP_STAFF_SESSION_SECRET:'a'.repeat(43),MAP_STAFF_ORIGIN:origin};
 const servers=[];const store=()=>createStageStaffSessionStore({env,fetchImpl:g.fetch});
 async function start(){const app=express(),auth=createMapStaffAuth({env,sessionStore:store()});app.use('/auth',auth.router);app.get('/private',auth.requireStaff,(_q,r)=>r.json({ok:true}));const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});servers.push(server);return 'http://127.0.0.1:'+server.address().port;}
 async function login(url,password='synthetic-old-password'){const r=await fetch(url+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({id:'fixture',password})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
 return {g,env,store,start,login,headers:cookie=>({origin,cookie}),close:()=>Promise.all(servers.map(s=>new Promise(r=>s.close(r))))};
}
for(const boundary of ['idle','maximum'])test('actual wall-clock '+boundary+' expiry rejects reads, activity and reconstructed process',async()=>{
 const f=await setup();try{const a=await f.start(),cookie=await f.login(a),headers=f.headers(cookie);assert.equal((await fetch(a+'/private',{headers})).status,200);
 const key=crypto.createHmac('sha256',f.env.MAP_STAFF_SESSION_SECRET).update(cookie.split('=')[1]).digest('hex'),fp=f.g.snapshot().credentialFingerprint;
 const deadline=Date.now()+1800;await f.store().set(key,{expiresAt:boundary==='maximum'?deadline:deadline+60000,idleExpiresAt:deadline},fp);
 assert.equal((await fetch(a+'/private',{headers})).status,200);await new Promise(r=>setTimeout(r,1900));assert.ok(Date.now()>=deadline);
 assert.equal((await fetch(a+'/private',{headers})).status,401);const session=await(await fetch(a+'/auth/session',{headers:{...headers,'x-map-staff-activity':'1'}})).json();assert.equal(session.authenticated,false);
 const restarted=await f.start();assert.equal((await fetch(restarted+'/private',{headers})).status,401);
 }finally{await f.close();}
});
test('isolated password change invalidates old cookie before and after process reconstruction',async()=>{
 const f=await setup();try{const a=await f.start(),old=f.headers(await f.login(a));assert.equal((await fetch(a+'/private',{headers:old})).status,200);
 f.env.MAP_STAFF_PASSWORD_HASH=await createStaffPasswordHash('synthetic-new-password');assert.equal((await fetch(a+'/private',{headers:old})).status,401);
 const b=await f.start();assert.equal((await fetch(b+'/private',{headers:old})).status,401);const fresh=f.headers(await f.login(b,'synthetic-new-password'));assert.equal((await fetch(b+'/private',{headers:fresh})).status,200);assert.equal((await fetch(a+'/private',{headers:old})).status,401);
 }finally{await f.close();}
});
