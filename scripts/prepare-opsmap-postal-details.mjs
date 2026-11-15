import { createHash } from 'node:crypto';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { gzipSync, gunzipSync } from 'node:zlib';
import { boundedRead, PERIODS, privateCoverageDirectory } from '../src/shadowCoverage/coverageFiles.js';
import { openOpsmapSyncGenerationStore, syncHash, syncSha256 } from '../src/opsmapSyncGeneration.js';

const [postalDirectory, releaseSha, sourceBoundaries, snapshotDirectory, target] = process.argv.slice(2);
if (![postalDirectory, sourceBoundaries, snapshotDirectory, target].every(value => isAbsolute(value || '')) ||
    !syncHash(releaseSha)) throw Error('POSTAL_DETAILS_BUILD_ARGUMENTS');
const appRoot = process.cwd();
for (const input of [postalDirectory, sourceBoundaries, snapshotDirectory, dirname(target)]) {
  await privateCoverageDirectory(await realpath(input), appRoot);
}
const centers = ['osan', 'yeongnam', 'honam', 'unknown'];
const codePattern = /^[A-Z]\d{1,20}$/;
const zipPattern = /^\d{5}$/;
const maxCustomerBytes = 2 * 1024 * 1024;
async function verify(file, hash, max) {
  const bytes = await boundedRead(file, max);
  if (syncSha256(bytes) !== hash) throw Error('POSTAL_DETAILS_BUILD_HASH');
  return bytes;
}

const packed = await verify(join(postalDirectory, 'postal-release.json.gz'), releaseSha, 1024 * 1024);
const coverage = JSON.parse(gunzipSync(packed, { maxOutputLength: 5 * 1024 * 1024 }));
const geometry = JSON.parse(await verify(join(postalDirectory, 'geometry/manifest.json'), coverage.boundary, 1024 * 1024));
const rawManifest = JSON.parse(await verify(join(sourceBoundaries, 'manifest.json'), geometry.source.sourceManifestSha256, 32 * 1024));
const input = await openOpsmapSyncGenerationStore(snapshotDirectory);
const generation = await input.read();
if (coverage.schema !== 'opsmap-postal-release-v1' || generation?.index.sha256 !== coverage.generation ||
    generation.index.catalog.sha256 !== coverage.catalog || generation.index.asOf !== coverage.asOf ||
    rawManifest.schema !== 'opsmap-postal-boundaries-v1' || ![16, 17].includes(rawManifest.regions?.length)) {
  throw Error('POSTAL_DETAILS_BUILD_GENERATION');
}

const names = [], nameIndex = new Map(), zones = [];
const zipSeen = new Set();
for (const region of rawManifest.regions) {
  if (!/^postal-\d{2}\.ndjson$/.test(region.basename) || !syncHash(region.sha256)) throw Error('POSTAL_DETAILS_BUILD_BOUNDARY');
  const stream = createReadStream(join(sourceBoundaries, region.basename));
  const digest = createHash('sha256');
  stream.on('data', bytes => digest.update(bytes));
  const lines = createInterface({ input:stream, crlfDelay:Infinity });
  let count = 0;
  for await (const line of lines) {
    const { id, label } = JSON.parse(line);
    if (!zipPattern.test(id) || zipSeen.has(id) || typeof label !== 'string' || label.length > 120) {
      throw Error('POSTAL_DETAILS_BUILD_BOUNDARY');
    }
    zipSeen.add(id);
    count++;
    const name = label.endsWith(id) ? label.slice(0, -id.length).trim() : label.trim();
    if (!nameIndex.has(name)) { nameIndex.set(name, names.length); names.push(name); }
    zones.push([Number(id), nameIndex.get(name)]);
  }
  if (count !== region.count || stream.bytesRead !== region.bytes || digest.digest('hex') !== region.sha256) {
    throw Error('POSTAL_DETAILS_BUILD_BOUNDARY');
  }
}
if (zipSeen.size !== geometry.count) throw Error('POSTAL_DETAILS_BUILD_BOUNDARY_COUNT');

const stores = new Map();
const sourceStore = new Map(generation.catalog.stores.map(row => [row.code, row]));
for (const [code, area, registered, center] of coverage.stores) {
  const original = sourceStore.get(code);
  if (!codePattern.test(code) || stores.has(code) || !original || original.registered !== registered ||
      (centers.includes(original.center) ? centers.indexOf(original.center) : 3) !== center ||
      (area !== null && !zipSeen.has(String(area).padStart(5, '0')))) throw Error('POSTAL_DETAILS_BUILD_STORE');
  stores.set(code, { area, registered, original, records:[] });
}
if (stores.size !== sourceStore.size) throw Error('POSTAL_DETAILS_BUILD_STORE_COUNT');

const identities = new Set();
const emitted = PERIODS.map(() => 0);
const unplaced = [0, 0, 0, 0], unplacedBoundary = [0, 0, 0, 0], raw = [0, 0, 0, 0];
const days = Object.keys(generation.state.dates)
  .filter(date => date >= coverage.periods[90].start && date <= coverage.asOf).sort();
let sourceUnidentified = 0;
for (const date of days) {
  const day = await input.readDay(date, generation);
  sourceUnidentified += day.unidentified;
  if (day.planningOnly) continue;
  const dispatch = new Map(day.dispatch ? day.tasks.map((row, i) => [row[0], day.dispatch.events[i]]) : []);
  const windows = PERIODS.map(selected => date >= coverage.periods[selected].start);
  for (const [fingerprint, code, vehicle, origin, address] of day.visits) {
    if (identities.has(fingerprint)) throw Error('POSTAL_DETAILS_BUILD_DUPLICATE');
    identities.add(fingerprint);
    const center = centers.indexOf(origin);
    raw[center]++;
    const store = stores.get(code), original = store?.original;
    if (!original?.matchHash || address !== original.matchHash || !Number.isFinite(original.lat) || !Number.isFinite(original.lng)) {
      unplaced[center]++;
      continue;
    }
    if (store.area === null) {
      unplacedBoundary[center]++;
      continue;
    }
    const event = dispatch.get(fingerprint);
    const completed = event?.[6] === 'VERIFIED_INDIVIDUAL' && event[3]
      ? new Date(Date.parse(event[3]) + 9 * 3600000).toISOString().slice(0,10) : null;
    // The approved archive only holds a delivery identity digest. It has no MIS order number or raw Delivery task ID.
    store.records.push([fingerprint, date, center, vehicle || null, event ? date : null, completed]);
    windows.forEach((inside, i) => { if (inside) emitted[i]++; });
  }
}
const source90 = coverage.periods[90];
if (sourceUnidentified !== source90.unidentified || identities.size !== source90.complete ||
    [raw, unplaced, unplacedBoundary].some((part, i) => part.some((n, j) =>
      n !== [source90.recorded, source90.unplaced, source90.unplacedBoundary][i][j]))) throw Error('POSTAL_DETAILS_BUILD_CONSERVATION');
const footprints = [];
for (const [i, days] of PERIODS.entries()) {
  const claim = new Map(coverage.periods[days].rows);
  let count = 0;
  for (const [code, item] of stores) {
    const tally = [0, 0, 0, 0];
    const lasts = [null, null, null, null];
    for (const [, date, center] of item.records) {
      if (date < coverage.periods[days].start) continue;
      tally[center]++;
      lasts[center] = date;
      count++;
    }
    const original = claim.get(code) || [];
    for (let center = 0; center < centers.length; center++) {
      const prior = original.find(row => row[0] === center);
      if (tally[center] !== (prior?.[1] ?? 0) || lasts[center] !== (prior?.[2] ?? null)) {
        throw Error('POSTAL_DETAILS_BUILD_COUNT_CONFLICT');
      }
    }
  }
  if (count !== emitted[i]) throw Error('POSTAL_DETAILS_BUILD_COUNT_CONFLICT');
  footprints.push([days, count]);
}
await mkdir(target, { mode:0o700 });
let offset = 0;
const parts = [];
const file = await open(join(target, 'customer-history.bin'), 'wx', 0o600);
try {
  for (const [code, store] of stores) {
    if (!store.records.length) continue;
    const rows = store.records.sort((a,b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0]));
    const body = Buffer.from(JSON.stringify({ code, rows }));
    if (body.length > maxCustomerBytes) throw Error('POSTAL_DETAILS_BUILD_CUSTOMER_SIZE');
    const compressed = gzipSync(body, { level:5 });
    await file.writeFile(compressed);
    const recent = new Map();
    for (const [,day,center,vehicle] of rows) {
      if (!recent.has(center)) recent.set(center,{day,cars:new Set()});
      const latest = recent.get(center);
      if (day === latest.day && vehicle) latest.cars.add(vehicle);
    }
    const assignments = [...recent].map(([center,{day,cars}]) => [center,day,[...cars].sort()]);
    parts.push([code, offset, compressed.length, body.length, syncSha256(compressed), rows.length, assignments]);
    offset += compressed.length;
  }
  await file.sync();
} finally { await file.close(); }
const manifest = {
  schema:'opsmap-postal-details-v1', generation:coverage.generation, release:releaseSha, boundary:coverage.boundary,
  sourceObservedAt:coverage.sourceObservedAt, asOf:coverage.asOf,
  zones, names, parts, bytes:offset, footprints, orders:'NOT_CONNECTED',
};
const index = gzipSync(JSON.stringify(manifest), { level:7 });
await writeFile(join(target, 'details-index.json.gz'), index, { flag:'wx', mode:0o600 });
console.log(JSON.stringify({
  generation:coverage.generation, detailIndexSha256:syncSha256(index), indexBytes:index.length,
  privateHistoryBytes:offset, zoneCount:zones.length, stores:stores.size, archivedDeliveryKeys:identities.size,
  memberHistoryCount:parts.length, counts:footprints, unknownDates:coverage.periods[90].missing.length,
  orderSource:'NOT_CONNECTED', originalDeliveryId:'UNAVAILABLE',
  individualDates:[...stores.values()].reduce((count, store) => count + store.records.filter(row => row[5]).length, 0),
},null,2));
