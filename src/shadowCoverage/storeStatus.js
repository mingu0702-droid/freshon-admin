import { isDay } from './coverageFiles.js';

const names = { NEW: '오산신규', HELD: '오산보류' };
const stateOf = vehicle => vehicle === names.NEW ? 'NEW' : vehicle === names.HELD ? 'HELD' : null;
const dayAt = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const orderStates = new Set(['CONFIRMED_VALID','CONFIRMED_ZERO','CONFIRMED_CANCELLED_ONLY','UNKNOWN']);
const unknownOrder = Object.freeze({state:'UNKNOWN',complete:false,validOrderCount:null,lastOrderDate:null,dates:Object.freeze([])});

function publicOrder(value) {
  if (!orderStates.has(value?.state) || value.state === 'UNKNOWN' || !Number.isSafeInteger(value.validOrderCount) ||
      value.validOrderCount < 0) return unknownOrder;
  if (value.state === 'CONFIRMED_VALID' ? value.validOrderCount === 0 : value.validOrderCount !== 0 || !value.complete) return unknownOrder;
  return {state:value.state,complete:value.complete === true,validOrderCount:value.validOrderCount,
    lastOrderDate:isDay(value.lastOrderDate) ? value.lastOrderDate : null,
    dates:(Array.isArray(value.dates) ? value.dates : []).filter(item=>isDay(item?.date) && Number.isSafeInteger(item.count) && item.count>0)
      .map(({date,count})=>({date,count}))};
}

export function createCoverageStatusReader({ readFixed, readEvidence, readSnapshot, orderDigest, now = Date.now }) {
  const cached = new WeakMap();
  const projections = new WeakMap();
  const orderProjections = new WeakMap();
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
      let orders;
      if (evidence?.getOrderStatus) {
        let byPeriod = orderProjections.get(evidence);
        if (!byPeriod) orderProjections.set(evidence, byPeriod = new Map());
        orders = byPeriod.get(days);
        if (!orders) {
          orders = new Map(codes.map(code => {
            const status = evidence.getOrderStatus(code, days);
            const order = publicOrder(status?.order);
            const newActive = order.complete && typeof status?.newActive === 'boolean' ? status.newActive : null;
            return [code, {newActive,historicalNew:status?.historicalNew === true,held:status?.held === true,
              heldOrderConflict:status?.heldOrderConflict === true,order}];
          }));
          byPeriod.set(days, orders);
        }
      }
      const records = new Map();
      const counts = { NEW: 0, HELD: 0, pastNew: 0, pastHeld: 0, changedFromNew: 0, changedFromHeld: 0,
        rollingNew: 0, rollingHeld: 0, newUnknown: 0, newZero: 0, newCancelledOnly: 0, held: 0, heldUnknown: 0, heldOrderConflict: 0,
        currentUnknown: 0, historyUnknown: 0, ordersUnknown: 0 };
      for (const code of codes) {
        const approved = evidenceRows?.get(code);
        const approvedCurrent = approved?.vehicle && currentAsOf && currentAsOf <= today && (!fixedDay || currentAsOf >= fixedDay) ? approved.vehicle : null;
        const vehicle = approvedCurrent || confirmed.get(code) || null;
        const rawState = stateOf(vehicle);
        const verifiedOrder = orders?.get(code);
        const order = verifiedOrder?.order ?? unknownOrder;
        const newActive = verifiedOrder?.newActive ?? null;
        const heldOrderConflict = verifiedOrder?.heldOrderConflict === true;
        const current = rawState === 'HELD' ? 'HELD' : null;
        const within = event => event.date >= (historyStart || first) && event.date <= (asOf || today);
        const observations = (approved?.fixedObservations || []).filter(within);
        const history = (approved?.transitions || []).filter(within);
        const historyComplete = approved?.historyComplete === true && asOf === today;
        const seen = (label, start) => observations.some(event => (!start || event.date >= start) && stateOf(event.vehicle) === label) ||
          history.some(event => (!start || event.date >= start) && (stateOf(event.vehicle) === label || stateOf(event.fromVehicle) === label));
        const pastNew = verifiedOrder?.historicalNew === true || seen('NEW'), pastHeld = seen('HELD');
        const newUnknown = pastNew && newActive === null;
        const held = verifiedOrder?.held === true || current === 'HELD' || pastHeld;
        if (newActive === true) counts.NEW++;
        if (newUnknown) counts.newUnknown++;
        if (pastNew && order.state === 'CONFIRMED_ZERO') counts.newZero++;
        if (pastNew && order.state === 'CONFIRMED_CANCELLED_ONLY') counts.newCancelledOnly++;
        if (current) counts.HELD++;
        if (held) counts.held++;
        if (held && order.state === 'UNKNOWN') counts.heldUnknown++;
        if (heldOrderConflict) counts.heldOrderConflict++;
        if (pastNew) counts.pastNew++;
        if (pastHeld) counts.pastHeld++;
        if (seen('NEW',first)) counts.rollingNew++;
        if (seen('HELD',first)) counts.rollingHeld++;
        if (pastNew && vehicle && rawState !== 'NEW') counts.changedFromNew++;
        if (pastHeld && vehicle && rawState !== 'HELD') counts.changedFromHeld++;
        if (!vehicle) counts.currentUnknown++;
        if (!historyComplete) counts.historyUnknown++;
        if (order.state === 'UNKNOWN') counts.ordersUnknown++;
        records.set(code, { vehicle, currentVehicle:vehicle, current, newActive, newUnknown, held, heldOrderConflict,
          pastNew, pastHeld, history, observations, historyComplete, order,
          lastDelivery: [approved?.lastDelivery,lastDelivery.get(code)].filter(Boolean).sort().at(-1) || null,
          asOf: approvedCurrent ? currentAsOf : vehicle ? fixedDay : null });
      }
      const orderSummary = evidence?.getOrderSummary?.(days);
      return { records, counts, fixedCheckedAt: fixedDay ? fixed.meta.checkedAt : null, evidenceAsOf: asOf, historyStart, rollingStart:first,
        version: fixed?.meta?.version || null, date: today,
        orderSummary:orderSummary ? activeOrderSummary(orderSummary, counts) : null,
        orderVersion:evidence?.metadata.orderSource==='VERIFIED' ? orderDigest : null,
        orderCell:id=>evidence?.getCell?.(id,{days,limit:1})?.orderFilter || null };
    })().finally(() => { entry.pending = false; entry.until = now() + 30000; });
    periods.set(days, entry);
    return entry.value;
  };
}

export function activeOrderSummary(summary, counts) {
  return {days:summary.days,start:summary.start,end:summary.end,source:summary.source,
    historicalNew:counts.pastNew, newActive:counts.pastNew > 0 && counts.newUnknown === counts.pastNew ? null : counts.NEW,
    newUnknown:counts.newUnknown,newZero:counts.newZero,newCancelledOnly:counts.newCancelledOnly,
    held:counts.held,heldOrderConflict:counts.heldOrderConflict};
}

export function cellStatusCounts(codes, statuses) {
  if (!statuses) return undefined;
  const counts = { NEW: 0, HELD: 0, pastNew: 0, pastHeld: 0, unknown: 0, ordersUnknown: 0,
    newUnknown: 0, newZero: 0, newCancelledOnly: 0, held: 0, heldUnknown: 0, heldOrderConflict: 0 };
  for (const code of codes) {
    const row = statuses.records.get(code);
    if (row?.newActive === true) counts.NEW++;
    if (row?.newUnknown === true) counts.newUnknown++;
    if (row?.pastNew && row.order.state === 'CONFIRMED_ZERO') counts.newZero++;
    if (row?.pastNew && row.order.state === 'CONFIRMED_CANCELLED_ONLY') counts.newCancelledOnly++;
    if (row?.current === 'HELD') counts.HELD++;
    if (row?.pastNew) counts.pastNew++;
    if (row?.pastHeld) counts.pastHeld++;
    if (!row?.vehicle) counts.unknown++;
    if (!row || row.order.state === 'UNKNOWN') counts.ordersUnknown++;
    if (row?.held) counts.held++;
    if (row?.held && row.order.state === 'UNKNOWN') counts.heldUnknown++;
    if (row?.heldOrderConflict) counts.heldOrderConflict++;
  }
  return counts;
}
