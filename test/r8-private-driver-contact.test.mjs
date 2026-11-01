import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {chromium} from 'playwright';
import {createDriverAssignmentReader,createDriverContactReader,mountPrivateDriverContact,driverPhone} from '../src/privateDriverContact.js';
import {redactPublicData} from '../src/publicDataSecurity.js';
const phone = ['010','0000','0000'].join('-');
const name = '합성기사';
const identity = {customerCode:'T900001',vehicle:'101',date:'2026-11-02',context:'BASE'};
const master = {generatedAt:'2026-11-02T01:00:00Z',sheetName:'SYNTHETIC',vehicles:[{vehicle:'101',driverName:name,phone,effectiveDate:'2026-10-01'}]};
const knownBase = {customerCode:identity.customerCode,baseVehicle:'101',baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:'b'.repeat(64),baseVehicleStale:true,baseVehicleCheckedAt:'2026-09-24'};
test('previously verified base assignment permits minimal contact without claiming freshness',async()=>{
 const assignment=createDriverAssignmentReader({readBaseVehicles:async()=>({ok:true,data:[knownBase]})});
 const result=await createDriverContactReader({readAssignment:assignment,readDriverMaster:async()=>master})(identity);
 assert.deepEqual(result.data,{driverName:name,phone});assert.equal(result.meta.assignmentStale,true);assert.equal(result.meta.assignmentCheckedAt,'2026-09-24');
 assert.equal(redactPublicData(result).data.phone,undefined);
});
test('unknown, conflicting and mismatched vehicle assignment never returns a contact',async()=>{
 for(const change of [{baseVehicleState:'UNKNOWN'},{baseVehicleState:'CONFLICT'},{baseVehicle:'122'},{baseVehicleVersion:''}]){
  const read=createDriverAssignmentReader({readBaseVehicles:async()=>({ok:true,data:[{...knownBase,...change}]})});
  await assert.rejects(()=>read(identity),e=>e.status===409);
 }
});
test('dated driver name takes precedence and a different driver master phone is not substituted',async()=>{
 const read=createDriverContactReader({readAssignment:async()=>({vehicle:'101',driverName:'이전합성기사',driverPhone:null}),readDriverMaster:async()=>master});
 const result=await read({...identity,context:'DATE_ROUTE'});assert.equal(result.data.driverName,'이전합성기사');assert.equal(result.data.phone,null);
});
test('dated matching driver phone requires a valid applicable date or actual assignment phone',async()=>{
 const assignment=async()=>({vehicle:'101',driverName:name});
 const normal=await createDriverContactReader({readAssignment:assignment,readDriverMaster:async()=>master})({...identity,context:'DATE_ROUTE'});assert.equal(normal.data.phone,phone);
 const undated={...master,vehicles:[{...master.vehicles[0],effectiveDate:'0000-00-00'}]};
 const unknown=await createDriverContactReader({readAssignment:assignment,readDriverMaster:async()=>undated})({...identity,context:'DATE_ROUTE'});assert.equal(unknown.data.phone,null);
 const actual=await createDriverContactReader({readAssignment:async()=>({vehicle:'101',driverName:name,driverPhone:phone}),readDriverMaster:async()=>undated})({...identity,context:'DATE_ROUTE'});assert.equal(actual.data.phone,phone);
});
test('stored date/customer/vehicle mismatch and repeated conflicting dated records are rejected',async()=>{
 const normal={date:identity.date,vehicle:'101',stops:[{customerCode:identity.customerCode,driverName:name,driverPhone:phone}]};
 for(const route of [{...normal,sourceRouteIdentityVerified:false},{...normal,date:'2026-11-01'},{...normal,vehicle:'122'},{...normal,stops:[{customerCode:'T900002'}]},{...normal,stops:[...normal.stops,{customerCode:identity.customerCode,driverName:'다른합성기사'}]}]){
  const read=createDriverAssignmentReader({readStoredRoute:async()=>route});await assert.rejects(()=>read({...identity,context:'DATE_ROUTE'}),e=>[404,409].includes(e.status));
 }
});
test('empty registered source and failed source are distinct; errors never contain raw upstream messages',async()=>{
 const assignment=async()=>({vehicle:'101'});
 const empty=await createDriverContactReader({readAssignment:assignment,readDriverMaster:async()=>({...master,vehicles:[]})})(identity);assert.equal(empty.meta.state,'UNREGISTERED');
 await assert.rejects(()=>createDriverContactReader({readAssignment:assignment,readDriverMaster:async()=>({vehicles:[]})})(identity),e=>e.code==='DRIVER_SOURCE_UNAVAILABLE');
});
test('phone and input allowlists reject injection and malformed dates',async()=>{
 assert.equal(driverPhone('javascript:alert(1)'),null);assert.equal(driverPhone('010-0000-0000;ext=123'),null);
 const read=createDriverContactReader({readAssignment:async()=>({vehicle:'101'}),readDriverMaster:async()=>master});
 for(const bad of [{customerCode:'../../x'},{date:'2026-02-30'},{vehicle:'101&all=1'},{context:'PUBLIC'}])await assert.rejects(()=>read({...identity,...bad}),e=>e.status===400);
});
test('private route blocks before read, rechecks expiry and emits no-store on success/failure',async()=>{
 let authenticated=false,reads=0;
 const app=express();mountPrivateDriverContact({app,requireStaff:(_q,r,n)=>authenticated?n():r.status(401).json({error:'STAFF_LOGIN_REQUIRED'}),readAssignment:async()=>({vehicle:'101'}),readDriverMaster:async()=>{reads++;return master;}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port+'/api/map-phase2b/private/driver-contact?'+new URLSearchParams(identity);
 try{assert.equal((await fetch(url)).status,401);assert.equal(reads,0);authenticated=true;const good=await fetch(url);assert.equal(good.status,200);assert.equal(good.headers.get('cache-control'),'private, no-store');assert.equal((await good.json()).data.phone,phone);}finally{await new Promise(r=>server.close(r));}
 const race=express();authenticated=true;mountPrivateDriverContact({app:race,requireStaff:(_q,r,n)=>authenticated?n():r.status(401).json({error:'STAFF_LOGIN_REQUIRED'}),readAssignment:async()=>({vehicle:'101'}),readDriverMaster:async()=>{authenticated=false;return master;}});
 const restarted=race.listen(0,'127.0.0.1');await new Promise(r=>restarted.once('listening',r));try{assert.equal((await fetch('http://127.0.0.1:'+restarted.address().port+'/api/map-phase2b/private/driver-contact?'+new URLSearchParams(identity))).status,401);}finally{await new Promise(r=>restarted.close(r));}
});
test('business labels omit repeated dates but preserve source metadata',async()=>{
 const {dispatchCenter}=await import('../public/opsmap/map-location-contract.mjs');const center=dispatchCenter({...knownBase,baseVehicleGroup:'osan'});assert.equal(center.label,'오산센터');assert.equal(center.checkedAt,'2026-09-24');assert.equal(center.state,'PREVIOUS_VERIFIED');
 const scope={};vm.runInNewContext(await fs.readFile(new URL('../public/opsmap/map-period-ui.js',import.meta.url),'utf8'),scope);assert.equal(scope.MapPeriodUi.baseVehicleLabel(knownBase),'101호');
});
test('tel destination is restricted to phone format and card uses text nodes',async()=>{
 const scope={};vm.runInNewContext(await fs.readFile(new URL('../public/opsmap/map-driver-contact.js',import.meta.url),'utf8'),scope);assert.equal(scope.MapDriverContact.phoneHref(phone),'tel:'+phone.replace(/-/g,''));assert.equal(scope.MapDriverContact.phoneHref('javascript:alert(1)'),null);
});
test('isolated Chromium: phone link renders in the card and logout removes the value',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();await page.setContent('<body data-map-staff-state="authenticated"><dd id="driver"></dd></body>');await page.addScriptTag({path:new URL('../public/opsmap/map-driver-contact.js',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
  const result=await page.evaluate(async({identity,name,phone})=>{
   const control=MapDriverContact.create({getTarget:()=>document.querySelector('#driver'),fetcher:async()=>({ok:true,json:async()=>({ok:true,data:{driverName:name,phone},meta:{...identity,state:'REGISTERED',source:'DRIVER_MASTER'}})})});
   await control.load(identity);const link=document.querySelector('#driver a'),before={href:link?.getAttribute('href'),text:document.querySelector('#driver').textContent};window.dispatchEvent(new Event('map-staff-signed-out'));return {before,after:document.querySelector('#driver').textContent};
  },{identity,name,phone});assert.equal(result.before.href,'tel:'+phone.replace(/-/g,''));assert(result.before.text.includes(name));assert.equal(result.after,'');
 }finally{await browser.close();}
});
test('isolated Chromium: late previous-customer response and permission failure cannot retain a phone',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const page=await browser.newPage();await page.setContent('<body data-map-staff-state="authenticated"><dd id="driver"></dd></body>');await page.addScriptTag({path:new URL('../public/opsmap/map-driver-contact.js',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
  const result=await page.evaluate(async({identity,name,phone})=>{
   let release;const other={...identity,customerCode:'T900002'};
   const control=MapDriverContact.create({getTarget:()=>document.querySelector('#driver'),fetcher:async url=>{const isFirst=url.includes(identity.customerCode);if(isFirst)await new Promise(r=>release=r);return {ok:!isFirst,json:async()=>isFirst?{error:'DRIVER_ASSIGNMENT_UNCONFIRMED'}:{ok:true,data:{driverName:name,phone},meta:{...other,state:'REGISTERED',source:'DRIVER_MASTER'}}};}});
   const old=control.load(identity);await control.load(other);release();await old;const current=document.querySelector('#driver').textContent;window.dispatchEvent(new CustomEvent('map-store-selected',{detail:{customerCode:null}}));return {current,cleared:document.querySelector('#driver').textContent};
  },{identity,name,phone});assert(result.current.includes(name));assert.equal(result.cleared,'');
 }finally{await browser.close();}
});
