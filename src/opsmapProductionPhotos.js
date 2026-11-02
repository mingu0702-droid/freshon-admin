// Reuses the existing C transport/parser/router. No login, collector or persistent photo cache.
import {createDeliveryAdminPhotoSource,DeliveryPhotoError,validatePhotoQuery} from './opsmapDeliveryPhotos.js';
import {createDeliveryAdminPhotoTransport,DELIVERY_ADMIN_PHOTO_CATEGORY_MAP,DELIVERY_ADMIN_PHOTO_HOSTS} from './opsmapDeliveryAdminTransport.js';
import {mountOpsmapDeliveryPhotoRoutes} from './opsmapDeliveryPhotoRouter.js';
const fail=(code,status=503,stage='source-session',sourceHttpStatus)=>{throw new DeliveryPhotoError(code,status,{stage,...(Number.isInteger(sourceHttpStatus)?{sourceHttpStatus}:{})});};
const session=has=>{if(typeof has!=='function'||has()!==true)fail('UPSTREAM_AUTH_REQUIRED',502);};
const checkLimit=(value,maximum)=>Number.isInteger(value)&&value>=1&&value<=maximum;
// This is a single approved verification scope, not a general-photo rollout.
// reserveRead must atomically reserve against the cumulative external approval ledger;
// process-local counters below are only additional ceilings, never a fresh allowance.
export function createProductionPhotoExtension({enabled=false,rawRequest,hasMemorySession,
 approvedRecords=[],approvalId='',reserveRead,imageFetch=globalThis.fetch,
 maxTaskReads=2,maxMediaReads=1,maxPhotosPerDelivery=1}={}){
 if(!checkLimit(maxTaskReads,2)||!checkLimit(maxMediaReads,1)||!checkLimit(maxPhotosPerDelivery,1))throw Error('PHOTO_BINDING_CONFIG_REJECTED');
 const isEnabled=()=>typeof enabled==='function'?enabled()===true:enabled===true;
 const records=new Map();
 if(!Array.isArray(approvedRecords)||approvedRecords.length>2)throw Error('PHOTO_BINDING_CONFIG_REJECTED');
 for(const item of approvedRecords){
  const identity=validatePhotoQuery(item);
  if(!identity.date||!identity.deliveryId||!['REFRIGERATOR_DOOR','ENTRANCE_LOCK'].includes(item.firstKind))throw Error('PHOTO_BINDING_CONFIG_REJECTED');
  const key=JSON.stringify(identity);if(records.has(key))throw Error('PHOTO_BINDING_CONFIG_REJECTED');records.set(key,{...identity,firstKind:item.firstKind});
 }
 let taskReads=0,mediaReads=0;
 const approvalReady=()=>/^[A-Za-z0-9_-]{8,128}$/.test(approvalId)&&records.size>0&&typeof reserveRead==='function';
 const approved=()=>isEnabled()&&approvalReady()&&typeof rawRequest==='function'&&typeof hasMemorySession==='function'&&hasMemorySession()===true;
 function permitted(identity){
  if(!approvalReady())fail('PHOTO_APPROVAL_REQUIRED',503,'source-session');
  const record=records.get(JSON.stringify(validatePhotoQuery(identity)));
  if(!record)fail('PHOTO_FORBIDDEN',403,'source-identity');return record;
 }
 async function reserve(operation,identity,signal){
  if(signal?.aborted)fail('PHOTO_TIMEOUT',504,'source-timeout');
  let value;try{value=await reserveRead({approvalId,operation,customerCode:identity.customerCode,date:identity.date,deliveryId:identity.deliveryId},{signal});}catch{fail('PHOTO_APPROVAL_REQUIRED',503,'source-session');}
  if(value?.reserved!==true||value.approvalId!==approvalId||value.operation!==operation||value.customerCode!==identity.customerCode||value.date!==identity.date||value.deliveryId!==identity.deliveryId)fail('PHOTO_APPROVAL_REQUIRED',503,'source-session');
  if(signal?.aborted)fail('PHOTO_TIMEOUT',504,'source-timeout');
 }
 const sources=new Map();
 for(const [key,identity] of records){
  const transport=createDeliveryAdminPhotoTransport({hasApprovedSession:approved,
   approvedRequest:async(path,options)=>{
    permitted(identity);session(approved);
    if(path!=='/api/bali/task/'+identity.deliveryId||options.method!=='GET')fail('INVALID_PHOTO_REQUEST',400,'source-identity');
    if(taskReads>=maxTaskReads)fail('PHOTO_RATE_LIMITED',429);await reserve('detail',identity,options.signal);taskReads++;
    return rawRequest(path,{method:'GET',signal:options.signal,redirect:'error',cache:'no-store',timeoutMs:8000});
   },imageFetch:async(url,options)=>{
    permitted(identity);session(approved);
    if(mediaReads>=maxMediaReads)fail('PHOTO_RATE_LIMITED',429,'source-media');await reserve('media',identity,options.signal);mediaReads++;
    return imageFetch(url,options);
   }});
  sources.set(key,createDeliveryAdminPhotoSource({...transport,firstPhotoKind:identity.firstKind,
   categoryMap:DELIVERY_ADMIN_PHOTO_CATEGORY_MAP,allowedImageHosts:DELIVERY_ADMIN_PHOTO_HOSTS}));
 }
 const limitedSource={
  async list(query,options){
   if(!approvalReady())fail('PHOTO_APPROVAL_REQUIRED',503,'source-session');
   const identity=validatePhotoQuery({customerCode:query.customerCode,...(query.date?{date:query.date}:{}),...(query.deliveryId?{deliveryId:query.deliveryId}:{})});
   if(!identity.deliveryId){
    const matches=[...records.values()].filter(r=>r.customerCode===identity.customerCode&&(!identity.date||r.date===identity.date));
    if(!matches.length)fail('PHOTO_FORBIDDEN',403,'source-identity');
    // Discovery exposes only the server's approved identifiers; no source scan/login.
    return matches.map(({customerCode,date,deliveryId})=>({customerCode,date,deliveryId,notes:'',status:'UNVERIFIED',photos:[]}));
   }
   permitted(identity);session(approved);
   return (await sources.get(JSON.stringify(identity)).list(identity,options)).map(row=>({...row,notes:'',photos:row.photos.slice(0,maxPhotosPerDelivery)}));
  },
  async openMedia(identity,ref,options){
   permitted(identity);session(approved);
   // Reject a second image before spending another detail-read reservation.
   if(mediaReads>=maxMediaReads)fail('PHOTO_RATE_LIMITED',429,'source-media');
   return sources.get(JSON.stringify(identity)).openMedia(identity,ref,options);
  }
 };
 return {diagnostics:()=>({enabled:isEnabled(),approvalConfigured:approvalReady(),sourceSession:approved(),taskReads,mediaReads,maxTaskReads,maxMediaReads}),
  mount:({app,requireStaff,isSessionCurrent,previewEnabled})=>mountOpsmapDeliveryPhotoRoutes({app,requireStaff,isSessionCurrent,source:limitedSource,
   enabled:()=>isEnabled()&&previewEnabled()===true,timeoutMs:8000,maxConcurrent:1,maxImageBytes:4*1024*1024})};
}

export function mountProductionPhotoBinding({env=process.env,rawRequest,hasMemorySession,reserveRead,...binding}={}){
 let approvedRecords=[];
 try{approvedRecords=JSON.parse(env.OPSMAP_PHOTO_APPROVED_RECORDS||'[]');}catch{/* A malformed optional setting must not stop the map server. */}
 let extension;
 try{extension=createProductionPhotoExtension({enabled:()=>env.OPSMAP_PRODUCTION_PHOTO_VERIFY==='1',
  approvalId:env.OPSMAP_PHOTO_APPROVAL_ID||'',approvedRecords,rawRequest,hasMemorySession,reserveRead});}
 catch{extension=createProductionPhotoExtension({enabled:()=>env.OPSMAP_PRODUCTION_PHOTO_VERIFY==='1'});}
 extension.mount(binding);return extension;
}
