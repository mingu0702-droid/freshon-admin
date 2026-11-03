// Customer-keyed recovery. Source reads/provider/budget are injected; no source writes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {coordinateAddressHash,preparePrivateCoordinateAddress,kakaoCoordinateResult} from './opsmap-abc/opsmapAutoCoordinates.js';
import {prepareRecoveryCoordinateAddress} from './coordinateLookupOutcome.js';
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const point=r=>Number.isFinite(r?.lat)&&Number.isFinite(r?.lng)&&r.lat>=33&&r.lat<=39.5&&r.lng>=124&&r.lng<=132;
const code=v=>typeof v==='string'&&/^[A-Z]\d{1,20}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=s=>{throw Object.assign(Error(s),{code:s});};
export const recoveryRecordHash=digest;
// Reuse A's credential checks, shared durable daily ledger and circuit breaker.
export function existingKakaoRecoveryLookup(service){
 if(typeof service?.lookup!=='function'||typeof service?.status!=='function')fail('EXISTING_PROVIDER_REQUIRED');
 return async query=>{const state=await service.status();if(!state.enabled)fail('EXISTING_PROVIDER_DISABLED');return service.lookup(query);};
}
export function selectCoordinateCustomer(rows,customerCode){
 const matches=rows.filter(r=>String(r.customerCode||'').trim().toUpperCase()===customerCode);
 if(!matches.length)return {status:'CUSTOMER_MASTER_UNMATCHED'};
 const time=r=>typeof r.updatedAt==='number'?r.updatedAt:Date.parse(r.updatedAt)||0,latest=Math.max(...matches.map(time)),fresh=matches.filter(r=>time(r)===latest);
 if(new Set(fresh.map(r=>coordinateAddressHash(r.address))).size!==1)return {status:'ADDRESS_CONFLICT'};
 const row=fresh[0];if(!row.address?.trim())return {status:'ADDRESS_EMPTY'};
 return {status:'FOUND',row};
}
export function createCoordinateRecoveryWorker({store,lookup=null,maxCalls=25,now=Date.now}={}){
 if(!store?.read||!store?.write||!Number.isInteger(maxCalls)||maxCalls<0||maxCalls>100)fail('RECOVERY_CONFIG');
 let active=null;
 const run=input=>active||=(async()=>{
  if(!Array.isArray(input.targets)||input.targets.length>500||new Set(input.targets.map(r=>r.customerCode)).size!==input.targets.length||input.targets.some(r=>!code(r.customerCode))||!/^\d+$/.test(input.sourceVersion||'')||input.sourceVersion!==input.versionAfter)fail('RECOVERY_INPUT');
  const old=await store.read(),records={...(old?.records||{})},bindings={},results=[],pending=new Map();let calls=0,providerStop=null;
  if(old&&BigInt(input.sourceVersion)<BigInt(old.sourceVersion))fail('RECOVERY_STALE_VERSION');
  for(const target of input.targets){
   const customerCode=target.customerCode,selected=selectCoordinateCustomer(input.customers,customerCode);
   if(selected.status!=='FOUND'){delete records[customerCode];results.push({customerCode,status:selected.status,manualRequired:true});continue;}
   const prepared=prepareRecoveryCoordinateAddress(selected.row.address,selected.row.detailAddress),addressHash=prepared.addressHash;
   bindings[customerCode]={addressHash,customerNameHash:digest(selected.row.customerName||'')};
   const normal=input.existing?.find(r=>r.customerCode===customerCode);
   if(normal?.coordinateSource==='MANUAL_PIN'||point(normal)){results.push({customerCode,status:'PRESERVED_EXISTING'});continue;}
   const cached=records[customerCode];if(cached&&(cached.addressHash!==addressHash||cached.customerNameHash!==bindings[customerCode].customerNameHash))delete records[customerCode];
   const evidence=(input.gps||[]).filter(e=>e.customerCode===customerCode&&e.addressHash===addressHash&&e.coordinateSource==='RAW_GPS'&&e.geocodeStatus==='OK'&&point(e));
   if(evidence.length&&evidence.some(e=>Math.abs(e.lat-evidence[0].lat)>1e-8||Math.abs(e.lng-evidence[0].lng)>1e-8)){delete records[customerCode];results.push({customerCode,status:'GPS_CONFLICT',manualRequired:true});continue;}
   if(evidence.length){const e=evidence[0];records[customerCode]={customerCode,addressHash,customerNameHash:bindings[customerCode].customerNameHash,lat:e.lat,lng:e.lng,coordinateSource:'RAW_GPS',evidenceHash:digest(e),sourceVersion:input.sourceVersion};results.push({customerCode,status:'RECOVERED_STORED_GPS'});continue;}
   if(cached&&cached.addressHash===addressHash&&cached.customerNameHash===bindings[customerCode].customerNameHash){records[customerCode]={...cached,sourceVersion:input.sourceVersion};results.push({customerCode,status:'RECOVERED_STORED_GPS'});continue;}
   if(!prepared.query||prepared.addressKind==='UNCONFIRMED'){results.push({customerCode,status:'AMBIGUOUS_ADDRESS',manualRequired:true});continue;}
   if(!lookup){results.push({customerCode,status:'PROVIDER_NOT_DELEGATED',manualRequired:true});continue;}
   if(providerStop){results.push({customerCode,status:providerStop,manualRequired:true});continue;}
   if(!pending.has(prepared.queryHash)){
    if(calls>=maxCalls){results.push({customerCode,status:'CALL_LIMIT',manualRequired:true});continue;}
    calls++;pending.set(prepared.queryHash,Promise.resolve().then(()=>lookup(prepared.query)).then(value=>({value}),error=>({error:error?.code||'EXTERNAL_API_FAILED'})));
   }
   const response=await pending.get(prepared.queryHash);
   if(response.error){const states={GEOCODE_DAILY_LIMIT:'DAILY_LIMIT',GEOCODE_AUTOMATICALLY_BLOCKED:'AUTOMATIC_BLOCKED',EXISTING_PROVIDER_DISABLED:'PROVIDER_DISABLED'};const status=states[response.error]||'EXTERNAL_API_FAILED';if(states[response.error])providerStop=status;results.push({customerCode,status,manualRequired:true});continue;}
   const value=response.value?.data||response.value,docs=value?.documents;
   const exact=Array.isArray(docs)&&kakaoCoordinateResult({documents:docs,meta:value.meta||{total_count:docs.length,is_end:true}},prepared.query);
   if(!exact){results.push({customerCode,status:Array.isArray(docs)&&docs.length>1?'MULTIPLE_CANDIDATES':'ADDRESS_OR_BUILDING_MISMATCH',manualRequired:true});continue;}
   // API results are request-only. They MUST NOT enter durable coordinates/snapshot.
   results.push({customerCode,status:'EXACT_API_REQUEST_ONLY',manualRequired:true});
  }
  const bundle={schema:'opsmap-private-coordinate-recovery-v1',sourceVersion:input.sourceVersion,observedAt:new Date(now()).toISOString(),bindings,records};bundle.sha256=digest(bundle);
  await store.write(bundle,old?.sha256||null);
  return {bundle,results,summary:{targets:input.targets.length,recovered:results.filter(r=>r.status==='RECOVERED_STORED_GPS').length,remaining:results.filter(r=>!['RECOVERED_STORED_GPS','PRESERVED_EXISTING'].includes(r.status)).length,providerCalls:calls,reasons:Object.fromEntries([...new Set(results.map(r=>r.status))].map(s=>[s,results.filter(r=>r.status===s).length]))}};
 })().finally(()=>{active=null;});
 return {manual:run,automatic:run};
}
export function validateCoordinateRecoveryBundle(v){
 if(!v||v.schema!=='opsmap-private-coordinate-recovery-v1'||Object.keys(v).join('|')!=='schema|sourceVersion|observedAt|bindings|records|sha256'||!/^\d+$/.test(v.sourceVersion)||!Number.isFinite(Date.parse(v.observedAt))||!hash(v.sha256))fail('RECOVERY_BUNDLE');
 const {sha256,...body}=v;if(digest(body)!==sha256||Object.keys(v.records||{}).length>500||Object.keys(v.bindings||{}).length>500)fail('RECOVERY_HASH');
 for(const [key,r]of Object.entries(v.records)){if(!code(key)||key!==r.customerCode||Object.keys(r).join('|')!=='customerCode|addressHash|customerNameHash|lat|lng|coordinateSource|evidenceHash|sourceVersion'||!point(r)||r.coordinateSource!=='RAW_GPS'||!hash(r.addressHash)||!hash(r.customerNameHash)||!hash(r.evidenceHash)||r.sourceVersion!==v.sourceVersion||v.bindings[key]?.addressHash!==r.addressHash||v.bindings[key]?.customerNameHash!==r.customerNameHash)fail('RECOVERY_RECORD');}
 for(const [key,b]of Object.entries(v.bindings)){if(!code(key)||Object.keys(b).join('|')!=='addressHash|customerNameHash'||!hash(b.addressHash)||!hash(b.customerNameHash))fail('RECOVERY_BINDING');}return v;
}
export function createPrivateCoordinateRecoveryFile({file,appRoot=process.cwd()}={}){
 if(!path.isAbsolute(file||''))fail('RECOVERY_PRIVATE_PATH');
 const directory=fs.realpathSync(path.dirname(file)),root=fs.realpathSync(appRoot),rel=path.relative(root,directory);if(!rel||!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel))fail('RECOVERY_OUTSIDE_APP_REQUIRED');
 const checked=p=>{if(fs.statSync(p).size>262144)fail('RECOVERY_FILE_LIMIT');return validateCoordinateRecoveryBundle(JSON.parse(fs.readFileSync(p,'utf8')));};
 const read=()=>{try{return checked(file);}catch(e){if(e.code==='ENOENT')return null;if(fs.existsSync(file+'.previous'))return checked(file+'.previous');throw e;}};
 return {read,write(value,expected){validateCoordinateRecoveryBundle(value);const lock=file+'.lock';let fd;try{fd=fs.openSync(lock,'wx',0o600);const prior=read();if((prior?.sha256||null)!==expected)fail('RECOVERY_CAS');const temp=file+'.'+crypto.randomUUID()+'.tmp';try{if(prior){fs.writeFileSync(temp,JSON.stringify(prior),{flag:'wx',mode:0o600});fs.renameSync(temp,file+'.previous');}fs.writeFileSync(temp,JSON.stringify(value),{flag:'wx',mode:0o600});validateCoordinateRecoveryBundle(JSON.parse(fs.readFileSync(temp,'utf8')));fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}}}};
}
export function joinVerifiedCoordinateRecords(rows,bundle,{currentBindings,sourceVersion}={}){
 validateCoordinateRecoveryBundle(bundle);if(sourceVersion!==bundle.sourceVersion)return rows;
 return rows.map(row=>{const key=row.customerCode||row.code,r=bundle.records[key],b=currentBindings?.[key];if(!r||point(row)||row.coordinateSource==='MANUAL_PIN'||key==='S191541'||!b||b.addressHash!==r.addressHash||b.customerNameHash!==r.customerNameHash)return row;const priorHash=row.originalAddressHash||row.addressHash;if(priorHash&&priorHash!==r.addressHash)return row;return {...row,lat:r.lat,lng:r.lng,coordinateSource:'RAW_GPS',coordinateAccuracy:'UNVERIFIED',originalAddressHash:r.addressHash};});
}
export function configuredCoordinateRecovery({env=process.env,now=Date.now,appRoot=process.cwd()}={}){
 const file=env.OPSMAP_COORDINATE_RECOVERY_FILE,bindingsFile=env.OPSMAP_COORDINATE_BINDINGS_FILE;if(!file||!bindingsFile)return null;
 try{
  const store=createPrivateCoordinateRecoveryFile({file,appRoot}),bundle=store.read();if(!bundle||!path.isAbsolute(bindingsFile)||fs.statSync(bindingsFile).size>131072)return null;
  const bindingsReal=fs.realpathSync(bindingsFile),relative=path.relative(fs.realpathSync(appRoot),bindingsReal);if(!relative||!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))return null;
  const observation=JSON.parse(fs.readFileSync(bindingsReal,'utf8')),age=now()-Date.parse(observation.observedAt),{sha256,...body}=observation;
  if(!hash(sha256)||digest(body)!==sha256||age<0||age>3600000||observation.sourceVersion!==bundle.sourceVersion)return null;
  return {bundle,currentBindings:observation.bindings,sourceVersion:observation.sourceVersion};
 }catch{return null;}
}
