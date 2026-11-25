import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { open, realpath, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { gunzip as decompress, gzip as compress } from 'node:zlib';
import { boundedRead, datesFor, isDay, parseCoverageIndex, PERIODS, postalCompleteCenters, privateCoverageDirectory, readStoredCoverageFile } from './coverageFiles.js';
import { projectPostalOperations } from './postalOperations.js';
import { decodePostalTile, intersects, postalText, postalTilesLevel, postalTilePosition, POSTAL_AREA_BYTES, POSTAL_LEVELS,
  POSTAL_TILE_LIMIT } from '../../public/opsmap/postal-geometry.mjs';

const gunzip = promisify(decompress);
const gzip = promisify(compress);
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
export async function encodePostalTileResponse(chunks, rawLength, acceptGzip, timing, prefix) {
  // Archive tiles are independent gzip members. Chrome consumes only the first member of an HTTP gzip response.
  if (acceptGzip && !prefix && chunks.length === 1) return chunks[0];
  const started = performance.now();
  const decoded = await gunzip(Buffer.concat(chunks), { maxOutputLength:rawLength });
  requireValid(decoded.length === rawLength);
  if (timing) timing.postal_tile_inflate = performance.now() - started;
  const body = prefix ? Buffer.concat([prefix,decoded]) : decoded;
  if (!acceptGzip) return body;
  const compressing = performance.now();
  const encoded = await gzip(body, { level:1 });
  if (timing) timing.postal_tile_compress = performance.now() - compressing;
  return encoded;
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

async function openOverview(directory, proof, appRoot, boundary, baseTiles) {
  if (!directory && !proof) return null;
  requireValid(isAbsolute(directory || '') && sha.test(proof || ''));
  const folder = await privateCoverageDirectory(directory,appRoot);
  const index = JSON.parse(await verifiedRead(join(folder,'overview-index.json'),proof,64 * 1024));
  const originals = [...baseTiles.values()].filter(tile => tile.id.startsWith('national-'));
  requireValid(index?.schema === 'opsmap-postal-overview-v1' && index.boundary === boundary &&
    index.projection === 'EPSG:5181*2.5' && Array.isArray(index.tiles) && index.tiles.length === originals.length &&
    index.count === sum(originals.map(tile => tile.count)));
  const tiles = new Map();
  let offset = 0;
  for (const tile of index.tiles) {
    const id = tile?.id;
    const original = typeof id === 'string' && /^overview-\d{1,3}-\d{1,3}-\d{1,2}$/.test(id) &&
      baseTiles.get(id.replace('overview-','national-'));
    requireValid(original && !tiles.has(id) && tile.count === original.count && sha.test(tile.sha256) &&
      Number.isInteger(tile.vertices) && tile.vertices >= 3 * tile.count && tile.vertices <= original.rawBytes / 8 &&
      Number.isInteger(tile.rawBytes) && tile.rawBytes > 4 && tile.rawBytes <= POSTAL_TILE_LIMIT &&
      Number.isInteger(tile.bytes) && tile.bytes > 0 && tile.bytes <= POSTAL_TILE_LIMIT);
    if (index.archive) requireValid(tile.offset === offset);
    offset += tile.bytes;
    tiles.set(id,{ ...tile, box:original.box, folder });
  }
  requireValid(index.vertices === sum([...tiles.values()].map(tile => tile.vertices)));
  let archive;
  if (index.archive) {
    requireValid(index.archive.bytes === offset && offset <= 8 * 1024 * 1024 &&
      sha.test(index.archive.sha256));
    archive = join(folder,'overview-tiles.gz');
    const file = await stat(archive);
    requireValid(file.isFile() && file.size === offset);
  }
  return { tiles, proof, archive };
}

export function classifyPostalZone({ visits, registered, eligible, assignmentUnknown }, areaKm2) {
  const density = visits / areaKm2;
  return visits > 0 ? (density >= POSTAL_DENSITY_HIGH ? 'HIGH' : 'LOW')
    : !assignmentUnknown && registered > 0 && registered === eligible ? 'CANDIDATE' : 'UNKNOWN';
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

export function applyPostalAssignmentReview(review, release, releaseSha256, codes) {
  if (review?.schema !== 'opsmap-postal-assignment-review-v1' || review.generation !== release.generation ||
      review.boundary !== release.boundary || review.release !== releaseSha256) throw Error('POSTAL_ASSIGNMENT_REVIEW_INVALID');
  const effective = new Map(codes);
  for (const field of ['previousMismatch', 'unresolved', 'addressMismatch']) {
    if (!Array.isArray(review[field]) || review[field].length > codes.size) throw Error('POSTAL_ASSIGNMENT_REVIEW_INVALID');
    for (const code of review[field]) {
      const member = effective.get(code);
      if (!member?.registered || member.area === null) throw Error('POSTAL_ASSIGNMENT_REVIEW_INVALID');
      effective.set(code, { ...member, area:null, reviewArea:member.area });
    }
  }
  return effective;
}

export function createScope(release, codes, areas, days, center, totalAreas) {
  const period = release.periods[days], groups = new Map();
  const completeCenters = postalCompleteCenters(period, days);
  const unavailable = new Set(period.unavailableCodes.flatMap((codes, index) => inCenter(center, index) ? codes : []));
  const linked = keys => sum(keys.filter((_, i) => inCenter(center, i)));
  const summary = {
    areas: totalAreas, registered: 0, located: 0, visits: 0, recorded: linked(period.recorded),
    unplaced: linked(period.unplaced), boundaryUnplaced: linked(period.unplacedBoundary), unmatchedStores: 0,
    assignmentHeldStores: 0, assignmentHeldVisits: 0,
    high: 0, low: 0, candidate: 0, candidateStores: 0, unknown: totalAreas,
    scopedAreas: 0, unverifiedScopedAreas: 0,
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
    if (store.reviewArea !== undefined) {
      summary.assignmentHeldStores++;
      groupFor(store.reviewArea).assignmentUnknown = true;
    }
    if (store.area === null) { summary.unmatchedStores++; continue; }
    summary.located++;
    const group = groupFor(store.area);
    group.registered++;
    if (flags & 1) group.newActive++;
    if (flags & 2) group.newUnknown++;
    if (flags & 4) group.held++;
    if (flags & 8) group.newZero++;
    if (completeCenters.has(centers[store.center]) && !unavailable.has(code)) group.eligible++;
  }
  for (const [code, delivery] of period.rows) {
    const store = codes.get(code);
    for (const [origin, visits, latest, vehicles] of delivery) {
      if (!inCenter(center, origin)) continue;
      summary.visits += visits;
      if (store.reviewArea !== undefined) {
        summary.assignmentHeldVisits += visits;
        groupFor(store.reviewArea).assignmentUnknown = true;
        continue;
      }
      const group = groupFor(store.area);
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
    if (group.registered > 0 || group.visits > 0) summary.scopedAreas++;
    if (group.status === 'UNKNOWN') {
      if (group.registered > 0) summary.unverifiedScopedAreas++;
      continue;
    }
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

export function createPostalRuntime({ directory, boundarySha256, releaseSha256, appRoot, readDirectory, readPublication, detailsDirectory, detailsIndexSha256, readFixed, readOperations, readCurrentRegistration,
  overviewDirectory, overviewSha256, reviewDirectory, reviewSha256, assetSource,
  now = Date.now } = {}) {
  let loaded, loadFlight, indexFlight, resolvedIndex, indexChecked = 0, scope, bulk = 0;
  let storeDetails;
  let operationsLedger, operationsEnd, operationsScopes = new Map();
  const tileCache = new Map(), pending = new Map();
  const overviewPending = new Map();
  let tileBytes = 0, reads = 0;

  async function assets() {
    if (loaded) return loaded;
    if (!loadFlight) loadFlight = (async () => {
      const remote = await assetSource?.base();
      const rootDirectory = remote?.directory ?? directory;
      const reviewRoot = remote?.review ?? reviewDirectory;
      if (!isAbsolute(rootDirectory || '') || !sha.test(boundarySha256 || '') || !sha.test(releaseSha256 || '')) {
        throw Error('POSTAL_DATA_UNCONFIGURED');
      }
      if (!isAbsolute(reviewRoot || '') || !sha.test(reviewSha256 || '')) throw Error('POSTAL_ASSIGNMENT_REVIEW_UNCONFIGURED');
      const root = await privateCoverageDirectory(rootDirectory, appRoot);
      const geometry = remote ? await privateCoverageDirectory(remote.geometry, appRoot) : join(root, 'geometry');
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
      const [areas, compressed, overview, review] = await Promise.all([
        verifiedRead(join(geometry,'areas.bin'),manifest.areas.sha256,manifest.areas.bytes,manifest.areas.bytes),
        verifiedRead(join(root,'postal-release.json.gz'),releaseSha256,1024 * 1024),
        openOverview(remote?.overview ?? overviewDirectory,overviewSha256,appRoot,boundarySha256,tiles),
        privateCoverageDirectory(reviewRoot,appRoot)
          .then(folder => verifiedRead(join(folder,'postal-assignment-review.json'),reviewSha256,512 * 1024))
          .then(JSON.parse).catch(() => { throw Error('POSTAL_ASSIGNMENT_REVIEW_INVALID'); }),
      ]);
      const release = JSON.parse(await gunzip(compressed, { maxOutputLength: maxReleaseBytes }));
      const codes = applyPostalAssignmentReview(review,release,releaseSha256,checkRelease(release,boundarySha256,areas));
      return loaded = { manifest, tiles, areas, release, codes, geometry, overview };
    })().finally(() => { loadFlight = null; });
    return loadFlight;
  }

  async function activeIndex() {
    if (readPublication) {
      const publication = await readPublication();
      if (!publication?.index) throw Error('POSTAL_DATA_UNCONFIGURED');
      return publication;
    }
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

  async function verifiedRelease(expected, timing) {
    const started = performance.now();
    const publication = activeIndex();
    if (assetSource && (await publication).index.sha256 !== assetSource.config.generation) throw Error('POSTAL_GENERATION_MISMATCH');
    const [opened, { index }] = await Promise.all([assets(), publication]);
    if (timing) timing.postal_source = performance.now() - started;
    const { release } = opened;
    if (expected && expected !== index.sha256) throw Error('COVERAGE_GENERATION_CHANGED');
    if (release.generation !== index.sha256 || release.catalog !== index.catalog.sha256 || release.asOf !== index.asOf) {
      throw Error('POSTAL_GENERATION_MISMATCH');
    }
    return opened;
  }

  async function ready(days, center, expected, timing) {
    const opened = await verifiedRelease(expected,timing);
    const {release,areas,codes,manifest} = opened;
    const key = [days, center].join(':');
    const joined = performance.now();
    if (scope?.key !== key) {
      const next = createScope(release, codes, areas, days, center, manifest.count);
      scope = { key, ...next };
    }
    if (timing) timing.postal_scope = performance.now() - joined;
    return { ...opened, scope };
  }

  function cachedBytes(key) {
    const bytes = tileCache.get(key);
    if (bytes) {
      tileCache.delete(key);
      tileCache.set(key,bytes);
    }
    return bytes;
  }

  async function getTile(opened, tile) {
    const cached = cachedBytes(tile.id);
    if (cached) return cached;
    if (pending.has(tile.id)) return pending.get(tile.id);
    if (pending.size >= 12) throw Error('POSTAL_READ_BUSY');
    const work = (async () => {
      reads++;
      const directory = tile.folder || await assetSource?.tiles(tile.id.split('-', 1)[0]) || opened.geometry;
      const file = join(directory,tile.id + '.gz');
      const bytes = await verifiedRead(file, tile.sha256, tile.bytes, tile.bytes);
      retainTile(tile.id,bytes);
      return bytes;
    })().finally(() => pending.delete(tile.id));
    pending.set(tile.id, work);
    return work;
  }

  function retainTile(id, bytes) {
    if (bytes.length > POSTAL_TILE_CACHE_BYTES) return;
    const previous = tileCache.get(id);
    if (previous) {
      tileBytes -= previous.length;
      tileCache.delete(id);
    }
    while (tileCache.size && tileBytes + bytes.length > POSTAL_TILE_CACHE_BYTES) {
      const oldest = tileCache.keys().next().value;
      tileBytes -= tileCache.get(oldest).length;
      tileCache.delete(oldest);
    }
    tileCache.set(id,bytes);
    tileBytes += bytes.length;
  }

  async function readOverviewTiles(archive, files) {
    const chunks = new Map();
    const missing = [];
    for (const tile of files) {
      const cached = cachedBytes(tile.id);
      if (cached) chunks.set(tile.id,cached);
      else missing.push(tile);
    }
    if (missing.length) {
      missing.sort((a,b) => a.offset - b.offset);
      const key = missing.map(tile => tile.id).join(',');
      if (!overviewPending.has(key)) {
        const work = (async () => {
          const sections = [];
          for (const tile of missing) {
            const last = sections.at(-1);
            if (last?.end === tile.offset) {
              last.end += tile.bytes;
              last.tiles.push(tile);
            } else sections.push({ start:tile.offset,end:tile.offset + tile.bytes,tiles:[tile] });
          }
          const blocks = new Map();
          const handle = await open(archive,'r');
          try {
            for (const section of sections) {
              reads++;
              const buffer = Buffer.allocUnsafe(section.end - section.start);
              for (let at = 0; at < buffer.length;) {
                const { bytesRead } = await handle.read(buffer,at,buffer.length - at,section.start + at);
                requireValid(bytesRead > 0);
                at += bytesRead;
              }
              for (const tile of section.tiles) {
                const at = tile.offset - section.start;
                const bytes = buffer.subarray(at,at + tile.bytes);
                requireValid(hash(bytes) === tile.sha256);
                blocks.set(tile.id,Buffer.from(bytes));
              }
            }
          } finally { await handle.close(); }
          for (const [id,bytes] of blocks) retainTile(id,bytes);
          return blocks;
        })().finally(() => overviewPending.delete(key));
        overviewPending.set(key,work);
      }
      for (const [id,bytes] of await overviewPending.get(key)) chunks.set(id,bytes);
    }
    return files.map(tile => chunks.get(tile.id));
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
      opened.catalogSearch = activeIndex().then(async ({ index, folder, readCatalog }) => {
        if (index.sha256 !== opened.release.generation) throw Error('POSTAL_GENERATION_MISMATCH');
        let catalog;
        if (readCatalog) catalog = await readCatalog();
        else {
          const root = await privateCoverageDirectory(folder, appRoot);
          const ref = index.catalog;
          const bytes = await readStoredCoverageFile(join(root, ref.sha256 + '.json'), ref.bytes);
          requireValid(bytes.length === ref.bytes && hash(bytes) === ref.sha256);
          catalog = JSON.parse(bytes);
        }
        const { stores, regions } = catalog;
        requireValid(Array.isArray(stores) && stores.length <= 15000);
        return { stores, regions: Array.isArray(regions) ? regions : [] };
      }).catch(error => { delete opened.catalogSearch; throw error; });
    }
    return opened.catalogSearch;
  }

  async function detailReader() {
    const { createPostalDetailsReader } = await import('./postalDetails.js');
    const directory = await assetSource?.details() ?? detailsDirectory;
    return storeDetails ??= createPostalDetailsReader({ directory, indexSha256:detailsIndexSha256,
      releaseSha256, appRoot, readFixed, now });
  }

  function currentRegistrationSource(opened) {
    return {boundary:boundarySha256,release:releaseSha256,
      hasArea:id=>Boolean(findArea(opened.areas,id)),hasLegacyCode:code=>opened.codes.get(code)?.registered===true,
      readLegacy:async()=>{
        const {stores}=await catalogData(opened);
        return stores.flatMap(row=>{
          const assignment=opened.codes.get(row.code);
          return assignment?.registered?[{code:row.code,name:row.name,address:row.address,
            center:centers[assignment.center],id:assignment.reviewArea===undefined?assignment.area:null}]:[];
        });
      }};
  }

  return {
    async warm() { await ready(90,'all'); },
    async operations({days,center,generation,area,offset=0}) {
      const opened = await verifiedRelease(generation);
      const ledger = await readOperations?.();
      if (!ledger) throw Error('POSTAL_OPERATIONS_UNAVAILABLE');
      const end = new Date(now()+9*3600000-86400000).toISOString().slice(0,10);
      if (operationsLedger !== ledger || operationsEnd !== end) {
        operationsLedger = ledger;
        operationsEnd = end;
        operationsScopes = new Map();
      }
      const key = days + ':' + center;
      if (!operationsScopes.has(key)) {
        if (operationsScopes.size >= 4) operationsScopes.delete(operationsScopes.keys().next().value);
        operationsScopes.set(key,projectPostalOperations(ledger,opened.codes,{days,center,end}));
      }
      const {areas,...report} = operationsScopes.get(key);
      if (area === undefined) {
        const tones = [...areas].map(([id,{counts}])=>[id,counts.completed ? 'COMPLETED' : counts.dispatch ? 'DISPATCH' : counts.orders ? 'ORDER' : 'UNKNOWN']);
        return {...report,tones};
      }
      const match = areas.get(area);
      const {stores} = await catalogData(loaded);
      const {postalCustomerName} = await import('./postalDetails.js');
      const members = match ? stores.filter(row=>match.members.has(row.code)) : [];
      const limit=12;
      return {period:report.period,publishedThrough:report.publishedThrough,area:postalText(area),counts:match?.counts??null,
        total:members.length,offset,next:members.length>offset+limit?offset+limit:null,
        members:members.slice(offset,offset+limit).map(row=>({code:row.code,name:postalCustomerName(row),flags:match.members.get(row.code)}))};
    },
    async currentRegistration({generation,registry,center,area,offset}) {
      const opened=await verifiedRelease(generation);
      const data=await readCurrentRegistration({registry,center,area,offset,...currentRegistrationSource(opened)});
      const {index}=await activeIndex();
      if(index.sha256!==generation)throw Error('COVERAGE_GENERATION_CHANGED');
      return {...data,generation};
    },
    async dispatchOverlapPostcodes({generation,registry}) {
      const opened=await verifiedRelease(generation);
      const data=await readCurrentRegistration?.dispatchPostcodes?.({registry,...currentRegistrationSource(opened)});
      const {index}=await activeIndex();
      if(index.sha256!==generation)throw Error('COVERAGE_GENERATION_CHANGED');
      return data;
    },
    async dispatchPostcodes(customerCodes,generation) {
      const {codes} = await verifiedRelease(generation);
      const result = new Map();
      for (const code of customerCodes) {
        const match = codes.get(code);
        if (match?.registered && match.area != null && match.reviewArea === undefined) {
          result.set(code,postalText(match.area));
        }
      }
      return result;
    },
    async view({ days, center, generation, box, indexed, timing }) {
      const opened = await ready(days,center,generation,timing);
      const selectedAt = performance.now();
      const { scope, manifest, release } = opened;
      const tier = postalTilesLevel(box);
      const overview = tier === 'national' && indexed ? opened.overview : null;
      const selectedTiles = [...(overview?.tiles.values() || manifest.tiers[tier])]
        .filter(tile => intersects(tile.box,box));
      const data = {
        generation: release.generation, boundary: boundarySha256, assignmentReview:reviewSha256, source: manifest.source, tier,
        ...(readOperations ? {operationsAvailable:true} : {}),
        ...(readCurrentRegistration ? {currentRegistrationAvailable:true} : {}),
        period: { days, start: release.periods[days].start, end: release.asOf }, sourceObservedAt: release.sourceObservedAt,
        stale: now() - Date.parse(release.sourceObservedAt) > 36 * 3600000,
        densityHighAt: POSTAL_DENSITY_HIGH, completeness: scope.completeness, summary: scope.summary,
        ...(overview ? { overview:overview.proof } : {}),
        tiles: selectedTiles.map(({ id, rawBytes, vertices }) => overview ? [id,rawBytes,vertices] : [id,rawBytes]),
        tones: [...scope.groups].filter(([, group]) =>
          (group.status !== 'UNKNOWN' || group.registered > 0) && intersects(group.place.box, box))
          .map(([id, group]) => [id, group.status]),
        candidates: scope.candidates.slice(0, 24).map(([id]) => detail(opened, id)),
        badges: tier === 'national' ? [] : [...scope.groups].filter(([, group]) =>
          (group.newActive || group.newUnknown || group.held) && intersects(group.place.box, box))
          .slice(0, 180).map(([id, group]) => [id, group.place.location, group.newActive, group.newUnknown, group.held]),
      };
      if (timing) timing.postal_viewport = performance.now() - selectedAt;
      return data;
    },
    async tiles(ids, version, acceptGzip, timing, prefix) {
      const opened = await assets();
      const overview = opened.overview && version === opened.overview.proof ? opened.overview : null;
      const index = overview?.tiles || (version === boundarySha256 ? opened.tiles : null);
      if (!index || !ids.length || ids.length > 32 || new Set(ids).size !== ids.length) throw Error('POSTAL_QUERY_INVALID');
      const files = ids.map(id => index.get(id));
      if (files.some(file => !file)) throw Error('POSTAL_QUERY_INVALID');
      const rawLength = sum(files.map(file => file.rawBytes));
      if (rawLength > POSTAL_MAX_BATCH_BYTES) throw Error('POSTAL_QUERY_INVALID');
      const load = () => withBatch(async () => {
        const started = performance.now();
        const chunks = overview?.archive ? await readOverviewTiles(overview.archive,files) : [];
        if (!overview?.archive) {
          for (let i = 0; i < files.length; i += 2) {
            chunks.push(...await Promise.all(files.slice(i,i + 2).map(file => getTile(opened,file))));
          }
        }
        if (timing) timing.postal_tile_read = performance.now() - started;
        return encodePostalTileResponse(chunks,rawLength,acceptGzip,timing,prefix);
      });
      if (!prefix || !acceptGzip) return load();
      // Equal frames have the same verified geometry, generation, scope and status text.
      const started = performance.now();
      const key = 'frame:' + version + ':' + hash(prefix) + ':' + ids.join(',');
      const cached = cachedBytes(key) || pending.get(key);
      if (cached) {
        if (timing) timing.postal_frame_cache_lookup = performance.now() - started;
        return cached;
      }
      if (pending.size >= 12) throw Error('POSTAL_READ_BUSY');
      const work = load().then(bytes => { retainTile(key,bytes); return bytes; }).finally(() => pending.delete(key));
      pending.set(key,work);
      return work;
    },
    async area({ days, center, generation, id }) { return detail(await ready(days, center, generation), id); },
    async outline(id) {
      const opened = await assets();
      const area = findArea(opened.areas,id);
      if (!area) return null;
      return withBatch(async () => {
        for (const tile of opened.manifest.tiers.detail) {
          if (!intersects(tile.box,area.box)) continue;
          const bytes = await gunzip(await getTile(opened,tile),{maxOutputLength:POSTAL_TILE_LIMIT});
          const zone = decodePostalTile(bytes).find(row=>row.id===id);
          if (!zone) continue;
          return {id:postalText(id),box:area.box,rings:zone.rings.map(ring=>{
            const points=[];
            for (let i=0;i<ring.length;i+=2) points.push([ring[i]/1e6,ring[i+1]/1e6]);
            return points;
          })};
        }
        throw Error('POSTAL_RELEASE_INTEGRITY');
      });
    },
    async stores(args) {
      const opened = await ready(args.days,args.center,args.generation);
      const [reader, { stores }] = await Promise.all([detailReader(),catalogData(loaded)]);
      return reader.roster({ ...args, opened, catalog:stores });
    },
    async history(args) {
      const opened = await ready(args.days,args.center,args.generation);
      return (await detailReader()).history({ ...args, opened });
    },
    async point({ days, center, generation, lat, lng, radius, timing }) {
      const opened = await ready(days,center,generation,timing);
      return withBatch(async () => {
        const started = performance.now();
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
        if (timing) timing.postal_point_join = performance.now() - started;
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
          location: bound.area ? [row.lat, row.lng] : null, assignmentPending: bound.area === null, area, rank });
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
