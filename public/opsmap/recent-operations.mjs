const centers = ['osan', 'yeongnam', 'honam'];
const labels = Object.freeze({
  delivery_completed: '배송완료',
  order_confirmed: '주문확정',
  dispatch_confirmed: '배차확정',
});
const daysInWindow = 90;
const dayMilliseconds = 86_400_000;
const customerCodePattern = /^[A-Z]\d{1,20}$/;

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}

function dateSet(values, start, end) {
  return new Set((Array.isArray(values) ? values : []).filter(value => {
    const time = day(value);
    return time >= start && time <= end;
  }));
}

function intersect(sets) {
  const [first, ...rest] = sets;
  return [...first].filter(value => rest.every(set => set.has(value))).length;
}

export function readRecentOperations(response) {
  const start = day(response?.startDate);
  const end = day(response?.endDate);
  if (response?.ok !== true || end - start !== (daysInWindow - 1) * dayMilliseconds ||
      !Array.isArray(response.rows) || !response.centers) throw Error('RECENT_OPERATIONS_UNAVAILABLE');

  const coverage = new Map(centers.map(center => {
    const result = response.centers[center];
    const confirmed = dateSet(result?.confirmedDays, start, end);
    const observed = dateSet(result?.observedDates, start, end);
    for (const dates of Object.values(result?.sourceObservedDates || {})) {
      for (const date of dateSet(dates, start, end)) observed.add(date);
    }
    for (const date of confirmed) observed.add(date);
    return [center, { confirmed, observed, unavailable: response.sourceUnavailable === true || result?.sourceUnavailable === true }];
  }));

  const latest = new Map(centers.map(center => [center, new Map()]));
  const observedCustomers = new Set();
  for (const row of response.rows) {
    const center = latest.get(row?.centerKey);
    const time = day(row?.date);
    if (!center || !customerCodePattern.test(row.customerCode || '') || !Object.hasOwn(labels, row.evidence) ||
        !(time >= start && time <= end)) continue;
    const prior = center.get(row.customerCode);
    if (!prior || prior.date < row.date) center.set(row.customerCode, { date: row.date, evidence: row.evidence });
    coverage.get(row.centerKey).observed.add(row.date);
    observedCustomers.add(row.customerCode);
  }
  const staleWindow=day(response.expectedEndDate)>end;
  const absenceEligibleCenters=new Set(staleWindow ? [] : [...coverage].filter(([,scope])=>
    scope.confirmed.size===daysInWindow&&!scope.unavailable).map(([center])=>center));
  return { startDate: response.startDate, endDate: response.endDate, coverage, latest, observedCustomers,
    staleWindow, absenceEligibleCenters };
}

export function recentRecord(report, center, customerCode) {
  return report?.latest.get(center)?.get(customerCode) || null;
}

export function recentCoverage(report, center = '') {
  if (!report) return { state: 'unknown', confirmedDays: 0, observedDates: 0 };
  const scope = center ? [report.coverage.get(center)].filter(Boolean) : [...report.coverage.values()];
  if (!scope.length) return { state: 'unknown', confirmedDays: 0, observedDates: 0 };

  const confirmedDays = intersect(scope.map(row => row.confirmed));
  const observedDates = new Set(scope.flatMap(row => [...row.observed])).size;
  const complete = confirmedDays === daysInWindow && !report.staleWindow && !scope.some(row => row.unavailable);
  return { state: complete ? 'complete' : observedDates ? 'partial' : 'unknown', confirmedDays, observedDates };
}

export function recentOperationStatus(report, center, customerCode, allowAbsence = true) {
  if (recentRecord(report, center, customerCode)) return 'operated';
  if (allowAbsence && report?.absenceEligibleCenters.has(center) &&
      customerCodePattern.test(customerCode || '') && !report.observedCustomers.has(customerCode)) return 'no-operation';
  return 'unknown';
}

export function recentDetail(report, center, customerCode, loading = false, allowAbsence = true) {
  if (loading) return { date: '확인 중', evidence: '확인 중' };
  const record = recentRecord(report, center, customerCode);
  if (record) return { date: record.date.replaceAll('-', '.'), evidence: '운영 확인 · ' + labels[record.evidence] };
  if (recentOperationStatus(report, center, customerCode, allowAbsence) === 'no-operation') {
    return { date: '90일 전수 확인', evidence: '운영 없음 확인' };
  }
  return { date: '미확인', evidence: '이력 미확인' };
}

if (typeof window !== 'undefined') window.MapRecentOperations = Object.freeze({
  readRecentOperations, recentRecord, recentCoverage, recentDetail, recentOperationStatus,
});
