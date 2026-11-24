import {opsmapArchiveSite} from './stageScope.js';
import {waitForPhotoSignal} from './opsmapDeliveryAdminTransport.js';
import {isDay} from './shadowCoverage/coverageFiles.js';

const origin='https://mis.freshon.co.kr';
const orderUrl=origin+'/bo/sm/order/orderInfoList';
const centers={
  osan:['011',['오산물류센터','오산센터','오산(직영) 센터']],
  yeongnam:['012',['영남센터']],
  honam:['013',['호남센터']]
};

function projectOrders(date, centerKey) {
  const [center,labels]=centers[centerKey];
  const customers=new Set(), lines=new Set();
  let count=0,rawCount=0,total=0,firstRejection;
  function validate(row) {
    if (!row) return 'RESPONSE_INVALID';
    if (row.stockDate!==date) return 'ROW_DATE_MISMATCH';
    if (!labels.includes(row.logCdName) || row.logCd && String(row.logCd)!==center) return 'ROW_CENTER_MISMATCH';
    if (row.dcOutDate!=='확정') return 'ROW_NOT_CONFIRMED';
    if (!/^[A-Z]\d{1,20}$/.test(row.estCd||'') || row.estCd!==row.dlvyEstCd) return 'ROW_CUSTOMER_INVALID';
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(row.orderNo||'') || !/^\d{1,12}$/.test(row.seq??'')) return 'ROW_ORDER_KEY_INVALID';
    const line=row.orderNo+':'+row.seq;
    const quantity=Number(String(row.orderQty??'').replaceAll(',',''));
    if (lines.has(line)) return 'ROW_DUPLICATE';
    if (!Number.isFinite(quantity) || quantity<=0) return 'ROW_QUANTITY_INVALID';
    lines.add(line);
    customers.add(row.estCd);
  }
  return {
    row(row) {
      if (++rawCount>60_000) throw Object.assign(Error('ORDER_ROWS_LIMIT'),{code:'ORDER_RESPONSE_INVALID'});
      if (row&&['소계','합계','총계'].includes(row.stockDate)&&!row.estCd&&!row.dlvyEstCd) return;
      if (++count===1) total=Number(row?.totalCnt);
      if (!firstRejection) firstRejection=validate(row);
    },
    finish({data,statusFailed,okFailed}) {
      if (!data||statusFailed||okFailed) return 'RESPONSE_INVALID';
      if (!count) return 'SOURCE_EMPTY';
      if (!Number.isSafeInteger(total)||total<1||count!==total) return 'COUNT_UNVERIFIED';
      return firstRejection||{date,centerKey,source:'freshon_orders',coverage:'partial',
        rows:[...customers].map(customerCode=>({customerCode,evidence:'order_confirmed'}))};
    }
  };
}

// Incremental envelope grammar, retaining only one JSON value. JSON.parse
// still validates each complete key/value/row including nested data and escapes.
function orderEnvelope(acceptRow) {
  const retained=Object.create(null),keys=new Set();
  let state='start', key, token=null;
  const space=character=>character===' '||character==='\t'||character==='\r'||character==='\n';
  const invalid=()=>{throw SyntaxError('ORDER_RESPONSE_JSON');};
  const begin=(delimiter,accept)=>{token={delimiter,accept,parts:[],depth:0,string:false,escaped:false};};
  function write(text) {
    let offset=0;
    while (offset<text.length) {
      if(token) {
        const start=offset,part=token;
        while(offset<text.length) {
          const c=text[offset];
          if(part.string) {
            if(part.escaped) part.escaped=false;
            else if(c==='\\') part.escaped=true;
            else if(c==='"')part.string=false;
          } else if(part.depth===0&&part.delimiter.includes(c)) break;
          else if(c==='"')part.string=true;
          else if(c==='{'||c==='[')part.depth++;
          else if(c==='}'||c===']') {if(--part.depth<0)invalid();}
          offset++;
        }
        if(offset>start)part.parts.push(text.slice(start,offset));
        if(offset===text.length) return;
        const delimiter=text[offset++];
        token=null;
        part.accept(JSON.parse(part.parts.join('')),delimiter);
        continue;
      }
      const c=text[offset];
      if(space(c)){offset++;continue;}
      if(state==='start'){
        if(c!=='{')throw Object.assign(Error('ORDER_RESPONSE_SHAPE'),{code:'ORDER_RESPONSE_INVALID'});
        state='firstKey';offset++;continue;
      }
      if(state==='firstKey'&&c==='}') {state='end';offset++;continue;}
      if(state==='firstKey'||state==='key') {
        if(c!=='"')invalid();
        begin(':',value=>{
          if(typeof value!=='string'||keys.has(value)&&['data','status','ok'].includes(value))invalid();
          if(['data','status','ok'].includes(value))keys.add(value);
          key=value;state='value';
        });
        continue;
      }
      if(state==='value'){
        if(key==='data'&&c==='['){retained.data=true;state='firstRow';offset++;continue;}
        begin(',}',(value,delimiter)=>{
          if(key==='status')retained.statusFailed=value>=400;
          if(key==='ok')retained.okFailed=value===false;
          state=delimiter===','?'key':'end';
        });
        continue;
      }
      if(state==='firstRow'&&c===']'){state='afterData';offset++;continue;}
      if(state==='firstRow'||state==='row'){
        begin(',]',(value,delimiter)=>{
          acceptRow(value);
          state=delimiter===','?'row':'afterData';
        });
        continue;
      }
      if(state==='afterData'&&(c===','||c==='}')){
        state=c===','?'key':'end';offset++;continue;
      }
      invalid();
    }
  }
  return {write,finish(){if(state!=='end'||token)invalid();return retained;}};
}

async function readOrderEvidence(response,date,centerKey,signal) {
  const limit=48*1024*1024;
  const length=response.headers.get('content-length');
  const type=(response.headers.get('content-type')||'').split(';')[0].trim();
  const cancel=reader=>{try {void reader?.cancel()?.catch(()=>{});}catch {}};
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)$/i.test(type)||
      length!==null&&(!/^\d+$/.test(length)||Number(length)>limit)) {
    cancel(response.body);throw Error('ORDER_RESPONSE_HEADERS');
  }
  const reader=response.body?.getReader();
  if(!reader)throw Error('ORDER_RESPONSE_BODY');
  const decoder=new TextDecoder('utf-8',{fatal:true}), projector=projectOrders(date,centerKey);
  const envelope=orderEnvelope(projector.row);
  const block=new Uint8Array(65_536);
  let bytes=0,filled=0;
  try {
    while(!signal.aborted) {
      const chunk=await waitForPhotoSignal(reader.read(),signal);
      if(chunk.done){
        if(filled)envelope.write(decoder.decode(block.subarray(0,filled),{stream:true}));
        envelope.write(decoder.decode());
        return projector.finish(envelope.finish());
      }
      bytes+=chunk.value.byteLength;
      if(bytes>limit)throw Error('ORDER_RESPONSE_LIMIT');
      // Fixed-size decoding both caps large chunks and coalesces tiny ones.
      for(let offset=0;offset<chunk.value.length;) {
        const take=Math.min(block.length-filled,chunk.value.length-offset);
        block.set(chunk.value.subarray(offset,offset+take),filled);
        filled+=take;offset+=take;
        if(filled===block.length) {
          envelope.write(decoder.decode(block,{stream:true}));
          filled=0;
        }
      }
    }
    throw Error('ORDER_RESPONSE_TIMEOUT');
  } finally {
    cancel(reader);
    try {reader.releaseLock();}catch {}
  }
}

export function createStageRecentOrdersReader({env=process.env, fetchImpl=fetch,onDiagnostic,
  login=async()=>(await import('./scraper/freshonDailyRoute.js')).loginFreshonSession()}={}) {
  if (!opsmapArchiveSite(env) ||
      env.OPSMAP_STAGE_RECENT_OPERATIONS_ORDERS_APPROVED!=='1' ||
      env.FRESHON_BASE_URL && new URL(env.FRESHON_BASE_URL).origin!==origin) return null;
  let cookie=String(env.FRESHON_COOKIE??''), attemptedLogin=false;
  async function authenticate() {
    if (attemptedLogin || !env.FRESHON_ID || !env.FRESHON_PASSWORD) return false;
    attemptedLogin=true;
    try {
      const result=await login();
      cookie=String(result?.cookie??'');
      return !!cookie;
    } catch {return false;}
  }
  return async(date,existingCenters=new Set(),{signal,allowLogin=true,onScopeDiagnostic}={})=>{
    const input=[];
    if (!isDay(date)) return input;
    const report=(centerKey,state)=>{
      try {onDiagnostic?.({date,centerKey,state});}
      catch { /* Diagnostics cannot change accepted evidence. */ }
      try {onScopeDiagnostic?.({centerKey,state});}
      catch { /* Recovery outcomes cannot change accepted evidence. */ }
    };
    if (!cookie && (!allowLogin || !await authenticate())) {
      for (const centerKey of Object.keys(centers)) report(centerKey,existingCenters.has(centerKey)?'ALREADY_OBSERVED':'AUTH_UNAVAILABLE');
      return input;
    }
    const timeout=AbortSignal.timeout(90_000);
    const budget=signal?AbortSignal.any([timeout,signal]):timeout;
    for (const [centerKey,[logCd]] of Object.entries(centers)) {
      if (existingCenters.has(centerKey)) {report(centerKey,'ALREADY_OBSERVED');continue;}
      if (budget.aborted) {report(centerKey,'BUDGET_EXHAUSTED');continue;}
      const body=new URLSearchParams({stockDateS:date,stockDateE:date,logCd,dcOutDate:'1',
        shipGbn:'1',deliveGbn:'',orderGbn:'',sortType:'3',sort:',ASC',page:'0',size:'1000',
        isPaging:'false',isCount:'true'});
      try {
        const request=()=>fetchImpl(orderUrl,{method:'POST',redirect:'manual',
          signal:AbortSignal.any([budget,AbortSignal.timeout(30_000)]),body:body.toString(),
          headers:{Cookie:cookie,Accept:'application/json','Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With':'XMLHttpRequest',Origin:origin,Referer:origin+'/bo/main'}});
        let response=await request();
        if (response.status===401 || response.status>=300&&response.status<400 ||
            response.ok&&response.headers.get('content-type')?.includes('text/html')) {
          await response.body?.cancel();
          if (!allowLogin || !await authenticate()) {report(centerKey,'AUTH_UNAVAILABLE');continue;}
          response=await request();
        }
        if (!response.ok) {
          await response.body?.cancel();
          report(centerKey,response.status===403?'SOURCE_FORBIDDEN':'HTTP_REJECTED');
          continue;
        }
        const evidence=await readOrderEvidence(response,date,centerKey,budget);
        if (typeof evidence==='string') report(centerKey,evidence);
        else {input.push(evidence);report(centerKey,'VERIFIED');}
      } catch (error) {report(centerKey,budget.aborted?'BUDGET_EXHAUSTED':
        error?.code==='ORDER_RESPONSE_INVALID'?'RESPONSE_INVALID':'READ_FAILED');}
    }
    return input;
  };
}
