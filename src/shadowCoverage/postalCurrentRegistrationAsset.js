import {createCipheriv,createDecipheriv,createHash,hkdfSync,randomBytes} from 'node:crypto';
import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../stageScope.js';
import {isCurrentPostalPoint} from './postalCurrentRegistration.js';

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

// An immutable package has no independent mutable pointer. Both active registry
// reads must identify the generation that was used for the geometry join.
export function createCurrentPostalRegistrationReader({readAsset,readRegistry,
  readRegistryVersion=async()=> (await readRegistry())?.ref?.version}) {
  let cached, pending, index;
  async function load(){
    if(cached)return cached;
    pending??=Promise.resolve().then(readAsset).then(value=>cached=value).finally(()=>{pending=null;});
    return pending;
  }
  return async({center='all',area,offset=0,registry,boundary,release,hasArea,hasLegacyCode})=>{
    if(!['all',...centers].includes(center)||!Number.isSafeInteger(offset)||offset<0||offset>maxRows||
        (area===undefined?offset!==0:!isPostalId(area)))throw Error('POSTAL_QUERY_INVALID');
    const before=await readRegistry();
    if(!digest.test(registry||'')||before?.ref?.version!==registry)throw Error('POSTAL_CURRENT_REGISTRATION_CHANGED');
    const asset=await load();
    if(asset.binding.registry!==registry||asset.binding.boundary!==boundary||asset.binding.release!==release) {
      throw Error('POSTAL_CURRENT_REGISTRATION_CHANGED');
    }
    if(!index){
      if(!Array.isArray(before.rows)||before.rows.length>maxRows)throw invalid();
      const byCode=new Map(before.rows.map(row=>[row.customerCode,row]));
      if(byCode.size!==before.rows.length)throw invalid();
      const byCenter={all:new Map(),osan:new Map(),yeongnam:new Map(),honam:new Map()};
      for(const [code,id] of asset.rows){
        const row=byCode.get(code);
        if(row?.lifecycle!=='ACTIVE'||!isCurrentPostalPoint(row)||hasLegacyCode(code)||!hasArea(id))throw invalid();
        const match={code,name:row.customerName,center:centers.has(row.centerGroup)?row.centerGroup:null};
        for(const group of [byCenter.all,...(match.center?[byCenter[match.center]]:[])]){
          const list=group.get(id)||[];
          list.push(match);
          group.set(id,list);
        }
      }
      index=byCenter;
    }
    if(await readRegistryVersion()!==registry)throw Error('POSTAL_CURRENT_REGISTRATION_CHANGED');
    const groups=index[center];
    if(area===undefined){
      const counts=[...groups].map(([id,rows])=>[id,rows.length]);
      return {registry,additionalRegistered:counts.reduce((total,[,count])=>total+count,0),counts};
    }
    const members=groups.get(area)||[],limit=12;
    return {registry,area,additionalRegistered:members.length,offset,next:members.length>offset+limit?offset+limit:null,
      members:members.slice(offset,offset+limit)};
  };
}

export function stageCurrentPostalRegistrationReader({env=process.env,readRegistry,readRegistryVersion}={}) {
  if(env.RENDER_SERVICE_ID!==STAGE_SERVICE||env.RENDER_EXTERNAL_URL!==STAGE_ORIGIN||
      env.OPSMAP_STAGE_CURRENT_POSTAL_REGISTRATION_APPROVED!=='1')return null;
  const file=env.OPSMAP_STAGE_CURRENT_POSTAL_REGISTRATION_FILE;
  const sha256=env.OPSMAP_STAGE_CURRENT_POSTAL_REGISTRATION_SHA256;
  const encoded=env.OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64||'';
  const key=Buffer.from(encoded,'base64');
  if(typeof readRegistry!=='function'||typeof readRegistryVersion!=='function'||
      !isAbsolute(file||'')||!digest.test(sha256||'')||key.length!==32||key.toString('base64')!==encoded) {
    return async()=>{throw invalid();};
  }
  let versionFlight;
  const currentVersion=()=>{
    versionFlight??=Promise.resolve().then(readRegistryVersion).finally(()=>{versionFlight=null;});
    return versionFlight;
  };
  return createCurrentPostalRegistrationReader({readRegistry,readRegistryVersion:currentVersion,async readAsset(){
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
