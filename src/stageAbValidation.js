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
import {createOfficialAddressLookup} from './opsmapOfficialAddressLookup.js';
import {readStageArchivedDelivery} from './stageArchivedDelivery.js';

export const STAGE_ORIGIN = 'https://freshon-admin-stage-preview-template.onrender.com';
export const STAGE_SERVICE = 'srv-da47hugu01pc73etpfa0';
export const STAGE_BUNDLE_ROUTE = '/api/map-phase2b/private/stage-validation-bundle';

const profiles = new Map([
  ['f990ee60197d15afde6f3a59d65909d0660d87b7ed9a5ac0a4ab3a00f9f27a63',{
    generation:'8e906410020e7abcc765e659d17ff524772eff3dc690e49edc6a7b95d6970f58',
    ledger:'8206b6dc53676970f231b81f41ffd9d9320460e63e5904d8809b7d8f3a246c35',located:5035,buildings:0
  }],
  ['77c389680516fc9c94e5c4842300a582caac6fc9245b9cd3605101b97c52126b',{
    generation:'3df93605c76dcb279b405de3ab55171a2278b763ae67ddc5e8cec91891aa5585',
    ledger:'c930bc96b87ff0c2577167ac2caa44d759414fa7c0817daf0ba162b2799c9fd3',located:5044,buildings:9,
    addressIndex:'7e0e54434fdbacd591a87ccda45a75e9c089da9bfbfd32f66d59ee718ef29941',
    deliveryIndex:'826ce89623dd1274827ea886df6b04a213a75374fdacf3d5684077f4fb73ead0'
  }]
]);
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

function registryFromCatalog(catalog, ledger, profile) {
  if (!Array.isArray(catalog.stores) || catalog.stores.length !== 6043) throw Error('REGISTRY_SCOPE');
  const registry = new Map();
  let located = 0;
  let gpsCount = 0;
  let buildings = 0;
  for (const row of catalog.stores) {
    const {code, name, center, lat, lng} = row;
    const addressHash = coordinateAddressHash(row.address);
    if (!/^[A-Z]\d{1,20}$/.test(code) || registry.has(code) || row.registered !== true ||
        typeof name !== 'string' || name.length > 200 || (row.address && !addressHash)) throw Error('REGISTRY_IDENTITY');
    const hasPoint = hasFixedCoordinatePoint(row);
    if (hasPoint && !addressHash || !hasPoint && (lat != null || lng != null)) throw Error('REGISTRY_POINT');
    const point = ledger.records[code]?.at(-1)?.point;
    if (point) {
      if (!point.verifiedAt || !['DELIVERY_COMPLETION_GPS','BUILDING_LOCATION'].includes(point.measurementKind) ||
          point.addressHash !== addressHash || !hasPoint || point.lat !== lat || point.lng !== lng) throw Error('REGISTRY_POINT_BINDING');
      if (point.measurementKind === 'DELIVERY_COMPLETION_GPS') gpsCount++;
      else buildings++;
    }
    if (hasPoint) located++;
    registry.set(code, {code, name, center, address:row.address || '', addressHash, matchHash:row.matchHash || null, lat, lng, hasPoint, point});
  }
  if (located !== profile.located || gpsCount !== 298 || buildings !== profile.buildings ||
      Object.keys(ledger.records).length !== gpsCount + buildings) throw Error('REGISTRY_COUNTS');
  return registry;
}

function mappedPoint(store, existing) {
  const sameManual = existing.coordinateSource === 'MANUAL_PIN' && sameAddress(existing, store.addressHash) &&
    existing.lat === store.lat && existing.lng === store.lng;
  return {
    lat:store.lat, lng:store.lng, coordinateStatus:'CONFIRMED',
    coordinateSource:store.point?.coordinateSource || (sameManual ? 'MANUAL_PIN' : 'VERIFIED_STORE_POINT'),
    coordinateAccuracy:store.point?.coordinateAccuracy || (sameManual ? 'MANUAL' : 'UNVERIFIED'),
    originalAddressHash:store.addressHash,
    coordinateEvidence:store.point?.measurementKind || 'STAGE_REGISTRY_POINT'
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
    if (!store?.hasPoint || store.point || rowCode(row) === 'S191541' || reviewedConflict(row) ||
        hasFixedCoordinatePoint(row) || row.coordinateSource === 'MANUAL_PIN' || !sameAddress(row, store.addressHash)) return row;
    return {...row, ...mappedPoint(store, row)};
  });
}

export function createStageAbValidation({now = Date.now, tempRoot = tmpdir()} = {}) {
  let current, installation;

  function active() {
    return current && current.expiresAt > now() ? current : null;
  }

  async function load(bytes, profile, digest) {
    const bundle = JSON.parse(await DECOMPRESS(bytes, {maxOutputLength:5 * 1024 * 1024}));
    const indexBytes = Buffer.from(bundle[INDEX], 'base64');
    const index = parseCoverageIndex(indexBytes);
    const ledger = readFixedCoordinateLedger(Buffer.from(bundle[LEDGER], 'base64'), profile.ledger);
    if (index.sha256 !== profile.generation) throw Error('STAGE_GENERATION');
    const files = new Map([[INDEX, indexBytes]]);
    for (const ref of [index.catalog, ...PERIODS.map(days => index.windows[days])]) {
      const name = ref.sha256 + '.json';
      const data = Buffer.from(bundle[name], 'base64');
      if (data.length !== ref.bytes || sha256(data) !== ref.sha256) throw Error('STAGE_BLOB_INTEGRITY');
      files.set(name, data);
    }
    const addressLookup = profile.addressIndex ? createOfficialAddressLookup(
      Buffer.from(bundle['opsmap-official-address-index-v1.json'], 'base64'),{sha256:profile.addressIndex}) : null;
    const readArchivedDelivery = profile.deliveryIndex ? readStageArchivedDelivery(
      Buffer.from(bundle['opsmap-stage-dated-delivery-v1.json'], 'base64'),profile.deliveryIndex) : null;
    if (Object.keys(bundle).length !== files.size + 1 + Number(!!addressLookup) + Number(!!readArchivedDelivery)) throw Error('STAGE_BUNDLE_SCOPE');
    const registry = registryFromCatalog(JSON.parse(files.get(index.catalog.sha256 + '.json')), ledger, profile);
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
      const result = {directory, registry, resolver:createFixedCoordinateResolver(ledger), asOf:index.asOf,
        generation:index.sha256, digest, profile, evidence, addressLookup, readArchivedDelivery, expiresAt:appliedAt + TTL};
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
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_COMPRESSED) throw Error('STAGE_BUNDLE_DIGEST');
    const digest = sha256(bytes), profile = profiles.get(digest);
    if (!profile) throw Error('STAGE_BUNDLE_DIGEST');
    const current = active();
    if (current?.digest === digest) return current;
    if (current && current.profile.located > profile.located) throw Error('STAGE_BUNDLE_OLDER');
    if (installation && installation.digest !== digest) throw Error('STAGE_BUNDLE_LOADING');
    installation ??= {digest, promise:load(bytes,profile,digest).finally(() => {installation = null;})};
    return installation.promise;
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
  return prepared ? {active:true, generation:prepared.generation, registered:prepared.registry.size,
    located:prepared.profile.located, pending:prepared.evidence.pendingCoordinates,
    gpsCompletion:298,...(prepared.profile.buildings?{buildings:prepared.profile.buildings}:{}),
    expiresAt:new Date(prepared.expiresAt).toISOString()} : {active:false};
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
