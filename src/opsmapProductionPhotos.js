// Reuses the existing C transport/parser/router. No login, collector or persistent photo cache.
import {createDeliveryAdminPhotoSource,DeliveryPhotoError,deliveryDate,validatePhotoQuery} from './opsmapDeliveryPhotos.js';
import {createDeliveryAdminPhotoTransport,DELIVERY_ADMIN_PHOTO_CATEGORY_MAP,DELIVERY_ADMIN_PHOTO_HOSTS,readBoundedPhotoLoginJson} from './opsmapDeliveryAdminTransport.js';
import {mountOpsmapDeliveryPhotoRoutes} from './opsmapDeliveryPhotoRouter.js';
const fail=(code,status=503,stage='source-session',sourceHttpStatus)=>{throw new DeliveryPhotoError(code,status,{stage,...(Number.isInteger(sourceHttpStatus)?{sourceHttpStatus}:{})});};
const session=has=>{if(typeof has!=='function'||has()!==true)fail('UPSTREAM_AUTH_REQUIRED',502);};
const checkLimit=(value,maximum)=>Number.isInteger(value)&&value>=1&&value<=maximum;
// The only list query is the existing server's date-scoped page-zero contract.
// Missing customer on an incomplete page remains UNVERIFIED, never EMPTY.
export function createProductionPhotoMetadataReader({rawRequest,hasMemorySession,maxReads=2,pageSize=100,extractRows}={}){
 if(!checkLimit(maxReads,2)||!checkLimit(pageSize,100)||typeof rawRequest!=='function')throw Error('PHOTO_BINDING_CONFIG_REJECTED');
 let reads=0;
 return async(identity, {signal}={})=>{
  validatePhotoQuery(identity);session(hasMemorySession);
  if(!identity.date)fail('UNVERIFIED',503,'source-identity');
  if(reads>=maxReads)fail('PHOTO_RATE_LIMITED',429);reads++;
  const date=identity.date+'T00:00:00+09:00',query=new URLSearchParams({logisticsCenterId:'1',page:'0',pageSize:String(pageSize)});
  query.append('enteringDatedAtBetween',date);query.append('enteringDatedAtBetween',date);
  const response=await rawRequest('/api/bali/task?'+query,{method:'GET',signal,redirect:'error',cache:'no-store',timeoutMs:8000});
  if(response?.redirected||response?.status!==200){try{void response?.body?.cancel?.();}catch{}fail(response?.status===401?'UPSTREAM_AUTH_REQUIRED':'PHOTO_LOOKUP_FAILED',502,'source-http',response?.status);}
  const payload=await readBoundedPhotoLoginJson(response,256*1024,signal||new AbortController().signal);session(hasMemorySession);
  const rows=typeof extractRows==='function'?extractRows(payload):payload?.data?.content??payload?.content;
  if(!Array.isArray(rows)||rows.length>pageSize)fail('INVALID_PHOTO_RESPONSE',502,'source-json');
  const matches=[];
  for(const task of rows){const code=task?.customer?.erpCode??task?.customerErpCode,date=deliveryDate(task?.carrier?.enteringDatedAt??task?.enteringDatedAt),id=String(task?.id??'');
   if(code===identity.customerCode&&date===identity.date&&/^\d{1,20}$/.test(id))matches.push({customerCode:code,date,deliveryId:id});}
  if(!matches.length)fail('UNVERIFIED',503,'source-identity');
  if(matches.length>32)fail('INVALID_PHOTO_RESPONSE',502,'source-identity');
  return matches;
 };
}

// Verification is deliberately narrower than general rollout: one image and two metadata pages.
// These counters are per process, not an assertion of a replenished remote approval budget.
export function createProductionPhotoExtension({enabled=false,rawRequest,hasMemorySession,listDeliveryMetadata,
 imageFetch=globalThis.fetch,maxTaskReads=4,maxMediaReads=1,maxPhotosPerDelivery=1}={}){
 if(!checkLimit(maxTaskReads,4)||!checkLimit(maxMediaReads,1)||!checkLimit(maxPhotosPerDelivery,1))throw Error('PHOTO_BINDING_CONFIG_REJECTED');
 let taskReads=0,mediaReads=0;
 const approved=()=>enabled===true&&typeof rawRequest==='function'&&typeof hasMemorySession==='function'&&hasMemorySession()===true;
 const transport=createDeliveryAdminPhotoTransport({hasApprovedSession:approved,
  approvedRequest:async(path,options)=>{
   session(approved);if(!/^\/api\/bali\/task\/\d{1,20}$/.test(path)||options.method!=='GET')fail('INVALID_PHOTO_REQUEST',400,'source-identity');
   if(taskReads>=maxTaskReads)fail('PHOTO_RATE_LIMITED',429);taskReads++;
   return rawRequest(path,{method:'GET',signal:options.signal,redirect:'error',cache:'no-store',timeoutMs:8000});
  },imageFetch:async(url,options)=>{if(mediaReads>=maxMediaReads)fail('PHOTO_RATE_LIMITED',429,'source-media');mediaReads++;return imageFetch(url,options);}});
 const source=createDeliveryAdminPhotoSource({...transport,listDeliveryMetadata,
  categoryMap:DELIVERY_ADMIN_PHOTO_CATEGORY_MAP,allowedImageHosts:DELIVERY_ADMIN_PHOTO_HOSTS});
 const limitedSource={list:async(...args)=>(await source.list(...args)).map(row=>({...row,notes:'',photos:row.photos.slice(0,maxPhotosPerDelivery)})),openMedia:(...args)=>{if(mediaReads>=maxMediaReads)fail('PHOTO_RATE_LIMITED',429,'source-media');return source.openMedia(...args);}};
 return {diagnostics:()=>({enabled:enabled===true,sourceSession:approved(),taskReads,mediaReads,maxTaskReads,maxMediaReads}),
  mount:({app,requireStaff,isSessionCurrent,previewEnabled})=>mountOpsmapDeliveryPhotoRoutes({app,requireStaff,isSessionCurrent,source:limitedSource,
   enabled:()=>enabled===true&&previewEnabled()===true,timeoutMs:8000,maxConcurrent:1,maxImageBytes:4*1024*1024})};
}
