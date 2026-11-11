import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import express from 'express';
import { cellToLatLng, cellToParent, greatCircleDistance, gridDisk, latLngToCell, UNITS } from 'h3-js';
import { buildShadowCoverage } from '../scripts/build-shadow-coverage.mjs';
import { aggregateDay, cellDetail, combineDays, coverageList, coverageMembers, datesFor, detailedCell, detailedViewport, prepareCatalog, prepareView, searchCoverage } from '../src/shadowCoverage/model.js';
import { mountShadowCoverage } from '../src/shadowCoverage/routes.js';
import { createShadowCoverageStore } from '../src/shadowCoverage/store.js';
import { cellStatusCounts, createCoverageStatusReader } from '../src/shadowCoverage/storeStatus.js';
import { COMPLETED_DELIVERY_SOURCE } from '../src/shadowCoverage/freshonCompletedDeliveries.js';
import { buildFreshonStoreStatus, createFreshonStoreStatusIndex } from '../src/shadowCoverage/freshonStoreStatus.js';

const end = '2026-11-07';
const allDates = datesFor(end, 90);
const proof = 'a'.repeat(64);
const baseCell = latLngToCell(37.16, 127.1, 8);
const [blue, orange, gray, purple] = gridDisk(baseCell, 1);
const names = [
  ['T900001', '모의 한빛매장', blue, '경기도 오산시 모의로 1 한빛빌딩'],
  ['T900002', '모의 정원매장', orange, '경기도 오산시 모의동 15-3'],
  ['T900003', '모의 중앙매장', purple, '경기도 오산시 모의로 3']
];
const storeRows = names.map(([code, name, id, address]) => {
  const [lat, lng] = cellToLatLng(id);
  return { code, name, address, lat, lng, center: id === purple ? 'unknown' : 'osan', registered: true, matchHash: proof };
});
const source = {
  registryComplete: true, registryProofHash: proof, stores: storeRows,
  scopes: [blue, orange, gray].map(id => ({ id, center: 'all', label: '모의 오산', proofHash: proof })),
  regions: [{ name: '모의동', query: '모의동', bounds: [127, 37, 127.2, 37.3], location: cellToLatLng(blue) }]
};
const identity = value => crypto.createHash('sha256').update(value).digest('hex');
const event = (id, vehicle, addressHash = proof) => [identity(id), 'T900001', vehicle, 'osan', addressHash];

function raw(date, visits = [], completeCenters = ['osan', 'yeongnam', 'honam']) {
  return { date, proof: 'VERIFIED_COMPLETE_DAY', proofHash: proof, completeCenters, sourceRows: visits.length, unidentified: 0, visits };
}

function fixture(change) {
  const catalog = prepareCatalog(source);
  const stores = new Map(catalog.stores.map(store => [store.code, store]));
  const days = new Map(allDates.map((date, index) => {
    const visits = [8, 47, 85].includes(index) ? [event(date, index === 8 ? '101' : '122')] : [];
    return [date, aggregateDay(raw(date, visits), stores)];
  }));
  change?.(days, stores);
  return { catalog, stores, days };
}

test('fine cells map verified store locations without copying R8 visit totals or fabricating an empty-cell verdict', () => {
  const { catalog, days } = fixture();
  const view = prepareView(catalog, combineDays(end, 90, days), 'all', 8);
  const [lat,lng] = cellToLatLng(blue);
  for (const resolution of [9,10]) {
    const id = latLngToCell(lat,lng,resolution);
    const visible = detailedViewport(view,catalog,[lng-.04,lat-.04,lng+.04,lat+.04],resolution);
    assert.equal(new Set(visible.cells.map(cell=>cell.id)).size,visible.cells.length);
    assert.equal(visible.cells.find(cell=>cell.id===id).visits,null);
    const detail = detailedCell(view,catalog,id);
    assert.equal(detail.observedStores,1);
    assert.deepEqual(coverageMembers(view,catalog,id),['T900001']);
    const empty = detailedCell(view,catalog,latLngToCell(lat+.01,lng+.01,resolution));
    assert.equal(empty.status,'UNKNOWN');
    assert.equal(empty.stores.length,0);
  }
});

test('only completed deliveries activate the historical new cohort and partial coverage still proves positives', async () => {
  const {catalog} = fixture();
  const row = (code, vehicle, fixedObservations, lastOrder=null) => [code,{vehicle,currentKnown:true,fixedObservations,transitions:[],
    historyComplete:true,ordersComplete:lastOrder!==null,lastOrder}];
  const rows = new Map([
    row('T900001','오산신규',[{date:'2026-10-01',vehicle:'오산신규'}]),
    row('T900002','오산보류',[{date:'2026-10-02',vehicle:'오산보류'}],'2026-11-10'),
    row('T900003','122',[{date:'2026-10-10',vehicle:'오산신규'}])
  ]);
  const evidence = {
    metadata:{generation:proof,start:'2026-08-14',asOf:'2026-11-11',currentAsOf:'2026-11-11'},
    getStore:code=>rows.get(code),
    getDeliveryStatus(code, days) {
      const positive={state:'CONFIRMED_DELIVERY',complete:false,observedCompletedCount:1,lastCompletedOn:'2026-09-19'};
      if (code === 'T900002') return {delivery:positive,held:true,newActive:false};
      if (code === 'T900003' && days >= 60) return {delivery:positive,newActive:true};
      return {delivery:{state:'UNKNOWN'},newActive:null};
    }
  };
  const clock=()=>Date.parse('2026-11-11T00:00:00Z');
  const fixed = async () => ({data:[],meta:{checkedAt:'2026-11-11T00:00:00Z'}});
  const read = createCoverageStatusReader({readFixed:fixed,readEvidence:async()=>evidence,readSnapshot:async()=>({
    rows:[{customerCode:'T900001',lastDeliveryDate:'2026-11-09',status:'COMPLETED'},
      {customerCode:'T900003',lastDeliveryDate:'2026-11-09',status:'UNCONFIRMED'}]
  }),now:clock});
  const data=await read(catalog,proof);
  assert.deepEqual(data.counts,{NEW:1,HELD:1,pastNew:2,pastHeld:1,changedFromNew:1,changedFromHeld:0,rollingNew:2,rollingHeld:1,
    newUnknown:1,newZero:0,held:1,currentUnknown:0,historyUnknown:0});
  assert.deepEqual(cellStatusCounts(['T900001','T900002'],data),{NEW:0,HELD:1,pastNew:1,pastHeld:1,unknown:0,newUnknown:1,newZero:0,held:1});
  assert.equal(data.records.get('T900001').delivery.state,'UNKNOWN');
  assert.equal(data.records.get('T900001').newActive,null);
  assert.equal(data.records.get('T900001').lastDelivery,'2026-11-09');
  assert.equal(data.records.get('T900003').lastDelivery,null);
  assert.equal(data.records.get('T900002').newActive,null);
  assert.equal(data.records.get('T900002').current,'HELD');
  assert.equal((await read(catalog,proof,30)).counts.NEW,0);
  assert.equal((await read(catalog,proof,60)).counts.NEW,1);
  assert.equal((await read(catalog,proof,60)).records.get('T900003').newActive,true);
  assert.equal((await read(catalog,proof,60)).records.get('T900003').delivery.observedCompletedCount,1);
  assert.equal((await read(catalog,proof,60)).records.get('T900003').delivery.complete,false);
  assert.equal((await read(catalog,proof,90)).counts.NEW,1);
  assert.equal(data.records.get('T900003').history.length,0);
  assert.equal(data.records.get('T900003').observations.length,1);
  assert.equal((await read(catalog,'different-generation')).counts.pastNew,0);
  const missing = await createCoverageStatusReader({readFixed:fixed,now:clock})(catalog,proof);
  assert.equal(missing.counts.currentUnknown,3);
  assert.equal(missing.deliverySummary,null);
  const historyOnly = await createCoverageStatusReader({readFixed:fixed,
    readEvidence:async()=>({metadata:evidence.metadata,getStore:evidence.getStore}),now:clock})(catalog,proof);
  assert.equal(historyOnly.counts.NEW,0);
  assert.equal(historyOnly.counts.HELD,1);
  assert.equal(historyOnly.counts.pastNew,2);
  assert.equal(historyOnly.counts.newUnknown,2);
});

test('periods keep unique delivery counts and each confirmed vehicle for the same customer', () => {
  const { catalog, days } = fixture();
  assert.equal(datesFor(end, 90)[0], '2026-08-10');
  assert.equal(datesFor(end, 60)[0], '2026-09-09');
  assert.equal(datesFor(end, 30)[0], '2026-10-09');
  for (const [period, count] of [[30, 1], [60, 2], [90, 3]]) {
    const view = prepareView(catalog, combineDays(end, period, days), 'all', 8);
    const detail = cellDetail(view, blue);
    assert.equal(detail.visits, count);
    assert.equal(detail.registered, 1);
    assert.equal(detail.customers, 1);
    assert.equal(detail.deliveryDays, count);
    assert.deepEqual(detail.stores[0].vehicles, period === 90 ? ['101', '122'] : ['122']);
  }
});

test('observational candidates stay separate from verified empty cells and incomplete scope', () => {
  const { catalog, days } = fixture();
  let view = prepareView(catalog, combineDays(end, 90, days), 'all', 8);
  assert.deepEqual([blue, orange, gray, purple].map(id => cellDetail(view, id).status),
    ['DELIVERED', 'CANDIDATE', 'EMPTY', 'UNKNOWN']);
  assert.equal(prepareView(catalog, combineDays(end, 90, days), 'all', 7).summary.empty, 0);
  days.delete(allDates[0]);
  view = prepareView(catalog, combineDays(end, 90, days), 'all', 8);
  assert.equal(cellDetail(view, gray).status, 'UNKNOWN');
  const candidate = cellDetail(view, orange);
  assert.equal(candidate.status, 'CANDIDATE');
  assert.equal(candidate.deliveryDays, 0);
  assert.equal(candidate.evidence.recordedDays, 89);
  assert.deepEqual(candidate.evidence.missingDates, [allDates[0]]);
  assert.deepEqual(candidate.administrative, { district: '경기도 오산시', locality: '모의동' });
  assert.equal(candidate.nearby.nearest.id, blue);
  assert.equal(candidate.nearby.nearest.distanceMeters, Math.round(greatCircleDistance(cellToLatLng(orange), cellToLatLng(blue), UNITS.m)));
  assert.deepEqual(candidate.nearby.vehicles, ['101', '122']);
  assert.deepEqual(coverageList(view).rows.map(row => row.id), [orange]);
  assert.equal(cellDetail(view, blue).status, 'DELIVERED');
});

test('daily evidence is deduplicated across visits and centers and unmatched visits suppress candidates', () => {
  const { catalog, days, stores } = fixture();
  const date = allDates[85];
  const moved = [identity('moved-orange'), 'T900002', '102', 'osan', 'b'.repeat(64)];
  const extra = [identity('same-day-other-center'), 'T900001', '115', 'yeongnam', proof];
  days.set(date, aggregateDay(raw(date, [event(date, '122'), moved, extra], []), stores));
  days.delete(allDates[1]);
  const window = combineDays(end, 90, days);
  const view = prepareView(catalog, window, 'all', 8);
  assert.equal(cellDetail(view, orange).status, 'UNKNOWN');
  assert.equal(view.summary.unplacedVisits, 1);
  const detail = cellDetail(prepareView(catalog, window, 'all', 7), cellToParent(blue, 7));
  assert.equal(detail.visits, 4);
  assert.equal(detail.deliveryDays, 3);
  const legacy = { ...window, observedDates: undefined, unplacedCodes: undefined, rows: window.rows.map(row => row.slice(0, 7)) };
  const legacyView = prepareView(catalog, legacy, 'all', 8);
  assert.equal(cellDetail(legacyView, blue).deliveryDays, null);
  assert.equal(cellDetail(legacyView, orange).status, 'UNKNOWN');
  assert.equal(prepareView(catalog, window, 'honam', 8).summary.candidates, 0);
});

test('observed center scope and changed addresses cannot create false empty cells', () => {
  const { catalog, days, stores } = fixture((data, byCode) => {
    data.set(end, aggregateDay(raw(end, [event('moved', '103', 'b'.repeat(64))], ['osan']), byCode));
  });
  assert.throws(() => aggregateDay(raw(end, [event('same', '101'), event('same', '122')]), stores), /DELIVERY|IDENTITY/);
  const window = combineDays(end, 90, days);
  assert.equal(window.unplaced.osan, 1);
  assert.deepEqual(window.unverified.all, [end]);
  assert.deepEqual(window.unverified.osan, []);
  assert.equal(prepareView(catalog, window, 'all', 8).summary.empty, 0);
  assert.equal(prepareView(catalog, window, 'yeongnam', 8).summary.visits, 0);
});

test('local search covers customer codes, stored street/lot/building names and region bounds', () => {
  const { catalog, days } = fixture();
  const view = prepareView(catalog, combineDays(end, 90, days), 'all', 8);
  for (const query of ['T900001', '한빛매장', '모의로 1', '한빛빌딩']) {
    const row = searchCoverage(catalog, view, query, 'all', 500)[0];
    assert.equal(row.id, blue);
    assert.equal(row.stats.visits, 3);
    assert(row.stats.nearbyRegistered >= 1);
  }
  assert.equal(searchCoverage(catalog, view, '모의동 15-3', 'all')[0].id, orange);
  assert(searchCoverage(catalog, view, '모의동', 'all').some(row => row.kind === 'region' && row.bounds));
});

test('daily shards are reused, duplicate reads share cache and restart uses previous verified data', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opsmap-coverage-'));
  const out = path.join(directory, 'compiled'), observed = path.join(directory, 'observed-days');
  await fs.mkdir(observed);
  await fs.writeFile(path.join(directory, 'stores.private.json'), JSON.stringify(source));
  const writeDay = (date, visits) => fs.writeFile(path.join(observed, date + '.json'), JSON.stringify(raw(date, visits)));
  const writeSource = stamp => fs.writeFile(path.join(directory, 'source-import.safe.json'),
    JSON.stringify({ end, observedAt: stamp, sourceWrites: 0 }));
  for (const date of allDates) await writeDay(date, date === end ? [event('first', '101')] : []);
  await writeSource('2026-11-08T00:00:00Z');
  const build = () => buildShadowCoverage({ inputDirectory: directory, outputDirectory: out, kind: 'FIXTURE', includeOfficialRegions: false });
  const first = await build();
  assert.equal(first.rebuiltDays, 90);
  const noChange = await build();
  assert.equal(noChange.reusedDays, 90);
  assert.equal(noChange.index.sha256, first.index.sha256);
  await writeDay(end, [event('first', '101'), event('next', '122')]);
  await writeSource('2026-11-08T01:00:00Z');
  const second = await build();
  assert.equal(second.reusedDays, 89);
  assert.equal(second.rebuiltDays, 1);
  const store = createShadowCoverageStore({ directory: out, allowFixture: true, recheckMs: 0 });
  const batch = await Promise.all(Array.from({ length: 12 }, () => store.readPeriod(90)));
  assert(batch.every(data => data.window.completed === 2));
  assert.equal(store.metrics().reads, 2);
  for (const period of [30, 60, 90]) {
    const value = await store.readPeriod(period);
    for (const resolution of [4, 5, 6, 7, 8]) store.viewFor(value, 'all', resolution);
  }
  assert(store.metrics().blobs <= 4);
  assert(store.metrics().views <= 2);
  await fs.writeFile(path.join(out, second.index.windows[90].sha256 + '.json'), 'corrupt');
  const restarted = createShadowCoverageStore({ directory: out, allowFixture: true });
  const old = await restarted.readPeriod(90);
  assert.equal(old.index.sha256, first.index.sha256);
  assert.equal(old.window.completed, 1);
  assert.equal(old.stale, true);
  await assert.rejects(createShadowCoverageStore({ directory: out }).readPeriod(90), /UNAVAILABLE/);
});

test('an observed publish rejects loss of an overlapping observed day and an unobserved end date', async t => {
  const input = await fs.mkdtemp(path.join(os.tmpdir(), 'opsmap-coverage-continuity-'));
  t.after(() => fs.rm(input, {recursive:true,force:true}));
  const observed = path.join(input, 'observed-days');
  const output = path.join(input, 'compiled');
  await fs.mkdir(observed);
  await fs.writeFile(path.join(input, 'stores.private.json'), JSON.stringify(source));
  const oldDay = allDates.at(-2);
  const addDay = day => fs.writeFile(path.join(observed, day + '.json'), JSON.stringify(raw(day)));
  const importEvidence = (lastDay, count, stamp) => fs.writeFile(path.join(input, 'source-import.safe.json'), JSON.stringify({
    end:lastDay, days:count, completedUnique:0, observedAt:stamp, sourceWrites:0,
    sources:{current:{stable:true}, archive:{stable:true}}, stores:{union:storeRows.length}
  }));
  const build = () => buildShadowCoverage({inputDirectory:input,outputDirectory:output,includeOfficialRegions:false});
  await addDay(oldDay);
  await addDay(end);
  await importEvidence(end, 2, '2026-11-08T00:00:00Z');
  const first = await build();
  await fs.unlink(path.join(observed, oldDay + '.json'));
  await importEvidence(end, 1, '2026-11-08T01:00:00Z');
  await assert.rejects(build(), /COVERAGE_OBSERVED_DAY_REGRESSION/);
  await addDay(oldDay);
  const nextDay = '2026-11-08';
  await importEvidence(nextDay, 2, '2026-11-09T00:00:00Z');
  await assert.rejects(build(), /COVERAGE_END_DATE_UNCONFIRMED/);
  const old = await createShadowCoverageStore({directory:output}).readPeriod(90);
  assert.equal(old.index.sha256, first.index.sha256);
  await addDay(nextDay);
  await importEvidence(nextDay, 3, '2026-11-09T01:00:00Z');
  const next = await build();
  assert.equal(next.reusedDays, 2);
  assert.equal(next.rebuiltDays, 1);
  assert.equal((await createShadowCoverageStore({directory:output}).readPeriod(90)).index.asOf, nextDay);
});

test('runtime reads bounded compressed private files and rejects altered content', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opsmap-coverage-packed-'));
  try {
    const { catalog, days } = fixture();
    const window = combineDays(end, 90, days);
    async function pack(file, value) {
      const bytes = Buffer.from(JSON.stringify(value));
      await fs.writeFile(path.join(directory, 'opsmap-coverage-' + file + '.gz.b64'), gzipSync(bytes).toString('base64'));
      return bytes;
    }
    const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    async function blob(value) {
      const bytes = Buffer.from(JSON.stringify(value)), sha256 = sha(bytes);
      await pack(sha256 + '.json', value);
      return { sha256, bytes: bytes.length };
    }
    const catalogRef = await blob(catalog);
    const windows = {};
    for (const period of [30, 60, 90]) windows[period] = await blob(combineDays(end, period, days));
    const body = { schema: 1, asOf: end, sourceObservedAt: end, generatedAt: end, kind: 'OBSERVED', catalog: catalogRef, windows };
    await pack('coverage-index.json', { ...body, sha256: sha(JSON.stringify(body)) });
    const start = () => createShadowCoverageStore({ directory }).readPeriod(90);
    assert.equal((await start()).window.completed, window.completed);
    await pack(windows[90].sha256 + '.json', { ...window, completed: window.completed + 1 });
    await assert.rejects(start, /COVERAGE_DATA_UNAVAILABLE/);
  } finally {
    for (const file of await fs.readdir(directory)) await fs.unlink(path.join(directory, file));
    await fs.rmdir(directory);
  }
});

test('the analytic endpoints enforce the existing staff gate and reject unbounded input', async () => {
  const app = express();
  const { catalog, days } = fixture();
  let reads = 0;
  const reader = {
    async readPeriod(period) {
      reads++;
      return { catalog, window: combineDays(end, period, days), stale: false, index: {
        sha256: proof, kind: 'FIXTURE', sourceObservedAt: '2026-11-08T00:00:00Z', generatedAt: '2026-11-08T00:00:00Z'
      } };
    },
    viewFor: ({ catalog, window }, center, resolution) => prepareView(catalog, window, center, resolution)
  };
  const statusReads = [];
  const registry = new Map(catalog.stores.map(store=>[store.code,{...store,addressHash:proof,hasPoint:Boolean(store.cell)}]));
  const statusProjection = buildFreshonStoreStatus({generation:proof,registry,asOf:end,observedDeliveryDates:allDates,
    current:{date:end,rows:[{code:'T900001',vehicle:'오산신규'},{code:'T900002',vehicle:'오산보류'}]},
    fixed:['T900001','T900003'].map(code=>({code,date:end,vehicle:'오산신규'}))});
  statusProjection.completedDeliveryEvidence={source:COMPLETED_DELIVERY_SOURCE,completeDates:allDates.slice(-30),
    stores:[['T900001',[[allDates[45],1]]]]};
  const index = createFreshonStoreStatusIndex(statusProjection,registry,proof);
  const readStatus = createCoverageStatusReader({
    readEvidence: () => index,
    now: () => Date.parse(end + 'T00:00:00Z')
  });
  mountShadowCoverage({
    app, store: reader,
    readStatus: (catalog, generation, period) => {
      statusReads.push(period);
      return readStatus(catalog, generation, period);
    },
    requireStaff: (req, res, next) => req.get('x-test-staff') === 'yes' ? next() : res.status(401).end()
  });
  const server = await new Promise(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
  const url = 'http://127.0.0.1:' + server.address().port + '/api/map-phase2b/private/shadow-coverage';
  const options = { headers: { 'x-test-staff': 'yes' } };
  try {
    assert.equal((await fetch(url + '/view?box=126,36,128,38')).status, 401);
    assert.equal(reads, 0);
    for (const query of ['box=0,0,999,99', 'box=127,37,126,38', 'box=126,36,128,38&days=999']) {
      assert.equal((await fetch(url + '/view?' + query, options)).status, 400);
    }
    const response = await fetch(url + '/view?days=90&level=4&box=126,36,128,38', options);
    assert.match(response.headers.get('cache-control'), /private, no-store/);
    const { data } = await response.json();
    assert.equal(data.resolution, 8);
    assert.equal(data.storeStatus.NEW, 1);
    assert.equal(data.storeStatus.pastNew, 2);
    assert.equal(data.storeStatus.deliveryFilter.newUnknown, 1);
    assert.equal(data.storeStatus.deliveryFilter.complete, false);
    assert(data.cells.length <= 360);
    assert(data.cells.every(cell => cell.boundary.length >= 5));
    const outside = await (await fetch(url + '/view?days=90&level=4&box=130,38,131,39', options)).json();
    assert.equal(outside.data.cells.length, 0);
    assert.equal(outside.data.summary.total, data.summary.total);
    assert.equal(outside.data.viewportSummary.total, 0);
    assert.equal(data.summaryResolution, 8);
    const coarse = await (await fetch(url + '/view?days=90&level=11&box=126,36,128,38', options)).json();
    assert.deepEqual(coarse.data.summary, data.summary);
    for (const [days, visits] of [[30, 1], [60, 2], [90, 3]]) {
      const search = await (await fetch(url + '/search?days=' + days + '&radius=500',
        { headers: { ...options.headers, 'x-map-customer-query': 'T900001' } })).json();
      const row = search.data.results[0];
      assert.equal(search.data.days, days);
      assert.equal(row.stats.visits, visits);
      assert.equal(row.id, blue);
      assert(row.stats.registeredWithin[500] <= row.stats.registeredWithin[1000]);
      const point = await (await fetch(url + '/point?days=' + days,
        { headers: { ...options.headers, 'x-map-coverage-point': cellToLatLng(blue).map(v => v.toFixed(10)).join(',') } })).json();
      assert.equal(point.data.results[0].stats.visits, visits);
    }
    const invalidPoint = await fetch(url + '/point', { headers: { ...options.headers, 'x-map-coverage-point': '91,127' } });
    assert.equal(invalidPoint.status, 400);
    const list = await (await fetch(url + '/list?filter=delivery&days=30', options)).json();
    assert.deepEqual(list.data.rows.map(row => row.id), [blue]);
    const [lat,lng] = cellToLatLng(blue);
    const fineId = latLngToCell(lat,lng,9);
    const box = `${lng-.02},${lat-.02},${lng+.02},${lat+.02}`;
    const narrow = await (await fetch(url + `/view?days=30&level=4&box=${box}`, options)).json();
    assert(narrow.data.statusPins.some(pin => pin.id === fineId && pin.pastNew && pin.newActive === false && pin.state === null));
    assert.equal(narrow.data.storeStatus.deliveryFilter.newZero,2);
    const active = await (await fetch(url + `/view?days=60&level=4&box=${box}`, options)).json();
    assert(active.data.statusPins.some(pin => pin.id === fineId && pin.newActive));
    const cell = await (await fetch(url + `/cell?id=${latLngToCell(lat,lng,11)}&days=60`, options)).json();
    assert.equal(cell.data.stores[0].newActive,true);
    assert.deepEqual(cell.data.stores[0].delivery,{state:'CONFIRMED_DELIVERY',complete:false,observedCompletedCount:1,lastCompletedOn:allDates[45]});
    assert.equal(cell.data.deliveryFilter.newActive,1);
    assert.deepEqual(statusReads.slice(-3),[30,60,60]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
