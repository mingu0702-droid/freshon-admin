import { datesFor } from './coverageFiles.js';

const centers = ['osan', 'yeongnam', 'honam'];
const kinds = { order_confirmed: 1, dispatch_confirmed: 2, delivery_completed: 4 };
const emptyCounts = () => ({ registered: 0, observed: 0, orders: 0, dispatch: 0, completed: 0 });

export function projectPostalOperations(ledger, assignments, { days, center, end }) {
  const { startDate, endDate } = ledger;
  const dates = datesFor(end,90).slice(-days);
  const window = new Set(dates);
  const areas = new Map();
  const matched = new Map();
  const unplaced = new Set();
  const observedDates = new Set();
  const inCenter = key => center === 'all' || center === key;
  for (const [code, member] of assignments) {
    if (!member.registered || member.area == null || member.reviewArea !== undefined || !inCenter(centers[member.center])) continue;
    if (!areas.has(member.area)) areas.set(member.area, { counts: emptyCounts(), members: new Map() });
    areas.get(member.area).members.set(code, 0);
    areas.get(member.area).counts.registered++;
  }
  for (const { date, centerKey, rows } of ledger.days) {
    if (!window.has(date) || !inCenter(centerKey)) continue;
    if (rows.length) observedDates.add(date);
    for (const { customerCode, evidence } of rows) {
      const assignment = assignments.get(customerCode);
      const area = areas.get(assignment?.area);
      if (!area?.members.has(customerCode) || centers[assignment.center] !== centerKey) {
        unplaced.add(customerCode);
        continue;
      }
      matched.set(customerCode, (matched.get(customerCode) ?? 0) | kinds[evidence]);
    }
  }
  const summary = { ...emptyCounts(), scopedAreas: areas.size, observedAreas: 0, missingAreas: 0, unplaced: unplaced.size };
  for (const area of areas.values()) {
    const { counts, members } = area;
    for (const code of members.keys()) {
      const flags = matched.get(code) ?? 0;
      members.set(code, flags);
      counts.observed += Number(flags !== 0);
      counts.orders += Number(Boolean(flags & kinds.order_confirmed));
      counts.dispatch += Number(Boolean(flags & kinds.dispatch_confirmed));
      counts.completed += Number(Boolean(flags & kinds.delivery_completed));
    }
    for (const key of Object.keys(counts)) summary[key] += counts[key];
    summary.observedAreas += Number(counts.observed > 0);
  }
  summary.missingAreas = summary.scopedAreas - summary.observedAreas;
  return {
    period: { days, start: dates[0], end }, publishedThrough: endDate, availableFrom: startDate,
    observedDays: observedDates.size, summary, areas,
  };
}
