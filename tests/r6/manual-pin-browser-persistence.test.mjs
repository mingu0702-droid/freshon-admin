import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {chromium} from 'playwright';
import {createManualMapPins} from '../../src/manualMapPins.js';import {createFileCoordinateStore} from '../../src/opsmapCoordinateIngestion.js';
test('isolated real-file pin survives browser reconnect; failed projection keeps manual source and shows warning',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'opsmap-final-pin-')),file=path.join(dir,'pins.json'),store=createFileCoordinateStore({filePath:file}),backup=createFileCoordinateStore({filePath:path.join(dir,'backup.json')});
 let available=true;const source={customerCode:'S970003',customerName:'SYNTHETIC_ONLY',address:'서울특별시 가상로 10'},env={MAP_STAFF_ID:'fixture',MAP_STAFF_SESSION_SECRET:'a'.repeat(43),OPSMAP_MANUAL_PIN_WRITER_ID:'fixture',OPSMAP_MANUAL_PIN_WRITES:'1',OPSMAP_MANUAL_PIN_DURABLE_CONFIRMED:'1'};
 const svc=createManualMapPins({env,appRoot:process.cwd(),store,backupStore:backup,authorizeWrite:()=>true,readCustomer:async()=>{if(!available)throw Error('ISOLATED_SOURCE_FAILURE');return source;}}),app=express();
 svc.mount({app,requireStaff:(_q,r,n)=>{r.locals.staffSession={key:'synthetic-session'};return n();},isSessionCurrent:()=>true});
 app.use('/assets',express.static(fileURLToPath(new URL('../../public',import.meta.url))));
 app.get('/',(_q,r)=>r.type('html').send(`<div id="periodStoreListSection"></div><output id="source"></output><script>window.row={customerCode:'S970003',customerName:'SYNTHETIC_ONLY',lat:37.4,lng:127,coordinateSource:'KAKAO_BUILDING_EXACT_ADDRESS'};window.MapUiLocalBridge={state:{selected:null},stores:()=>[row],refreshManualCoordinates(){MapManualPins.apply(row);document.querySelector('#source').textContent=row.coordinateSource;}};</script><script type="module" src="/assets/manual-map-pins.mjs"></script>`));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),origin='http://127.0.0.1:'+server.address().port;env.MAP_STAFF_ORIGIN=origin;
 let browser;
 try{
 const executablePath=process.env.OPSMAP_TEST_CHROMIUM;
 browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
 const page=await browser.newPage();await page.goto(origin);await page.waitForFunction(()=>window.MapManualPins?.verified());
 const saved=await page.evaluate(async()=>{const b='/api/map-phase2b/private/manual-pins/S970003',s=await(await fetch(b)).json();const r=await fetch(b+'/save',{method:'POST',headers:{'content-type':'application/json','x-map-pin-csrf':s.csrfToken},body:JSON.stringify({originalAddressHash:s.data.originalAddressHash,expectedRevision:0,requestId:crypto.randomUUID(),latitude:37.5,longitude:127})});return {status:r.status,value:await r.json()};});assert.equal(saved.status,200);assert.equal(saved.value.data.current.coordinateSource,'MANUAL_PIN');
 await page.evaluate(()=>MapManualPins.refresh());await page.waitForFunction(()=>document.querySelector('#source').textContent==='MANUAL_PIN');await page.reload();await page.waitForFunction(()=>document.querySelector('#source').textContent==='MANUAL_PIN');
 const next=await browser.newContext(),reconnected=await next.newPage();await reconnected.goto(origin);await reconnected.waitForFunction(()=>document.querySelector('#source').textContent==='MANUAL_PIN');const before=await fs.readFile(file,'utf8');
 available=false;assert.equal(await reconnected.evaluate(async()=>{try{await MapManualPins.refresh();return false;}catch{return true;}}),true);assert.equal(await reconnected.locator('#source').textContent(),'MANUAL_PIN');assert.equal(await reconnected.locator('#manualPinProjectionStatus').isVisible(),true);assert.equal(await fs.readFile(file,'utf8'),before);
 available=true;await reconnected.evaluate(()=>MapManualPins.refresh());assert.equal(await reconnected.locator('#manualPinProjectionStatus').isVisible(),false);
 }finally{await browser?.close();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});}
});
