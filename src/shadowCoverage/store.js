import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CENTERS, PERIODS, datesFor, isDay, prepareCatalog, prepareView } from './model.js';

const SHA = /^[a-f0-9]{64}$/;
const MAX_BLOB_BYTES = 3 * 1024 * 1024;
const MAX_SECRET_FILE_BYTES = 1_000_000;
export const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export async function privateCoverageDirectory(directory, appRoot) {
  if (!path.isAbsolute(directory || '')) throw Error('COVERAGE_PRIVATE_DIRECTORY_REQUIRED');
  const resolved = await fs.realpath(directory);
  const relative = path.relative(await fs.realpath(appRoot), resolved);
  if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
    throw Error('COVERAGE_OUTSIDE_APP_REQUIRED');
  }
  if (!(await fs.stat(resolved)).isDirectory()) throw Error('COVERAGE_PRIVATE_DIRECTORY_REQUIRED');
  return resolved;
}

export async function boundedRead(file, maxBytes = MAX_BLOB_BYTES) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw Error('COVERAGE_FILE_TOO_LARGE');
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw Error('COVERAGE_FILE_TOO_LARGE');
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readStoredCoverageFile(file, maxBytes) {
  try {
    return await boundedRead(file, maxBytes);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // Docker mounts Render Secret Files as text at runtime. Limit both the
  // encoded file and the decompressed bytes before validating the B hashes.
  const packedFile = path.join(path.dirname(file), 'opsmap-coverage-' + path.basename(file) + '.gz.b64');
  const encoded = (await boundedRead(packedFile, MAX_SECRET_FILE_BYTES)).toString('utf8').trim();
  const compressed = Buffer.from(encoded, 'base64');
  if (!compressed.length || compressed.toString('base64') !== encoded) throw Error('COVERAGE_ENCODING_INVALID');
  return gunzipSync(compressed, { maxOutputLength: maxBytes });
}

export async function atomicCoverageWrite(file, bytes) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  let created = false;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  } finally {
    if (created) await fs.unlink(temp).catch(() => {});
  }
}

export async function writeCoverageBlob(directory, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_BLOB_BYTES) throw Error('COVERAGE_BLOB_LIMIT');
  const sha256 = hash(bytes);
  const file = path.join(directory, sha256 + '.json');
  const existing = await boundedRead(file).catch(() => null);
  if (!existing || hash(existing) !== sha256) await atomicCoverageWrite(file, bytes);
  return { sha256, bytes: bytes.length };
}

const validRef = ref => ref && SHA.test(ref.sha256 || '') &&
  Number.isInteger(ref.bytes) && ref.bytes > 0 && ref.bytes <= MAX_BLOB_BYTES;

export async function readCoverageIndex(file, { allowFixture = false } = {}) {
  const value = JSON.parse(await readStoredCoverageFile(file, 16_384));
  const { sha256, ...body } = value;
  if (!SHA.test(sha256 || '') || hash(JSON.stringify(body)) !== sha256 || value.schema !== 1 ||
      !isDay(value.asOf) || !Number.isFinite(Date.parse(value.generatedAt)) ||
      !Number.isFinite(Date.parse(value.sourceObservedAt)) || !validRef(value.catalog) ||
      !PERIODS.every(days => validRef(value.windows?.[days])) ||
      !(value.kind === 'OBSERVED' || allowFixture && value.kind === 'FIXTURE')) {
    throw Error('COVERAGE_INDEX_INVALID');
  }
  return value;
}

export async function publishCoverageIndex(directory, metadata, { allowFixture = false } = {}) {
  const currentFile = path.join(directory, 'coverage-index.json');
  const previousFile = path.join(directory, 'coverage-index.previous.json');
  const previous = await readCoverageIndex(currentFile, { allowFixture }).catch(() => null);
  if (previous && (previous.asOf > metadata.asOf ||
      Date.parse(previous.sourceObservedAt) > Date.parse(metadata.sourceObservedAt))) {
    throw Error('COVERAGE_SOURCE_REGRESSION');
  }
  if (previous && previous.kind === metadata.kind && previous.asOf === metadata.asOf &&
      previous.sourceObservedAt === metadata.sourceObservedAt && previous.catalog.sha256 === metadata.catalog.sha256 &&
      PERIODS.every(days => previous.windows[days].sha256 === metadata.windows[days].sha256)) return previous;
  const body = { schema: 1, ...metadata };
  const value = { ...body, sha256: hash(JSON.stringify(body)) };
  const bytes = Buffer.from(JSON.stringify(value));
  if (previous?.sha256 === value.sha256) return previous;
  // A failed build never replaces either the source data or the verified pointer.
  if (previous) {
    const checks = [];
    for (const ref of [previous.catalog, ...PERIODS.map(days => previous.windows[days])]) {
      const bytes = await boundedRead(path.join(directory, ref.sha256 + '.json'), ref.bytes).catch(() => null);
      checks.push(bytes?.length === ref.bytes && hash(bytes) === ref.sha256);
    }
    if (checks.every(Boolean)) await atomicCoverageWrite(previousFile, JSON.stringify(previous));
  }
  await atomicCoverageWrite(currentFile, bytes);
  return value;
}

function checkWindow(value, days, end) {
  const dates = datesFor(end, days);
  const dateList = list => Array.isArray(list) && list.length <= days &&
    new Set(list).size === list.length && list.every(date => dates.includes(date));
  if (value.days !== days || value.start !== dates[0] || value.end !== end || !dateList(value.missing) ||
      !CENTERS.every(center => dateList(value.unverified?.[center])) ||
      !Array.isArray(value.rows) || value.rows.length > 24_000 ||
      !Number.isSafeInteger(value.completed) || value.completed < 0 || !value.recorded || !value.unplaced) {
    throw Error('COVERAGE_WINDOW_INVALID');
  }
  if (value.evidenceVersion !== undefined) {
    const limit = 1n << BigInt(days);
    const missing = new Set(value.missing);
    const missingMask = dates.reduce((mask, date, index) => missing.has(date) ? mask | 1n << BigInt(index) : mask, 0n);
    const validMask = row => {
      if (!/^[1-9a-f][0-9a-f]{0,22}$/.test(row?.[7] || '')) return false;
      const bits = BigInt('0x' + row[7]);
      return bits < limit && !(bits & missingMask) && row[3] === dates[bits.toString(2).length - 1];
    };
    const keys = [...CENTERS.slice(1), 'unknown'];
    if (value.evidenceVersion !== 2 ||
        !CENTERS.every(center => dateList(value.observedDates?.[center]) &&
          value.observedDates[center].every(date => !missing.has(date))) ||
        !keys.every(center => {
          const codes = value.unplacedCodes?.[center];
          return Array.isArray(codes) && codes.length <= Math.min(15_000, value.unplaced[center]) &&
            new Set(codes).size === codes.length && codes.every(code => /^[A-Z]\d{1,20}$/.test(code));
        }) || !value.rows.every(validMask)) throw Error('COVERAGE_EVIDENCE_INVALID');
  }
  return value;
}

// Load immutable files only on demand. Concurrent readers share one read, and
// at most one disk decode runs at a time. View indexes have their own small cap.
export function createShadowCoverageStore({ directory, appRoot = process.cwd(), allowFixture = false,
  maxCacheBytes = MAX_CACHE_BYTES, now = Date.now, recheckMs = 15_000 } = {}) {
  const blobs = new Map(), views = new Map(), pending = new Map();
  let folder, active, previous, lastGood, checkPromise, checkedAt = -Infinity, tail = Promise.resolve(), cacheBytes = 0, reads = 0;

  async function checkIndexes() {
    if (now() - checkedAt < recheckMs) return;
    if (!checkPromise) {
      checkPromise = (async () => {
        folder ||= await privateCoverageDirectory(directory, appRoot);
        const opts = { allowFixture };
        [active, previous] = await Promise.all([
          readCoverageIndex(path.join(folder, 'coverage-index.json'), opts).catch(() => null),
          readCoverageIndex(path.join(folder, 'coverage-index.previous.json'), opts).catch(() => null)
        ]);
        checkedAt = now();
      })().finally(() => { checkPromise = null; });
    }
    await checkPromise;
  }

  async function readBlob(ref, decode) {
    const key = ref.sha256;
    if (blobs.has(key)) {
      const hit = blobs.get(key);
      blobs.delete(key);
      blobs.set(key, hit);
      return hit.value;
    }
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 6) throw Error('COVERAGE_READ_BUSY');
    const work = tail.then(async () => {
      reads++;
      const bytes = await readStoredCoverageFile(path.join(folder, key + '.json'), ref.bytes);
      if (bytes.length !== ref.bytes || hash(bytes) !== key) throw Error('COVERAGE_BLOB_INTEGRITY');
      const value = decode(JSON.parse(bytes));
      if (ref.bytes <= maxCacheBytes) {
        while (blobs.size && (blobs.size >= 4 || cacheBytes + ref.bytes > maxCacheBytes)) {
          const oldest = blobs.keys().next().value;
          cacheBytes -= blobs.get(oldest).bytes;
          blobs.delete(oldest);
        }
        blobs.set(key, { value, bytes: ref.bytes });
        cacheBytes += ref.bytes;
      }
      return value;
    });
    tail = work.catch(() => {});
    pending.set(key, work);
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  }

  async function readPeriod(days, expectedGeneration) {
    await checkIndexes();
    const candidates = [...new Set([active, lastGood, previous].filter(Boolean))];
    for (const index of candidates) {
      if (expectedGeneration && index.sha256 !== expectedGeneration) continue;
      try {
        const [catalog, window] = await Promise.all([
          readBlob(index.catalog, prepareCatalog),
          readBlob(index.windows[days], value => checkWindow(value, days, index.asOf))
        ]);
        lastGood = index;
        const stale = index.sha256 !== active?.sha256 || now() - Date.parse(index.sourceObservedAt) > 36 * 3_600_000;
        return { index, catalog, window, stale };
      } catch {
        // The previous verified generation is useful even after a restart.
      }
    }
    if (expectedGeneration) throw Error('COVERAGE_GENERATION_CHANGED');
    throw Error('COVERAGE_DATA_UNAVAILABLE');
  }

  function viewFor(data, center, resolution) {
    const key = data.index.sha256 + ':' + data.window.days + ':' + center + ':' + resolution;
    if (views.has(key)) {
      const hit = views.get(key);
      views.delete(key);
      views.set(key, hit);
      return hit;
    }
    const view = prepareView(data.catalog, data.window, center, resolution);
    while (views.size >= 2) views.delete(views.keys().next().value);
    views.set(key, view);
    return view;
  }

  return {
    readPeriod, viewFor,
    metrics: () => ({ cacheBytes, blobs: blobs.size, views: views.size, reads, pending: pending.size })
  };
}
