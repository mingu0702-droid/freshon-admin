import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import vm from 'node:vm';import {performance} from 'node:perf_hooks';
import '../../public/map-view-policy.js';
const context={Map,Set,Math,Number,Object,Array,Date};context.window=context;
const baseline=process.env.OPSMAP_BASELINE_ROOT?path.join(process.env.OPSMAP_BASELINE_ROOT,'public/map-period-ui.js'):fileURLToPath(new URL('../../../baseline/public/map-period-ui.js',import.meta.url));
if(fs.existsSync(baseline))vm.runInNewContext(fs.readFileSync(baseline,'utf8'),context);
const rows=Array.from({length:2036},(_,i)=>({customerCode:'S'+(10000+i),lat:35.05+(i%47)*.065,lng:126.2+Math.floor(i/47)*.048,vehicle:String(101+i%25),baseVehicle:String(101+i%25),baseVehicleGroup:'osan',addressRegion:i%2?'수도권':'충청권'}));
const project=r=>({x:(r.lng-126)*420,y:(38.4-r.lat)*210});
function bench(fn){const times=[];let output;for(let i=0;i<60;i++){const t=performance.now();output=fn();if(i>=10)times.push(performance.now()-t);}times.sort((a,b)=>a-b);return {markerCount:output.length,medianMs:+times[25].toFixed(3),p95Ms:+times[47].toFixed(3)};}
const result={scope:'SYNTHETIC_CPU_MICROBENCHMARK_NOT_REAL_SDK_OR_NETWORK',rows:rows.length,baselineDaily:{markerCount:rows.length,note:'baseline DATE_ROUTE does not call cluster()'},patchedDaily:bench(()=>MapViewPolicy.stableClusters(rows,project,10,'',{width:1440,height:900},{mode:'DATE_ROUTE',maxMarkers:180,sourceVersion:'fixture-v1'})),baselineGeneral:context.MapPeriodUi?bench(()=>context.MapPeriodUi.cluster(rows,project,10,'',{width:1440,height:900})):{status:'BASELINE_NOT_SUPPLIED'},patchedGeneral:bench(()=>MapViewPolicy.stableClusters(rows,project,10,'',{width:1440,height:900},{mode:'BASE_60D',maxMarkers:180,sourceVersion:'fixture-v1'}))};
console.log(JSON.stringify(result,null,2));
