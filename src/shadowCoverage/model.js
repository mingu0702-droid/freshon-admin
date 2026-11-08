import { cellToBoundary, cellToLatLng, cellToParent, getResolution, greatCircleDistance, isValidCell, latLngToCell, UNITS } from 'h3-js';

export const PERIODS = [30, 60, 90];
export const CENTERS = ['all', 'osan', 'yeongnam', 'honam'];
export const BASE_RESOLUTION = 8;
export const MAX_VISIBLE_CELLS = 360;
const DAY = 86_400_000;
const MAX_STORES = 15_000;
const MAX_LEAF_ROWS = 24_000;
const CENTER_KEYS = [...CENTERS.slice(1), 'unknown'];
const CODE = /^[A-Z]\d{1,20}$/;
const SHA = /^[a-f0-9]{64}$/;
const PROTECTED = /[\u0000-\u001f]|비밀번호|보안키|공동현관|bearer\s|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/i;

export function isDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function datesFor(end, days) {
  if (!isDay(end) || !PERIODS.includes(days)) throw Error('COVERAGE_PERIOD_INVALID');
  return Array.from({ length: days }, (_, index) =>
    new Date(Date.parse(end) - (days - 1 - index) * DAY).toISOString().slice(0, 10));
}

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
  for (const [identity, code, vehicle, center, addressHash] of doc.visits) {
    if (!SHA.test(identity) || !CODE.test(code) || seen.has(identity) || !CENTER_KEYS.includes(center)) {
      throw Error('COVERAGE_VISIT_IDENTITY');
    }
    seen.add(identity);
    recorded[center]++;
    const store = stores.get(code);
    if (!store?.cell || !store.matchHash || addressHash !== store.matchHash) {
      unplaced[center]++;
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
  let sourceRows = 0, completed = 0, unidentified = 0, latest = null;
  for (const date of required) {
    const day = daily.get(date);
    if (!day) {
      missing.push(date);
      continue;
    }
    for (const center of CENTERS) {
      const verified = center === 'all' ? day.verifiedCenters.length === 3 : day.verifiedCenters.includes(center);
      if (!verified) unverified[center].push(date);
    }
    latest = date;
    sourceRows += day.sourceRows;
    completed += day.completed;
    unidentified += day.unidentified;
    for (const center of CENTER_KEYS) {
      unplaced[center] += day.unplaced[center];
      recorded[center] += day.recorded[center];
    }
    for (const [id, center, count, codes, vehicles, assignments] of day.rows) {
      const key = id + ':' + center;
      if (!groups.has(key)) groups.set(key, {
        id, center, count: 0, codes: new Set(), vehicles: new Set(), assignments: new Map()
      });
      const group = groups.get(key);
      group.count += count;
      group.latest = date;
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
    days, start: required[0], end, latest, missing, unverified, sourceRows, completed, unplaced, unidentified, recorded,
    rows: [...groups.values()].map(group => [
      group.id, group.center, group.count, group.latest, [...group.codes].sort(), [...group.vehicles].sort(),
      [...group.assignments].map(([code, vehicles]) => [code, [...vehicles].sort()])
    ])
  };
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
      id, visits: 0, lastDelivery: null, registered: [], history: [], scope: null
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
    const [id, observedCenter, count, date] = row;
    if (!assignedToCenter(observedCenter)) continue;
    const group = get(parent(id));
    group.visits += count;
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
  const summary = { total: 0, delivered: 0, undelivered: 0, review: 0, registered, missingStoreLocation, unplacedVisits, visits: 0 };
  for (const group of groups.values()) {
    group.status = group.visits ? 'DELIVERED' : absenceReady && group.scope
      ? (group.registered.length ? 'UNDLVRD' : 'EMPTY') : 'UNKNOWN';
    const sample = group.registered[0] || group.history[0]?.[4][0];
    group.label = group.scope?.label || stores.get(sample)?.area || '행정구역 미확인';
    group.geometry = geometryFor(catalog, group.id);
    summary.total++;
    summary.visits += group.visits;
    if (group.status === 'DELIVERED') summary.delivered++;
    else if (group.status === 'UNKNOWN') summary.review++;
    else summary.undelivered++;
  }
  return {
    groups, stores, summary,
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
    candidate: group.status === 'UNDLVRD' || group.status === 'EMPTY',
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
  for (const group of view.groups.values()) {
    if (!intersects(bounds, group.geometry.bounds)) continue;
    if (cells.length >= limit) return { cells, overflow: true };
    cells.push({ ...card(group), boundary: group.geometry.boundary });
  }
  return { cells, overflow: false };
}

export function cellDetail(view, id, offset = 0) {
  const group = view.groups.get(id);
  if (!group) return {
    id, label: '행정구역 미확인', status: 'UNKNOWN', visits: 0, registered: 0, customers: 0,
    lastDelivery: null, candidate: false, location: cellToLatLng(id), vehicles: [], stores: [], next: null
  };
  const registered = new Set(group.registered);
  const members = new Set(registered);
  const vehicles = new Set();
  for (const row of group.history) {
    for (const code of row[4]) members.add(code);
    for (const vehicle of row[5]) vehicles.add(vehicle);
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
  const address = view.stores.get(codes.find(code => view.stores.get(code)?.address))?.address || '';
  return { ...card(group), address, customers: members.size, vehicles: [...vehicles].sort(), stores,
    next: offset + stores.length < codes.length ? offset + stores.length : null };
}

const searchKey = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s·]/g, '');

export function searchCoverage(catalog, view90, query, center, radius = 0) {
  const key = searchKey(query);
  const rows = [];
  for (const store of catalog.stores) {
    if (center !== 'all' && store.center !== center) continue;
    const exact = store.code.toLowerCase() === key;
    if (exact || searchKey(store.name).includes(key) || searchKey(store.address).includes(key)) {
      rows.push({ store, rank: exact ? 0 : searchKey(store.name) === key ? 1 : 2 });
    }
  }
  rows.sort((a, b) => a.rank - b.rank || Number(!a.store.cell) - Number(!b.store.cell));
  const regions = catalog.regions.filter(region => [region.name, region.query].some(value => {
    const text = searchKey(value);
    return text && (text === key || text.includes(key));
  })).sort((a, b) => Number(searchKey(a.query) !== key) - Number(searchKey(b.query) !== key)).slice(0, 5);
  const searchStats = (id, location) => {
    if (!id) return null;
    const group = view90.groups.get(id);
    const nearbyRegistered = radius ? catalog.stores.filter(store =>
      store.registered && store.cell && (center === 'all' || store.center === center) &&
      Math.abs(store.lat - location[0]) < radius / 100_000 &&
      Math.abs(store.lng - location[1]) < radius / 75_000 &&
      greatCircleDistance(location, [store.lat, store.lng], UNITS.m) <= radius).length : null;
    return { visits: group?.visits || 0, registered: group?.registered.length || 0,
      vehicles: [...new Set(group?.history.flatMap(row => row[5]) || [])].sort(),
      lastDelivery: group?.lastDelivery || null, status: group?.status || 'UNKNOWN', nearbyRegistered };
  };
  return [
    ...rows.slice(0, 12).map(({ store }) => {
      const location = store.cell ? [store.lat, store.lng] : null;
      return { kind: 'store', code: store.code, name: store.name, address: store.address,
        location, id: store.cell, stats: searchStats(store.cell, location) };
    }),
    ...regions.map(region => {
      const id = region.location ? latLngToCell(...region.location, BASE_RESOLUTION) : null;
      return { kind: 'region', name: region.name, bounds: region.bounds, location: region.location,
        id, stats: searchStats(id, region.location) };
    })
  ];
}
