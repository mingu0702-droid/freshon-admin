// Dedicated, explicit-opt-in staff writes. Reuses the existing durable file adapter.
import path from'node:path';import os from'node:os';import fs from'node:fs/promises';import fsSync from'node:fs';import crypto from'node:crypto';import express from'express';
import{createFileCoordinateStore}from'./opsmapCoordinateIngestion.js';
import{coordinateAddressHash}from'./opsmapAutoCoordinates.js';
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const codeValid=v=>typeof v==='string'&&/^[A-Z]\d{1,20}$/.test(v),point=p=>p&&typeof p.latitude==='number'&&typeof p.longitude==='number'&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&p.latitude>=33&&p.latitude<=39.5&&p.longitude>=124&&p.longitude<=132;
const location=v=>typeof v==='string'&&v.length<=500&&!/[\r\n\x00-\x1f]|비번|비밀번호|출입|보안키|도어락|password|token|secret|cookie|https?:|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/i.test(v)?v.trim():null;
const failure=(code,status=409)=>Object.assign(Error(code),{code,status});
export const isManualPinWriteRequest=req=>req.method==='POST'&&/^\/api\/map-phase2b\/private\/manual-pins\/[A-Z]\d{1,20}\/(?:save|revert|reserve-search)$/.test(req.path);
// A confirmation flag alone cannot make Render's container filesystem durable.
export function manualPinRenderMountVerified(env,readMountInfo=()=>fsSync.readFileSync('/proc/self/mountinfo','utf8'),realpath=p=>fsSync.realpathSync(p)){
 if(env.RENDER!=='true'&&!env.RENDER_SERVICE_ID)return true;
 try{
  const root=env.OPSMAP_MANUAL_PIN_DURABLE_ROOT,file=env.OPSMAP_MANUAL_PIN_STORE_FILE;
  if(!root||!file||!path.isAbsolute(root)||!path.isAbsolute(file)||root==='/')return false;
  const actualRoot=realpath(root),actualParent=realpath(path.dirname(file));
  if(actualParent!==actualRoot&&!actualParent.startsWith(actualRoot+path.sep))return false;
  const decode=v=>v.replace(/\\([0-7]{3})/g,(_,n)=>String.fromCharCode(parseInt(n,8)));
  return readMountInfo().split('\n').some(line=>{const [left,right]=line.split(' - ');if(!right)return false;const mount=decode(left.split(' ')[4]||''),kind=right.split(' ')[0];return mount===actualRoot&&!['overlay','tmpfs','ramfs','proc','sysfs','devtmpfs','squashfs'].includes(kind);});
 }catch{return false;}
}
export function createManualMapPins({env=process.env,appRoot,readCustomer,readCoordinate=()=>null,now=Date.now,store:providedStore,backupStore:providedBackup,authorizeWrite}={}){
 const file=env.OPSMAP_MANUAL_PIN_STORE_FILE,configured=Boolean((file||providedStore)&&typeof readCustomer==='function');
 let store=providedStore,backup=providedBackup;
 if(configured&&!store){
  if(!path.isAbsolute(file)||!appRoot||path.resolve(file).startsWith(path.resolve(appRoot)+path.sep)||path.resolve(file).startsWith(path.resolve(os.tmpdir())+path.sep))throw failure('MANUAL_PIN_PRIVATE_DURABLE_PATH_REQUIRED',503);
  store=createFileCoordinateStore({filePath:file});backup=createFileCoordinateStore({filePath:file+'.backup.json'});
 }
 const canWrite=()=>configured&&env.OPSMAP_MANUAL_PIN_WRITES==='1'&&env.OPSMAP_MANUAL_PIN_DURABLE_CONFIRMED==='1'&&(providedStore?.kind==='github-production-cas-v1'||manualPinRenderMountVerified(env))&&typeof authorizeWrite==='function'&&Boolean(env.MAP_STAFF_ID)&&env.OPSMAP_MANUAL_PIN_WRITER_ID===env.MAP_STAFF_ID;
 const searchCache=new Map(),cacheFile=env.OPSMAP_MANUAL_PIN_SEARCH_CACHE_FILE;
 if(cacheFile){
  if(!path.isAbsolute(cacheFile)||path.resolve(cacheFile).startsWith(path.resolve(appRoot)+path.sep)||fsSync.statSync(cacheFile).size>1048576)throw failure('MANUAL_PIN_SEARCH_CACHE_PATH',503);
  const raw=fsSync.readFileSync(cacheFile);if(crypto.createHash('sha256').update(raw).digest('hex')!==env.OPSMAP_MANUAL_PIN_SEARCH_CACHE_SHA256)throw failure('MANUAL_PIN_SEARCH_CACHE_HASH',503);
  const cache=JSON.parse(raw);if(cache.schema!=='opsmap-private-address-search-cache-v1'||!Array.isArray(cache.rows)||cache.rows.length>1000)throw failure('MANUAL_PIN_SEARCH_CACHE_CONTRACT',503);
  for(const r of cache.rows){if(!/^[a-f0-9]{64}$/.test(r.queryHash||'')||!point(r)||!/^[a-f0-9]{64}$/.test(r.sourceReceiptHash||''))throw failure('MANUAL_PIN_SEARCH_CACHE_CONTRACT',503);const list=searchCache.get(r.queryHash)||[];list.push({latitude:r.latitude,longitude:r.longitude,label:'기존 주소 검색의 건물 위치',sourceReceiptHash:r.sourceReceiptHash});searchCache.set(r.queryHash,list);}
 }
 const lookupSavedSearch=query=>searchCache.get(coordinateAddressHash(query))||[];
 function container(state){state.manualPins??={schema:1,operations:0,customers:{}};const m=state.manualPins;if(m.schema!==1||!Number.isSafeInteger(m.operations)||m.operations<0||!m.customers||Array.isArray(m.customers))throw failure('MANUAL_PIN_STORAGE_INVALID',503);return m;}
 function verify(record,code){
  if(!record)return;let prior=null,revision=0;
  if(!Array.isArray(record.history)||record.history.length>2000)throw failure('MANUAL_PIN_AUDIT_INVALID',503);
  for(const e of record.history){const {hash,...body}=e;if(e.customerCode!==code||e.revision!==++revision||e.previousHash!==prior||digest(body)!==hash||e.after!==null&&(!point(e.after)||e.after.customerCode!==code||e.after.coordinateSource!=='MANUAL_PIN'||e.after.resolutionStatus!=='MANUAL_CONFIRMED'))throw failure('MANUAL_PIN_AUDIT_INVALID',503);prior=hash;}
  if(record.revision!==revision||record.head!==prior||digest(record.current)!==digest(record.history.at(-1)?.after??null))throw failure('MANUAL_PIN_AUDIT_INVALID',503);
 }
 async function source(code){const row=await readCustomer(code);if(!row||row.customerCode!==code||!location(row.address))throw failure('MANUAL_PIN_CUSTOMER_ADDRESS_UNAVAILABLE',503);return {...row,address:location(row.address),originalAddressHash:coordinateAddressHash(row.address)};}
 async function selected(code){if(!codeValid(code))throw failure('MANUAL_PIN_CUSTOMER_CODE',400);if(!configured||!store)throw failure('MANUAL_PIN_STORE_NOT_CONFIGURED',503);const customer=await source(code);return store.transaction(async state=>{
  const record=container(state).customers[code];verify(record,code);return {customerCode:code,customerName:customer.customerName,originalAddress:customer.address,originalAddressHash:customer.originalAddressHash,sourceVersion:customer.sourceDriveVersion||null,revision:record?.revision||0,
   current:record?.current||null,addressChanged:Boolean(record?.current&&record.current.originalAddressHash!==customer.originalAddressHash),previousCoordinate:readCoordinate(code),history:(record?.history||[]).slice(-20).reverse(),canWrite:canWrite(),actorLabel:'공유계정 수정',addressRegion:customer.addressRegion||null};
 });}
 async function projection(){if(!configured||!store)return [];return store.transaction(async state=>{
  const rows=[];for(const [code,r]of Object.entries(container(state).customers)){verify(r,code);if(!r.current)continue;const customer=await source(code),matched=r.current.originalAddressHash===customer.originalAddressHash;
   rows.push({customerCode:code,revision:r.revision,originalAddressHash:r.current.originalAddressHash,coordinateSource:'MANUAL_PIN',resolutionStatus:matched?'MANUAL_CONFIRMED':'ADDRESS_CHANGED_REVIEW_REQUIRED',latitude:matched?r.current.latitude:null,longitude:matched?r.current.longitude:null,updatedAt:r.current.updatedAt});}
  return rows;
 });}
 async function mutate(code,action,body,{assertSession=()=>{},actorLabel='공유계정 수정'}={}){
  if(!canWrite())throw failure('MANUAL_PIN_WRITE_PERMISSION_REQUIRED',403);
  if(!codeValid(code)||!body||Object.keys(body).some(k=>!['originalAddressHash','expectedRevision','requestId','latitude','longitude','correctedSearchAddress','targetRevision'].includes(k))||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||typeof body.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(body.requestId)||!/^[a-f0-9]{64}$/.test(body.originalAddressHash||''))throw failure('MANUAL_PIN_INPUT',400);
  if(action==='save'&&(!point(body)||body.correctedSearchAddress!==undefined&&body.correctedSearchAddress!==''&&!location(body.correctedSearchAddress)))throw failure('MANUAL_PIN_POINT_OR_SEARCH_ADDRESS',400);
  const customer=await source(code);if(customer.originalAddressHash!==body.originalAddressHash)throw failure('MANUAL_PIN_ADDRESS_CHANGED');
  const requestHash=digest({code,action,body});
  return store.transaction(async(state,checkpoint)=>{
   const m=container(state),record=m.customers[code]||{revision:0,current:null,history:[],head:null};verify(record,code);
   const duplicate=record.history.find(e=>e.requestId===body.requestId);
   if(duplicate){if(duplicate.requestHash!==requestHash||duplicate.revision!==record.revision)throw failure('MANUAL_PIN_OPERATION_SUPERSEDED');await assertSession();return {customerCode:code,revision:record.revision,current:record.current,idempotent:true};}
   if(record.revision!==body.expectedRevision)throw failure('MANUAL_PIN_REVISION_CONFLICT');
   if(m.operations>=2000)throw failure('MANUAL_PIN_STORAGE_OPERATION_LIMIT',507);
   const timestamp=new Date(now()).toISOString(),modifiedBy={type:'SHARED_STAFF_ACCOUNT',label:actorLabel};let next;
   if(action==='save')next={customerCode:code,correctedSearchAddressHash:body.correctedSearchAddress?coordinateAddressHash(location(body.correctedSearchAddress)):null,latitude:body.latitude,longitude:body.longitude,coordinateSource:'MANUAL_PIN',resolutionStatus:'MANUAL_CONFIRMED',originalAddressHash:customer.originalAddressHash,updatedAt:timestamp,modifiedBy};
   else if(action==='revert'){
    if(!Number.isSafeInteger(body.targetRevision)||body.targetRevision<0||body.targetRevision>=record.revision)throw failure('MANUAL_PIN_REVERT_REVISION',400);
    const target=body.targetRevision===0?null:record.history.find(e=>e.revision===body.targetRevision)?.after;
    if(target===undefined||target&&target.originalAddressHash!==customer.originalAddressHash)throw failure('MANUAL_PIN_REVERT_ADDRESS_CHANGED');
    next=target?{...target,updatedAt:timestamp,modifiedBy}:null;
   }else throw failure('MANUAL_PIN_OPERATION',400);
   await assertSession();const currentCustomer=await source(code);if(currentCustomer.originalAddressHash!==customer.originalAddressHash)throw failure('MANUAL_PIN_ADDRESS_CHANGED');
   // One bounded previous normal snapshot, plus the complete append-only audit.
   await backup.transaction(async(_old,save)=>save(structuredClone(state)));
   await assertSession();
   const event={customerCode:code,revision:record.revision+1,operation:action,requestId:body.requestId,requestHash,originalAddressHash:customer.originalAddressHash,updatedAt:timestamp,modifiedBy,previousHash:record.head,
    before:record.current,previousCoordinate:record.revision?null:readCoordinate(code),after:next};event.hash=digest(event);
   m.customers[code]={revision:event.revision,current:next,history:[...record.history,event],head:event.hash};m.operations++;
   await checkpoint(state);
   if(file&&!providedStore){const readback=JSON.parse(await fs.readFile(file,'utf8'));verify(container(readback).customers[code],code);if(container(readback).customers[code].head!==event.hash)throw failure('MANUAL_PIN_READBACK_UNKNOWN',503);}
   return {customerCode:code,revision:event.revision,current:next,idempotent:false};
  });
 }
 const csrf=key=>crypto.createHmac('sha256',env.MAP_STAFF_SESSION_SECRET||'').update('manual-map-pin:'+key).digest('hex');
 return {selected,projection,mutate,canWrite,configured,lookupSavedSearch,mount({app,requireStaff,isSessionCurrent}){
  if(typeof requireStaff!=='function'||typeof isSessionCurrent!=='function')throw Error('EXISTING_STAFF_AUTH_REQUIRED');
  const base='/api/map-phase2b/private/manual-pins';app.use(base,requireStaff,(_q,r,next)=>{r.set('Cache-Control','private, no-store');next();});
  const wrap=fn=>async(q,r)=>{try{await fn(q,r);}catch(e){r.status(e.status||503).json({ok:false,error:/^MANUAL_PIN_[A-Z_]+$/.test(e.code||'')?e.code:'MANUAL_PIN_STORAGE_UNAVAILABLE'});}};
  app.get(base+'/projection',wrap(async(q,r)=>{const data=await projection();return requireStaff(q,r,()=>r.json({ok:true,data}));}));
  app.get(base+'/:code',wrap(async(q,r)=>{const data=await selected(q.params.code);data.canWrite=data.canWrite&&(await authorizeWrite(q,r.locals.staffSession))===true;return requireStaff(q,r,()=>r.json({ok:true,data,csrfToken:data.canWrite?csrf(r.locals.staffSession.key):null}));}));
  app.get(base+'/:code/search',wrap(async(q,r)=>{
   if(!codeValid(q.params.code))throw failure('MANUAL_PIN_CUSTOMER_CODE',400);await source(q.params.code);
   let query;try{query=decodeURIComponent(q.get('x-map-search-address')||'');}catch{throw failure('MANUAL_PIN_SEARCH_ADDRESS',400);}if(!location(query))throw failure('MANUAL_PIN_SEARCH_ADDRESS',400);
   return requireStaff(q,r,()=>r.json({ok:true,data:lookupSavedSearch(query),liveSearchRequiresReservation:true}));
  }));
  app.post(base+'/:code/:action',express.json({limit:'4kb'}),wrap(async(q,r)=>{
   const origin=env.RENDER_EXTERNAL_URL||env.MAP_STAFF_ORIGIN,site=q.get('sec-fetch-site'),token=q.get('x-map-pin-csrf');
   if(!canWrite())throw failure('MANUAL_PIN_WRITE_PERMISSION_REQUIRED',403);
   if(q.get('origin')!==origin||site&&!['same-origin','none'].includes(site)||!q.is('application/json')||typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||!crypto.timingSafeEqual(Buffer.from(token),Buffer.from(csrf(r.locals.staffSession.key))))throw failure('MANUAL_PIN_CSRF_REJECTED',403);
   const key=r.locals.staffSession.key,assertSession=async()=>{if(!isSessionCurrent(q,key))throw failure('MANUAL_PIN_SESSION_EXPIRED',401);if((await authorizeWrite(q,r.locals.staffSession))!==true)throw failure('MANUAL_PIN_WRITE_PERMISSION_REQUIRED',403);};await assertSession();
   if(q.params.action==='reserve-search'){
    if(!codeValid(q.params.code)||Object.keys(q.body||{}).some(k=>k!=='query')||!location(q.body?.query))throw failure('MANUAL_PIN_SEARCH_ADDRESS',400);await source(q.params.code);
    const maximum=Number(env.OPSMAP_MANUAL_PIN_GEOCODER_ALLOWANCE||0);if(!Number.isSafeInteger(maximum)||maximum<1||maximum>200)throw failure('MANUAL_PIN_GEOCODER_BUDGET_EXHAUSTED',429);
    const data=await store.transaction(async(state,checkpoint)=>{const m=container(state);m.searchReservations??=[];const hash=coordinateAddressHash(q.body.query);if(m.searchReservations.length>=maximum||m.searchReservations.some(r=>r.queryHash===hash))throw failure('MANUAL_PIN_GEOCODER_BUDGET_EXHAUSTED',429);await assertSession();const id=crypto.randomUUID();m.searchReservations.push({id,queryHash:hash,customerCode:q.params.code,reservedAt:new Date(now()).toISOString(),maximumAtReservation:maximum});await checkpoint(state);return {reservationId:id,maxCalls:1,retries:0};});return requireStaff(q,r,()=>r.json({ok:true,data}));
   }
   const data=await mutate(q.params.code,q.params.action,q.body,{assertSession});return requireStaff(q,r,()=>r.json({ok:true,data}));
  }));
  app.use(base,(error,_q,r,_next)=>r.status(error?.type==='entity.too.large'?413:400).json({ok:false,error:'MANUAL_PIN_INPUT'}));
 }};
}
