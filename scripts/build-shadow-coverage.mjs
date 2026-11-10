import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { aggregateDay, combineDays, datesFor, PERIODS, prepareCatalog, prepareView } from '../src/shadowCoverage/model.js';
import { atomicCoverageWrite, boundedRead, privateCoverageDirectory, publishCoverageIndex, readCoverageIndex, writeCoverageBlob } from '../src/shadowCoverage/store.js';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const digestJson = value => digest(JSON.stringify(value));
const repository = fileURLToPath(new URL('../', import.meta.url));
const boundaryRoot = path.join(repository, 'integrations/official-boundaries/sgis-adm-20250630-overview');
const boundaryHash = '2193450655b521a1c0315ab1330e5910f9aa4069aad3d81ddf176afc553b188d';
const provinces = {
  11: '서울', 21: '부산', 22: '대구', 23: '인천', 24: '광주', 25: '대전', 26: '울산', 29: '세종',
  31: '경기', 32: '강원', 33: '충북', 34: '충남', 35: '전북', 36: '전남', 37: '경북', 38: '경남', 39: '제주'
};

// Only names, codes and bounds enter the analytic catalog. No administrative
// polygon is loaded by the operating server or sent to this tab.
async function adminSearchIndex() {
  const bytes = await boundedRead(path.join(boundaryRoot, 'manifest.json'), 2 * 1024 * 1024);
  if (digest(bytes) !== boundaryHash) throw Error('COVERAGE_ADMIN_INDEX_INTEGRITY');
  const index = JSON.parse(bytes);
  const bounds = new Map(index.entries.map(entry => [entry.code, entry.bbox]));
  const output = [];
  for (const shard of index.shards) {
    const compressed = await boundedRead(path.join(boundaryRoot, shard.file), shard.gzipBytes);
    if (digest(compressed) !== shard.sha256) throw Error('COVERAGE_ADMIN_SHARD_INTEGRITY');
    const data = JSON.parse(gunzipSync(compressed, { maxOutputLength: shard.jsonBytes }));
    for (const feature of data.features) {
      const { adm_cd: code, adm_nm: name } = feature.properties;
      const box = bounds.get(code);
      if (!box || !name) throw Error('COVERAGE_ADMIN_NAME_MISSING');
      const province = provinces[code.slice(0, 2)] || '';
      output.push({
        name: [province, name].filter(Boolean).join(' '), query: name, bounds: box,
        location: [(box[1] + box[3]) / 2, (box[0] + box[2]) / 2]
      });
    }
  }
  if (output.length !== index.featureCount) throw Error('COVERAGE_ADMIN_COUNT');
  return output;
}

function storedRegions(stores) {
  const byName = new Map();
  for (const store of stores) {
    if (!store.cell) continue;
    const parts = store.area.split(/\s+/).slice(0, 3);
    for (const [index, token] of parts.entries()) {
      if (index > 0 && !/[시군구]$/.test(token)) continue;
      if (token.length < 2 || token === '행정구역' || token === '미확인') continue;
      const label = parts.slice(0, index + 1).join(' ');
      if (!byName.has(label)) byName.set(label, {
        name: label + ' 등록 지점', query: token, location: [store.lat, store.lng],
        bounds: [store.lng - 0.008, store.lat - 0.008, store.lng + 0.008, store.lat + 0.008]
      });
      const box = byName.get(label).bounds;
      box[0] = Math.min(box[0], store.lng - 0.008);
      box[1] = Math.min(box[1], store.lat - 0.008);
      box[2] = Math.max(box[2], store.lng + 0.008);
      box[3] = Math.max(box[3], store.lat + 0.008);
    }
  }
  return [...byName.values()];
}

async function optionalJson(file, maxBytes) {
  try {
    return JSON.parse(await boundedRead(file, maxBytes));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function checkObservedContinuity(output, end, daily) {
  if (!daily.has(end)) throw Error('COVERAGE_END_DATE_UNCONFIRMED');
  let previous;
  try {
    previous = await readCoverageIndex(path.join(output, 'coverage-index.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const ref = previous.windows[90];
  const bytes = await boundedRead(path.join(output, ref.sha256 + '.json'), ref.bytes);
  if (bytes.length !== ref.bytes || digest(bytes) !== ref.sha256) throw Error('COVERAGE_PREVIOUS_WINDOW_INTEGRITY');
  const missing = new Set(JSON.parse(bytes).missing);
  const newRange = new Set(datesFor(end, 90));
  for (const date of datesFor(previous.asOf, 90)) {
    if (newRange.has(date) && !missing.has(date) && !daily.has(date)) throw Error('COVERAGE_OBSERVED_DAY_REGRESSION');
  }
}

export async function buildShadowCoverage({ inputDirectory, outputDirectory, kind = 'OBSERVED', includeOfficialRegions = true }) {
  const input = await privateCoverageDirectory(inputDirectory, repository);
  if (!path.isAbsolute(outputDirectory)) throw Error('COVERAGE_PRIVATE_DIRECTORY_REQUIRED');
  const parent = await privateCoverageDirectory(path.dirname(outputDirectory), repository);
  const output = path.join(parent, path.basename(outputDirectory));
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  await privateCoverageDirectory(output, repository);
  const lockPath = path.join(output, 'coverage-build.lock');
  const lock = await fs.open(lockPath, 'wx', 0o600);
  try {
    const started = performance.now();
    const source = await optionalJson(path.join(input, 'source-import.safe.json'), 32_768);
    const locations = await optionalJson(path.join(input, 'stores.private.json'), 3 * 1024 * 1024);
    if (!source || !locations || !Number.isFinite(Date.parse(source.observedAt)) ||
        kind === 'OBSERVED' && (source.sourceWrites !== 0 ||
          source.sources?.current?.stable !== true || source.sources?.archive?.stable !== true)) {
      throw Error('COVERAGE_SOURCE_UNVERIFIED');
    }
    const scope = await optionalJson(path.join(input, 'scope.private.json'), 2 * 1024 * 1024);
    const storeCatalog = prepareCatalog({ ...locations, scopes: scope?.cells || [] });
    let official = [];
    if (includeOfficialRegions) {
      const adminFile = path.join(output, 'admin-names-' + boundaryHash + '.json');
      official = await optionalJson(adminFile, 1_500_000).catch(() => null);
      if (!official) {
        official = await adminSearchIndex();
        await atomicCoverageWrite(adminFile, JSON.stringify(official));
      }
    }
    const catalog = prepareCatalog({
      ...locations, scopes: storeCatalog.scopes, regions: [...(locations.regions || []), ...storedRegions(storeCatalog.stores), ...official]
    });
    const byCode = new Map(catalog.stores.map(store => [store.code, store]));
    const shards = path.join(output, 'days');
    await fs.mkdir(shards, { recursive: true, mode: 0o700 });
    const daily = new Map(), visitIdentities = new Set();
    let reusedDays = 0, rebuiltDays = 0;
    for (const date of datesFor(source.end, 90)) {
      const raw = await optionalJson(path.join(input, 'observed-days', date + '.json'), 3 * 1024 * 1024);
      if (!raw || raw.planningOnly === true) continue;
      if (raw.date !== date || !Array.isArray(raw.visits) || raw.visits.length > 12_000) throw Error('COVERAGE_DAY_CONTRACT');
      const references = new Set();
      for (const [identity, code] of raw.visits) {
        if (visitIdentities.has(identity)) throw Error('COVERAGE_DUPLICATE_DELIVERY_ID');
        visitIdentities.add(identity);
        references.add(code);
      }
      // A store address/point change invalidates only days that used it.
      const bindings = [...references].sort().map(code => {
        const store = byCode.get(code);
        return [code, store?.cell || null, store?.matchHash || null];
      });
      const signature = digestJson([2, raw, bindings]);
      const shardFile = path.join(shards, date + '.json');
      const saved = await optionalJson(shardFile, 3 * 1024 * 1024).catch(() => null);
      if (saved?.signature === signature && saved.sha256 === digestJson(saved.value) && saved.value.date === date) {
        daily.set(date, saved.value);
        reusedDays++;
        continue;
      }
      const value = aggregateDay(raw, byCode);
      await atomicCoverageWrite(shardFile, JSON.stringify({ signature, value, sha256: digestJson(value) }));
      daily.set(date, value);
      rebuiltDays++;
    }
    if (!daily.size) throw Error('COVERAGE_NO_DAILY_DATA');
    if (kind === 'OBSERVED' && (daily.size !== source.days ||
        [...daily.values()].reduce((count, day) => count + day.completed, 0) !== source.completedUnique ||
        catalog.stores.length !== source.stores?.union)) {
      throw Error('COVERAGE_OBSERVATION_COUNT_MISMATCH');
    }
    if (kind === 'OBSERVED') await checkObservedContinuity(output, source.end, daily);

    const catalogRef = await writeCoverageBlob(output, {
      stores: catalog.stores.map(({ code, name, address, center, registered, lat, lng }) =>
        ({ code, name, address, center, registered, lat, lng })),
      registryComplete: catalog.registryVerified, registryProofHash: locations.registryProofHash || null,
      regions: catalog.regions, scopes: catalog.scopes
    });
    const windows = {}, metrics = {};
    for (const period of PERIODS) {
      const window = combineDays(source.end, period, daily);
      windows[period] = await writeCoverageBlob(output, window);
      const view = prepareView(catalog, window, 'all', 8);
      metrics[period] = { start: window.start, end: window.end, recorded: window.completed, byCenter: window.recorded,
        missing: window.missing, recordedDays: view.evidence.recordedDays, unverifiedDays: window.unverified.all.length, ...view.summary };
    }
    const index = await publishCoverageIndex(output, {
      kind, asOf: source.end, sourceObservedAt: source.observedAt, generatedAt: new Date().toISOString(),
      catalog: catalogRef, windows
    }, { allowFixture: kind === 'FIXTURE' });
    return {
      index, metrics, reusedDays, rebuiltDays, regions: catalog.regions.length,
      buildMs: Math.round(performance.now() - started), rssMiB: Math.round(process.memoryUsage().rss / 1048576)
    };
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [inputDirectory, outputDirectory] = process.argv.slice(2);
    if (!inputDirectory || !outputDirectory) throw Error('COVERAGE_BUILD_ARGUMENTS');
    const result = await buildShadowCoverage({ inputDirectory, outputDirectory });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'COVERAGE_BUILD_FAILED');
    process.exitCode = 1;
  }
}
