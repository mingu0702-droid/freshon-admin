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
  if (!Array.isArray(payload?.data) || payload.status>=400 || payload.ok===false || payload.data.length>60_000) return null;
  const rows=payload.data.filter(row=>!row || !['소계','합계','총계'].includes(row.stockDate) || row.estCd || row.dlvyEstCd);
  const total=Number(rows[0]?.totalCnt);
  if (!Number.isSafeInteger(total) || total<1 || rows.length!==total) return null;
  const customers=new Set(), lines=new Set();
  for (const row of rows) {
    if (!row || row.stockDate!==date || !labels.includes(row.logCdName) ||
        row.logCd && String(row.logCd)!==center || row.dcOutDate!=='확정' ||
        !/^[A-Z]\d{1,20}$/.test(row.estCd||'') || row.estCd!==row.dlvyEstCd ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(row.orderNo||'') || !/^\d{1,12}$/.test(row.seq??'')) return null;
    const line=row.orderNo+':'+row.seq;
    const quantity=Number(String(row.orderQty??'').replaceAll(',',''));
    if (lines.has(line) || !Number.isFinite(quantity) || quantity<=0) return null;
    lines.add(line);
    customers.add(row.estCd);
  }
  return {date,centerKey,source:'freshon_orders',coverage:'partial',
    rows:[...customers].map(customerCode=>({customerCode,evidence:'order_confirmed'}))};
}

export function createStageRecentOrdersReader({env=process.env, fetchImpl=fetch,
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
  return async(date,existingCenters=new Set())=>{
    const input=[];
    if (!isDay(date) || !cookie && !await authenticate()) return input;
    const budget=AbortSignal.timeout(90_000);
    for (const [centerKey,[logCd]] of Object.entries(centers)) {
      if (existingCenters.has(centerKey) || budget.aborted) continue;
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
          if (!await authenticate()) continue;
          response=await request();
        }
        if (!response.ok) {await response.body?.cancel();continue;}
        const evidence=projectOrders(await readBoundedPhotoLoginJson(response,48*1024*1024,budget),date,centerKey);
        if (evidence) input.push(evidence);
      } catch {/* A source or center can fail without replacing prior observations. */}
    }
    return input;
  };
}
