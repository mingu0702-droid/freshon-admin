import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import http from 'node:http';import express from 'express';
import {createProductionManualPinGithubStore} from '../src/opsmap-abc/manualPinGithubStore.js';import {createManualMapPins} from '../src/opsmap-abc/manualMapPins.js';import {createMemoryCoordinateStore} from '../src/opsmap-abc/opsmapCoordinateIngestion.js';import {coordinateAddressHash} from '../src/opsmap-abc/opsmapAutoCoordinates.js';
const sha=n=>String(n).padStart(40,'0');
function fakeGithub(){let revision=1,value={manualPins:{schema:1,operations:0,customers:{}}},writes=0,unknown=false;
 const response=(status,body)=>({status,ok:status>=200&&status<300,json:async()=>structuredClone(body)});
 const fetchImpl=async(url,opts)=>{if(url==='https://api.github.com/repos/mingu0702-droid/freshon-cache')return response(200,{private:true,permissions:{push:true}});
  assert(url.startsWith('https://api.github.com/repos/mingu0702-droid/freshon-cache/contents/opsmap-production/manual-pins-v1.json'));
  if(opts.method==='PUT'){writes++;if(unknown)throw Error('lost response');const b=JSON.parse(opts.body);assert.equal(b.branch,'production/opsmap-manual-pins');if(b.sha!==sha(revision))return response(409,{});value=JSON.parse(Buffer.from(b.content,'base64'));revision++;return response(200,{});}
  assert(url.endsWith('?ref=production%2Fopsmap-manual-pins'));return response(200,{sha:sha(revision),encoding:'base64',content:Buffer.from(JSON.stringify(value)).toString('base64')});};
 return {fetchImpl,get writes(){return writes;},set unknown(v){unknown=v;},get value(){return value;}};
}
test('private GitHub Production CAS, readback, conflict, unknown outcome and private fields',async()=>{
 const fake=fakeGithub(),store=createProductionManualPinGithubStore({repo:'mingu0702-droid/freshon-cache',token:'synthetic',branch:'production/opsmap-manual-pins',fetchImpl:fake.fetchImpl});let saveA,saveB;
 await store.transaction(async(s,save)=>{saveA=()=>save({...s,manualPins:{...s.manualPins,operations:1}});});await store.transaction(async(s,save)=>{saveB=()=>save({...s,manualPins:{...s.manualPins,operations:2}});});
 await saveA();await assert.rejects(saveB(),e=>e.code==='MANUAL_PIN_GITHUB_CONFLICT');assert.equal(fake.value.manualPins.operations,1);
 await assert.rejects(store.transaction(async(s,save)=>save({...s,originalAddress:'private'})),e=>e.code==='MANUAL_PIN_GITHUB_PRIVATE_FIELD');
 const before=fake.writes;fake.unknown=true;await assert.rejects(store.transaction(async(s,save)=>save(s)),e=>e.code==='MANUAL_PIN_WRITE_OUTCOME_UNKNOWN');assert.equal(fake.writes,before+1);
 assert.throws(()=>createProductionManualPinGithubStore({repo:'mingu0702-droid/freshon-cache',token:'synthetic',branch:'main'}),e=>e.code==='MANUAL_PIN_GITHUB_CONFIG');
 const publicStore=createProductionManualPinGithubStore({repo:'mingu0702-droid/freshon-cache',token:'synthetic',branch:'production/opsmap-manual-pins',fetchImpl:async()=>({ok:true,json:async()=>({private:false,permissions:{push:true}})})});await assert.rejects(publicStore.transaction(()=>{}),e=>e.code==='MANUAL_PIN_GITHUB_PRIVATE_WRITE_REQUIRED');
});
test('shared staff session cannot write without independent coordinate permission',async()=>{
 const env={MAP_STAFF_ID:'fixture',MAP_STAFF_SESSION_SECRET:'a'.repeat(43),RENDER_EXTERNAL_URL:'https://localhost:3000',OPSMAP_MANUAL_PIN_STORE_FILE:'C:/outside/fixture.json',OPSMAP_MANUAL_PIN_WRITES:'1',OPSMAP_MANUAL_PIN_DURABLE_CONFIRMED:'1',OPSMAP_MANUAL_PIN_WRITER_ID:'fixture'};
 const readCustomer=async code=>({customerCode:code,customerName:'fixture',address:'서울특별시 가상로 10'}),store=createMemoryCoordinateStore(),backupStore=createMemoryCoordinateStore();
 const service=createManualMapPins({env,appRoot:'C:/app',readCustomer,store,backupStore});assert.equal(service.canWrite(),false);
 const serviceWithPermission=createManualMapPins({env,appRoot:'C:/app',readCustomer,store,backupStore,authorizeWrite:q=>q.get('x-test-coordinate-role')==='approved'}),app=express();
 serviceWithPermission.mount({app,requireStaff:(_q,r,n)=>{r.locals.staffSession={key:'fixture-session'};n();},isSessionCurrent:()=>true});const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port+'/api/map-phase2b/private/manual-pins/S970003';
 try{const read=await(await fetch(base)).json();assert.equal(read.data.canWrite,false);assert.equal(read.csrfToken,null);
  const allowed=await(await fetch(base,{headers:{'x-test-coordinate-role':'approved'}})).json();assert.equal(allowed.data.canWrite,true);
  const body={originalAddressHash:coordinateAddressHash('서울특별시 가상로 10'),expectedRevision:0,requestId:crypto.randomUUID(),latitude:37.5,longitude:127};
  const headers={'content-type':'application/json',origin:'https://localhost:3000','x-map-pin-csrf':allowed.csrfToken};assert.equal((await fetch(base+'/save',{method:'POST',headers,body:JSON.stringify(body)})).status,403);
  assert.equal((await fetch(base+'/save',{method:'POST',headers:{...headers,'x-test-coordinate-role':'approved'},body:JSON.stringify({...body,correctedSearchAddress:'서울특별시 가상로 12'})})).status,200);
  const record=store.snapshot().manualPins.customers.S970003.current;assert.equal(record.originalAddress,undefined);assert.equal(record.correctedSearchAddress,undefined);assert.equal(record.correctedSearchAddressHash,coordinateAddressHash('서울특별시 가상로 12'));
 }finally{await new Promise(r=>server.close(r));}
});
test('manual pin real service persists, reloads and reverts through isolated CAS adapter',async()=>{
 const remote=fakeGithub(),store=createProductionManualPinGithubStore({repo:'mingu0702-droid/freshon-cache',token:'synthetic',branch:'production/opsmap-manual-pins',fetchImpl:remote.fetchImpl});
 const env={RENDER:'true',RENDER_SERVICE_ID:'fixture',MAP_STAFF_ID:'fixture',OPSMAP_MANUAL_PIN_WRITER_ID:'fixture',OPSMAP_MANUAL_PIN_WRITES:'1',OPSMAP_MANUAL_PIN_DURABLE_CONFIRMED:'1'};
 const source={customerCode:'S970003',customerName:'fixture',address:'서울특별시 가상로 10'},options={env,appRoot:'C:/app',store,backupStore:store.backupStore,authorizeWrite:()=>true,readCustomer:async()=>source,readCoordinate:()=>({latitude:null,longitude:null})};
 const service=createManualMapPins(options),body={originalAddressHash:coordinateAddressHash(source.address),expectedRevision:0,requestId:crypto.randomUUID(),latitude:37.5,longitude:127};
 await service.mutate(source.customerCode,'save',body);const reopened=createManualMapPins(options);assert.equal((await reopened.projection())[0].resolutionStatus,'MANUAL_CONFIRMED');
 await reopened.mutate(source.customerCode,'revert',{...body,expectedRevision:1,requestId:crypto.randomUUID(),targetRevision:0});assert.equal((await reopened.projection()).length,0);
 assert.equal(remote.value.manualPins.customers[source.customerCode].history.length,2);assert.equal(JSON.stringify(remote.value).includes(source.address),false);assert.equal(remote.writes,2);
});
