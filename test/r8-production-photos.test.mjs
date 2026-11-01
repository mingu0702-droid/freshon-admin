import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';
import {createProductionPhotoExtension,createProductionPhotoMetadataReader} from '../src/opsmapProductionPhotos.js';
const code='S970001',date='2026-10-23',id='970001',origin='https://static.chabyulhwa.com';
function task(images=true){return {id,customer:{erpCode:code},carrier:{enteringDatedAt:date+'T00:00:00+09:00'},taskAttachments:images?[{typeText:'냉장고 문은 잘 닫았나요?',text:'DO_NOT_EXPORT_PRIVATE_MEMO',images:[{url:origin+'/synthetic.jpg?secret=SYNTHETIC_URL_ONLY'},{url:origin+'/synthetic2.jpg'}]}]:[]};}
async function server({enabled=true,upstreamSession=true,empty=false,wrongCode=false,contentType='image/jpeg'}={}){
 let staff=true,rawReads=0,mediaReads=0;
 const extension=createProductionPhotoExtension({enabled,hasMemorySession:()=>upstreamSession,
  rawRequest:async(path,options)=>{rawReads++;assert.equal(path,'/api/bali/task/'+id);assert.equal(options.redirect,'error');assert.equal(options.method,'GET');assert(!options.headers);const value=task(!empty);if(wrongCode)value.customer.erpCode='S970002';return Response.json({data:value});},
  listDeliveryMetadata:async identity=>[{customerCode:identity.customerCode,date,deliveryId:id}],
  imageFetch:async(url,options)=>{mediaReads++;assert.equal(options.credentials,'omit');assert(!options.headers.Cookie);assert(!options.headers.Authorization);return new Response(new Uint8Array([255,216,255,217]),{status:200,headers:{'content-type':contentType}});}});
 const app=express(),guard=async(req,res,next)=>{await new Promise(r=>setTimeout(r,2));if(!staff||req.get('x-fixture')!=='authorized')return res.status(401).json({error:'STAFF_LOGIN_REQUIRED'});res.locals.staffSession={key:'synthetic-session',expiresAt:Date.now()+60000,idleExpiresAt:Date.now()+60000};return next();};
 extension.mount({app,requireStaff:guard,isSessionCurrent:()=>staff,previewEnabled:()=>true});
 const instance=app.listen(0,'127.0.0.1');await new Promise(r=>instance.once('listening',r));
 return {url:'http://127.0.0.1:'+instance.address().port,headers:{'x-fixture':'authorized'},stats:()=>({rawReads,mediaReads,...extension.diagnostics()}),logout:()=>{staff=false;},close:()=>new Promise(r=>instance.close(r))};
}
const endpoint='/api/map-phase2b/private/delivery-photos',query='?customerCode='+code+'&date='+date+'&deliveryId='+id;
test('authenticated exact task produces one opaque image, awaits async staff auth, and denies replay after logout',async()=>{
 const s=await server();try{
  assert.equal((await fetch(s.url+endpoint+query)).status,401);assert.equal(s.stats().rawReads,0);
  const response=await fetch(s.url+endpoint+query,{headers:s.headers});assert.equal(response.status,200);const value=await response.json(),delivery=value.data.deliveries[0];
  assert.equal(delivery.status,'READY');assert.equal(delivery.photos.length,1);assert.equal(delivery.notes,'');assert(!JSON.stringify(value).includes(origin));assert(!JSON.stringify(value).includes('secret='));
  const media=delivery.photos[0].url,raw=await fetch(s.url+media,{headers:s.headers});assert.equal(raw.status,200);assert.equal((await raw.arrayBuffer()).byteLength,4);assert.match(raw.headers.get('cache-control'),/no-store/);assert.equal(s.stats().mediaReads,1);
  const repeated=await fetch(s.url+media,{headers:s.headers});assert.equal(repeated.status,429);assert.equal(s.stats().mediaReads,1);
  s.logout();assert.equal((await fetch(s.url+media,{headers:s.headers})).status,401);
 }finally{await s.close();}
});
test('valid employee session is distinct from missing source session; no automatic source login occurs',async()=>{
 const s=await server({upstreamSession:false});try{const r=await fetch(s.url+endpoint+query,{headers:s.headers});assert.equal(r.status,502);assert.equal((await r.json()).error.code,'UPSTREAM_AUTH_REQUIRED');assert.equal(s.stats().rawReads,0);}finally{await s.close();}
});
test('no task attachments is EMPTY; identity mismatch never returns images',async()=>{
 for(const options of [{empty:true},{wrongCode:true}]){const s=await server(options);try{const r=await fetch(s.url+endpoint+query,{headers:s.headers}),value=await r.json();if(options.empty){assert.equal(r.status,200);assert.equal(value.data.deliveries[0].status,'EMPTY');}else{assert.equal(r.status,409);assert.equal(value.error.code,'DELIVERY_IDENTITY_MISMATCH');}assert.equal(s.stats().mediaReads,0);}finally{await s.close();}}
});
test('non-image upstream response is rejected without replacing staff authentication',async()=>{
 const s=await server({contentType:'text/html'});try{const v=await(await fetch(s.url+endpoint+query,{headers:s.headers})).json();const r=await fetch(s.url+v.data.deliveries[0].photos[0].url,{headers:s.headers});assert.equal(r.status,502);assert.equal((await r.json()).error.code,'INVALID_MEDIA_TYPE');}finally{await s.close();}
});
test('single metadata page verifies exact customer/date and never calls a login provider',async()=>{
 let calls=0;const read=createProductionPhotoMetadataReader({hasMemorySession:()=>true,rawRequest:async(path,options)=>{calls++;const url=new URL(path,'https://example.test');assert.equal(url.pathname,'/api/bali/task');assert.deepEqual(url.searchParams.getAll('enteringDatedAtBetween'),[date+'T00:00:00+09:00',date+'T00:00:00+09:00']);assert.equal(options.redirect,'error');return Response.json({content:[task(),{...task(),customer:{erpCode:'S970002'}}],totalPages:20});}});
 assert.deepEqual(await read({customerCode:code,date}),[{customerCode:code,date,deliveryId:id}]);assert.equal(calls,1);
});
test('metadata incomplete page without a customer stays UNVERIFIED; remaining read limit is enforced',async()=>{
 let calls=0;const read=createProductionPhotoMetadataReader({maxReads:1,hasMemorySession:()=>true,rawRequest:async()=>{calls++;return Response.json({content:[],totalPages:20});}});
 await assert.rejects(read({customerCode:code,date}),e=>e.code==='UNVERIFIED');await assert.rejects(read({customerCode:code,date}),e=>e.code==='PHOTO_RATE_LIMITED');assert.equal(calls,1);
});
test('disabled source and absent source session never issue remote calls',async()=>{
 let calls=0;const read=createProductionPhotoMetadataReader({hasMemorySession:()=>false,rawRequest:async()=>{calls++;throw Error('NO_READ');}});
 await assert.rejects(read({customerCode:code,date}),e=>e.code==='UPSTREAM_AUTH_REQUIRED');assert.equal(calls,0);
 const s=await server({enabled:false});try{const r=await fetch(s.url+endpoint+query,{headers:s.headers});assert.equal(r.status,503);assert.equal((await r.json()).error.code,'PHOTO_SOURCE_DISABLED');assert.equal(s.stats().rawReads,0);}finally{await s.close();}
});
