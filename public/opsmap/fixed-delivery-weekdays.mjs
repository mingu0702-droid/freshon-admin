// Shared, read-only rules for the FreshOn fixed dispatch master.
export const DELIVERY_WEEKDAYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
// Reserved in the weekday tuple only. A one-byte marker keeps legacy
// compressed snapshots small. The old numeric projection never emitted it.
export const NO_FIXED_ASSIGNMENT = '_';

const labels = Object.freeze(['월', '화', '수', '목', '금', '토']);
const noDeliveryValues = new Set([NO_FIXED_ASSIGNMENT, '오산신규', '오산보류']);
const verifiedStates = new Set(['VERIFIED_MASTER', 'UNASSIGNED']);
const centerCodes = new Set(['osan', 'yeongnam', 'honam']);
const radiusKm = .5;
const earthKm = 6371;
const rad = Math.PI / 180;

const compact = value => typeof value === 'string' || Number.isSafeInteger(value)
  ? String(value).normalize('NFKC').replace(/\s+/g, '') : '';

function fixedRoute(value) {
  const match = compact(value).match(/^(\d+)(?:호(?:차)?)?$/);
  const route = match?.[1].replace(/^0+/, '') ?? '';
  return /^[1-9]\d{0,11}$/.test(route) ? route : null;
}

export function projectFixedWeekdayValue(value, observed) {
  if (!observed) return '';
  // An explicit blank in an observed source field differs from a missing field
  // or a blank in an older projection that had already flattened both cases.
  if (value === null || typeof value === 'string' && !value.trim()) return NO_FIXED_ASSIGNMENT;
  const key = compact(value);
  if (key === '오산신규') return key;
  if (key === '보류' || key === '오산보류') return '오산보류';
  return fixedRoute(value) ?? '';
}

export function isStoredFixedWeekdayValue(value) {
  return typeof value === 'string' && (/^\d*$/.test(value) ||
    noDeliveryValues.has(value));
}

function freshness(row, source) {
  return {
    version: source?.version ?? row?.baseVehicleVersion ?? null,
    checkedAt: source?.checkedAt ?? row?.baseVehicleCheckedAt ?? null,
    stale: Boolean(source?.stale || source?.lastError || row?.baseVehicleStale)
  };
}

export function fixedDeliveryWeekdays(row, { source } = {}) {
  const meta = freshness(row, source);
  const trusted = row?.baseVehicleSource === 'FIXED_DISPATCH_PRIMARY' &&
    verifiedStates.has(row.baseVehicleState) && (!source?.version || source.version === row.baseVehicleVersion);
  const byDay = DELIVERY_WEEKDAYS.map((key, i) => {
    const value = trusted && Object.hasOwn(row.weekdays ?? {}, key) ? row.weekdays[key] : '';
    const route = fixedRoute(value);
    const keyValue = compact(value);
    const noDelivery = noDeliveryValues.has(keyValue) || keyValue === '보류';
    const status = route ? 'DELIVERY' : !meta.stale && noDelivery ? 'NO_DELIVERY' : 'UNKNOWN';
    return { key, label: labels[i], status, route };
  });
  const days = byDay.filter(day => day.status === 'DELIVERY').map(day => day.label);
  const unconfirmedDays = byDay.filter(day => day.status === 'UNKNOWN').map(day => day.label);
  const status = days.length ? (unconfirmedDays.length || meta.stale ? 'PARTIAL' : 'VERIFIED') :
    unconfirmedDays.length ? 'UNKNOWN' : 'NO_DELIVERY';
  return { status, days, unconfirmedDays, byDay, ...meta };
}

const validPoint = row => row && Number.isFinite(row.lat) && Number.isFinite(row.lng) &&
  row.lat >= 33 && row.lat <= 39.5 && row.lng >= 124 && row.lng <= 132;
const codeOf = row => typeof row?.customerCode === 'string' && /^(?:[A-Z]\d+|\d+)$/.test(row.customerCode) ? row.customerCode : '';
const registeredPoint = row => validPoint(row) && !row.virtual && !row.searchTemporary && !row.deliveryOnly &&
  row.customerRegistryStatus !== 'DELETED' && !['CONFLICT', 'UNVERIFIED', 'MISSING'].includes(row.coordinateStatus) &&
  row.resolutionStatus !== 'ADDRESS_CHANGED_REVIEW_REQUIRED' && !/(?:_TEMPORARY|_LIVE)$/.test(row.coordinateSource ?? '');

function distance(a, b) {
  const x = Math.sin((b.lat - a.lat) * rad / 2);
  const y = Math.sin((b.lng - a.lng) * rad / 2);
  const h = x * x + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * y * y;
  return earthKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Reuse MapPeriodUi.spatialIndex(verifiedLocations) and the already-loaded
// baseVehicles map. No fetch, geocoder, source mutation or full-map scan.
export function nearbyFixedDeliveryWeekdays(point, index, assignments, {
  source, locationCoverageComplete = false, excludeCustomerCode
} = {}) {
  const byDay = DELIVERY_WEEKDAYS.map((key, i) => ({
    key, label: labels[i], storeCount: 0, unconfirmedStoreCount: 0, noDeliveryStoreCount: 0, routes: [], stores: []
  }));
  const base = {
    radiusMeters: 500, days: [], byDay, nearbyRegisteredStoreCount: null,
    nearbyDeliveryStoreCount: null, unconfirmedStoreCount: null, locationCoverageComplete: false,
    ...freshness(null, source)
  };
  if (!validPoint(point) || typeof index?.query !== 'function') return { ...base, status: 'UNKNOWN' };

  const angle = radiusKm / earthKm;
  const latitude = angle / rad;
  const longitude = Math.asin(Math.sin(angle) / Math.cos(point.lat * rad)) / rad;
  const candidates = new Map();
  for (const row of index.query({ south: point.lat - latitude, north: point.lat + latitude,
    west: point.lng - longitude, east: point.lng + longitude })) {
    const code = codeOf(row);
    if (!code || code === excludeCustomerCode || !registeredPoint(row)) continue;
    const km = distance(point, row);
    const previous = candidates.get(code);
    if (!previous) candidates.set(code, { row, km, conflict: false });
    else {
      previous.conflict ||= row.lat !== previous.row.lat || row.lng !== previous.row.lng;
      if (km < previous.km) Object.assign(previous, { row, km });
    }
  }
  const stores = [...candidates.values()].filter(entry => entry.km <= radiusKm)
    .sort((a, b) => a.km - b.km || a.row.customerCode.localeCompare(b.row.customerCode));
  let deliveryCount = 0, unconfirmedCount = 0;
  for (const { row, km, conflict } of stores) {
    const assignment = !conflict && typeof assignments?.get === 'function' ? assignments.get(row.customerCode) : null;
    const schedule = fixedDeliveryWeekdays(assignment, { source });
    if (schedule.status === 'PARTIAL' || schedule.status === 'UNKNOWN') unconfirmedCount++;
    base.stale ||= schedule.stale;
    if (schedule.days.length) deliveryCount++;
    for (const [i, day] of schedule.byDay.entries()) {
      if (day.status === 'UNKNOWN') {
        byDay[i].unconfirmedStoreCount++;
        continue;
      }
      if (day.status === 'NO_DELIVERY') {
        byDay[i].noDeliveryStoreCount++;
        continue;
      }
      const center = centerCodes.has(assignment.baseVehicleGroup) ? assignment.baseVehicleGroup : null;
      byDay[i].stores.push({ customerCode: row.customerCode, customerName: row.customerName ?? '',
        route: day.route, center, distanceMeters: Math.round(km * 1000) });
    }
  }
  for (const day of byDay) {
    day.storeCount = day.stores.length;
    const counts = new Map();
    for (const { route, center } of day.stores) {
      const key = (center ?? '') + ':' + route;
      const summary = counts.get(key) ?? { route, center, storeCount: 0 };
      summary.storeCount++;
      counts.set(key, summary);
    }
    day.routes = [...counts.values()];
  }
  const days = byDay.filter(day => day.storeCount).map(day => day.label);
  const partial = !locationCoverageComplete || unconfirmedCount > 0 || base.stale;
  const status = days.length ? (partial ? 'PARTIAL' : 'VERIFIED') :
    !stores.length && locationCoverageComplete ? 'NO_NEARBY_STORES' :
      partial ? 'UNKNOWN' : 'NO_DELIVERY';
  return { ...base, status, days, locationCoverageComplete, nearbyRegisteredStoreCount: stores.length,
    nearbyDeliveryStoreCount: deliveryCount, unconfirmedStoreCount: unconfirmedCount };
}
