import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell } from 'h3-js';
import { buildFreshonStoreStatus, createFreshonStoreStatusIndex } from '../src/shadowCoverage/freshonStoreStatus.js';

const generation = 'a'.repeat(64);
const canonical = 'b'.repeat(64);
const archived = 'c'.repeat(64);
const points = [37.1, 127.1];
const codes = ['T1000', 'T2000', 'T3000'];
const registry = new Map(codes.map(code => [code, { code, address: '검증 주소', addressHash: canonical,
  matchHash: archived, hasPoint: true, lat: points[0], lng: points[1] }]));
const start = '2026-08-10';
const asOf = '2026-11-07';
const common = { generation, registry, asOf, observedDeliveryDates: [asOf] };
const build = data => buildFreshonStoreStatus({ ...common, ...data });
const index = data => createFreshonStoreStatusIndex(build(data), registry, generation);
const event = (code, vehicle, addressHash = archived) => ({ code, vehicle, addressHash, addressHashKind: 'delivery', date: asOf });

test('current and observed status are independent, and partial snapshots do not invent change dates', () => {
  const view = index({
    current: { date: asOf, complete: false, rows: [{ code: codes[0], vehicle: '101' }, { code: codes[1], vehicle: '오산보류' }] },
    fixed: [{ code: codes[0], date: start, vehicle: '오산신규' }, { code: codes[0], date: start, vehicle: '오산신규' }],
    orders: [{ code: codes[1], date: asOf }]
  });
  assert.equal(view.summary.currentNew, null);
  assert.equal(view.summary.verifiedCurrentHeld, 1);
  assert.equal(view.summary.observedNew, 1);
  assert.equal(view.summary.historyScope, 'PARTIAL');
  assert.equal(view.getStore(codes[0]).fixedObservations.length, 1);
  assert.deepEqual(view.getStore(codes[0]).transitions, []);
  assert.equal(view.getStore(codes[1]).vehicle, '오산보류');
  assert.equal(view.getStore(codes[1]).lastOrder, asOf);
});

test('verified changes preserve vehicle hire and general routes on the same KST date', () => {
  const view = index({
    current: { date: asOf, complete: true, rows: codes.map((code, i) => ({ code, vehicle: ['오산신규', '101', null][i] })) },
    changes: [
      { code: codes[1], fromVehicle: '용차7', vehicle: '101', changedAt: '2026-11-06T17:00:00Z' },
      { code: codes[1], fromVehicle: '오산신규', vehicle: '용차7', changedAt: '2026-11-06T16:00:00Z' }
    ]
  });
  assert.equal(view.summary.currentNew, 1);
  assert.equal(view.summary.observedNew, 1);
  assert.deepEqual(view.getStore(codes[1]).transitions.map(item => [item.date, item.vehicle]), [[asOf, '용차7'], [asOf, '101']]);
  assert.deepEqual(view.getStore(codes[0]).confirmedVehicles, []);
  assert.equal(view.getStore(codes[2]).currentKnown, true);
});

test('order and dispatch gaps need separate completeness and recorded visits stay separate', () => {
  const view = index({
    completeOrderCodes: [codes[1]], completeDispatchCodes: [codes[1]],
    dispatch: [event(codes[0], null), event(codes[0], '용차8'), event(codes[0], '용차8')],
    deliveries: [event(codes[2], '101')]
  });
  assert.equal(view.summary.confirmedNoOrder, 1);
  assert.equal(view.summary.confirmedDispatchGap, 1);
  assert.equal(view.summary.dispatchUnknown, 1);
  assert.equal(view.getStore(codes[2]).lastDispatch, null);
  assert.deepEqual(view.getStore(codes[2]).lastDelivery, { date: asOf, vehicles: ['101'] });
  assert.deepEqual(view.getStore(codes[0]).confirmedVehicles, ['용차8']);
  assert.equal(view.metadata.deliveryUnknownDates.length, 89);
});

test('an unconfirmed route remains visible and does not invent a confirmed dispatch date or gap', () => {
  const view = index({ dispatch: [event(codes[0], null)], completeDispatchCodes: [codes[0]] });
  assert.equal(view.getStore(codes[0]).lastDispatch, null);
  assert.deepEqual(view.getStore(codes[0]).dispatchObservations, [{ date: asOf, confirmedVehicle: null }]);
  assert.equal(view.summary.dispatchPending, 1);
  assert.equal(view.summary.confirmedDispatchGap, 0);
});

test('mismatched delivery address blocks the event and a no-dispatch assertion', () => {
  const projection = build({ completeDispatchCodes: [codes[0]], dispatch: [event(codes[0], '101', canonical)] });
  const view = createFreshonStoreStatusIndex(projection, registry, generation);
  assert.equal(projection.addressMismatches, 1);
  assert.equal(view.getStore(codes[0]).dispatchComplete, false);
  assert.equal(view.getStore(codes[0]).lastDispatch, null);
  assert.equal(view.summary.confirmedDispatchGap, 0);
  assert.throws(() => createFreshonStoreStatusIndex(projection, registry, 'd'.repeat(64)), /GENERATION/);
  const changed = new Map(registry);
  changed.set(codes[0], { ...registry.get(codes[0]), addressHash: 'd'.repeat(64) });
  assert.throws(() => createFreshonStoreStatusIndex(projection, changed, generation), /ADDRESS/);
});

test('R8–R11 keep colocated customer codes distinct with independent counts and pagination', () => {
  const view = index({ current: { date: asOf, complete: true, rows: [
    { code: codes[0], vehicle: '오산신규' }, { code: codes[1], vehicle: '오산보류' }, { code: codes[2], vehicle: '101' }
  ] }, completeDispatchCodes: [codes[0]] });
  for (const res of [8, 9, 10, 11]) {
    const cell = view.getCell(latLngToCell(...points, res), { offset: 1, limit: 1 });
    assert.equal(cell.counts.registered, 3);
    assert.equal(cell.counts.currentNew, 1);
    assert.equal(cell.counts.currentHeld, 1);
    assert.equal(cell.counts.confirmedDispatchGap, 1);
    assert.equal(cell.rows[0].code, codes[1]);
    assert.equal(cell.rows[0].address, '검증 주소');
  }
  const clone = view.getStore(codes[0]);
  clone.vehicle = '102';
  assert.equal(view.getStore(codes[0]).vehicle, '오산신규');
  assert.throws(() => view.getCell(latLngToCell(...points, 7)), /QUERY/);
});

test('rejects conflicting current records and invalid observed dates', () => {
  assert.throws(() => build({ current: { date: asOf, rows: [
    { code: codes[0], vehicle: '오산신규' }, { code: codes[0], vehicle: '오산보류' }
  ] } }), /CURRENT/);
  assert.throws(() => build({ observedDeliveryDates: [asOf, asOf] }), /DELIVERY_DATES/);
});
