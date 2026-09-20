import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {mountProductionMapApi} from '../src/productionMapIntegration.js';
import {createStaffPasswordHash} from '../src/mapStaffAuth.js';
import {phase2bSnapshotMeta} from '../src/phase2bOperations.js';
const secret='synthetic-production-read-model-key-00000000';
test('production routes: signed Unicode ingest, Period, staff auth, protected history/detail and public projection',async t=>{
 const env={MAP_STAFF_ID:'abc',MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash('Ab12cd'),MAP_STAFF_SESSION_SECRET:'s'.repeat(43),RENDER_EXTERNAL_URL:'https://production.example.test',HUB_API_SECRET:secret,ADMIN_TOKEN:'test-admin'};
 const snapshot={rows:[{customerCode:'S12345',customerName:'합성점포',address:'합성주소',lat:37,lng:127,password:'SYNTHETIC',rawMemo:'SYNTHETIC'}],latestDate:'2026-09-19'};
 const calls=[],app=express();
 const model=mountProductionMapApi(app,{previewEnabled:()=>true,requireView:(_q,_r,n)=>n(),readPhase2bSnapshot:async()=>snapshot,getSnapshotMemory:()=>snapshot,phase2bKstDate:()=> '2026-09-21',normalizeCell:v=>String(v||'').trim(),normalizeDateValue:v=>v,phase2bSnapshotMeta,phase2bTodayStatus:()=>assert.fail('COLLECTOR_NOT_ALLOWED'),secret,authOptions:{env},
  callHub:async(action,params)=>{calls.push({action,params});if(action==='stageReadModelRequest')return {data:{phase:'RESTORE'}};if(action==='staffCustomerDetail')return{data:{customerCode:'S12345'},meta:{}};throw Error('UNEXPECTED_HUB_READ');}});
 app.get('/api/collector/delivery',(q,r)=>r.sendStatus(q.get('x-admin-token')===env.ADMIN_TOKEN?200:401));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 const get=p=>fetch(base+p),period='/api/map-phase2b/preview/period?startDate=2026-09-19&endDate=2026-09-19';
 assert.equal((await get('/api/map-phase2b/preview/period-status')).status,200);assert.equal((await (await get(period)).json()).meta.ready,false);
 await model.requestPublishedModel();assert.deepEqual(calls.pop(),{action:'stageReadModelRequest',params:{target:'production'}});
 let cookie='';const login=async password=>fetch(base+'/api/map-phase2b/auth/login',{method:'POST',headers:{Origin:env.RENDER_EXTERNAL_URL,'content-type':'application/json'},body:JSON.stringify({id:'abc',password})});
 assert.equal((await login('wrong')).status,401);const ok=await login('Ab12cd');assert.equal(ok.status,200);const h=ok.headers.get('set-cookie');for(const flag of ['HttpOnly','Secure','SameSite=Strict'])assert(h.includes(flag));cookie=h.split(';')[0];
 assert.equal((await get('/api/map-phase2b/private/customer-detail?customerCode=S12345')).status,401);
 const auth=p=>fetch(base+p,{headers:{Cookie:cookie}});
 assert.equal((await auth('/api/collector/delivery')).status,401);assert.equal((await get('/api/collector/delivery')).status,401);
 assert.equal((await fetch(base+'/api/collector/delivery',{headers:{'x-admin-token':env.ADMIN_TOKEN}})).status,200);
 assert.equal((await (await auth('/api/map-phase2b/auth/session')).json()).authenticated,true);
 assert.equal((await auth('/api/map-phase2b/private/driver-history?customerCode=S12345&startDate=2026-09-19&endDate=2026-09-19')).status,503);
 const send=async(message,signed=true)=>{const b={timestamp:String(Date.now()),nonce:crypto.randomUUID().replaceAll('-',''),message},body=JSON.stringify(b);return fetch(base+'/internal/stage-read-model',{method:'POST',headers:{'content-type':'application/json',...(signed?{'x-stage-model-signature':crypto.createHmac('sha256',secret).update(body).digest('hex')}:{})},body});};
 assert.equal((await send({type:'begin',generation:1789933588775},false)).status,401);
 assert.equal((await send({type:'begin',generation:1789933588775})).status,200);const manifest=[];
 for(const kind of ['history','period']){const rows=[kind==='history'?{deliveryDate:'2026-09-19',customerCode:'S12345',deliveryId:'D1',vehicle:'101',driverName:'합성기사',driverPhone:'SYNTHETIC',kind:'ASSIGNED',sourceVersion:'test',updatedAt:'2026-09-19'}:{deliveryDate:'2026-09-19',customerCode:'S12345',vehicle:'101',driverName:'합성기사',driverKey:'driver',driverIdentity:'UNVERIFIED'}];const hash=crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');manifest.push({key:kind+':2026-09-19',hash,count:1});assert.equal((await send({type:'shard',generation:1789933588775,kind,date:'2026-09-19',rows,hash})).status,200);}
 assert.equal(model.status().ready,false);assert.equal((await send({type:'commit',generation:1789933588775,startDate:'2026-06-22',endDate:'2026-09-19',manifest})).status,200);assert.equal(model.status().ready,true);
 const result=await get(period);assert.equal(result.status,200);const value=await result.json();assert.equal(value.meta.storeCount,1);assert.equal(value.meta.generation,1789933588775);assert(!JSON.stringify(value).includes('SYNTHETIC'));
 assert.equal((await get(period+'&vehicle=101')).status,200);assert.equal((await get(period+'&driverKey=driver')).status,200);
 assert.equal((await get('/api/map-phase2b/preview/period?startDate=2026-06-21&endDate=2026-06-21')).status,202);
 const history=await auth('/api/map-phase2b/private/driver-history?customerCode=S12345&startDate=2026-09-19&endDate=2026-09-19');assert.equal(history.status,200);assert.equal((await history.json()).data.length,1);
 assert.equal((await auth('/api/map-phase2b/private/customer-detail?customerCode=S12345')).status,200);
 const publicDetail=await (await get('/api/map-phase2b/preview/detail?customerCode=S12345')).json();assert(!JSON.stringify(publicDetail).includes('SYNTHETIC'));
 const logout=await fetch(base+'/api/map-phase2b/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:env.RENDER_EXTERNAL_URL}});assert.equal(logout.status,200);assert.equal((await auth('/api/map-phase2b/private/customer-detail?customerCode=S12345')).status,401);
 assert(calls.every(c=>['staffCustomerDetail','stageReadModelRequest'].includes(c.action)));
});
test('Production collector, Snapshot worker, ETA and legacy route code remain byte-identical to main',()=>{
 const original=execFileSync('git',['show','2b346cfc7d0341d819369f4b1c35cac3e7aeb4f8:src/server.js'],{encoding:'utf8'}).replaceAll('\r\n','\n');
 const current=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
 for(const [start,end]of [['async function refreshPhase2bSnapshot','function schedulePhase2bSnapshotRefresh'],['app.get("/api/collector/delivery"','app.get("/api/map-phase2b/preview/status"'],['app.get("/api/map-phase2b/preview/route-plan"','app.all("/api/*"']]){const a=original.indexOf(start),b=original.indexOf(end,a);assert(a>=0&&b>a);assert.equal(current.slice(current.indexOf(start),current.indexOf(end,current.indexOf(start))),original.slice(a,b));}
 for(const file of ['src/auth.js','src/store.js','src/hubApiClient.js','src/phase2bOperations.js','src/config.js'])assert.equal(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8').replaceAll('\r\n','\n'),execFileSync('git',['show','2b346cf:'+file],{encoding:'utf8'}).replaceAll('\r\n','\n'));
});
