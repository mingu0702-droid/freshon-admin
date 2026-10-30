import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import '../..//public/map-view-policy.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const policy=globalThis.MapViewPolicy;
const project=row=>({x:(row.lng-126)*10000,y:(38-row.lat)*10000});
const store=(i,lat=37+i*.0001,lng=127+i*.0001,vehicle='122')=>({customerCode:`S${i}`,customerName:`매장 ${i}`,lat,lng,vehicle,baseVehicle:vehicle,addressRegion:'수도권'});
const flattened=rows=>rows.flatMap(row=>row.clusterRows || [row]);

test('selected hocha preserves every distinct positioned store even above generic 180-pin cap',()=>{
  const rows=Array.from({length:260},(_,i)=>store(i));
  const pins=policy.stableClusters(rows,project,10,'',null,{grouping:'individual',maxMarkers:40,mode:'BASE_60D'});
  assert.equal(pins.length,260);
  assert.deepEqual(flattened(pins).map(x=>x.customerCode),rows.map(x=>x.customerCode));
});
test('same-building distinct stores stay accessible via same-location member list',()=>{
  const rows=[store(1,37.5,127.5),store(2,37.5,127.5),store(3,37.5001,127.5001)];
  const pins=policy.stableClusters(rows,project,12,'',null,{grouping:'individual',mode:'DATE_ROUTE'});
  assert.equal(pins.length,2);
  const colocated=pins.find(x=>x.clusterCount===2);
  assert.equal(colocated.clusterKind,'location');
  assert.deepEqual(colocated.memberCodes,['S1','S2']);
  assert.equal(flattened(pins).length,3);
});
test('selected store stays visible at its own coordinates when neighboring shops overlap',()=>{
  const rows=[store(1,37.5,127.5),store(2,37.5,127.5),store(3,37.5001,127.5001)];
  const pins=policy.stableClusters(rows,project,12,'S1',null,{grouping:'individual'});
  assert(pins.some(x=>x.customerCode==='S1'));
  assert.deepEqual(flattened(pins).map(x=>x.customerCode).sort(),['S1','S2','S3']);
});
test('general map still groups geographically without losing source membership',()=>{
  const rows=Array.from({length:190},(_,i)=>store(i,37.5+(i%10)*.00001,127.5+Math.floor(i/10)*.00001,String(100+i)));
  const pins=policy.stableClusters(rows,project,12,'',null,{maxMarkers:40,mode:'BASE_60D'});
  assert(pins.length<=40);
  assert.equal(flattened(pins).length,190);
});
test('selected hocha route markers exclude off-screen stores but do not remove source records',()=>{
  const rows=[store(1,37.5,127.5),store(2,38.5,128.5)];
  const p=()=>({x:0,y:0});
  assert.equal(policy.stableClusters(rows,p,8,'',null,{grouping:'individual'}).length,2);
  const onlyFirst=row=>({x:row.customerCode==='S1'?30:900,y:30});
  assert.deepEqual(policy.stableClusters(rows,onlyFirst,8,'',{width:500,height:500},{grouping:'individual'}).map(x=>x.customerCode),['S1']);
});
test('source runtime selects vehicle summary in overview, individual stops in focused mode',()=>{
  const src=fs.readFileSync(path.join(root,'public/map-phase2b-runtime.js'),'utf8');
  assert.match(src,/const vehicleOverview = periodBasis === 'vehicle'/);
  assert.match(src,/representativeRows\(valid\)/);
  assert.match(src,/grouping:focusedStops\?'individual':'territory'/);
  assert.match(src,/periodVehicleScope = 'selected'; syncPeriodBasis\(\)/);
  assert.match(src,/실제 운행순서는 일자별 운행에서 확인/);
});
test('nav-assigned store pins remain selectable and pins have restored size',()=>{
  const css=fs.readFileSync(path.join(root,'public/map-performance.css'),'utf8');
  assert.match(css,/\.marker\.navAssigned \{ visibility:visible!important; pointer-events:auto!important; \}/);
  assert.match(css,/\.marker\.approvedMarker \.pin \{ width:40px; height:40px;/);
  assert.match(css,/\.marker\.approvedMarker \.pin>span \{ font-size:13px;/);
});
test('network recovery rechecks staff cookie but does not disable deliberate logout',()=>{
  const js=fs.readFileSync(path.join(root,'public/map-staff-entry.js'),'utf8');
  assert.match(js,/window.addEventListener\('online', \(\) => \{ if \(!logoutRequired\) void check\(\); \}\)/);
  const auth=fs.readFileSync(path.join(root,'src/mapStaffAuth.js'),'utf8');
  assert.match(auth,/STAFF_IDLE_MS = 8 \* 60/);
  assert.match(auth,/STAFF_MAX_MS = 12 \* 60/);
  assert.match(auth,/persistence: 'PROCESS_MEMORY'/);
});
