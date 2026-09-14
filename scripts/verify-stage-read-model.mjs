// Stage-only, read-only evidence. Never persist or print operational bodies.
const base='https://freshon-admin-stage-preview-template.onrender.com';
const sensitive=k=>/phone|password|passwd|rawmemo|accessinfo|accessmemo|detailaddress|specialremark/i.test(k.replace(/[_\s-]/g,''));
function fields(v,parent=''){return !v||typeof v!=='object'?0:Object.entries(v).reduce((n,[k,x])=>n+Number(sensitive(k)||(parent==='location'&&k==='message'))+fields(x,k),0);}
async function read(path){const at=performance.now();try{const r=await fetch(base+path,{signal:AbortSignal.timeout(45000)});let raw=await r.text(),j;try{j=JSON.parse(raw);}catch{}const bytes=Buffer.byteLength(raw);raw='';return{j,http:r.status,ms:+(performance.now()-at).toFixed(1),bytes,encoding:r.headers.get('content-encoding'),contentLength:Number(r.headers.get('content-length'))||null};}catch{return{http:0,error:'NETWORK_OR_TIMEOUT',ms:+(performance.now()-at).toFixed(1)};}}
function safe(x){return{http:x.http,ms:x.ms,bytes:x.bytes,encoding:x.encoding,compressedBytes:x.contentLength,sensitiveFields:fields(x.j?.data),error:x.error};}
if(process.argv.includes('--regression')){
 for(const path of ['/api/health','/api/collector/delivery','/api/collector/freshon','/api/map-phase2b/private/customer-detail?customerCode=S222538','/api/map-phase2b/private/driver-history?customerCode=S222538','/api/map-phase2b/preview/detail?customerCode=S222538']){const x=await read(path);console.log(JSON.stringify({endpoint:path.split('?')[0],...safe(x)}));}
 for(let i=0;i<2;i++){const x=await read('/api/map-phase2b/preview/route-plan?date=2026-08-11&vehicle=101');console.log(JSON.stringify({sample:'route',...safe(x),total:x.j?.data?.totalStops,completed:x.j?.data?.completedStops,remaining:x.j?.data?.remainingStops}));}
 const x=await read('/api/map-phase2b/preview/today-status?date=2026-09-15');const d=x.j?.data;console.log(JSON.stringify({sample:'current-delivery',...safe(x),requestedDate:d?.requestedBusinessDate,responseDate:d?.responseBusinessDate,complete:d?.complete,vehicles:d?.vehicles?.length,source:d?.source,fetchedAt:d?.fetchedAt}));
}else{
 for(const [range,startDate]of [['7d','2026-09-09'],['60d','2026-07-18']]){
  const path='/api/map-phase2b/preview/period?startDate='+startDate+'&endDate=2026-09-15',samples=[];
  for(let i=0;i<5;i++){const x=await read(path);samples.push({...safe(x),complete:x.j?.meta?.complete,phase:x.j?.meta?.phase,stores:x.j?.data?.length});if(x.http!==200||!x.j?.meta?.complete)break;}
  console.log(JSON.stringify({range,samples}));if(samples[0]?.http!==200)break;
  const x=await read(path),driver=x.j?.data?.flatMap(r=>r.relations||[]).find(r=>r.vehicle==='101'&&r.driverKey)?.driverKey;
  for(const [filter,value]of [['vehicle','101'],['driverKey',driver]]){if(!value)continue;const y=await read(path+'&'+filter+'='+encodeURIComponent(value));console.log(JSON.stringify({range,filter,...safe(y),stores:y.j?.data?.length,filterMatch:y.j?.data?.every(r=>(r.relations||[]).some(h=>h[filter]===value)),noDailyHistory:y.j?.data?.every(r=>!('history'in r))}));}
 }
}
