import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latLngToCell } from 'h3-js';
import { datesFor } from '../src/shadowCoverage/coverageFiles.js';
import { collectFreshonCompletedDeliveries, COMPLETED_DELIVERY_SOURCE } from '../src/shadowCoverage/freshonCompletedDeliveries.js';
import { buildFreshonStoreStatus, createFreshonStoreStatusIndex } from '../src/shadowCoverage/freshonStoreStatus.js';
import { validateOpsmapSyncDay } from '../src/opsmapSyncGeneration.js';

const asOf = '2026-11-07';
const generation = 'a'.repeat(64);
const addressHash = 'b'.repeat(64);
const [completed, planned, held] = ['T1001', 'T1002', 'T1003'];
const registry = new Map([completed, planned, held].map(code => [code,
  { code, addressHash, hasPoint: true, lat: 37.1, lng: 127.1 }]));
const fixed = [...registry.keys()].map(code => ({ code, date: asOf, vehicle: code === held ? '오산보류' : '오산신규' }));

test('completed visits activate a store despite missing days, and planned or cancelled rows do not', async () => {
  const archiveDate = '2026-09-09';
  const archive = validateOpsmapSyncDay({ date: archiveDate, sourceRows: 1, unidentified: 0,
    proof: 'OBSERVED_ARCHIVE_CURRENT', proofHash: addressHash, completeCenters: [],
    visits: [[addressHash, completed, '용8', 'osan', null]] }, archiveDate);
  const plan = validateOpsmapSyncDay({ date: asOf, sourceRows: 2, unidentified: 0, proof: 'VERIFIED_COMPLETE_DAY',
    proofHash: addressHash, completeCenters: ['osan'], planningOnly: true, visits: [],
    tasks: [[addressHash, planned, '102', 'osan', addressHash, 'OPEN'],
      [generation, planned, '102', 'osan', addressHash, 'CANCELLED']] }, asOf);
  const projection = buildFreshonStoreStatus({ generation, registry, asOf, fixed,
    observedDeliveryDates: [archiveDate, asOf] });
  projection.completedDeliveryEvidence = await collectFreshonCompletedDeliveries([archive, plan], new Set(registry.keys()));
  const index = createFreshonStoreStatusIndex(projection, registry, generation);
  assert.equal(index.getDeliveryStatus(completed, 30).newActive, null);
  assert.equal(index.getDeliveryStatus(completed, 60).newActive, true);
  assert.equal(index.getDeliveryStatus(completed, 60).delivery.complete, false);
  assert.equal(index.getDeliveryStatus(planned, 90).newActive, null);
  assert.equal(index.getDeliveryStatus(held, 90).held, true);
  for (const res of [8, 9, 10, 11]) {
    const cell = index.getCell(latLngToCell(37.1, 127.1, res), { days: 60 });
    assert.equal(cell.deliveryFilter.confirmedNewActive, 1);
    assert.equal(cell.deliveryFilter.newUnknown, 1);
    assert.equal(cell.deliveryFilter.held, 1);
    assert.equal(cell.rows.find(row => row.code === completed).deliveryStatus.newActive, true);
  }
});

test('zero deliveries are confirmed only for a completely verified period', () => {
  const observed = datesFor(asOf, 90);
  const complete = datesFor(asOf, 30);
  const projection = buildFreshonStoreStatus({ generation, registry, asOf, fixed, observedDeliveryDates: observed });
  projection.completedDeliveryEvidence = { source: COMPLETED_DELIVERY_SOURCE, completeDates: complete, stores: [] };
  const index = createFreshonStoreStatusIndex(projection, registry, generation);
  assert.equal(index.getDeliveryStatus(completed, 30).newActive, false);
  assert.equal(index.getDeliverySummary(30).newZero, 2);
  assert.equal(index.getDeliveryStatus(completed, 60).newActive, null);
  assert.equal(index.getDeliverySummary(60).newZero, 0);
  delete projection.completedDeliveryEvidence;
  assert.equal(createFreshonStoreStatusIndex(projection, registry, generation).getDeliverySummary(30).newActive, null);
});
