import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import path from'node:path';import crypto from'node:crypto';import http from'node:http';import vm from'node:vm';import express from'express';
import{createManualMapPins,manualPinRenderMountVerified}from'../src/manualMapPins.js';import{createMapStaffAuth,createStaffPasswordHash}from'../src/mapStaffAuth.js';import{coordinateAddressHash}from'../src/opsmapAutoCoordinates.js';import{createMemoryCoordinateStore}from'../src/opsmapCoordinateIngestion.js';import{addressRegion,dispatchCenter}from'../public/map-location-contract.mjs';
const root=path.join(process.env.LOCALAPPDATA||process.cwd(),'OpsmapPrivate','manual-pin-test-'+crypto.randomUUID());await fs.mkdir(root,{recursive:true});
const address='서울특별시 가상로 10',source={customerCode:'S970003',customerName:'합성 매장',address,detailAddress:'2층',sourceDriveVersion:'1',addressRegion:'수도권'};
const options=()=>({env:{MAP_STAFF_ID:'synthetic-only',MAP_STAFF_SESSION_SECRET:'x'.repeat(43),MAP_STAFF_ORIGIN:'https://localhost:3000',OPSMAP_MANUAL_PIN_WRITER_ID:'synthetic-only',OPSMAP_MANUAL_PIN_WRITES:'1',OPSMAP_MANUAL_PIN_DURABLE_CONFIRMED:'1',OPSMAP_MANUAL_PIN_STORE_FILE:path.join(root,crypto.randomUUID()+'.json')},appRoot:path.resolve('src'),authorizeWrite:()=>true,readCustomer:async code=>code===source.customerCode?{...source}:null,readCoordinate:()=>({latitude:null,longitude:null,coordinateSource:'UNCONFIRMED'})});
const body=(revision=0,extra={})=>({originalAddressHash:coordinateAddressHash(source.address),expectedRevision:revision,requestId:crypto.randomUUID(),latitude:37.5,longitude:127,...extra});
test('Render file writes require a real durable mount rather than a confirmation flag',async()=>{
 const config=options();config.env.RENDER='true';config.env.RENDER_SERVICE_ID='stage-test';
 const service=createManualMapPins(config);assert.equal(service.canWrite(),false);await assert.rejects(service.mutate(source.customerCode,'save',body()),e=>e.code==='MANUAL_PIN_WRITE_PERMISSION_REQUIRED');
 const mount=path.join(root,'mounted'),file=path.join(mount,'pins.json'),env={RENDER:'true',OPSMAP_MANUAL_PIN_DURABLE_ROOT:mount,OPSMAP_MANUAL_PIN_STORE_FILE:file},identity=p=>p;
 const line=kind=>'40 30 8:1 / '+mount+' rw - '+kind+' /dev/sdb rw';
 assert.equal(manualPinRenderMountVerified(env,()=>line('ext4'),identity),true);
 assert.equal(manualPinRenderMountVerified(env,()=>line('overlay'),identity),false);
 assert.equal(manualPinRenderMountVerified(env,()=>line('tmpfs'),identity),false);
 assert.equal(manualPinRenderMountVerified({...env,OPSMAP_MANUAL_PIN_STORE_FILE:path.join(root,'outside.json')},()=>line('ext4'),identity),false);
 assert.equal(manualPinRenderMountVerified(env,()=>{throw Error('unavailable');},identity),false);
});
test('center source remains independent of address region and freshness',()=>{
 assert.equal(addressRegion('인천광역시 검단구 가상로 10'),'수도권');assert.equal(addressRegion('전북특별자치도 전주시 가상로 10'),'호남권');assert.equal(addressRegion('강원특별자치도 원주시 가상로 10'),'강원권');
 const row={baseVehicleGroup:'osan',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleState:'VERIFIED_MASTER',baseVehicleVersion:'a'.repeat(64),baseVehicleCheckedAt:'2026-09-24',baseVehicleStale:true};
 assert.equal(dispatchCenter(row).state,'PREVIOUS_VERIFIED');assert.equal(dispatchCenter({...row,baseVehicleStale:false}).state,'LATEST_VERIFIED');assert.equal(dispatchCenter({...row,baseVehicleSource:'DAILY_CONFIRMED'}).state,'UNCONFIRMED');assert.equal(addressRegion('제주특별자치도 제주시 가상로 10'),'제주권');
});
test('default write permission is closed and no Customer/source write exists',async()=>{
 const config=options();delete config.env.OPSMAP_MANUAL_PIN_WRITES;const service=createManualMapPins(config);assert.equal(service.canWrite(),false);await assert.rejects(service.mutate(source.customerCode,'save',body()),e=>e.code==='MANUAL_PIN_WRITE_PERMISSION_REQUIRED');assert.equal((await service.projection()).length,0);
});
test('atomic file save, duplicate delivery, restart, re-edit, undo and history',async()=>{
 const config=options(),service=createManualMapPins(config),input=body();const saved=await service.mutate(source.customerCode,'save',input);assert.equal(saved.revision,1);assert.equal(saved.current.coordinateSource,'MANUAL_PIN');assert.equal(saved.current.originalAddress,undefined);assert.equal(saved.current.modifiedBy.type,'SHARED_STAFF_ACCOUNT');
 assert.equal((await service.mutate(source.customerCode,'save',input)).idempotent,true);assert((await fs.stat(config.env.OPSMAP_MANUAL_PIN_STORE_FILE+'.backup.json')).size>0);
 const reopened=createManualMapPins(config);assert.equal((await reopened.projection())[0].resolutionStatus,'MANUAL_CONFIRMED');
 await reopened.mutate(source.customerCode,'save',body(1,{latitude:37.51,correctedSearchAddress:'서울특별시 가상로 12'}));await assert.rejects(reopened.mutate(source.customerCode,'save',body(1)),e=>e.code==='MANUAL_PIN_REVISION_CONFLICT');
 const undone=await reopened.mutate(source.customerCode,'revert',body(2,{targetRevision:0}));assert.equal(undone.current,null);assert.equal((await reopened.projection()).length,0);
 const restored=await reopened.mutate(source.customerCode,'revert',body(3,{targetRevision:1}));assert.equal(restored.current.latitude,37.5);const detail=await reopened.selected(source.customerCode);assert.equal(detail.history.length,4);assert.equal(detail.history.at(-1).previousCoordinate.latitude,null);assert.equal(source.address,address);
});
test('changed address is held and stale manual writes cannot resolve the warning',async()=>{
 const config=options(),row={...source};config.readCustomer=async()=>({...row});const service=createManualMapPins(config);await service.mutate(row.customerCode,'save',body());row.address='서울특별시 가상로 11';
 const projected=await service.projection();assert.equal(projected[0].resolutionStatus,'ADDRESS_CHANGED_REVIEW_REQUIRED');assert.equal(projected[0].latitude,null);await assert.rejects(service.mutate(row.customerCode,'save',body(1)),e=>e.code==='MANUAL_PIN_ADDRESS_CHANGED');
 const detail=await service.selected(row.customerCode);assert(detail.addressChanged);assert.equal(detail.current.originalAddressHash,coordinateAddressHash(address));
});
test('backup failure and revoked session preserve previous normal store',async()=>{
 const store=createMemoryCoordinateStore(),config={...options(),store,backupStore:{transaction:async()=>{throw Error('simulated unavailable disk');}}},service=createManualMapPins(config);
 await assert.rejects(service.mutate(source.customerCode,'save',body()));assert.equal(store.snapshot().manualPins,undefined);
 config.backupStore=createMemoryCoordinateStore();const revoked=createManualMapPins(config);await assert.rejects(revoked.mutate(source.customerCode,'save',body(),{assertSession:()=>{throw Error('expired');}}));assert.equal(store.snapshot().manualPins,undefined);
});
test('audit tamper is rejected and coordinate edits do not affect another customer',async()=>{
 const config=options(),service=createManualMapPins(config);await service.mutate(source.customerCode,'save',body());const file=config.env.OPSMAP_MANUAL_PIN_STORE_FILE,state=JSON.parse(await fs.readFile(file));assert.deepEqual(Object.keys(state.manualPins.customers),[source.customerCode]);state.manualPins.customers[source.customerCode].current.latitude=38;await fs.writeFile(file,JSON.stringify(state));await assert.rejects(service.projection(),e=>e.code==='MANUAL_PIN_AUDIT_INVALID');
});
test('real browser overlay keeps manual priority across new snapshots and isolates other stores',async()=>{
 const source=await fs.readFile(new URL('../public/manual-map-pins.mjs',import.meta.url),'utf8'),text=source.slice(source.indexOf('function apply(row){'),source.indexOf('\nasync function refresh()'));
 const records=new Map([['S970003',{resolutionStatus:'MANUAL_CONFIRMED',latitude:37.55,longitude:127.1}]]),apply=vm.runInNewContext('('+text+')',{records,bases:new WeakMap(),ORIGINAL_PIN_BASE:Symbol('opsmap-original-pin-base')});
 const automatic={customerCode:'S970003',lat:37.1,lng:127.2,coordinateSource:'RAW_GPS'},neighbor={customerCode:'S970004',lat:36.1,lng:128.1,coordinateSource:'RAW_GPS'};apply(automatic);assert.equal(automatic.lat,37.55);assert.equal(automatic.coordinateSource,'MANUAL_PIN');
 const refreshed={customerCode:'S970003',lat:37.2,lng:127.3,coordinateSource:'KAKAO_VERIFIED_BUILDING'};apply(refreshed);assert.equal(refreshed.lat,37.55);apply(neighbor);assert.equal(neighbor.lat,36.1);assert.equal(neighbor.coordinateSource,'RAW_GPS');
 records.clear();apply(refreshed);assert.equal(refreshed.lat,37.2);assert.equal(refreshed.coordinateSource,'KAKAO_VERIFIED_BUILDING');
 records.set('S970003',{resolutionStatus:'ADDRESS_CHANGED_REVIEW_REQUIRED'});apply(refreshed);assert.equal(refreshed.lat,null);assert.equal(refreshed.coordinateStatus,'CONFLICT');
});
test('HTTP staff session, explicit permission, CSRF, expiry and search budget are enforced',async()=>{
 const config=options();config.env.RENDER_EXTERNAL_URL='https://localhost:3000';config.env.MAP_STAFF_PASSWORD_HASH=await createStaffPasswordHash('synthetic-test-only');let clock=Date.now();const auth=createMapStaffAuth({env:config.env,now:()=>clock}),service=createManualMapPins(config),app=express();app.use('/api/map-phase2b/auth',auth.router);service.mount({app,requireStaff:auth.requireStaff,isSessionCurrent:auth.isSessionCurrent});const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let cookie='';const request=async(url,{method='GET',body:payload,origin='https://localhost:3000',csrf}={})=>{const response=await fetch('http://127.0.0.1:'+server.address().port+url,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(payload?{'content-type':'application/json'}:{}),...(csrf?{'x-map-pin-csrf':csrf}:{})},body:payload?JSON.stringify(payload):undefined});const data=await response.json();return {status:response.status,data,cookie:response.headers.get('set-cookie')};};
 try{const route='/api/map-phase2b/private/manual-pins/'+source.customerCode;assert.equal((await request(route+'/save',{method:'POST',body:body()})).status,401);
 const login=await request('/api/map-phase2b/auth/login',{method:'POST',body:{id:'synthetic-only',password:'synthetic-test-only'}});assert.equal(login.status,200);cookie=login.cookie.split(';')[0];const detail=await request(route),csrf=detail.data.csrfToken;assert.equal(detail.data.data.canWrite,true);
 assert.equal((await request(route+'/save',{method:'POST',body:body()})).status,403);assert.equal((await request(route+'/save',{method:'POST',body:body(),csrf,origin:'https://invalid.example'})).status,401);
 const invalid=await fetch('http://127.0.0.1:'+server.address().port+route+'/save',{method:'POST',headers:{Origin:'https://localhost:3000',Cookie:cookie,'content-type':'application/json','x-map-pin-csrf':csrf},body:'{'});assert.equal(invalid.status,400);assert.deepEqual(await invalid.json(),{ok:false,error:'MANUAL_PIN_INPUT'});
 assert.equal((await request(route+'/reserve-search',{method:'POST',body:{query:address},csrf})).status,429);assert.equal((await request(route+'/save',{method:'POST',body:body(),csrf})).status,200);
 clock+=13*60*60*1000;assert.equal((await request(route+'/save',{method:'POST',body:body(1),csrf})).status,401);
 }finally{cookie='';await new Promise(resolve=>server.close(resolve));}
});
test.after(async()=>{const privateRoot=path.resolve(process.env.LOCALAPPDATA||process.cwd(),'OpsmapPrivate');assert(path.resolve(root).startsWith(privateRoot+path.sep));await fs.rm(root,{recursive:true,force:true});});
