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
import { aggregateDay, cellDetail, combineDays, coverageList, datesFor, prepareCatalog, prepareView, searchCoverage, viewportCandidates, viewportCells } from '../src/shadowCoverage/model.js';
import { mountShadowCoverage } from '../src/shadowCoverage/routes.js';
import { createShadowCoverageStore } from '../src/shadowCoverage/store.js';

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

test('zoomed-out delivery polygons do not hide or double count R8 candidates', () => {
  const { days } = fixture();
  const candidateId = gridDisk(blue, 1).find(id => id !== blue && cellToParent(id, 4) === cellToParent(blue, 4));
  assert(candidateId);
  const [lat, lng] = cellToLatLng(candidateId);
  const catalog = prepareCatalog({ ...source, scopes: [], stores: [storeRows[0], { ...storeRows[1], lat, lng }] });
  const window = combineDays(end, 90, days);
  const base = prepareView(catalog, window, 'all', 8);
  const bounds = [126, 36, 128, 38];
  assert.equal(base.summary.candidates, 1);
  const coarse = viewportCells(prepareView(catalog, window, 'all', 4), bounds);
  assert.equal(coarse.summary.delivered, 1);
  assert.equal(coarse.summary.candidates, 0);
  for (const res of [4, 5, 6, 7]) {
    assert.deepEqual(viewportCandidates(base, bounds, res),
      { cells: 1, stores: 1, groups: 1, markers: [{ id: candidateId, location: [lat, lng], cells: 1 }] });
  }
  assert.deepEqual(viewportCandidates(base, bounds, 8), { cells: 1, stores: 1, groups: 0, markers: [] });
  assert.deepEqual(viewportCandidates(base, [130, 38, 131, 39], 4),
    { cells: 0, stores: 0, groups: 0, markers: [] });
  assert.equal(viewportCandidates(prepareView(catalog, window, 'honam', 8), bounds, 4).cells, 0);
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
  mountShadowCoverage({
    app, store: reader,
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
    assert(data.cells.length <= 360);
    assert(data.cells.every(cell => cell.boundary.length >= 5));
    const outside = await (await fetch(url + '/view?days=90&level=4&box=130,38,131,39', options)).json();
    assert.equal(outside.data.cells.length, 0);
    assert.equal(outside.data.summary.total, data.summary.total);
    assert.equal(outside.data.viewportSummary.total, 0);
    assert.deepEqual(outside.data.candidateViewport, { cells: 0, stores: 0, groups: 0, markers: [] });
    assert.equal(data.candidateViewport.cells, data.viewportSummary.candidates);
    assert.deepEqual(data.candidateViewport.markers, []);
    assert.equal(data.summaryResolution, 8);
    const coarse = await (await fetch(url + '/view?days=90&level=11&box=126,36,128,38', options)).json();
    assert.deepEqual(coarse.data.summary, data.summary);
    assert.equal(coarse.data.candidateViewport.cells, data.candidateViewport.cells);
    assert.equal(coarse.data.candidateViewport.markers.reduce((sum, marker) => sum + marker.cells, 0), data.candidateViewport.cells);
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
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
