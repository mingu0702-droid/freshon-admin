import { isDay } from './coverageFiles.js';

const names = { NEW: '오산신규', HELD: '오산보류' };
const stateOf = vehicle => vehicle === names.NEW ? 'NEW' : vehicle === names.HELD ? 'HELD' : null;
const dayAt = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const unknownDelivery = Object.freeze({state:'UNKNOWN',complete:false,observedCompletedCount:0,lastCompletedOn:null});

function publicDelivery(value) {
  if (value?.state === 'CONFIRMED_ZERO' && value.complete === true && value.observedCompletedCount === 0) {
    return {state:value.state,complete:true,observedCompletedCount:0,lastCompletedOn:null};
  }
  if (value?.state !== 'CONFIRMED_DELIVERY' || !Number.isSafeInteger(value.observedCompletedCount) ||
      value.observedCompletedCount < 1 || !isDay(value.lastCompletedOn)) return unknownDelivery;
  return {state:value.state,complete:value.complete===true,observedCompletedCount:value.observedCompletedCount,
    lastCompletedOn:value.lastCompletedOn};
}

export function createCoverageStatusReader({ readFixed, readEvidence, readSnapshot, now = Date.now }) {
  const cached = new WeakMap();
  const projections = new WeakMap();
  const deliveryProjections = new WeakMap();
  return async (catalog, generation, days = 90) => {
    let periods = cached.get(catalog);
    if (!periods) cached.set(catalog, periods = new Map());
    const old = periods.get(days);
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
            transitions:row.transitions, historyComplete:row.historyComplete, lastDelivery:row.lastDelivery?.date || null}];
        }));
        projections.set(evidence,evidenceRows);
      }
      const asOf = evidence?.metadata.asOf || null;
      const historyStart = evidence?.metadata.start || null;
      const currentAsOf = evidence?.metadata.currentAsOf || null;
      const first = dayAt(now() - 89 * 86400000);
      const fixedTime = Date.parse(fixed?.meta?.checkedAt);
      const fixedDay = Number.isFinite(fixedTime) ? dayAt(fixedTime) : null;
      let deliveries;
      if (evidence?.getDeliveryStatus) {
        let byPeriod = deliveryProjections.get(evidence);
        if (!byPeriod) deliveryProjections.set(evidence, byPeriod = new Map());
        deliveries = byPeriod.get(days);
        if (!deliveries) {
          deliveries = new Map(codes.map(code => {
            const status = evidence.getDeliveryStatus(code, days);
            const delivery = publicDelivery(status?.delivery);
            const newActive = status?.newActive === true && delivery.state === 'CONFIRMED_DELIVERY' ? true :
              status?.newActive === false && delivery.state === 'CONFIRMED_ZERO' ? false : null;
            return [code, {newActive,historicalNew:status?.historicalNew === true,held:status?.held === true,delivery}];
          }));
          byPeriod.set(days, deliveries);
        }
      }
      const records = new Map();
      const counts = { NEW: 0, HELD: 0, pastNew: 0, pastHeld: 0, changedFromNew: 0, changedFromHeld: 0,
        rollingNew: 0, rollingHeld: 0, newUnknown: 0, newZero: 0, held: 0, currentUnknown: 0, historyUnknown: 0 };
      for (const code of codes) {
        const approved = evidenceRows?.get(code);
        const approvedCurrent = approved?.vehicle && currentAsOf && currentAsOf <= today && (!fixedDay || currentAsOf >= fixedDay) ? approved.vehicle : null;
        const vehicle = approvedCurrent || confirmed.get(code) || null;
        const rawState = stateOf(vehicle);
        const verifiedDelivery = deliveries?.get(code);
        const delivery = verifiedDelivery?.delivery ?? unknownDelivery;
        const current = rawState === 'HELD' ? 'HELD' : null;
        const within = event => event.date >= (historyStart || first) && event.date <= (asOf || today);
        const observations = (approved?.fixedObservations || []).filter(within);
        const history = (approved?.transitions || []).filter(within);
        const historyComplete = approved?.historyComplete === true && asOf === today;
        const seen = (label, start) => observations.some(event => (!start || event.date >= start) && stateOf(event.vehicle) === label) ||
          history.some(event => (!start || event.date >= start) && (stateOf(event.vehicle) === label || stateOf(event.fromVehicle) === label));
        const pastNew = verifiedDelivery?.historicalNew === true || seen('NEW'), pastHeld = seen('HELD');
        const newActive = pastNew ? verifiedDelivery?.newActive ?? null : null;
        const newUnknown = pastNew && newActive === null;
        const held = verifiedDelivery?.held === true || current === 'HELD' || pastHeld;
        if (newActive === true) counts.NEW++;
        if (newUnknown) counts.newUnknown++;
        if (newActive === false) counts.newZero++;
        if (current) counts.HELD++;
        if (held) counts.held++;
        if (pastNew) counts.pastNew++;
        if (pastHeld) counts.pastHeld++;
        if (seen('NEW',first)) counts.rollingNew++;
        if (seen('HELD',first)) counts.rollingHeld++;
        if (pastNew && vehicle && rawState !== 'NEW') counts.changedFromNew++;
        if (pastHeld && vehicle && rawState !== 'HELD') counts.changedFromHeld++;
        if (!vehicle) counts.currentUnknown++;
        if (!historyComplete) counts.historyUnknown++;
        records.set(code, { vehicle, currentVehicle:vehicle, current, newActive, newUnknown, held,
          pastNew, pastHeld, history, observations, historyComplete, delivery,
          lastDelivery: [approved?.lastDelivery,lastDelivery.get(code)].filter(Boolean).sort().at(-1) || null,
          asOf: approvedCurrent ? currentAsOf : vehicle ? fixedDay : null });
      }
      const deliverySummary = evidence?.getDeliverySummary?.(days);
      return { records, counts, fixedCheckedAt: fixedDay ? fixed.meta.checkedAt : null, evidenceAsOf: asOf, historyStart, rollingStart:first,
        version: fixed?.meta?.version || null, date: today,
        deliverySummary:deliverySummary ? activeDeliverySummary(deliverySummary, counts) : null,
        deliveryCell:id=>evidence?.getCell?.(id,{days,limit:1})?.deliveryFilter || null };
    })().finally(() => { entry.pending = false; entry.until = now() + 30000; });
    periods.set(days, entry);
    return entry.value;
  };
}

export function activeDeliverySummary(summary, counts) {
  return {days:summary.days,start:summary.start,end:summary.end,source:summary.source,
    observedDays:summary.observedDays,missingDays:summary.missingDays,completeDays:summary.completeDays,
    historicalNew:counts.pastNew,newActive:counts.newUnknown && !counts.NEW ? null : counts.NEW,
    confirmedNewActive:counts.NEW,complete:summary.complete === true,
    newUnknown:counts.newUnknown,newZero:counts.newZero,held:counts.held};
}

export function cellStatusCounts(codes, statuses) {
  if (!statuses) return undefined;
  const counts = { NEW: 0, HELD: 0, pastNew: 0, pastHeld: 0, unknown: 0,newUnknown: 0,newZero: 0,held: 0 };
  for (const code of codes) {
    const row = statuses.records.get(code);
    if (row?.newActive === true) counts.NEW++;
    if (row?.newUnknown === true) counts.newUnknown++;
    if (row?.newActive === false) counts.newZero++;
    if (row?.current === 'HELD') counts.HELD++;
    if (row?.pastNew) counts.pastNew++;
    if (row?.pastHeld) counts.pastHeld++;
    if (!row?.vehicle) counts.unknown++;
    if (row?.held) counts.held++;
  }
  return counts;
}
