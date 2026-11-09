import {createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import express from 'express';
import {coordinateAddressHash} from './opsmap-abc/opsmapAutoCoordinates.js';
import {createFixedCoordinateResolver, hasFixedCoordinatePoint, readFixedCoordinateLedger} from './fixedStoreCoordinates.js';
import {parseCoverageIndex, PERIODS} from './shadowCoverage/coverageFiles.js';

export const STAGE_ORIGIN = 'https://freshon-admin-stage-preview-template.onrender.com';
export const STAGE_SERVICE = 'srv-da47hugu01pc73etpfa0';
export const STAGE_BUNDLE_ROUTE = '/api/map-phase2b/private/stage-validation-bundle';

const BUNDLE_SHA256 = 'f990ee60197d15afde6f3a59d65909d0660d87b7ed9a5ac0a4ab3a00f9f27a63';
const GENERATION = '8e906410020e7abcc765e659d17ff524772eff3dc690e49edc6a7b95d6970f58';
const LEDGER_SHA256 = '8206b6dc53676970f231b81f41ffd9d9320460e63e5904d8809b7d8f3a246c35';
const INDEX = 'coverage-index.json';
const LEDGER = 'fixed-store-coordinates-v1.json';
const DECOMPRESS = promisify(gunzip);
const MAX_COMPRESSED = 1024 * 1024;
const TTL = 2 * 60 * 60 * 1000;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const rowCode = row => row?.customerCode || row?.code;
const address = row => row?.customerAddress || row?.basicAddress || row?.address;
const sameAddress = (row, hash) => {
  const claims = [coordinateAddressHash(address(row)), row.originalAddressHash, row.coordinateAddressHash, row.addressHash, row.currentAddressHash].filter(Boolean);
  return claims.length > 0 && claims.every(value => value === hash);
};
const reviewedConflict = row => row?.addressChanged === true || row?.coordinateStatus === 'CONFLICT' ||
  row?.resolutionStatus === 'ADDRESS_CHANGED_REVIEW_REQUIRED';

function registryFromCatalog(catalog, ledger) {
  if (!Array.isArray(catalog.stores) || catalog.stores.length !== 6043) throw Error('REGISTRY_SCOPE');
  const registry = new Map();
  let located = 0;
  let gpsCount = 0;
  for (const row of catalog.stores) {
    const {code, name, center, lat, lng} = row;
    const addressHash = coordinateAddressHash(row.address);
    if (!/^[A-Z]\d{1,20}$/.test(code) || registry.has(code) || row.registered !== true ||
        typeof name !== 'string' || name.length > 200 || (row.address && !addressHash)) throw Error('REGISTRY_IDENTITY');
    const hasPoint = hasFixedCoordinatePoint(row);
    if (hasPoint && !addressHash || !hasPoint && (lat != null || lng != null)) throw Error('REGISTRY_POINT');
    const gps = ledger.records[code]?.at(-1)?.point;
    if (gps) {
      if (!gps.verifiedAt || gps.measurementKind !== 'DELIVERY_COMPLETION_GPS' || gps.addressHash !== addressHash ||
          !hasPoint || gps.lat !== lat || gps.lng !== lng) throw Error('REGISTRY_GPS_BINDING');
      gpsCount++;
    }
    if (hasPoint) located++;
    registry.set(code, {code, name, center, address:row.address || '', addressHash, lat, lng, hasPoint, gps});
  }
  if (located !== 5035 || gpsCount !== 298 || Object.keys(ledger.records).length !== gpsCount) throw Error('REGISTRY_COUNTS');
  return registry;
}

function mappedPoint(store, existing) {
  const sameManual = existing.coordinateSource === 'MANUAL_PIN' && sameAddress(existing, store.addressHash) &&
    existing.lat === store.lat && existing.lng === store.lng;
  return {
    lat:store.lat, lng:store.lng, coordinateStatus:'CONFIRMED',
    coordinateSource:store.gps?.coordinateSource || (sameManual ? 'MANUAL_PIN' : 'VERIFIED_STORE_POINT'),
    coordinateAccuracy:store.gps?.coordinateAccuracy || (sameManual ? 'MANUAL' : 'UNVERIFIED'),
    originalAddressHash:store.addressHash,
    coordinateEvidence:store.gps ? 'DELIVERY_COMPLETION_GPS' : 'STAGE_REGISTRY_POINT'
  };
}

function projectedRegistry(registry, rows) {
  const saved = new Map(rows.map(row => [rowCode(row), row]));
  return [...registry.values()].map(store => {
    const previous = saved.get(store.code);
    const matching = previous && !reviewedConflict(previous) && sameAddress(previous, store.addressHash);
    const base = matching ? previous : {};
    const {lat:_lat, lng:_lng, latitude:_latitude, longitude:_longitude,
      coordinateStatus:_status, coordinateEvidence:_evidence, coordinateSource:_source, coordinateAccuracy:_accuracy,
      ...metadata} = base;
    const point = store.hasPoint ? mappedPoint(store, base) : {lat:null, lng:null, coordinateStatus:'MISSING'};
    return {...metadata, customerCode:store.code, customerName:store.name, address:store.address,
      originalAddressHash:store.addressHash, centerGroup:store.center, customerOnly:!matching || base.customerOnly === true,
      ...point};
  });
}

function joinMissing(registry, rows) {
  return rows.map(row => {
    const store = registry.get(rowCode(row));
    if (!store?.hasPoint || store.gps || rowCode(row) === 'S191541' || reviewedConflict(row) ||
        hasFixedCoordinatePoint(row) || row.coordinateSource === 'MANUAL_PIN' || !sameAddress(row, store.addressHash)) return row;
    return {...row, ...mappedPoint(store, row)};
  });
}

export function createStageAbValidation({now = Date.now, tempRoot = tmpdir()} = {}) {
  let current, installation;

  function active() {
    return current && current.expiresAt > now() ? current : null;
  }

  async function load(bytes) {
    const bundle = JSON.parse(await DECOMPRESS(bytes, {maxOutputLength:5 * 1024 * 1024}));
    const indexBytes = Buffer.from(bundle[INDEX], 'base64');
    const index = parseCoverageIndex(indexBytes);
    const ledger = readFixedCoordinateLedger(Buffer.from(bundle[LEDGER], 'base64'), LEDGER_SHA256);
    if (index.sha256 !== GENERATION) throw Error('STAGE_GENERATION');
    const files = new Map([[INDEX, indexBytes]]);
    for (const ref of [index.catalog, ...PERIODS.map(days => index.windows[days])]) {
      const name = ref.sha256 + '.json';
      const data = Buffer.from(bundle[name], 'base64');
      if (data.length !== ref.bytes || sha256(data) !== ref.sha256) throw Error('STAGE_BLOB_INTEGRITY');
      files.set(name, data);
    }
    if (Object.keys(bundle).length !== files.size + 1) throw Error('STAGE_BUNDLE_SCOPE');
    const registry = registryFromCatalog(JSON.parse(files.get(index.catalog.sha256 + '.json')), ledger);
    const directory = await mkdtemp(path.join(tempRoot, 'opsmap-ab-stage-'));
    try {
      for (const [name, data] of files) await writeFile(path.join(directory, name), data, {mode:0o600, flag:'wx'});
      const appliedAt = now();
      const evidence = {
        coordinateAppliedAt:new Date(appliedAt).toISOString(),
        coordinateScope:'STAGE_TEMPORARY',
        pendingCoordinates:[...registry.values()].filter(store => !store.hasPoint).length,
        coverageGeneratedAt:index.generatedAt,
        coverageSourceObservedAt:index.sourceObservedAt,
        coverageAsOf:index.asOf
      };
      const result = {directory, registry, resolver:createFixedCoordinateResolver(ledger), asOf:index.asOf, generation:index.sha256, evidence, expiresAt:appliedAt + TTL};
      current = result;
      setTimeout(() => {
        if (current === result) current = null;
        void rm(directory, {recursive:true, force:true}).catch(() => {});
      }, TTL).unref();
      return result;
    } catch (error) {
      await rm(directory, {recursive:true, force:true}).catch(() => {});
      throw error;
    }
  }

  async function activate(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_COMPRESSED || sha256(bytes) !== BUNDLE_SHA256) throw Error('STAGE_BUNDLE_DIGEST');
    return active() || (installation ??= load(bytes).finally(() => {installation = null;}));
  }

  function snapshot(saved) {
    const prepared = active();
    if (!prepared) return saved;
    const base = saved || {};
    const rows = projectedRegistry(prepared.registry, base.rows || []);
    return {...base, rows, rowCount:rows.length, latestDate:base.latestDate || prepared.asOf,
      source:'STAGE_VERIFIED_REGISTRY', sourceGeneration:prepared.generation};
  }

  function joinPayload(payload) {
    const prepared = active();
    if (!prepared || !payload || typeof payload !== 'object') return payload;
    const join = rows => joinMissing(prepared.registry, prepared.resolver.join(rows));
    if (Array.isArray(payload.data)) return {...payload, data:join(payload.data)};
    if (Array.isArray(payload.data?.rows)) return {...payload, data:{...payload.data, rows:join(payload.data.rows)}};
    if (Array.isArray(payload.data?.stops)) return {...payload, data:{...payload.data, stops:join(payload.data.stops)}};
    if (Array.isArray(payload.stops)) return {...payload, stops:join(payload.stops)};
    return payload;
  }

  return {activate, active, snapshot, joinPayload};
}

function publicStatus(prepared) {
  return prepared ? {active:true, generation:prepared.generation, registered:6043, located:5035, pending:1008,
    gpsCompletion:298, expiresAt:new Date(prepared.expiresAt).toISOString()} : {active:false};
}

export function mountStageAbValidation(router, {requireStaff, isSessionCurrent, validation}) {
  const noStore = (_req, res, next) => {res.set('Cache-Control','private, no-store').vary('Cookie'); next();};
  router.get(STAGE_BUNDLE_ROUTE, requireStaff, noStore, (_req, res) => res.json(publicStatus(validation.active())));
  router.post(STAGE_BUNDLE_ROUTE, requireStaff, noStore, (req,res,next) => {
    if (req.get('Origin') !== STAGE_ORIGIN || req.get('X-Opsmap-Stage-Verification') !== '1') return res.status(403).json({error:'STAGE_ORIGIN_REQUIRED'});
    next();
  }, express.raw({type:'application/octet-stream',limit:MAX_COMPRESSED,inflate:false}), async (req,res) => {
    try {
      if (!isSessionCurrent(req,res.locals.staffSession?.key)) return res.sendStatus(401);
      const prepared = await validation.activate(req.body);
      return requireStaff(req,res,() => res.json(publicStatus(prepared)));
    } catch {
      return res.status(422).json({error:'STAGE_BUNDLE_REJECTED'});
    }
  });

}
