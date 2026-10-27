// Read-only status/projection and one administrator-only stored-data job request.
// This module never calls a collector or writes Customer data.
import express from 'express';
import compression from 'compression';
import {requireAdmin} from './auth.js';
import {createFixedVehicleCache} from './fixedVehicleCache.js';
import {createFixedVehicleStore,createFixedVehicleFileStore} from './fixedVehicleStore.js';

// Stage preparation / loaded period-model metadata is NOT the public map root.
// Hub's field called "published" does not certify a Production publication,
// source-bound completion or a PRIVATE/SEALED receipt.
export function mapPublicationConnection(hubStatus,liveStatus){
  const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v?v:null;
  const generation=v=>Number.isSafeInteger(v)&&v>0?v:null;
  const p=hubStatus?.published||{},live=liveStatus||{};
  const checkpoint={generation:generation(p.generation),startDate:day(p.startDate),endDate:day(p.endDate)};
  const serving={ready:live.ready===true&&live.source==='Hub.StageReadModel',generation:generation(live.generation),startDate:day(live.startDate),endDate:day(live.endDate)};
  const validRange=v=>v.startDate!==null&&v.endDate!==null&&v.startDate<=v.endDate;
  const matched=serving.ready&&checkpoint.generation!==null&&checkpoint.generation===serving.generation&&validRange(checkpoint)&&validRange(serving)&&checkpoint.startDate===serving.startDate&&checkpoint.endDate===serving.endDate;
  return {status:!serving.ready?'SERVING_MODEL_UNCONFIRMED':matched?'SERVING_GENERATION_MATCHED':'CHECKPOINT_SERVING_MISMATCH',
    root:{project:'Hub',storage:'ScriptProperties',key:'PHASE2B_STAGE_READ_MODEL_V1',reader:'hubStageModelLoad_',format:'DRIVE_FILE_ID',role:'STAGE_PREPARATION_ONLY',publicPointer:false,rawPointerVerified:false},
    checkpoint,serving,servingGenerationMatch:matched,rollingRootVerified:false,
    sourceBoundCompletionVerified:false,privateSealedBindingVerified:false,oneDateValidationAllowed:false};
}

export function mountMapDataFreshness(app,{callHub,requireView,requireBaseVehicleView=requireView,previewEnabled,modelStatus,readBaseVehicleMaster,env=process.env,adminGuard=requireAdmin,baseStore=env.OPSMAP_STAGE_FIXED_MASTER_FILE?createFixedVehicleFileStore({env}):env.GITHUB_CACHE_REPO?createFixedVehicleStore({env}):null}){
  let statusCache=null,statusAt=0,statusPending=null;
  const base=createFixedVehicleCache({reader:readBaseVehicleMaster||(()=>{throw new Error('FIXED_MASTER_UNAVAILABLE');}),store:baseStore,readOnly:env.OPSMAP_STAGE_VERIFY_ONLY==='1'});
  const cleanDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'')?v:null;
  const code=v=>/^[A-Z0-9_]+$/.test(v||'')?v:'UNKNOWN';
  async function readStatus(){
    if(statusCache&&Date.now()-statusAt<20000)return statusCache;
    if(statusPending)return statusPending;
    statusPending=(async()=>{
      const [model,details]=await Promise.all([callHub('mapModelStatus',{}, {useCache:false}),callHub('customerDetailsStatus',{}, {useCache:false,privateRead:true,maxResponseBytes:8192}).catch(()=>null)]);
      const raw=model.data||{},c=raw.customer||{},p=raw.published||{},j=raw.job,detail=details?.data;
      const customerDetails=detail?{prepared:detail.prepared===true,version:Number.isSafeInteger(detail.version)?detail.version:null,automatic:detail.automatic===true,phase:code(detail.job?.phase||'NOT_STARTED'),preparedCustomers:Number.isSafeInteger(detail.job?.preparedCustomers)?detail.job.preparedCustomers:null,updatedAt:typeof detail.job?.updatedAt==='string'&&Number.isFinite(Date.parse(detail.job.updatedAt))?detail.job.updatedAt:null,lastError:detail.job?.lastError?code(detail.job.lastError):null}:null;
      statusCache={customerDetails,customer:{freshon:cleanDate(c.freshon),delivery:cleanDate(c.delivery),proof:code(c.proof)},
        published:{generation:Number(p.generation)||null,startDate:cleanDate(p.startDate),endDate:cleanDate(p.endDate),status:code(p.status)},
        job:j?Object.fromEntries(['phase','generation','baseGeneration','startDate','endDate','buildAt','verifyAt','sendAt','shards','lastError','updatedAt','commitHttp','publication'].map(k=>[k,j[k]??null])):null,
        coverage:{generation:Number(raw.coverage?.generation)||null,proof:code(raw.coverage?.proof),
          history:(raw.coverage?.history||[]).filter(cleanDate),period:(raw.coverage?.period||[]).filter(cleanDate)},
        automatic:raw.automatic&&typeof raw.automatic==='object'?code(raw.automatic.status):'NOT_CONFIGURED',
        automation:raw.automatic&&typeof raw.automatic==='object'?{configured:raw.automatic.configured===true,status:code(raw.automatic.status),lastCheck:raw.automatic.lastCheck||null,lastRequest:raw.automatic.lastRequest||null,lastSuccess:raw.automatic.lastSuccess||null,lastError:raw.automatic.lastError?code(raw.automatic.lastError):null,generation:Number(raw.automatic.generation)||null}:{configured:false,status:'NOT_CONFIGURED'},continuation:raw.continuation==='ACTIVE'?'ACTIVE':'NONE',checkedAt:new Date().toISOString()};
      statusAt=Date.now();return statusCache;
    })().finally(()=>{statusPending=null;});return statusPending;
  }
  const enabled=(_q,r,n)=>previewEnabled()?n():r.sendStatus(404);
  app.get('/api/map-phase2b/preview/data-status',requireView,enabled,async(_q,r)=>{
    r.set('Cache-Control','no-store');
    try{const status=await readStatus(),live=modelStatus();return r.json({ok:true,data:{...status,live,publicationConnection:mapPublicationConnection(status,live)}});}catch{return r.status(503).json({error:'MAP_DATA_STATUS_UNAVAILABLE'});}
  });
  async function baseResponse(q,r){
    r.set('Cache-Control','no-store');
    const requested=q.method==='POST'?q.body?.customerCodes:q.query.customerCodes?String(q.query.customerCodes).split(','):q.query.customerCode?[q.query.customerCode]:[];
    if(q.method==='GET'&&(q.query.customerCodes?.length>8000||requested.length>500))return r.status(400).json({error:'INVALID_CUSTOMER_CODES'});
    if(!Array.isArray(requested)||requested.length>10000||requested.some(v=>typeof v!=='string'||!/^[A-Z]\d+$/.test(v)))return r.status(400).json({error:'INVALID_CUSTOMER_CODES'});
    const payload=await base.get([...new Set(requested)]);
    return r.status(payload.ok?200:payload.phase==='ERROR'?503:202).json({...payload,progress:readBaseVehicleMaster?.getProgress?.()||null});
  }
  app.get('/api/map-phase2b/preview/base-vehicles',requireBaseVehicleView,enabled,compression({threshold:1024}),baseResponse);
  app.post('/api/map-phase2b/preview/base-vehicles',requireBaseVehicleView,enabled,express.json({limit:'128kb'}),compression({threshold:1024}),baseResponse);
  app.post('/api/map-phase2b/admin/model-sync',enabled,express.json({limit:'1kb'}),(q,r,n)=>{
    r.set('Cache-Control','private, no-store');
    if(!q.get('x-admin-token')||q.query.token)return r.status(401).json({error:'ADMIN_HEADER_REQUIRED'});
    if(q.get('origin')!==env.RENDER_EXTERNAL_URL||env.RENDER_EXTERNAL_URL!=='https://freshon-admin-1.onrender.com')return r.status(403).json({error:'ORIGIN_NOT_ALLOWED'});
    if(!q.is('application/json')||Object.keys(q.body||{}).length)return r.status(400).json({error:'INVALID_REQUEST'});
    return adminGuard(q,r,n);
  },async(_q,r)=>{
    try{
      const result=await callHub('mapModelIncrementalRequest',{target:'production'},{useCache:false});
      statusCache=null;statusAt=0;
      const d=result.data||{};
      return r.status(d.phase==='ERROR'?409:202).json({ok:d.phase!=='ERROR',data:{phase:d.phase,generation:d.generation||null,sendAt:d.sendAt??null,endDate:cleanDate(d.endDate),lastError:code(d.lastError)}});
    }catch{return r.status(502).json({error:'MODEL_SYNC_REQUEST_UNCONFIRMED'});}
  });
  app.post('/api/map-phase2b/admin/customer-details-sync',enabled,express.json({limit:'1kb'}),(q,r,n)=>{
    r.set('Cache-Control','private, no-store');
    if(!q.get('x-admin-token')||q.query.token)return r.status(401).json({error:'ADMIN_HEADER_REQUIRED'});
    if(q.get('origin')!==env.RENDER_EXTERNAL_URL||env.RENDER_EXTERNAL_URL!=='https://freshon-admin-1.onrender.com')return r.status(403).json({error:'ORIGIN_NOT_ALLOWED'});
    if(!q.is('application/json')||Object.keys(q.body||{}).length)return r.status(400).json({error:'INVALID_REQUEST'});
    return adminGuard(q,r,n);
  },async(_q,r)=>{
    try{
      const result=await callHub('customerDetailsSyncRequest',{}, {useCache:false,privateRead:true});
      // Request acknowledgement only; the existing Hub tick continues the job.
      const d=result.data||{};
      return r.status(['ERROR','HELD'].includes(d.phase)?409:d.phase==='NOOP'?200:202).json({ok:!['ERROR','HELD'].includes(d.phase),data:{phase:code(d.phase),version:Number.isSafeInteger(d.version)?d.version:null,scannedRows:Number.isSafeInteger(d.scannedRows)?d.scannedRows:null,completed:false,lastError:d.lastError?code(d.lastError):null}});
    }catch{return r.status(502).json({error:'CUSTOMER_DETAILS_SYNC_REQUEST_UNCONFIRMED'});}
  });
  function coverage(start,end,kind){
    const proof=statusCache?.coverage,live=modelStatus();
    const verified=proof?.generation===live.generation&&proof.proof==='GENERATION_SHARD_HASH_AND_COLLECTION_LOG_MATCH'?new Set(proof[kind]):new Set();
    const verifiedDates=[],unconfirmedDates=[];
    for(let t=Date.parse(start);t<=Date.parse(end);t+=86400000){const date=new Date(t).toISOString().slice(0,10);(verified.has(date)?verifiedDates:unconfirmedDates).push(date);}
    return {generation:live.generation,verifiedDates,unconfirmedDates,coverageComplete:unconfirmedDates.length===0,
      coverageReason:unconfirmedDates.length?'NO_GENERATION_MATCHED_COMPLETION_EVIDENCE_FOR_SOME_DATES':'GENERATION_SHARD_HASH_AND_COLLECTION_LOG_MATCH'};
  }
  return {readStatus,coverage};
}
