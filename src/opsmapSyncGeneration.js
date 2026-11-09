import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {hasFixedCoordinatePoint, validateFixedCoordinateLedger} from './fixedStoreCoordinates.js';
import {materializeSnapshot, validateSnapshotProjection} from './productionSnapshotStore.js';
import {boundedRead, isDay, parseCoverageIndex, PERIODS, privateCoverageDirectory} from './shadowCoverage/coverageFiles.js';
import {atomicCoverageWrite} from './shadowCoverage/store.js';
import {readStageNearbyEvidence} from './stageNearbyEvidence.js';
import {coordinateAddressHash} from './opsmap-abc/opsmapAutoCoordinates.js';

export const syncSha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const syncDigest = value => syncSha256(JSON.stringify(value));
export const syncHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const SYNC_MAX_DAY_BYTES = 3 * 1024 * 1024;
const headName = /^\d{12}\.json$/;
const idPattern = /^[a-f0-9-]{36}$/;
const codePattern = /^[A-Z]\d{1,20}$/;
const centers = ['osan','yeongnam','honam','unknown'];
const vehiclePattern = /^[A-Za-z가-힣0-9 -]{1,32}$/;

export function validateOpsmapSyncDay(value, date) {
  const {sourceRows, unidentified, visits, tasks} = value || {};
  if (!isDay(date) || value?.date !== date || !Number.isSafeInteger(sourceRows) || sourceRows < 0 || sourceRows > 12_000 ||
      !Number.isSafeInteger(unidentified) || unidentified < 0 || unidentified > sourceRows ||
      !Array.isArray(visits) || visits.length > sourceRows || !syncHash(value.proofHash) ||
      !Array.isArray(value.completeCenters) || value.completeCenters.some(center => !centers.slice(0,3).includes(center))) {
    throw Error('OPSMAP_SYNC_DAY_CONTRACT');
  }
  function checkRows(rows, includeStatus) {
    const identities = new Set();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== (includeStatus ? 6 : 5)) throw Error('OPSMAP_SYNC_DAY_ROW');
      const [id, code, vehicle, center, addressHash, status] = row;
      if (!syncHash(id) || identities.has(id) || !codePattern.test(code) ||
          vehicle !== '' && !vehiclePattern.test(vehicle) || !centers.includes(center) ||
          addressHash !== null && !syncHash(addressHash) || includeStatus && !['COMPLETED','OPEN','CANCELLED'].includes(status)) {
        throw Error('OPSMAP_SYNC_DAY_ROW');
      }
      identities.add(id);
    }
    return identities;
  }
  const visitIds = checkRows(visits, false);
  if (tasks !== undefined) {
    if (!Array.isArray(tasks) || tasks.length !== sourceRows || unidentified !== 0) throw Error('OPSMAP_SYNC_TASK_COUNT');
    checkRows(tasks, true);
    const completed = tasks.filter(row => row[5] === 'COMPLETED');
    const byId = new Map(visits.map(row => [row[0],row]));
    if (completed.length !== visitIds.size || completed.some(([id,code,vehicle,center]) => {
      const visit = byId.get(id);
      return !visit || visit[1] !== code || visit[2] !== vehicle || visit[3] !== center;
    })) throw Error('OPSMAP_SYNC_TASK_BINDING');
  }
  return value;
}

async function verifiedBytes(file, expected, limit) {
  const data = await boundedRead(file, limit);
  if (syncSha256(data) !== expected) throw Error('OPSMAP_SYNC_FILE_DIGEST');
  return data;
}

// Each committed revision is immutable. Linking a fully written pointer to the
// next revision name publishes it atomically and rejects concurrent publishers.
export async function openOpsmapSyncGenerationStore(directory, {appRoot = process.cwd(), writable = false} = {}) {
  const root = await privateCoverageDirectory(directory, appRoot);
  if (process.platform !== 'win32' && ((await fs.stat(root)).mode & 0o007) !== 0) throw Error('OPSMAP_SYNC_PRIVATE_DIRECTORY');
  const heads = path.join(root,'published');
  const generations = path.join(root,'generations');
  if (writable) {
    await fs.mkdir(heads,{recursive:true,mode:0o700});
    await fs.mkdir(generations,{recursive:true,mode:0o700});
  }
  let cached;

  async function headNames() {
    const names = await fs.readdir(heads).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    return names.filter(name => headName.test(name)).sort().reverse();
  }

  async function readHead(name, file = path.join(heads,name)) {
    const {sha256,...state} = JSON.parse(await boundedRead(file,512*1024));
    if (state.schema !== 1 || state.revision !== Number(name.slice(0,12)) || !idPattern.test(state.id) ||
        !syncHash(sha256) || syncDigest(state) !== sha256 || !syncHash(state.fingerprint) ||
        !syncHash(state.snapshotSha256) || !syncHash(state.ledgerSha256) || !syncHash(state.indexSha256) ||
        !syncHash(state.catalogSha256) || !syncHash(state.baseSha256) || !syncHash(state.nearbySha256) ||
        !isDay(state.asOf) || !Number.isFinite(Date.parse(state.committedAt)) ||
        !state.dates || Object.entries(state.dates).some(([date,hash]) => !isDay(date) || !syncHash(hash))) {
      throw Error('OPSMAP_SYNC_HEAD');
    }
    const folder = path.join(generations,state.id);
    const input = path.join(folder,'input');
    const coverage = path.join(folder,'coverage');
    const [snapshotBytes, catalogBytes, baseBytes, ledgerBytes, indexBytes] = await Promise.all([
      verifiedBytes(path.join(folder,'snapshot.json'),state.snapshotSha256,8*1024*1024),
      verifiedBytes(path.join(input,'stores.private.json'),state.catalogSha256,3*1024*1024),
      verifiedBytes(path.join(input,'base.private.json'),state.baseSha256,3*1024*1024),
      verifiedBytes(path.join(folder,'fixed-store-coordinates-v1.json'),state.ledgerSha256,8*1024*1024),
      verifiedBytes(path.join(coverage,'coverage-index.json'),state.indexSha256,16_384)
    ]);
    const sealedSnapshot = validateSnapshotProjection(JSON.parse(snapshotBytes));
    const ledger = validateFixedCoordinateLedger(JSON.parse(ledgerBytes));
    const catalog = JSON.parse(catalogBytes);
    const index = parseCoverageIndex(indexBytes);
    if (index.sha256 !== state.generation || index.asOf !== state.asOf || !Array.isArray(catalog.stores)) throw Error('OPSMAP_SYNC_GENERATION');
    let window90;
    for (const ref of [index.catalog,...PERIODS.map(days => index.windows[days])]) {
      const bytes = await verifiedBytes(path.join(coverage,ref.sha256+'.json'),ref.sha256,ref.bytes);
      if (bytes.length !== ref.bytes) throw Error('OPSMAP_SYNC_COVERAGE_LENGTH');
      if (ref === index.windows[90]) window90 = JSON.parse(bytes);
    }
    const stores = new Map(catalog.stores.map(row => [row.code,row]));
    const registry = new Map(catalog.stores.filter(row => row.registered).map(row => {
      const addressHash = coordinateAddressHash(row.address);
      const proof = ledger.records[row.code]?.at(-1).point;
      return [row.code,{...row,addressHash,hasPoint:hasFixedCoordinatePoint(row),proof:proof?.addressHash===addressHash?proof:null}];
    }));
    const nearby = readStageNearbyEvidence(await verifiedBytes(path.join(folder,'nearby.json'),state.nearbySha256,384*1024),
      {expected:state.nearbySha256,generation:index.sha256,registry,window:window90});
    const snapshot = materializeSnapshot(sealedSnapshot);
    snapshot.rows = snapshot.rows.map(row => ({...row,address:stores.get(row.customerCode)?.address || ''}));
    return {state,folder,input,coverage,index,ledger,catalog,registry,nearby,baseCatalog:JSON.parse(baseBytes),sealedSnapshot,
      snapshot:{...snapshot,source:'STAGE_VERIFIED_REGISTRY',sourceGeneration:index.sha256}};
  }

  async function read({recheck = false} = {}) {
    const names = await headNames();
    if (!recheck && cached && names[0] === cached.name) return cached.value;
    for (const name of names.slice(0,2)) {
      try {
        const value = await readHead(name);
        cached = {name,value};
        return value;
      } catch { /* Retain the last complete generation, including after restart. */ }
    }
    if (cached) return cached.value;
    if (names.length) throw Error('OPSMAP_SYNC_NO_VALID_GENERATION');
    return null;
  }

  const latestRevision = async () => Number((await headNames())[0]?.slice(0,12) || 0);
  return {root, read, latestRevision, async readStatus() {
    try { return JSON.parse(await boundedRead(path.join(root,'sync-status.json'),32_768)); }
    catch { return null; }
  }, async readDay(date, generation) {
    if (!isDay(date)) throw Error('OPSMAP_SYNC_DAY');
    const active = generation ?? await read();
    const hash = active?.state.dates[date];
    if (!hash) return null;
    const data = await verifiedBytes(path.join(active.input,'observed-days',date+'.json'),hash,SYNC_MAX_DAY_BYTES);
    return validateOpsmapSyncDay(JSON.parse(data),date);
  }, async candidate(expectedRevision) {
    if (!writable) throw Error('OPSMAP_SYNC_READ_ONLY');
    if (await latestRevision() !== expectedRevision) throw Error('OPSMAP_SYNC_PUBLISH_CONFLICT');
    const revision = expectedRevision + 1;
    const id = randomUUID();
    const folder = path.join(generations,id);
    await fs.mkdir(folder,{mode:0o700});
    return {revision,id,folder};
  }, async publish(candidate, metadata) {
    if (!writable) throw Error('OPSMAP_SYNC_READ_ONLY');
    const {revision,id} = candidate;
    const state = {schema:1,revision,id,...metadata};
    const pending = path.join(heads,'.pending-'+id);
    const name = String(revision).padStart(12,'0') + '.json';
    let value;
    try {
      await atomicCoverageWrite(pending,JSON.stringify({...state,sha256:syncDigest(state)}));
      value = await readHead(name,pending);
      await fs.link(pending,path.join(heads,name));
    } catch (error) {
      if (error.code === 'EEXIST') throw Error('OPSMAP_SYNC_PUBLISH_CONFLICT');
      throw error;
    } finally { await fs.unlink(pending).catch(() => {}); }
    cached = {name,value};
    return value;
  }, async discard(candidate) {
    if (!writable || !idPattern.test(candidate.id) || candidate.folder !== path.join(generations,candidate.id)) throw Error('OPSMAP_SYNC_CANDIDATE');
    const folder = await fs.realpath(candidate.folder);
    if (path.dirname(folder) !== generations || path.basename(folder) !== candidate.id) throw Error('OPSMAP_SYNC_CANDIDATE');
    await fs.rm(folder,{recursive:true,force:true});
  }};
}

export function archivedOpsmapAssignments(day, generation) {
  if (!day || !generation) return null;
  const rows = new Map(generation.snapshot.rows.map(row => [row.customerCode,row]));
  const historicalHashes = new Map(generation.catalog.stores.map(row => [row.code,row.matchHash]));
  const grouped = new Map();
  for (const [,customerCode,vehicle,,hash,status] of day.tasks || day.visits) {
    if (!vehicle || status==='CANCELLED') continue;
    const known = rows.get(customerCode);
    const previous = grouped.get(vehicle+'|'+customerCode);
    const matches = previous?.lat !== null && hash !== null &&
      (day.tasks ? known?.originalAddressHash === hash : historicalHashes.get(customerCode) === hash);
    const complete = !day.tasks || status === 'COMPLETED' || previous?.status === 'COMPLETED';
    grouped.set(vehicle+'|'+customerCode,{customerCode,customerName:known?.customerName || customerCode,vehicle,
      deliveryDate:day.date,lastDeliveryDate:day.date,status:complete?'COMPLETED':'UNCONFIRMED',order:null,
      lat:matches?known?.lat ?? null:null,lng:matches?known?.lng ?? null:null});
  }
  const data = [...grouped.values()];
  if (!data.length) return null;
  return {ok:true,data,meta:{date:day.date,source:'STAGE_VERIFIED_DELIVERY_ARCHIVE',recordKind:day.tasks?'OBSERVED_ASSIGNMENTS':'ARCHIVE_COMPLETED',
    reviewOnly:true,complete:false,sourceComplete:false,rowCount:data.length,observedVisitCount:day.visits.length,
    sourceDayRows:day.sourceRows,vehicles:[...new Set(data.map(row => row.vehicle))]},error:null};
}
