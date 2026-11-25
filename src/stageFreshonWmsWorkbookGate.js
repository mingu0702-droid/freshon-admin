import {createHash} from 'node:crypto';
import {freshonWmsVehicle as vehicle,verifiedFreshonWmsWorkbookLines as verifiedWorkbookLines,collectFreshonWmsDispatch as collect,encodeFreshonWmsDispatch} from './stageFreshonWmsDispatch.js';
import {createStageWmsDispatchExportReader,parseOpsmapWmsDispatchExport,publishStageWmsDispatchExport} from './opsmapWmsDispatchExport.js';
import {FRESHON_JSON_WMS_FORMAT,createStageWmsReleaseStore,isStageWmsDay,stageWmsError,stageWmsReleaseEnabled} from './stageWmsExportIndex.js';

const warehouse='011', pageSize=3000, maxWorkbookBytes=4*1024*1024;
const sourceUrl='https://mis.freshon.co.kr/bo/wm/dispatch/baecha_list';
const sha=/^[a-f0-9]{64}$/;
const fail=code=>{throw stageWmsError('WMS_EXPORT_FRESHON_'+code);};
const sourceMetadata=new WeakMap();

function requestScope(date,env) {
  if(!isStageWmsDay(date)||!stageWmsReleaseEnabled(env)||env.OPSMAP_STAGE_WMS_FRESHON_VALIDATION_APPROVED!=='1')fail('SCOPE');
  return new URLSearchParams({page:'0',isPaging:'true',isCount:'true',size:String(pageSize),
    sort:'stock_date,ASC',excelFileNm:'baecha_list',logCd:warehouse,calStartDate:date,calEndDate:date,
    baecha:'2',shipGbn:'1',estCd:'',estName:'',cboStartCarSeq:'',cboStartCarSeqNm:'',
    cboEndCarSeq:'',cboEndCarSeqNm:''});
}

export async function readStageFreshonWmsWorkbookEvidence({date,readJson,env=process.env,signal}={}) {
  const body=requestScope(date,env);
  if(typeof readJson!=='function')fail('TRANSPORT');
  const payload=await readJson(sourceUrl,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},
    body:body.toString(),redirect:'error',signal});
  const source=collect(payload,date);
  const evidence=Object.freeze({source:'FRESHON_BAECHA_JSON',date,warehouse,detailRows:source.lines.size,
    routes:source.routes.size,total:source.sum,deliveryCount:source.count});
  sourceMetadata.set(evidence,source);
  return evidence;
}

export function verifyStageFreshonWmsDispatchWorkbook({evidence,bytes,date,observedAt,sha256,env=process.env}={}) {
  requestScope(date,env);
  const source=sourceMetadata.get(evidence);
  if(!source||evidence.date!==date||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>maxWorkbookBytes||!sha.test(sha256||'')||
    createHash('sha256').update(bytes).digest('hex')!==sha256)fail('WORKBOOK_SCOPE');
  const workbook=parseOpsmapWmsDispatchExport(bytes,{date,observedAt});
  const lines=verifiedWorkbookLines(bytes,date);
  if(workbook.total!==source.sum||workbook.deliveryCount!==source.count||lines.size!==source.lines.size||
    workbook.vehicles.length!==source.routes.size||[...lines].some(key=>!source.lines.has(key))||
    workbook.vehicles.some(row=>{
      const actual=source.routes.get(vehicle(row.vehicle));
      return !actual||actual[0]!==row.amount||actual[1]!==row.deliveryCount;
    }))fail('WORKBOOK_MISMATCH');
  return Object.freeze({state:'VERIFIED_SOURCE_WORKBOOK',source:evidence.source,date,warehouse,sha256,
    total:source.sum,deliveryCount:source.count,detailRows:source.lines.size,routes:source.routes.size});
}

export async function publishStageFreshonWmsDispatchWorkbook({evidence,bytes,date,observedAt,sha256,replaceSha256,env=process.env,fetchImpl=fetch}={}) {
  const original=Buffer.isBuffer(bytes)&&bytes.length<=maxWorkbookBytes?Buffer.from(bytes):bytes;
  verifyStageFreshonWmsDispatchWorkbook({evidence,bytes:original,date,observedAt,sha256,env});
  return publishStageWmsDispatchExport({bytes:original,date,observedAt,sha256,replaceSha256,env,fetchImpl});
}

// The CLI injects the existing approved one-request login. No automatic
// credential renewal is attempted when the pinned read rejects that session.
export async function runStageFreshonWmsWorkbookOnce({
  bytes,date,observedAt,sha256,login,publish=false,replaceSha256,fetchImpl=fetch,env=process.env
}={}) {
  requestScope(date,env);
  if(replaceSha256!==undefined&&(!publish||!sha.test(replaceSha256)))fail('WORKBOOK_SCOPE');
  if(publish&&!createStageWmsReleaseStore({env,write:true}))fail('RELEASE_CONFIGURATION');
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>maxWorkbookBytes||!sha.test(sha256||'')||
    createHash('sha256').update(bytes).digest('hex')!==sha256)fail('WORKBOOK_SCOPE');
  parseOpsmapWmsDispatchExport(bytes,{date,observedAt});
  const evidence=await readFreshonWmsOnce({date,login,fetchImpl,env});
  if(publish){
    return publishStageFreshonWmsDispatchWorkbook({evidence,bytes,date,observedAt,sha256,replaceSha256,env,fetchImpl});
  }
  return verifyStageFreshonWmsDispatchWorkbook({evidence,bytes,date,observedAt,sha256,env});
}

async function readFreshonWmsOnce({date,login,fetchImpl,env}) {
  if(typeof login!=='function')fail('TRANSPORT');
  const {cookie}=await login();
  if(typeof cookie!=='string'||!cookie||/[\r\n]/.test(cookie))fail('SESSION');
  return readStageFreshonWmsWorkbookEvidence({date,env,readJson:async (url,options)=>{
    const origin=new URL(sourceUrl).origin;
    const response=await fetchImpl(url,{...options,signal:AbortSignal.timeout(25000),
      headers:{...options.headers,Accept:'application/json',Origin:origin,
        Referer:origin+'/bo/main#/bo/wm/dispatch/LOTMTR005_list',Cookie:cookie}});
    if(response.status!==200||!response.body||
      !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type')||'')){
      await response.body?.cancel();
      fail('RESPONSE');
    }
    const limit=8*1024*1024;
    if(Number(response.headers.get('content-length'))>limit){
      await response.body.cancel();
      fail('RESPONSE_SIZE');
    }
    const chunks=[];
    let size=0;
    const reader=response.body.getReader();
    try{
      for(;;){
        const {value,done}=await reader.read();
        if(done)break;
        size+=value.byteLength;
        if(size>limit){
          await reader.cancel();
          fail('RESPONSE_SIZE');
        }
        chunks.push(value);
      }
      try{return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}
      catch{fail('RESPONSE');}
    }finally{reader.releaseLock();}
  }});
}

export async function syncStageFreshonWmsDispatch({
  date,observedAt,login,replaceSha256,reconcileExisting=false,env=process.env,fetchImpl=fetch,archiveFetchImpl=fetch
}={}) {
  requestScope(date,env);
  if(env.OPSMAP_STAGE_WMS_FRESHON_JSON_PUBLISH_APPROVED!=='1'||
    !createStageWmsReleaseStore({env,fetchImpl:archiveFetchImpl,write:true}))fail('SCOPE');
  if(typeof observedAt!=='string'||!Number.isFinite(Date.parse(observedAt))||
    replaceSha256!==undefined&&!sha.test(replaceSha256)||
    reconcileExisting&&(replaceSha256!==undefined||env.OPSMAP_STAGE_WMS_NIGHT_SLOT_APPROVED!=='1'))fail('SCOPE');
  let manifest;
  try{manifest=JSON.parse(env.OPSMAP_STAGE_WMS_DISPATCH_EXPORTS_JSON);}catch{fail('SCOPE');}
  if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))fail('SCOPE');
  const releases=createStageWmsReleaseStore({env,fetchImpl:archiveFetchImpl});
  if(!releases)fail('SCOPE');
  const reader=createStageWmsDispatchExportReader({env,fetchImpl:archiveFetchImpl,includeOfficial:false});
  const legacy=Object.hasOwn(manifest,date)?manifest[date]:null;
  const entry=legacy|| (await releases.readIndex()).entries.find(item=>item.date===date);
  // Nightly reconciliation may advance a signed release, including a manual
  // XLSX release, via the same compare-and-swap used by manual corrections.
  const replacement=reconcileExisting&&!legacy&&entry&&Date.parse(observedAt)>Date.parse(entry.observedAt)
    ? entry.sha256 : replaceSha256;
  if(entry){
    if(replacement!==undefined&&(legacy||replacement!==entry.sha256||
      Date.parse(observedAt)<=Date.parse(entry.observedAt)))fail('REPLACEMENT');
    const readback=await reader(date);
    if(!readback)fail('ARCHIVE_READBACK');
    if(replacement===undefined)return {state:'VERIFIED_NOOP',date,sha256:entry.sha256};
  }else if(replacement!==undefined)fail('REPLACEMENT');
  const pinnedDate=Object.keys(manifest).filter(isStageWmsDay).sort().at(-1);
  if(!pinnedDate||!await reader(pinnedDate))fail('ARCHIVE_READBACK');
  const evidence=await readFreshonWmsOnce({date,login,fetchImpl,env});
  const bytes=encodeFreshonWmsDispatch(date,sourceMetadata.get(evidence));
  const sha256=createHash('sha256').update(bytes).digest('hex');
  return publishStageWmsDispatchExport({bytes,date,observedAt,sha256,replaceSha256:replacement,env,
    format:FRESHON_JSON_WMS_FORMAT,fetchImpl:archiveFetchImpl});
}
