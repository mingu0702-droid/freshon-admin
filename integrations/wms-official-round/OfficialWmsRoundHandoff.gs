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
  return {audience:settings.audience,key};
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

function opsmapQueueWmsOfficialRound_(reports,job,outcome,lease){
  try{
    if(outcome?.ok!==true||outcome.published!==true||outcome.metadataPending||lease?.id!==job.id||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(job.id||''))return;
    const osan=reports?.find(report=>report.code==='011'&&report.fullyReconciled===true);
    if(!osan)return;
    const capture=OPSMAP_WMS_PAIR_CAPTURE_.get(osan);
    OPSMAP_WMS_PAIR_CAPTURE_.delete(osan);
    if(!capture||capture.day!==job.day)return;
    const stamp={date:job.day,warehouse:'011',roundId:job.id,observedAt:capture.observedAt};
    const payload=JSON.stringify({plan:{...stamp,rows:capture.plans},dispatch:{...stamp,rows:capture.dispatch}});
    if(Utilities.newBlob(payload).getBytes().length<=OPSMAP_WMS_HANDOFF_LIMIT_)
      OPSMAP_WMS_PAIR_PENDING_.set(lease,{date:job.day,captured:Date.parse(capture.observedAt),payload});
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
    console.log(JSON.stringify({component:'opsmap-wms-official-handoff',date:pair.date,
      state:acknowledged?'ACKNOWLEDGED':'NOT_ACKNOWLEDGED',status}));
  }catch(_){
    console.warn('OPSMAP_WMS_HANDOFF_NOT_ACKNOWLEDGED');
  }
}
