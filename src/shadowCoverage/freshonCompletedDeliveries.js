import { datesFor } from './coverageFiles.js';
import { completeSyncObservation, SYNC_CENTERS, SYNC_DELIVERY_SOURCES } from '../opsmapSyncPolicy.js';

export const COMPLETED_DELIVERY_SOURCE = 'SEALED_COMPLETED_DELIVERIES';

// The caller reads and validates each day against the sealed generation before
// passing it here. Archived visits prove positives, not complete coverage.
export async function collectFreshonCompletedDeliveries(days, customerCodes) {
  const completeDates = [];
  const visitsByStore = new Map();
  for await (const day of days) {
    if (!day || day.planningOnly) continue;
    const archive = day.proof === 'OBSERVED_ARCHIVE_CURRENT' && !day.tasks;
    const verified = day.proof === 'VERIFIED_COMPLETE_DAY' && Array.isArray(day.tasks);
    if (!archive && !verified) continue;
    if (completeSyncObservation(day, SYNC_CENTERS, Object.values(SYNC_DELIVERY_SOURCES))) {
      completeDates.push(day.date);
    }
    for (const [, code] of day.visits) {
      if (!customerCodes.has(code)) continue;
      const visits = visitsByStore.get(code) ?? new Map();
      visits.set(day.date, (visits.get(day.date) ?? 0) + 1);
      visitsByStore.set(code, visits);
    }
  }
  return { source: COMPLETED_DELIVERY_SOURCE, completeDates: completeDates.sort(),
    stores: [...visitsByStore].sort(([a], [b]) => a.localeCompare(b))
      .map(([code, visits]) => [code, [...visits].sort(([a], [b]) => a.localeCompare(b))]) };
}

export function createFreshonCompletedDeliveryWindows(projection, rows, seen) {
  const observed = new Set(projection.deliveryObservedDates);
  const evidence = projection.completedDeliveryEvidence;
  const completeDates = new Set();
  const visits = new Map();
  if (evidence !== undefined) {
    if (evidence?.source !== COMPLETED_DELIVERY_SOURCE || !Array.isArray(evidence.completeDates) ||
        !Array.isArray(evidence.stores) || evidence.stores.length > rows.size) {
      throw Error('FRESHON_COMPLETED_DELIVERY_CONTRACT');
    }
    for (const day of evidence.completeDates) {
      if (!observed.has(day) || completeDates.has(day)) throw Error('FRESHON_COMPLETED_DELIVERY_COVERAGE');
      completeDates.add(day);
    }
    for (const [code, days] of evidence.stores) {
      if (!rows.has(code) || visits.has(code) || !Array.isArray(days) || !days.length ||
          days.some(([date, count], index) => !observed.has(date) || index > 0 && date <= days[index - 1][0] ||
            !Number.isSafeInteger(count) || count < 1 || count > 12000)) {
        throw Error('FRESHON_COMPLETED_DELIVERY_STORE');
      }
      visits.set(code, days);
    }
  }

  const periods = new Map();
  return days => {
    if (periods.has(days)) return periods.get(days);
    const dates = datesFor(projection.asOf, days);
    const start = dates[0];
    const observedDays = dates.filter(date => observed.has(date)).length;
    const completeDays = dates.filter(date => completeDates.has(date)).length;
    const complete = completeDays === days;
    const source = evidence?.source ?? 'NOT_CONNECTED';
    const byCode = new Map();
    for (const [code, row] of rows) {
      const historicalNew = seen(row, '오산신규');
      const held = row.vehicle === '오산보류' || seen(row, '오산보류');
      if (!historicalNew && !held) continue;
      const matches = (visits.get(code) ?? []).filter(([date]) => date >= start);
      const observedCompletedCount = matches.reduce((total, [, count]) => total + count, 0);
      const confirmed = observedCompletedCount > 0;
      const state = confirmed ? 'CONFIRMED_DELIVERY' : complete ? 'CONFIRMED_ZERO' : 'UNKNOWN';
      const deliveryActive = state === 'UNKNOWN' ? null : confirmed;
      byCode.set(code, { historicalNew, held, newActive: historicalNew ? deliveryActive : false,
        delivery: { state, observedCompletedCount, lastCompletedOn: matches.at(-1)?.[0] ?? null, complete } });
    }
    const summarize = members => {
      const counts = { historicalNew: 0, confirmedNewActive: 0, newZero: 0, newUnknown: 0, held: 0 };
      for (const { code } of members) {
        const status = byCode.get(code);
        if (status?.held) counts.held++;
        if (!status?.historicalNew) continue;
        counts.historicalNew++;
        if (status.newActive === true) counts.confirmedNewActive++;
        else if (status.newActive === false) counts.newZero++;
        else counts.newUnknown++;
      }
      return { days, start, end: projection.asOf, source, observedDays, missingDays: days - observedDays, completeDays, complete,
        ...counts, newActive: counts.confirmedNewActive || (counts.newUnknown ? null : 0) };
    };
    const result = { byCode, summarize, summary: Object.freeze(summarize(rows.values())) };
    periods.set(days, result);
    return result;
  };
}
