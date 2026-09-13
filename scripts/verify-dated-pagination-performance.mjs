import fs from 'node:fs/promises';
const base='https://freshon-admin-stage-preview-template.onrender.com/api/map-phase2b/preview/';
const results={at:new Date().toISOString(),performance:{}};
for(const [label,path] of [['bounds','bounds?mode=BASE_90D&south=36.8&west=126.8&north=37.3&east=127.3'],['detail','detail?customerCode=S222538'],['route','route-plan?date=2026-08-11&vehicle=101'],['assignments','assignments?date=2026-08-11']]){
 const times=[];
 for(let i=0;i<2;i++){
  const t=Date.now(),r=await fetch(base+path,{signal:AbortSignal.timeout(140000)}),j=await r.json();
  times.push({http:r.status,ms:Date.now()-t,cache:r.headers.get('x-phase2b-cache'),error:j.error||null});
  if(label==='route'&&i===0)results.route={date:j.data?.date,total:j.data?.totalStops,completed:j.data?.completedStops,remaining:j.data?.remainingStops,rows:j.data?.stops?.length};
 }
 results.performance[label]=times;console.log(JSON.stringify({[label]:times,...(label==='route'?{route:results.route}:{})}));
}
const s=await fetch(base+'status');results.status=await s.json();
await fs.writeFile('C:/Users/SFN/.codex/outputs/phase2b-dated-pagination-20260913/performance-status.json',JSON.stringify(results,null,2));
console.log(JSON.stringify({status:results.status}));

