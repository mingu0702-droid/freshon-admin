// Read-only status/projection and one administrator-only stored-data job request.
// This module never calls a collector or writes Customer data.
import express from 'express';
import {requireAdmin} from './auth.js';

export function mountMapDataFreshness(app,{callHub,requireView,previewEnabled,modelStatus,readBaseVehicleMaster,env=process.env,adminGuard=requireAdmin}){
  let statusCache=null,statusAt=0,statusPending=null,baseCache=null,baseAt=0,basePending=null,baseError='',baseErrorAt=0;
  let baseReadMeta=null;
  const cleanDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'')?v:null;
  const code=v=>/^[A-Z0-9_]+$/.test(v||'')?v:'UNKNOWN';
  async function readStatus(){
    if(statusCache&&Date.now()-statusAt<20000)return statusCache;
    if(statusPending)return statusPending;
    statusPending=(async()=>{
      const raw=(await callHub('mapModelStatus',{}, {useCache:false})).data||{},c=raw.customer||{},p=raw.published||{},j=raw.job;
      statusCache={customer:{freshon:cleanDate(c.freshon),delivery:cleanDate(c.delivery),proof:code(c.proof)},
        published:{generation:Number(p.generation)||null,startDate:cleanDate(p.startDate),endDate:cleanDate(p.endDate),status:code(p.status)},
        job:j?Object.fromEntries(['phase','generation','baseGeneration','startDate','endDate','buildAt','verifyAt','sendAt','shards','lastError','updatedAt','commitHttp','publication'].map(k=>[k,j[k]??null])):null,
        coverage:{generation:Number(raw.coverage?.generation)||null,proof:code(raw.coverage?.proof),
          history:(raw.coverage?.history||[]).filter(cleanDate),period:(raw.coverage?.period||[]).filter(cleanDate)},
        automatic:'NOT_CONFIGURED',continuation:raw.continuation==='ACTIVE'?'ACTIVE':'NONE',checkedAt:new Date().toISOString()};
      statusAt=Date.now();return statusCache;
    })().finally(()=>{statusPending=null;});return statusPending;
  }
  const enabled=(_q,r,n)=>previewEnabled()?n():r.sendStatus(404);
  app.get('/api/map-phase2b/preview/data-status',requireView,enabled,async(_q,r)=>{
    r.set('Cache-Control','no-store');
    try{return r.json({ok:true,data:{...await readStatus(),live:modelStatus()}});}catch{return r.status(503).json({error:'MAP_DATA_STATUS_UNAVAILABLE'});}
  });
  app.get('/api/map-phase2b/preview/base-vehicles',requireView,enabled,(_q,r)=>{
    r.set('Cache-Control','no-store');
    if(baseError&&Date.now()-baseErrorAt>=300000)baseError='';
    if(baseCache&&Date.now()-baseAt<1800000)return r.json({ok:true,data:baseCache,meta:{basis:readBaseVehicleMaster?'FIXED_DISPATCH_PRIMARY':'LATEST_STORED_DELIVERY_BASE',checkedAt:new Date(baseAt).toISOString(),read:baseReadMeta}});
    if(!basePending&&!baseError){
      basePending=(readBaseVehicleMaster?readBaseVehicleMaster():callHub('mapBaseVehicles',{}, {useCache:false})).then(result=>{
        if(!Array.isArray(result.data))throw new Error('CONTRACT');
        baseCache=result.data.filter(x=>/^[A-Z]\d+$/.test(x.customerCode)).map(x=>({
          customerCode:x.customerCode,baseVehicle:String(x.baseVehicle||'').slice(0,20),baseVehicleDate:cleanDate(x.baseVehicleDate),
          baseVehicleGroup:['osan','yeongnam','honam'].includes(x.baseVehicleGroup)?x.baseVehicleGroup:'',
          baseVehicleState:['VERIFIED_MASTER','UNASSIGNED','VERIFIED_STORED','CONFLICT','UNKNOWN'].includes(x.baseVehicleState)?x.baseVehicleState:'UNKNOWN',
          baseVehicleSource:readBaseVehicleMaster?'FIXED_DISPATCH_PRIMARY':'Delivery.carrier.basedNo → Customer.delivery_admin_raw'}));
        baseAt=Date.now();
        baseReadMeta=result.meta?{authRetried:result.meta.authRetried===true,firstHttp:Number(result.meta.firstHttp)||null,authReason:['HTML_OR_LOGIN','HTTP_401'].includes(result.meta.authReason)?result.meta.authReason:null,readHttp:Number(result.meta.readHttp)||null}:null;
      }).catch(error=>{baseError='BASE_VEHICLE_SOURCE_UNAVAILABLE';baseErrorAt=Date.now();baseReadMeta={code:/^FIXED_MASTER_[A-Z_]+$/.test(error.code||'')?error.code:'FIXED_MASTER_UNAVAILABLE',http:Number(error.status)||null,step:['READ','PARSE','SESSION'].includes(error.step)?error.step:'READ'};}).finally(()=>{basePending=null;});
    }
    return r.status(baseError?503:202).json({ok:false,error:baseError||null,phase:baseError?'ERROR':'LOADING',read:baseError?baseReadMeta:null});
  });
  app.post('/api/map-phase2b/admin/model-sync',enabled,express.json({limit:'1kb'}),(q,r,n)=>{
    r.set('Cache-Control','private, no-store');
    if(!q.get('x-admin-token')||q.query.token)return r.status(401).json({error:'ADMIN_HEADER_REQUIRED'});
    if(q.get('origin')!==env.RENDER_EXTERNAL_URL||env.RENDER_EXTERNAL_URL!=='https://freshon-admin-1.onrender.com')return r.status(403).json({error:'ORIGIN_NOT_ALLOWED'});
    if(!q.is('application/json')||Object.keys(q.body||{}).length)return r.status(400).json({error:'INVALID_REQUEST'});
    return adminGuard(q,r,n);
  },async(_q,r)=>{
    try{
      const result=await callHub('mapModelIncrementalRequest',{target:'production'},{useCache:false});
      statusCache=null;statusAt=0;baseError='';
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
  return {readStatus,coverage};
}
