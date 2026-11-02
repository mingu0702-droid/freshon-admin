// Reuses the private GitHub Contents SHA-CAS adapter; never creates a grant/file.
import crypto from 'node:crypto';
import {createPrivateGithubJsonStore} from './fixedVehicleStore.js';
import {validatePhotoQuery} from './opsmapDeliveryPhotos.js';
const file='photo-budget-v1.json',scope='PRODUCTION_PHOTO_READ_BUDGET';
const fail=(code,status=503)=>{throw Object.assign(Error(code),{code,status});};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex');
const keys=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===names.split('|').sort().join('|');
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export function sealPhotoBudgetState(value){const {sha256,...body}=value;return {...body,sha256:hash(body)};}
export function validatePhotoBudgetState(value){
 if(!keys(value,'schema|scope|revision|legacy|approvals|sha256')||value.schema!==1||value.scope!==scope||!integer(value.revision))fail('PHOTO_BUDGET_INVALID');
 const {sha256,...body}=value;if(!/^[a-f0-9]{64}$/.test(sha256||'')||sha256!==hash(body))fail('PHOTO_BUDGET_INVALID');
 const old=value.legacy;
 if(!keys(old,'remainingState|priorAutomaticMediaLoadsObserved|exactDetailPotentiallyUsed|laterRecordedDetailAttempts')||old.remainingState!=='UNCONFIRMED_NOT_RESET'||!integer(old.priorAutomaticMediaLoadsObserved)||old.priorAutomaticMediaLoadsObserved<9||!integer(old.exactDetailPotentiallyUsed)||old.exactDetailPotentiallyUsed<1||!integer(old.laterRecordedDetailAttempts)||old.laterRecordedDetailAttempts<1)fail('PHOTO_BUDGET_INVALID');
 if(!Array.isArray(value.approvals)||value.approvals.length>100)fail('PHOTO_BUDGET_INVALID');
 const ids=new Set(),reservations=new Set();
 for(const record of value.approvals){
  if(!keys(record,'approvalId|status|customerCode|date|deliveryId|firstKind|approvedAt|expiresAt|limits|used|reservations')||!/^[A-Za-z0-9_-]{8,128}$/.test(record.approvalId||'')||ids.has(record.approvalId))fail('PHOTO_BUDGET_INVALID');ids.add(record.approvalId);
  try{const id=validatePhotoQuery(record);if(!id.date||!id.deliveryId)fail('PHOTO_BUDGET_INVALID');}catch{fail('PHOTO_BUDGET_INVALID');}
  if(!['PENDING','APPROVED','REVOKED'].includes(record.status)||!['REFRIGERATOR_DOOR','ENTRANCE_LOCK'].includes(record.firstKind))fail('PHOTO_BUDGET_INVALID');
  if(record.status==='PENDING'?(record.approvedAt!==null||record.expiresAt!==null):(!iso(record.approvedAt)||!iso(record.expiresAt)||record.expiresAt<=record.approvedAt))fail('PHOTO_BUDGET_INVALID');
  if(!keys(record.limits,'login|detail|media')||record.limits.login!==0||record.limits.detail!==2||record.limits.media!==1||!keys(record.used,'login|detail|media'))fail('PHOTO_BUDGET_INVALID');
  for(const op of ['login','detail','media'])if(!integer(record.used[op])||record.used[op]>record.limits[op])fail('PHOTO_BUDGET_INVALID');
  if(!Array.isArray(record.reservations)||record.reservations.length>3)fail('PHOTO_BUDGET_INVALID');
  const counts={login:0,detail:0,media:0};
  for(const reservation of record.reservations){
   if(!keys(reservation,'id|operation|createdAt')||!/^[-a-f0-9]{36}$/.test(reservation.id||'')||reservations.has(reservation.id)||!['detail','media'].includes(reservation.operation)||!iso(reservation.createdAt))fail('PHOTO_BUDGET_INVALID');
   reservations.add(reservation.id);counts[reservation.operation]++;
  }
  if(['login','detail','media'].some(op=>counts[op]!==record.used[op])||record.status==='PENDING'&&record.reservations.length)fail('PHOTO_BUDGET_INVALID');
 }
 if(value.revision!==reservations.size)fail('PHOTO_BUDGET_INVALID');
 return value;
}
export function createProductionPhotoBudgetStore({env=process.env,token=env.OPSMAP_PHOTO_BUDGET_STORE_TOKEN,fetchImpl=fetch,now=Date.now}={}){
 if(env.OPSMAP_PHOTO_BUDGET_STORE_ENABLED!=='1')return undefined;
 if(env.OPSMAP_PHOTO_BUDGET_STORE_REPO!=='mingu0702-droid/freshon-cache'||env.OPSMAP_PHOTO_BUDGET_STORE_BRANCH!=='production/opsmap-photo-budget'||!token)fail('PHOTO_BUDGET_NOT_CONFIGURED');
 if(env.RENDER_SERVICE_ID&&env.RENDER_SERVICE_ID!=='srv-d87gc5rtqb8s7398t37g'||env.RENDER_EXTERNAL_URL&&env.RENDER_EXTERNAL_URL.replace(/\/$/,'')!=='https://freshon-admin-1.onrender.com')fail('PHOTO_BUDGET_NOT_CONFIGURED');
 const adapter=createPrivateGithubJsonStore({env:{GITHUB_CACHE_REPO:env.OPSMAP_PHOTO_BUDGET_STORE_REPO,GITHUB_TOKEN:token,GITHUB_CACHE_BRANCH:env.OPSMAP_PHOTO_BUDGET_STORE_BRANCH,GITHUB_CACHE_DIR:'opsmap-production'},fetchImpl,now});
 const aborted=signal=>{if(signal?.aborted)fail('PHOTO_TIMEOUT',504);};
 const safeFailure=error=>{
  if(/^PHOTO_BUDGET_[A-Z_]+$/.test(error?.code||'')||error?.code==='PHOTO_TIMEOUT')throw error;
  fail(error?.code==='FIXED_STORE_CONFLICT'?'PHOTO_BUDGET_CONFLICT':'PHOTO_BUDGET_UNAVAILABLE',error?.code==='FIXED_STORE_CONFLICT'?409:503);
 };
 return {kind:'PRIVATE_GITHUB_PHOTO_BUDGET_CAS',async reserve(input,{signal}={}){
  try{
   aborted(signal);
   if(!keys(input,'approvalId|operation|customerCode|date|deliveryId|firstKind')||!['detail','media'].includes(input.operation))fail('PHOTO_BUDGET_NOT_APPROVED');
   const identity=validatePhotoQuery(input);if(!identity.date||!identity.deliveryId)fail('PHOTO_BUDGET_NOT_APPROVED');
   const old=await adapter.read(file);aborted(signal);
   // Missing file/branch must never become permission to create a new allowance.
   if(!old.value||!/^[a-f0-9]{40}$/.test(old.sha||''))fail('PHOTO_BUDGET_NOT_INITIALIZED');
   validatePhotoBudgetState(old.value);
   const current=old.value.approvals.find(r=>r.approvalId===input.approvalId&&r.customerCode===identity.customerCode&&r.date===identity.date&&r.deliveryId===identity.deliveryId&&r.firstKind===input.firstKind);
   if(!current||current.status!=='APPROVED'||Date.parse(current.approvedAt)>now()||Date.parse(current.expiresAt)<=now())fail('PHOTO_BUDGET_NOT_APPROVED');
   if(current.used[input.operation]>=current.limits[input.operation])fail('PHOTO_BUDGET_EXHAUSTED',429);
   if(input.operation==='media'&&current.used.detail!==2)fail('PHOTO_BUDGET_NOT_APPROVED');
   const next=structuredClone(old.value),target=next.approvals.find(r=>r.approvalId===input.approvalId),reservation={id:crypto.randomUUID(),operation:input.operation,createdAt:new Date(now()).toISOString()};
   target.used[input.operation]++;target.reservations.push(reservation);next.revision++;delete next.sha256;
   const savedValue=sealPhotoBudgetState(next);validatePhotoBudgetState(savedValue);aborted(signal);
   await adapter.write(file,savedValue,old.sha);
   // A failed/ambiguous write or read-back consumes no source request and is never retried.
   const saved=await adapter.read(file);aborted(signal);validatePhotoBudgetState(saved.value);
   if(saved.value.sha256!==savedValue.sha256||!saved.value.approvals.some(r=>r.approvalId===input.approvalId&&r.reservations.some(x=>x.id===reservation.id)))fail('PHOTO_BUDGET_READBACK_UNVERIFIED');
   return {...input,reserved:true,reservationId:reservation.id};
  }catch(error){return safeFailure(error);}
 }};
}
