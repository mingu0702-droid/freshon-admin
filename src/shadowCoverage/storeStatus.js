import { isDay } from './coverageFiles.js';

const names = { NEW: '오산신규', HELD: '오산보류' };
const stateOf = vehicle => vehicle === names.NEW ? 'NEW' : vehicle === names.HELD ? 'HELD' : null;
const dayAt = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);

export function createCoverageStatusReader({ readFixed, readEvidence, readSnapshot, now = Date.now }) {
  const cached = new WeakMap();
  const projections = new WeakMap();
  return async (catalog, generation) => {
    const old = cached.get(catalog);
    if (old?.generation === generation && (old.pending || now() < old.until)) return old.value;
    const entry = { generation, pending: true };
    entry.value = (async () => {
      const codes = catalog.stores.filter(row => row.registered).map(row => row.code);
      const [fixed, source, snapshot] = await Promise.all([
        Promise.resolve().then(() => readFixed(codes)).catch(() => null),
        Promise.resolve().then(() => readEvidence?.(generation)).catch(() => null),
        Promise.resolve().then(() => readSnapshot(generation)).catch(() => null)
      ]);
      const confirmed = new Map((fixed?.data || []).filter(row => row.baseVehicleState === 'VERIFIED_MASTER' &&
        row.baseVehicleSource === 'FIXED_DISPATCH_PRIMARY').map(row => [row.customerCode, row.baseVehicle]));
      const today = dayAt(now());
      const lastDelivery = new Map((snapshot?.rows || []).filter(row => isDay(row.lastDeliveryDate) && row.lastDeliveryDate <= today &&
        (row.status === 'COMPLETED' || row.deliveryStatus === 'COMPLETED')).map(row => [row.customerCode, row.lastDeliveryDate]));
      const evidence = source?.metadata?.generation === generation && source.metadata.asOf <= today ? source : null;
      let evidenceRows = evidence && projections.get(evidence);
      if (evidence && !evidenceRows) {
        evidenceRows = new Map(codes.map(code => {
          const row = evidence.getStore(code);
          return [code, row && {vehicle:row.currentKnown ? row.vehicle : null, fixedObservations:row.fixedObservations,
            transitions:row.transitions, historyComplete:row.historyComplete, lastOrder:row.lastOrder,
            ordersComplete:row.ordersComplete, lastDelivery:row.lastDelivery?.date || null}];
        }));
        projections.set(evidence,evidenceRows);
      }
      const asOf = evidence?.metadata.asOf || null;
      const currentAsOf = evidence?.metadata.currentAsOf || null;
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
        const approved = evidenceRows?.get(code);
        const approvedCurrent = approved?.vehicle && currentAsOf && currentAsOf <= today && (!fixedDay || currentAsOf >= fixedDay) ? approved.vehicle : null;
        const vehicle = approvedCurrent || confirmed.get(code) || null;
        const rawState = stateOf(vehicle);
        const order = approved?.lastOrder || null;
        const ordersComplete = approved?.ordersComplete === true && asOf === today;
        const resumed = rawState === 'HELD' && order && order >= cutoff;
        const current = resumed ? null : rawState;
        const within = event => event.date >= first && event.date <= today;
        const observations = (approved?.fixedObservations || []).filter(within);
        const history = (approved?.transitions || []).filter(within);
        const historyComplete = approved?.historyComplete === true && asOf === today;
        const seen = label => observations.some(event => stateOf(event.vehicle) === label) ||
          history.some(event => stateOf(event.vehicle) === label || stateOf(event.fromVehicle) === label);
        const pastNew = seen('NEW'), pastHeld = seen('HELD');
        if (current) counts[current]++;
        if (pastNew) counts.pastNew++;
        if (pastHeld) counts.pastHeld++;
        if (pastNew && vehicle && current !== 'NEW') counts.changedFromNew++;
        if (pastHeld && vehicle && current !== 'HELD') counts.changedFromHeld++;
        if (!vehicle) counts.currentUnknown++;
        if (!historyComplete) counts.historyUnknown++;
        if (!ordersComplete) counts.ordersUnknown++;
        records.set(code, { vehicle, current, pastNew, pastHeld, history, observations, historyComplete, order, ordersComplete,
          resumed: Boolean(resumed), lastDelivery: [approved?.lastDelivery,lastDelivery.get(code)].filter(Boolean).sort().at(-1) || null,
          asOf: approvedCurrent ? currentAsOf : vehicle ? fixedDay : null });
      }
      return { records, counts, fixedCheckedAt: fixedDay ? fixed.meta.checkedAt : null, evidenceAsOf: asOf,
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
