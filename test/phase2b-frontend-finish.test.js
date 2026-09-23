import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../public/map-period-ui.js';
import '../public/phase2b-ui-helpers.js';
const runtime = fs.readFileSync(new URL('../public/map-phase2b-runtime.js', import.meta.url), 'utf8');
const file = name => fs.readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');
const range = {startDate:'2026-08-01', endDate:'2026-08-28', complete:true};
const sample = {customerCode:'S900001',customerName:'합성 매장',vehicle:'101',lat:37.1,lng:127.1,
  history:[{deliveryDate:'2026-08-28',vehicle:'101',driverKey:'SYNTHETIC',driverName:'합성기사'}]};
const model = {ready:true,periodLatest:'2026-09-19',startDate:'2026-06-22',endDate:'2026-09-19'};
function fixture(windowData = {}) {
  const nodes = new Map(), selectors = new Map(), timers = new Map(), drawn = []; let seq = 0, downloads = 0;
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,attrs:{},dataset:{},style:{setProperty(){}},clientWidth:1000,clientHeight:700,options:[],selectedOptions:[],children:[],
        classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k),toggle(k,v){ if(v ?? !classes.has(k))classes.add(k);else classes.delete(k); }},
        setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},toggleAttribute(){},append(x){this.children.push(x);},replaceChildren(...x){this.children=x;},add(){},addEventListener(){},
        click(){downloads++;},getBoundingClientRect(){return {left:320,width:1000,top:58};}});
    }
    return nodes.get(id);
  };
  const checks=[{value:'101',checked:true}]; selectors.set('#vehicleList input[type=checkbox]', checks);
  const ctx = vm.createContext({window:windowData,document:{body:node('body'),querySelector:node,querySelectorAll:s=>selectors.get(s)||[],createElement:t=>node('created-'+t+'-'+(++seq))},
    MapPeriodUi:globalThis.MapPeriodUi,Phase2bUi:globalThis.Phase2bUi,Date,Intl,Map,Set,URL,URLSearchParams,Number,Symbol,AbortController,performance,console,
    setTimeout:(fn,ms)=>{timers.set(++seq,{fn,ms});return seq;},clearTimeout:id=>timers.delete(id),requestAnimationFrame(){},innerWidth:1440,innerHeight:900,
    kakao:{maps:{LatLng:class {constructor(lat,lng){this.lat=lat;this.lng=lng;}},LatLngBounds:class {extend(){}},Polygon:class {constructor(options){this.options=options;}setMap(map){this.map=map;}},CustomOverlay:class {constructor(options){this.options=options;}setMap(map){if(map)drawn.push(this.options.content);}}}},
    Option:class {constructor(text,value){this.textContent=text;this.value=value;}},location:{href:'http://local.test/'}});
  vm.runInContext(runtime.slice(0,runtime.lastIndexOf('  initVehicles();')) + `
    activateSheet=()=>{}; refreshVehicleUi=()=>{};
    window.test={state,initializePeriod,selectLatestRoute,syncDateHeading,drawSelectedBoundaries,clearBoundaries,changePeriod,changeSelectedDate,clearNewAreaBatch,runNewArea,exportNewArea,selectStore,clearSelection,renderStops,search,searchPeriod,loadOperationStatus,showDiagnostics,renderPeriodStoreList,selectCenter,comparisonStores,judgeNewAreaPoint,loadBaseVehicles,
      baseRows:()=>[...baseVehicles.values()],
      setReady:()=>{dateReady=true;periodMeta=${JSON.stringify(range)};state.rangeStart=periodMeta.startDate;state.rangeEnd=periodMeta.endDate;},
      setRows:rows=>{periodRows=rows;replaceStoreSnapshot(rows,{});},
      setFetch:fn=>fetchJson=fn,setJudge:fn=>judgeNewAreaRow=fn,setInput:rows=>parseNewArea=()=>rows,
      setWidth:value=>innerWidth=value,ready:()=>dateReady};
  })();`, ctx);
  return {...ctx.window.test,node,selectors,timers,drawn,downloads:()=>downloads};
}

test('center round trip clears hidden driver/vehicle filters and invalidates old search',()=>{
 const f=fixture();f.setReady();
 for(const center of ['osan','yeongnam','honam','all','osan']){
  f.state.driverKey='OLD';f.node('#periodDriver').value='OLD';f.selectors.get('#vehicleList input[type=checkbox]')[0].checked=true;
  const before=f.state.searchRequestId;f.selectCenter(center);
  assert.equal(f.state.driverKey,'');assert.equal(f.node('#periodDriver').value,'');assert.equal(f.selectors.get('#vehicleList input[type=checkbox]')[0].checked,false);
  assert.ok(f.state.searchRequestId>before);assert.equal(f.node('#periodCenter').value,center);
 }
});

test('base refresh queries visible-period codes only and preserves selection/range/center/camera',async()=>{
 const f=fixture();f.setReady();f.setRows([sample]);f.state.selected={...sample};f.state.centerFilter='osan';f.state.fitRequested=false;
 const requests=[];let version='v1',vehicle='101';
 f.setFetch(async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {data:[{customerCode:sample.customerCode,baseVehicle:vehicle,baseVehicleGroup:'osan',baseVehicleState:vehicle?'VERIFIED_MASTER':'UNASSIGNED',baseVehicleVersion:version,baseVehicleStale:true}],meta:{version,stale:true,refresh:'RUNNING',checkedAt:'2026-09-23T00:00:00Z'}};});
 await f.loadBaseVehicles();assert.deepEqual(requests[0].body.customerCodes,[sample.customerCode]);
 assert.equal(f.state.selected.customerCode,sample.customerCode);assert.equal(f.state.rangeStart,range.startDate);assert.equal(f.state.centerFilter,'osan');assert.equal(f.state.fitRequested,false);assert.match(f.node('#detailBaseVehicle').textContent,/101호.*이전 확인값/);
 version='v2';vehicle='';await [...f.timers.values()].at(-1).fn();await new Promise(r=>setImmediate(r));
 assert.equal(f.state.selected.baseVehicle,'');assert.equal(f.state.selected.vehicle,'');assert.match(f.node('#detailBaseVehicle').textContent,/미지정/);assert.equal(f.state.selected.customerCode,sample.customerCode);assert.equal(f.state.centerFilter,'osan');
});
test('outside-period customer code is included without requesting all master customers',async()=>{
 const f=fixture();f.setReady();f.setRows([sample]);let codes;
 f.setFetch(async(_u,o)=>{codes=JSON.parse(o.body).customerCodes;return {data:codes.map(customerCode=>({customerCode,baseVehicle:'101',baseVehicleState:'VERIFIED_MASTER',baseVehicleVersion:'v1'})),meta:{version:'v1'}};});
 await f.loadBaseVehicles(['S123456']);assert.deepEqual(codes,[sample.customerCode,'S123456']);assert.equal(f.baseRows().length,2);
});
test('failed refresh keeps verified label and schedules non-blocking retry',async()=>{
 const f=fixture();f.setReady();f.setRows([sample]);
 f.setFetch(async()=>({data:[{customerCode:sample.customerCode,baseVehicle:'101',baseVehicleState:'VERIFIED_MASTER',baseVehicleVersion:'v1'}],meta:{version:'v1',refresh:'IDLE'}}));
 await f.loadBaseVehicles();f.setFetch(async()=>{throw Error('NETWORK');});await f.loadBaseVehicles();assert.equal(f.baseRows()[0].baseVehicle,'101');assert.equal(f.timers.size,1);
});
test('period change during a base request loads newly required customers immediately',async()=>{
 const f=fixture();f.setReady();f.setRows([sample]);let resolve,calls=0;
 const result=code=>({data:[{customerCode:code,baseVehicle:'101',baseVehicleState:'VERIFIED_MASTER',baseVehicleVersion:'v1'}],meta:{version:'v1'}});
 f.setFetch(async()=>{calls++;return calls===1?new Promise(r=>resolve=r):result('S123456');});
 const first=f.loadBaseVehicles();f.setRows([{...sample,customerCode:'S123456'}]);const second=f.loadBaseVehicles();resolve(result(sample.customerCode));await Promise.all([first,second]);
 assert.equal(calls,2);assert(f.baseRows().some(r=>r.customerCode==='S123456'));
});
test('new area uses other centers existing points, preserves apartment/Jeju exclusions',()=>{
 const f=fixture();f.setReady();f.state.centerFilter='osan';f.setRows([{...sample,address:'부산광역시 가로 1',lat:35.17,lng:129.07}]);
 assert.equal(f.comparisonStores().length,1);
 for(const address of ['부산광역시 가로 2','광주광역시 가로 2','경기도 광주시 가로 2'])assert.equal(f.judgeNewAreaPoint({address},{lat:35.17,lng:129.07}).decision,'O');
 assert.equal(f.judgeNewAreaPoint({address:'제주특별자치도 제주시 가로 1'},{lat:35.17,lng:129.07}).decision,'X');
 assert.equal(f.judgeNewAreaPoint({address:'부산광역시 자이 아파트 101동 102호'},{lat:35.17,lng:129.07}).reason,'아파트');
 assert.equal(f.judgeNewAreaPoint({address:'부산광역시 상가동 가로 1'},{lat:35.17,lng:129.07}).decision,'O');
 assert.equal(f.judgeNewAreaPoint({address:'전라남도 가로 1'},{lat:33,lng:126}).reason,'해당 센터 비교자료 부족');
});
test('startup uses model latest after status, not stale Snapshot or today',async()=>{
 const f=fixture(),urls=[];
 f.setFetch(async url=>{urls.push(url);if(url.endsWith('period-status'))return model;if(url.endsWith('snapshot'))return {data:[],meta:{latestDate:'2026-08-24'}};return {data:[sample],meta:{complete:true,startDate:'2026-07-22',endDate:'2026-09-19',coverageComplete:false}};});
 await f.initializePeriod();
 assert.equal(urls.length,4);assert.ok(urls[0].endsWith('period-status'));assert.ok(urls[2].includes('startDate=2026-07-22&endDate=2026-09-19'));assert.ok(urls[3].endsWith('base-vehicles'));
 assert.equal(f.state.rangeEnd,'2026-09-19');assert.equal(f.node('#latestDate').textContent,'2026-07-22 ~ 2026-09-19');
 assert.equal(f.node('#periodStoreList').attrs['data-state'],'ready');assert.equal(f.node('#periodStoreListCount').textContent,'1개 매장');
 assert.equal(f.node('#freshnessState').textContent,'지도 반영일 2026-09-19');assert.doesNotMatch(f.node('#freshnessState').textContent,/원천 0건/);
 assert.equal(f.selectors.get('#vehicleList input[type=checkbox]').filter(x=>x.checked).length,0);
});
test('default Period creates zero cards; selecting a late store creates only its card',()=>{
 const f=fixture();f.setReady();const rows=Array.from({length:6000},(_,i)=>({...sample,customerCode:'S'+(900000+i)}));
 f.state.currentRows=rows;f.renderPeriodStoreList();assert.equal((f.node('#periodStoreList').innerHTML.match(/data-period-store=/g)||[]).length,0);
 f.selectStore(rows[5999],null,false);assert.equal((f.node('#periodStoreList').innerHTML.match(/data-period-store=/g)||[]).length,1);
 f.clearSelection();assert.equal((f.node('#periodStoreList').innerHTML.match(/data-period-store=/g)||[]).length,0);
 assert.equal(f.state.currentRows.length,6000);
});
test('repeated map idle reuses pins, preserves polygons and never fetches',()=>{
 const f=fixture();f.setReady();f.state.fitRequested=false;let calls=0;f.setFetch(()=>{calls++;throw Error('must not fetch');});
 f.state.map={getLevel:()=>5,getProjection:()=>({containerPointFromCoords:()=>({x:100,y:100})})};
 const rows=[sample];f.renderStops(rows);const overlay=f.state.overlays[0];const boundary={setMap(){throw Error('must not rebuild');}};f.state.polygons=[boundary];
 f.renderStops(rows,{viewportOnly:true});assert.equal(f.state.overlays[0],overlay);assert.equal(f.state.polygons[0],boundary);assert.equal(calls,0);
 const metrics=JSON.parse(f.node('#map').attrs['data-render-metrics']);assert.equal(metrics.created,1);assert.equal(metrics.removed,0);assert.equal(metrics.reused,1);
});
test('model not ready polls status only and transitions to ready automatically',async()=>{
 const f=fixture(),urls=[];let ready=false;
 f.setFetch(async url=>{urls.push(url);if(url.endsWith('period-status'))return {...model,ready};if(url.endsWith('snapshot'))return {data:[]};return {data:[sample],meta:{complete:true,startDate:'2026-07-22',endDate:'2026-09-19'}};});
 await f.initializePeriod();assert.equal(urls.length,1);assert.equal(f.node('#periodStoreList').attrs['data-state'],'not-ready');
 ready=true;await [...f.timers.values()][0].fn();await new Promise(r=>setImmediate(r));
 assert.equal(f.ready(),true);assert.equal(f.node('#periodStoreList').attrs['data-state'],'ready');
});
test('late bootstrap NOT_READY cannot overwrite a newer successful period',async()=>{
 const f=fixture();let done;f.setFetch(()=>new Promise(r=>done=r));const initial=f.initializePeriod();
 f.setFetch(async()=>({data:[sample],meta:range}));await f.changePeriod(range.startDate,range.endDate);
 done({ready:false});await initial;assert.equal(f.node('#periodStoreList').attrs['data-state'],'ready');assert.equal(f.timers.size,0);
});
test('late old Period NOT_READY cannot overwrite newer successful period',async()=>{
 const f=fixture();let done;f.setFetch(()=>new Promise(r=>done=r));const old=f.changePeriod('2026-08-02',range.endDate);
 f.setFetch(async()=>({data:[sample],meta:range}));await f.changePeriod(range.startDate,range.endDate);
 done({meta:{complete:false},pendingReason:'READ_MODEL_NOT_READY'});await old;
 assert.equal(f.node('#periodStoreList').attrs['data-state'],'ready');assert.equal(f.timers.size,0);
});
test('out-of-range is distinct from not-ready and never loops retry',async()=>{
 const f=fixture();f.setFetch(async()=>({data:[],meta:{complete:false},pendingReason:'READ_MODEL_RANGE_NOT_READY'}));
 await f.changePeriod(range.startDate,range.endDate);assert.equal(f.node('#periodStoreList').attrs['data-state'],'out-of-range');
 assert.match(f.node('#periodStoreList').innerHTML,/기간 범위 밖/);assert.equal(f.timers.size,0);
});
test('draft Period heading updates immediately; Daily uses only selectedDate',()=>{
 const f=fixture();f.state.latestDate='2026-08-24';f.node('#rangeStart').value='2026-06-22';f.node('#rangeEnd').value='2026-09-19';f.syncDateHeading();
 assert.equal(f.node('#latestDate').textContent,'2026-06-22 ~ 2026-09-19');
 f.state.mode='DATE_ROUTE';f.state.selectedDate='2026-09-21';f.syncDateHeading();assert.equal(f.node('#latestDate').textContent,'2026-09-21');
});
test('latest Daily resolves actual assignments API date, never Snapshot fallback',async()=>{
 const f=fixture(),urls=[];f.state.latestDate='2026-08-24';
 f.setFetch(async url=>{urls.push(url);return {data:[sample],meta:{date:'2026-09-19',complete:true}};});await f.selectLatestRoute();
 assert.ok(urls[0].endsWith('assignments?date=latest'));assert.equal(f.state.selectedDate,'2026-09-19');assert.equal(f.node('#periodControls').hidden,true);assert.equal(f.node('#dailyControls').hidden,false);
});
test('all-vehicle Osan administrative geometry attaches, toggles without selection/camera mutations',()=>{
 const f=fixture({VEHICLE_AREA_DATA:{vehicles:[{vehicle:'101',group:'osan',overview_admin_codes:['A']},{vehicle:'202',group:'honam',overview_admin_codes:['B']}]},ADMIN_FEATURES:[{properties:{code:'A'},geometry:{type:'Polygon',coordinates:[[[127,37],[128,37],[128,38],[127,37]]]}}]});
 f.selectors.get('#vehicleList input[type=checkbox]').forEach(x=>x.checked=false);
 f.state.map={center:'unchanged',level:5};f.state.centerFilter='osan';f.state.selected=sample;const map=f.state.map;
 f.drawSelectedBoundaries([]);assert.equal(f.state.polygons.length,1);assert.equal(f.state.polygons[0].map,map);assert.equal(f.node('#areaToggle').attrs['data-geometry-count'],'1');
 f.clearBoundaries();assert.equal(f.state.polygons.length,0);assert.equal(f.state.selected,sample);assert.equal(map.level,5);assert.equal(map.center,'unchanged');assert.equal(f.state.mode,'BASE_60D');
});
test('date controls move as one DOM into sidebar; address retains original DOM/events; assets versioned',()=>{
 const html=file('map-phase2b-preview.html');assert.ok(html.indexOf('id="mapDateBar"')<html.indexOf('id="map"'));
 assert.equal(html.split('id="selectedDate"').length-1,1);assert.equal(html.split('id="todayBtn"').length-1,1);
 assert.ok(runtime.includes('$("#results").before(addressPanel)'));assert.ok(!runtime.includes('filters.append($("#legacyVehicleState"), $("#periodDriver"), $("#periodControls"))'));
 assert.ok(runtime.includes("$('#leftPanel .head').append($('#mapDateBar'))"));
 for(const asset of ['map-data-sync.js','map-staff.js','map-staff.css'])assert.ok(html.includes(asset+'?v=20260924-ui1'));
 for(const asset of ['map-period-ui.js','map-phase2b-runtime.js'])assert.ok(html.includes(asset+'?v=20260924-fixed-cache1'));
 assert.ok(html.includes('map-period.css?v=20260924-ui1'));
});
test('recent range never exceeds available model start and never guesses absent latest',()=>{
 assert.deepEqual(MapPeriodUi.recentRange({...model,startDate:'2026-09-01'}),{start:'2026-09-01',end:'2026-09-19'});
 assert.equal(MapPeriodUi.recentRange({ready:false}),null);assert.equal(MapPeriodUi.recentRange({ready:true}),null);
});

test('batch analysis -> clear -> both exports cannot resurrect prior results', async () => {
  const f=fixture();f.setReady();f.setInput([{address:'합성 주소'}]);f.setJudge(async row=>({...row,decision:'O'}));
  f.node('#newAreaBatchInput').value='합성 주소';
  await f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults');
  assert.equal(f.state.newAreaResults.length,1);assert.equal(f.node('#exportNewAreaCsv').disabled,false);
  f.clearNewAreaBatch();
  assert.equal(f.state.newAreaResults.length,0);assert.equal(f.node('#newAreaBatchInput').value,'');assert.equal(f.node('#newAreaBatchResults').innerHTML,'');
  assert.equal(f.node('#newAreaBatchStatus').textContent,'입력 0 · 완료 0');
  f.exportNewArea('csv');f.exportNewArea('xlsx');assert.equal(f.downloads(),0);
  assert.equal(f.node('#exportNewAreaCsv').disabled,true);assert.equal(f.node('#exportNewAreaExcel').disabled,true);
});
test('clear invalidates an in-flight batch and prevents late export enablement',async()=>{
  const f=fixture();f.setReady();f.setInput([{address:'합성'}]);let done;f.setJudge(()=>new Promise(r=>done=r));
  const pending=f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults');
  f.clearNewAreaBatch();done({decision:'O'});await pending;
  assert.equal(f.state.newAreaResults.length,0);assert.equal(f.node('#newAreaBatchStatus').textContent,'입력 0 · 완료 0');assert.equal(f.node('#exportNewAreaCsv').disabled,true);
});
test('a failed replacement analysis cannot export the previous successful batch',async()=>{
  const f=fixture();f.setReady();f.state.newAreaResults=[sample];f.setInput([{}]);f.setJudge(async()=>{throw Error('synthetic');});
  await f.runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults');
  assert.equal(f.state.newAreaResults.length,1);assert.match(f.state.newAreaResults[0].reason,/조회 실패/);assert.equal(f.state.newAreaResults[0].customerCode,undefined);assert.equal(f.downloads(),0);
});
test('Period not-ready retains old overlays and does not claim empty or start recovery',async()=>{
  const f=fixture();let removed=0;const old=[sample];f.state.currentRows=old;f.state.overlays=[{setMap:()=>removed++}];
  f.setFetch(async url=>{assert.ok(!url.includes('retry=1'));return {data:[],meta:{complete:false,phase:'WAITING'},pendingReason:'READ_MODEL_NOT_READY'};});
  await f.changePeriod(range.startDate,range.endDate);
  assert.equal(removed,0);assert.equal(f.state.currentRows,old);assert.equal(f.node('#periodStoreList').attrs['data-state'],'not-ready');
  assert.match(f.node('#periodStoreList').innerHTML,/빈 결과가 아닙니다/);assert.equal(f.ready(),false);assert.equal(f.timers.size,1);
});
test('Period loading and error preserve map and retry only requests data',async()=>{
  const f=fixture();let reject;const old=[sample];f.state.currentRows=old;
  f.setFetch(()=>new Promise((_r,j)=>reject=j));const work=f.changePeriod(range.startDate,range.endDate);
  assert.equal(f.node('#periodStoreList').attrs['data-state'],'loading');reject(Error('synthetic'));await work;
  assert.equal(f.node('#periodStoreList').attrs['data-state'],'error');assert.equal(f.state.currentRows,old);assert.equal(f.ready(),false);
  assert.match(f.node('#periodStoreList').innerHTML,/조회 실패를 매장 0개로/);
  const urls=[];f.setFetch(async url=>{urls.push(url);return {data:[],meta:range};});
  await f.node('#periodStoreList').children.at(-1).onclick();
  assert.equal(urls.some(url=>url.includes('retry=')),false);
});
for (const [rows,expected] of [[[], 'empty'],[[sample],'ready']]) test('complete Period uses '+expected+' state',async()=>{
  const f=fixture();f.setFetch(async()=>({data:rows,meta:range}));await f.changePeriod(range.startDate,range.endDate);
  assert.equal(f.ready(),true);assert.equal(f.node('#periodStoreList').attrs['data-state'],expected);
});
test('cached Period becomes ready again after a failed different range',async()=>{
  const f=fixture();f.setReady();f.setRows([sample]);f.setFetch(async()=>{throw Error('synthetic');});
  await f.changePeriod('2026-08-02',range.endDate);await f.changePeriod(range.startDate,range.endDate);
  assert.equal(f.node('#periodStoreList').attrs['data-state'],'ready');
});
for (const [status,message] of [[503,/검색 서버 오류/],[0,/검색 요청 실패/],[200,/검색 결과 0건/]]) test('Period search failure category '+status+' keeps map',async()=>{
  const f=fixture();f.setReady();f.setRows([sample]);const old=[sample];f.state.currentRows=old;
  f.setFetch(async()=>{if(status!==200)throw Object.assign(Error('synthetic'),{status});return {data:[]};});
  await f.searchPeriod('존재하지않음');assert.match(f.node('#searchState').innerHTML,message);assert.equal(f.state.currentRows,old);
});
test('selection updates search row, pin, period list, popup and focused zoom',()=>{
  const f=fixture();f.setReady();f.setRows([sample]);f.state.currentRows=[sample];const pin=f.node('pin'),list=f.node('list'),a=f.node('resultA'),b=f.node('resultB');
  pin.dataset={customerCode:sample.customerCode,vehicle:'101'};list.dataset={periodStore:sample.customerCode};a.dataset={searchCode:sample.customerCode};b.dataset={searchCode:'other'};
  f.selectors.set('.marker',[pin]);f.selectors.set('[data-period-store]',[list]);f.selectors.set('[data-search-code]',[a,b]);
  f.state.map={level:10,getLevel(){return this.level;},getProjection:()=>({containerPointFromCoords:()=>({x:50,y:50})}),setLevel:v=>{f.state.map.level=v;},panTo:p=>{f.state.map.point=p;}};
  f.selectStore({...sample,lat:null,lng:null},null,true,true);
  assert.equal(a.attrs['aria-pressed'],'true');assert.equal(b.attrs['aria-pressed'],'false');assert.equal(list.attrs['aria-pressed'],'true');
  assert.equal(pin.classList.contains('selected'),true);assert.equal(f.node('#detailSection').classList.contains('open'),true);
  assert.match(f.node('#mapStatusSub').textContent,/좌표 미확인/);assert.equal(f.state.map.point,undefined);
  f.selectStore(sample,null,true,true);assert.equal(f.state.map.level,5);assert.equal(f.state.map.point.lat,sample.lat);
});
test('outside-period search adds a temporary pin without changing period membership',()=>{
  const f=fixture();f.setReady();f.state.currentRows=[sample];
  f.state.map={getLevel:()=>5,getProjection:()=>({containerPointFromCoords:()=>({x:50,y:50})}),setLevel(){},panTo(){}};
  f.selectStore({...sample,customerCode:'S900099',vehicle:'',outsideReason:'선택 기간 이력 없음'},null,true,true);
  assert.equal(f.state.currentRows.length,1);assert.equal(f.state.currentRows[0].customerCode,sample.customerCode);
  assert.ok(f.drawn.some(pin=>pin.dataset.customerCode==='S900099'));
  f.drawn.length=0;f.clearSelection();assert.equal(f.drawn.some(pin=>pin.dataset.customerCode==='S900099'),false);
});
test('daily status failure keeps map and cannot leak a late failure into Period',async()=>{
  const f=fixture();f.state.mode='DATE_ROUTE';f.state.selectedDate=range.endDate;const old=[sample];f.state.currentRows=old;
  f.setFetch(async()=>{throw Error('synthetic');});await f.loadOperationStatus('101',true);
  assert.equal(f.state.currentRows,old);assert.equal(f.state.mode,'DATE_ROUTE');
  let reject;f.setFetch(()=>new Promise((_r,j)=>reject=j));const pending=f.loadOperationStatus('101',true);
  f.state.mode='BASE_60D';f.node('#mapStatusSub').textContent='period retained';reject(Error('synthetic'));await pending;
  assert.equal(f.node('#mapStatusSub').textContent,'period retained');assert.equal(f.state.currentRows,old);
});
test('today-status failure does not discard a successful dated assignment',async()=>{
  const f=fixture();const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date());
  f.setFetch(async url=>{if(url.includes('/assignments'))return {data:[sample],meta:{complete:true,date:today}};throw Error('synthetic');});
  await f.changeSelectedDate(today);assert.equal(f.ready(),true);assert.equal(f.state.currentRows.length,1);assert.equal(f.state.currentRows[0].customerCode,sample.customerCode);
});
test('Data Health uses only observed API fields and marks stale/unknown',async()=>{
  const f=fixture();f.node('#operationsPanel').hidden=true;const paths=[];
  f.setFetch(async url=>{paths.push(url);return url.endsWith('/status')?{hubAuth:'READY',snapshot:{latest:range.endDate,stale:true}}:{phase:'WAITING',ready:false};});
  await f.showDiagnostics();const html=f.node('#operationsPanel').innerHTML;
  assert.match(html,/true · 최신 상태 아님/);assert.match(html,/준비 중/);assert.match(html,/확인 중/);
  assert.doesNotMatch(html,/Customer 최신일|Hub 최신일|Circuit|ETA|BUILD/);assert.equal(paths.length,2);
});
test('mobile keeps one reparented panel set; PC-only rules are media scoped',()=>{
  const css=file('map-period.css');assert.match(css,/@media\(min-width:761px\)\{\s*:root\{--left:clamp/);
  assert.match(runtime,/\$\("#mobileSheetContent"\)\.append\(panel\)/);assert.match(runtime,/anchor\.parentNode\.insertBefore\(panel, anchor\.nextSibling\)/);
  assert.match(css,/@media\(max-width:760px\)/);assert.equal((runtime.match(/filters\.id = "periodFilterPanel"/g)||[]).length,1);
});
test('legacy tools are retained and prototypes cannot pretend to save',()=>{
  for(const name of ['routeTool','endRoute','legacyVehicleState','todayStatusTool']) assert.ok((runtime+file('map-phase2b-preview.html')).includes(name));
  assert.match(file('vehicle-master-sync.html'),/id="saveBtn" disabled/);assert.doesNotMatch(file('vehicle-master-sync.html'),/저장 완료/);
  assert.match(file('daily-route-optimized-concepts.html'),/실제 도로 최적화\/ETA\/운영 저장 기능을 제공하지 않습니다/);
  assert.match(file('wms-ui-concept.html'),/자체 WMS 처리·저장 기능은 없습니다/);
});
