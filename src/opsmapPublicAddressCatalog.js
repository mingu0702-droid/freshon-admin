import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {coordinateAddressHash} from './opsmap-abc/opsmapAutoCoordinates.js';
import {hasFixedCoordinatePoint} from './fixedStoreCoordinates.js';
import {OFFICIAL_BUILDING_SOURCE, OFFICIAL_BUSINESS_SOURCE} from './opsmapOfficialAddressLookup.js';
import {privateCoverageDirectory} from './shadowCoverage/coverageFiles.js';

const helper = fileURLToPath(new URL('../scripts/opsmap-public-address-catalog.py', import.meta.url));
const hash = /^[a-f0-9]{64}$/;
const unmatched = new Set(['ADDRESS_NOT_IDENTIFIED', 'AMBIGUOUS_BUILDING', 'NO_LICENSED_POINT']);
const fileIdentity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

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

export async function openPublicAddressCatalog({file,sha256} = {}, {appRoot = process.cwd()} = {}) {
  if (!path.isAbsolute(file || '') || !hash.test(sha256 || '')) throw Error('PUBLIC_ADDRESS_CATALOG_CONFIG');
  const folder = await privateCoverageDirectory(path.dirname(file), appRoot);
  const actual = await fs.realpath(path.join(folder, path.basename(file)));
  if (path.dirname(actual) !== folder) throw Error('PUBLIC_ADDRESS_CATALOG_PATH');
  const identity = await approvedFile(actual, sha256);
  const checkFile = async () => {
    if (fileIdentity(await fs.stat(actual,{bigint:true})) !== identity) throw Error('PUBLIC_ADDRESS_CATALOG_CHANGED');
  };
  return { async resolveMany(addresses) {
    if (!addresses.length) return {resolve:() => null};
    await checkFile();
    const {metadata,rows} = await readBatch(actual, addresses);
    await checkFile();
    const sources = [OFFICIAL_BUILDING_SOURCE, OFFICIAL_BUSINESS_SOURCE];
    if (metadata?.schema !== 'opsmap-public-address-catalog-v1' || !Array.isArray(metadata.sources) ||
        metadata.sources.length !== sources.length || !metadata.sources.every((entry,i) =>
          entry?.url === sources[i] && hash.test(entry.sha256 || '') && /^\d{4}-\d{2}-\d{2}$/.test(entry.date || '')) ||
        !Array.isArray(rows) || rows.length !== addresses.length) throw Error('PUBLIC_ADDRESS_CATALOG_RESPONSE');
    const points = new Map(), statuses = new Map();
    for (const [i,row] of rows.entries()) {
      const address = addresses[i];
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
    return {resolve:address => points.get(address),status:address => statuses.get(address)};
  }};
}
