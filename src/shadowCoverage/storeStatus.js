import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { boundedRead, isDay } from './coverageFiles.js';

const codePattern = /^[A-Z]\d{1,20}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const vehiclePattern = /^[\p{L}\p{N}_-]{1,64}$/u;
const names = { NEW: '오산신규', HELD: '오산보류' };
const stateOf = vehicle => vehicle === names.NEW ? 'NEW' : vehicle === names.HELD ? 'HELD' : null;
const dayAt = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const isVehicle = value => typeof value === 'string' && vehiclePattern.test(value);

export function validateCoverageStatusSource(payload) {
  if (payload?.schema !== 1 || !isDay(payload.asOf) || !Array.isArray(payload.stores) || payload.stores.length > 15000) {
    throw Error('COVERAGE_STATUS_SOURCE_INVALID');
  }
  const stores = new Map();
  for (const row of payload.stores) {
    if (!row || typeof row.code !== 'string' || !codePattern.test(row.code) || stores.has(row.code) ||
        !(row.vehicle === null || isVehicle(row.vehicle)) ||
        typeof row.historyComplete !== 'boolean' || typeof row.ordersComplete !== 'boolean' ||
        !Array.isArray(row.history) || row.history.length > 90 ||
        row.history.some((event, index) => !isDay(event?.date) || event.date > payload.asOf ||
          index > 0 && event.date <= row.history[index - 1].date || !isVehicle(event.vehicle)) ||
        row.lastOrder !== null && (!isDay(row.lastOrder) || row.lastOrder > payload.asOf)) {
      throw Error('COVERAGE_STATUS_SOURCE_INVALID');
    }
    stores.set(row.code, row);
  }
  return { asOf: payload.asOf, stores };
}

// Only the separately approved, hash-pinned private projection may add history or orders.
export function createCoverageStatusFileReader({ file, sha256, appRoot }) {
  if (!file && !sha256) return undefined;
  let saved;
  return () => saved ??= (async () => {
    if (!path.isAbsolute(file || '') || !hashPattern.test(sha256 || '')) throw Error('COVERAGE_STATUS_FILE_CONFIG');
    const resolved = await realpath(file);
    const relative = path.relative(await realpath(appRoot), resolved);
    if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw Error('COVERAGE_STATUS_FILE_PRIVATE');
    const bytes = await boundedRead(resolved, 3 * 1024 * 1024);
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw Error('COVERAGE_STATUS_FILE_DIGEST');
    return validateCoverageStatusSource(JSON.parse(bytes));
  })().catch(error => { saved = undefined; throw error; });
}

export function createCoverageStatusReader({ readFixed, readEvidence, readSnapshot, now = Date.now }) {
  const cached = new WeakMap();
  return async (catalog, generation) => {
    const old = cached.get(catalog);
    if (old?.generation === generation && (old.pending || now() < old.until)) return old.value;
    const entry = { generation, pending: true };
    entry.value = (async () => {
      const codes = catalog.stores.filter(row => row.registered).map(row => row.code);
      const [fixed, source, snapshot] = await Promise.all([
        Promise.resolve().then(() => readFixed(codes)).catch(() => null),
        Promise.resolve().then(readEvidence).catch(() => null),
        Promise.resolve().then(() => readSnapshot(generation)).catch(() => null)
      ]);
      const confirmed = new Map((fixed?.data || []).filter(row => row.baseVehicleState === 'VERIFIED_MASTER' &&
        row.baseVehicleSource === 'FIXED_DISPATCH_PRIMARY').map(row => [row.customerCode, row.baseVehicle]));
      const today = dayAt(now());
      const lastDelivery = new Map((snapshot?.rows || []).filter(row => isDay(row.lastDeliveryDate) && row.lastDeliveryDate <= today &&
        (row.status === 'COMPLETED' || row.deliveryStatus === 'COMPLETED')).map(row => [row.customerCode, row.lastDeliveryDate]));
      const evidence = source?.asOf <= today ? source : null;
      const first = dayAt(now() - 89 * 86400000);
      const orderCutoff = new Date(today + 'T00:00:00Z');
      orderCutoff.setUTCMonth(orderCutoff.getUTCMonth() - 3, 1);
      const lastDay = new Date(Date.UTC(orderCutoff.getUTCFullYear(), orderCutoff.getUTCMonth() + 1, 0)).getUTCDate();
      orderCutoff.setUTCDate(Math.min(Number(today.slice(8)), lastDay));
      const cutoff = orderCutoff.toISOString().slice(0, 10);
      const fixedTime = Date.parse(fixed?.meta?.checkedAt);
      const fixedDay = Number.isFinite(fixedTime) ? dayAt(fixedTime) : null;
      const records = new Map();
      const counts = { NEW: 0, HELD: 0, pastNew: 0, pastHeld: 0, changedFromNew: 0, changedFromHeld: 0,
        currentUnknown: 0, historyUnknown: 0, ordersUnknown: 0 };
      for (const code of codes) {
        const approved = evidence?.stores.get(code);
        const approvedCurrent = approved?.vehicle && (!fixedDay || evidence.asOf >= fixedDay) ? approved.vehicle : null;
        const vehicle = approvedCurrent || confirmed.get(code) || null;
        const rawState = stateOf(vehicle);
        const order = approved?.lastOrder || null;
        const ordersComplete = approved?.ordersComplete === true && evidence.asOf === today;
        const resumed = rawState === 'HELD' && order && order >= cutoff;
        const current = resumed ? null : rawState;
        const history = (approved?.history || []).filter(event => event.date >= first && event.date <= today);
        const historyComplete = approved?.historyComplete === true && evidence.asOf === today;
        const pastNew = history.some(event => stateOf(event.vehicle) === 'NEW');
        const pastHeld = history.some(event => stateOf(event.vehicle) === 'HELD');
        if (current) counts[current]++;
        if (pastNew) counts.pastNew++;
        if (pastHeld) counts.pastHeld++;
        if (pastNew && vehicle && current !== 'NEW') counts.changedFromNew++;
        if (pastHeld && vehicle && current !== 'HELD') counts.changedFromHeld++;
        if (!vehicle) counts.currentUnknown++;
        if (!historyComplete) counts.historyUnknown++;
        if (!ordersComplete) counts.ordersUnknown++;
        records.set(code, { vehicle, current, pastNew, pastHeld, history, historyComplete, order, ordersComplete,
          resumed: Boolean(resumed), lastDelivery: lastDelivery.get(code) || null,
          asOf: approvedCurrent ? evidence.asOf : vehicle ? fixedDay : null });
      }
      return { records, counts, fixedCheckedAt: fixedDay ? fixed.meta.checkedAt : null, evidenceAsOf: evidence?.asOf || null,
        version: fixed?.meta?.version || null, date: today };
    })().finally(() => { entry.pending = false; entry.until = now() + 30000; });
    cached.set(catalog, entry);
    return entry.value;
  };
}

export function cellStatusCounts(codes, statuses) {
  if (!statuses) return undefined;
  const counts = { NEW: 0, HELD: 0, pastNew: 0, pastHeld: 0, unknown: 0 };
  for (const code of codes) {
    const row = statuses.records.get(code);
    if (row?.current) counts[row.current]++;
    if (row?.pastNew) counts.pastNew++;
    if (row?.pastHeld) counts.pastHeld++;
    if (!row?.vehicle) counts.unknown++;
  }
  return counts;
}
