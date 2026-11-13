import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { fixedDeliveryWeekdays, nearbyFixedDeliveryWeekdays, NO_FIXED_ASSIGNMENT } from '../public/opsmap/fixed-delivery-weekdays.mjs';
import { projectFixedVehicles } from '../src/fixedVehicleProjection.js';
import * as legacy from '../src/fixedVehicleStore.js';
import * as stage from '../src/opsmap-abc/fixedVehicleStore.js';
import { createFixedVehicleCache } from '../src/opsmap-abc/fixedVehicleCache.js';
import { mountMapDataFreshness } from '../src/opsmap-abc/mapDataFreshness.js';

const checkedAt = '2026-11-11T07:38:28.734Z';
const version = 'a'.repeat(64);
const center = { lat: 37.5, lng: 127 };
const dayKeys = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const allEmpty = Object.fromEntries(dayKeys.map(day => [day, NO_FIXED_ASSIGNMENT]));
const row = (customerCode, weekdays, patch = {}) => ({
  customerCode, baseVehicle: '177', baseVehicleGroup: 'osan', baseVehicleState: 'VERIFIED_MASTER',
  baseVehicleSource: 'FIXED_DISPATCH_PRIMARY', baseVehicleCheckedAt: checkedAt, baseVehicleVersion: version,
  baseVehicleStale: false, weekdays, ...patch
});
const point = (customerCode, meters = 0, patch = {}) => ({
  customerCode, customerName: '검증 매장 ' + customerCode, ...center,
  lat: center.lat + (meters / 6371000) * 180 / Math.PI, ...patch
});
const assignments = (...rows) => new Map(rows.map(value => [value.customerCode, value]));
const js = readFileSync(new URL('../public/opsmap/map-period-ui.js', import.meta.url), 'utf8');
const context = {};
runInNewContext(js, context);
const index = rows => context.MapPeriodUi.spatialIndex(rows);
const opts = { source: { version, checkedAt, stale: false }, locationCoverageComplete: true };

test('raw master projects normal routes, explicit exclusions and absent days separately', () => {
  const [projected] = projectFixedVehicles([{
    estCd: 'S10001', logCd: '011', mainCarSeqNm: '177',
    carSeqMonNm: '１０１ 호차', carSeqTueNm: '오산 신규', carSeqWedNm: '보류',
    carSeqThuNm: null, carSeqFriNm: '122', carSeqSunNm: '202'
  }]);
  assert.deepEqual(projected.weekdays, {
    Mon: '101', Tue: '오산신규', Wed: '오산보류', Thu: NO_FIXED_ASSIGNMENT, Fri: '122', Sat: '', Sun: '202'
  });
  for (const store of [legacy, stage]) {
    const data = store.validateFixedEnvelope(store.fixedEnvelope([projected], checkedAt)).data[0];
    const schedule = fixedDeliveryWeekdays(data);
    assert.deepEqual(schedule.days, ['월', '금']);
    assert.deepEqual(schedule.unconfirmedDays, ['토']);
    assert.deepEqual(schedule.byDay.map(day => day.status),
      ['DELIVERY', 'NO_DELIVERY', 'NO_DELIVERY', 'NO_DELIVERY', 'DELIVERY', 'UNKNOWN']);
    assert.equal(schedule.status, 'PARTIAL');
  }
});

test('legacy blanks and unknown weekday values cannot become confirmed no delivery', () => {
  const current = row('S10001', { ...allEmpty, Sun: '202' });
  assert.equal(fixedDeliveryWeekdays(current).status, 'NO_DELIVERY');
  const old = row('S10001', { Mon: '', Tue: '0', Wed: '확인 필요', Thu: '', Fri: '', Sat: '', Sun: '202' },
    { baseVehicleEmptyVerified: true });
  const schedule = fixedDeliveryWeekdays(old);
  assert.equal(schedule.status, 'UNKNOWN');
  assert.deepEqual(schedule.days, []);
  assert.deepEqual(schedule.unconfirmedDays, ['월', '화', '수', '목', '금', '토']);
  assert.equal(fixedDeliveryWeekdays(row('S10001', allEmpty, { baseVehicleState: 'NOT_IN_MASTER' })).status, 'UNKNOWN');
});

test('new and held stores do not advertise old numeric weekday assignments', () => {
  for(const baseVehicle of ['오산신규','오산보류','호남신규']){
    const assignment=row('S10001',{Mon:'101',Wed:'척01',Sun:'202'},{baseVehicle});
    assert.deepEqual(fixedDeliveryWeekdays(assignment).days,[]);
    assert.equal(fixedDeliveryWeekdays(assignment).status,'NO_DELIVERY');
  }
});

test('registered named master routes count on Monday to Saturday only', () => {
  const [raw] = projectFixedVehicles([{ estCd: 'S10001', logCd: '011', mainCarSeqNm: '용11호',
    carSeqMonNm: '용11 호차', carSeqTueNm: '척 204', carSeqWedNm: '오산신규', carSeqSunNm: '용12' }]);
  for (const store of [legacy, stage]) {
    const [data] = store.validateFixedEnvelope(store.fixedEnvelope([raw], checkedAt)).data;
    assert.equal(data.weekdays.Sun, '용12');
    assert.deepEqual(fixedDeliveryWeekdays(data).days, ['월', '화']);
    assert.deepEqual(fixedDeliveryWeekdays(data).byDay.slice(0, 3).map(d => d.route), ['용11', '척204', null]);
  }
});

test('raw duplicates keep corroborated days and never resolve a day conflict by last row', () => {
  const common = { estCd: 'S10001', logCd: '011', mainCarSeqNm: '101', carSeqMonNm: '101' };
  const [projected] = projectFixedVehicles([
    { ...common, carSeqTueNm: '101', carSeqWedNm: '' },
    { ...common, carSeqTueNm: '122' },
    { ...common, carSeqTueNm: '122', carSeqWedNm: '' }
  ]);
  assert.equal(projected.baseVehicleState, 'VERIFIED_MASTER');
  assert.equal(projected.weekdays.Tue, '');
  assert.equal(projected.weekdays.Wed, '');
  assert.deepEqual(fixedDeliveryWeekdays(projected).days, ['월']);
});

test('source version, stale cache and unrelated delivery events do not certify missing days', () => {
  const empty = row('S10001', allEmpty);
  const cached = row('S10001', { ...allEmpty, Mon: '101' }, { baseVehicleStale: true });
  assert.equal(fixedDeliveryWeekdays(empty, { source: { lastError: 'SOURCE_UNAVAILABLE' } }).status, 'UNKNOWN');
  assert.equal(fixedDeliveryWeekdays(cached).status, 'PARTIAL');
  assert.equal(fixedDeliveryWeekdays(cached).stale, true);
  assert.deepEqual(fixedDeliveryWeekdays(cached).days, ['월']);
  assert.deepEqual(fixedDeliveryWeekdays(cached, { source: { version: 'b'.repeat(64) } }).days, []);
  assert.deepEqual(fixedDeliveryWeekdays({ ...cached, baseVehicleSource: 'DELIVERY_STATUS_RECORD_V1' }).days, []);
});

test('500 m schedule uses the union, keeps separate codes at the same address and counts references', () => {
  const p = point('S10001');
  const stores = [p, { ...p }, point('S10002'), point('S10003', 499.999), point('S10004', 500.001)];
  const a = assignments(
    row('S10001', { ...allEmpty, Mon: '101', Wed: '105', Fri: '105' }),
    row('S10002', { Mon: '101', Tue: '122', Wed: '101', Thu: '122', Fri: '101', Sat: '122' }, { baseVehicleGroup: 'honam' }),
    row('S10003', { Mon: '101', Tue: '122', Wed: '101', Thu: '122', Fri: '101', Sat: '122' }),
    row('S10004', { Mon: '999' })
  );
  const result = nearbyFixedDeliveryWeekdays(center, index(stores), a, opts);
  assert.equal(result.status, 'VERIFIED');
  assert.deepEqual(result.days, ['월', '화', '수', '목', '금', '토']);
  assert.equal(result.nearbyRegisteredStoreCount, 3);
  assert.equal(result.nearbyDeliveryStoreCount, 3);
  assert.deepEqual(result.byDay.map(day => day.storeCount), [3, 2, 3, 2, 3, 2]);
  assert.deepEqual(result.byDay.map(day => day.noDeliveryStoreCount), [0, 1, 0, 1, 0, 1]);
  assert.ok(result.byDay.every(day => day.unconfirmedStoreCount === 0));
  assert.deepEqual(result.byDay[0].routes, [
    { route: '101', center: 'osan', storeCount: 2 }, { route: '101', center: 'honam', storeCount: 1 }
  ]);
  assert.equal(result.byDay.some(day => day.stores.some(store => store.customerCode === 'S10004')), false);
});

test('same schedules do not manufacture additional possible weekdays', () => {
  const stores = [point('S10001', 10), point('S10002', 20), point('S10003', 30)];
  const a = assignments(...stores.map(s => row(s.customerCode, { ...allEmpty, Mon: '101', Wed: '101', Fri: '101' })));
  const result = nearbyFixedDeliveryWeekdays(center, index(stores), a, opts);
  assert.deepEqual(result.days, ['월', '수', '금']);
  assert.deepEqual(result.byDay.map(day => day.storeCount), [3, 0, 3, 0, 3, 0]);
});

test('duplicates with conflicting points and incomplete sources cannot produce evidence', () => {
  const stores = [point('S10001', 20), point('S10001', 40), point('S10002', 100), point('S10003', 110, {
    coordinateSource: 'KAKAO_ADDRESS_LIVE'
  }), point('S10004', 120, { deliveryOnly: true }), point('S10005', 130, {
    resolutionStatus: 'ADDRESS_CHANGED_REVIEW_REQUIRED'
  })];
  const a = assignments(...stores.map(s => row(s.customerCode, { ...allEmpty, Mon: '101' })));
  a.delete('S10002');
  const result = nearbyFixedDeliveryWeekdays(center, index(stores), a, opts);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.nearbyRegisteredStoreCount, 2);
  assert.equal(result.unconfirmedStoreCount, 2);
  assert.ok(result.byDay.every(day => day.unconfirmedStoreCount === 2 && day.noDeliveryStoreCount === 0));
  assert.deepEqual(result.days, []);
});

test('known no schedule, no locations and missing location evidence are separate', () => {
  const stores = index([point('S10001')]);
  const a = assignments(row('S10001', allEmpty));
  assert.equal(nearbyFixedDeliveryWeekdays(center, stores, a, opts).status, 'NO_DELIVERY');
  assert.equal(nearbyFixedDeliveryWeekdays(center, index([]), a, opts).status, 'NO_NEARBY_STORES');
  assert.equal(nearbyFixedDeliveryWeekdays(center, index([]), a).status, 'UNKNOWN');
  assert.equal(nearbyFixedDeliveryWeekdays(center, stores, a, { ...opts, source: { lastError: 'UNAVAILABLE' } }).status, 'UNKNOWN');
  assert.equal(nearbyFixedDeliveryWeekdays({ lat: null, lng: 127 }, stores, a, opts).nearbyRegisteredStoreCount, null);
});

test('the existing protected Stage response preserves weekday evidence without a new request', async t => {
  const checked = stage.fixedEnvelope(projectFixedVehicles([
    { estCd: 'S10001', logCd: '011', mainCarSeqNm: '101', carSeqMonNm: '101', carSeqTueNm: '', carSeqFriNm: '오산보류' }
  ]), checkedAt);
  let loads = 0;
  const baseCache = createFixedVehicleCache({ readOnly: true, now: () => Date.parse(checkedAt) + 1000,
    store: { load: async () => { loads++; return checked; } } });
  const app = express();
  mountMapDataFreshness(app, { previewEnabled: () => true, env: {}, baseCache, baseStore: null,
    requireView: (req, res, next) => req.get('x-fixture-staff') === 'yes' ? next() : res.sendStatus(401)
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/map-phase2b/preview/base-vehicles?customerCodes=S10001,S99999';
  assert.equal((await fetch(url)).status, 401);
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = await fetch(url, { headers: { 'x-fixture-staff': 'yes' } });
    assert.equal(response.status, 200);
    const { data, meta } = await response.json();
    const known = fixedDeliveryWeekdays(data[0], { source: meta });
    assert.deepEqual(known.days, ['월']);
    assert.equal(known.byDay[1].status, 'NO_DELIVERY');
    assert.equal(known.byDay[4].status, 'NO_DELIVERY');
    assert.equal(fixedDeliveryWeekdays(data[1], { source: meta }).status, 'UNKNOWN');
  }
  assert.equal(loads, 1);
});
