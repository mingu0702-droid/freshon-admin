import fs from 'node:fs/promises';
const base='https://freshon-admin-stage-preview-template.onrender.com/api/map-phase2b/preview/';
const results={at:new Date().toISOString(),checks:{}};
for (const [label,path] of [['bounds','bounds?mode=BASE_90D&south=36.8&west=126.8&north=37.3&east=127.3'],['detail','detail?customerCode=S222538'],['route','route-plan?date=2026-08-11&vehicle=101']]) {
 const t=Date.now(),response=await fetch(base+path,{signal:AbortSignal.timeout(130000)});await response.arrayBuffer();
 const item={http:response.status,ms:Date.now()-t,cache:response.headers.get('x-phase2b-cache')};results.checks[label]=item;console.log(JSON.stringify({[label]:item}));
}
await fs.writeFile('C:/Users/SFN/.codex/outputs/phase2b-dated-pagination-20260913/warm-evidence.json',JSON.stringify(results,null,2));

