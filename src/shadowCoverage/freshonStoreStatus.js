import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { getResolution, isValidCell, latLngToCell } from 'h3-js';
import { datesFor, isDay, privateCoverageDirectory, boundedRead } from './coverageFiles.js';

const names = new Map([['오산신규', 'new'], ['오산보류', 'held']]);
const customerCode = /^[A-Z]\d{1,20}$/;
const sha256 = /^[a-f0-9]{64}$/;
const vehicle = /^[\p{L}\p{N} _-]{1,64}$/u;
const resolutions = [8, 9, 10, 11];
const fields = ['registered', 'currentNew', 'currentHeld', 'observedNew', 'observedHeld',
  'confirmedNoOrder', 'orderUnknown', 'confirmedDispatchGap', 'dispatchPending', 'dispatchUnknown'];
const counters = () => Object.fromEntries(fields.map(key => [key, 0]));
const code = value => typeof value === 'string' && customerCode.test(value);
const digest = value => typeof value === 'string' && sha256.test(value);
const route = value => typeof value === 'string' && vehicle.test(value) && value.trim() === value;

function count(row, totals) {
  totals.registered++;
  if (names.get(row.vehicle) === 'new') totals.currentNew++;
  if (names.get(row.vehicle) === 'held') totals.currentHeld++;
  const seen = label => row.fixedObservations.some(item => item.vehicle === label) ||
    row.transitions.some(item => item.vehicle === label || item.fromVehicle === label);
  if (seen('오산신규')) totals.observedNew++;
  if (seen('오산보류')) totals.observedHeld++;
  if (row.ordersComplete && row.lastOrder === null) totals.confirmedNoOrder++;
  if (!row.ordersComplete && row.lastOrder === null) totals.orderUnknown++;
  if (row.dispatchComplete && row.dispatchObservations.length === 0) totals.confirmedDispatchGap++;
  if (row.lastDispatch === null && row.dispatchObservations.length > 0) totals.dispatchPending++;
  if (!row.dispatchComplete && row.lastDispatch === null) totals.dispatchUnknown++;
}

function report(totals, currentComplete, historyComplete) {
  const { currentNew, currentHeld, observedNew, observedHeld, ...rest } = totals;
  return { ...rest, currentNew: currentComplete ? currentNew : null,
    currentHeld: currentComplete ? currentHeld : null, verifiedCurrentNew: currentNew,
    verifiedCurrentHeld: currentHeld, observedNew, observedHeld,
    historyScope: historyComplete ? 'COMPLETE' : observedNew || observedHeld ? 'PARTIAL' : 'UNKNOWN' };
}

// Input facts come from separate, read-only sources. A dated snapshot observation
// never becomes a change date. A verified visit never becomes an order or task.
export function buildFreshonStoreStatus({ generation, registry, asOf, observedDeliveryDates,
  current = null, fixed = [], changes = [], orders = [], dispatch = [], deliveries = [],
  completeHistoryCodes = [], completeOrderCodes = [], completeDispatchCodes = [] }) {
  if (!digest(generation) || !(registry instanceof Map) || registry.size > 15000 ||
      !Array.isArray(observedDeliveryDates)) throw Error('FRESHON_SHADOW_SCOPE');
  const dates = datesFor(asOf, 90);
  const days = new Set(dates);
  const observed = new Set(observedDeliveryDates);
  if (observed.size !== observedDeliveryDates.length || [...observed].some(day => !days.has(day))) {
    throw Error('FRESHON_SHADOW_DELIVERY_DATES');
  }

  const rows = new Map([...registry].map(([key, store]) => {
    if (!code(key) || store.code !== key || !digest(store.addressHash)) throw Error('FRESHON_SHADOW_REGISTRY');
    return [key, { code: key, addressHash: store.addressHash, vehicle: null, currentKnown: false, history: [],
      historyComplete: false, ordersComplete: false, dispatchComplete: false,
      fixedObservations: [], transitions: [], lastOrder: null, lastDispatch: null,
      lastDelivery: null, confirmedVehicles: [], dispatchObservations: [] }];
  }));
  if (current !== null) {
    if (!isDay(current.date) || !Array.isArray(current.rows)) throw Error('FRESHON_SHADOW_CURRENT');
    const seen = new Set();
    for (const item of current.rows) {
      if (!code(item.code) || item.vehicle !== null && !route(item.vehicle) || seen.has(item.code)) {
        throw Error('FRESHON_SHADOW_CURRENT');
      }
      seen.add(item.code);
      const row = rows.get(item.code);
      if (row) {
        row.currentKnown = true;
        row.vehicle = item.vehicle;
      }
    }
  }

  const observations = new Set();
  for (const item of fixed) {
    if (!code(item.code) || !days.has(item.date) || !route(item.vehicle)) throw Error('FRESHON_SHADOW_FIXED');
    const key = `${item.code}|${item.date}|${item.vehicle}`;
    const row = rows.get(item.code);
    if (row && !observations.has(key)) row.fixedObservations.push({ date: item.date, vehicle: item.vehicle });
    observations.add(key);
  }

  const changeKeys = new Map();
  for (const item of changes) {
    const ms = Date.parse(item.changedAt);
    if (!Number.isFinite(ms) || !item.changedAt.endsWith('Z') || !code(item.code) ||
        !route(item.fromVehicle) || !route(item.vehicle) || item.fromVehicle === item.vehicle) {
      throw Error('FRESHON_SHADOW_CHANGE');
    }
    const date = new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
    if (!days.has(date)) throw Error('FRESHON_SHADOW_CHANGE_SCOPE');
    const changedAt = new Date(ms).toISOString();
    const key = `${item.code}|${changedAt}`;
    const pair = `${item.fromVehicle}|${item.vehicle}`;
    if (changeKeys.has(key) && changeKeys.get(key) !== pair) throw Error('FRESHON_SHADOW_CHANGE_CONFLICT');
    if (!changeKeys.has(key)) rows.get(item.code)?.transitions.push({ changedAt, date, fromVehicle: item.fromVehicle, vehicle: item.vehicle });
    changeKeys.set(key, pair);
  }

  for (const item of orders) {
    if (!code(item.code) || !days.has(item.date)) throw Error('FRESHON_SHADOW_ORDER');
    const row = rows.get(item.code);
    if (row && item.date > (row.lastOrder || '')) row.lastOrder = item.date;
  }
  let addressMismatches = 0;
  const seenDispatch = new Set();
  for (const [field, events] of [['lastDispatch', dispatch], ['lastDelivery', deliveries]]) {
    for (const item of events) {
      if (!code(item.code) || !days.has(item.date) || item.vehicle !== null && !route(item.vehicle) ||
          !digest(item.addressHash) || !['registry', 'delivery'].includes(item.addressHashKind) ||
          field === 'lastDelivery' && !observed.has(item.date)) {
        throw Error('FRESHON_SHADOW_ACTIVITY');
      }
      const row = rows.get(item.code);
      if (!row) continue;
      const store = registry.get(item.code);
      const hash = item.addressHashKind === 'delivery' ? store.matchHash : store.addressHash;
      if (item.addressHash !== hash) {
        addressMismatches++;
        if (field === 'lastDispatch') row.dispatchComplete = null;
        continue;
      }
      if (field === 'lastDispatch') {
        const key = `${item.code}|${item.date}|${item.vehicle ?? ''}`;
        if (!seenDispatch.has(key)) row.dispatchObservations.push({ date: item.date, confirmedVehicle: item.vehicle });
        seenDispatch.add(key);
        if (item.vehicle === null) continue;
        if (!row.confirmedVehicles.includes(item.vehicle)) row.confirmedVehicles.push(item.vehicle);
      }
      if (item.date > (row[field]?.date || '')) row[field] = { date: item.date, vehicles: [] };
      if (item.vehicle !== null && item.date === row[field].date && !row[field].vehicles.includes(item.vehicle)) {
        row[field].vehicles.push(item.vehicle);
      }
    }
  }

  const historyCoverage = new Set(completeHistoryCodes);
  const orderCoverage = new Set(completeOrderCodes);
  const dispatchCoverage = new Set(completeDispatchCodes);
  for (const row of rows.values()) {
    row.historyComplete = historyCoverage.has(row.code);
    row.ordersComplete = orderCoverage.has(row.code);
    row.dispatchComplete = row.dispatchComplete !== null && dispatchCoverage.has(row.code);
    row.fixedObservations.sort((a, b) => a.date.localeCompare(b.date) || a.vehicle.localeCompare(b.vehicle));
    row.transitions.sort((a, b) => a.changedAt.localeCompare(b.changedAt));
    const endOfDay = new Map(row.transitions.map(item => [item.date, { date: item.date, vehicle: item.vehicle }]));
    row.history = [...endOfDay.values()];
    row.lastDispatch?.vehicles.sort();
    row.lastDelivery?.vehicles.sort();
    row.confirmedVehicles.sort();
    row.dispatchObservations.sort((a, b) => a.date.localeCompare(b.date) ||
      (a.confirmedVehicle ?? '').localeCompare(b.confirmedVehicle ?? ''));
  }
  return { schema: 1, provider: 'FRESHON', generation, asOf, start: dates[0],
    currentAsOf: current?.date ?? null, currentComplete: current?.complete === true &&
      [...rows.values()].every(row => row.currentKnown),
    deliveryObservedDates: dates.filter(day => observed.has(day)),
    deliveryUnknownDates: dates.filter(day => !observed.has(day)), addressMismatches, stores: [...rows.values()] };
}

export function createFreshonStoreStatusIndex(projection, registry, generation) {
  if (!digest(generation) || projection?.schema !== 1 || projection.provider !== 'FRESHON' ||
      projection.generation !== generation || !Array.isArray(projection.stores) || projection.stores.length !== registry.size ||
      typeof projection.currentComplete !== 'boolean') throw Error('FRESHON_SHADOW_GENERATION');
  const dates = datesFor(projection.asOf, 90);
  const received = new Set(projection.deliveryObservedDates);
  if (projection.start !== dates[0] || received.size !== projection.deliveryObservedDates?.length ||
      JSON.stringify(dates.filter(date => received.has(date))) !== JSON.stringify(projection.deliveryObservedDates) ||
      JSON.stringify(dates.filter(date => !received.has(date))) !== JSON.stringify(projection.deliveryUnknownDates)) {
    throw Error('FRESHON_SHADOW_DELIVERY_DATES');
  }
  const rows = new Map();
  const cells = new Map();
  const totals = counters();
  const metadata = Object.freeze({ provider: projection.provider, generation, start: projection.start,
    asOf: projection.asOf, currentAsOf: projection.currentAsOf,
    deliveryObservedDates: Object.freeze([...received]), deliveryUnknownDates: Object.freeze([...projection.deliveryUnknownDates]) });
  for (const row of projection.stores) {
    const store = registry.get(row?.code);
    if (!store || !digest(row.addressHash) || store.addressHash !== row.addressHash || rows.has(row.code) ||
        !Array.isArray(row.fixedObservations) || !Array.isArray(row.transitions)) throw Error('FRESHON_SHADOW_ADDRESS');
    const details = structuredClone({ ...row, address: store.address });
    rows.set(row.code, details);
    count(details, totals);
    if (!store.hasPoint) continue;
    for (const res of resolutions) {
      const cell = latLngToCell(store.lat, store.lng, res);
      const members = cells.get(cell) || [];
      members.push(details);
      cells.set(cell, members);
    }
  }
  return Object.freeze({ metadata, summary: Object.freeze(report(totals, projection.currentComplete,
    projection.stores.every(row => row.historyComplete))),
  getStore(key) { return rows.has(key) ? structuredClone(rows.get(key)) : null; },
  getCell(id, { offset = 0, limit = 50 } = {}) {
    if (typeof id !== 'string' || !isValidCell(id) || !resolutions.includes(getResolution(id)) ||
        !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw Error('FRESHON_SHADOW_CELL_QUERY');
    }
    const members = cells.get(id) || [];
    const cellTotals = counters();
    for (const row of members) count(row, cellTotals);
    return { id, ...metadata, counts: report(cellTotals, projection.currentComplete,
      members.length > 0 && members.every(row => row.historyComplete)), offset,
    rows: structuredClone(members.slice(offset, offset + limit)) };
  } });
}

export async function readFreshonStoreStatusFile({ file, expectedSha256, appRoot = process.cwd(), generation, registry }) {
  if (!path.isAbsolute(file || '') || !digest(expectedSha256)) throw Error('FRESHON_SHADOW_FILE_CONFIG');
  const resolved = await realpath(file);
  await privateCoverageDirectory(path.dirname(resolved), appRoot);
  const bytes = await boundedRead(resolved, 8 * 1024 * 1024);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw Error('FRESHON_SHADOW_FILE_DIGEST');
  return createFreshonStoreStatusIndex(JSON.parse(bytes), registry, generation);
}
