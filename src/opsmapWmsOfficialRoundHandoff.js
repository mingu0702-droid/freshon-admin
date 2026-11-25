import express from 'express';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {opsmapArchiveSite,opsmapArchiveWriteApproved,PRIMARY_ORIGIN,STAGE_ORIGIN} from './stageScope.js';
import {publishStageWmsOfficialRound} from './opsmapWmsDispatchExport.js';
import {createStageWmsReleaseStore,isStageWmsDay} from './stageWmsExportIndex.js';

export const OPSMAP_WMS_HANDOFF_ROUTE='/internal/opsmap/scheduled-sync/wms-official-round';
const payloadLimit=512*1024, receiptAgeMs=10*60_000, bodyReadMs=5_000, dayMs=24*60*60_000;
const sha=/^[a-f0-9]{64}$/;
const audienceAllowed=audience=>audience===STAGE_ORIGIN||audience===PRIMARY_ORIGIN;
const kstDay=time=>new Date(time+9*60*60_000).toISOString().slice(0,10);

export function deriveOpsmapWmsHandoffKey(clockSecret,audience) {
  if(typeof clockSecret!=='string'||clockSecret.length<32||clockSecret.length>512||!audienceAllowed(audience))return null;
  // The WMS project receives only this audience-bound capability. It cannot
  // use it for general scheduler HMACs or for another service.
  return createHmac('sha256',clockSecret).update('opsmap-wms-owner-handoff-key-v1\0').update(audience).digest();
}

function verifyHandoffHeaders(req,{audience,key,now}) {
  const date=req.get('X-Opsmap-Wms-Date'),issuedAt=req.get('X-Opsmap-Wms-Issued-At'),
    bodySha=req.get('X-Opsmap-Wms-Body-Sha256'),signature=req.get('X-Opsmap-Wms-Signature');
  const timestamp=Date.parse(issuedAt);
  if(!isStageWmsDay(date)||!Number.isFinite(timestamp)||issuedAt!==new Date(timestamp).toISOString()||
      Math.abs(now()-timestamp)>receiptAgeMs||(date!==kstDay(timestamp)&&date!==kstDay(timestamp+dayMs))||
      !sha.test(bodySha||'')||!sha.test(signature||''))return null;
  const signed=JSON.stringify(['opsmap-wms-owner-handoff-v1',audience,OPSMAP_WMS_HANDOFF_ROUTE,'011',date,issuedAt,bodySha]);
  const expected=createHmac('sha256',key).update(signed).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))return null;
  return {date,timestamp,bodySha};
}

function sameCaptureBody(bytes,receipt) {
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>payloadLimit||
      createHash('sha256').update(bytes).digest('hex')!==receipt.bodySha)return null;
  let round;
  try{round=JSON.parse(bytes.toString('utf8'));}catch{return null;}
  if(!round||Object.keys(round).length!==2||!round.plan||!round.dispatch)return null;
  for(const part of [round.plan,round.dispatch]){
    const capturedAt=Date.parse(part.observedAt);
    if(part.date!==receipt.date||part.warehouse!=='011'||!Number.isFinite(capturedAt)||
        capturedAt>receipt.timestamp||receipt.timestamp-capturedAt>receiptAgeMs)return null;
  }
  return round;
}

export function mountOpsmapWmsOfficialRoundHandoff(app,{
  env=process.env,clock,fetchImpl=fetch,now=Date.now,publish=publishStageWmsOfficialRound
}={}) {
  if(env.OPSMAP_STAGE_WMS_OFFICIAL_ROUND_HANDOFF_APPROVED!=='1'||
      env.OPSMAP_STAGE_WMS_OFFICIAL_ROUND_PUBLISH_APPROVED!=='1'||
      !opsmapArchiveSite(env)||!opsmapArchiveWriteApproved(env)||
      !createStageWmsReleaseStore({env,fetchImpl,write:true,official:true}))return false;
  const audience=env.RENDER_EXTERNAL_URL;
  const key=deriveOpsmapWmsHandoffKey(clock?.secret,audience);
  if(!key)return false;
  const parse=express.raw({type:'application/json',limit:payloadLimit,inflate:false});
  let active;
  app.post(OPSMAP_WMS_HANDOFF_ROUTE,(req,res)=>{
    res.set('Cache-Control','no-store');
    if(req.url!==OPSMAP_WMS_HANDOFF_ROUTE)return res.status(404).end();
    if(!req.is('application/json')||req.get('Content-Encoding')&&req.get('Content-Encoding')!=='identity')
      return res.status(415).json({error:'WMS_HANDOFF_MEDIA_TYPE'});
    const receipt=verifyHandoffHeaders(req,{audience,key,now});
    if(!receipt)return res.status(403).json({error:'WMS_HANDOFF_REJECTED'});
    if(active)return res.status(429).json({error:'WMS_HANDOFF_BUSY'});
    const request={publishing:false};
    active=request;
    const close=()=>{if(!request.publishing)release();};
    const release=()=>{
      clearTimeout(timer);
      res.off('close',close);
      if(active===request)active=null;
    };
    const timer=setTimeout(()=>{
      release();
      req.destroy();
    },bodyReadMs);
    timer.unref();
    res.once('close',close);
    parse(req,res,async error=>{
      clearTimeout(timer);
      try{
        if(active!==request||res.destroyed)return;
        if(error)return res.status(error.status===413?413:400).json({error:'WMS_HANDOFF_BODY_REJECTED'});
        const round=sameCaptureBody(req.body,receipt);
        if(!round)return res.status(400).json({error:'WMS_HANDOFF_BODY_REJECTED'});
        request.publishing=true;
        const result=await publish({round,date:receipt.date,reconcileExisting:true,env,fetchImpl});
        if(!res.destroyed)return res.json({state:result.state,date:receipt.date});
      }catch(error){
        if(res.destroyed)return;
        const conflict=/^WMS_EXPORT_(?:RELEASE_(?:BASE_CHANGED|STALE|DATE_CONFLICT)|OFFICIAL_ROUND_CONFLICT)$/.test(error?.code||'');
        const invalid=!conflict&&/^WMS_EXPORT_OFFICIAL_[A-Z_]+$/.test(error?.code||'');
        return res.status(conflict?409:invalid?422:503).json({
          error:conflict?'WMS_HANDOFF_CONFLICT':invalid?'WMS_HANDOFF_UNVERIFIED':'WMS_HANDOFF_UNAVAILABLE'
        });
      }finally{
        release();
      }
    });
  });
  return true;
}
