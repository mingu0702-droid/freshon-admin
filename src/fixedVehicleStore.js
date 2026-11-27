// Dedicated, private fixed-master projection. Never stores source payloads.
import crypto from 'node:crypto';
import {isFixedMasterCustomerKey} from './fixedMasterCustomerKey.js';
import {canonicalFixedMasterVehicle, isProjectedFixedMasterVehicle} from './fixedMasterVehicle.js';
import {isStoredFixedWeekdayValue} from '../public/opsmap/fixed-delivery-weekdays.mjs';
export const FIXED_SCHEMA = 1;
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const fail = (code, fixedDiagnostic) => {
  throw Object.assign(new Error(code), {code, ...(fixedDiagnostic ? {fixedDiagnostic} : {})});
};
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const groups = ['','osan','yeongnam','honam'];
const states = ['VERIFIED_MASTER','UNASSIGNED','CONFLICT'];
const invalid = (field, reason, rowIndex, group) => fail('FIXED_STORE_INVALID', {
  field, reason, ...(rowIndex === undefined ? {} : {rowIndex}),
  ...(groups.includes(group) && group ? {group} : {})
});
export function fixedEnvelope(data, checkedAt) {
  if (!Array.isArray(data) || !data.length) invalid('rows','EMPTY_OR_INVALID');
  if (!Number.isFinite(Date.parse(checkedAt)) || Date.parse(checkedAt)>Date.now()+300000) invalid('checkedAt','INVALID_TIME');
  const seen = new Set();
  const rows = data.map((row, index) => {
    const code = row.customerCode;
    const vehicle = String(row.baseVehicle || '');
    const group = String(row.baseVehicleGroup || '');
    const state = row.baseVehicleState;
    if (!isFixedMasterCustomerKey(code)) invalid('customerCode','INVALID_FORMAT',index,group);
    if (seen.has(code)) invalid('customerCode','DUPLICATE',index,group);
    if (!isProjectedFixedMasterVehicle(vehicle)) invalid('baseVehicle','INVALID_FORMAT',index,group);
    if (!groups.includes(group)) invalid('baseVehicleGroup','UNKNOWN_CENTER',index);
    if (!states.includes(state)) invalid('baseVehicleState','INVALID_STATE',index,group);
    if ((state==='VERIFIED_MASTER') !== !!vehicle) invalid('baseVehicle','STATE_MISMATCH',index,group);
    if (row.baseVehicleEmptyVerified!==undefined && (row.baseVehicleEmptyVerified!==true || state!=='UNASSIGNED')) {
      invalid('baseVehicleEmptyVerified','STATE_MISMATCH',index,group);
    }
    seen.add(code);
    const days = row.weekdays ? DAYS.map(day => {
      const v=String(row.weekdays[day]||'');
      if(!isStoredFixedWeekdayValue(v)) invalid('weekdays.'+day,'INVALID_FORMAT',index,group);
      return v;
    }) : null;
    const tuple=[code, vehicle, group, state, days];
    if(row.baseVehicleEmptyVerified)tuple.push(true);
    return tuple;
  }).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  const body={schema:FIXED_SCHEMA,checkedAt:new Date(checkedAt).toISOString(),rows};
  return {...body,count:rows.length,version:hash(body)};
}
export function fixedTupleData(r){return {customerCode:r[0],baseVehicle:canonicalFixedMasterVehicle(r[1]),baseVehicleGroup:r[2],baseVehicleState:r[3],
  ...(r[5]===true?{baseVehicleEmptyVerified:true}:{}),
  ...(r[4]?{weekdays:Object.fromEntries(DAYS.map((d,i)=>[d,r[4][i]]))}:{}),baseVehicleSource:'FIXED_DISPATCH_PRIMARY'};}
export function validateFixedEnvelope(value,{materialize=true}={}) {
  if(value?.schema!==FIXED_SCHEMA || !Array.isArray(value.rows) || !value.rows.length) invalid('rows','INVALID_ENVELOPE');
  if(!Number.isFinite(Date.parse(value.checkedAt)) || new Date(value.checkedAt).toISOString()!==value.checkedAt ||
      Date.parse(value.checkedAt)>Date.now()+300000) invalid('checkedAt','INVALID_TIME');
  let previous='';
  for(const [index,r] of value.rows.entries()){
    if(!Array.isArray(r) || r.length!==5 && !(r.length===6 && r[5]===true && r[3]==='UNASSIGNED')) invalid('row','INVALID_TUPLE',index);
    const [code,vehicle,group,state,days]=r;
    if(days!==null && (!Array.isArray(days) || days.length!==7)) invalid('weekdays','INVALID_TUPLE',index,group);
    if(!isFixedMasterCustomerKey(code)) invalid('customerCode','INVALID_FORMAT',index,group);
    if(code<=previous) invalid('customerCode',code===previous?'DUPLICATE':'UNSORTED',index,group);
    if(!isProjectedFixedMasterVehicle(vehicle)) invalid('baseVehicle','INVALID_FORMAT',index,group);
    if(!groups.includes(group)) invalid('baseVehicleGroup','UNKNOWN_CENTER',index);
    if(!states.includes(state)) invalid('baseVehicleState','INVALID_STATE',index,group);
    if((state==='VERIFIED_MASTER')!==!!vehicle) invalid('baseVehicle','STATE_MISMATCH',index,group);
    for(let day=0;days && day<DAYS.length;day++){
      if(!isStoredFixedWeekdayValue(days[day])) invalid('weekdays.'+DAYS[day],'INVALID_FORMAT',index,group);
    }
    previous=code;
  }
  // Validate the same canonical bytes without materializing 88k customer
  // objects and a second tuple tree on every load/save/read-back.
  const body={schema:FIXED_SCHEMA,checkedAt:value.checkedAt,rows:value.rows};
  if(value.version!==hash(body)||value.count!==value.rows.length||Object.keys(value).join('|')!=='schema|checkedAt|rows|count|version')fail('FIXED_STORE_INTEGRITY');
  return {envelope:value,...(materialize?{data:value.rows.map(fixedTupleData)}:{})};
}

// Reuses existing GITHUB_* credentials. Explicitly refuses public repositories.
// Contents API SHA CAS gives atomic replace/lease across overlapping processes.
export function createPrivateGithubJsonStore({env=process.env,fetchImpl=fetch,now=Date.now,diagnoseReads=false}={}) {
  const repo=env.GITHUB_CACHE_REPO,token=env.GITHUB_TOKEN,branch=env.GITHUB_CACHE_BRANCH||'main';
  const prefix=(env.GITHUB_CACHE_DIR||'freshon-cache').replace(/^\/+|\/+$/g,'');
  const root=`https://api.github.com/repos/${repo}`;
  let privateCheckedAt=0;
  async function request(url,options={}){
    let response;
    try{response=await fetchImpl(url,{...options,signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json','User-Agent':'freshon-fixed-projection',...options.headers}});}catch{fail('FIXED_STORE_NETWORK');}
    return response;
  }
  async function guard(){
    if(!token||!/^[-\w.]+\/[-\w.]+$/.test(repo||'')||!prefix||prefix.includes('..'))fail('FIXED_STORE_NOT_CONFIGURED');
    if(privateCheckedAt&&now()-privateCheckedAt<60000)return;
    const r=await request(root);if(!r.ok)fail('FIXED_STORE_PERMISSION');
    const d=await r.json();if(d.private!==true)fail('FIXED_STORE_NOT_PRIVATE');privateCheckedAt=now();
  }
  const url=name=>`${root}/contents/${prefix}/${name}`;
  const transientReadStatus=new Set([408,429,500,502,503,504]);
  const readFail=(code,reason,{status,retryable=false}={})=>fail(code,diagnoseReads?
    {reason,...(status===undefined?{}:{status}),retryable}:undefined);
  async function read(name){
    await guard();
    const r=await request(url(name)+'?ref='+encodeURIComponent(branch));
    if(r.status===404)return {sha:null,value:null};
    if(!r.ok)readFail('FIXED_STORE_READ','CONTENTS_HTTP',{status:r.status,retryable:transientReadStatus.has(r.status)});
    let meta;
    try{meta=await r.json();}
    catch(error){
      if(!diagnoseReads)throw error;
      readFail('FIXED_STORE_INVALID','CONTENTS_METADATA_JSON',{retryable:true});
    }
    try{
      if(meta.content)return {sha:meta.sha,value:JSON.parse(Buffer.from(meta.content,'base64').toString('utf8'))};
      // >1MB Contents responses omit content. Fetch exact blob SHA, not a mutable raw URL.
      if(!/^[a-f0-9]{40}$/.test(meta.sha||''))readFail('FIXED_STORE_INVALID','CONTENTS_METADATA_SHA',{retryable:true});
      const blob=await request(`${root}/git/blobs/${meta.sha}`);
      if(!blob.ok)readFail('FIXED_STORE_READ','BLOB_HTTP',{status:blob.status,retryable:transientReadStatus.has(blob.status)});
      let body;
      try{body=await blob.json();}
      catch{readFail('FIXED_STORE_INVALID','BLOB_METADATA_JSON',{retryable:true});}
      return {sha:meta.sha,value:JSON.parse(Buffer.from(body.content,'base64').toString('utf8'))};
    }catch(error){
      if(diagnoseReads&&(error?.fixedDiagnostic||error?.code==='FIXED_STORE_NETWORK'))throw error;
      readFail('FIXED_STORE_INVALID','STORED_JSON_INVALID');
    }
  }
  async function readRaw(name,maxBytes){
    await guard();
    const r=await request(url(name)+'?ref='+encodeURIComponent(branch),{headers:{Accept:'application/vnd.github.raw+json'}});
    if(r.status===404)return null;
    if(!r.ok)fail('FIXED_STORE_READ');
    if(!r.body||Number(r.headers.get('content-length'))>maxBytes){
      await r.body?.cancel().catch(()=>{});
      fail('FIXED_STORE_INVALID');
    }
    const chunks=[];
    let length=0;
    try{
      for await(const chunk of r.body){
        length+=chunk.byteLength;
        if(length>maxBytes)fail('FIXED_STORE_INVALID');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks,length).toString('utf8'));
    }catch{fail('FIXED_STORE_INVALID');}
  }
  async function write(name,value,sha){
    await guard();const r=await request(url(name),{method:'PUT',body:JSON.stringify({message:'Update private fixed vehicle projection',branch,content:Buffer.from(JSON.stringify(value),'utf8').toString('base64'),...(sha?{sha}:{})})});
    if([409,422].includes(r.status))fail('FIXED_STORE_CONFLICT');if(!r.ok)fail('FIXED_STORE_WRITE');
  }
  return {read,write,readRaw};
}

export function createFixedVehicleStore(options={}) {
  const {read,write}=createPrivateGithubJsonStore(options),now=options.now||Date.now;
  const file='fixed-vehicle-projection-v1.json',leaseFile='fixed-vehicle-refresh-lease-v1.json';
  return {
    async load(){const {value}=await read(file);return value?validateFixedEnvelope(value,{materialize:false}).envelope:null;},
    async save(envelope){
      validateFixedEnvelope(envelope,{materialize:false});const old=await read(file);
      if(old.value){validateFixedEnvelope(old.value,{materialize:false});if(Date.parse(old.value.checkedAt)>Date.parse(envelope.checkedAt))fail('FIXED_STORE_SUPERSEDED');if(old.value.version===envelope.version)return;}
      await write(file,envelope,old.sha);
      const saved=await read(file);if(saved.value?.version!==envelope.version)fail('FIXED_STORE_VERIFY');validateFixedEnvelope(saved.value,{materialize:false});
    },
    async acquire(owner){
      const old=await read(leaseFile);
      if(old.value?.expiresAt>now()&&old.value.owner!==owner)return false;
      try{await write(leaseFile,{owner,expiresAt:now()+600000},old.sha);return true;}catch(e){if(e.code==='FIXED_STORE_CONFLICT')return false;throw e;}
    },
    async renew(owner){const old=await read(leaseFile);if(old.value?.owner!==owner||old.value.expiresAt<=now())fail('FIXED_STORE_LEASE_LOST');await write(leaseFile,{owner,expiresAt:now()+600000},old.sha);},
    async release(owner){const old=await read(leaseFile);if(old.value?.owner===owner)await write(leaseFile,{owner,expiresAt:0},old.sha);}
  };
}
