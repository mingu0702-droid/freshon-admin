import {isCurrentPostalPoint,projectCurrentPostalRegistration} from './postalCurrentRegistration.js';
import {sealCurrentPostalRegistration,verifyCurrentPostalRegistration} from './postalCurrentRegistrationAsset.js';
import {currentPostalRegistrationFallback} from './postalCurrentRegistrationStore.js';
import {stagePostalReadToken} from './stagePostalAssets.js';
import {opsmapArchiveSite} from '../stageScope.js';

const hex=/^[a-f0-9]{64}$/;
const conflict=error=>error?.code==='FIXED_STORE_CONFLICT';
const fail=code=>Error('POSTAL_REGISTRATION_REFRESH_'+code);
const sameBinding=(a,b)=>a?.registry===b?.registry&&a?.boundary===b?.boundary&&a?.release===b?.release;

export async function readStageCurrentPostalFallback({env,fetchImpl=fetch}) {
  if(!opsmapArchiveSite(env)||
      env.OPSMAP_STAGE_CURRENT_POSTAL_REFRESH_APPROVED!=='1')throw fail('SCOPE');
  const token=stagePostalReadToken(env);
  if(!token)throw fail('CREDENTIALS');
  const url='https://api.github.com/repos/mingu0702-droid/freshon-cache/contents/opsmap-stage/postal-v1/current-registration-v1.sealed?ref='+
    currentPostalRegistrationFallback.ref;
  const response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000),
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github.raw+json','Accept-Encoding':'identity'}});
  if(!response.ok||!response.body){
    await response.body?.cancel().catch(()=>{});
    throw fail('SEED');
  }
  const chunks=[];let size=0;
  for await(const chunk of response.body){
    size+=chunk.byteLength;
    if(size>512*1024)throw fail('SEED');
    chunks.push(chunk);
  }
  return {bytes:Buffer.concat(chunks,size),sha256:currentPostalRegistrationFallback.sha256};
}

function proveAsset(bytes,ref,key){
  const asset=verifyCurrentPostalRegistration(bytes,ref.sha256,key);
  if(!sameBinding(asset.binding,ref))throw fail('BINDING');
  return asset;
}
const samePoint=(prior,next)=>prior?.lifecycle==='ACTIVE'&&isCurrentPostalPoint(prior)&&
  prior.addressHash===next.addressHash&&prior.centerGroup===next.centerGroup&&
  ['lat','lng','kind'].every(key=>prior.verifiedLocation[key]===next.verifiedLocation[key]);

export async function refreshStageCurrentPostalRegistration({store,readRegistry,readRegistryVersion,readRegistryRows,
  readLegacyRegistration,readDetailTiles,binding,fallback}) {
  if(!store?.writeHead||!store.createObject||!hex.test(binding?.boundary||'')||!hex.test(binding?.release||''))throw fail('SCOPE');
  const registry=await readRegistry();
  const version=registry?.ref?.version;
  if(!hex.test(version||'')||!Array.isArray(registry?.rows))throw fail('REGISTRY');
  const assertVersion=async()=>{if(await readRegistryVersion()!==version)throw fail('REGISTRY_CHANGED');};
  await assertVersion();
  const head=await store.readHead();
  let oldRef=head.current, old, seedBytes;
  if(oldRef)old=proveAsset(await store.readObject(oldRef),oldRef,store.key);
  else{
    const seed=await fallback();
    old=verifyCurrentPostalRegistration(seed.bytes,seed.sha256,store.key);
    oldRef={...old.binding,sha256:seed.sha256};
    seedBytes=seed.bytes;
  }
  if(oldRef.boundary!==binding.boundary||oldRef.release!==binding.release)throw fail('BINDING');
  if(oldRef.registry===version){
    await assertVersion();
    return {state:'VERIFIED_NOOP',registry:version,matchedCount:old.rows.length};
  }
  const previousRows=await readRegistryRows(oldRef.registry);
  if(!Array.isArray(previousRows))throw fail('PREVIOUS_REGISTRY');
  const previous=new Map(previousRows.map(row=>[row.customerCode,row]));
  const oldLinks=new Map(old.rows), seen=new Set(), same=new Map(), changed=[];
  if(previous.size!==previousRows.length||old.rows.some(([code])=>{
    const row=previous.get(code);
    return row?.lifecycle!=='ACTIVE'||!isCurrentPostalPoint(row);
  }))throw fail('PREVIOUS_REGISTRY');
  const legacyCodes=await readLegacyRegistration();
  if(!(legacyCodes instanceof Set)||old.rows.some(([code])=>legacyCodes.has(code)))throw fail('LEGACY_BINDING');
  for(const row of registry.rows){
    const code=row?.customerCode;
    if(typeof code!=='string'||!/^[A-Z]\d{1,20}$/.test(code)||seen.has(code))throw fail('REGISTRY_IDENTITY');
    seen.add(code);
    if(row.lifecycle!=='ACTIVE'||legacyCodes.has(code)||!isCurrentPostalPoint(row))continue;
    if((oldLinks.has(code)||head.current)&&samePoint(previous.get(code),row)){
      if(oldLinks.has(code))same.set(code,{area:oldLinks.get(code),center:row.centerGroup});
    }else changed.push(row);
  }
  const projection=await projectCurrentPostalRegistration(changed,legacyCodes,
    changed.length?await readDetailTiles(changed):[]);
  const assignments=new Map([...same,...projection.assignments]);
  const lost=old.rows.filter(([code])=>!assignments.has(code)).length;
  if(lost>=Math.max(10,Math.ceil(old.rows.length*0.005)))throw fail('BULK_LOSS');
  const nextBinding={...binding,registry:version};
  const {bytes,sha256}=sealCurrentPostalRegistration({binding:nextBinding,assignments},store.key);
  const next={...nextBinding,sha256};
  async function createAndVerify(ref,bytes) {
    try{await store.createObject(ref,bytes);}
    catch(error){if(!conflict(error))throw error;}
    return proveAsset(await store.readObject(ref),ref,store.key);
  }
  await assertVersion();
  if(seedBytes)await createAndVerify(oldRef,seedBytes);
  const candidate=await createAndVerify(next,bytes);
  await assertVersion();
  try{await store.writeHead(next,oldRef,head.etag);}
  catch(error){
    if(!conflict(error))throw error;
  }
  const confirmed=await store.readHead();
  if(!sameBinding(confirmed.current,next)||!confirmed.previous||confirmed.previous.sha256!==oldRef.sha256)throw fail('SUPERSEDED');
  const final=proveAsset(await store.readObject(confirmed.current),confirmed.current,store.key);
  if(JSON.stringify(final.rows)!==JSON.stringify(candidate.rows))throw fail('SUPERSEDED');
  await assertVersion();
  return {state:confirmed.current.sha256===sha256?'PUBLISHED':'VERIFIED_NOOP',
    registry:version,matchedCount:assignments.size,reusedCount:same.size,changedCount:changed.length,
    ambiguousCount:projection.counts.ambiguous,outsideCount:projection.counts.outside};
}
