import fs from 'node:fs/promises';
const base='https://freshon-admin-stage-preview-template.onrender.com/api/map-phase2b/preview/';
const out='C:/Users/SFN/.codex/outputs/phase2b-dated-pagination-20260913';
await fs.mkdir(out,{recursive:true});
const evidence={at:new Date().toISOString(),requests:[]};
for(const [name,url] of [['historical','assignments?date=2026-08-11'],['latest','assignments?date=latest']]){
 const started=Date.now();const response=await fetch(base+url,{signal:AbortSignal.timeout(180000)});const body=await response.json();
 const entry={name,http:response.status,ms:Date.now()-started,cache:response.headers.get('x-phase2b-cache'),meta:body.meta,error:body.error,count:body.data?.length};
 evidence.requests.push(entry);console.log(JSON.stringify(entry));
 if(response.ok&&body.ok) { await fs.writeFile(out+'/'+name+'.json',JSON.stringify(body)); evidence[name]=body; } else break;
}
if(evidence.historical&&evidence.latest){
 const recent=new Map(evidence.latest.data.map(r=>[r.customerCode,r]));
 const changed=evidence.historical.data.filter(r=>recent.has(r.customerCode)&&recent.get(r.customerCode).vehicle!==r.vehicle&&r.lat!=null&&recent.get(r.customerCode).lat!=null).map(r=>({customerCode:r.customerCode,pastDate:r.deliveryDate,pastVehicle:r.vehicle,latestDate:recent.get(r.customerCode).deliveryDate,latestVehicle:recent.get(r.customerCode).vehicle}));
 console.log(JSON.stringify({changedCount:changed.length,changed:changed.slice(0,8)}));
 evidence.changed=changed;
}
delete evidence.historical; delete evidence.latest;
await fs.writeFile(out+'/api-evidence.json',JSON.stringify(evidence,null,2));

