import {createHash} from 'node:crypto';
import {freshonWmsVehicle} from './stageFreshonWmsDispatch.js';
import {isStageWmsDay} from './stageWmsExportIndex.js';

const origin='https://mis.freshon.co.kr';
const sourceUrl=origin+'/bo/wm/dispatch/baecha_list';
const centers=new Map([['osan','011'],['yeongnam','012'],['honam','013']]);
const pageSize=3000;
const responseLimit=8*1024*1024;
const customerCodePattern=/^[A-Z]\d{1,20}$/;
const sha256=value=>createHash('sha256').update(value).digest('hex');
const fail=reason=>{
  const code='FRESHON_NIGHT_DISPATCH_'+reason;
  throw Object.assign(Error(code),{code});
};
const text=value=>typeof value==='string'?value.trim():Number.isSafeInteger(value)?String(value):'';

function integer(value) {
  const raw=text(value);
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.0+)?$/.test(raw)) fail('COUNT');
  const numeric=Number(raw.replaceAll(',',''));
  if (!Number.isSafeInteger(numeric)) fail('COUNT');
  return numeric;
}

function vehicle(value) {
  try { return freshonWmsVehicle(value); }
  catch { fail('DETAIL'); }
}

function readPage(payload,{dates,center}) {
  if (!Array.isArray(payload?.data)||payload.data.length>=pageSize||
      [payload.status,payload.statusCode].some(status=>status!=null&&text(status)!=='200')) fail('PAGE');
  const allowedDates=new Set(dates.map(date=>date.replaceAll('-','')));
  const customers=new Map(), counts=new Map(), routes=new Set();
  let group, detail=0, declared;
  for (const row of payload.data) {
    if (!row||typeof row!=='object'||Array.isArray(row)||
        (row.isSum!==false&&row.isSum!=='false')||
        (row.logCd!=null&&row.logCd!==''&&![center,String(Number(center))].includes(text(row.logCd)))) fail('SCOPE');
    const stamp=text(row.stockDate);
    const customerCode=text(row.estCd).toUpperCase();
    if (!stamp) {
      if (row.stockDate!=null&&row.stockDate!==''||row.estCd!=null&&row.estCd!==''||
          !group||integer(row.totalCnt)!==0||
          integer(row.maechul)!==group.amount||integer(row.baesongCnt)!==group.deliveries) fail('SUBTOTAL');
      const subtotalVehicle=text(row.confirmCarSeq);
      if (subtotalVehicle&&!['-','소계'].includes(subtotalVehicle)&&vehicle(subtotalVehicle)!==group.route) fail('SUBTOTAL');
      routes.add(group.route);
      group=undefined;
      continue;
    }
    if (!/^(?:\d{8}|\d{4}-\d\d-\d\d|\d{4}\.\d\d\.\d\d)$/.test(stamp)||
        !allowedDates.has(stamp.replace(/[-.]/g,''))) fail('SCOPE');
    const amount=integer(row.maechul), deliveries=integer(row.baesongCnt), total=integer(row.totalCnt);
    const route=vehicle(row.confirmCarSeq);
    if (!customerCodePattern.test(customerCode)||deliveries<1||
        total<1||total>=pageSize||routes.has(route)||(group&&group.route!==route)) fail('DETAIL');
    declared??=total;
    if (total!==declared) fail('COUNT');
    group??={route,amount:0,deliveries:0};
    group.amount+=amount;
    group.deliveries+=deliveries;
    if (!Number.isSafeInteger(group.amount)||!Number.isSafeInteger(group.deliveries)) fail('COUNT');
    detail++;
    const day=stamp.replace(/[-.]/g,'');
    counts.set(day,(counts.get(day)||0)+1);
    if (!customers.has(customerCode)) customers.set(customerCode,new Set());
    customers.get(customerCode).add(route);
  }
  const declaredTotals=[payload.totalCnt,payload.totalCount,payload.totalElements,payload.recordsTotal];
  if (group||detail+routes.size!==payload.data.length||(detail>0&&declared!==detail)||
      declaredTotals.some(total=>total!=null&&integer(total)!==detail)) fail('COUNT');
  return {customers,counts,detail};
}

async function responseBody(response) {
  if ([401,403].includes(response.status)) {
    await response.body?.cancel();
    fail('AUTH');
  }
  if (response.status!==200||!response.body||
      !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type')||'')) {
    await response.body?.cancel();
    fail('RESPONSE');
  }
  if (Number(response.headers.get('content-length'))>responseLimit) {
    await response.body.cancel();
    fail('RESPONSE_SIZE');
  }
  const chunks=[];
  let size=0;
  const reader=response.body.getReader();
  try {
    for (;;) {
      const {value,done}=await reader.read();
      if (done) break;
      size+=value.byteLength;
      if (size>responseLimit) {
        await reader.cancel();
        fail('RESPONSE_SIZE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes=Buffer.concat(chunks,size);
  try { return {payload:JSON.parse(bytes.toString('utf8')),digest:sha256(bytes)}; }
  catch { fail('RESPONSE'); }
}

function abortable(operation,signal) {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(operation).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

function neighborEvidence(neighbor,date,centerKey) {
  return neighbor&&neighbor.centerKey===centerKey&&isStageWmsDay(neighbor.date)&&
    Math.abs(Date.parse(date)-Date.parse(neighbor.date))===86_400_000&&
    Number.isSafeInteger(neighbor.detail)&&neighbor.detail>0&&neighbor.detail<pageSize;
}

function result(state,date,centerKey,observedAt,sourceSha256,detail,rows) {
  const summary={state,date,centerKey,observedAt,sourceSha256,rows};
  // Retain the provider's detail count for adjacent-day proof. It is different
  // from the returned count of unique customers and is not persisted as a row.
  return Object.freeze(Object.defineProperty(summary,'detail',{value:detail}));
}

export function createStageFreshonNightDispatchReader({login,fetchImpl=fetch,now=Date.now,deadlineMs=65_000}={}) {
  if (typeof login!=='function'||typeof fetchImpl!=='function'||typeof now!=='function'||
      !Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>90_000) fail('CONFIG');
  let batchSignal, session, queue=Promise.resolve(), requestCount=0;

  async function request(start,end,center,signal) {
    if (requestCount>=centers.size*2) fail('REQUEST_BUDGET');
    signal.throwIfAborted();
    requestCount++;
    batchSignal.throwIfAborted();
    session??=abortable(()=>login({signal:batchSignal}),batchSignal).then(value=>{
      const cookie=value?.cookie;
      if (typeof cookie!=='string'||!cookie||/[\r\n]/.test(cookie)) fail('AUTH');
      return cookie;
    },()=>fail('AUTH'));
    const cookie=await abortable(()=>session,signal);
    const form=new URLSearchParams({
      page:'0',isPaging:'true',isCount:'true',size:String(pageSize),sort:'stock_date,ASC',
      excelFileNm:'baecha_list',logCd:center,calStartDate:start,calEndDate:end,baecha:'2',shipGbn:'1',
      estCd:'',estName:'',cboStartCarSeq:'',cboStartCarSeqNm:'',cboEndCarSeq:'',cboEndCarSeqNm:''
    });
    const options={method:'POST',redirect:'error',signal,body:form.toString(),headers:{
      Accept:'application/json','Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
      Origin:origin,Referer:origin+'/bo/main#/bo/wm/dispatch/LOTMTR005_list',Cookie:cookie
    }};
    const {payload,digest}=await abortable(async()=>responseBody(await fetchImpl(sourceUrl,options)),signal);
    return {...readPage(payload,{dates:[start,end],center}),digest};
  }

  async function read(date,centerKey,{signal,neighbor}={}) {
    const center=centers.get(centerKey);
    if (!isStageWmsDay(date)||!center) fail('SCOPE');
    batchSignal??=AbortSignal.timeout(deadlineMs);
    const signals=[batchSignal,AbortSignal.timeout(25_000)];
    if (signal) signals.push(signal);
    const active=AbortSignal.any(signals);
    try {
      const exact=await request(date,date,center,active);
      if (exact.detail) {
        const rows=[...exact.customers.keys()].sort().map(customerCode=>({
          customerCode,vehicles:[...exact.customers.get(customerCode)].sort()
        }));
        return result('VERIFIED',date,centerKey,new Date(now()).toISOString(),exact.digest,exact.detail,rows);
      }
      if (!neighborEvidence(neighbor,date,centerKey)) return null;
      const [start,end]=[date,neighbor.date].sort();
      const range=await request(start,end,center,active);
      if (range.counts.has(date.replaceAll('-',''))||range.detail!==neighbor.detail||
          range.counts.get(neighbor.date.replaceAll('-',''))!==neighbor.detail) return null;
      const digest=sha256(JSON.stringify([date,center,exact.digest,range.digest,neighbor.date,neighbor.detail]));
      return result('ZERO_VERIFIED',date,centerKey,new Date(now()).toISOString(),digest,0,[]);
    } catch (error) {
      if (active.aborted) fail('TIMEOUT');
      if (/^FRESHON_NIGHT_DISPATCH_[A-Z_]+$/.test(error?.code||'')) throw error;
      fail('TRANSPORT');
    }
  }

  // The three centers share one bounded login, deadline and request budget.
  return (date,centerKey,options)=>{
    const work=queue.then(()=>read(date,centerKey,options));
    queue=work.catch(()=>{});
    return work;
  };
}
