import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createOperationalPhotoExtension, createOperationalPhotoMetadataReader} from '../src/opsmapOperationalPhotos.js';

const endpoint = '/api/map-phase2b/private/delivery-photos';
const record = {customerCode:'S990001', date:'2026-11-04', deliveryId:'990001'};
const task = (id=record.deliveryId, code=record.customerCode) => ({id,customer:{erpCode:code},carrier:{enteringDatedAt:record.date+'T00:00:00+09:00'},taskAttachments:[
  {typeText:'냉장고 문은 잘 닫았나요?',images:[{url:'https://static.chabyulhwa.com/synthetic-fridge.jpg'}]},
  {typeText:'매장 출입문은 잘 잠궜나요?',images:[{url:'https://static.chabyulhwa.com/synthetic-door.jpg'}]}
]});
const query = value => '?'+new URLSearchParams(value);
async function fixture({enabled=true, session=true, empty=false, status=200, mismatch=false}={}) {
  const app=express();let loggedIn=true, sourceSession=session, details=0, medias=0, auths=0, metadataReads=0;
  const requireStaff=(q,r,n)=>{if(!loggedIn||q.get('x-staff')!=='yes')return r.status(401).json({error:'STAFF_LOGIN_REQUIRED'});r.locals.staffSession={key:'synthetic-session',expiresAt:Date.now()+60000,idleExpiresAt:Date.now()+60000};return n();};
  const extension=createOperationalPhotoExtension({enabled,hasMemorySession:()=>sourceSession,prepareSession:async()=>{auths++;sourceSession=true;},
    listDeliveryMetadata:createOperationalPhotoMetadataReader({defaultDate:()=>record.date,readTaskRows:async()=>{metadataReads++;return [task(),task('990002','S990002')];}}),
    rawRequest:async(path,options)=>{const statusRecord=path.endsWith('/status-record');if(!statusRecord)details++;assert.equal(options.cache,'no-store');assert.equal(options.method,'GET');assert.match(path,/^\/api\/bali\/task\/\d+(?:\/status-record)?$/);if(status!==200)return new Response(null,{status});const id=path.split('/')[4],value=task(id,mismatch?'S990002':record.customerCode);if(empty)value.taskAttachments=[];return Response.json({data:statusRecord?[{id:'1990001',taskId:id,taskAttachments:value.taskAttachments}]:value});},
    imageFetch:async(_url,options)=>{medias++;assert.equal(options.credentials,'omit');assert(!options.headers.Cookie);return new Response(new Uint8Array([255,216,255,217]),{headers:{'content-type':'image/jpeg'}});}});
  extension.mount({app,requireStaff,isSessionCurrent:()=>loggedIn,previewEnabled:()=>true});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  return {get:async(path,headers={'x-staff':'yes'})=>{const response=await fetch(base+path,{headers});return {response,body:response.headers.get('content-type')?.includes('json')?await response.json():new Uint8Array(await response.arrayBuffer())};},stats:()=>({details,medias,auths,metadataReads}),logout:()=>{loggedIn=false;},close:()=>new Promise(r=>server.close(r))};
}

test('operational mode discovers exact customer/day and serves multiple categories beyond the old 2/1 allowance',async()=>{
  const f=await fixture();try{
    const list=await f.get(endpoint+query({customerCode:record.customerCode,date:record.date}));assert.equal(list.response.status,200);assert.deepEqual(list.body.data.deliveries.map(x=>x.deliveryId),[record.deliveryId]);assert.equal(f.stats().details,0);
    for(let i=0;i<3;i++){
      const detail=await f.get(endpoint+query(record));assert.equal(detail.response.status,200);const photos=detail.body.data.deliveries[0].photos;assert.equal(photos.length,2);
      for(const photo of photos){const image=await f.get(photo.url);assert.equal(image.response.status,200);assert.equal(image.body.length,4);assert.match(image.response.headers.get('cache-control'),/no-store/);}
      assert(!JSON.stringify(detail.body).includes('chabyulhwa'));
    }
    assert.equal(f.stats().medias,6);assert.equal(f.stats().details,9);
  }finally{await f.close();}
});
test('existing authentication prepares only for authenticated explicit photo access, never anonymously or OFF',async()=>{
  for(const enabled of [false,true]){const f=await fixture({enabled,session:false});try{
    assert.equal((await f.get(endpoint+query(record),{})).response.status,401);assert.equal(f.stats().auths,0);
    const read=await f.get(endpoint+query({customerCode:record.customerCode,date:record.date}));assert.equal(read.response.status,enabled?200:503);assert.equal(f.stats().auths,enabled?1:0);
  }finally{await f.close();}}
});
test('verified empty, upstream permission, expired upstream auth, source failure and identity mismatch stay distinct',async()=>{
  for(const [options,http,code,state] of [[{empty:true},200,null,'EMPTY'],[{status:403},403,'PHOTO_FORBIDDEN'],[{status:401},502,'UPSTREAM_AUTH_REQUIRED'],[{status:500},502,'PHOTO_LOOKUP_FAILED'],[{mismatch:true},409,'DELIVERY_IDENTITY_MISMATCH']]){
    const f=await fixture(options);try{const read=await f.get(endpoint+query(record));assert.equal(read.response.status,http);if(code)assert.equal(read.body.error.code,code);else assert.equal(read.body.data.deliveries[0].status,state);assert.equal(f.stats().medias,0);}finally{await f.close();}
  }
});
test('logout invalidates opaque media handles before image bytes leave the service',async()=>{
  const f=await fixture();try{const read=await f.get(endpoint+query(record));f.logout();assert.equal((await f.get(read.body.data.deliveries[0].photos[0].url)).response.status,401);assert.equal(f.stats().medias,0);}finally{await f.close();}
});
test('metadata rejects malformed selected identities and filters other customers/dates without scanning',async()=>{
  let count=0;const read=createOperationalPhotoMetadataReader({readTaskRows:async date=>{count++;assert.equal(date,record.date);return [task(),task('990002','S990002')];}});
  assert.deepEqual(await read(record),[record]);assert.equal(count,1);
  assert.deepEqual(await read(record),[record]);assert.equal(count,1);
  await assert.rejects(read({...record,date:'2026-02-30'}),{code:'INVALID_DATE'});assert.equal(count,1);
  const partial=[];Object.defineProperty(partial,'sourceObservation',{value:{complete:false}});
  await assert.rejects(createOperationalPhotoMetadataReader({readTaskRows:async()=>partial})(record),{code:'SOURCE_UNAVAILABLE'});
});

test('aborting a photo request releases its concurrency slot while the existing shared login remains in progress',async()=>{
  const app=express();let prepared=false,preparations=0,details=0,resolveShared;
  const sharedLogin=new Promise(r=>{resolveShared=r;});
  const extension=createOperationalPhotoExtension({enabled:true,hasMemorySession:()=>prepared,
    prepareSession:()=>{preparations++;return sharedLogin;},
    listDeliveryMetadata:async()=>[record],rawRequest:async path=>{if(path.endsWith('/status-record'))return Response.json({data:[{id:'1990001',taskAttachments:task().taskAttachments}]});details++;return Response.json({data:task()});}});
  extension.mount({app,requireStaff:(_q,r,n)=>{r.locals.staffSession={key:'synthetic-staff'};return n();},isSessionCurrent:()=>true,previewEnabled:()=>true});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const url='http://127.0.0.1:'+server.address().port+endpoint+query(record),controllers=Array.from({length:3},()=>new AbortController());
  const pending=controllers.map(controller=>fetch(url,{signal:controller.signal}).catch(()=>null));
  try{
    for(let i=0;i<100&&preparations<3;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(preparations,3);controllers[0].abort();await pending[0];
    await new Promise(r=>setTimeout(r,20));prepared=true;
    const response=await fetch(url);assert.equal(response.status,200);await response.json();assert.equal(details,1);
    assert.equal(preparations,3); // No retry/new login after an aborted waiter.
  }finally{
    controllers.forEach(controller=>controller.abort());await Promise.allSettled(pending);resolveShared();
    await new Promise(r=>server.close(r));
  }
});
