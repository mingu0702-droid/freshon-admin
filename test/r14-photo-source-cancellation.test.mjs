import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createOperationalPhotoExtension,createOperationalPhotoMetadataReader} from '../src/opsmapOperationalPhotos.js';
import {mountProductionPhotoBinding} from '../src/opsmapProductionPhotos.js';

test('cancelled metadata stops its caller even if an injected reader never settles',async()=>{
 const controller=new AbortController();
 const read=createOperationalPhotoMetadataReader({readTaskRows:()=>new Promise(()=>{})});
 const pending=read({customerCode:'S990001',date:'2026-11-04'},{signal:controller.signal});
 controller.abort();await assert.rejects(pending,{code:'PHOTO_TIMEOUT'});
});

test('client cancellation releases photo source preparation without waiting for a shared login',async()=>{
 const app=express();let started=false;
 const extension=createOperationalPhotoExtension({enabled:true,hasMemorySession:()=>false,prepareSession:()=>{started=true;return new Promise(()=>{});},rawRequest:async()=>{throw Error('SOURCE_MUST_NOT_RUN');}});
 extension.mount({app,requireStaff:(_q,r,n)=>{r.locals.staffSession={key:'synthetic'};return n();},isSessionCurrent:()=>true,previewEnabled:()=>true});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const controller=new AbortController();
 const request=fetch('http://127.0.0.1:'+server.address().port+'/api/map-phase2b/private/delivery-photos?customerCode=S990001&date=2026-11-04',{signal:controller.signal});
 while(!started)await new Promise(r=>setTimeout(r,1));
 controller.abort();await assert.rejects(request,{name:'AbortError'});
 await new Promise(r=>server.close(r));
});

test('private photo configuration exposes only booleans and denies anonymous access',async()=>{
 const app=express();let sourceReads=0;
 mountProductionPhotoBinding({app,requireStaff:(q,r,n)=>q.get('x-staff')==='yes'?n():r.status(401).end(),isSessionCurrent:()=>true,previewEnabled:()=>true,env:{},sourceConfiguration:()=>{sourceReads++;return{credentialsConfigured:true,environmentCookieConfigured:false,privateSecret:'SYNTHETIC_SECRET'};}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const url='http://127.0.0.1:'+server.address().port+'/api/map-phase2b/private/delivery-photos/config';
  assert.equal((await fetch(url)).status,401);assert.equal(sourceReads,0);
  const response=await fetch(url,{headers:{'x-staff':'yes'}}),text=await response.text();
  assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
  assert(!text.includes('SYNTHETIC_SECRET'));assert.deepEqual(Object.values(JSON.parse(text).data).map(v=>typeof v),Array(5).fill('boolean'));
 }finally{await new Promise(r=>server.close(r));}
});
