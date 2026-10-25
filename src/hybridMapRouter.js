import {createHybridHubAdapter} from './hybridHubAdapter.js';
import {createHash} from 'node:crypto';
const parseInteger=v=>typeof v==='string'&&/^[1-9]\d*$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):null;
// Read-policy gate only: reuses existing package/catalog verification and never publishes.
export function createHubPublicationReadGate({getAdapter,approval,enabled,legacyBusy=()=>false,timeoutMs=10000}){
 let active=false,pending,state={mode:'LEGACY',verified:false,reason:'OFF'};
 const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 async function initialize(){
  if(pending)return pending;
  pending=(async()=>{
   if(!approval)return false;
   let pin;try{pin=typeof approval==='string'?JSON.parse(approval):approval;}catch{state.reason='CUTOVER_CONFIG_INVALID';return false;}
   if(!enabled()||!pin||Object.keys(pin).sort().join(',')!=='catalogHash,consumer,manifestHash'
    ||pin.consumer!=='HYBRID_PAGED_V1'||![pin.catalogHash,pin.manifestHash].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))){state.reason='CUTOVER_CONFIG_INVALID';return false;}
   if(legacyBusy()){state.reason='LEGACY_BUSY';return false;}
   const controller=new AbortController();let timer;
   const operation=(async()=>{
    const adapter=getAdapter(),m=await adapter.getManifest({signal:controller.signal}),r=await adapter.getDateCatalog({signal:controller.signal}),c=r.data;
    if(!c||digest(m)!==pin.manifestHash||digest(c)!==pin.catalogHash||c.publication!=='PUBLISHED'
      ||c.completionVerified!==true||c.gaps.length||m.startDate!==c.startDate||m.endDate!==c.endDate
      ||m.customerCompletedThrough!==c.completedThrough||c.expectedThrough!==c.completedThrough
      ||Date.parse(c.endDate)-Date.parse(c.startDate)!==89*86400000
      ||m.coverage.unconfirmedDates.length||m.coverage.verifiedDates.length!==90||!m.dependencies.publicSource
      ||c.days.length!==90||c.days.some(d=>!d.verified||!d.complete))throw Error('CUTOVER_NOT_VERIFIED');
    // Re-read roots: never join two generations or substitute a HELD preparation.
    const m2=await adapter.getManifest({signal:controller.signal}),c2=(await adapter.getDateCatalog({signal:controller.signal})).data;
    if(digest(m2)!==pin.manifestHash||digest(c2)!==pin.catalogHash||legacyBusy())throw Error('CUTOVER_CHANGED');
    controller.signal.throwIfAborted();
    active=true;state={mode:'HUB_PUBLISHED',verified:true,packageVersion:m.version,catalogVersion:c.version,completedThrough:c.completedThrough};return true;
   })();
   try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('CUTOVER_TIMEOUT'));},timeoutMs);})]);}
   catch{state={mode:'LEGACY',verified:false,reason:'PUBLICATION_NOT_VERIFIED'};return false;}
   finally{clearTimeout(timer);controller.abort();}
  })();return pending;
 }
 // Once active, upstream read failures fail closed in the existing adapter. They
 // never restart Render restoration or silently mix the old snapshot into a new version.
 return {initialize,isActive:()=>active,status:()=>({...state})};
}
export function mountHybridMapReadApi(app,{enabled,requireStaff,previewEnabled,callHub,today,readIndexedDay,readDateCatalog,readDatePage,publicationCutover=null,legacyBusy,uiReadiness=()=>({verification:'PENDING',publicationHeld:true})}){
 let adapter;const getAdapter=()=>adapter||(adapter=createHybridHubAdapter({callHub,today,readIndexedDay,readDateCatalog,readDatePage}));
 const publicationReadGate=createHubPublicationReadGate({getAdapter,approval:publicationCutover,enabled:()=>enabled()&&previewEnabled(),legacyBusy});
 const prefix='/api/map-phase2b/hybrid';
 const gate=(req,res,next)=>{res.set('Cache-Control','private, no-store');res.set('Vary','Cookie');if(!enabled()||!previewEnabled())return res.status(404).json({error:'HYBRID_DISABLED'});return requireStaff(req,res,next);};
 app.get(`${prefix}/ui-status`,gate,(_req,res)=>{
  // B may consume stored data only after the existing full-90 publication gate.
  const state=publicationReadGate.isActive()?{verification:'VERIFIED',publicationHeld:false,rollingDateIndexEnabled:true}:uiReadiness();
  return res.json({verification:state?.verification==='VERIFIED'?'VERIFIED':'PENDING',publicationHeld:state?.publicationHeld!==false,rollingDateIndexEnabled:state?.rollingDateIndexEnabled===true&&typeof readDateCatalog==='function'&&typeof readDatePage==='function'});
 });
 const handlers={manifest:q=>getAdapter().getManifest({signal:q.signal}),chunk:q=>getAdapter().getChunk(q),assignments:q=>getAdapter().getDated(q),catalog:q=>getAdapter().getDateCatalog(q),range:q=>getAdapter().getRange(q)};
 for(const [name,handler] of Object.entries(handlers))app.get(`${prefix}/${name}`,gate,async(req,res)=>{
  const controller=new AbortController(),cancel=()=>controller.abort();req.once('aborted',cancel);res.once('close',cancel);
  try{
   const allowed=name==='manifest'?[]:name==='catalog'?['catalogVersion','date']:name==='range'?['catalogVersion','startDate','endDate','cursor']:name==='chunk'?['version','sourceGeneration','key']:['version','sourceGeneration','date','vehicle','cursor','limit','sourceRevision'];
   if(Object.keys(req.query).some(k=>!allowed.includes(k)||typeof req.query[k]!=='string'))return res.status(400).json({error:'HYBRID_REQUEST_INVALID'});
   const q={...req.query,signal:controller.signal};
   if(!['manifest','catalog','range'].includes(name)){
    q.version=parseInteger(q.version);q.sourceGeneration=parseInteger(q.sourceGeneration);
    if(!q.version||!q.sourceGeneration)return res.status(400).json({error:'HYBRID_REQUEST_INVALID'});
   }
   if(name==='chunk'&&!/^public-\d{1,3}$/.test(q.key||''))return res.status(400).json({error:'HYBRID_REQUEST_INVALID'});
   if(name==='assignments'){q.limit=q.limit===undefined?300:parseInteger(q.limit);q.vehicle=q.vehicle||'';}
   const value=await handler(q);
   if(controller.signal.aborted)return;
   // Existing staff session is rechecked after every upstream read, including public package reads.
   return requireStaff(req,res,()=>{res.set('Cache-Control','private, no-store');return res.json(name==='manifest'?{ok:true,data:value,meta:{restoreRequired:false}}:value);});
  }catch(error){
   if(controller.signal.aborted||res.destroyed)return;
   const known=['HYBRID_RANGE_REQUEST_INVALID','HYBRID_RANGE_CURSOR','HYBRID_DATE_CATALOG_UNAVAILABLE','HYBRID_DATE_READER_UNAVAILABLE','HYBRID_GENERATION_CHANGED','HYBRID_DATE_REVISION_CHANGED','HYBRID_DATE_REVISION_UNAVAILABLE','HYBRID_DATE_REVISION_REQUIRED','HYBRID_BUSY','HYBRID_READ_BACKOFF','HYBRID_DATE_REQUEST_INVALID','HYBRID_CHUNK_NOT_FOUND'];
   const code=known.includes(error.message)?error.message:'HYBRID_READ_UNAVAILABLE';
   const status=['HYBRID_BUSY','HYBRID_READ_BACKOFF'].includes(code)?429:code.includes('CHANGED')?409:['HYBRID_DATE_REQUEST_INVALID','HYBRID_RANGE_REQUEST_INVALID','HYBRID_RANGE_CURSOR'].includes(code)?400:code==='HYBRID_CHUNK_NOT_FOUND'?404:503;
   if(status===429)res.set('Retry-After','1');return res.status(status).json({ok:false,data:null,error:code,retryable:[409,429,503].includes(status)});
  }finally{req.removeListener('aborted',cancel);res.removeListener('close',cancel);}
 });
 return {stats:()=>adapter?.stats()||{active:0,inFlight:0},publicationReadGate};
}
