// Sensitive values stay server-side. No browser/HTTP/shared public cache.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
const AAD=Buffer.from('opsmap-private-detail-cache-v1');
const fail=code=>Object.assign(new Error(code),{code});
function keyBytes(key){const b=Buffer.isBuffer(key)?key:Buffer.from(String(key||''),'base64');if(b.length!==32)throw fail('PRIVATE_CACHE_KEY_INVALID');return b;}
export function sealPrivateSnapshot(value,key){
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',keyBytes(key),iv);cipher.setAAD(AAD);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return {schema:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:ciphertext.toString('base64')};
}
export function openPrivateSnapshot(value,key){
  if(value?.schema!==1||typeof value.data!=='string'||value.data.length>24*1024*1024)throw fail('PRIVATE_CACHE_INVALID');
  try{const iv=Buffer.from(value.iv,'base64'),tag=Buffer.from(value.tag,'base64');if(iv.length!==12||tag.length!==16)throw Error();const decipher=crypto.createDecipheriv('aes-256-gcm',keyBytes(key),iv);decipher.setAAD(AAD);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data,'base64')),decipher.final()]).toString('utf8'));}
  catch{throw fail('PRIVATE_CACHE_AUTH_FAILED');}
}
const forbidden=error=>[401,403,404,410].includes(Number(error?.upstreamStatus||error?.status))||error?.failureType==='auth';
export function createPrivateDetailCache({now=Date.now,freshMs=60000,maxStaleMs=3600000,maxEntries=512,retryDelayMs=10000}={}){
  if(!Number.isFinite(freshMs)||freshMs<0||maxStaleMs<freshMs||maxStaleMs>86400000||maxEntries<1||maxEntries>20000)throw fail('PRIVATE_CACHE_POLICY_INVALID');
  const entries=new Map(),pending=new Map(),generations=new Map(),retryAt=new Map();let epoch=0;
  const identity=({customerCode,date,view='notes'})=>{
    if(!/^[A-Z]\d{3,}$/.test(customerCode||'')||!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!['notes','store'].includes(view))throw fail('PRIVATE_CACHE_IDENTITY');
    return `${view}:${customerCode}:${date}`;
  };
  function put(k,value,checkedAt,sourceVersion=null){
    const size=Buffer.byteLength(JSON.stringify(value));if(size>32768)throw fail('PRIVATE_CACHE_VALUE_LIMIT');
    if(entries.has(k))entries.delete(k);while(entries.size>=maxEntries)entries.delete(entries.keys().next().value);
    entries.set(k,{value:structuredClone(value),checkedAt,sourceVersion});
  }
  function refresh(k,loader){
    if(pending.has(k))return pending.get(k);
    const generation=generations.get(k)||0,startedEpoch=epoch;
    const promise=Promise.resolve().then(loader).then(result=>{
      if(epoch!==startedEpoch||(generations.get(k)||0)!==generation)throw fail('PRIVATE_CACHE_SOURCE_CHANGED');
      if(!result||!Object.hasOwn(result,'value'))throw fail('PRIVATE_CACHE_LOADER_CONTRACT');
      put(k,result.value,now(),result.sourceVersion||null);retryAt.delete(k);return entries.get(k);
    }).catch(e=>{retryAt.set(k,now()+retryDelayMs);if(forbidden(e)){entries.delete(k);generations.set(k,generation+1);}throw e;}).finally(()=>{if(pending.get(k)===promise)pending.delete(k);});
    pending.set(k,promise);return promise;
  }
  const response=(entry,cache,refreshing=false)=>({value:structuredClone(entry.value),meta:{cache,checkedAt:new Date(entry.checkedAt).toISOString(),ageMs:Math.max(0,now()-entry.checkedAt),stale:now()-entry.checkedAt>=freshMs,refreshing,sourceVersion:entry.sourceVersion}});
  return {
    async get(id,{loader,preferFresh=false}={}){
      const k=identity(id);if(typeof loader!=='function')throw fail('PRIVATE_CACHE_LOADER_REQUIRED');
      const e=entries.get(k),age=e?now()-e.checkedAt:Infinity;
      if(e&&age<0){entries.delete(k);throw fail('PRIVATE_CACHE_CLOCK_INVALID');}
      if(e&&age<freshMs&&!preferFresh)return response(e,'HIT');
      if(e&&age<maxStaleMs&&!preferFresh){const mayRefresh=now()>=(retryAt.get(k)||0);if(mayRefresh)void refresh(k,loader).catch(()=>{});return response(e,'STALE',mayRefresh||pending.has(k));}
      if(e)entries.delete(k);
      return response(await refresh(k,loader),'MISS');
    },
    seed(id,value,{checkedAt,sourceVersion=null}={}){
      const time=Date.parse(checkedAt);if(!Number.isFinite(time)||time>now()||now()-time>=maxStaleMs)return false;
      const k=identity(id),current=entries.get(k);if(current&&current.checkedAt>time)return false;
      generations.set(k,(generations.get(k)||0)+1);put(k,value,time,sourceVersion);return true;
    },
    invalidate(customerCode){for(const k of new Set([...entries.keys(),...pending.keys()]))if(k.split(':')[1]===customerCode){entries.delete(k);generations.set(k,(generations.get(k)||0)+1);}},
    clear(){epoch++;entries.clear();retryAt.clear();},
    stats:()=>({entries:entries.size,pending:pending.size}),
    // Test/tool API returns counts, never plaintext cache contents.
    settled:()=>Promise.allSettled([...pending.values()])
  };
}
export async function loadEncryptedPrivateSnapshot({env=process.env,appRoot,cache,normalize}={}){
  const file=env.OPSMAP_PRIVATE_DETAIL_FILE;
  if(!file)return {loaded:false,reason:'NOT_CONFIGURED'};
  if(!cache||!normalize||!appRoot||!path.isAbsolute(file))throw fail('PRIVATE_CACHE_CONFIG');
  const canonical=await fs.realpath(file),root=await fs.realpath(appRoot),relative=path.relative(root,canonical);
  if(relative===''||!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw fail('PRIVATE_CACHE_OUTSIDE_APP_REQUIRED');
  const stat=await fs.stat(canonical);if(!stat.isFile()||stat.size>24*1024*1024)throw fail('PRIVATE_CACHE_FILE_LIMIT');
  if(process.platform!=='win32'&&(stat.mode&0o077))throw fail('PRIVATE_CACHE_FILE_PERMISSIONS');
  const raw=await fs.readFile(canonical),pin=env.OPSMAP_PRIVATE_DETAIL_SHA256;
  if(pin&&crypto.createHash('sha256').update(raw).digest('hex')!==pin)throw fail('PRIVATE_CACHE_FILE_HASH');
  const snapshot=openPrivateSnapshot(JSON.parse(raw.toString('utf8')),env.OPSMAP_PRIVATE_DETAIL_ENCRYPTION_KEY);
  if(snapshot?.schema!=='opsmap-protected-detail-v1'||!Array.isArray(snapshot.rows)||snapshot.rows.length>20000||typeof snapshot.sourceVersion!=='string'||!snapshot.sourceVersion||!Number.isFinite(Date.parse(snapshot.checkedAt)))throw fail('PRIVATE_CACHE_SNAPSHOT_CONTRACT');
  const seen=new Set(),prepared=[];
  for(const r of snapshot.rows){
    const id={customerCode:r.customerCode,date:r.date,view:'notes'},identity=id.customerCode+':'+id.date;
    if(seen.has(identity)||!/^[A-Z]\d{3,}$/.test(id.customerCode)||!/^\d{4}-\d{2}-\d{2}$/.test(id.date))throw fail('PRIVATE_CACHE_SNAPSHOT_IDENTITY');
    seen.add(identity);prepared.push({id,value:normalize(r,{customerCode:r.customerCode,date:r.date})});
  }
  let loaded=0;for(const r of prepared)if(cache.seed(r.id,r.value,{checkedAt:snapshot.checkedAt,sourceVersion:snapshot.sourceVersion}))loaded++;
  return {loaded:true,count:loaded,sourceVersion:snapshot.sourceVersion,checkedAt:snapshot.checkedAt};
}
