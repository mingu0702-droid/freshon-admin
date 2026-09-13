// Read-only Stage verifier. Never writes response bodies or operational records.
const base='https://freshon-admin-stage-preview-template.onrender.com',startDate='2026-07-17',endDate='2026-09-14';
const path='/api/map-phase2b/preview/period?startDate='+startDate+'&endDate='+endDate;
const sensitive=key=>/phone|password|memo|access|message|tel(?:ephone)?$|비밀번호|연락처/i.test(key);
function exposures(value){if(!value||typeof value!=='object')return 0;return Object.entries(value).reduce((n,[k,v])=>n+(sensitive(k)&&v!=null&&v!==''?1:0)+exposures(v),0);}
async function read(url){const at=performance.now(),r=await fetch(base+url,{signal:AbortSignal.timeout(45000)}),text=await r.text();let b;try{b=JSON.parse(text);}catch{}return{r,b,ms:Math.round((performance.now()-at)*10)/10,bytes:Buffer.byteLength(text)};}
function safe(x){return{http:x.r.status,ms:x.ms,contentType:x.r.headers.get('content-type'),bytes:x.bytes,parse:!!x.b,complete:x.b?.meta?.complete,phase:x.b?.meta?.phase,progress:x.b?.meta?.progress,rows:x.b?.data?.length,sensitiveFields:exposures(x.b?.data)};}
if(process.argv.includes('--route')){
 for(let i=0;i<2;i++){const x=await read('/api/map-phase2b/preview/route-plan?date=2026-08-11&vehicle=101');console.log(JSON.stringify({sample:'route',...safe(x),total:x.b?.data?.totalStops,completed:x.b?.data?.completedStops,remaining:x.b?.data?.remainingStops}));}
}else if(process.argv.includes('--regression')){
 for(const url of ['/api/collector/delivery','/api/collector/freshon','/api/map-phase2b/private/driver-history?customerCode=S222538','/api/map-phase2b/private/customer-detail?customerCode=S222538&date=2026-08-11','/api/map-phase2b/preview/detail?customerCode=S222538','/api/health']){const x=await read(url);console.log(JSON.stringify({endpoint:url.split('?')[0],...safe(x)}));}
}else{
 const initial=await read(path);console.log(JSON.stringify({sample:'period',...safe(initial),count:initial.b?.meta?.count,sourceTotal:initial.b?.meta?.sourceTotal}));
 if(initial.r.status===200&&initial.b?.meta?.complete){
  const stores=initial.b.data,driver=stores.flatMap(s=>s.history||[]).find(h=>h.vehicle==='101'&&h.driverKey)?.driverKey;
  const sample=stores.find(s=>s.customerCode==='S222538');
  console.log(JSON.stringify({sample:'history-integrity',visits:sample?.history?.length,multipleDates:sample?new Set(sample.history.map(h=>h.deliveryDate)).size:0,multiVehicleStores:stores.filter(s=>new Set(s.history.map(h=>h.vehicle)).size>1).length}));
  for(const [name,query]of [['vehicle','&vehicle=101'],['driver','&driverKey='+encodeURIComponent(driver||'')]]){
   if(name==='driver'&&!driver)continue;const measurements=[];
   for(let i=0;i<5;i++){const x=await read(path+query);const ok=x.b?.data?.every(s=>(s.history||[]).some(h=>name==='vehicle'?h.vehicle==='101':h.driverKey===driver));measurements.push({...safe(x),filterValid:ok});}
   const times=measurements.map(x=>x.ms).sort((a,b)=>a-b);console.log(JSON.stringify({sample:name,measurements,min:times[0],median:times[2],max:times.at(-1)}));
  }
 }
}
