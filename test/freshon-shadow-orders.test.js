import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { latLngToCell } from 'h3-js';
import { createFreshonMisOrderLookup, prepareFreshonMisOrderLedger } from '../src/shadowCoverage/freshonMisOrderLedger.js';
import { buildFreshonStoreStatus, createFreshonStoreStatusIndex, readFreshonStoreStatusFile } from '../src/shadowCoverage/freshonStoreStatus.js';

const generation = 'a'.repeat(64);
const addressHash = 'b'.repeat(64);
const start = '2026-08-10';
const asOf = '2026-11-07';
const [ordered, cancelled, zero, unverified, unknown, held] = ['T1001', 'T1002', 'T1003', 'T1004', 'T1005', 'T1006'];
const registry = new Map([ordered, cancelled, zero, unverified, unknown, held].map(code => [code,
  { code, address: '확인주소', addressHash, hasPoint: true, lat: 37.1, lng: 127.1 }]));
const row = (id, code, date, state = 'VALID') => [id.repeat(64), code, date, state];
const receipt = (customerCode, since = start) => ({ customerCode, start: since, end: asOf, scope: 'VERIFIED_COMPLETE_ALL_STATUSES' });
const source = (orders = [], coverage = []) => ({ schema: 1, source: 'FRESHON_MIS_ORDER_LEDGER', generation,
  asOf, start, sourceRevision: 'MIS_TEST_1', orders, coverage });
const projection = buildFreshonStoreStatus({ generation, registry, asOf, observedDeliveryDates: [],
  current: { date: '2026-11-11', rows: [{ code: ordered, vehicle: '101' }, { code: held, vehicle: '오산보류' }] },
  fixed: [...registry.keys()].map(code => ({ code, date: start, vehicle: code === held ? '오산보류' : '오산신규' })),
  dispatch: [{ code: ordered, date: asOf, vehicle: '용차8', addressHash, addressHashKind: 'registry' }],
  orders: [{ code: unknown, date: asOf }] });
const index = payload => createFreshonStoreStatusIndex(projection, registry, generation, payload && {
  orderLookup: createFreshonMisOrderLookup(payload, { generation, asOf }), orderSource: 'VERIFIED'
});

test('preserves the historical cohort and gates activation by the selected order dates at R8–R11', () => {
  const valid = row('1', ordered, '2026-09-09');
  const view = index(source([valid, valid, row('2', ordered, start)], [receipt(ordered)]));
  assert.equal(view.getOrderSummary(90).historicalNew, 5);
  assert.equal(view.getOrderStatus(ordered, 90).order.validOrderCount, 2);
  assert.deepEqual(view.getOrderStatus(ordered, 60).order.dates, [{ date: '2026-09-09', count: 1 }]);
  assert.equal(view.getOrderStatus(ordered, 30).order.state, 'CONFIRMED_ZERO');
  assert.equal(view.getOrderStatus(ordered).currentVehicle, '101');
  assert.equal(view.getOrderStatus(ordered).laterNumberedVehicle, true);
  assert.equal(view.getStore(ordered).lastDelivery, null);
  assert.deepEqual(view.getStore(ordered).confirmedVehicles, ['용차8']);
  for (const resolution of [8, 9, 10, 11]) {
    const id = latLngToCell(37.1, 127.1, resolution);
    assert.equal(view.getCell(id, { days: 30 }).orderFilter.newActive, null);
    assert.equal(view.getCell(id, { days: 60 }).orderFilter.newActive, 1);
    assert.equal(view.getCell(id, { days: 90 }).rows.find(r => r.code === ordered).orderStatus.newActive, true);
  }
  assert.throws(() => view.getOrderSummary(14), /COVERAGE_PERIOD_INVALID/);
});

test('separates cancelled-only, actual zero, missing evidence and unverified source statuses', () => {
  const view = index(source([row('1', cancelled, asOf, 'CANCELLED'), row('2', unverified, asOf, 'UNVERIFIED')],
    [receipt(cancelled), receipt(zero), receipt(unverified)]));
  assert.equal(view.getOrderStatus(cancelled).order.state, 'CONFIRMED_CANCELLED_ONLY');
  assert.equal(view.getOrderStatus(cancelled).newActive, false);
  assert.equal(view.getOrderStatus(zero).order.state, 'CONFIRMED_ZERO');
  assert.equal(view.getOrderStatus(unverified).order.state, 'UNKNOWN');
  assert.equal(view.getOrderStatus(unknown).order.validOrderCount, null);
  const counts = view.getOrderSummary();
  assert.deepEqual([counts.newActive, counts.newZero, counts.newCancelledOnly, counts.newUnknown], [null, 1, 1, 3]);
});

test('partial coverage keeps activation and counts unknown even when valid orders were observed', () => {
  const view = index(source([row('1', cancelled, asOf, 'CANCELLED'), row('2', ordered, asOf)],
    [receipt(cancelled, '2026-10-09'), receipt(ordered, '2026-10-09')]));
  assert.equal(view.getOrderStatus(cancelled, 90).order.state, 'UNKNOWN');
  assert.equal(view.getOrderStatus(cancelled, 30).order.state, 'CONFIRMED_CANCELLED_ONLY');
  const partial = view.getOrderStatus(ordered, 90);
  assert.equal(partial.newActive, null);
  assert.equal(partial.order.validOrderCount, null);
  assert.equal(partial.order.lastOrderDate, null);
  assert.equal(partial.order.observedValidOrderCount, 1);
  assert.equal(partial.order.lastObservedValidOrderDate, asOf);
  assert.equal(view.getOrderSummary(90).newActive, null);
  assert.equal(view.getOrderStatus(ordered, 30).newActive, true);
  assert.equal(view.getOrderSummary(30).numberedWithVerifiedOrders, 1);
  assert.equal(view.getOrderSummary(30).hiredWithVerifiedOrders, 1);
});

test('holds remain visible and confirmed orders add a separate source discrepancy', () => {
  const view = index(source([row('1', held, start)], [receipt(held)]));
  assert.equal(view.getOrderStatus(held, 30).held, true);
  assert.equal(view.getOrderStatus(held, 30).heldOrderConflict, false);
  assert.equal(view.getOrderStatus(held, 90).heldOrderConflict, true);
  assert.equal(view.getOrderStatus(held, 90).heldOrderConflictReason, 'HELD_WITH_VALID_ORDER');
  assert.equal(view.getOrderStatus(held, 90).newActive, false);
  assert.equal(view.getOrderSummary(90).held, 1);
});

test('rejects a mismatched snapshot, non-MIS inputs, conflicting order IDs and unproved negative coverage', () => {
  for (const input of [
    { ...source(), generation: 'f'.repeat(64) }, { ...source(), source: 'DELIVERY_ARCHIVE' },
    source([row('1', ordered, asOf), row('1', ordered, asOf, 'CANCELLED')]),
    source([], [{ ...receipt(zero), scope: 'PARTIAL' }])
  ]) assert.throws(() => index(input), /FRESHON_MIS_ORDER/);
  assert.equal(index().getOrderStatus(unknown).newUnknown, true);
  assert.equal(index().getOrderStatus(unknown).order.validOrderCount, null);
});

test('only loads an external private ledger with its pinned digest and leaves existing history on failure', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'freshon-mis-test-'));
  const file = path.join(root, 'status.json');
  const orderFile = path.join(root, 'orders.json');
  t.after(async () => { await unlink(orderFile); await unlink(file); await rmdir(root); });
  const statusBytes = JSON.stringify(projection);
  const orderBytes = JSON.stringify(source([row('1', ordered, asOf)], [receipt(ordered)]));
  await writeFile(file, statusBytes);
  await writeFile(orderFile, orderBytes);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const options = { file, expectedSha256: hash(statusBytes), generation, registry, orderFile };
  const valid = await readFreshonStoreStatusFile({ ...options, orderSha256: hash(orderBytes) });
  assert.equal(valid.getOrderSummary().newActive, 1);
  assert.equal(valid.metadata.orderSource, 'VERIFIED');
  const bad = await readFreshonStoreStatusFile({ ...options, orderSha256: 'c'.repeat(64) });
  assert.equal(bad.metadata.orderSource, 'UNAVAILABLE');
  assert.equal(bad.getOrderSummary().newActive, null);
  assert.equal(bad.getOrderSummary().newUnknown, 5);
  assert.equal(bad.summary.observedNew, 5);
});

test('MIS page evidence rejects missing or duplicate pages, changed totals and filtered cancellation statuses', () => {
  const sourceRevision = 'MIS_TEST_1';
  const first = row('1', ordered, asOf);
  const second = row('2', ordered, asOf, 'CANCELLED');
  const page = (number, orders, totalRows = 2) => ({ number, orders, totalRows, pageSize: 1, sourceRevision, httpStatus: 200 });
  const buildFrom = (pages, allStatuses = true) => index(prepareFreshonMisOrderLedger({ generation, asOf, sourceRevision,
    reads: [{ customerCode: ordered, start, end: asOf, allStatuses, pages }] }));
  assert.equal(buildFrom([page(2, [second]), page(1, [first])]).getOrderStatus(ordered).newActive, true);
  const incomplete = [
    buildFrom([page(1, [first])]),
    buildFrom([page(1, [first]), page(1, [second])]),
    buildFrom([page(1, [first]), page(2, [first])]),
    buildFrom([page(1, [first]), page(2, [second], 3)]),
    buildFrom([page(1, [first]), page(2, [second])], false)
  ];
  for (const view of incomplete) assert.equal(view.getOrderStatus(ordered).newActive, null);
  assert.equal(buildFrom([]).getOrderStatus(ordered).order.validOrderCount, null);
  assert.equal(buildFrom([{ ...page(1, [], 0), httpStatus: 403 }]).getOrderStatus(ordered).newActive, null);
  assert.equal(buildFrom([page(1, [], 0)]).getOrderStatus(ordered).order.validOrderCount, 0);
});
