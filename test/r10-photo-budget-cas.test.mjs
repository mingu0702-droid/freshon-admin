import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {createProductionPhotoBudgetStore,sealPhotoBudgetState,validatePhotoBudgetState} from '../src/productionPhotoBudgetStore.js';
import {createProductionPhotoExtension} from '../src/opsmapProductionPhotos.js';
const now=Date.parse('2026-11-03T00:00:00.000Z'),approvalId='synthetic-new-approval-01';
const identity={customerCode:'S990001',date:'2026-11-02',deliveryId:'990001',firstKind:'REFRIGERATOR_DOOR'};
const env={OPSMAP_PHOTO_BUDGET_STORE_ENABLED:'1',OPSMAP_PHOTO_BUDGET_STORE_REPO:'mingu0702-droid/freshon-cache',OPSMAP_PHOTO_BUDGET_STORE_BRANCH:'production/opsmap-photo-budget'};
const seed=(status='APPROVED')=>sealPhotoBudgetState({schema:1,scope:'PRODUCTION_PHOTO_READ_BUDGET',revision:0,legacy:{remainingState:'UNCONFIRMED_NOT_RESET',priorAutomaticMediaLoadsObserved:9,exactDetailPotentiallyUsed:1,laterRecordedDetailAttempts:1},approvals:[{approvalId,status,...identity,approvedAt:status==='PENDING'?null:'2026-11-02T23:00:00.000Z',expiresAt:status==='PENDING'?null:'2026-11-04T00:00:00.000Z',limits:{login:0,detail:2,media:1},used:{login:0,detail:0,media:0},reservations:[]}]});
const digest=value=>crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
function fakeGithub({value=seed(),privateRepo=true,conflict=false,badReadback=false,ambiguousWrite=false}={}){
 let state=structuredClone(value),sha=digest(state),writes=0;const calls=[];
 const old=structuredClone(state);
 return {calls,get state(){return state;},get writes(){return writes;},fetch:async(url,options={})=>{
  const u=new URL(url),method=options.method||'GET';calls.push({method,path:u.pathname,query:u.search});assert.equal(u.origin,'https://api.github.com');
  assert.match(options.headers.Authorization,/^Bearer synthetic-token$/);
  if(u.pathname==='/repos/mingu0702-droid/freshon-cache')return Response.json({private:privateRepo,permissions:{push:true}});
  assert.equal(u.pathname,'/repos/mingu0702-droid/freshon-cache/contents/opsmap-production/photo-budget-v1.json');
  if(method==='GET'){assert.equal(u.searchParams.get('ref'),env.OPSMAP_PHOTO_BUDGET_STORE_BRANCH);if(state===null)return new Response(null,{status:404});const content=badReadback&&writes?old:state;return Response.json({sha,encoding:'base64',content:Buffer.from(JSON.stringify(content)).toString('base64')});}
  assert.equal(method,'PUT');writes++;const b=JSON.parse(options.body);assert.equal(b.branch,env.OPSMAP_PHOTO_BUDGET_STORE_BRANCH);assert.equal(b.sha.length,40);
  if(conflict||b.sha!==sha)return new Response(null,{status:409});
  state=JSON.parse(Buffer.from(b.content,'base64').toString('utf8'));sha=digest(state);
  if(ambiguousWrite)throw Error('PRIVATE_PROVIDER_BODY_MUST_NOT_LEAK');return Response.json({content:{sha}});
 }};
}
const store=github=>createProductionPhotoBudgetStore({env,token:'synthetic-token',fetchImpl:github.fetch,now:()=>now});
const request=operation=>({approvalId,operation,...identity});

test('CAS consumes detail2/media1 only after pre-existing approval, then remains exhausted after a new process',async()=>{
 const github=fakeGithub(),initial=structuredClone(github.state),first=store(github);
 assert.equal((await first.reserve(request('detail'))).reserved,true);assert.equal((await first.reserve(request('detail'))).reserved,true);assert.equal((await first.reserve(request('media'))).reserved,true);
 const saved=validatePhotoBudgetState(github.state);assert.deepEqual(saved.legacy,initial.legacy);assert.equal(saved.revision,3);assert.deepEqual(saved.approvals[0].used,{login:0,detail:2,media:1});assert.equal(github.writes,3);
 await assert.rejects(store(github).reserve(request('media')),e=>e.code==='PHOTO_BUDGET_EXHAUSTED');assert.equal(github.writes,3);
});
test('disabled/unconfigured/Stage connection cannot issue reads or create the budget file',async()=>{
 let calls=0;assert.equal(createProductionPhotoBudgetStore({env:{},fetchImpl:()=>{calls++;}}),undefined);
 for(const invalid of [{OPSMAP_PHOTO_BUDGET_STORE_BRANCH:'stage/opsmap-photo-budget'},{OPSMAP_PHOTO_BUDGET_STORE_REPO:'other/private'},{RENDER_SERVICE_ID:'srv-da47hugu01pc73etpfa0'},{RENDER_EXTERNAL_URL:'https://freshon-admin-stage-preview-template.onrender.com'}])assert.throws(()=>createProductionPhotoBudgetStore({env:{...env,...invalid},token:'synthetic-token',fetchImpl:()=>{calls++;}}),e=>e.code==='PHOTO_BUDGET_NOT_CONFIGURED');assert.equal(calls,0);
 const github=fakeGithub({value:null});await assert.rejects(store(github).reserve(request('detail')),e=>e.code==='PHOTO_BUDGET_NOT_INITIALIZED');assert.equal(github.writes,0);
});
test('pending/revoked/expired/mismatched customer-date-id-category and login never receive a reservation',async()=>{
 for(const value of [seed('PENDING'),seed('REVOKED')]){const github=fakeGithub({value});await assert.rejects(store(github).reserve(request('detail')),e=>e.code==='PHOTO_BUDGET_NOT_APPROVED');assert.equal(github.writes,0);}
 for(const change of [{approvalId:'another-approval'},{customerCode:'S990002'},{date:'2026-11-01'},{deliveryId:'990002'},{firstKind:'ENTRANCE_LOCK'},{operation:'login'}]){const github=fakeGithub();await assert.rejects(store(github).reserve({...request('detail'),...change}),e=>e.code==='PHOTO_BUDGET_NOT_APPROVED');assert.equal(github.writes,0);}
 const expired=seed();expired.approvals[0].expiresAt='2026-11-02T23:59:59.000Z';delete expired.sha256;const github=fakeGithub({value:sealPhotoBudgetState(expired)});await assert.rejects(store(github).reserve(request('detail')),e=>e.code==='PHOTO_BUDGET_NOT_APPROVED');assert.equal(github.writes,0);
});
test('media reservation requires both exact task reads and malformed/altered ledger is not reset',async()=>{
 const github=fakeGithub();await assert.rejects(store(github).reserve(request('media')),e=>e.code==='PHOTO_BUDGET_NOT_APPROVED');assert.equal(github.writes,0);
 const malformed=seed();malformed.approvals[0].used.detail=1;const bad=fakeGithub({value:malformed});await assert.rejects(store(bad).reserve(request('detail')),e=>e.code==='PHOTO_BUDGET_INVALID');assert.equal(bad.writes,0);
 const leaked=seed();leaked.password='PRIVATE_SENTINEL';delete leaked.sha256;assert.throws(()=>validatePhotoBudgetState(sealPhotoBudgetState(leaked)),e=>e.code==='PHOTO_BUDGET_INVALID');
});
test('CAS conflict, ambiguous write and mismatching read-back never return permission or retry',async()=>{
 for(const options of [{conflict:true},{badReadback:true},{ambiguousWrite:true},{privateRepo:false}]){const github=fakeGithub(options);let result;try{result=await store(github).reserve(request('detail'));assert.fail('UNEXPECTED_SOURCE_PERMISSION');}catch(error){assert.match(error.code,/^PHOTO_BUDGET_/);assert(!JSON.stringify(error).includes('PRIVATE_PROVIDER'));}assert.equal(result,undefined);assert.equal(github.writes,options.privateRepo===false?0:1);}
});
test('two workers using one old SHA cannot overspend the same reservation',async()=>{
 const github=fakeGithub(),one=store(github),two=store(github);const values=await Promise.allSettled([one.reserve(request('detail')),two.reserve(request('detail'))]);assert.equal(values.filter(v=>v.status==='fulfilled').length,1);assert.equal(values.filter(v=>v.status==='rejected').length,1);assert.equal(github.state.approvals[0].used.detail,1);assert.equal(github.state.approvals[0].reservations.length,1);assert.equal(github.writes,2);
});
test('already cancelled request never reads or reserves',async()=>{
 const github=fakeGithub();await assert.rejects(store(github).reserve(request('detail'),{signal:AbortSignal.abort()}),e=>e.code==='PHOTO_TIMEOUT');assert.equal(github.calls.length,0);
});
test('wired CAS read-back happens before each of two exact details and one media; failed read-back issues none',async()=>{
 for(const badReadback of [false,true]){
  const github=fakeGithub({badReadback}),budget=store(github),app=express();let details=0,media=0;
  const extension=createProductionPhotoExtension({enabled:true,approvalId,approvedRecords:[identity],reserveRead:budget.reserve,hasMemorySession:()=>true,
   rawRequest:async path=>{details++;assert.equal(path,'/api/bali/task/'+identity.deliveryId);assert.equal(github.state.approvals[0].used.detail,details);return Response.json({data:{id:identity.deliveryId,customer:{erpCode:identity.customerCode},carrier:{enteringDatedAt:identity.date+'T00:00:00+09:00'},taskAttachments:[{typeText:'냉장고 문은 잘 닫았나요?',images:[{url:'https://static.chabyulhwa.com/synthetic.jpg'}]}]}});},
   imageFetch:async()=>{media++;assert.equal(github.state.approvals[0].used.media,1);return new Response(new Uint8Array([255,216,255,217]),{headers:{'content-type':'image/jpeg','content-length':'4'}});}});
  extension.mount({app,previewEnabled:()=>true,isSessionCurrent:()=>true,requireStaff:(_q,r,next)=>{r.locals.staffSession={key:'synthetic',expiresAt:now+864000000000,idleExpiresAt:now+864000000000};return next();}});
  const instance=app.listen(0,'127.0.0.1');await new Promise(r=>instance.once('listening',r));const base='http://127.0.0.1:'+instance.address().port;
  try{
   const response=await fetch(base+'/api/map-phase2b/private/delivery-photos?'+new URLSearchParams({customerCode:identity.customerCode,date:identity.date,deliveryId:identity.deliveryId})),value=await response.json();
   if(badReadback){assert.equal(response.status,503);assert.equal(value.error.code,'PHOTO_BUDGET_READBACK_UNVERIFIED');assert.equal(details,0);assert.equal(media,0);continue;}
   assert.equal(response.status,200);const image=await fetch(base+value.data.deliveries[0].photos[0].url);assert.equal(image.status,200);await image.arrayBuffer();assert.equal(details,2);assert.equal(media,1);assert.deepEqual(github.state.approvals[0].used,{login:0,detail:2,media:1});
  }finally{await new Promise(r=>instance.close(r));}
 }
});
