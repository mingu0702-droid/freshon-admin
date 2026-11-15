import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';
import { boundedRead, PERIODS, privateCoverageDirectory } from '../src/shadowCoverage/coverageFiles.js';
import { openOpsmapSyncGenerationStore, syncHash, syncSha256 } from '../src/opsmapSyncGeneration.js';
import { readFreshonStoreStatusFile } from '../src/shadowCoverage/freshonStoreStatus.js';
import { encodePostalArea, encodePostalZone, exactPostalPosition, POSTAL_TILE_LIMIT } from '../public/opsmap/postal-geometry.mjs';

const args = process.argv.slice(2);
const [boundaryDirectory, boundaryProof, snapshotDirectory, statusFile, statusProof, target] = args;
if (args.length !== 6 || ![boundaryDirectory, snapshotDirectory, statusFile, target].every(isAbsolute) ||
    ![boundaryProof, statusProof].every(syncHash)) throw Error('POSTAL_BUILD_ARGUMENTS');
await privateCoverageDirectory(await realpath(dirname(target)), process.cwd());
await mkdir(target, { mode: 0o700 });
const tileDirectory = join(target, 'geometry');
await mkdir(tileDirectory, { mode: 0o700 });

const tileLevel = {
  national: { key: 'overview', span: 1.1 },
  regional: { key: 'regional', span: .34 },
  detail: { key: 'rings', span: .075 },
};
const centers = ['osan', 'yeongnam', 'honam', 'unknown'];
const korea = ([w, s, e, n]) => w >= 123 && s >= 32 && e <= 133 && n <= 40 && w < e && s < n;
const sum = values => values.reduce((a, b) => a + b, 0);

async function verified(file, sha, max) {
  const bytes = await boundedRead(file, max);
  if (syncSha256(bytes) !== sha) throw Error('POSTAL_BUILD_SOURCE_SHA256');
  return bytes;
}

function flatRings(geometry) {
  // Open rings are sufficient for rasterization and signed-edge checks.
  return geometry.flatMap(part => part.map(ring => ring.slice(0, -1)));
}

function boundUnion(a, b) {
  return !a ? b : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

const source = JSON.parse(await verified(join(boundaryDirectory, 'manifest.json'), boundaryProof, 32768));
const approvedSources = {
  SEOUL_WFS: ['서울시 공개 WFS 국가기초구역', 'https://energyinfo.seoul.go.kr/gis/wfs?service=WFS&version=2.0.0&request=GetCapabilities', 'WFS 2.0.0 / magok:tl_kodis_bas'],
  MOIS_15050416: ['행정안전부 구역의 도형 국가기초구역', 'https://www.data.go.kr/data/15050416/fileData.do', 'TL_KODIS_BAS'],
  VWORLD_30054: ['브이월드 국가기초구역', 'https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=MK&dsId=30054', 'TL_KODIS_BAS'],
};
if (source.schema !== 'opsmap-postal-boundaries-v1' || !Object.hasOwn(approvedSources, source.origin) ||
    !Array.isArray(source.regions) || ![16, 17].includes(source.regions.length) || source.origin !== 'SEOUL_WFS' &&
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(source.vintage)) throw Error('POSTAL_BUILD_BOUNDARY_MANIFEST');
const input = await openOpsmapSyncGenerationStore(snapshotDirectory);
const generation = await input.read();
if (!generation || generation.index.kind !== 'OBSERVED') throw Error('POSTAL_BUILD_GENERATION');
const { index, registry, catalog, state } = generation;
const stores = new Map(), buckets = new Map();
const bucket = .125;
const bucketKey = (x, y) => x + ',' + y;
for (const row of catalog.stores) {
  if (stores.has(row.code) || !/^[A-Z]\d{1,20}$/.test(row.code)) throw Error('POSTAL_BUILD_STORE_ID');
  const record = { ...row, position: registry.get(row.code)?.hasPoint !== false &&
    Number.isFinite(row.lat) && Number.isFinite(row.lng), match: null, ambiguous: false, relation: 0 };
  stores.set(row.code, record);
  if (!record.position) continue;
  const key = bucketKey(Math.floor(row.lng / bucket), Math.floor(row.lat / bucket));
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(record);
}

function matchStores(zone) {
  const [w,s,e,n] = zone.bbox;
  let relation;
  for (let y = Math.floor(s/bucket); y <= Math.floor(n/bucket); y++) {
    for (let x = Math.floor(w/bucket); x <= Math.floor(e/bucket); x++) {
      for (const row of buckets.get(bucketKey(x, y)) || []) {
        if (row.lng < w || row.lng > e || row.lat < s || row.lat > n) continue;
        relation ??= exactPostalPosition(zone.rings);
        const hit = relation(row.lng, row.lat);
        if (!hit || hit < row.relation) continue;
        if (hit > row.relation) Object.assign(row, { relation: hit, match: Number(zone.id), ambiguous: false });
        else row.ambiguous = true;
      }
    }
  }
}

const areas = new Map(), tileGroups = new Map();
const hasRegion = code => source.regions.some(row => row.basename === 'postal-' + code + '.ndjson');
if (!['11', '26', '27', '28', '30', '31', '36', '41', '43', '44', '47', '48', '50'].every(hasRegion) ||
    !(hasRegion('42') || hasRegion('51')) || !(hasRegion('45') || hasRegion('52')) ||
    !(hasRegion('53') || hasRegion('29') && hasRegion('46'))) throw Error('POSTAL_BUILD_BOUNDARY_EXTENT');
const regionIds = new Set();
for (const region of source.regions) {
  const name = region.basename;
  if (!/^postal-\d{2}\.ndjson$/.test(name) || regionIds.has(name) || !syncHash(region.sha256) ||
      !syncHash(region.sourceSha256) || !Number.isInteger(region.count) || !Number.isInteger(region.bytes)) {
    throw Error('POSTAL_BUILD_BOUNDARY_REGION');
  }
  regionIds.add(name);
  const hash = createHash('sha256');
  const file = createReadStream(join(boundaryDirectory, name));
  file.on('data', bytes => hash.update(bytes));
  const lines = createInterface({ input: file, crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) {
    const zone = JSON.parse(line);
    const id = Number(zone.id);
    if (!/^\d{5}$/.test(zone.id) || areas.has(id) || !korea(zone.bbox) || !Number.isFinite(zone.areaKm2) || zone.areaKm2 <= 0 ||
        !Number.isFinite(zone.center?.[0]) || !Number.isFinite(zone.center?.[1])) throw Error('POSTAL_BUILD_BOUNDARY_ZONE');
    areas.set(id, encodePostalArea(zone));
    matchStores(zone);
    for (const [level, { key, span }] of Object.entries(tileLevel)) {
      const tile = level + '-' + Math.floor((zone.center[0] - 123) / span) + '-' + Math.floor((zone.center[1] - 32) / span);
      if (!tileGroups.has(tile)) tileGroups.set(tile, []);
      const geometry = encodePostalZone(zone, flatRings(zone[key]));
      if (geometry.length + 8 > POSTAL_TILE_LIMIT) throw Error('POSTAL_BUILD_TILE_GEOMETRY');
      tileGroups.get(tile).push({ bytes: geometry, box: zone.bbox });
    }
    count++;
  }
  if (count !== region.count || file.bytesRead !== region.bytes || hash.digest('hex') !== region.sha256) {
    throw Error('POSTAL_BUILD_BOUNDARY_SHA256');
  }
}

const manifest = {
  schema: 'opsmap-postal-geometry-v1',
  source: {
    origin: source.origin, label: approvedSources[source.origin][0], url: approvedSources[source.origin][1],
    version: approvedSources[source.origin][2], asOf: source.vintage, sourceChangeAsOf: source.latestSourceChange ?? null,
    retrievedAt: source.retrievedAt ?? null, sourceManifestSha256: boundaryProof,
    provinceSources: source.regions.map(({ basename, sourceSha256 }) => [basename.slice(7, 9), sourceSha256]),
    repaired: sum(source.regions.map(region => region.repaired || 0)),
  },
  count: areas.size,
  tiers: { national: [], regional: [], detail: [] },
};
const areaBytes = Buffer.concat([...areas.keys()].sort((a, b) => a - b).map(id => areas.get(id)));
manifest.areas = { sha256: syncSha256(areaBytes), bytes: areaBytes.length };
await writeFile(join(tileDirectory, 'areas.bin'), areaBytes, { flag: 'wx' });

async function saveTile(key, rows, part) {
  const header = Buffer.alloc(8);
  header.write('PCG1');
  header.writeInt32LE(rows.length, 4);
  const raw = Buffer.concat([header, ...rows.map(row => row.bytes)]);
  const gzip = gzipSync(raw, { level: 5 });
  const id = key + '-' + part;
  await writeFile(join(tileDirectory, id + '.gz'), gzip, { flag: 'wx' });
  const box = rows.reduce((current, row) => boundUnion(current, row.box), null);
  manifest.tiers[key.split('-')[0]].push({ id, box, count: rows.length, bytes: gzip.length,
    rawBytes: raw.length, sha256: syncSha256(gzip) });
}
for (const [key, rows] of tileGroups) {
  let part = 0, output = [], bytes = 8;
  for (const row of rows) {
    if (bytes + row.bytes.length > POSTAL_TILE_LIMIT) {
      await saveTile(key, output, part++);
      output = [];
      bytes = 8;
    }
    output.push(row);
    bytes += row.bytes.length;
  }
  await saveTile(key, output, part);
  tileGroups.delete(key);
}
const geom = Buffer.from(JSON.stringify(manifest));
await writeFile(join(tileDirectory, 'manifest.json'), geom, { flag: 'wx' });

const status = await readFreshonStoreStatusFile({ file: statusFile, expectedSha256: statusProof,
  generation: index.sha256, registry });
const periodGroups = {};
const windows = {};
const selected = new Set();
const expected = new Map();
for (const days of PERIODS) {
  const ref = index.windows[days];
  const doc = JSON.parse(await verified(join(generation.coverage, ref.sha256 + '.json'), ref.sha256, ref.bytes));
  if (doc.evidenceVersion !== 2 || doc.end !== index.asOf || doc.days !== days) throw Error('POSTAL_BUILD_PERIOD');
  windows[days] = doc;
  periodGroups[days] = new Map();
  for (const date of Object.keys(state.dates).filter(date => date >= doc.start && date <= doc.end)) selected.add(date);
  expected.set(days, { source: 0, unidentified: 0, complete: 0,
    recorded: centers.map(() => 0), originalMissing: centers.map(() => 0), boundaryMissing: centers.map(() => 0),
    unavailableCodes: centers.map(() => new Set()) });
}
const identities = new Set();
for (const date of [...selected].sort()) {
  const day = await input.readDay(date, generation);
  const involved = PERIODS.filter(days => date >= windows[days].start && date <= windows[days].end);
  for (const days of involved) {
    const proof = expected.get(days);
    proof.source += day.sourceRows;
    proof.unidentified += day.unidentified;
    proof.complete += day.visits.length;
  }
  for (const [id, code, vehicle, origin, addressHash] of day.visits) {
    if (identities.has(id)) throw Error('POSTAL_BUILD_DUPLICATE_DELIVERY_ID');
    identities.add(id);
    const row = stores.get(code);
    const center = centers.indexOf(origin);
    // Address changes use the same match semantics as the published rolling archive.
    const sourceMatched = row?.position && row.matchHash && row.matchHash === addressHash;
    for (const days of involved) {
      const proof = expected.get(days);
      proof.recorded[center]++;
      if (!sourceMatched) { proof.originalMissing[center]++; if (row?.registered) proof.unavailableCodes[center].add(code); continue; }
      if (!row.match || row.ambiguous) { proof.boundaryMissing[center]++; if (row.registered) proof.unavailableCodes[center].add(code); continue; }
      const groups = periodGroups[days];
      if (!groups.has(code)) groups.set(code, new Map());
      const byCenter = groups.get(code);
      if (!byCenter.has(center)) byCenter.set(center, { count: 0, date: null, vehicles: new Set() });
      const entry = byCenter.get(center);
      entry.count++;
      entry.date = date;
      if (vehicle) entry.vehicles.add(vehicle);
    }
  }
}
const periods = {};
for (const days of PERIODS) {
  const doc = windows[days];
  const proof = expected.get(days);
  if (proof.source !== doc.sourceRows || proof.unidentified !== doc.unidentified || proof.complete !== doc.completed ||
      centers.some((center, i) => proof.recorded[i] !== doc.recorded[center] || proof.originalMissing[i] !== doc.unplaced[center])) {
    throw Error('POSTAL_BUILD_SOURCE_CONSERVATION');
  }
  const statusSummary = status.getDeliverySummary(days);
  const stateRows = [];
  for (const code of registry.keys()) {
    const storeStatus = status.getDeliveryStatus(code, days);
    if (!storeStatus) continue;
    const bits = (storeStatus.newActive === true ? 1 : 0) | (storeStatus.historicalNew && storeStatus.newActive === null ? 2 : 0) |
      (storeStatus.held ? 4 : 0) | (storeStatus.historicalNew && storeStatus.newActive === false ? 8 : 0);
    if (bits) stateRows.push([code, bits]);
  }
  periods[days] = {
    start: doc.start, end: doc.end, missing: doc.missing, observed: doc.observedDates, unverified: doc.unverified,
    unidentified: doc.unidentified, complete: doc.completed, recorded: proof.recorded, unplaced: proof.originalMissing,
    unplacedBoundary: proof.boundaryMissing, unavailableCodes: proof.unavailableCodes.map(codes => [...codes].sort()),
    rows: [...periodGroups[days]].map(([code, byCenter]) => [code, [...byCenter].map(([center, row]) =>
      [center, row.count, row.date, [...row.vehicles].sort()])]),
    states: stateRows, statusSummary,
  };
}
const release = {
  schema: 'opsmap-postal-release-v1', generation: index.sha256, catalog: index.catalog.sha256, boundary: syncSha256(geom),
  sourceObservedAt: index.sourceObservedAt, asOf: index.asOf,
  stores: [...stores.values()].map(row =>
    [row.code, row.match && !row.ambiguous ? row.match : null, row.registered, centers.includes(row.center) ? centers.indexOf(row.center) : 3]),
  ambiguousStores: [...stores.values()].filter(row => row.registered && row.ambiguous).length,
  periods,
};
const bundle = gzipSync(JSON.stringify(release), { level: 8 });
await writeFile(join(target, 'postal-release.json.gz'), bundle, { flag: 'wx', mode: 0o600 });
const sizes = Object.fromEntries(Object.entries(manifest.tiers).map(([level, files]) =>
  [level, { tiles: files.length, features: sum(files.map(file => file.count)), bytes: sum(files.map(file => file.bytes)) }]));
console.log(JSON.stringify({ generation: release.generation, manifestSha256: release.boundary, releaseSha256: syncSha256(bundle),
  releaseBytes: bundle.length, boundaries: manifest.count, sizes, stores: registry.size,
  boundaryUnmatched: release.stores.filter(row => row[2] && row[1] === null).length, ambiguous: release.ambiguousStores,
  periods: Object.fromEntries(PERIODS.map(days => [days, {
    observedOsan: periods[days].observed.osan.length, missing: periods[days].missing.length,
    delivered: periods[days].complete, located: periods[days].complete - sum(periods[days].unplaced) - sum(periods[days].unplacedBoundary),
    new: periods[days].statusSummary.confirmedNewActive, newUnknown: periods[days].statusSummary.newUnknown, held: periods[days].statusSummary.held
  }])) }, null, 2));
