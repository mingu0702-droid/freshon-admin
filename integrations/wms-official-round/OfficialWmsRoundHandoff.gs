// Owner-only WMS Apps Script candidate. Uses the existing external_request scope.
const OPSMAP_WMS_HANDOFF_ROUTE_='/internal/opsmap/scheduled-sync/wms-official-round';
const OPSMAP_WMS_HANDOFF_LIMIT_=512*1024;
const OPSMAP_WMS_HANDOFF_AUDIENCES_=[
  'https://freshon-admin-stage-preview-template.onrender.com',
  'https://freshon-admin-1.onrender.com'
];
const OPSMAP_WMS_PLAN_FIELDS_=['WH_CD','DLVRY_DATE','DISPATCH_NO','DISPATCH_YN','ROUTE_NM','VEHICLE_NO','ROUTE_CD','SELL_AMT','STOP_LOC_CNT'];
const OPSMAP_WMS_DETAIL_FIELDS_=['WH_CD','DLVRY_DATE','DLVRY_NO','DISPATCH_NO','DISPATCH_YN','ROUTE_NM','ROUTE_CD_ORG','ROUTE_CD','CUST_CD','SELL_AMT'];
const OPSMAP_WMS_PAIR_CAPTURE_=new WeakMap();
const OPSMAP_WMS_PAIR_PENDING_=new WeakMap();

function opsmapWmsHex_(bytes){
  return bytes.map(byte=>(byte&255).toString(16).padStart(2,'0')).join('');
}

function opsmapWmsHandoffSettings_(){
  const props=PropertiesService.getScriptProperties();
  let settings;
  try{settings=JSON.parse(props.getProperty('OPSMAP_WMS_OFFICIAL_HANDOFF_V1')||'null');}catch(_){return null;}
  if(settings?.enabled!==true||!OPSMAP_WMS_HANDOFF_AUDIENCES_.includes(settings.audience))return null;
  const encoded=props.getProperty('OPSMAP_WMS_OFFICIAL_CAPABILITY_B64');
  if(!/^[A-Za-z0-9+/]{43}=$/.test(encoded||''))return null;
  const key=Utilities.base64Decode(encoded);
  if(key.length!==32||Utilities.base64Encode(key)!==encoded)return null;
  return {audience:settings.audience,key,nightly:settings.nightly===true};
}

function opsmapWmsMinimizeRows_(rows,fields){
  if(!Array.isArray(rows)||rows.length>=10000)throw Error('OPSMAP_WMS_HANDOFF_SCOPE');
  return rows.map(source=>{
    const record={};
    for(const field of fields){
      const value=source[field];
      if(value==null)continue;
      if(!(typeof value==='string'&&value.length<=200)&&!Number.isSafeInteger(value))
        throw Error('OPSMAP_WMS_HANDOFF_SCOPE');
      record[field]=value;
    }
    return record;
  });
}

function opsmapCaptureWmsOfficialRound_(report,day,checkedAt,plans,dispatch){
  try{
    if(report?.code!=='011'||!report.fullyReconciled||!opsmapWmsHandoffSettings_())return;
    OPSMAP_WMS_PAIR_CAPTURE_.set(report,{day,observedAt:new Date(checkedAt).toISOString(),
      plans:opsmapWmsMinimizeRows_(plans,OPSMAP_WMS_PLAN_FIELDS_),
      dispatch:opsmapWmsMinimizeRows_(dispatch,OPSMAP_WMS_DETAIL_FIELDS_)});
  }catch(_){/* Optional handoff capture cannot change the WMS sheet result. */}
}

function opsmapWmsPairPayload_(date,id,observedAt,plans,dispatch){
  const stamp={date,warehouse:'011',roundId:id,observedAt:new Date(observedAt).toISOString()};
  const payload=JSON.stringify({plan:{...stamp,rows:plans},dispatch:{...stamp,rows:dispatch}});
  return Utilities.newBlob(payload).getBytes().length<=OPSMAP_WMS_HANDOFF_LIMIT_?payload:null;
}

function opsmapQueueWmsOfficialRound_(reports,job,outcome,lease){
  try{
    if(outcome?.ok!==true||outcome.published!==true||outcome.metadataPending||lease?.id!==job.id||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(job.id||''))return;
    const osan=reports?.find(report=>report.code==='011'&&report.fullyReconciled===true);
    if(!osan)return;
    const capture=OPSMAP_WMS_PAIR_CAPTURE_.get(osan);
    OPSMAP_WMS_PAIR_CAPTURE_.delete(osan);
    if(!capture||capture.day!==job.day)return;
    const captured=Date.parse(capture.observedAt);
    const payload=opsmapWmsPairPayload_(job.day,job.id,captured,capture.plans,capture.dispatch);
    if(payload)OPSMAP_WMS_PAIR_PENDING_.set(lease,{date:job.day,captured,payload});
  }catch(_){/* The native sheet keeps its verified state. */}
}

function opsmapSendWmsOfficialRound_(lease){
  const pair=OPSMAP_WMS_PAIR_PENDING_.get(lease);
  OPSMAP_WMS_PAIR_PENDING_.delete(lease);
  if(!pair)return;
  try{
    soOwner_();
    const settings=opsmapWmsHandoffSettings_();
    const now=Date.now();
    if(!settings||now<pair.captured||now-pair.captured>10*60*1000)return;
    opsmapPostWmsOfficialRound_(pair,settings,now);
  }catch(_){
    console.warn('OPSMAP_WMS_HANDOFF_NOT_ACKNOWLEDGED');
  }
}

function opsmapPostWmsOfficialRound_(pair,settings,now){
  const issuedAt=new Date(now).toISOString();
  const bodySha=opsmapWmsHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,Utilities.newBlob(pair.payload).getBytes()));
  const signed=JSON.stringify(['opsmap-wms-owner-handoff-v1',settings.audience,OPSMAP_WMS_HANDOFF_ROUTE_,'011',pair.date,issuedAt,bodySha]);
  const signature=opsmapWmsHex_(Utilities.computeHmacSha256Signature(Utilities.newBlob(signed).getBytes(),settings.key));
  const response=UrlFetchApp.fetch(settings.audience+OPSMAP_WMS_HANDOFF_ROUTE_,{
    method:'post',contentType:'application/json; charset=utf-8',payload:pair.payload,
    followRedirects:false,muteHttpExceptions:true,validateHttpsCertificates:true,
    headers:{'X-Opsmap-Wms-Date':pair.date,'X-Opsmap-Wms-Issued-At':issuedAt,
      'X-Opsmap-Wms-Body-Sha256':bodySha,'X-Opsmap-Wms-Signature':signature}
  });
  const status=response.getResponseCode();
  let acknowledged=false;
  if(status===200){
    try{
      const body=JSON.parse(response.getContentText());
      acknowledged=body?.date===pair.date&&['PUBLISHED','VERIFIED_NOOP'].includes(body.state);
    }catch(_){/* A proxy/error response must not acknowledge a publish. */}
  }
  const state=acknowledged?'ACKNOWLEDGED':'NOT_ACKNOWLEDGED';
  console.log(JSON.stringify({component:'opsmap-wms-official-handoff',date:pair.date,state,status}));
  return state;
}

const OPSMAP_WMS_NIGHT_STATE_='OPSMAP_WMS_OFFICIAL_NIGHT_V1';
const OPSMAP_WMS_NIGHT_RUN_MS_=110*1000;
const OPSMAP_WMS_NIGHT_START_=21*60+10;
const OPSMAP_WMS_NIGHT_END_=22*60+10;

function opsmapNightWmsDay_(started){
  const kst=new Date(started+9*60*60*1000);
  const minute=kst.getUTCHours()*60+kst.getUTCMinutes();
  return Number.isFinite(started)&&minute>=OPSMAP_WMS_NIGHT_START_&&minute<OPSMAP_WMS_NIGHT_END_?
    new Date(kst.getTime()+24*60*60*1000).toISOString().slice(0,10):null;
}

function opsmapOwnNightWmsClock_(event,receipt,started){
  if(receipt?.ok!==true||receipt.source!=='30-minute-clock'||!event?.triggerUid||
      !/^[FR]\d+_\d{13}$/.test(receipt.requestId||'')||!Number.isFinite(receipt.scheduledAt)||
      started-receipt.scheduledAt>45*60*1000||receipt.scheduledAt>Date.now()||
      String(event.triggerUid)!==sonState_('TRIGGERS')?.clock)return false;
  const request=sonState_(SON_CLOCK_REQUEST_PREFIX_+receipt.requestId);
  return request?.first===false&&request.uid===String(event.triggerUid)&&
    request.scheduledAt===receipt.scheduledAt&&request.day===sopKstDay_(new Date(started));
}

function opsmapRunNightWmsOfficialRound_(event,receipt,started){
  // This hook runs after the existing clock releases its Sheet lease. Its
  // result cannot affect the MIS receipt or any other scheduled job.
  const date=opsmapNightWmsDay_(started);
  if(!date)return;
  let claimed,current,settings;
  try{
    sonOwnerEffective_();
    settings=opsmapWmsHandoffSettings_();
    if(!settings?.nightly||!opsmapOwnNightWmsClock_(event,receipt,started)||
        Date.now()-started>OPSMAP_WMS_NIGHT_RUN_MS_)return;
    current=soRead_('ACTIVE','wms');
    if(!current?.file)return;
    claimed=soLock_(()=>{
      if(sonState_(OPSMAP_WMS_NIGHT_STATE_)?.date===date)return false;
      sonSave_(OPSMAP_WMS_NIGHT_STATE_,{date,audience:settings.audience,at:Date.now(),state:'ATTEMPTED'});
      return true;
    });
    if(!claimed)return;

    const guard=()=>{
      if(Date.now()-started>OPSMAP_WMS_NIGHT_RUN_MS_||!opsmapOwnNightWmsClock_(event,receipt,started)||
          soRead_('ACTIVE','wms')?.file!==current.file)throw Error('OPSMAP_WMS_NIGHT_SCOPE');
    };
    const before=SON_METER_;
    let plans,dispatch,observedAt;
    try{
      SON_METER_={calls:0,check:guard};
      guard();
      const session=swfLiveLogin_(sonDriverCredential_(current.file),{});
      const ymd=date.replace(/-/g,'');
      const [planResponse,dispatchResponse]=swfSend_([
        swfSpec_(session,'011',ymd,false),swfSpec_(session,'011',ymd,true)
      ]);
      observedAt=Date.now();
      plans=swfRows_(planResponse,'011',ymd);
      dispatch=swfRows_(dispatchResponse,'011',ymd);
    }finally{SON_METER_=before;}
    const report=swfReport_(plans,dispatch,'011');
    if(report?.code!=='011'||report.fullyReconciled!==true)throw Error('OPSMAP_WMS_NIGHT_UNVERIFIED');
    guard();
    const fresh=opsmapWmsHandoffSettings_();
    if(!fresh?.nightly||fresh.audience!==settings.audience)throw Error('OPSMAP_WMS_NIGHT_SCOPE');
    const payload=opsmapWmsPairPayload_(date,Utilities.getUuid(),observedAt,
      opsmapWmsMinimizeRows_(plans,OPSMAP_WMS_PLAN_FIELDS_),opsmapWmsMinimizeRows_(dispatch,OPSMAP_WMS_DETAIL_FIELDS_));
    if(!payload)throw Error('OPSMAP_WMS_NIGHT_UNVERIFIED');
    const state=opsmapPostWmsOfficialRound_({date,captured:observedAt,payload},fresh,Date.now());
    sonSave_(OPSMAP_WMS_NIGHT_STATE_,{date,audience:settings.audience,at:Date.now(),state});
  }catch(_){
    // Capture or acknowledgement failures are separate from the MIS result.
    // The pre-request marker prevents retries when a write outcome is unknown.
    if(claimed)console.warn('OPSMAP_WMS_OFFICIAL_NIGHT_NOT_ACKNOWLEDGED');
  }
}
