// SYNTHETIC ONLY. Never logs in, calls Delivery Admin, or reads operational data.
// R14_QA_TARGET_ROOT allows independent review against an integration worktree.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root=resolve(process.env.R14_QA_TARGET_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const load=path=>import(pathToFileURL(resolve(root,path)).href);
const express=createRequire(pathToFileURL(resolve(root,'package.json')))('express');
const {createOperationalPhotoMetadataReader,createOperationalPhotoExtension}=await load('src/opsmapOperationalPhotos.js');
const endpoint='/api/map-phase2b/private/delivery-photos';
const identity={customerCode:'S990091',date:'2026-11-04',deliveryId:'990091'};
const task=(changes={})=>({id:identity.deliveryId,customer:{erpCode:identity.customerCode},carrier:{enteringDatedAt:identity.date+'T00:00:00+09:00'},taskAttachments:[{typeText:'냉장고 문은 잘 닫았나요?',images:[{url:'https://static.chabyulhwa.com/qa-synthetic.jpg?signature=SYNTHETIC_SECRET'}]}],...changes});
const observed=(rows,complete)=>Object.defineProperty(rows,'sourceObservation',{value:{complete,requestedDate:identity.date}});
const staff={'x-qa-staff':'yes'};
async function fixture({taskValue=task(),metadataRows=observed([task()],true),mediaResponse,rawError,rawStatus=200}={}){
  let staffKey='qa-session-A',loggedIn=true,raw=0,media=0,metadata=0;
  const app=express();
  const extension=createOperationalPhotoExtension({enabled:true,hasMemorySession:()=>true,
    listDeliveryMetadata:createOperationalPhotoMetadataReader({readTaskRows:async()=>{metadata++;return metadataRows;}}),
    rawRequest:async(path,options)=>{raw++;assert.match(path,/^\/api\/bali\/task\/\d{1,20}(?:\/status-record)?$/);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');if(rawError)throw rawError;return rawStatus===200?Response.json({data:path.endsWith('/status-record')?[{id:'1990091',taskId:identity.deliveryId,taskAttachments:taskValue.taskAttachments}]:taskValue}):new Response(null,{status:rawStatus});},
    imageFetch:async(_url,options)=>{media++;assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert(!options.headers.Cookie);assert(!options.headers.Authorization);return mediaResponse?.()||new Response(new Uint8Array([255,216,255,217]),{headers:{'content-type':'image/jpeg'}});}});
  extension.mount({app,requireStaff:(q,r,next)=>{if(!loggedIn||q.get('x-qa-staff')!=='yes')return r.status(401).json({error:'STAFF_LOGIN_REQUIRED'});r.locals.staffSession={key:staffKey,expiresAt:Date.now()+60000,idleExpiresAt:Date.now()+60000};return next();},isSessionCurrent:(_q,key)=>loggedIn&&key===staffKey,previewEnabled:()=>true});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  return {get:(path,headers=staff)=>fetch(base+path,{headers}),list:(value=identity)=>fetch(base+endpoint+'?'+new URLSearchParams(value),{headers:staff}),stats:()=>({raw,media,metadata}),switchSession:()=>{staffKey='qa-session-B';},close:()=>new Promise(r=>server.close(r))};
}

test('SYNTHETIC: metadata requires affirmative completeness before declaring no records',async()=>{
  for(const rows of [[],observed([],undefined),observed([],false)]){
    const read=createOperationalPhotoMetadataReader({readTaskRows:async()=>rows});
    await assert.rejects(read(identity),{code:'SOURCE_UNAVAILABLE'});
  }
  assert.deepEqual(await createOperationalPhotoMetadataReader({readTaskRows:async()=>observed([],true)})(identity),[]);
});
test('SYNTHETIC: partial metadata can prove only the exact customer/date/task identity',async()=>{
  const read=createOperationalPhotoMetadataReader({readTaskRows:async()=>observed([task(),task({id:'990092',customer:{erpCode:'S990092'}})],false)});
  assert.deepEqual(await read(identity),[identity]);
  const wrongDate=createOperationalPhotoMetadataReader({readTaskRows:async()=>observed([task({carrier:{enteringDatedAt:'2026-11-03T00:00:00+09:00'}})],false)});
  await assert.rejects(wrongDate(identity),{code:'PHOTO_IDENTITY_UNVERIFIED'});
});
test('SYNTHETIC: malformed exact identities do not become empty-photo success',async()=>{
  for(const changes of [{id:'990091/../../1'},{id:undefined},{carrier:{}},{carrier:{enteringDatedAt:'2026-11-04T00:00:00'}}]){
    const read=createOperationalPhotoMetadataReader({readTaskRows:async()=>observed([task(changes)],true)});
    await assert.rejects(read(identity),{code:'PHOTO_IDENTITY_UNVERIFIED'});
  }
});
test('SYNTHETIC: anonymous discovery/detail/media deny before source activity and never cache',async()=>{
  const f=await fixture();try{for(const path of [endpoint+'?'+new URLSearchParams(identity),endpoint+'?customerCode='+identity.customerCode+'&date='+identity.date,endpoint+'/media/syntheticopaquehandle']){
    const r=await f.get(path,{});assert.equal(r.status,401);assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.get('cross-origin-resource-policy'),'same-origin');
  }assert.deepEqual(f.stats(),{raw:0,media:0,metadata:0});}finally{await f.close();}
});
test('SYNTHETIC: upstream 404/403/401 remain failures; verified attachment absence alone is EMPTY',async()=>{
  for(const [status,code] of [[404,'PHOTO_NOT_FOUND'],[403,'PHOTO_FORBIDDEN'],[401,'UPSTREAM_AUTH_REQUIRED']]){
    const f=await fixture({rawStatus:status});try{const r=await f.list();assert.equal(r.status,status===401?502:status);assert.equal((await r.json()).error.code,code);}finally{await f.close();}
  }
  const f=await fixture({taskValue:task({taskAttachments:[]})});try{const r=await f.list();assert.equal(r.status,200);assert.equal((await r.json()).data.deliveries[0].status,'EMPTY');}finally{await f.close();}
});
test('SYNTHETIC: detail prevents customer/date/task substitution',async()=>{
  for(const changes of [{customer:{erpCode:'S990092'}},{id:'990092'},{carrier:{enteringDatedAt:'2026-11-03T00:00:00+09:00'}}]){
    const f=await fixture({taskValue:task(changes)});try{const r=await f.list();assert.equal(r.status,409);assert.equal((await r.json()).error.code,'DELIVERY_IDENTITY_MISMATCH');assert.equal(f.stats().media,0);}finally{await f.close();}
  }
});
test('SYNTHETIC: hostile media origins are rejected before any fetch',async()=>{
  for(const url of ['http://static.chabyulhwa.com/a.jpg','https://127.0.0.1/a.jpg','https://static.chabyulhwa.com.evil.invalid/a.jpg','https://user:password@static.chabyulhwa.com/a.jpg','https://static.chabyulhwa.com:8443/a.jpg','file:///tmp/a.jpg','https://[::1]/a.jpg']){
    const value=task();value.taskAttachments[0].images[0].url=url;
    const f=await fixture({taskValue:value});try{const r=await f.list();assert.equal(r.status,403);assert.equal((await r.json()).error.code,'MEDIA_ORIGIN_REJECTED');assert.equal(f.stats().media,0);}finally{await f.close();}
  }
});
test('SYNTHETIC: opaque handles are session-bound and cannot survive a different staff login',async()=>{
  const f=await fixture();try{const body=await(await f.list()).json();const url=body.data.deliveries[0].photos[0].url;f.switchSession();const r=await f.get(url);assert.equal(r.status,404);assert.equal(f.stats().media,0);}finally{await f.close();}
});
test('SYNTHETIC: oversized declared media and active HTML are rejected before streaming',async()=>{
  for(const [headers,expected,code] of [[{'content-type':'image/jpeg','content-length':String(4*1024*1024+1)},413,'MEDIA_TOO_LARGE'],[{'content-type':'text/html'},502,'INVALID_MEDIA_TYPE']]){
    const f=await fixture({mediaResponse:()=>new Response('SYNTHETIC',{headers})});try{const body=await(await f.list()).json();const r=await f.get(body.data.deliveries[0].photos[0].url);assert.equal(r.status,expected);assert.equal((await r.json()).error.code,code);}finally{await f.close();}
  }
});
test('SYNTHETIC: responses contain neither signed upstream URLs nor arbitrary source error text',async()=>{
  const f=await fixture();try{const r=await f.list();const body=await r.text();assert(!body.includes('SYNTHETIC_SECRET'));assert(!body.includes('chabyulhwa.com'));assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal(r.headers.get('referrer-policy'),'no-referrer');}finally{await f.close();}
  const g=await fixture({rawError:new Error('SYNTHETIC_SECRET cookie=password signed-url')});try{const r=await g.list();const body=await r.text();assert.equal(r.status,502);assert(!body.includes('SYNTHETIC_SECRET'));assert.equal(JSON.parse(body).error.code,'PHOTO_LOOKUP_FAILED');}finally{await g.close();}
});
