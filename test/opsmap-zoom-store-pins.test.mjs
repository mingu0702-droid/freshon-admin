import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import '../public/opsmap/phase2b-ui-helpers.js';
import '../public/opsmap/map-view-policy.js';
import '../public/opsmap/map-period-ui.js';
import { addressMunicipality } from '../public/opsmap/vehicle-picker-regions.js';

const runtime = readFileSync(new URL('../public/opsmap/map-phase2b-runtime.js', import.meta.url), 'utf8');

test('a subset of selected base routes uses individual stores at any map level', () => {
  const code = runtime.slice(runtime.indexOf('  function showSelectedVehicleStores('), runtime.indexOf('  function primarySelectedVehicle('));
  const state = {mode:'BASE_60D', selectedVehicles:['101','172','182','208']};
  const scope = {state, periodBasis:'vehicle', allVehiclesSelected:false};
  const showStores = vm.runInNewContext(code + '\nshowSelectedVehicleStores', scope);
  assert.equal(showStores(), true);
  scope.allVehiclesSelected = true;
  assert.equal(showStores(), false);
  scope.allVehiclesSelected = false;
  state.mode = 'DATE_ROUTE';
  assert.equal(showStores(), false);
  state.mode = 'BASE_60D';
  state.selectedVehicles = [];
  assert.equal(showStores(), false);
});

test('the municipality used by the route filter excludes street, building and access details', () => {
  assert.equal(addressMunicipality('서울특별시 강남구 합성로 1 (건물)'), '강남구');
  assert.equal(addressMunicipality('경기 포천시 합성면 합성로 1'), '포천시');
  assert.equal(addressMunicipality('서울 강남구역빌딩 합성로 1'), '');
  assert.equal(addressMunicipality('강남구 합성로 1'), '');
});

test('detailed map keeps all visible stores and groups only exact co-locations', () => {
  const rows = Array.from({ length: 305 }, (_, i) => ({ customerCode: `S${i}`, lat: 37.5, lng: 127 + i / 10000 }));
  rows.push({ customerCode: 'S305', lat: rows[0].lat, lng: rows[0].lng });
  rows.push({ customerCode: 'S306', lat: 38.5, lng: 128 });
  const { stableClusters, storePinLevel } = globalThis.MapViewPolicy;
  const project = row => ({ x: (row.lng - 127) * 10000 + 100, y: 100 });
  const viewport = { width: 700, height: 500 };
  const markers = stableClusters(rows, project, storePinLevel, 'S0', viewport, {
    grouping: 'locations', protectedCodes: ['S305'], maxMarkers: 120
  });
  const codes = markers.flatMap(marker => marker.memberCodes || [marker.customerCode]);
  assert.equal(markers.length, 305);
  assert.equal(codes.length, 306);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(!codes.includes('S306'));
  assert.deepEqual(markers.find(marker => marker.clusterKind === 'location').memberCodes.sort(), ['S0', 'S305']);
});

test('close-up viewport preserves exact positions and does not retain an extra selection in the index', () => {
  const point = (customerCode, lat, lng, vehicle = '') => ({ customerCode, lat, lng, vehicle });
  const rows = [
    point('S00001', 37.5, 127, '104'), point('S00002', 37.5, 127, '108'),
    {...point('S00003', 37.5, 127),baseVehicleState:'UNASSIGNED',baseVehicleEmptyVerified:true,baseVehicleSource:'FIXED_DISPATCH_PRIMARY'},
    point('S00004', 37.5, 127.0000001, '117'),
    point('S00005', 37.51, 127.02, '127'), point('S00006', 37.5, 127.05),
    point('S00007', null, null),
  ];
  const extra = point('S00008', 37.5, 127, '117');
  const pointIndex = MapPeriodUi.spatialIndex(rows);
  const coordinate = (lat, lng) => ({ getLat: () => lat, getLng: () => lng });
  const viewport = { width: 390, height: 600 };
  const map = { getBounds: () => ({ getSouthWest: () => coordinate(37.5, 127), getNorthEast: () => coordinate(37.51, 127.02) }) };
  const start = runtime.indexOf('  function detailedMarkerRows(');
  const end = runtime.indexOf('  function refreshMarkerSelection(', start);
  assert(start >= 0 && end > start);
  const detailedMarkerRows = vm.runInNewContext(runtime.slice(start, end) + '\ndetailedMarkerRows', {
    pointIndex, state: { map }, MapPeriodUi, window: { MapViewPolicy },
  });
  const codes = markers => Array.from(markers.flatMap(marker => marker.memberCodes || [marker.customerCode])).sort();
  const first = detailedMarkerRows(viewport);
  assert.equal(first.length, 3);
  assert.deepEqual(codes(first), ['S00001', 'S00002', 'S00003', 'S00004', 'S00005']);
  const colocated = first.find(marker => marker.clusterKind === 'location');
  assert.equal(colocated.lat, rows[0].lat);
  assert.equal(colocated.lng, rows[0].lng);
  assert.deepEqual(colocated.clusterVehicles, ['104', '108']);
  assert.equal(colocated.clusterUnassigned, true);
  assert(first.includes(rows[3]));
  const selected = detailedMarkerRows(viewport, extra);
  assert.deepEqual(codes(selected), ['S00001', 'S00002', 'S00003', 'S00004', 'S00005', 'S00008']);
  assert.strictEqual(detailedMarkerRows(viewport)[0], first[0]);
  assert.deepEqual(codes(detailedMarkerRows(viewport)), codes(first));
});

test('pins distinguish the primary fixed route, confirmed blank, and missing evidence', () => {
  const {pinAssignment,exactLocations}=MapViewPolicy;
  const row={vehicle:'202',baseVehicle:' １１４ 호차 ',baseVehicleState:'VERIFIED_MASTER'};
  assert.deepEqual(pinAssignment(row),{code:'114',label:'114',kind:'vehicle'});
  assert.equal(pinAssignment(row,'DATE_ROUTE').label,'202');
  assert.equal(pinAssignment({...row,baseVehicle:'오산 신규'}).label,'오산신규');
  assert.deepEqual(pinAssignment({...row,baseVehicle:'호남신규'}),{code:'호남신규',label:'호남신규',kind:'new'});
  assert.equal(pinAssignment({...row,baseVehicle:'척01'}).label,'척01');
  assert.equal(pinAssignment({...row,baseVehicle:'용09'}).label,'용09');
  assert.equal(pinAssignment({...row,baseVehicle:'보류'}).label,'오산보류');
  const blank={baseVehicle:'',vehicle:'202',baseVehicleState:'UNASSIGNED',baseVehicleSource:'FIXED_DISPATCH_PRIMARY'};
  assert.equal(pinAssignment(blank).label,'미확인');
  assert.equal(pinAssignment({...blank,baseVehicleEmptyVerified:true}).label,'?');
  assert.equal(pinAssignment({...blank,baseVehicleState:'UNKNOWN',baseVehicleVersion:'v'}).label,'미확인');
  assert.deepEqual(pinAssignment({...blank,baseVehicleState:'UNKNOWN'}),{code:'',label:'미확인',kind:'unverified',loading:true});
  assert.equal(pinAssignment({...row,baseVehicleState:'CONFLICT'}).label,'충돌');
  assert.equal(pinAssignment({...row,baseVehicleState:'NOT_IN_MASTER'}).label,'미등록');
  for(const value of ['.','·','•','?','','미배정','비활성','unknown']){
    assert.equal(pinAssignment({...row,baseVehicle:value}).code,'');
    assert.equal(pinAssignment({vehicle:value},'DATE_ROUTE').label,'미확인');
  }
  assert.equal(MapPeriodUi.baseVehicleLabel(blank),'확인 필요');
  assert.equal(MapPeriodUi.baseVehicleLabel({...blank,baseVehicleEmptyVerified:true}),'미지정');
  assert.equal(MapPeriodUi.baseVehicleLabel({...row,baseVehicle:'보류'}),'오산보류');
  assert.equal(MapPeriodUi.baseVehicleLabel({baseVehicleState:'NOT_IN_MASTER'}),'고정배차표에 없음');
  assert.equal(MapPeriodUi.baseVehicleLabel({baseVehicleState:'NOT_IN_MASTER',baseVehicleStale:true}),'기준호차 확인 필요');
  const same=(code,assignment)=>({customerCode:code,lat:37.5,lng:127,...assignment});
  const [group]=exactLocations([same('S1',{...row,baseVehicle:'보류'}),same('S2',{...row,baseVehicle:'오산보류'})]);
  assert.equal(pinAssignment(group).label,'오산보류');
  const [pair]=exactLocations([same('S1',{...row,baseVehicle:'101'}),same('S2',row)]);
  assert.equal(pinAssignment(pair).label,'101·114');
  assert.deepEqual(pair.clusterVehicles,['101','114']);
  const [uncertain]=exactLocations([same('S1',blank),same('S2',{...blank,baseVehicleEmptyVerified:true})]);
  assert.equal(pinAssignment(uncertain).label,'미확인');
  assert.deepEqual(uncertain.memberCodes,['S1','S2']);
  const [oneRoute]=exactLocations([same('S1',row),same('S2',{...row,baseVehicleState:'NOT_IN_MASTER'})]);
  assert.equal(pinAssignment(oneRoute).label,'114');
  assert.equal(oneRoute.clusterUnverified,true);
});

const pointChecks = runtime.slice(runtime.indexOf('  function hasMapCoordinates('), runtime.indexOf('  function staffRegistrationScope('));
const verifiedPoint = {
  coordinateStatus:'CONFIRMED', coordinateSource:'VERIFIED_STORE_POINT', coordinateEvidence:'STAGE_REGISTRY_POINT',
  originalAddressHash:'a'.repeat(64),
};

test('verified Stage store locations survive a missing fixed route without changing route membership', () => {
  const start = runtime.indexOf('  function buildMapPinIndex(');
  const end = runtime.indexOf('  function renderStops(', start);
  assert(start >= 0 && end > start);
  let verifiedStage = false;
  const coordinateByCode = new Map();
  const build = vm.runInNewContext(pointChecks + runtime.slice(start, end) + '\nbuildMapPinIndex',
    { MapPeriodUi, coordinateByCode, hasVerifiedStageLocations:()=>verifiedStage });
  const rows = [
    { customerCode:'S10001', lat:37.5, lng:127, baseVehicle:'101', baseVehicleState:'VERIFIED_MASTER' },
    { customerCode:'S10002', lat:37.5, lng:127, vehicle:'202', baseVehicleState:'NOT_IN_MASTER', ...verifiedPoint },
    { customerCode:'S10003', lat:37.6, lng:127.1, baseVehicle:'오산신규', baseVehicleState:'VERIFIED_MASTER' },
    { customerCode:'S10004', lat:37.7, lng:127.2, baseVehicle:'오산보류', baseVehicleState:'VERIFIED_MASTER' },
    { customerCode:'S10005', lat:37.8, lng:127.3, baseVehicleState:'UNASSIGNED' },
    { customerCode:'S10006', lat:37.8, lng:127.3, baseVehicleState:'NOT_IN_MASTER' },
    { customerCode:'S10007', lat:37.8, lng:127.3, baseVehicleState:'NOT_IN_MASTER', staffRegistrationOnly:true, ...verifiedPoint },
    { customerCode:'S10008', lat:37.8, lng:127.3, baseVehicleState:'NOT_IN_MASTER', ...verifiedPoint, currentAddressHash:'b'.repeat(64) },
    { customerCode:'S10009', lat:37.9, lng:127.4, baseVehicleState:'NOT_IN_MASTER', ...verifiedPoint, coordinateEvidence:undefined },
    { customerCode:'S10010', lat:37.8, lng:127.4, baseVehicleState:'NOT_IN_MASTER', ...verifiedPoint, coordinateEvidence:undefined },
  ];
  coordinateByCode.set('S10009',{...rows[8]});
  coordinateByCode.set('S10010',{...rows[9],lat:37.5});
  const base = build(rows, 'BASE_60D');
  assert.deepEqual(base.valid, [rows[0], rows[2], rows[3], rows[4]]);
  assert(!MapViewPolicy.exactLocations(base.valid).some(pin => pin.clusterRows?.includes(rows[1])));
  verifiedStage = true;
  const published = build(rows, 'BASE_60D');
  assert.deepEqual(published.valid, [...rows.slice(0,5), rows[8]]);
  const [group] = MapViewPolicy.exactLocations(published.valid);
  assert.deepEqual(group.memberCodes, ['S10001','S10002']);
  assert.deepEqual(group.clusterVehicles, ['101']);
  assert.equal(MapViewPolicy.pinAssignment(rows[1]).code, '');
  assert.equal(MapPeriodUi.select(rows, ['202'], '', {vehicleBasis:'base',includeUnvisited:true}).length, 0);
  assert.equal(build(rows, 'DATE_ROUTE').byCode.get('S10002'), rows[1]);
  assert.equal(rows.length, 10);
});

test('Stage counts bound verified points independently of populated coordinates', () => {
  const start = runtime.indexOf('  function staffRegistrationScope(');
  const end = runtime.indexOf('  function filteredPeriodStores(', start);
  const state = {mode:'BASE_60D'};
  const rows = [
    {lat:37.5,lng:127,center:'osan', ...verifiedPoint},
    {lat:37.5,lng:128,center:'osan'},
    {lat:37.6,lng:127,center:'osan', ...verifiedPoint, coordinateSource:'KAKAO_ADDRESS_LIVE'},
    {lat:null,lng:null,center:'yeongnam'},
  ];
  const count = vm.runInNewContext(pointChecks + runtime.slice(start,end) + '\nstaffRegistrationScope', {
    registrationCounts:null, searchNeighborhood:null, coordinateByCode:new Map(), allStores:rows, state, dateReady:true,
    registrationCenter:row=>row.center,
    hasVerifiedStageLocations:()=>true, stageRegistrationOnly:()=>true,
  });
  assert.deepEqual({...count()}, {registered:4,coordinates:3,located:1,source:'AVAILABLE'});
  state.centerFilter = 'yeongnam';
  assert.deepEqual({...count()}, {registered:1,coordinates:0,located:0,source:'REGISTERED'});
});

test('loading and unknown pins use readable labels while grouping keeps the store count', () => {
  class Element {
    dataset = {};
    children = [];
    classList = { add() {} };
    style = { setProperty() {} };
    textContent = '';
    attributes = {};
    setAttribute(name, value) { this.attributes[name] = value; }
    append(child) { this.children.push(child); }
  }
  const start = runtime.indexOf('  function markerElement(');
  const end = runtime.indexOf('  function representativeRows(', start);
  const state = { mode:'BASE_60D' };
  const context = {
    window:{ MapViewPolicy }, document:{ createElement:()=>new Element(), body:{ classList:{ contains:()=>true } } },
    state, periodBasis:'vehicle', baseVehicleStatus:'LOADING', vehicleLabel:value=>value+'호', vehicleColor:()=>'',
    markerIsSelected:()=>false, bindMapMarkerSelection:()=>{}
  };
  const makeMarker = vm.runInNewContext(runtime.slice(start,end)+'\nmarkerElement',context);
  const pending = { customerCode:'S10001', customerName:'매장', baseVehicleState:'UNKNOWN' };
  const label = marker=>marker.children[0].children[0].textContent;
  const store = makeMarker(pending,null,'store');
  assert.equal(label(store),'조회 중');
  assert.equal(store.dataset.pinAssignment,'loading');
  assert.match(store.attributes['aria-label'],/기준호차 조회 중/);
  const group = makeMarker({...pending,customerCode:'',clusterCount:9,
    clusterAssignment:{code:'',kind:'unverified',label:'미확인'}},null,'store');
  assert.equal(label(group),'미확인');
  assert.match(group.attributes['aria-label'],/9개 매장/);
  context.baseVehicleStatus='ERROR';
  const failed = makeMarker(pending,null,'store');
  assert.equal(label(failed),'미확인');
  assert.equal(failed.dataset.pinAssignment,'unverified');
  assert.match(failed.attributes['aria-label'],/기준호차 확인 필요/);
  const searchSelection = {...pending, vehicle:'202', baseVehicleState:'NOT_IN_MASTER'};
  assert.equal(label(makeMarker(searchSelection,null,'store')),'매장');
  assert.match(makeMarker(searchSelection,null,'store').attributes['aria-label'],/고정배차표에 없음/);
  const unassignedGroup = {...searchSelection, customerCode:'', clusterCount:3, clusterAssignment:MapViewPolicy.pinAssignment(searchSelection)};
  assert.equal(label(makeMarker(unassignedGroup,null,'store')),'매장');
  state.mode='DATE_ROUTE';
  assert.equal(label(makeMarker(searchSelection,null,'store')),'202');
  state.mode='BASE_60D';
  assert.equal(label(makeMarker({...pending,baseVehicle:'156',baseVehicleState:'VERIFIED_MASTER'},null,'store')),'156');
  assert.equal(label(makeMarker({...pending,baseVehicle:'오산신규',baseVehicleState:'VERIFIED_MASTER'},null,'store')),'오산\n신규');
  assert.equal(label(makeMarker({...pending,baseVehicle:'오산보류',baseVehicleState:'VERIFIED_MASTER'},null,'store')),'오산\n보류');
});

test('store search retains verified fixed-route evidence and clears outdated empty-route evidence',()=>{
  const code='S10001';
  const verified={customerCode:code,baseVehicle:'114',baseVehicleGroup:'osan',baseVehicleState:'VERIFIED_MASTER',
    baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:'a'.repeat(64),baseVehicleCheckedAt:'2026-11-12T00:00:00Z',weekdays:{Mon:'114'}};
  const snapshot={...verified,baseVehicle:'',baseVehicleState:'UNASSIGNED',baseVehicleEmptyVerified:true};
  const baseVehicles=new Map(), coordinateByCode=new Map([[code,verified]]), storesByCode=new Map();
  const fixed=runtime.slice(runtime.indexOf('  function fixedVehicleFor('),runtime.indexOf('  function replaceStoreSnapshot('));
  const search=runtime.slice(runtime.indexOf('  function normalizeApiStore('),runtime.indexOf('  function closeUnifiedSearchResults('));
  const normalize=vm.runInNewContext(fixed+search+'\nnormalizeApiStore',{
    state:{mode:'BASE_60D'},periodBasis:'vehicle',baseVehicles,coordinateByCode,storesByCode,storeByVehicleAndCode:new Map(),MapPeriodUi,
    normalizeVehicle:String,numberOrNull:value=>value??null
  });
  const hit={customerCode:code,vehicle:'202',baseVehicle:'999',baseVehicleEmptyVerified:true};
  const stored=normalize(hit);
  assert.equal(MapViewPolicy.pinAssignment(stored).label,'114');
  assert.equal(stored.vehicle,'114');
  assert.equal(stored.baseVehicleStale,true);
  assert.equal(stored.weekdays.Mon,'114');
  assert.equal(stored.baseVehicleEmptyVerified,false);
  coordinateByCode.set(code,snapshot);
  assert.equal(MapViewPolicy.pinAssignment(normalize(hit)).label,'?');
  baseVehicles.set(code,{...snapshot,baseVehicleEmptyVerified:undefined,baseVehicleVersion:'b'.repeat(64),baseVehicleCheckedAt:'2026-11-13T00:00:00Z'});
  assert.equal(MapViewPolicy.pinAssignment(normalize(hit)).label,'미확인');
  baseVehicles.clear();coordinateByCode.clear();
  const unverified=normalize(hit);
  assert.equal(unverified.vehicle,'');
  assert.equal(unverified.baseVehicleEmptyVerified,false);
  assert.equal(MapViewPolicy.pinAssignment(unverified).loading,true);
});

test('nearby vehicle badges avoid existing pins and each other, with overflow left in the existing list', () => {
  const {placeOverlayLabels}=MapViewPolicy;
  const bounds={left:0,top:0,right:390,bottom:420};
  const badges=[125,163].map(id=>({id,left:170,top:140,width:42,height:24}));
  const temporary={left:162,top:135,right:221,bottom:187};
  const [one,two]=placeOverlayLabels(badges,bounds,[temporary]);
  assert.deepEqual([one.id,two.id],[125,163]);
  assert.ok(!one.hidden&&!two.hidden);
  const rect=({x,y})=>({left:170+x,top:140+y,right:212+x,bottom:164+y});
  const noOverlap=(a,b)=>a.left>=b.right||a.right<=b.left||a.top>=b.bottom||a.bottom<=b.top;
  assert.ok(noOverlap(rect(one),temporary)&&noOverlap(rect(two),temporary)&&noOverlap(rect(one),rect(two)));
  assert.deepEqual(placeOverlayLabels(badges,bounds,[bounds]),[{id:125,hidden:true},{id:163,hidden:true}]);
  assert.deepEqual(placeOverlayLabels([{...badges[0],left:500}],bounds,[]),[]);
});

test('a store with a verified empty delivery aggregate still uses its fixed route', () => {
  const [row]=MapPeriodUi.select([{customerCode:'S1',baseVehicle:'114',vehicle:'202',periodAggregate:{verified:true,groups:[]}}],['114'],'',{vehicleBasis:'base',includeUnvisited:true});
  assert.equal(row.vehicle,'114');
});

test('overview keeps a route visible when its average falls outside the viewport',()=>{
  const {visibleVehicleRepresentatives}=MapViewPolicy;
  const at=(lat,lng)=>({lat,lng});
  const visible=at(40,80),far=at(600,700);
  const overview=[{vehicle:'157',lat:300,lng:600,clusterRows:[visible,far]},{vehicle:'202',...far,clusterRows:[far]}];
  const view={width:390,height:460};
  const project=row=>({x:row.lng,y:row.lat});
  const markers=visibleVehicleRepresentatives(overview,project,view,new Map([['157',[visible]]]));
  assert.equal(markers.length,1);
  assert.deepEqual([markers[0].vehicle,markers[0].lat,markers[0].lng],['157',40,80]);
  assert.strictEqual(markers[0].clusterRows,overview[0].clusterRows);
  assert.equal(overview[0].lng,600);
});

test('overview pixel groups contain every visible route once and open up on zoom',()=>{
  const {visibleVehicleRepresentatives,groupOverviewVehiclePins}=MapViewPolicy;
  const project=row=>({x:row.lng,y:row.lat});
  const view={width:390,height:420};
  const rows=[{vehicle:'161',lat:195,lng:185},{vehicle:'157',lat:200,lng:190},
    {vehicle:'125',lat:201,lng:251},{vehicle:'122',lat:3,lng:2},{vehicle:'202',lat:30,lng:-140}];
  const visible=visibleVehicleRepresentatives(rows,project,view);
  const markers=groupOverviewVehiclePins(visible,project,view);
  const bundle=markers.find(marker=>marker.overviewRoutes);
  assert.deepEqual(bundle.overviewRoutes,[rows[0],rows[1]]);
  assert.deepEqual(markers.flatMap(marker=>(marker.overviewRoutes||[marker]).map(r=>r.vehicle)).sort(),['122','125','157','161']);
  assert.deepEqual([bundle.lat,bundle.lng],[rows[0].lat,rows[0].lng]);
  assert.strictEqual(markers.find(marker=>marker.vehicle==='125'),rows[2]);
  assert.deepEqual(markers.find(marker=>marker.vehicle==='122').representativeOffset,{x:30,y:57});
  const zoomed=groupOverviewVehiclePins(visible, row=>({x:80+row.lng*14,y:200}),{width:3800,height:420});
  assert.equal(zoomed.length,visible.length);
  assert.ok(zoomed.every(marker=>!marker.overviewRoutes));
});

const nearbyPoint = (code, route, meters, pixel) => ({
  customerCode: code, baseVehicle: route, lat: 37.5 + meters / 6371000 * 180 / Math.PI, lng: 127, pixel,
});
const projectNearby = row => ({x: row.pixel??100+(row.lat-37.5)*2000, y: 150});

test('levels five and four split nearby distinct coordinates and keep exact co-locations selectable', () => {
  const {stableClusters, zoomBand} = MapViewPolicy;
  const viewport={width:390,height:844}, settings={nearbyVehicleOnly:true,maxMarkers:40,sourceVersion:1};
  const rows=[nearbyPoint('S1','101',0,100),nearbyPoint('S2','114',0,100),
    nearbyPoint('S3','114',70,101),nearbyPoint('S4','114',71,102),
    nearbyPoint('S5','122',499.999,137),nearbyPoint('S6','124',500.001,138)];
  const codes = markers => markers.flatMap(marker=>marker.memberCodes||[marker.customerCode]).sort();
  assert.deepEqual([10,9,7,6,5,4].map(zoomBand),[3,2,2,1,0,0]);
  for(const level of [7,6,5,4]){
    const markers=stableClusters(rows,projectNearby,level,'S1',viewport,settings);
    assert.deepEqual(codes(markers),codes(rows));
    if(level>5){
      assert.ok(markers.some(row=>row.clusterKind==='vehicle'));
      continue;
    }
    const clusters=markers.filter(row=>row.clusterCount);
    assert.equal(clusters.length,1);
    assert.equal(clusters[0].clusterKind,'location');
    assert.deepEqual(clusters[0].memberCodes,['S1','S2']);
    assert.ok(markers.includes(rows[4])&&markers.includes(rows[5]));
  }
});

test('the searched neighborhood separates the 500m reference list from the visible verified registration pins', () => {
  const center={lat:37.5,lng:127};
  const saved=(code,route,meters,patch)=>({...nearbyPoint(code,route,meters,100),...verifiedPoint,...patch});
  const base=saved('S10001','101',0), colocated=saved('S10002','114',0), inside=saved('S10003','114',499.9);
  const allStores=[base,colocated,inside,saved('S10004','114',500.1),saved('S10005','114',3,{coordinateStatus:'UNVERIFIED'}),
    saved('S10006','114',5,{staffRegistrationOnly:true}),saved('S10007','114',6,{customerRegistryStatus:'DELETED'}),
    saved('S10008','114',7,{currentAddressHash:'b'.repeat(64)}),saved('S10009','114',5000),
    saved('S10010','114',8,{staffRegistrationOnly:true,coordinateStatus:'UNVERIFIED'})];
  const pointIndex=MapPeriodUi.spatialIndex([base]);
  const coord=(lat,lng)=>({getLat:()=>lat,getLng:()=>lng});
  const state={selectedVehicles:[],map:{getBounds:()=>({getSouthWest:()=>coord(37.49,126.99),getNorthEast:()=>coord(37.51,127.01)})}};
  const start=runtime.indexOf('  function nearbyVerifiedStores('),end=runtime.indexOf('  function overviewVehicleStores(',start);
  const {registeredAreaIndex,nearbyVerifiedStores,detailedMarkerRows}=vm.runInNewContext(
    pointChecks+runtime.slice(start,end)+'\n({registeredAreaIndex,nearbyVerifiedStores,detailedMarkerRows})',{
      allStores,searchNeighborhood:null,areaViewportIndex:null,pointIndex,state,Phase2bUi,MapPeriodUi,window:{MapViewPolicy},
      hasVerifiedStageLocations:()=>true,baseVehicleKey:String,optionalNewVehicles:new Set(),mapShowsNewVehicle:()=>true
    });
  const areaIndex=registeredAreaIndex();
  assert.ok(areaIndex.valid.some(row=>row.customerCode==='S10009'));
  const stores=nearbyVerifiedStores(center,areaIndex);
  assert.deepEqual(Array.from(stores,row=>row.customerCode).sort(),['S10001','S10002','S10003','S10006']);
  const pins=detailedMarkerRows({width:390,height:600},null,'BASE_60D',areaIndex,true);
  assert.deepEqual(Array.from(pins.flatMap(pin=>pin.memberCodes||[pin.customerCode])).sort(),
    ['S10001','S10002','S10003','S10004','S10006']);
  assert.deepEqual(pointIndex.valid,[base]);
  const colocatedPin=pins.find(pin=>pin.memberCodes?.includes('S10001'));
  assert.equal(colocatedPin.clusterKind,'location');
  assert.deepEqual(Array.from(colocatedPin.memberCodes),['S10001','S10002']);
});

test('pin reconciliation reuses unchanged overlays across viewport and selection changes', () => {
  const { reconcile } = MapPeriodUi;
  const start = runtime.indexOf('  const markerPositions=');
  const end = runtime.indexOf('  function renderStops(', start);
  assert(start >= 0 && end > start);
  const update = vm.runInNewContext(runtime.slice(start, end) + '\nrefreshMarkerSelection');
  const create = ({ key, zIndex }) => {
    const classes = new Set();
    const classList = { contains: name => classes.has(name), toggle: (name, active) => active ? classes.add(name) : classes.delete(name) };
    return { key, zIndex, zChanges: 0, getContent: () => ({ classList }), getZIndex() { return this.zIndex; },
      setZIndex(value) { this.zIndex = value; this.zChanges++; } };
  };
  const entry = (key, fingerprint, selected = false) => ({ key, fingerprint, selected, assigned: false, zIndex: selected ? 40 : 5 });
  const removed = [];
  const remove = value => removed.push(value);
  const first = reconcile(new Map(), [entry('stays', 'same location'), entry('leaves', 'old location')], create, remove);
  const overlay = first.next.get('stays').value;
  const selected = [entry('stays', 'same location', true), entry('enters', 'new location')];
  // The selection controller updates the button class before rendering.
  overlay.getContent().classList.toggle('selected', true);
  const next = reconcile(first.next, selected, create, remove, update);
  assert.deepEqual([next.created, next.removed, next.reused], [1, 1, 1]);
  assert.strictEqual(next.next.get('stays').value, overlay);
  assert.equal(overlay.getZIndex(), 40);
  const idle = reconcile(next.next, selected, create, remove, update);
  assert.equal(overlay.zChanges, 1);
  overlay.getContent().classList.toggle('selected', false);
  reconcile(idle.next, [entry('stays', 'same location'), selected[1]], create, remove, update);
  assert.equal(overlay.getZIndex(), 5);
  assert.deepEqual(removed, [first.next.get('leaves').value]);
});

test('a line label stays on the visible part of a segment when its midpoint leaves the map', () => {
  const { lineLabelPoint } = globalThis.MapViewPolicy;
  const box = { left: 20, right: 200, top: 40, bottom: 100 };
  assert.deepEqual(lineLabelPoint({x:50,y:70},{x:550,y:70},box),{x:125,y:70});
  assert.equal(lineLabelPoint({x:50,y:120},{x:550,y:120},box),null);
});
