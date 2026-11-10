import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {coordinateAddressHash} from './opsmap-abc/opsmapAutoCoordinates.js';
import {hasFixedCoordinatePoint} from './fixedStoreCoordinates.js';
import {OFFICIAL_BUILDING_SOURCE, OFFICIAL_BUSINESS_SOURCE, OPEN_BUILDING_SOURCE, officialAddressKey} from './opsmapOfficialAddressLookup.js';
import {boundedRead,privateCoverageDirectory} from './shadowCoverage/coverageFiles.js';

const helper = fileURLToPath(new URL('../scripts/opsmap-public-address-catalog.py', import.meta.url));
const hash = /^[a-f0-9]{64}$/;
const unmatched = new Set(['ADDRESS_NOT_IDENTIFIED', 'AMBIGUOUS_BUILDING', 'NO_LICENSED_POINT']);
const fileIdentity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_BATCH = 15_000;

async function readReviewFile(config,appRoot) {
  const {file,sha256} = config;
  if (!path.isAbsolute(file || '') || !hash.test(sha256 || '')) throw Error('PUBLIC_ADDRESS_REVIEW_CONFIG');
  const folder = await privateCoverageDirectory(path.dirname(file),appRoot);
  const actual = await fs.realpath(path.join(folder,path.basename(file)));
  if (path.dirname(actual) !== folder) throw Error('PUBLIC_ADDRESS_REVIEW_PATH');
  const bytes = await boundedRead(actual,128 * 1024);
  if (sha(bytes) !== sha256) throw Error('PUBLIC_ADDRESS_REVIEW_DIGEST');
  return JSON.parse(bytes.toString('utf8'));
}

async function openAddressReviews(config,appRoot) {
  const reviews = new Map();
  if (!config) return reviews;
  const {schema,rows} = await readReviewFile(config,appRoot);
  if (schema !== 'opsmap-reviewed-public-addresses-v1' || !Array.isArray(rows) || rows.length > 250) {
    throw Error('PUBLIC_ADDRESS_REVIEW_SCHEMA');
  }
  for (const {customerCode,addressHash,correctedAddress,buildingSha256} of rows) {
    if (!/^[A-Z]\d{1,20}$/.test(customerCode || '') || reviews.has(customerCode) ||
        !hash.test(addressHash || '') || !hash.test(buildingSha256 || '') || !officialAddressKey(correctedAddress) ||
        /[\u0000-\u001f]/.test(correctedAddress) || coordinateAddressHash(correctedAddress) === addressHash) {
      throw Error('PUBLIC_ADDRESS_REVIEW_ROW');
    }
    reviews.set(customerCode,{addressHash,correctedAddress,buildingSha256,reviewSha256:config.sha256});
  }
  return reviews;
}

async function openBuildingReviews(config,appRoot,catalogSha256) {
  const reviews = new Map();
  if (!config) return reviews;
  const {schema,baseCatalogSha256,datasetSha256,datasetDate,license,rows} = await readReviewFile(config,appRoot);
  if (schema !== 'opsmap-reviewed-open-building-points-v1' || baseCatalogSha256 !== catalogSha256 ||
      license !== 'ODbL-1.0' || !hash.test(datasetSha256 || '') || !/^\d{4}-\d{2}-\d{2}$/.test(datasetDate || '') ||
      !Array.isArray(rows) || rows.length > 32) throw Error('PUBLIC_OPEN_BUILDING_REVIEW_SCHEMA');
  for (const {customerCode,addressHash,status,buildingSha256,wayId,lat,lng} of rows) {
    if (!/^[A-Z]\d{1,20}$/.test(customerCode || '') || reviews.has(customerCode) ||
        !hash.test(addressHash || '') || !hash.test(buildingSha256 || '') || !Number.isSafeInteger(wayId) || wayId < 1 ||
        !['NO_LICENSED_POINT','AMBIGUOUS_BUILDING'].includes(status) ||
        typeof lat !== 'number' || typeof lng !== 'number' || !hasFixedCoordinatePoint({lat,lng})) {
      throw Error('PUBLIC_OPEN_BUILDING_REVIEW_ROW');
    }
    reviews.set(customerCode,{status,lat,lng,buildingSha256,osmWayId:wayId,reviewSha256:config.sha256,
      customerAddressHash:addressHash,evidenceSource:'OPEN_ADDRESS_DATA',sourceDataset:OPEN_BUILDING_SOURCE,
      datasetSha256,datasetDate,indexSha256:catalogSha256,measurementKind:'ADDRESS_LOCATION'});
  }
  return reviews;
}

async function approvedFile(file, expected) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat({bigint:true});
    if (!stat.isFile() || stat.size < 100 || stat.size > 8n * 1024n ** 3n) throw Error('PUBLIC_ADDRESS_CATALOG_SIZE');
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({autoClose:false})) digest.update(chunk);
    const identity = fileIdentity(stat);
    if (digest.digest('hex') !== expected || fileIdentity(await handle.stat({bigint:true})) !== identity) {
      throw Error('PUBLIC_ADDRESS_CATALOG_DIGEST');
    }
    return identity;
  } finally {
    await handle.close();
  }
}

function readBatch(file, addresses) {
  return new Promise((resolve, reject) => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const child = spawn(python, ['-X','utf8','-B',helper,'lookup',file], {
      stdio:['pipe','pipe','ignore'],windowsHide:true
    });
    const chunks = [];
    let bytes = 0;
    const fail = code => { child.kill(); reject(Error(code)); };
    const timeout = setTimeout(() => fail('PUBLIC_ADDRESS_CATALOG_TIMEOUT'), 60_000);
    child.on('error', () => fail('PUBLIC_ADDRESS_CATALOG_UNAVAILABLE'));
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 5 * 1024 * 1024) fail('PUBLIC_ADDRESS_CATALOG_RESPONSE_SIZE');
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => fail('PUBLIC_ADDRESS_CATALOG_INPUT'));
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) return reject(Error('PUBLIC_ADDRESS_CATALOG_READ'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Error('PUBLIC_ADDRESS_CATALOG_RESPONSE')); }
    });
    child.stdin.end(JSON.stringify(addresses));
  });
}

export async function openPublicAddressCatalog({file,sha256,reviewedAddresses,reviewedOpenBuildings} = {}, {appRoot = process.cwd()} = {}) {
  if (!path.isAbsolute(file || '') || !hash.test(sha256 || '')) throw Error('PUBLIC_ADDRESS_CATALOG_CONFIG');
  const folder = await privateCoverageDirectory(path.dirname(file), appRoot);
  const actual = await fs.realpath(path.join(folder, path.basename(file)));
  if (path.dirname(actual) !== folder) throw Error('PUBLIC_ADDRESS_CATALOG_PATH');
  const [identity,reviews,openBuildings] = await Promise.all([approvedFile(actual,sha256),
    openAddressReviews(reviewedAddresses,appRoot),openBuildingReviews(reviewedOpenBuildings,appRoot,sha256)]);
  const checkFile = async () => {
    if (fileIdentity(await fs.stat(actual,{bigint:true})) !== identity) throw Error('PUBLIC_ADDRESS_CATALOG_CHANGED');
  };
  return { async resolveMany(addresses, customers = []) {
    if (!addresses.length) return {resolve:() => null};
    if (addresses.length > MAX_BATCH) throw Error('PUBLIC_ADDRESS_QUERY_SCOPE');
    const permitted = new Set(addresses);
    const alternatives = new Map();
    for (const {customerCode,address} of customers) {
      const review = reviews.get(customerCode);
      if (review && permitted.has(address) && review.addressHash === coordinateAddressHash(address)) {
        alternatives.set(customerCode,review);
      }
    }
    const queries = [...new Set([...addresses,...[...alternatives.values()].map(row=>row.correctedAddress)])];
    await checkFile();
    const sources = [OFFICIAL_BUILDING_SOURCE, OFFICIAL_BUSINESS_SOURCE];
    const points = new Map(), statuses = new Map();
    for (let offset = 0; offset < queries.length; offset += MAX_BATCH) {
      const batch = queries.slice(offset,offset + MAX_BATCH);
      const {metadata,rows} = await readBatch(actual,batch);
      if (metadata?.schema !== 'opsmap-public-address-catalog-v1' || !Array.isArray(metadata.sources) ||
          metadata.sources.length !== sources.length || !metadata.sources.every((entry,i) =>
            entry?.url === sources[i] && hash.test(entry.sha256 || '') && /^\d{4}-\d{2}-\d{2}$/.test(entry.date || '')) ||
          !Array.isArray(rows) || rows.length !== batch.length) throw Error('PUBLIC_ADDRESS_CATALOG_RESPONSE');
      for (const [i,row] of rows.entries()) {
        const address = batch[i];
        if (unmatched.has(row?.status)) { statuses.set(address,row.status); continue; }
        const dataset = metadata.sources[row?.source];
        if (row?.status !== 'MATCHED' || !dataset || !hash.test(row.buildingSha256 || '') ||
            typeof row.lat !== 'number' || typeof row.lng !== 'number' || !hasFixedCoordinatePoint(row)) {
          throw Error('PUBLIC_ADDRESS_CATALOG_ROW');
        }
        points.set(address,{lat:row.lat,lng:row.lng,buildingSha256:row.buildingSha256,
          customerAddressHash:coordinateAddressHash(address),evidenceSource:'OFFICIAL_ADDRESS_DATA',
          sourceDataset:dataset.url,datasetDate:dataset.date,datasetSha256:dataset.sha256,indexSha256:sha256,
          measurementKind:row.source === 0 ? 'BUILDING_LOCATION' : 'ADDRESS_LOCATION'});
      }
    }
    await checkFile();
    return {resolve(address,customerCode) {
      if (!permitted.has(address)) return null;
      const direct = points.get(address);
      if (direct) return direct;
      const status = statuses.get(address);
      const open = openBuildings.get(customerCode);
      if (open && open.status === status && open.customerAddressHash === coordinateAddressHash(address)) return open;
      if (status !== 'ADDRESS_NOT_IDENTIFIED') return null;
      const review = alternatives.get(customerCode);
      if (!review || coordinateAddressHash(address) !== review.addressHash) return null;
      const point = points.get(review.correctedAddress);
      if (!point || point.buildingSha256 !== review.buildingSha256) return null;
      return {...point,customerAddressHash:review.addressHash,reviewSha256:review.reviewSha256,
        correctedAddressHash:point.customerAddressHash,measurementKind:'ADDRESS_LOCATION'};
    },status:address => statuses.get(address)};
  }};
}
