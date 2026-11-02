import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {fileURLToPath} from 'node:url';
import {createProductionPhotoExtension,mountProductionPhotoBinding} from '../src/opsmapProductionPhotos.js';
import {mountProductionOpsmapCandidate} from '../src/productionOpsmapCandidate.js';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';

const record={customerCode:'S990001',date:'2026-11-02',deliveryId:'990001',firstKind:'REFRIGERATOR_DOOR'};
const approvalId='synthetic-approval-v1',endpoint='/api/map-phase2b/private/delivery-photos';
const headers={'x-synthetic-staff':'yes'};
const query=(r=record)=>'?'+new URLSearchParams({customerCode:r.customerCode,date:r.date,deliveryId:r.deliveryId});
const task=(overrides={})=>({id:record.deliveryId,customer:{erpCode:record.customerCode},carrier:{enteringDatedAt:record.date+'T00:00:00+09:00'},
 taskAttachments:[{typeText:'냉장고 문은 잘 닫았나요?',text:'PRIVATE_SENTINEL',images:Array.from({length:9},(_,i)=>({url:'https://static.chabyulhwa.com/synthetic-'+i+'.jpg?signature=DO_NOT_DISCLOSE'}))}],...overrides});
function ledger({detail=2,media=1}={}){
 const available={detail,media},calls=[];
 return {available,calls,async reserve(input){calls.push({...input});const reserved=available[input.operation]>0;if(reserved)available[input.operation]--;return {...input,reserved};}};
}
async function server({enabled=true,session=true,approved=true,budget=ledger(),getTask=()=>Response.json({data:task()}),mediaType='image/jpeg',mediaBytes=new Uint8Array([255,216,255,217]),rawHook,env}={}){
 let staff=true,rawReads=0,mediaReads=0;const app=express();
 const common={app,requireStaff:async(q,r,next)=>{await Promise.resolve();if(!staff||q.get('x-synthetic-staff')!=='yes')return r.status(401).json({error:'STAFF_LOGIN_REQUIRED'});r.locals.staffSession={key:'synthetic-key',expiresAt:Date.now()+60000,idleExpiresAt:Date.now()+60000};return next();},isSessionCurrent:()=>staff,previewEnabled:()=>true};
 const source={rawRequest:async(path,options)=>{rawReads++;assert.equal(path,'/api/bali/task/'+record.deliveryId);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert(!options.headers);await rawHook?.(options);return getTask();},hasMemorySession:()=>session,
 reserveRead:approved?budget.reserve:undefined,imageFetch:async(url,options)=>{mediaReads++;assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert(!options.headers.Cookie);assert(!options.headers.Authorization);return new Response(mediaBytes,{headers:{'content-type':mediaType,'content-length':String(mediaBytes.byteLength)}});}};
 let extension;
 if(env)extension=mountProductionPhotoBinding({...common,...source,env});
 else{extension=createProductionPhotoExtension({enabled,approvedRecords:[record],approvalId,...source});extension.mount(common);}
 const instance=app.listen(0,'127.0.0.1');await new Promise(r=>instance.once('listening',r));
 return {url:'http://127.0.0.1:'+instance.address().port,stats:()=>({rawReads,mediaReads,...extension.diagnostics()}),logout:()=>{staff=false;},close:()=>new Promise(r=>instance.close(r))};
}
const json=async(s,path=endpoint+query())=>{const r=await fetch(s.url+path,{headers});return {status:r.status,body:await r.json()};};

test('default/OFF and absent cumulative approval make zero source and login requests',async()=>{
 for(const options of [{enabled:false},{approved:false},{env:{OPSMAP_PRODUCTION_PHOTO_VERIFY:'1',OPSMAP_PHOTO_APPROVED_RECORDS:'malformed'}}]){
  const s=await server(options);try{const v=await json(s);assert.equal(v.status,503);assert.equal(v.body.error.code,options.enabled===false?'PHOTO_SOURCE_DISABLED':'PHOTO_APPROVAL_REQUIRED');assert.equal(s.stats().rawReads,0);assert.equal(s.stats().mediaReads,0);}finally{await s.close();}
 }
});
test('anonymous and unapproved identities are denied before any source call',async()=>{
 const s=await server();try{assert.equal((await fetch(s.url+endpoint+query())).status,401);
  for(const r of [{...record,customerCode:'S990002'},{...record,date:'2026-11-01'},{...record,deliveryId:'990002'}])assert.equal((await json(s,endpoint+query(r))).status,403);
  assert.equal(s.stats().rawReads,0);
 }finally{await s.close();}
});
test('approved discovery is local allowlist only and one record yields one opaque image out of nine',async()=>{
 const s=await server();try{const list=await json(s,endpoint+'?customerCode='+record.customerCode+'&date='+record.date);assert.equal(list.status,200);assert.equal(list.body.data.deliveries.length,1);assert.equal(s.stats().rawReads,0);
  const v=await json(s);assert.equal(v.status,200);const d=v.body.data.deliveries[0];assert.equal(d.status,'READY');assert.equal(d.photos.length,1);assert.equal(d.notes,'');assert.equal(s.stats().rawReads,1);
  const text=JSON.stringify(v);assert(!text.includes('chabyulhwa'));assert(!text.includes('signature'));assert(!text.includes('PRIVATE_SENTINEL'));
 }finally{await s.close();}
});
test('exact list plus revalidation consumes detail two/media one and repeated media is stopped before another detail',async()=>{
 const b=ledger(),s=await server({budget:b});try{const v=await json(s),p=v.body.data.deliveries[0].photos[0].url;
  const r=await fetch(s.url+p,{headers});assert.equal(r.status,200);assert.equal((await r.arrayBuffer()).byteLength,4);assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(s.stats().rawReads,2);assert.equal(s.stats().mediaReads,1);assert.deepEqual(b.calls.map(x=>x.operation),['detail','detail','media']);
  assert.equal((await json(s,p)).status,429);assert.equal(s.stats().rawReads,2);assert.equal(s.stats().mediaReads,1);
  s.logout();assert.equal((await fetch(s.url+p,{headers})).status,401);
 }finally{await s.close();}
});
test('a shared approval ledger remains exhausted across extension/process replacement',async()=>{
 const b=ledger({detail:1,media:0});const first=await server({budget:b});try{assert.equal((await json(first)).status,200);}finally{await first.close();}
 const second=await server({budget:b});try{const v=await json(second);assert.equal(v.status,503);assert.equal(v.body.error.code,'PHOTO_APPROVAL_REQUIRED');assert.equal(second.stats().rawReads,0);}finally{await second.close();}
});
test('source session failure/401 stays distinct from the valid staff session without automatic login',async()=>{
 for(const options of [{session:false},{getTask:()=>new Response(null,{status:401})}]){const s=await server(options);try{const v=await json(s);assert.equal(v.status,502);assert.equal(v.body.error.code,'UPSTREAM_AUTH_REQUIRED');assert.equal(s.stats().rawReads,options.session===false?0:1);
  const local=await json(s,endpoint+'?customerCode='+record.customerCode);assert.equal(local.status,200);
 }finally{await s.close();}}
});
test('task identity, missing attachments, unknown category, and verified empty are separate outcomes',async()=>{
 for(const [payload,status,code,state] of [
  [task({customer:{erpCode:'S990002'}}),409,'DELIVERY_IDENTITY_MISMATCH'],
  [task({carrier:{enteringDatedAt:'2026-11-01T00:00:00+09:00'}}),409,'DELIVERY_IDENTITY_MISMATCH'],
  [task({id:'990002'}),409,'DELIVERY_IDENTITY_MISMATCH'],
  [task({taskAttachments:undefined}),503,'PHOTO_ATTACHMENTS_INVALID'],
  [task({taskAttachments:[]}),200,null,'EMPTY'],
  [task({taskAttachments:[{typeText:'UNVERIFIED_TYPE',images:[{url:'https://static.chabyulhwa.com/a.jpg'}]}]}),200,null,'UNVERIFIED'],
  [task({taskAttachments:[{typeText:'매장 출입문은 잘 잠궜나요?',images:[{url:'https://static.chabyulhwa.com/a.jpg'}]}]}),200,null,'UNVERIFIED']
 ]){const s=await server({getTask:()=>Response.json({data:payload})});try{const v=await json(s);assert.equal(v.status,status);if(code)assert.equal(v.body.error.code,code);else assert.equal(v.body.data.deliveries[0].status,state);assert.equal(s.stats().mediaReads,0);}finally{await s.close();}}
});
test('one nested images group preserves the exact identity and returns/revalidates only its first image',async()=>{
 const nested=task({taskAttachments:[{typeText:'냉장고 문은 잘 닫았나요?',images:[{images:[{url:'https://static.chabyulhwa.com/nested-first.jpg'},{url:'https://static.chabyulhwa.com/nested-second.jpg'}]}]}]});
 const s=await server({getTask:()=>Response.json({data:nested})});try{const v=await json(s);assert.equal(v.status,200);assert.equal(v.body.data.deliveries[0].photos.length,1);const media=await fetch(s.url+v.body.data.deliveries[0].photos[0].url,{headers});assert.equal(media.status,200);await media.arrayBuffer();assert.equal(s.stats().rawReads,2);assert.equal(s.stats().mediaReads,1);}finally{await s.close();}
});
test('ambiguous/deeper nested image groups are unverified, never an empty delivery',async()=>{
 for(const image of [{url:'https://static.chabyulhwa.com/a.jpg',images:[]},{images:[{images:[]}]},{typeText:'매장 출입문은 잘 잠궜나요?',images:[{url:'https://static.chabyulhwa.com/a.jpg'}]}]){
  const s=await server({getTask:()=>Response.json({data:task({taskAttachments:[{typeText:'냉장고 문은 잘 닫았나요?',images:[image]}]})})});try{const v=await json(s);assert.equal(v.status,503);assert.equal(v.body.error.code,'PHOTO_IMAGES_INVALID');assert.equal(s.stats().mediaReads,0);}finally{await s.close();}
 }
});
test('JSON/content-type errors expose only allowed code/stage/http, never body',async()=>{
 for(const [response,code] of [[new Response('PRIVATE_SENTINEL',{headers:{'content-type':'text/html'}}),'PHOTO_CONTENT_TYPE_INVALID'],[new Response('PRIVATE_SENTINEL',{headers:{'content-type':'application/json'}}),'PHOTO_JSON_INVALID']]){
  const s=await server({getTask:()=>response});try{const v=await json(s);assert.equal(v.status,502);assert.equal(v.body.error.code,code);assert.equal(v.body.error.sourceHttpStatus,200);assert(!JSON.stringify(v).includes('PRIVATE_SENTINEL'));}finally{await s.close();}
 }
});
test('media rejects unapproved host, invalid content-type, and oversized body without disclosing media URLs',async()=>{
 for(const options of [
  {getTask:()=>Response.json({data:task({taskAttachments:[{typeText:'냉장고 문은 잘 닫았나요?',images:[{url:'https://example.test/a.jpg'}]}]})})},
  {mediaType:'text/html'},
  {mediaBytes:new Uint8Array(4*1024*1024+1)}
 ]){const s=await server(options);try{const v=await json(s);if(options.getTask){assert.equal(v.status,403);assert.equal(v.body.error.code,'MEDIA_ORIGIN_REJECTED');assert.equal(s.stats().mediaReads,0);}else{const r=await fetch(s.url+v.body.data.deliveries[0].photos[0].url,{headers});assert.equal(r.status,options.mediaType?502:413);assert(!JSON.stringify(await r.json()).includes('chabyulhwa'));}}finally{await s.close();}}
});
test('concurrent request is rejected while one bounded requester is active',async()=>{
 let release,started;const begin=new Promise(r=>{started=r;}),pause=new Promise(r=>{release=r;});
 const s=await server({rawHook:async()=>{started();await pause;}});try{const first=json(s);await begin;const second=await json(s);assert.equal(second.status,429);release();assert.equal((await first).status,200);assert.equal(s.stats().rawReads,1);}finally{release();await s.close();}
});
test('Production candidate binds only the approved raw requester and keeps its actual staff authentication',async()=>{
 const origin='https://production.example.test',password='synthetic-photo-test-only',env={OPSMAP_PRODUCTION_CANDIDATE_ENABLED:'1',OPSMAP_AUTH_ID:'fixture',OPSMAP_AUTH_PASSWORD_HASH:await createStaffPasswordHash(password),OPSMAP_AUTH_SESSION_SECRET:'s'.repeat(43),OPSMAP_AUTH_ORIGIN:origin,OPSMAP_PRODUCTION_PHOTO_VERIFY:'1',OPSMAP_PHOTO_APPROVAL_ID:approvalId,OPSMAP_PHOTO_APPROVED_RECORDS:JSON.stringify([record])};
 const sessions=new Map(),sessionStore={kind:'ISOLATED_TEST_STORE',get:async k=>sessions.get(k),set:async(k,v)=>sessions.set(k,v),touch:async(k,v)=>{if(!sessions.has(k))return false;sessions.set(k,v);return true;},delete:async k=>sessions.delete(k)};
 const app=express(),b=ledger();let rawReads=0;
 mountProductionOpsmapCandidate(app,{env,sessionStore,publicDir:fileURLToPath(new URL('../public',import.meta.url)),photoHasMemorySession:()=>true,photoRawRequest:async path=>{rawReads++;assert.equal(path,'/api/bali/task/'+record.deliveryId);return Response.json({data:task()});},reservePhotoRead:b.reserve,readPhase2bSnapshot:async()=>({rows:[]}),getSnapshotMemory:()=>({rows:[]})});
 const instance=app.listen(0,'127.0.0.1');await new Promise(r=>instance.once('listening',r));const base='http://127.0.0.1:'+instance.address().port,path='/opsmap'+endpoint+query();
 try{
  assert.equal((await fetch(base+path)).status,401);assert.equal(rawReads,0);
  const login=await fetch(base+'/opsmap/api/map-phase2b/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({id:'fixture',password})});assert.equal(login.status,200);
  const auth={origin,cookie:login.headers.get('set-cookie').split(';')[0]},r=await fetch(base+path,{headers:auth}),value=await r.json();assert.equal(r.status,200);assert.equal(value.data.deliveries[0].photos.length,1);assert.equal(rawReads,1);assert.match(r.headers.get('cache-control'),/no-store/);
  assert.equal((await fetch(base+'/opsmap/api/map-phase2b/auth/logout',{method:'POST',headers:auth})).status,200);assert.equal((await fetch(base+path,{headers:auth})).status,401);assert.equal(rawReads,1);
 }finally{await new Promise(r=>instance.close(r));}
});
