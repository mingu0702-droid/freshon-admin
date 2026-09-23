// Dedicated, private fixed-master projection. Never stores source payloads.
import crypto from 'node:crypto';
export const FIXED_SCHEMA = 1;
const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const fail = code => { throw Object.assign(new Error(code), {code}); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
export function fixedEnvelope(data, checkedAt) {
  if (!Array.isArray(data) || !data.length || !Number.isFinite(Date.parse(checkedAt)) || Date.parse(checkedAt)>Date.now()+300000) fail('FIXED_STORE_INVALID');
  const seen = new Set();
  const rows = data.map(row => {
    const code = String(row.customerCode || '');
    const vehicle = String(row.baseVehicle || '');
    const group = String(row.baseVehicleGroup || '');
    const state = row.baseVehicleState;
    if (!/^[A-Z]\d+$/.test(code) || seen.has(code) || !/^\d*$/.test(vehicle) || !['','osan','yeongnam','honam'].includes(group)
      || !['VERIFIED_MASTER','UNASSIGNED','CONFLICT'].includes(state) || (state==='VERIFIED_MASTER') !== !!vehicle) fail('FIXED_STORE_INVALID');
    seen.add(code);
    const days = row.weekdays ? DAYS.map(day => {const v=String(row.weekdays[day]||'');if(!/^\d*$/.test(v))fail('FIXED_STORE_INVALID');return v;}) : null;
    return [code, vehicle, group, state, days];
  }).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  const body={schema:FIXED_SCHEMA,checkedAt:new Date(checkedAt).toISOString(),rows};
  return {...body,count:rows.length,version:hash(body)};
}
export function validateFixedEnvelope(value) {
  if(value?.schema!==FIXED_SCHEMA || !Array.isArray(value.rows) || value.rows.some(r=>!Array.isArray(r)||r.length!==5||r[4]!==null&&(!Array.isArray(r[4])||r[4].length!==7)))fail('FIXED_STORE_INVALID');
  const data=value.rows.map(r=>({customerCode:r[0],baseVehicle:r[1],baseVehicleGroup:r[2],baseVehicleState:r[3],
    ...(r[4]?{weekdays:Object.fromEntries(DAYS.map((d,i)=>[d,r[4][i]]))}:{}),baseVehicleSource:'FIXED_DISPATCH_PRIMARY'}));
  const expected=fixedEnvelope(data,value.checkedAt);
  if(expected.version!==value.version || expected.count!==value.count || JSON.stringify(expected)!==JSON.stringify(value))fail('FIXED_STORE_INTEGRITY');
  return {envelope:expected,data};
}

// Reuses existing GITHUB_* credentials. Explicitly refuses public repositories.
// Contents API SHA CAS gives atomic replace/lease across overlapping processes.
export function createFixedVehicleStore({env=process.env,fetchImpl=fetch,now=Date.now}={}) {
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
  async function read(name){
    await guard();const r=await request(url(name)+'?ref='+encodeURIComponent(branch));
    if(r.status===404)return {sha:null,value:null};if(!r.ok)fail('FIXED_STORE_READ');
    const meta=await r.json();let value;
    try{
      if(meta.content)value=JSON.parse(Buffer.from(meta.content,'base64').toString('utf8'));
      else {
        // >1MB Contents responses omit content. Fetch exact blob SHA, not a mutable raw URL.
        if(!/^[a-f0-9]{40}$/.test(meta.sha||''))fail('FIXED_STORE_INVALID');
        const blob=await request(`${root}/git/blobs/${meta.sha}`);if(!blob.ok)fail('FIXED_STORE_READ');
        const body=await blob.json();value=JSON.parse(Buffer.from(body.content,'base64').toString('utf8'));
      }
    }catch{fail('FIXED_STORE_INVALID');}
    return {sha:meta.sha,value};
  }
  async function write(name,value,sha){
    await guard();const r=await request(url(name),{method:'PUT',body:JSON.stringify({message:'Update private fixed vehicle projection',branch,content:Buffer.from(JSON.stringify(value),'utf8').toString('base64'),...(sha?{sha}:{})})});
    if([409,422].includes(r.status))fail('FIXED_STORE_CONFLICT');if(!r.ok)fail('FIXED_STORE_WRITE');
  }
  const file='fixed-vehicle-projection-v1.json',leaseFile='fixed-vehicle-refresh-lease-v1.json';
  return {
    async load(){const {value}=await read(file);return value?validateFixedEnvelope(value).envelope:null;},
    async save(envelope){
      validateFixedEnvelope(envelope);const old=await read(file);
      if(old.value){validateFixedEnvelope(old.value);if(Date.parse(old.value.checkedAt)>Date.parse(envelope.checkedAt))fail('FIXED_STORE_SUPERSEDED');if(old.value.version===envelope.version)return;}
      await write(file,envelope,old.sha);
      const saved=await read(file);if(saved.value?.version!==envelope.version)fail('FIXED_STORE_VERIFY');validateFixedEnvelope(saved.value);
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
