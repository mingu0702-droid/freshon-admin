import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
import {createMapStaffAuth,createStaffPasswordHash,STAFF_IDLE_MS} from '../../src/mapStaffAuth.js';
import {createStageStaffSessionStore} from '../../src/staffSessionStore.js';

function github(){let file=null,sha=0,failed=false;const requests=[];return {requests,fail:v=>failed=v,snapshot:()=>file,fetch:async(url,options={})=>{
 requests.push({path:new URL(url).pathname,method:options.method||'GET'});
 if(failed)return new Response('{}',{status:503});
 if(!url.includes('/contents/'))return Response.json({private:true,permissions:{push:true}});
 if(options.method==='PUT'){const b=JSON.parse(options.body);if(b.sha!==(sha?sha.toString(16).padStart(40,'0'):undefined))return Response.json({},{status:409});file=JSON.parse(Buffer.from(b.content,'base64'));sha++;return Response.json({});}
 return file?Response.json({sha:sha.toString(16).padStart(40,'0'),size:JSON.stringify(file).length,encoding:'base64',content:Buffer.from(JSON.stringify(file)).toString('base64')}):Response.json({},{status:404});
 }};}
test('durable signed sessions survive restart; logout, expiry, rotation and store failures deny access',async()=>{
 let time=Date.now();const g=github(),env={OPSMAP_STAGE_VERIFY_ONLY:'1',GITHUB_CACHE_REPO:'mingu0702-droid/freshon-cache',GITHUB_TOKEN:'synthetic-only',OPSMAP_MANUAL_PIN_GITHUB_BRANCH:'stage/opsmap-manual-pins',MAP_STAFF_ID:'fixture',MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash('synthetic-password'),MAP_STAFF_SESSION_SECRET:'a'.repeat(43),MAP_STAFF_ORIGIN:'https://localhost:3000'};
 const servers=[];async function start(){const auth=createMapStaffAuth({env,now:()=>time,sessionStore:createStageStaffSessionStore({env,fetchImpl:g.fetch,now:()=>time})}),app=express();app.use('/auth',auth.router);app.get('/private',auth.requireStaff,(_q,r)=>r.json({ok:true}));const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});servers.push(server);return 'http://127.0.0.1:'+server.address().port;}
 try{
 const a=await start();const login=async url=>{const r=await fetch(url+'/auth/login',{method:'POST',headers:{origin:env.MAP_STAFF_ORIGIN,'content-type':'application/json'},body:JSON.stringify({id:'fixture',password:'synthetic-password'})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
 const cookie=await login(a),headers={cookie,origin:env.MAP_STAFF_ORIGIN};
 const b=await start();assert.equal((await fetch(b+'/private',{headers})).status,200);
 assert.equal((await (await fetch(b+'/auth/session',{headers})).json()).policy.persistence,'PRIVATE_GITHUB_CAS');
 const stored=JSON.stringify(g.snapshot());assert.ok(!stored.includes(cookie.split('=')[1]));assert.ok(!stored.includes(env.MAP_STAFF_ID));assert.ok(!stored.includes(env.MAP_STAFF_PASSWORD_HASH));
 assert.equal((await fetch(b+'/auth/logout',{method:'POST',headers})).status,200);
 assert.equal((await fetch(a+'/private',{headers})).status,401);const c=await start();assert.equal((await fetch(c+'/private',{headers})).status,401);
 const cookie2=await login(c),h2={cookie:cookie2,origin:env.MAP_STAFF_ORIGIN};env.MAP_STAFF_PASSWORD_HASH=await createStaffPasswordHash('changed-synthetic-password');assert.equal((await fetch(c+'/private',{headers:h2})).status,401);
 env.MAP_STAFF_PASSWORD_HASH=await createStaffPasswordHash('synthetic-password');
 const cookie3=await login(c),h3={cookie:cookie3,origin:env.MAP_STAFF_ORIGIN};g.fail(true);assert.equal((await fetch(c+'/private',{headers:h3})).status,503);g.fail(false);
 time+=STAFF_IDLE_MS+1;assert.equal((await fetch(c+'/private',{headers:h3})).status,401);
 assert.ok(g.requests.filter(r=>r.method==='PUT').every(r=>r.path.endsWith('/opsmap-stage/staff-sessions-v1.json')));
 }finally{await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));}
});
