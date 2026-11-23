import {STAGE_ORIGIN,STAGE_SERVICE} from './stageScope.js';
import {readBoundedPhotoLoginJson} from './opsmapDeliveryAdminTransport.js';
import {isDay} from './shadowCoverage/coverageFiles.js';

const origin='https://mis.freshon.co.kr';
const orderUrl=origin+'/bo/sm/order/orderInfoList';
const centers={
  osan:['011',['오산물류센터','오산센터','오산(직영) 센터']],
  yeongnam:['012',['영남센터']],
  honam:['013',['호남센터']]
};

function projectOrders(payload, date, centerKey) {
  const [center,labels]=centers[centerKey];
  if (!Array.isArray(payload?.data) || payload.status>=400 || payload.ok===false || payload.data.length>60_000) return 'RESPONSE_INVALID';
  const rows=payload.data.filter(row=>!row || !['소계','합계','총계'].includes(row.stockDate) || row.estCd || row.dlvyEstCd);
  if (!rows.length) return 'SOURCE_EMPTY';
  const total=Number(rows[0]?.totalCnt);
  if (!Number.isSafeInteger(total) || total<1 || rows.length!==total) return 'COUNT_UNVERIFIED';
  const customers=new Set(), lines=new Set();
  for (const row of rows) {
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
  return {date,centerKey,source:'freshon_orders',coverage:'partial',
    rows:[...customers].map(customerCode=>({customerCode,evidence:'order_confirmed'}))};
}

export function createStageRecentOrdersReader({env=process.env, fetchImpl=fetch,onDiagnostic,
  login=async()=>(await import('./scraper/freshonDailyRoute.js')).loginFreshonSession()}={}) {
  if (env.RENDER_SERVICE_ID!==STAGE_SERVICE || env.RENDER_EXTERNAL_URL!==STAGE_ORIGIN ||
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
  return async(date,existingCenters=new Set(),{signal,allowLogin=true}={})=>{
    const input=[];
    if (!isDay(date)) return input;
    const report=(centerKey,state)=>{
      try {onDiagnostic?.({date,centerKey,state});}
      catch { /* Diagnostics cannot change accepted evidence. */ }
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
            response.headers.get('content-type')?.includes('text/html')) {
          await response.body?.cancel();
          if (!allowLogin || !await authenticate()) {report(centerKey,'AUTH_UNAVAILABLE');continue;}
          response=await request();
        }
        if (!response.ok) {await response.body?.cancel();report(centerKey,'HTTP_REJECTED');continue;}
        const evidence=projectOrders(await readBoundedPhotoLoginJson(response,48*1024*1024,budget),date,centerKey);
        if (typeof evidence==='string') report(centerKey,evidence);
        else {input.push(evidence);report(centerKey,'VERIFIED');}
      } catch {report(centerKey,budget.aborted?'BUDGET_EXHAUSTED':'READ_FAILED');}
    }
    return input;
  };
}
