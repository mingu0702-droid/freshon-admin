import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../public/map-period-ui.js';
import '../public/phase2b-ui-helpers.js';
const runtime=fs.readFileSync(new URL('../public/map-phase2b-runtime.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/map-period.css',import.meta.url),'utf8');
const rows=[{customerCode:'A',customerName:'합성 A',history:[
 {deliveryDate:'2026-08-01',vehicle:'101',driverKey:'old',driverName:'과거기사'},
 {deliveryDate:'2026-08-20',vehicle:'202',driverKey:'new',driverName:'최근기사'}]}];
function fixture(){
 const nodes=new Map(), checks=[{value:'101',checked:true},{value:'202',checked:false}];
 const node=id=>{if(!nodes.has(id)) nodes.set(id,{value:'',innerHTML:'',textContent:'',options:[],selectedOptions:[],style:{},
 classList:{toggle(){},add(){},remove(){},contains(){return false;}},setAttribute(){},toggleAttribute(){},add(){}});return nodes.get(id);};
 const ctx=vm.createContext({window:{VEHICLE_AREA_DATA:{vehicles:[]}},document:{body:node('body'),querySelector:node,querySelectorAll:s=>s==='#vehicleList input[type=checkbox]'?checks:[]},
 MapPeriodUi:globalThis.MapPeriodUi,Phase2bUi:globalThis.Phase2bUi,Intl,Date,Map,Set,URL,URLSearchParams,Number,AbortController,setTimeout,clearTimeout,performance,console,innerWidth:1440,requestAnimationFrame(){}});
 vm.runInContext(runtime.slice(0,runtime.lastIndexOf('  initVehicles();'))+`
 activateSheet=()=>{}; clearMap=()=>{};
 window.test={state,switchMode,selectedVehicles,setSelectedVehicles,filteredPeriodStores,searchPeriod,
 setBasis:value=>periodBasis=value,setScope:value=>periodVehicleScope=value,
 setRows:rows=>{allStores=rows;periodRows=rows;dateReady=true;},setSnapshot:rows=>latestSnapshotRows=rows};
 })();`,ctx);
 return {...ctx.window.test,node};
}
test('period unique stores preserve full history and latest matching driver/vehicle',()=>{
 const result=MapPeriodUi.select([...rows,...rows],['101']);
 assert.equal(result.length,1);assert.equal(result[0].vehicle,'101');assert.equal(result[0].driverName,'과거기사');
 assert.equal(result[0].visitCount,1);assert.equal(result[0].history.length,2);
 assert.equal(MapPeriodUi.select(rows,[],'new')[0].vehicle,'202');
});
test('vehicle and driver criteria are exclusive; clear differs from all vehicles',()=>{
 const f=fixture();f.setRows(rows);f.state.driverKey='new';
 assert.equal(f.filteredPeriodStores()[0].vehicle,'101');
 f.setBasis('driver');assert.equal(f.filteredPeriodStores()[0].vehicle,'202');
 f.setBasis('vehicle');f.setSelectedVehicles([]);assert.equal(f.filteredPeriodStores().length,0);
 f.setScope('all');assert.equal(f.filteredPeriodStores()[0].vehicle,'202');
});
test('mode changes restore independent vehicle, area and center filters',()=>{
 const f=fixture();f.switchMode('BASE_60D');f.setSelectedVehicles(['202']);f.state.areaOn=true;f.state.centerFilter='osan';
 f.switchMode('DATE_ROUTE');assert.equal(f.selectedVehicles()[0],'101');assert.equal(f.state.areaOn,false);
 f.switchMode('BASE_60D');assert.equal(f.selectedVehicles()[0],'202');assert.equal(f.state.areaOn,true);assert.equal(f.state.centerFilter,'osan');
});
test('period customer search retains map rows and excludes latest master assignment',async()=>{
 const f=fixture();f.setRows(rows);f.state.currentRows=rows;
 f.setSnapshot([{customerCode:'OUT',customerName:'기간밖',vehicle:'999'}]);
 await f.searchPeriod('OUT');
 assert.match(f.node('#results').innerHTML,/선택 기간 이력 없음/);
 assert.doesNotMatch(f.node('#results').innerHTML,/999호/);
 assert.equal(f.state.currentRows,rows);assert.equal(f.selectedVehicles()[0],'101');
});
test('dense close-zoom map stays bounded and offscreen points do not create overlays',()=>{
 const many=Array.from({length:10000},(_,i)=>({customerCode:'S'+i,x:i%100*10,y:Math.floor(i/100)*10}));
 const pins=MapPeriodUi.cluster(many,row=>row,5,'S0',{width:390,height:700});
 assert.ok(pins.length<250);assert.ok(pins.some(row=>row.customerCode==='S0'&&!row.clusterCount));
 assert.equal(many.length,10000);
});
test('period view has one header, no daily ETA/status; mobile has distinct filters and store panels',()=>{
 assert.match(css,/\.periodMode #operationBar/);assert.match(css,/body.historicalMode #etaMetric\{display:none/);
 assert.match(runtime,/filters: \$\("#periodFilterPanel"\), stores: \$\("#periodStoreListSection"\)/);
 assert.match(runtime,/routeMode && !skipEnrich/);
 assert.match(runtime,/rangeStart: routeMode \? daysBefore\(state.selectedDate, 59\)/);
});

test('recent sixty days never regresses to a stale coordinate snapshot date',()=>{
 assert.ok(runtime.includes('state.rangeEnd = state.rangeEnd || localDate()'));
 assert.ok(runtime.includes('changePeriod(daysBefore(localDate(),59), localDate())'));
});
