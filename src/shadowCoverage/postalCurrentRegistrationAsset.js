import {createCipheriv,createDecipheriv,createHash,hkdfSync,randomBytes} from 'node:crypto';
import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {customerRegistryAddressHash} from '../customerRegistry.js';
import {opsmapArchiveSite} from '../stageScope.js';
import {isCurrentPostalPoint} from './postalCurrentRegistration.js';
import {stagePostalReadToken} from './stagePostalAssets.js';
import {createStageCurrentPostalRefreshStore} from './postalCurrentRegistrationStore.js';

const assetUrl='https://api.github.com/repos/mingu0702-droid/freshon-cache/contents/opsmap-stage/postal-v1/current-registration-v1.sealed';
const schema='opsmap-postal-current-registration-v1';
const maxBytes=512*1024;
const maxRows=30000;
const digest=/^[a-f0-9]{64}$/;
const identity=/^[A-Z]\d{1,20}$/;
const centers=new Set(['osan','yeongnam','honam']);
const checksum=bytes=>createHash('sha256').update(bytes).digest('hex');
const context=Buffer.from(schema);
const keyFor=key=>Buffer.from(hkdfSync('sha256',key,context,Buffer.from('asset-encryption'),32));
const invalid=()=>Error('POSTAL_CURRENT_REGISTRATION_INVALID');
const isPostalId=value=>Number.isSafeInteger(value)&&value>=1000&&value<=99999;
const expectedBinding=value=>['registry','boundary','release'].every(key=>digest.test(value?.[key]||''));

export function sealCurrentPostalRegistration({binding,assignments},key) {
  if(!expectedBinding(binding)||!(assignments instanceof Map)||assignments.size>maxRows||key?.length!==32)throw invalid();
  const rows=[...assignments].map(([code,{area}])=>[code,area]).sort((a,b)=>a[0].localeCompare(b[0],'en'));
  if(rows.some(([code,area])=>!identity.test(code)||!isPostalId(area)))throw invalid();
  const plaintext=Buffer.from(JSON.stringify({schema,binding:{registry:binding.registry,boundary:binding.boundary,release:binding.release},rows}));
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyFor(key),nonce);
  cipher.setAAD(context);
  const bytes=Buffer.concat([nonce,cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]);
  if(bytes.length>maxBytes)throw invalid();
  return {bytes,sha256:checksum(bytes)};
}

export function verifyCurrentPostalRegistration(bytes,sha256,key) {
  if(!Buffer.isBuffer(bytes)||bytes.length<29||bytes.length>maxBytes||!digest.test(sha256||'')||
      checksum(bytes)!==sha256||key?.length!==32)throw invalid();
  let value;
  try {
    const decipher=createDecipheriv('aes-256-gcm',keyFor(key),bytes.subarray(0,12));
    decipher.setAAD(context);
    decipher.setAuthTag(bytes.subarray(-16));
    value=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8'));
  } catch {throw invalid();}
  if(value?.schema!==schema||!expectedBinding(value.binding)||!Array.isArray(value.rows)||value.rows.length>maxRows)throw invalid();
  const seen=new Set();
  for(const tuple of value.rows){
    if(!Array.isArray(tuple)||tuple.length!==2)throw invalid();
    const [code,area]=tuple;
    if(typeof code!=='string'||!identity.test(code)||seen.has(code)||!isPostalId(area))throw invalid();
    seen.add(code);
  }
  return value;
}

// Asset and roster caches belong to one exact registry version.
export function createCurrentPostalRegistrationReader({readAsset,readRegistry,
  readRegistryVersion=async()=> (await readRegistry())?.ref?.version}) {
  let cached;
  async function load(version){
    if(cached?.version!==version){
      const entry={version};
      entry.asset=Promise.resolve().then(()=>readAsset(version)).then(asset=>{
        if(asset?.binding?.registry!==version)throw Error('POSTAL_CURRENT_REGISTRATION_CHANGED');
        return asset;
      }).catch(error=>{
        if(cached===entry)cached=null;
        throw error;
      });
      cached=entry;
    }
    return cached;
  }
  async function buildIndex(before,asset,{hasArea,hasLegacyCode,readLegacy}){
    if(!Array.isArray(before.rows)||before.rows.length>maxRows)throw invalid();
    const byCode=new Map(before.rows.map(row=>[row.customerCode,row]));
    if(byCode.size!==before.rows.length)throw invalid();
    const byCenter={all:new Map(),osan:new Map(),yeongnam:new Map(),honam:new Map()};
    const dispatchDensityAssignments=new Map();
    const scope={all:0,osan:0,yeongnam:0,honam:0}, additional={...scope};
    const countScope=center=>{
      scope.all++;
      if(centers.has(center))scope[center]++;
    };
    const add=(code,name,center,id,supplement)=>{
      const currentCenter=centers.has(center)?center:null;
      const match={code,name,center:currentCenter};
      for(const group of ['all',...(currentCenter?[currentCenter]:[])]){
        const list=byCenter[group].get(id)||[];
        list.push(match);
        byCenter[group].set(id,list);
        if(supplement)additional[group]++;
      }
    };
    for(const row of byCode.values())if(row.lifecycle==='ACTIVE')countScope(row.centerGroup);
    const legacy=readLegacy?await readLegacy():[];
    const seenLegacy=new Set();
    for(const {code,name,address,center,id,lat,lng} of legacy){
      if(!identity.test(code)||seenLegacy.has(code))throw invalid();
      seenLegacy.add(code);
      const current=byCode.get(code);
      if(!current)countScope(center);
      if(id==null||!hasArea(id)||!address)continue;
      if(current&&(current.lifecycle!=='ACTIVE'||current.addressHash!==customerRegistryAddressHash(address)||
          centers.has(current.centerGroup)&&current.centerGroup!==center))continue;
      add(code,current?.customerName||name,current?.centerGroup||center,id,false);
      const point=current?.verifiedLocation;
      const legacyPoint=Number.isFinite(lat)&&lat>=33&&lat<=39.5&&Number.isFinite(lng)&&lng>=124&&lng<=132;
      // The verified legacy point is still tied to the exact active address above.
      // A current, conflicting coordinate must never be replaced by that point.
      if(current?.centerGroup===center&&centers.has(center)&&legacyPoint&&
          (!point||isCurrentPostalPoint(current)&&point.lat===lat&&point.lng===lng)) {
        dispatchDensityAssignments.set(code,{area:id,center});
      }
    }
    for(const [code,id] of asset.rows){
      const row=byCode.get(code);
      if(row?.lifecycle!=='ACTIVE'||!isCurrentPostalPoint(row)||hasLegacyCode(code)||seenLegacy.has(code)||!hasArea(id))throw invalid();
      add(code,row.customerName,row.centerGroup,id,true);
      if(centers.has(row.centerGroup))dispatchDensityAssignments.set(code,{area:id,center:row.centerGroup});
    }
    return {byCenter,scope,additional,dispatchDensityAssignments};
  }
  async function verifiedIndex({registry,boundary,release,hasArea,hasLegacyCode,readLegacy}) {
    const before=await readRegistry();
    const version=before?.ref?.version;
    if(!digest.test(version||'')||registry!==undefined&&registry!==version)throw Error('POSTAL_CURRENT_REGISTRATION_CHANGED');
    const entry=await load(version);
    const asset=await entry.asset;
    if(asset.binding.registry!==version||asset.binding.boundary!==boundary||asset.binding.release!==release) {
      throw Error('POSTAL_CURRENT_REGISTRATION_CHANGED');
    }
    entry.index??=buildIndex(before,asset,{hasArea,hasLegacyCode,readLegacy}).catch(error=>{
      entry.index=null;
      throw error;
    });
    const index=await entry.index;
    if(await readRegistryVersion()!==version)throw Error('POSTAL_CURRENT_REGISTRATION_CHANGED');
    return {index,version};
  }
  const read=async({center='all',area,offset=0,...source})=>{
    if(!['all',...centers].includes(center)||!Number.isSafeInteger(offset)||offset<0||offset>maxRows||
        (area===undefined?offset!==0:!isPostalId(area)))throw Error('POSTAL_QUERY_INVALID');
    const {index,version}=await verifiedIndex(source);
    const groups=index.byCenter[center];
    if(area===undefined){
      const counts=[...groups].map(([id,rows])=>[id,rows.length]);
      return {registry:version,registeredScope:index.scope[center],additionalRegistered:index.additional[center],
        registered:counts.reduce((total,[,count])=>total+count,0),counts};
    }
    const members=groups.get(area)||[],limit=12;
    return {registry:version,area,registered:members.length,offset,next:members.length>offset+limit?offset+limit:null,
      members:members.slice(offset,offset+limit)};
  };
  read.dispatchPostcodes=async source=>{
    const {index,version}=await verifiedIndex(source);
    index.osanPostcodes??=new Map([...index.byCenter.osan].flatMap(([id,members])=>
      members.map(({code})=>[code,String(id).padStart(5,'0')])));
    return {registryVersion:version,postcodes:index.osanPostcodes};
  };
  read.dispatchDensityAssignments=async source=>{
    const {index,version}=await verifiedIndex(source);
    return {registryVersion:version,assignments:index.dispatchDensityAssignments};
  };
  return read;
}

export function stageCurrentPostalRegistrationReader({env=process.env,readRegistry,readRegistryVersion,fetchImpl=fetch,approvedRelease}={}) {
  const approval=env.OPSMAP_STAGE_CURRENT_POSTAL_REGISTRATION_APPROVED;
  if(!opsmapArchiveSite(env)||
      (approval!==undefined?approval!=='1':!approvedRelease))return null;
  const file=approval==='1'?env.OPSMAP_STAGE_CURRENT_POSTAL_REGISTRATION_FILE:null;
  const ref=approval==='1'?env.OPSMAP_STAGE_CURRENT_POSTAL_REGISTRATION_ARCHIVE_REF:approvedRelease.ref;
  const token=stagePostalReadToken(env);
  const sha256=approval==='1'?env.OPSMAP_STAGE_CURRENT_POSTAL_REGISTRATION_SHA256:approvedRelease.sha256;
  const encoded=env.OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64||'';
  const key=Buffer.from(encoded,'base64');
  if(typeof readRegistry!=='function'||typeof readRegistryVersion!=='function'||
      (ref?!/^[a-f0-9]{40}$/.test(ref)||!token||file:!isAbsolute(file||''))||
      !digest.test(sha256||'')||key.length!==32||key.toString('base64')!==encoded) {
    return async()=>{throw invalid();};
  }
  let versionFlight;
  const currentVersion=()=>{
    versionFlight??=Promise.resolve().then(readRegistryVersion).finally(()=>{versionFlight=null;});
    return versionFlight;
  };
  let refreshStore;
  return createCurrentPostalRegistrationReader({readRegistry,readRegistryVersion:currentVersion,async readAsset(version){
    refreshStore??=createStageCurrentPostalRefreshStore({env,fetchImpl});
    if(refreshStore){
      const {current}=await refreshStore.readHead();
      if(current){
        if(current.registry!==version)throw Error('POSTAL_CURRENT_REGISTRATION_CHANGED');
        const asset=verifyCurrentPostalRegistration(await refreshStore.readObject(current),current.sha256,key);
        if(['registry','boundary','release'].some(field=>asset.binding[field]!==current[field]))throw invalid();
        return asset;
      }
    }
    if(ref){
      const response=await fetchImpl(assetUrl+'?ref='+ref,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),
        headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github.raw+json','Accept-Encoding':'identity'}});
      if(!response.ok||!response.body){
        await response.body?.cancel().catch(()=>{});
        throw invalid();
      }
      let size=0;const chunks=[];
      for await(const chunk of response.body){
        size+=chunk.byteLength;
        if(size>maxBytes)throw invalid();
        chunks.push(chunk);
      }
      return verifyCurrentPostalRegistration(Buffer.concat(chunks,size),sha256,key);
    }
    const f=await open(file,'r');
    try{
      const st=await f.stat();
      if(!st.isFile()||st.size<29||st.size>maxBytes)throw invalid();
      const bytes=Buffer.alloc(st.size);
      let offset=0;
      while(offset<bytes.length){
        const {bytesRead}=await f.read(bytes,offset,bytes.length-offset,offset);
        if(!bytesRead)throw invalid();
        offset+=bytesRead;
      }
      if((await f.stat()).size!==bytes.length)throw invalid();
      return verifyCurrentPostalRegistration(bytes,sha256,key);
    } finally {await f.close();}
  }});
}
