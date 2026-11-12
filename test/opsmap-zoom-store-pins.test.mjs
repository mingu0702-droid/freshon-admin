import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
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
  assert.equal(pinAssignment({...row,baseVehicle:'보류'}).label,'오산보류');
  const blank={baseVehicle:'',vehicle:'202',baseVehicleState:'UNASSIGNED',baseVehicleSource:'FIXED_DISPATCH_PRIMARY'};
  assert.equal(pinAssignment(blank).label,'•');
  assert.equal(pinAssignment({...blank,baseVehicleEmptyVerified:true}).label,'?');
  assert.equal(pinAssignment({...blank,baseVehicleState:'UNKNOWN',baseVehicleVersion:'v'}).label,'•');
  assert.equal(pinAssignment({...blank,baseVehicleState:'UNKNOWN'}).label,'…');
  assert.equal(pinAssignment({...row,baseVehicleState:'CONFLICT'}).label,'•');
  assert.equal(MapPeriodUi.baseVehicleLabel(blank),'확인 필요');
  assert.equal(MapPeriodUi.baseVehicleLabel({...blank,baseVehicleEmptyVerified:true}),'미지정');
  assert.equal(MapPeriodUi.baseVehicleLabel({...row,baseVehicle:'보류'}),'오산보류');
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

test('a store with a verified empty delivery aggregate still uses its fixed route', () => {
  const [row]=MapPeriodUi.select([{customerCode:'S1',baseVehicle:'114',vehicle:'202',periodAggregate:{verified:true,groups:[]}}],['114'],'',{vehicleBasis:'base',includeUnvisited:true});
  assert.equal(row.vehicle,'114');
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
