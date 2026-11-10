import { cellToBoundary, cellToLatLng, cellToParent, getResolution, greatCircleDistance, gridDisk, isValidCell, latLngToCell, UNITS } from 'h3-js';
import { isDay, PERIODS, datesFor } from './coverageFiles.js';

export { isDay, PERIODS, datesFor };
export const CENTERS = ['all', 'osan', 'yeongnam', 'honam'];
export const BASE_RESOLUTION = 8;
export const MAX_VISIBLE_CELLS = 360;
const DAY = 86_400_000;
const MAX_STORES = 15_000;
const MAX_LEAF_ROWS = 24_000;
const CENTER_KEYS = [...CENTERS.slice(1), 'unknown'];
export const COVERAGE_LIST_FILTERS = { candidate: 'CANDIDATE', delivery: 'DELIVERED', review: 'UNKNOWN' };
const CODE = /^[A-Z]\d{1,20}$/;
const SHA = /^[a-f0-9]{64}$/;
const PROTECTED = /[\u0000-\u001f]|비밀번호|보안키|공동현관|bearer\s|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/i;


export function isPoint(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= 33 && lat <= 39.5 && lng >= 124 && lng <= 132;
}

export function boundsOf(values) {
  if (!Array.isArray(values) || values.length !== 4 || !values.every(Number.isFinite)) return null;
  const [west, south, east, north] = values;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return null;
  return values;
}

function safeText(value, max) {
  if (typeof value !== 'string' || value.length > max || PROTECTED.test(value)) return '';
  return value.trim();
}

function areaOf(address) {
  const parts = address.split(/\s+/);
  const area = [];
  for (const part of parts.slice(0, 5)) {
    if (/(?:대로|로|길)$/.test(part) || /^\d/.test(part)) break;
    area.push(part);
  }
  return area.join(' ') || '행정구역 미확인';
}

function administrativeArea(address) {
  const parts = areaOf(address).split(' ');
  const local = parts.find(part => /(?:읍|면|동(?:\d+가)?|리)$/.test(part));
  const annotation = address.match(/\(([가-힣0-9]+(?:동(?:\d+가)?|읍|면|리))(?=\s*[,）)])/);
  const district = parts.slice(0, local ? parts.indexOf(local) : parts.length);
  return {
    district: district.some(part => /(?:시|군|구)$/.test(part)) ? district.join(' ') : null,
    locality: local || annotation?.[1] || null
  };
}

const vehicleCode = value => typeof value === 'string' && /^[A-Za-z가-힣0-9 -]{1,32}$/.test(value);
const centerCounts = () => Object.fromEntries(CENTER_KEYS.map(center => [center, 0]));
const countFor = (counts, center) => center === 'all'
  ? Object.values(counts).reduce((total, count) => total + count, 0)
  : counts[center] || 0;

export function prepareCatalog(input) {
  if (!Array.isArray(input.stores) || input.stores.length > MAX_STORES) throw Error('COVERAGE_STORE_LIMIT');
  const codes = new Set();
  const stores = input.stores.map(row => {
    if (!CODE.test(row.code) || codes.has(row.code) || typeof row.registered !== 'boolean') {
      throw Error('COVERAGE_STORE_CONTRACT');
    }
    codes.add(row.code);
    const located = isPoint(row.lat, row.lng);
    const address = safeText(row.address, 500);
    return {
      code: row.code,
      name: safeText(row.name, 200) || row.code,
      address,
      area: areaOf(address),
      center: CENTER_KEYS.includes(row.center) ? row.center : 'unknown',
      registered: row.registered,
      lat: located ? row.lat : null,
      lng: located ? row.lng : null,
      cell: located ? latLngToCell(row.lat, row.lng, BASE_RESOLUTION) : null,
      matchHash: address && SHA.test(row.matchHash || '') ? row.matchHash : null
    };
  });
  const scopes = input.scopes || [];
  if (!Array.isArray(scopes) || scopes.length > MAX_LEAF_ROWS || scopes.some(row =>
    !isValidCell(row.id) || getResolution(row.id) < 4 || getResolution(row.id) > BASE_RESOLUTION ||
    !CENTERS.includes(row.center) || !SHA.test(row.proofHash || '') || !isPoint(...cellToLatLng(row.id)))) {
    throw Error('COVERAGE_SCOPE_CONTRACT');
  }
  const regions = input.regions || [];
  if (!Array.isArray(regions) || regions.length > 5000) throw Error('COVERAGE_REGION_LIMIT');
  return {
    stores,
    byCode: new Map(stores.map(store => [store.code, store])),
    parents: new Map(),
    geometry: new Map(),
    registryVerified: input.registryComplete === true && SHA.test(input.registryProofHash || ''),
    scopes: scopes.map(({ id, center, label, proofHash }) => ({ id, center, label: safeText(label, 120), proofHash })),
    regions: regions.filter(row => boundsOf(row.bounds) && safeText(row.name, 100))
      .map(row => ({ name: safeText(row.name, 100), bounds: row.bounds, query: safeText(row.query, 100),
        location: Array.isArray(row.location) && row.location.length === 2 && isPoint(...row.location) ? row.location : null }))
  };
}

// Each source visit is an already dated, unique Delivery identity. Location comes
// from the approved saved point only when its Customer address still matches.
export function aggregateDay(doc, stores) {
  if (!isDay(doc.date) || !Array.isArray(doc.visits) || doc.visits.length > 12_000 ||
      !Number.isSafeInteger(doc.sourceRows) || doc.sourceRows < doc.visits.length ||
      !Number.isSafeInteger(doc.unidentified) || doc.unidentified < 0) {
    throw Error('COVERAGE_DAY_CONTRACT');
  }
  const groups = new Map();
  const seen = new Set();
  const unplaced = centerCounts();
  const recorded = centerCounts();
  const unplacedCodes = Object.fromEntries(CENTER_KEYS.map(center => [center, new Set()]));
  for (const [identity, code, vehicle, center, addressHash] of doc.visits) {
    if (!SHA.test(identity) || !CODE.test(code) || seen.has(identity) || !CENTER_KEYS.includes(center)) {
      throw Error('COVERAGE_VISIT_IDENTITY');
    }
    seen.add(identity);
    recorded[center]++;
    const store = stores.get(code);
    if (!store?.cell || !store.matchHash || addressHash !== store.matchHash) {
      unplaced[center]++;
      if (store?.registered) unplacedCodes[center].add(code);
      continue;
    }
    const key = store.cell + ':' + center;
    if (!groups.has(key)) groups.set(key, {
      id: store.cell, center, count: 0, codes: new Set(), vehicles: new Set(), assignments: new Map()
    });
    const group = groups.get(key);
    group.count++;
    group.codes.add(code);
    if (vehicleCode(vehicle)) {
      group.vehicles.add(vehicle);
      const assignment = code + ':' + vehicle;
      group.assignments.set(assignment, (group.assignments.get(assignment) || 0) + 1);
    }
  }
  return {
    date: doc.date,
    verifiedCenters: doc.proof === 'VERIFIED_COMPLETE_DAY' && SHA.test(doc.proofHash || '') && doc.unidentified === 0 &&
      Array.isArray(doc.completeCenters) ? CENTERS.slice(1).filter(center => doc.completeCenters.includes(center)) : [],
    sourceRows: doc.sourceRows,
    completed: doc.visits.length,
    unidentified: doc.unidentified,
    unplaced,
    unplacedCodes: Object.fromEntries(CENTER_KEYS.map(center => [center, [...unplacedCodes[center]].sort()])),
    recorded,
    rows: [...groups.values()].map(group => [
      group.id, group.center, group.count, [...group.codes].sort(), [...group.vehicles].sort(),
      [...group.assignments].sort().map(([assignment, count]) => [...assignment.split(':'), count])
    ])
  };
}

export function combineDays(end, days, daily) {
  const required = datesFor(end, days);
  const missing = [];
  const unverified = Object.fromEntries(CENTERS.map(center => [center, []]));
  const groups = new Map();
  const unplaced = centerCounts();
  const recorded = centerCounts();
  const observedDates = Object.fromEntries(CENTERS.map(center => [center, []]));
  const unplacedCodes = Object.fromEntries(CENTER_KEYS.map(center => [center, new Set()]));
  let sourceRows = 0, completed = 0, unidentified = 0, latest = null;
  for (const [index, date] of required.entries()) {
    const day = daily.get(date);
    if (!day) {
      missing.push(date);
      continue;
    }
    for (const center of CENTERS) {
      const verified = center === 'all' ? day.verifiedCenters.length === 3 : day.verifiedCenters.includes(center);
      if (!verified) unverified[center].push(date);
      const seen = center === 'all' ? day.completed > 0 || day.verifiedCenters.length > 0
        : day.recorded[center] > 0 || verified;
      if (seen) observedDates[center].push(date);
    }
    latest = date;
    sourceRows += day.sourceRows;
    completed += day.completed;
    unidentified += day.unidentified;
    for (const center of CENTER_KEYS) {
      unplaced[center] += day.unplaced[center];
      recorded[center] += day.recorded[center];
      for (const code of day.unplacedCodes[center]) unplacedCodes[center].add(code);
    }
    const bit = 1n << BigInt(index);
    for (const [id, center, count, codes, vehicles, assignments] of day.rows) {
      const key = id + ':' + center;
      if (!groups.has(key)) groups.set(key, {
        id, center, count: 0, codes: new Set(), vehicles: new Set(), assignments: new Map(), dateMask: 0n
      });
      const group = groups.get(key);
      group.count += count;
      group.latest = date;
      group.dateMask |= bit;
      for (const code of codes) group.codes.add(code);
      for (const vehicle of vehicles) group.vehicles.add(vehicle);
      for (const [code, vehicle] of assignments) {
        if (!group.assignments.has(code)) group.assignments.set(code, new Set());
        group.assignments.get(code).add(vehicle);
      }
    }
  }
  if (groups.size > MAX_LEAF_ROWS) throw Error('COVERAGE_CELL_LIMIT');
  return {
    evidenceVersion: 2, days, start: required[0], end, latest, missing, unverified, observedDates,
    sourceRows, completed, unplaced, unidentified, recorded,
    unplacedCodes: Object.fromEntries(CENTER_KEYS.map(center => [center, [...unplacedCodes[center]].sort()])),
    rows: [...groups.values()].map(group => [
      group.id, group.center, group.count, group.latest, [...group.codes].sort(), [...group.vehicles].sort(),
      [...group.assignments].map(([code, vehicles]) => [code, [...vehicles].sort()]), group.dateMask.toString(16)
    ])
  };
}

const counts = () => ({ total: 0, delivered: 0, candidates: 0, candidateStores: 0, empty: 0, review: 0 });

function countCell(summary, group) {
  summary.total++;
  if (group.status === 'DELIVERED') summary.delivered++;
  else if (group.status === 'CANDIDATE') {
    summary.candidates++;
    summary.candidateStores += group.registered.length;
  } else if (group.status === 'EMPTY') summary.empty++;
  else summary.review++;
}

export function periodEvidence(window, center) {
  const dates = datesFor(window.end, window.days);
  const present = dates.filter(date => !window.missing.includes(date));
  const unverifiedDates = window.unverified[center];
  // Old published windows cannot attribute unverified source days to a particular center.
  const observed = window.observedDates?.[center] ?? (center === 'all' ? present
    : !window.recorded[center] || !unverifiedDates.length ? present.filter(date => !unverifiedDates.includes(date)) : null);
  const missingDates = observed ? dates.filter(date => !observed.includes(date)) : window.missing;
  return { totalDays: window.days, recordedDays: observed?.length ?? null, missingDates, unverifiedDates,
    latestRecorded: observed?.at(-1) || null, sourceMissingDates: window.missing,
    unidentifiedVisits: window.unidentified };
}

function countDays(mask) {
  let count = 0;
  for (let bits = mask; bits; bits &= bits - 1n) count++;
  return count;
}

export function prepareView(catalog, window, center, resolution) {
  const stores = catalog.byCode;
  const groups = new Map();
  const assignedToCenter = value => center === 'all' || value === center;
  function parent(id) {
    if (resolution === BASE_RESOLUTION) return id;
    if (!catalog.parents.has(id)) {
      catalog.parents.set(id, [4, 5, 6, 7].map(res => cellToParent(id, res)));
    }
    return catalog.parents.get(id)[resolution - 4];
  }
  const get = id => {
    if (!groups.has(id)) groups.set(id, {
      id, visits: 0, dateMask: 0n, exactDates: true, lastDelivery: null, registered: [], history: [], scope: null
    });
    return groups.get(id);
  };
  let registered = 0, missingStoreLocation = 0, unknownStoreCenter = 0;
  for (const store of catalog.stores) {
    if (!store.registered) continue;
    if (store.center === 'unknown') unknownStoreCenter++;
    if (!assignedToCenter(store.center)) continue;
    registered++;
    if (!store.cell) {
      missingStoreLocation++;
      continue;
    }
    get(parent(store.cell)).registered.push(store.code);
  }
  for (const row of window.rows) {
    const [id, observedCenter, count, date, , , , mask] = row;
    if (!assignedToCenter(observedCenter)) continue;
    const group = get(parent(id));
    group.visits += count;
    if (mask) group.dateMask |= BigInt('0x' + mask);
    else group.exactDates = false;
    if (!group.lastDelivery || date > group.lastDelivery) group.lastDelivery = date;
    group.history.push(row);
  }
  for (const scope of catalog.scopes) {
    if (scope.center === center && getResolution(scope.id) === resolution) get(scope.id).scope = scope;
  }
  const unplacedVisits = countFor(window.unplaced, center);
  const dateComplete = !window.missing.length && !window.unverified[center].length && !window.unidentified;
  const centerComplete = center === 'all' || (!window.recorded.unknown && !unknownStoreCenter);
  const absenceReady = catalog.registryVerified && dateComplete && centerComplete && !missingStoreLocation && !unplacedVisits;
  const observedCenters = new Set(CENTERS.slice(1).filter(key =>
    window.recorded[key] > window.unplaced[key] ||
    window.days > window.missing.length + window.unverified[key].length));
  const unplacedKnown = new Set(window.unplacedCodes
    ? CENTER_KEYS.filter(assignedToCenter).flatMap(key => window.unplacedCodes[key]) : []);
  // When an old snapshot cannot link unplaced visits to customers, keep its
  // potential candidates unknown. A newer snapshot can exclude the affected cells.
  const candidateEvidence = !window.unidentified && (!unplacedVisits || !!window.unplacedCodes);
  const summary = { ...counts(), registered, located: registered - missingStoreLocation,
    missingStoreLocation, unplacedVisits, unidentifiedVisits: window.unidentified, visits: 0 };
  const delivered = [], baseCandidates = [];
  for (const group of groups.values()) {
    const provenScope = absenceReady && !!group.scope;
    const observedCandidate = candidateEvidence && group.registered.length > 0 && group.registered.every(code =>
      observedCenters.has(stores.get(code).center) && !unplacedKnown.has(code));
    if (group.visits) group.status = 'DELIVERED';
    else if (group.registered.length && (observedCandidate || provenScope)) group.status = 'CANDIDATE';
    else if (!group.registered.length && provenScope) group.status = 'EMPTY';
    else group.status = 'UNKNOWN';
    const sample = group.registered.find(code => stores.get(code)?.address) ||
      group.history.flatMap(row => row[4]).find(code => stores.get(code)?.address);
    group.address = stores.get(sample)?.address || '';
    group.administrative = administrativeArea(group.address);
    group.label = group.scope?.label || [group.administrative.district, group.administrative.locality].filter(Boolean).join(' ') ||
      stores.get(sample)?.area || '행정구역 미확인';
    group.geometry = geometryFor(catalog, group.id);
    group.vehicles = [...new Set(group.history.flatMap(row => row[5]))].sort();
    group.deliveryDays = group.exactDates ? countDays(group.dateMask) : null;
    if (group.status === 'DELIVERED') delivered.push(group);
    if (resolution === BASE_RESOLUTION && group.status === 'CANDIDATE') baseCandidates.push(group);
    countCell(summary, group);
    summary.visits += group.visits;
  }
  delivered.sort((a, b) => a.geometry.location[0] - b.geometry.location[0]);
  return {
    groups, stores, summary, delivered, baseCandidates, nearby: new Map(), lists: new Map(),
    evidence: periodEvidence(window, center),
    proof: { dateComplete, centerComplete, registryVerified: catalog.registryVerified,
      scopedCells: catalog.scopes.filter(scope => scope.center === center && getResolution(scope.id) === resolution).length }
  };
}

function card(group) {
  return {
    id: group.id,
    label: group.label,
    status: group.status,
    visits: group.visits,
    registered: group.registered.length,
    lastDelivery: group.lastDelivery,
    candidate: group.status === 'CANDIDATE',
    location: group.geometry.location
  };
}

function cellBounds(polygon) {
  const lat = polygon.map(point => point[0]);
  const lng = polygon.map(point => point[1]);
  return [Math.min(...lng), Math.min(...lat), Math.max(...lng), Math.max(...lat)];
}

function geometryFor(catalog, id) {
  if (!catalog.geometry.has(id)) {
    const boundary = cellToBoundary(id);
    if (catalog.geometry.size >= 12_000) catalog.geometry.delete(catalog.geometry.keys().next().value);
    catalog.geometry.set(id, { boundary, bounds: cellBounds(boundary), location: cellToLatLng(id) });
  }
  return catalog.geometry.get(id);
}

function intersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function viewportCells(view, bounds, limit = MAX_VISIBLE_CELLS) {
  const cells = [];
  const summary = counts();
  for (const group of view.groups.values()) {
    if (!intersects(bounds, group.geometry.bounds)) continue;
    countCell(summary, group);
    if (cells.length < limit) cells.push({ ...card(group), boundary: group.geometry.boundary });
  }
  return { cells, summary, overflow: summary.total > limit };
}

// Count the original candidates even when a larger cell also contains deliveries.
export function viewportCandidates(baseView, bounds, resolution) {
  const groups = new Map();
  let cells = 0, stores = 0;
  for (const candidate of baseView.baseCandidates) {
    if (!intersects(bounds, candidate.geometry.bounds)) continue;
    cells++;
    stores += candidate.registered.length;
    if (resolution === BASE_RESOLUTION) continue;
    const parent = cellToParent(candidate.id, resolution);
    const location = candidate.geometry.location;
    const [lat, lng] = location;
    const centered = lng >= bounds[0] && lng <= bounds[2] && lat >= bounds[1] && lat <= bounds[3];
    let group = groups.get(parent);
    if (!group) groups.set(parent, group = { id: candidate.id, location, cells: 0, centered });
    else if (centered && !group.centered) Object.assign(group, { id: candidate.id, location, centered });
    group.cells++;
  }
  const markers = Array.from(groups.values()).slice(0, MAX_VISIBLE_CELLS).map(({ id, location, cells }) => ({ id, location, cells }));
  return { cells, stores, groups: groups.size, markers };
}

function nearbyDelivery(view, id, point) {
  const cached = !point && view.nearby.get(id);
  if (cached) return cached;
  const location = point || view.groups.get(id)?.geometry.location || cellToLatLng(id);
  const lat = location[0], groups = view.delivered;
  const adjacent = gridDisk(id, 1).filter(neighbor => neighbor !== id && view.groups.get(neighbor)?.visits);
  // Look only at observed delivery cells. Latitude difference bounds the
  // possible straight-line distance, so distant rows need no calculation.
  let low = 0, high = groups.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (groups[mid].geometry.location[0] < lat) low = mid + 1;
    else high = mid;
  }
  let left = low - 1, right = low, nearest = null, distance = Infinity;
  while (left >= 0 || right < groups.length) {
    const below = left >= 0 ? lat - groups[left].geometry.location[0] : Infinity;
    const above = right < groups.length ? groups[right].geometry.location[0] - lat : Infinity;
    if (Math.min(below, above) * 110_000 > distance) break;
    const group = below <= above ? groups[left--] : groups[right++];
    if (group.id === id) continue;
    const next = greatCircleDistance(location, group.geometry.location, UNITS.m);
    if (next < distance || next === distance && group.id < nearest.id) {
      nearest = group;
      distance = next;
    }
  }
  const historicVehicles = [...new Set(adjacent.flatMap(neighbor => view.groups.get(neighbor).vehicles))].sort();
  const vehicles = historicVehicles.length ? historicVehicles : nearest?.vehicles || [];
  const result = { adjacentCount: adjacent.length,
    nearest: nearest ? { id: nearest.id, label: nearest.label, distanceMeters: Math.round(distance) } : null,
    vehicles: vehicles.slice(0, 8), vehicleCount: vehicles.length, vehicleScope: historicVehicles.length ? 'adjacent' : 'nearest' };
  if (!point) {
    if (view.nearby.size >= 1024) view.nearby.delete(view.nearby.keys().next().value);
    view.nearby.set(id, result);
  }
  return result;
}

export function coverageList(view, filter = 'candidate', offset = 0) {
  if (!view.lists.has(filter)) {
    const status = COVERAGE_LIST_FILTERS[filter];
    view.lists.set(filter, [...view.groups.values()].filter(group => group.status === status).sort((a, b) =>
      b.registered.length - a.registered.length || b.visits - a.visits || a.id.localeCompare(b.id)));
  }
  const ranked = view.lists.get(filter);
  const rows = ranked.slice(offset, offset + 12).map(group => ({ ...card(group), nearby: nearbyDelivery(view, group.id) }));
  const next = offset + rows.length < ranked.length ? offset + rows.length : null;
  return { filter, total: ranked.length, rows, next };
}

export function cellDetail(view, id, offset = 0) {
  const group = view.groups.get(id);
  if (!group) return {
    id, label: '행정구역 미확인', status: 'UNKNOWN', visits: 0, registered: 0, customers: 0,
    lastDelivery: null, candidate: false, location: cellToLatLng(id), vehicles: [], stores: [], next: null,
    deliveryDays: null, administrative: { district: null, locality: null }, evidence: view.evidence, nearby: nearbyDelivery(view, id)
  };
  const registered = new Set(group.registered);
  const members = new Set(registered);
  for (const row of group.history) {
    for (const code of row[4]) members.add(code);
  }
  const codes = [...members].sort();
  const page = codes.slice(offset, offset + 40);
  const assignments = new Map(page.map(code => [code, new Set()]));
  for (const row of group.history) {
    for (const [code, cars] of row[6]) {
      const selected = assignments.get(code);
      if (selected) for (const vehicle of cars) selected.add(vehicle);
    }
  }
  const stores = page.map(code => {
    const row = view.stores.get(code);
    return { code, name: row?.name || code, registered: registered.has(code), vehicles: [...assignments.get(code)].sort() };
  });
  return { ...card(group), address: group.address, administrative: group.administrative, customers: members.size,
    vehicles: group.vehicles, deliveryDays: group.deliveryDays, evidence: view.evidence, nearby: nearbyDelivery(view, id), stores,
    next: offset + stores.length < codes.length ? offset + stores.length : null };
}

const searchKey = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s·]/g, '');

export function coverageAtPoint(catalog, view, location, center, radius = 0) {
  const id = latLngToCell(...location, BASE_RESOLUTION);
  const group = view.groups.get(id);
  const registeredWithin = { 500: 0, 1000: 0 };
  for (const store of catalog.stores) {
    if (!store.registered || !store.cell || center !== 'all' && store.center !== center ||
        Math.abs(store.lat - location[0]) > .01 || Math.abs(store.lng - location[1]) > .014) continue;
    const meters = greatCircleDistance(location, [store.lat, store.lng], UNITS.m);
    if (meters <= 1000) registeredWithin[1000]++;
    if (meters <= 500) registeredWithin[500]++;
  }
  return { id, location, stats: { visits: group?.visits || 0, registered: group?.registered.length || 0,
    vehicles: group?.vehicles || [], lastDelivery: group?.lastDelivery || null, status: group?.status || 'UNKNOWN',
    nearby: nearbyDelivery(view, id, location), registeredWithin, nearbyRegistered: radius ? registeredWithin[radius] : null } };
}

export function searchCoverage(catalog, view, query, center, radius = 0) {
  const key = searchKey(query);
  const rows = [];
  for (const store of catalog.stores) {
    const address = searchKey(store.address);
    if (center !== 'all' && store.center !== center && address !== key) continue;
    const exact = store.code.toLowerCase() === key;
    if (exact || searchKey(store.name).includes(key) || address.includes(key)) {
      rows.push({ store, rank: exact ? 0 : searchKey(store.name) === key || address === key ? 1 : 2 });
    }
  }
  rows.sort((a, b) => a.rank - b.rank || Number(!a.store.cell) - Number(!b.store.cell));
  const regions = catalog.regions.filter(region => [region.name, region.query].some(value => {
    const text = searchKey(value);
    return text && (text === key || text.includes(key));
  })).sort((a, b) => Number(searchKey(a.query) !== key) - Number(searchKey(b.query) !== key)).slice(0, 5);
  const stats = location => location ? coverageAtPoint(catalog, view, location, center, radius)
    : { location: null, id: null, stats: null };
  return [
    ...rows.slice(0, 12).map(({ store }) => ({
      kind: 'store', code: store.code, name: store.name, address: store.address,
      ...stats(store.cell ? [store.lat, store.lng] : null)
    })),
    ...regions.map(region => ({
      kind: 'region', name: region.name, bounds: region.bounds, ...stats(region.location)
    }))
  ];
}
