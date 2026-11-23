import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {parseOpsmapWmsDispatchExport,publishStageWmsDispatchExport} from './opsmapWmsDispatchExport.js';
import {isStageWmsDay,stageWmsError,stageWmsReleaseEnabled} from './stageWmsExportIndex.js';

const require=createRequire(import.meta.url);
const warehouse='011', pageSize=3000, maxWorkbookBytes=4*1024*1024;
const sourceUrl='https://mis.freshon.co.kr/bo/wm/dispatch/baecha_list';
const sha=/^[a-f0-9]{64}$/;
const text=value=>typeof value==='string'?value.trim():Number.isSafeInteger(value)?String(value):'';
const fail=code=>{throw stageWmsError('WMS_EXPORT_FRESHON_'+code);};
const customerPattern=/^[A-Z]\d{1,20}$/;
const sourceMetadata=new WeakMap();

function exactInteger(value) {
  const raw=text(value);
  if(!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.0+)?$/.test(raw))fail('INTEGER');
  const numeric=Number(raw.replaceAll(',',''));
  if(!Number.isSafeInteger(numeric))fail('INTEGER');
  return numeric;
}

function add(left,right) {
  const sum=left+right;
  if(!Number.isSafeInteger(sum))fail('INTEGER');
  return sum;
}

function vehicle(value) {
  if(value!=null&&typeof value!=='string'&&!Number.isSafeInteger(value))fail('VEHICLE');
  const normalized=text(value).replace(/호(?:차)?$/,'').trim();
  if(!normalized||normalized==='미배정')return '미배정';
  if(!/^[0-9가-힣 -]{1,24}$/.test(normalized)||['-','소계','합계'].includes(normalized))fail('VEHICLE');
  return normalized;
}

function detail(route,base,customer,amount,count) {
  const code=text(customer).toUpperCase();
  const deliveries=exactInteger(count);
  if(!customerPattern.test(code)||deliveries<1)fail('DETAIL');
  return [vehicle(route),code,vehicle(base),exactInteger(amount),deliveries];
}

function requestScope(date,env) {
  if(!isStageWmsDay(date)||!stageWmsReleaseEnabled(env)||env.OPSMAP_STAGE_WMS_FRESHON_VALIDATION_APPROVED!=='1')fail('SCOPE');
  return new URLSearchParams({page:'0',isPaging:'true',isCount:'true',size:String(pageSize),
    sort:'stock_date,ASC',excelFileNm:'baecha_list',logCd:warehouse,calStartDate:date,calEndDate:date,
    baecha:'2',shipGbn:'1',estCd:'',estName:'',cboStartCarSeq:'',cboStartCarSeqNm:'',
    cboEndCarSeq:'',cboEndCarSeqNm:''});
}

function collect(payload,date) {
  // One explicitly counted complete page is the only provider contract verified for XLSX parity.
  if(!Array.isArray(payload?.data)||!payload.data.length||payload.data.length>=pageSize)fail('PAGE');
  const target=date.replaceAll('-',''), lines=new Set(), routes=new Map();
  let current=null,declared=null,sum=0,count=0,groups=0;
  for(const row of payload.data){
    if(!row||typeof row!=='object'||Array.isArray(row)||!(row.isSum===false||row.isSum==='false')||
      (row.logCd!=null&&!['','011','11'].includes(text(row.logCd))))fail('ROW');
    const stamp=text(row.stockDate);
    // isSum=false is present on both detail and subtotal rows in the observed provider response.
    if(/^\d{8}$|^\d{4}-\d\d-\d\d$|^\d{4}\.\d\d\.\d\d$/.test(stamp)&&stamp.replace(/[-.]/g,'')===target){
      const entry=detail(row.confirmCarSeq,row.carSeq,row.estCd,row.maechul,row.baesongCnt);
      const [route,,,amount,deliveries]=entry;
      const total=exactInteger(row.totalCnt), key=JSON.stringify(entry);
      if(total<1||total>=pageSize||lines.has(key)||routes.has(route))fail('DETAIL');
      if(declared===null)declared=total;
      if(total!==declared||current&&current.route!==route)fail('DETAIL');
      current??={route,amount:0,deliveries:0};
      current.amount=add(current.amount,amount);
      current.deliveries=add(current.deliveries,deliveries);
      lines.add(key);
      continue;
    }
    if(![null,undefined,''].includes(row.stockDate)||![null,undefined,''].includes(row.estCd)||!current||
      exactInteger(row.totalCnt)!==0||exactInteger(row.maechul)!==current.amount||
      exactInteger(row.baesongCnt)!==current.deliveries)fail('SUBTOTAL');
    const subtotalRoute=text(row.confirmCarSeq);
    if(subtotalRoute&&subtotalRoute!=='-'&&subtotalRoute!=='소계'&&vehicle(subtotalRoute)!==current.route)fail('SUBTOTAL');
    groups++;
    sum=add(sum,current.amount);
    count=add(count,current.deliveries);
    routes.set(current.route,[current.amount,current.deliveries]);
    current=null;
  }
  if(current||declared!==lines.size||groups!==routes.size||lines.size+groups!==payload.data.length)fail('COUNT');
  return {lines,routes,sum,count};
}

function verifiedWorkbookLines(bytes,date) {
  const XLSX=require('xlsx');
  const book=XLSX.read(bytes,{type:'buffer',sheetRows:12001,cellFormula:false,cellText:false});
  const [header,...rows]=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,defval:'',blankrows:false});
  const required=['입고요청일','확정호차','고객','매출금액','배송건수','기준호차'];
  const columns=required.map(name=>{
    const positions=header.flatMap((value,index)=>text(value)===name?[index]:[]);
    if(positions.length!==1)fail('WORKBOOK_FIELDS');
    return positions[0];
  });
  const [day,route,code,amount,count,base]=columns;
  const lines=new Set();
  for(const row of rows){
    if(text(row[day]).replace(/[-.]/g,'')!==date.replaceAll('-',''))continue;
    const key=JSON.stringify(detail(row[route],row[base],row[code],row[amount],row[count]));
    if(lines.has(key))fail('WORKBOOK_DETAIL');
    lines.add(key);
  }
  return lines;
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
export async function verifyStageFreshonWmsWorkbookOnce({
  bytes,date,observedAt,sha256,login,fetchImpl=fetch,env=process.env
}={}) {
  requestScope(date,env);
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>maxWorkbookBytes||!sha.test(sha256||'')||
    createHash('sha256').update(bytes).digest('hex')!==sha256)fail('WORKBOOK_SCOPE');
  parseOpsmapWmsDispatchExport(bytes,{date,observedAt});
  if(typeof login!=='function')fail('TRANSPORT');
  const {cookie}=await login();
  if(typeof cookie!=='string'||!cookie||/[\r\n]/.test(cookie))fail('SESSION');
  const evidence=await readStageFreshonWmsWorkbookEvidence({date,env,readJson:async (url,options)=>{
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
  return verifyStageFreshonWmsDispatchWorkbook({evidence,bytes,date,observedAt,sha256,env});
}
