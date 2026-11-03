import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {prepareRecoveryCoordinateAddress,classifyCoordinateLookup} from './coordinateLookupOutcome.js';
import {selectCoordinateCustomer,recoveryRecordHash} from './coordinateRecoveryWorker.js';
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const code=v=>typeof v==='string'&&/^[A-Z]\d{1,20}$/.test(v);
const day=t=>new Date(t+32400000).toISOString().slice(0,10);
const fail=s=>{throw Object.assign(Error(s),{code:s});};
const states=new Set(['HISTORICAL_RECEIPT_UNAVAILABLE','REQUEST_STARTED','EXACT_REQUEST_ONLY','ZERO_RESULT','MULTIPLE_CANDIDATES','TRUNCATED','ADDRESS_OR_COORDINATE_MISMATCH','INVALID_RESPONSE','DEFERRED_DAILY_LIMIT','FAILED','DISPLAY_FAILED','SUPERSEDED','CANCELLED']);

export function buildCoordinateLookupPlan({customers,customerCodes,sourceVersion,observedAt}) {
 if(!/^\d+$/.test(sourceVersion)||!Array.isArray(customerCodes)||customerCodes.length>500||new Set(customerCodes).size!==customerCodes.length||customerCodes.some(c=>!code(c)))fail('LOOKUP_PLAN_INPUT');
 const items=[],review=[];
 for(const customerCode of customerCodes){
  const selected=selectCoordinateCustomer(customers,customerCode);if(selected.status!=='FOUND'){review.push({customerCode,reason:selected.status});continue;}
  const p=prepareRecoveryCoordinateAddress(selected.row.address,selected.row.detailAddress);
  if(!p.query||p.addressKind==='UNCONFIRMED'){review.push({customerCode,reason:'ADDRESS_NEEDS_SOURCE_CONFIRMATION'});continue;}
  items.push({customerCode,addressHash:p.addressHash,customerNameHash:recoveryRecordHash(selected.row.customerName||''),queryHash:p.queryHash,query:p.query});
 }
 return {sourceVersion,observedAt,items,review};
}
export function validateLookupCheckpoint(value) {
 if(value?.schema!==1||Object.keys(value).join('|')!=='schema|items|sha256'||!hash(value.sha256)||!Array.isArray(value.items)||value.items.length>1000)fail('LOOKUP_CHECKPOINT');
 const {sha256,...body}=value;if(recoveryRecordHash(body)!==sha256)fail('LOOKUP_CHECKPOINT_HASH');
 const keys=new Set();
 for(const r of value.items){
  if(Object.keys(r).join('|')!=='customerCode|addressHash|queryHash|state|day|httpStatus|providerHttp|candidateCount|errorCode'||!code(r.customerCode)||!hash(r.addressHash)||!hash(r.queryHash)||!states.has(r.state)||!/^\d{4}-\d\d-\d\d$/.test(r.day)||[r.httpStatus,r.providerHttp].some(s=>s!==null&&(!Number.isInteger(s)||s<100||s>599))||r.candidateCount!==null&&(!Number.isInteger(r.candidateCount)||r.candidateCount<0||r.candidateCount>30)||r.errorCode!==null&&!/^[A-Z_]{1,64}$/.test(r.errorCode))fail('LOOKUP_RECEIPT');
  const key=r.customerCode+':'+r.addressHash;if(keys.has(key))fail('LOOKUP_DUPLICATE');keys.add(key);
 }return value;
}
export function sealLookupCheckpoint(items){const body={schema:1,items};return validateLookupCheckpoint({...body,sha256:recoveryRecordHash(body)});}
export function createLookupCheckpointFile({file,appRoot=process.cwd()}) {
 if(!path.isAbsolute(file))fail('LOOKUP_PRIVATE_PATH');
 const relative=path.relative(fs.realpathSync(appRoot),fs.realpathSync(path.dirname(file)));if(!relative||!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))fail('LOOKUP_OUTSIDE_APP');
 const read=()=>{if(!fs.existsSync(file))return null;if(fs.statSync(file).size>524288)fail('LOOKUP_CHECKPOINT_SIZE');return validateLookupCheckpoint(JSON.parse(fs.readFileSync(file,'utf8')));};
 return {read,write(value,expected){validateLookupCheckpoint(value);const lock=file+'.lock',fd=fs.openSync(lock,'wx',0o600),temp=file+'.'+crypto.randomUUID()+'.tmp';try{if((read()?.sha256||null)!==expected)fail('LOOKUP_CHECKPOINT_CAS');fs.writeFileSync(temp,JSON.stringify(value),{flag:'wx',mode:0o600});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);fs.closeSync(fd);fs.unlinkSync(lock);}}};
}
// No HTTP client/key configuration: reuse the SAME authenticated A service and its daily ledger.
export async function runCoordinateLookupPlan({plan,service,store,assertCurrent,onPoint=async()=>{},signal,now=Date.now,maxCalls=100}) {
 const age=now()-Date.parse(plan.observedAt);if(!Number.isFinite(age)||age<0||age>3600000||typeof assertCurrent!=='function'||!service?.status||!service?.lookup||!Number.isInteger(maxCalls)||maxCalls<0||maxCalls>100)fail('LOOKUP_RUN_CONFIG');
 if(!/^\d+$/.test(plan.sourceVersion)||!Array.isArray(plan.items)||plan.items.length>500||new Set(plan.items.map(r=>r.customerCode)).size!==plan.items.length||plan.items.some(r=>!code(r.customerCode)||!hash(r.addressHash)||!hash(r.queryHash)||!hash(r.customerNameHash)||prepareRecoveryCoordinateAddress(r.query).queryHash!==r.queryHash))fail('LOOKUP_RUN_INPUT');
 const prior=await store.read(),records=new Map((prior?.items||[]).map(r=>[r.customerCode+':'+r.addressHash,r]));let expected=prior?.sha256||null,calls=0,stop=false;const inFlight=new Map();
 const save=async()=>{const value=sealLookupCheckpoint([...records.values()]);await store.write(value,expected);expected=value.sha256;};
 for(const item of plan.items){
  if(signal?.aborted)break;
  const key=item.customerCode+':'+item.addressHash,old=records.get(key),today=day(now());
  // Unknown interrupted/historical requests are never silently repeated, even after midnight.
  // A no-call quota deferral may resume after fresh identity checks and a
  // confirmed increase in the same service's remaining allowance.
  if(old&&old.state!=='DEFERRED_DAILY_LIMIT')continue;
  const receipt={customerCode:item.customerCode,addressHash:item.addressHash,queryHash:item.queryHash,state:'REQUEST_STARTED',day:today,httpStatus:null,providerHttp:null,candidateCount:null,errorCode:null};
  const current=async()=>{if(signal?.aborted)fail('CANCELLED');await assertCurrent(item,plan.sourceVersion);};
  try{
   await current();const status=await service.status();
   if(!status.enabled)fail('PROVIDER_DISABLED');
   if(!Number.isSafeInteger(status.dailyUsed)||status.dailyUsed<0||!Number.isSafeInteger(status.dailyLimit)||status.dailyLimit<1||status.dailyLimit>1000)fail('PROVIDER_STATUS_UNVERIFIED');
   if(stop||calls>=maxCalls||status.dailyUsed>=status.dailyLimit){receipt.state='DEFERRED_DAILY_LIMIT';stop=true;records.set(key,receipt);await save();continue;}
   const shared=inFlight.get(item.queryHash);records.set(key,receipt);await save();
   let response;
   if(shared)response=await shared;
   else{calls++;const request=Promise.resolve().then(()=>service.lookup(item.query,{assertCurrent:current}));inFlight.set(item.queryHash,request);response=await request;}
   await current();const data=response?.data||response;
   if(response?.ok===false)fail('PROVIDER_RESPONSE_REJECTED');
   receipt.providerHttp=Number.isInteger(data?.providerHttp)?data.providerHttp:null;
   receipt.candidateCount=Number.isInteger(data?.resolution?.candidateCount)?data.resolution.candidateCount:null;
   const docs=data?.documents;
   const exact=data?.exact===true&&data.retention==='REQUEST_ONLY'&&data.coordinatePersistence===false&&classifyCoordinateLookup({documents:docs,meta:{is_end:true,total_count:docs?.length}},item.query).point;
   if(exact){receipt.state='EXACT_REQUEST_ONLY';try{await current();await onPoint({customerCode:item.customerCode,lat:Number(docs[0].y),lng:Number(docs[0].x),coordinateSource:'KAKAO_EXACT_ADDRESS',requestOnly:true});}catch(e){receipt.state=e.code==='CANCELLED'?'CANCELLED':e.code==='ADDRESS_SUPERSEDED'?'SUPERSEDED':'DISPLAY_FAILED';}}
   else receipt.state=states.has(data?.resolution?.kind)?data.resolution.kind:'INVALID_RESPONSE';
  }catch(e){receipt.httpStatus=Number.isInteger(e.status)?e.status:null;receipt.providerHttp=Number.isInteger(e.providerHttp)?e.providerHttp:null;receipt.errorCode=/^[A-Z_]{1,64}$/.test(e.code||'')?e.code:'LOOKUP_FAILED';receipt.state=e.code==='GEOCODE_DAILY_LIMIT'?'DEFERRED_DAILY_LIMIT':e.code==='CANCELLED'?'CANCELLED':e.code==='ADDRESS_SUPERSEDED'?'SUPERSEDED':'FAILED';if(['GEOCODE_DAILY_LIMIT','GEOCODE_AUTOMATICALLY_BLOCKED','PROVIDER_DISABLED'].includes(e.code))stop=true;}
  records.set(key,receipt);await save();
  if(['GEOCODE_AUTOMATICALLY_BLOCKED','PROVIDER_DISABLED','PROVIDER_STATUS_UNVERIFIED','GEOCODE_SESSION_EXPIRED','GEOCODE_ORIGIN_REJECTED'].includes(receipt.errorCode))break;
 }
 return {lookupInvocations:calls,checkpoint:sealLookupCheckpoint([...records.values()])};
}
