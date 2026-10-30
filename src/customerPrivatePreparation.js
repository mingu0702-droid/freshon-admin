// Offline private projection of existing Customer rows. Never changes sources or deployment.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import '../integrations/hub/HubCustomerDetailContract.js';
import {sealPrivateSnapshot,openPrivateSnapshot} from './privateDetailCache.js';
const contract=globalThis.OpsmapCustomerDetailContract;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const stable=value=>JSON.stringify(value);
export function buildCustomerPrivateRecords({rows,sourceVersion,observedAt,previous={},activeCodes}={}){
 if(!Array.isArray(rows)||rows.length>20000||typeof sourceVersion!=='string'||!sourceVersion||!contract.instant(observedAt))fail('CUSTOMER_PREPARE_INPUT');
 const active=activeCodes?new Set(activeCodes):null,records=structuredClone(previous),seen=new Set();
 const changedCodes=new Set(),counts={sourceRows:rows.length,customers:0,changedCustomers:0,changedFields:0,conflicts:0,skippedRows:0,duplicateObservations:0,unparsedMemos:0};
 for(const row of rows){
  if(!row||typeof row.customerCode!=='string'||!row.customerCode.trim()){counts.skippedRows++;continue;}
  const code=row.customerCode.trim().toUpperCase();if(!/^[A-Z]\d{1,20}$/.test(code))fail('CUSTOMER_PREPARE_IDENTITY');
  if(active&&!active.has(code))continue;if(seen.has(code))counts.duplicateObservations++;seen.add(code);
  const input=contract.observation({...row,customerCode:code},{source:'CUSTOMER',sourceVersion,observedAt,modifiedAt:row.updatedAt||row.modifiedAt,correctionVerified:row.correctionVerified===true,deleted:row.deleted===true,clearedFields:row.correctionVerified===true&&Array.isArray(row.clearedFields)?row.clearedFields:[]});
  const result=contract.merge(records[code],input);records[code]=result.record;
  if(result.changed)changedCodes.add(code);counts.changedFields+=result.changedFields.length;counts.conflicts+=result.conflicts.length;counts.unparsedMemos+=Number(input.unparsedMemo);
 }
 if(Object.keys(records).length>20000)fail('CUSTOMER_PREPARE_LIMIT');
 counts.customers=Object.keys(records).length;counts.changedCustomers=changedCodes.size;counts.fields=Object.fromEntries(contract.FIELDS.map(field=>[field,Object.values(records).filter(r=>r.fields[field]&&!r.fields[field].conflict&&r.fields[field].value!==null&&!r.deletedAt).length]));
 return {records,counts};
}
export async function createCustomerPrivateArtifactStore({directory,appRoot,key,readFile=fs.readFile,writeFile=fs.writeFile,rename=fs.rename}={}){
 if(!path.isAbsolute(directory||'')||!path.isAbsolute(appRoot||''))fail('CUSTOMER_ARTIFACT_PATH');
 const dir=await fs.realpath(directory),app=await fs.realpath(appRoot),rel=path.relative(app,dir);
 if(!rel||!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel))fail('CUSTOMER_ARTIFACT_OUTSIDE_REPO_REQUIRED');
 if(!/^[A-Za-z0-9+/]{43}=$/.test(key||'')||Buffer.from(key,'base64').length!==32)fail('CUSTOMER_ARTIFACT_KEY');
 const pointerFile=path.join(dir,'customer-current.json');
 const parse=raw=>{try{return JSON.parse(raw);}catch{fail('CUSTOMER_ARTIFACT_JSON');}};
 async function pointer(){try{const raw=await readFile(pointerFile,'utf8');if(Buffer.byteLength(raw)>4096)fail('CUSTOMER_ARTIFACT_POINTER');const p=parse(raw);if(p.schema!==1||!p.current||!Number.isSafeInteger(p.current.version)||p.current.version<1)fail('CUSTOMER_ARTIFACT_POINTER');return {raw,value:p};}catch(e){if(e.code==='ENOENT')return {raw:null,value:null};throw e;}}
 async function checked(entry,limit=1048576){
  if(!entry||!/^customer-[a-z0-9-]+\.encrypted\.json$/.test(entry.file||'')||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||entry.bytes>limit||!/^[a-f0-9]{64}$/.test(entry.sha256||''))fail('CUSTOMER_ARTIFACT_REF');
  const raw=await readFile(path.join(dir,entry.file));if(raw.length!==entry.bytes||sha(raw)!==entry.sha256)fail('CUSTOMER_ARTIFACT_HASH');return openPrivateSnapshot(parse(raw),key);
 }
 async function immutable(name,value){
  const raw=Buffer.from(stable(sealPrivateSnapshot(value,key)));if(raw.length>1048576)fail('CUSTOMER_ARTIFACT_LIMIT');
  await writeFile(path.join(dir,name),raw,{flag:'wx',mode:0o600});const entry={file:name,bytes:raw.length,sha256:sha(raw)};
  if(stable(await checked(entry))!==stable(value))fail('CUSTOMER_ARTIFACT_READBACK');return entry;
 }
 async function loadRoot(p){const root=await checked(p.current);if(root.schema!==1||root.version!==p.current.version||typeof root.sourceVersion!=='string'||!root.buckets)fail('CUSTOMER_ARTIFACT_ROOT');return root;}
 return {
  async status(){const p=await pointer();if(!p.value)return {ready:false};const root=await loadRoot(p.value);return {ready:true,version:root.version,sourceVersion:root.sourceVersion,customers:root.counts.customers,previousPreserved:!!p.value.previous};},
  async loadRecords(){const p=await pointer();if(!p.value)return {};const root=await loadRoot(p.value),records={};for(const [bucket,entry]of Object.entries(root.buckets)){if(!/^[a-f0-9]{2}$/.test(bucket))fail('CUSTOMER_ARTIFACT_BUCKET');const part=await checked(entry);for(const [code,value]of Object.entries(part)){if(sha(code).slice(0,2)!==bucket||records[code])fail('CUSTOMER_ARTIFACT_BUCKET');records[code]=value;}}return records;},
  async read(customerCode,{view='notes',requestedDate=null}={}){if(!/^[A-Z]\d{1,20}$/.test(customerCode||'')||!['notes','store'].includes(view)||requestedDate!==null&&(!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)||!Number.isFinite(Date.parse(requestedDate))||new Date(requestedDate).toISOString().slice(0,10)!==requestedDate))fail('CUSTOMER_ARTIFACT_IDENTITY');const p=await pointer();if(!p.value)fail('CUSTOMER_ARTIFACT_NOT_READY');const root=await loadRoot(p.value),entry=root.buckets[sha(customerCode).slice(0,2)],bucket=entry?await checked(entry):{},record=bucket[customerCode];if(!record)fail('CUSTOMER_ARTIFACT_UNOBSERVED');return contract.project(record,{view,requestedDate,version:root.version,checkedAt:root.checkedAt,currentness:'UNCONFIRMED'});},
  async commit({records,counts,sourceVersion,sourceMarker,confirmSource}={}){
   if(!records||Object.keys(records).length>20000||typeof confirmSource!=='function'||typeof sourceVersion!=='string'||!sourceMarker)fail('CUSTOMER_ARTIFACT_INPUT');
   if(stable(await confirmSource())!==stable(sourceMarker))fail('CUSTOMER_ARTIFACT_SOURCE_CHANGED');
   const before=await pointer();if(before.value){const old=await loadRoot(before.value);if(old.sourceVersion===sourceVersion&&stable(old.sourceMarker)===stable(sourceMarker))return {phase:'NOOP',version:old.version,customers:old.counts.customers};}
   const version=(before.value?.current.version||0)+1,id=crypto.randomBytes(8).toString('hex'),grouped={},buckets={};
   for(const [code,record]of Object.entries(records)){if(record.customerCode!==code||!/^\w+$/.test(code))fail('CUSTOMER_ARTIFACT_IDENTITY');(grouped[sha(code).slice(0,2)]??={})[code]=record;}
   for(const bucket of Object.keys(grouped).sort())buckets[bucket]=await immutable('customer-'+version+'-'+id+'-'+bucket+'.encrypted.json',grouped[bucket]);
   const root={schema:1,version,sourceVersion,sourceMarker,checkedAt:new Date().toISOString(),counts,buckets,sourceCompletenessVerified:false};const entry=await immutable('customer-'+version+'-'+id+'-root.encrypted.json',root);
   // A lock and compare-and-swap protect only this isolated artifact pointer.
   const lock=await fs.open(path.join(dir,'customer-commit.lock'),'wx',0o600);let temp;
   try{
    if((await pointer()).raw!==before.raw)fail('CUSTOMER_ARTIFACT_POINTER_CHANGED');
    if(stable(await confirmSource())!==stable(sourceMarker))fail('CUSTOMER_ARTIFACT_SOURCE_CHANGED');
    const next={schema:1,current:{...entry,version},previous:before.value?.current||null};temp=path.join(dir,'customer-pointer-'+id+'.tmp');await writeFile(temp,stable(next),{flag:'wx',mode:0o600});await rename(temp,pointerFile);temp=null;
    if((await pointer()).raw!==stable(next))fail('CUSTOMER_ARTIFACT_COMMIT_UNCONFIRMED');return {phase:'DONE',version,...counts,previousPreserved:!!next.previous};
   }finally{if(temp)await fs.unlink(temp).catch(()=>{});await lock.close();await fs.unlink(path.join(dir,'customer-commit.lock'));}
  }
 };
}
// Optional injection into the existing authenticated server's callHub dependency.
// This does not mount a route, create a session, configure Stage, or bypass its guards.
export function bindPreparedCustomerPrivateReads({store,callHub}={}){
 if(typeof store?.read!=='function'||typeof callHub!=='function')fail('CUSTOMER_ARTIFACT_BRIDGE');
 return async(action,params,options)=>{
  if(action!=='customerDetailPrepared')return callHub(action,params,options);
  if(!params||Object.keys(params).some(k=>!['customerCode','view','requestedDate'].includes(k)))fail('CUSTOMER_ARTIFACT_PARAMS');
  return {...await store.read(params.customerCode,{view:params.view??'notes',requestedDate:params.requestedDate??null}),cached:false};
 };
}
// Both operator and scheduler invoke exactly the same bounded, single-flight job.
// Scheduling, authentication and deployment remain the caller's responsibility.
export function createCustomerPrivateRefreshWorker({store,readSnapshot,confirmSource}={}){
 if(!store?.loadRecords||!store?.commit||typeof readSnapshot!=='function'||typeof confirmSource!=='function')fail('CUSTOMER_REFRESH_CONFIG');
 let running=null;
 const refresh=()=>{
  if(running)return running;
  running=Promise.resolve().then(async()=>{
   const snapshot=await readSnapshot();
   if(!snapshot||typeof snapshot.sourceMarker?.version!=='string')fail('CUSTOMER_REFRESH_SNAPSHOT');
   const prepared=buildCustomerPrivateRecords({rows:snapshot.rows,previous:await store.loadRecords(),sourceVersion:snapshot.sourceMarker.version,observedAt:snapshot.observedAt});
   return store.commit({...prepared,sourceVersion:snapshot.sourceMarker.version,sourceMarker:snapshot.sourceMarker,confirmSource});
  }).finally(()=>{running=null;});return running;
 };
 return Object.freeze({manual:refresh,automatic:refresh});
}
