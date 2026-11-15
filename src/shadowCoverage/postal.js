import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzip as decompress } from 'node:zlib';
import { boundedRead, datesFor, isDay, parseCoverageIndex, PERIODS, privateCoverageDirectory, readStoredCoverageFile } from './coverageFiles.js';
import { decodePostalTile, intersects, postalText, postalTilesLevel, postalTilePosition, POSTAL_AREA_BYTES, POSTAL_LEVELS,
  POSTAL_TILE_LIMIT } from '../../public/opsmap/postal-geometry.mjs';

const gunzip = promisify(decompress);
const sha = /^[0-9a-f]{64}$/;
const codePattern = /^[A-Z]\d{1,20}$/;
const centers = ['osan', 'yeongnam', 'honam', 'unknown'];
const maxReleaseBytes = 5 * 1024 * 1024;
export const POSTAL_TILE_CACHE_BYTES = 4 * 1024 * 1024;
export const POSTAL_DENSITY_HIGH = 100;
export const POSTAL_MAX_BATCH_BYTES = 6 * 1024 * 1024;
const tileID = /^(?:national|regional|detail)-\d{1,3}-\d{1,3}-\d{1,2}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const empty = Object.freeze({ visits: 0, registered: 0, latest: null, newActive: 0, newUnknown: 0, newZero: 0, held: 0 });
const keyFor = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s·]/g, '');
const inCenter = (center, index) => center === 'all' || centers[index] === center;
const sum = values => values.reduce((a, b) => a + b, 0);

function requireValid(value) {
  if (!value) throw Error('POSTAL_RELEASE_INTEGRITY');
}
function numericTuple(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}
export function postalBounds(box) {
  return numericTuple(box, 4) && box[0] >= -180 && box[1] >= -90 && box[2] <= 180 && box[3] <= 90 &&
    box[0] < box[2] && box[1] < box[3];
}
async function verifiedRead(path, proof, limit, length) {
  const bytes = await boundedRead(path, limit);
  requireValid((length === undefined || bytes.length === length) && hash(bytes) === proof);
  return bytes;
}

export function classifyPostalZone({ visits, registered, eligible }, areaKm2) {
  const density = visits / areaKm2;
  return visits > 0 ? (density >= POSTAL_DENSITY_HIGH ? 'HIGH' : 'LOW')
    : registered > 0 && registered === eligible ? 'CANDIDATE' : 'UNKNOWN';
}

function readArea(buffer, offset) {
  return {
    id: buffer.readUInt32LE(offset),
    location: [buffer.readInt32LE(offset + 4) / 1e6, buffer.readInt32LE(offset + 8) / 1e6],
    areaKm2: buffer.readDoubleLE(offset + 12),
    box: Array.from({ length: 4 }, (_, i) => buffer.readInt32LE(offset + 20 + i * 4) / 1e6),
  };
}
function findArea(areas, id) {
  let lo = 0, hi = areas.length / POSTAL_AREA_BYTES;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const offset = mid * POSTAL_AREA_BYTES;
    const candidate = areas.readUInt32LE(offset);
    if (candidate === id) return readArea(areas, offset);
    if (candidate < id) lo = mid + 1;
    else hi = mid;
  }
  return null;
}

function registeredWithin(stores, codes, center, location, radius) {
  const [lat, lng] = location;
  const toRad = Math.PI / 180;
  const latLimit = radius / 110000;
  const lngLimit = latLimit / Math.cos(lat * toRad);
  let count = 0;
  for (const row of stores) {
    const store = codes.get(row.code);
    if (!store?.registered || !store.area || !inCenter(center, store.center) ||
        !Number.isFinite(row.lat) || !Number.isFinite(row.lng) ||
        Math.abs(row.lat - lat) > latLimit || Math.abs(row.lng - lng) > lngLimit) continue;
    const latitude = Math.sin((row.lat - lat) * toRad / 2) ** 2;
    const longitude = Math.sin((row.lng - lng) * toRad / 2) ** 2;
    const cross = Math.cos(lat * toRad) * Math.cos(row.lat * toRad);
    if (12742017.6 * Math.asin(Math.sqrt(latitude + cross * longitude)) <= radius) count++;
  }
  return count;
}

function checkRelease(release, boundary, areas) {
  requireValid(release?.schema === 'opsmap-postal-release-v1' && sha.test(release.generation) &&
    sha.test(release.catalog) && release.boundary === boundary && isDay(release.asOf) &&
    Number.isFinite(Date.parse(release.sourceObservedAt)) && Array.isArray(release.stores) && release.stores.length <= 15000);
  const codes = new Map();
  for (const [code, area, registered, center] of release.stores) {
    requireValid(codePattern.test(code) && !codes.has(code) && typeof registered === 'boolean' &&
      Number.isInteger(center) && center >= 0 && center <= 3 && (area === null || findArea(areas, area)));
    codes.set(code, { area, registered, center });
  }
  const validDateList = (value, expected) => Array.isArray(value) && new Set(value).size === value.length &&
    value.every(date => expected.has(date));
  for (const days of PERIODS) {
    const period = release.periods[days], dates = datesFor(release.asOf, days);
    const inWindow = new Set(dates);
    const validPeriodCounts = counts => numericTuple(counts, 4) && counts.every(n => Number.isSafeInteger(n) && n >= 0);
    requireValid(period?.start === dates[0] && period.end === dates.at(-1) && validDateList(period.missing, inWindow) &&
      ['all', ...centers.slice(0, 3)].every(center => validDateList(period.observed?.[center], inWindow) &&
      validDateList(period.unverified?.[center], inWindow)) &&
      validPeriodCounts(period.recorded) && validPeriodCounts(period.unplaced) && validPeriodCounts(period.unplacedBoundary) &&
      period.complete === sum(period.recorded) && Array.isArray(period.unavailableCodes) && period.unavailableCodes.length === 4 &&
      period.unavailableCodes.every(list => Array.isArray(list) && list.every(code => codes.has(code))) &&
      Number.isSafeInteger(period.unidentified) && period.unidentified >= 0 &&
      Array.isArray(period.rows) && period.rows.length <= codes.size && Array.isArray(period.states) && period.states.length <= codes.size);
    const matched = [0, 0, 0, 0], members = new Set();
    for (const [code, sources] of period.rows) {
      requireValid(codes.get(code)?.area && !members.has(code) && Array.isArray(sources) && sources.length > 0 && sources.length <= 4);
      members.add(code);
      const seen = new Set();
      for (const [center, count, latest, vehicles] of sources) {
        requireValid(Number.isInteger(center) && center >= 0 && center <= 3 && !seen.has(center) &&
          Number.isSafeInteger(count) && count > 0 && inWindow.has(latest) &&
          Array.isArray(vehicles) && vehicles.length <= 500 &&
          vehicles.every(vehicle => /^[A-Za-z가-힣0-9 -]{1,32}$/.test(vehicle)));
        seen.add(center);
        matched[center] += count;
      }
    }
    requireValid(matched.every((value, i) => value + period.unplaced[i] + period.unplacedBoundary[i] === period.recorded[i]));
    const states = new Set();
    const totals = [0, 0, 0, 0];
    for (const [code, flags] of period.states) {
      const active = flags & 11;
      requireValid(codes.get(code)?.registered && !states.has(code) && Number.isInteger(flags) && flags > 0 && flags < 16 &&
        [0, 1, 2, 8].includes(active));
      states.add(code);
      [1, 2, 4, 8].forEach((flag, i) => { if (flags & flag) totals[i]++; });
    }
    const { confirmedNewActive, newUnknown, held, newZero } = period.statusSummary || {};
    requireValid([confirmedNewActive, newUnknown, held, newZero].every((count, i) => count === totals[i]));
  }
  return codes;
}

function createScope(release, codes, areas, days, center, totalAreas) {
  const period = release.periods[days], groups = new Map();
  const observed = new Set(centers.filter(key => period.observed[key]?.length));
  const unavailable = new Set(period.unavailableCodes.flatMap((codes, index) => inCenter(center, index) ? codes : []));
  const linked = keys => sum(keys.filter((_, i) => inCenter(center, i)));
  const summary = {
    areas: totalAreas, registered: 0, located: 0, visits: 0, recorded: linked(period.recorded),
    unplaced: linked(period.unplaced), boundaryUnplaced: linked(period.unplacedBoundary), unmatchedStores: 0,
    high: 0, low: 0, candidate: 0, candidateStores: 0, unknown: totalAreas,
    newActive: 0, newUnknown: 0, newZero: 0, held: 0,
  };
  function groupFor(id) {
    if (!groups.has(id)) groups.set(id, { ...empty, eligible: 0, visited: new Set(), vehicles: new Set() });
    return groups.get(id);
  }
  const statuses = new Map(period.states);
  for (const [code, store] of codes) {
    if (!store.registered || !inCenter(center, store.center)) continue;
    summary.registered++;
    const flags = statuses.get(code) || 0;
    if (flags & 1) summary.newActive++;
    if (flags & 2) summary.newUnknown++;
    if (flags & 4) summary.held++;
    if (flags & 8) summary.newZero++;
    if (store.area === null) { summary.unmatchedStores++; continue; }
    summary.located++;
    const group = groupFor(store.area);
    group.registered++;
    if (flags & 1) group.newActive++;
    if (flags & 2) group.newUnknown++;
    if (flags & 4) group.held++;
    if (flags & 8) group.newZero++;
    if (observed.has(centers[store.center]) && !unavailable.has(code) && !period.unidentified) group.eligible++;
  }
  for (const [code, delivery] of period.rows) {
    for (const [origin, visits, latest, vehicles] of delivery) {
      if (!inCenter(center, origin)) continue;
      const group = groupFor(codes.get(code).area);
      group.visits += visits;
      group.visited.add(code);
      if (!group.latest || group.latest < latest) group.latest = latest;
      for (const vehicle of vehicles) group.vehicles.add(vehicle);
    }
  }
  for (const [id, group] of groups) {
    group.place = findArea(areas, id);
    const { areaKm2 } = group.place;
    group.status = classifyPostalZone(group, areaKm2);
    group.density = group.visits / areaKm2;
    summary.visits += group.visits;
    if (group.status === 'UNKNOWN') continue;
    summary.unknown--;
    summary[group.status.toLowerCase()]++;
    if (group.status === 'CANDIDATE') summary.candidateStores += group.registered;
  }
  const candidates = [...groups].filter(([, row]) => row.status === 'CANDIDATE')
    .sort((a, b) => b[1].registered - a[1].registered || a[0] - b[0]);
  const recorded = period.observed[center];
  return { groups, summary, candidates, completeness: {
    observed: recorded.length, missing: datesFor(release.asOf, days).filter(date => !recorded.includes(date)),
    sourceMissing: period.missing, unverified: period.unverified[center], unidentified: period.unidentified,
    centerObserved: Object.fromEntries(Object.entries(period.observed).map(([key, days]) => [key, days.length])),
  } };
}

export function createPostalRuntime({ directory, boundarySha256, releaseSha256, appRoot, readDirectory,
  now = Date.now } = {}) {
  let loaded, loadFlight, indexFlight, resolvedIndex, indexChecked = 0, scope, bulk = 0;
  const tileCache = new Map(), pending = new Map();
  let tileBytes = 0, reads = 0;

  async function assets() {
    if (loaded) return loaded;
    if (!loadFlight) loadFlight = (async () => {
      if (!isAbsolute(directory || '') || !sha.test(boundarySha256 || '') || !sha.test(releaseSha256 || '')) {
        throw Error('POSTAL_DATA_UNCONFIGURED');
      }
      const root = await privateCoverageDirectory(directory, appRoot);
      const geometry = join(root, 'geometry');
      const manifest = JSON.parse(await verifiedRead(join(geometry, 'manifest.json'), boundarySha256, 1024 * 1024));
      requireValid(manifest.schema === 'opsmap-postal-geometry-v1' && Number.isInteger(manifest.count) &&
        manifest.count > 0 && manifest.count <= 50000 &&
        typeof manifest.source?.url === 'string' && manifest.source.url.startsWith('https://') &&
        sha.test(manifest.areas?.sha256) && manifest.areas?.bytes === manifest.count * POSTAL_AREA_BYTES);
      const tiles = new Map();
      for (const tier of POSTAL_LEVELS) {
        const files = manifest.tiers?.[tier];
        requireValid(Array.isArray(files) && files.length > 0 && files.length <= 4096);
        let count = 0;
        for (const tile of files) {
          requireValid(tileID.test(tile.id) && tile.id.startsWith(tier + '-') && !tiles.has(tile.id) &&
            postalBounds(tile.box) && Number.isInteger(tile.count) && tile.count > 0 && tile.count <= 10000 &&
            Number.isInteger(tile.rawBytes) && tile.rawBytes <= POSTAL_TILE_LIMIT &&
            Number.isInteger(tile.bytes) && tile.bytes > 0 && tile.bytes <= POSTAL_TILE_LIMIT && sha.test(tile.sha256));
          tiles.set(tile.id, tile);
          count += tile.count;
        }
        requireValid(count === manifest.count);
      }
      const areas = await verifiedRead(join(geometry, 'areas.bin'), manifest.areas.sha256, manifest.areas.bytes, manifest.areas.bytes);
      const compressed = await verifiedRead(join(root, 'postal-release.json.gz'), releaseSha256, 1024 * 1024);
      const release = JSON.parse(await gunzip(compressed, { maxOutputLength: maxReleaseBytes }));
      const codes = checkRelease(release, boundarySha256, areas);
      return loaded = { manifest, tiles, areas, release, codes, geometry };
    })().finally(() => { loadFlight = null; });
    return loadFlight;
  }

  async function activeIndex() {
    if (resolvedIndex && now() - indexChecked < 10000) return resolvedIndex;
    if (!indexFlight) indexFlight = (async () => {
      const root = await readDirectory?.();
      const folder = await privateCoverageDirectory(root, appRoot);
      // The materialized ledger and postal release must describe the same publication.
      const index = parseCoverageIndex(await readStoredCoverageFile(join(folder, 'coverage-index.json'), 16_384));
      indexChecked = now();
      return resolvedIndex = { index, folder };
    })().finally(() => { indexFlight = null; });
    return indexFlight;
  }

  async function ready(days, center, expected) {
    const [opened, { index }] = await Promise.all([assets(), activeIndex()]);
    const { release, areas, codes, manifest } = opened;
    if (expected && expected !== index.sha256) throw Error('COVERAGE_GENERATION_CHANGED');
    if (release.generation !== index.sha256 || release.catalog !== index.catalog.sha256 || release.asOf !== index.asOf) {
      throw Error('POSTAL_GENERATION_MISMATCH');
    }
    const key = [days, center].join(':');
    if (scope?.key !== key) {
      const next = createScope(release, codes, areas, days, center, manifest.count);
      scope = { key, ...next };
    }
    return { ...opened, scope };
  }

  async function getTile(opened, tile) {
    if (tileCache.has(tile.id)) {
      const bytes = tileCache.get(tile.id);
      tileCache.delete(tile.id);
      tileCache.set(tile.id, bytes);
      return bytes;
    }
    if (pending.has(tile.id)) return pending.get(tile.id);
    if (pending.size >= 12) throw Error('POSTAL_READ_BUSY');
    const work = (async () => {
      reads++;
      const file = join(opened.geometry, tile.id + '.gz');
      const bytes = await verifiedRead(file, tile.sha256, tile.bytes, tile.bytes);
      while (tileCache.size && tileBytes + bytes.length > POSTAL_TILE_CACHE_BYTES) {
        const oldest = tileCache.keys().next().value;
        tileBytes -= tileCache.get(oldest).length;
        tileCache.delete(oldest);
      }
      tileCache.set(tile.id, bytes);
      tileBytes += bytes.length;
      return bytes;
    })().finally(() => pending.delete(tile.id));
    pending.set(tile.id, work);
    return work;
  }

  async function withBatch(work) {
    if (bulk >= 4) throw Error('POSTAL_READ_BUSY');
    bulk++;
    try { return await work(); } finally { bulk--; }
  }

  function detail(opened, id) {
    const row = opened.scope.groups.get(id);
    const area = row?.place ?? findArea(opened.areas, id);
    if (!area) return null;
    return { id: postalText(id), location: area.location, areaKm2: area.areaKm2, status: row?.status || 'UNKNOWN',
      visits: row?.visits || 0, registered: row?.registered || 0, visitedStores: row?.visited.size || 0,
      latest: row?.latest || null, density: row?.density || 0, vehicles: [...(row?.vehicles || [])].sort(),
      newActive: row?.newActive || 0, newUnknown: row?.newUnknown || 0, newZero: row?.newZero || 0, held: row?.held || 0 };
  }

  async function catalogData(opened) {
    if (!opened.catalogSearch) {
      // Lazy load of the already approved, digest-verified registry. The prepared postal release only contains IDs.
      opened.catalogSearch = activeIndex().then(async ({ index, folder }) => {
        if (index.sha256 !== opened.release.generation) throw Error('POSTAL_GENERATION_MISMATCH');
        const ref = index.catalog;
        const bytes = await readStoredCoverageFile(join(folder, ref.sha256 + '.json'), ref.bytes);
        requireValid(bytes.length === ref.bytes && hash(bytes) === ref.sha256);
        const { stores, regions } = JSON.parse(bytes);
        requireValid(Array.isArray(stores) && stores.length <= 15000);
        return { stores, regions: Array.isArray(regions) ? regions : [] };
      }).catch(error => { delete opened.catalogSearch; throw error; });
    }
    return opened.catalogSearch;
  }

  return {
    async warm() { await Promise.all([assets(), activeIndex()]); },
    async view({ days, center, generation, box }) {
      const opened = await ready(days, center, generation);
      const { scope, manifest, release } = opened;
      const tier = postalTilesLevel(box);
      const selectedTiles = manifest.tiers[tier].filter(tile => intersects(tile.box, box));
      return {
        generation: release.generation, boundary: boundarySha256, source: manifest.source, tier,
        period: { days, start: release.periods[days].start, end: release.asOf }, sourceObservedAt: release.sourceObservedAt,
        stale: now() - Date.parse(release.sourceObservedAt) > 36 * 3600000,
        densityHighAt: POSTAL_DENSITY_HIGH, completeness: scope.completeness, summary: scope.summary,
        tiles: selectedTiles.map(({ id, rawBytes }) => [id, rawBytes]),
        tones: [...scope.groups].filter(([, group]) => group.status !== 'UNKNOWN' && intersects(group.place.box, box))
          .map(([id, group]) => [id, group.status]),
        candidates: scope.candidates.slice(0, 24).map(([id]) => detail(opened, id)),
        badges: tier === 'national' ? [] : [...scope.groups].filter(([, group]) =>
          (group.newActive || group.newUnknown || group.held) && intersects(group.place.box, box))
          .slice(0, 180).map(([id, group]) => [id, group.place.location, group.newActive, group.newUnknown, group.held]),
      };
    },
    async tiles(ids, version, acceptGzip) {
      const opened = await assets();
      if (version !== boundarySha256 || !ids.length || ids.length > 32 || new Set(ids).size !== ids.length) throw Error('POSTAL_QUERY_INVALID');
      const files = ids.map(id => opened.tiles.get(id));
      if (files.some(file => !file) || sum(files.map(file => file.rawBytes)) > POSTAL_MAX_BATCH_BYTES) throw Error('POSTAL_QUERY_INVALID');
      return withBatch(async () => {
        const chunks = [];
        for (const file of files) chunks.push(await getTile(opened, file));
        const bytes = Buffer.concat(chunks);
        return acceptGzip ? bytes : gunzip(bytes, { maxOutputLength: POSTAL_MAX_BATCH_BYTES });
      });
    },
    async area({ days, center, generation, id }) { return detail(await ready(days, center, generation), id); },
    async point({ days, center, generation, lat, lng, radius }) {
      const opened = await ready(days, center, generation);
      return withBatch(async () => {
        let id = null, best = 0, ties = false;
        const box = [lng, lat, lng, lat];
        for (const tile of opened.manifest.tiers.detail) {
          if (!intersects(tile.box, box)) continue;
          const bytes = await gunzip(await getTile(opened, tile), { maxOutputLength: POSTAL_TILE_LIMIT });
          for (const zone of decodePostalTile(bytes)) {
            const result = postalTilePosition(zone, lng, lat);
            if (!result || result < best) continue;
            if (result > best) { id = zone.id; best = result; ties = false; }
            else ties = true;
          }
        }
        const area = ties || id === null ? null : detail(opened, id);
        if (area && radius) {
          const { stores } = await catalogData(loaded);
          area.nearby = { radius, registered: registeredWithin(stores, opened.codes, center, [lat, lng], radius) };
        }
        return { state: ties ? 'AMBIGUOUS' : id === null ? 'OUTSIDE' : 'MATCHED', area };
      });
    },
    async search({ days, center, generation, query }) {
      const opened = await ready(days, center, generation);
      const key = keyFor(query);
      if (/^\d{5}$/.test(key)) {
        const area = detail(opened, Number(key));
        return area ? [{ name: area.id + ' 우편번호', ...area, kind: 'area' }] : [];
      }
      const { stores, regions } = await catalogData(loaded);
      const exactCode = /^[a-z]\d{1,20}$/.test(key);
      const matches = [];
      for (const row of stores) {
        const address = keyFor(row.address), name = keyFor(row.name);
        const rank = exactCode ? (row.code.toLowerCase() === key ? 0 : -1) : address === key || name === key ? 1
          : name.includes(key) ? 2 : address.includes(key) ? 3 : -1;
        if (rank < 0) continue;
        const bound = opened.codes.get(row.code);
        if (!bound || !inCenter(center, bound.center) && !exactCode && address !== key) continue;
        const area = bound.area ? detail(opened, bound.area) : null;
        matches.push({ kind: 'store', code: row.code, name: row.name || row.code,
          location: bound.area ? [row.lat, row.lng] : null, area, rank });
      }
      if (matches.length || exactCode) return matches.sort((a, b) => a.rank - b.rank)
        .slice(0, 12).map(({ rank, ...item }) => ({ ...item, exact: rank < 2 }));
      return regions.filter(row => keyFor(row.name) === key || keyFor(row.query) === key).slice(0, 5)
        .filter(row => numericTuple(row.location, 2))
        .map(row => ({ kind: 'region', name: row.name, location: row.location, bounds: row.bounds }));
    },
    metrics() { return { tileBytes, tileEntries: tileCache.size, reads, pending: pending.size, scopes: Number(!!scope) }; },
  };
}
