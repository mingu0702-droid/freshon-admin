// Read-only status/projection and one administrator-only stored-data job request.
// This module never calls a collector or writes Customer data.
import express from 'express';
import compression from 'compression';
import {requireAdmin} from './auth.js';
import {createFixedVehicleCache} from './fixedVehicleCache.js';
import {createFixedVehicleStore} from './fixedVehicleStore.js';
import {mapPublicationConnection} from './opsmap-abc/mapDataFreshness.js';

export function mountMapDataFreshness(app,{callHub,requireView,previewEnabled,modelStatus,readBaseVehicleMaster,env=process.env,adminGuard=requireAdmin,baseStore=env.GITHUB_CACHE_REPO?createFixedVehicleStore({env}):null}){
  let statusCache=null,statusAt=0,statusPending=null;
  const base=createFixedVehicleCache({reader:readBaseVehicleMaster||(()=>{throw new Error('FIXED_MASTER_UNAVAILABLE');}),store:baseStore,readOnly:process.env.OPSMAP_FIXED_MASTER_REFRESH_ENABLED==='0'});
  const cleanDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'')?v:null;
  const code=v=>/^[A-Z0-9_]+$/.test(v||'')?v:'UNKNOWN';
  async function readStatus(){
    if(statusCache&&Date.now()-statusAt<20000)return statusCache;
    if(statusPending)return statusPending;
    statusPending=(async()=>{
      const sources=[];
      const read=async(action,options)=>{
        const started=Date.now();
        try {
          const value=await callHub(action,{},options);
          if(!value?.data||typeof value.data!=='object'||Array.isArray(value.data))throw Object.assign(Error(),{failureType:'contract'});
          sources.push({action,state:'AVAILABLE',durationMs:Date.now()-started});return value;
        } catch(error) {
          const allowed=['auth','parse','contract','upstream','network','output'];
          sources.push({action,state:'UNKNOWN',durationMs:Date.now()-started,
            errorCode:typeof error?.message==='string'&&/^HUB_[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'UNKNOWN',
            failureType:error?.name==='AbortError'?'timeout':allowed.includes(error?.failureType)?error.failureType:'unknown',
            upstreamStatus:[400,401,403,404,408,409,413,429,500,502,503,504].includes(error?.upstreamStatus)?error.upstreamStatus:null});
          throw error;
        }
      };
      const [modelResult,detailResult]=await Promise.allSettled([read('mapModelStatus',{useCache:false}),env.OPSMAP_PREPARED_DETAILS_ENABLED==='1'?read('customerDetailsStatus',{useCache:false,privateRead:true,maxResponseBytes:8192}):Promise.resolve(null)]);
      const model=modelResult.status==='fulfilled'?modelResult.value:null,details=detailResult.status==='fulfilled'?detailResult.value:null;
      const raw=model?.data||{},c=raw.customer||{},p=raw.published||{},j=raw.job,detail=details?.data;
      const customerDetails=detail?{prepared:detail.prepared===true,version:Number.isSafeInteger(detail.version)?detail.version:null,automatic:detail.automatic===true,phase:code(detail.job?.phase||'NOT_STARTED'),preparedCustomers:Number.isSafeInteger(detail.job?.preparedCustomers)?detail.job.preparedCustomers:null,updatedAt:typeof detail.job?.updatedAt==='string'&&Number.isFinite(Date.parse(detail.job.updatedAt))?detail.job.updatedAt:null,lastError:detail.job?.lastError?code(detail.job.lastError):null}:null;
      statusCache={partial:sources.some(source=>source.state==='UNKNOWN'),sources,customerDetails,customer:{freshon:cleanDate(c.freshon),delivery:cleanDate(c.delivery),proof:code(c.proof)},
        published:{generation:Number(p.generation)||null,startDate:cleanDate(p.startDate),endDate:cleanDate(p.endDate),status:code(p.status)},
        job:j?Object.fromEntries(['phase','generation','baseGeneration','startDate','endDate','buildAt','verifyAt','sendAt','shards','lastError','updatedAt','commitHttp','publication'].map(k=>[k,j[k]??null])):null,
        coverage:{generation:Number(raw.coverage?.generation)||null,proof:code(raw.coverage?.proof),
          history:(raw.coverage?.history||[]).filter(cleanDate),period:(raw.coverage?.period||[]).filter(cleanDate)},
        automatic:raw.automatic&&typeof raw.automatic==='object'?code(raw.automatic.status):model?'NOT_CONFIGURED':'UNKNOWN',
        automation:raw.automatic&&typeof raw.automatic==='object'?{configured:raw.automatic.configured===true,status:code(raw.automatic.status),lastCheck:raw.automatic.lastCheck||null,lastRequest:raw.automatic.lastRequest||null,lastSuccess:raw.automatic.lastSuccess||null,lastError:raw.automatic.lastError?code(raw.automatic.lastError):null,generation:Number(raw.automatic.generation)||null}:model?{configured:false,status:'NOT_CONFIGURED'}:{configured:null,status:'UNKNOWN'},continuation:!model?'UNKNOWN':raw.continuation==='ACTIVE'?'ACTIVE':'NONE',checkedAt:new Date().toISOString()};
      statusAt=Date.now();return statusCache;
    })().finally(()=>{statusPending=null;});return statusPending;
  }
  const enabled=(_q,r,n)=>previewEnabled()?n():r.sendStatus(404);
  app.get('/api/map-phase2b/preview/data-status',requireView,enabled,async(_q,r)=>{
    r.set('Cache-Control','no-store');
    try{
      const status=await readStatus();let live=null,liveAvailable=false;
      try{live=await modelStatus();liveAvailable=!!live&&typeof live==='object'&&!Array.isArray(live);}catch{/* Independent local status remains unknown. */}
      const sources=[...status.sources,{action:'localModelStatus',state:liveAvailable?'AVAILABLE':'UNKNOWN'}];
      const available=sources.some(source=>source.state==='AVAILABLE');
      return r.status(available?200:503).json({ok:available,...(!available?{error:'MAP_DATA_STATUS_UNAVAILABLE'}:{}),data:{...status,partial:sources.some(source=>source.state==='UNKNOWN'),sources,live,publicationConnection:mapPublicationConnection(status,live)}});
    }catch{return r.status(503).json({error:'MAP_DATA_STATUS_UNAVAILABLE'});}
  });
  async function baseResponse(q,r){
    r.set('Cache-Control','no-store');
    const requested=q.method==='POST'?q.body?.customerCodes:q.query.customerCode?[q.query.customerCode]:[];
    if(!Array.isArray(requested)||requested.length>10000||requested.some(v=>typeof v!=='string'||!/^[A-Z]\d+$/.test(v)))return r.status(400).json({error:'INVALID_CUSTOMER_CODES'});
    const payload=await base.get([...new Set(requested)]);
    return r.status(payload.ok?200:payload.phase==='ERROR'?503:202).json({...payload,progress:readBaseVehicleMaster?.getProgress?.()||null});
  }
  app.get('/api/map-phase2b/preview/base-vehicles',requireView,enabled,compression({threshold:1024}),baseResponse);
  app.post('/api/map-phase2b/preview/base-vehicles',requireView,enabled,express.json({limit:'128kb'}),compression({threshold:1024}),baseResponse);
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
  function coverage(start,end,kind){
    const proof=statusCache?.coverage,live=modelStatus();
    const verified=proof?.generation===live.generation&&proof.proof==='GENERATION_SHARD_HASH_AND_COLLECTION_LOG_MATCH'?new Set(proof[kind]):new Set();
    const verifiedDates=[],unconfirmedDates=[];
    for(let t=Date.parse(start);t<=Date.parse(end);t+=86400000){const date=new Date(t).toISOString().slice(0,10);(verified.has(date)?verifiedDates:unconfirmedDates).push(date);}
    return {generation:live.generation,verifiedDates,unconfirmedDates,coverageComplete:unconfirmedDates.length===0,
      coverageReason:unconfirmedDates.length?'NO_GENERATION_MATCHED_COMPLETION_EVIDENCE_FOR_SOME_DATES':'GENERATION_SHARD_HASH_AND_COLLECTION_LOG_MATCH'};
  }
  return {readStatus,coverage,baseCache:base};
}
