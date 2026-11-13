import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import '../public/opsmap/phase2b-ui-helpers.js';
import '../public/opsmap/map-view-policy.js';
import '../public/opsmap/map-period-ui.js';

const runtime = readFileSync(new URL('../public/opsmap/map-phase2b-runtime.js', import.meta.url), 'utf8');

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

test('level-six viewport preserves exact positions and does not retain an extra selection in the index', () => {
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
  assert.equal(pinAssignment(blank).label,'•');
  assert.equal(pinAssignment({...blank,baseVehicleEmptyVerified:true}).label,'?');
  assert.equal(pinAssignment({...blank,baseVehicleState:'UNKNOWN',baseVehicleVersion:'v'}).label,'•');
  assert.deepEqual(pinAssignment({...blank,baseVehicleState:'UNKNOWN'}),{code:'',label:'',kind:'unverified',loading:true});
  assert.equal(pinAssignment({...row,baseVehicleState:'CONFLICT'}).label,'•');
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
  assert.equal(pinAssignment(uncertain).label,'•');
  assert.deepEqual(uncertain.memberCodes,['S1','S2']);
});

test('initial map pins use counts for groups and retain the loading message outside the pin label', () => {
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
  assert.equal(label(store),'');
  assert.equal(store.dataset.pinAssignment,'loading');
  assert.match(store.attributes['aria-label'],/기준호차 조회 중/);
  const group = makeMarker({...pending,customerCode:'',clusterCount:9,
    clusterAssignment:{code:'',kind:'unverified',label:''}},null,'store');
  assert.equal(label(group),'9');
  assert.match(group.attributes['aria-label'],/9개 매장/);
  context.baseVehicleStatus='ERROR';
  const failed = makeMarker(pending,null,'store');
  assert.equal(label(failed),'•');
  assert.equal(failed.dataset.pinAssignment,'unverified');
  assert.match(failed.attributes['aria-label'],/기준호차 확인 필요/);
  assert.equal(label(makeMarker({...pending,baseVehicle:'156',baseVehicleState:'VERIFIED_MASTER'},null,'store')),'156');
  assert.equal(label(makeMarker({...pending,baseVehicle:'오산신규',baseVehicleState:'VERIFIED_MASTER'},null,'store')),'오산\n신규');
  assert.equal(label(makeMarker({...pending,baseVehicle:'오산보류',baseVehicleState:'VERIFIED_MASTER'},null,'store')),'오산\n보류');
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

test('overlapping overview pins stay separate while retaining both geographic anchors',()=>{
  const {visibleVehicleRepresentatives}=MapViewPolicy;
  const project=row=>({x:row.lng,y:row.lat});
  const rows=[{vehicle:'161',lat:195,lng:185},{vehicle:'157',lat:200,lng:190}];
  const visible=visibleVehicleRepresentatives(rows,project,{width:390,height:420},new Map());
  assert.strictEqual(visible[0],rows[0]);
  assert.equal(visible[1].lng,rows[1].lng);
  assert.equal(visible[1].lat,rows[1].lat);
  assert.ok(Math.abs(visible[1].lng+visible[1].representativeOffset.x-rows[0].lng)>=44||
    Math.abs(visible[1].lat+visible[1].representativeOffset.y-rows[0].lat)>=56);
});

const nearbyPoint = (code, route, meters, pixel) => ({
  customerCode: code, baseVehicle: route, lat: 37.5 + meters / 6371000 * 180 / Math.PI, lng: 127, pixel,
});
const projectNearby = row => ({x: row.pixel, y: 150});

test('different fixed routes merge only within 500m and one visible pin width', () => {
  const {overlappingVehicleLocations} = MapViewPolicy;
  const start = nearbyPoint('S1', '101', 0, 100);
  for(const meters of [499.999, 500, 500.001]) {
    const markers = overlappingVehicleLocations([start,nearbyPoint('S2','114',meters,139)],projectNearby);
    assert.equal(markers.length,meters<=500?1:2);
    if(meters<=500)assert.deepEqual(markers[0].clusterVehicles,['101','114']);
  }
  for(const other of [nearbyPoint('S2','114',300,141),nearbyPoint('S2','101',100,120),nearbyPoint('S2','오산신규',100,120)]) {
    assert.equal(overlappingVehicleLocations([start,other],projectNearby).length,2);
  }
  assert.equal(overlappingVehicleLocations([start,nearbyPoint('S2','척01',100,120)],projectNearby).length,1);
  assert.equal(overlappingVehicleLocations([start,nearbyPoint('S2','114',100,120)],projectNearby,'BASE_60D',['S2']).length,2);
});

test('nearby route clusters cannot expand through a chain and broader bins keep routes separate', () => {
  const {overlappingVehicleLocations,stableClusters} = MapViewPolicy;
  const rows = [nearbyPoint('S1','101',0,100),nearbyPoint('S2','114',400,110),nearbyPoint('S3','122',800,120),nearbyPoint('S4','114',1500,130)];
  const codes = markers => markers.flatMap(marker=>marker.memberCodes||[marker.customerCode]).sort();
  const mixed = markers => markers.filter(marker=>marker.clusterVehicles?.length>1);
  const close = overlappingVehicleLocations(rows,projectNearby);
  assert.deepEqual(mixed(close).map(marker=>marker.memberCodes),[['S1','S2']]);
  assert.deepEqual(codes(close),['S1','S2','S3','S4']);
  const viewport={width:390,height:844};
  const settings={nearbyVehicleOnly:true,sourceVersion:1};
  const project = row=>({x:100+(row.lat-37.5)*2000,y:150});
  const street=stableClusters(rows,project,6,'',viewport,settings);
  assert.deepEqual(mixed(street).map(marker=>marker.memberCodes),[['S1','S2']]);
  assert.deepEqual(codes(street),codes(close));
  const broad=stableClusters(rows,project,8,'',viewport,settings);
  assert.equal(mixed(broad).length,0);
  assert.deepEqual(codes(broad),codes(close));
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
