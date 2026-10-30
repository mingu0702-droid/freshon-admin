import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {createManualPinGithubStore} from '../../src/manualPinGithubStore.js';
import {createManualMapPins} from '../../src/manualMapPins.js';
import {coordinateAddressHash} from '../../src/opsmapAutoCoordinates.js';
test('isolated pin conflict, permission denial and failed requery preserve confirmed record and audit',async()=>{
 let data={manualPins:{schema:1,operations:0,customers:{}}},version=1,readFail=false,forbidden=false;
 const fetchImpl=async(url,opt={})=>{
  if(!url.includes('/contents/'))return Response.json({private:true,permissions:{push:!forbidden}});
  if(opt.method==='PUT'){const b=JSON.parse(opt.body);if(b.sha!==String(version).padStart(40,'0'))return Response.json({},{status:409});data=JSON.parse(Buffer.from(b.content,'base64'));version++;return Response.json({});}
  if(readFail)return Response.json({},{status:503});
  return Response.json({sha:String(version).padStart(40,'0'),encoding:'base64',content:Buffer.from(JSON.stringify(data)).toString('base64')});
 };
 const store=createManualPinGithubStore({repo:'fixture/private',token:'synthetic-only',branch:'stage/opsmap-manual-pins',fetchImpl});
 const env={RENDER:'true',MAP_STAFF_ID:'fixture',OPSMAP_MANUAL_PIN_WRITER_ID:'fixture',OPSMAP_MANUAL_PIN_WRITES:'1',OPSMAP_MANUAL_PIN_DURABLE_CONFIRMED:'1'};
 const source={customerCode:'S970003',customerName:'Synthetic only',address:'서울특별시 가상로 10'};
 const options={env,appRoot:process.cwd(),store,backupStore:store.backupStore,authorizeWrite:()=>true,readCustomer:async()=>source,readCoordinate:()=>({latitude:null,longitude:null})};
 const service=createManualMapPins(options),body={expectedRevision:0,requestId:crypto.randomUUID(),originalAddressHash:coordinateAddressHash(source.address),latitude:37.5,longitude:127};
 await service.mutate(source.customerCode,'save',body);const baseline=JSON.stringify(data);
 await assert.rejects(service.mutate(source.customerCode,'save',{...body,requestId:crypto.randomUUID(),latitude:37.6}),e=>e.code==='MANUAL_PIN_REVISION_CONFLICT');assert.equal(JSON.stringify(data),baseline);
 const denied=createManualMapPins({...options,env:{...env,OPSMAP_MANUAL_PIN_WRITES:'0'}});await assert.rejects(denied.mutate(source.customerCode,'save',{...body,expectedRevision:1}),e=>e.code==='MANUAL_PIN_WRITE_PERMISSION_REQUIRED');assert.equal(JSON.stringify(data),baseline);
 forbidden=true;await assert.rejects(service.projection(),e=>e.code==='MANUAL_PIN_GITHUB_PRIVATE_WRITE_REQUIRED');forbidden=false;assert.equal(JSON.stringify(data),baseline);
 readFail=true;await assert.rejects(service.projection(),e=>e.code==='MANUAL_PIN_GITHUB_READ');readFail=false;assert.equal(JSON.stringify(data),baseline);
 const reopened=createManualMapPins(options),row=(await reopened.projection())[0];assert.equal(row.coordinateSource,'MANUAL_PIN');assert.equal(row.resolutionStatus,'MANUAL_CONFIRMED');assert.equal(row.revision,1);assert.equal(row.latitude,37.5);assert.equal((await reopened.selected(source.customerCode)).history.length,1);
});
