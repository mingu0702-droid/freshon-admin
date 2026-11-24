import {createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import express from 'express';
import {coordinateAddressHash,externalCoordinateAddress} from './opsmap-abc/opsmapAutoCoordinates.js';
import {createFixedCoordinateResolver, hasFixedCoordinatePoint, readFixedCoordinateLedger} from './fixedStoreCoordinates.js';
import {isDay, parseCoverageIndex, PERIODS} from './shadowCoverage/coverageFiles.js';
import {readStageArchivedDelivery} from './stageArchivedDelivery.js';
import {createOfficialAddressLookup,createOfficialAddressReview,officialAddressKey} from './opsmapOfficialAddressLookup.js';
import {addStaffTiming} from './opsmap-abc/staffLatency.js';
import {createLegacyNearbyVehicleReader, readStageNearbyEvidence, stageNearbyResponse} from './stageNearbyEvidence.js';
import {preparePreservedAddressIndex,prepareStageAddressMasterIndex,resolvePreservedAddressBatch,searchPreservedRegistry} from './privateCustomerSearch.js';
import {archivedOpsmapAssignments} from './opsmapSyncGeneration.js';
import {collectStageVehicleWeekdays, opsmapVehicleDeliveryPage} from './opsmapVehicleDeliveryEvidence.js';
import {SYNC_DELIVERY_SOURCES} from './opsmapSyncPolicy.js';
import {archivedDatedDispatch} from './datedDeliveryContract.js';

import {STAGE_ORIGIN,STAGE_SERVICE,STAGE_BUNDLE_ROUTE,STAGE_NEARBY_ROUTE,STAGE_VEHICLE_DELIVERY_ROUTE,STAGE_ADDRESS_BATCH_ROUTE,MAX_STAGE_BUNDLE_BYTES} from './stageScope.js';
export {STAGE_ORIGIN,STAGE_SERVICE,STAGE_BUNDLE_ROUTE,STAGE_NEARBY_ROUTE,STAGE_ADDRESS_BATCH_ROUTE,MAX_STAGE_BUNDLE_BYTES} from './stageScope.js';

const currentProfile = {
  generation:'3df93605c76dcb279b405de3ab55171a2278b763ae67ddc5e8cec91891aa5585',
  ledger:'c930bc96b87ff0c2577167ac2caa44d759414fa7c0817daf0ba162b2799c9fd3',
  official:9, addressIndex:'7e0e54434fdbacd591a87ccda45a75e9c089da9bfbfd32f66d59ee718ef29941',
  archive:'826ce89623dd1274827ea886df6b04a213a75374fdacf3d5684077f4fb73ead0'
};

const bundles = new Map([
  ['f990ee60197d15afde6f3a59d65909d0660d87b7ed9a5ac0a4ab3a00f9f27a63', {
    version:1, generation:'8e906410020e7abcc765e659d17ff524772eff3dc690e49edc6a7b95d6970f58',
    ledger:'8206b6dc53676970f231b81f41ffd9d9320460e63e5904d8809b7d8f3a246c35', official:0
  }],
  ['2c442f181244a536c597e686e1c73ffabc4aca5d8862a71468c9897f7f8961ee', {
    version:2, generation:'dc02f573b0597846620c75d24f01c23284a3030f58bd8f67f7cb9c08ffb83960',
    ledger:'cd6c04c20076cd609249c93613769faa7aa5b47c1b7759a0084d72dcda3c507d', official:8
  }],
  ['fd76f1dcf1a78289b6557dc7a9b2cffbe23d059da94788c0a0862e319cb76bdd', {
    version:3, generation:'dc02f573b0597846620c75d24f01c23284a3030f58bd8f67f7cb9c08ffb83960',
    ledger:'cd6c04c20076cd609249c93613769faa7aa5b47c1b7759a0084d72dcda3c507d', official:8,
    archive:'11e72a5e987660ef18865acb8f541700cda847ac937aa82541a1d6221611254a'
  }],
  ['77c389680516fc9c94e5c4842300a582caac6fc9245b9cd3605101b97c52126b',{...currentProfile, version:4}],
  ['94806273844c0ca4f7c6d8c0c8a30762c06bfd9c3bcd6cb801c1b9cdb7f80896',{
    ...currentProfile, version:5, nearby:'71949a90c9ca1412753c72f21e8594649d2babe6c5e1804da32a1939fc927e43'
  }],
  ['98773bd97fb457da292cf5376b762eb5afdf077930e9f14f7a266d6dfb02cd0e',{
    ...currentProfile, version:6, official:38,
    generation:'506774f9e38c2c4cc7b900c53f32d8c31c4623e45cc1ef5d9350254a6bf20ed6',
    ledger:'8065d5fdea2653d542730e95acc669ab578356680bfb74857c7504180aed60ca',
    nearby:'cb2d51833b478ab589843d09a868eeab5379ac8643de1d65b1561cb98941ba60'
  }],
  ['7ddddb915546fbcf0b462c242fac318d454e0569583b0d45d155c2b62bc83f76',{
    ...currentProfile, version:7, official:395,
    generation:'f15280152af5363bddeee7752c48f053da348fd1d2101999a18d40e23f91ecba',
    ledger:'6cf537e3444fd6a790e3582c554075ff556a9c33492ea2a97dccd59602d8ee85',
    nearby:'6d9c2caa87bbf93e9f3301b96a20f9173155948db69b45063b360e9192bbabe0',
    addressReview:'1668c2d407eb93f295bd08276af2c5ede9b3e0bd58580f1fcd01273e65edb5b7'
  }],
  ['1dc652a346539cc8cf265b20ad681e4c0ea01957e6fc1126a11357abc8ee677c',{
    ...currentProfile, version:8, gps:525, official:395,
    generation:'86a2aba6595d3abcb9f8a1cd3fa5531296cca3242c187e465d320bf034fc92a9',
    ledger:'781312bba532851c63343837aaef3fb5f77a38aecdfda2090b48b12334771cfb',
    nearby:'db3679ce939db0bf742621e6b98158c6db76740c282a53532ef805b6c6d0055f',
    addressReview:'1668c2d407eb93f295bd08276af2c5ede9b3e0bd58580f1fcd01273e65edb5b7'
  }]
]);
const INDEX = 'coverage-index.json';
const LEDGER = 'fixed-store-coordinates-v1.json';
const DELIVERY_ARCHIVE = 'verified-delivery-observations-v1.json';
const DECOMPRESS = promisify(gunzip);
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

function registryFromCatalog(catalog, ledger, {official:expectedOfficial,gps:expectedGps=298}) {
  if (!Array.isArray(catalog.stores) || catalog.stores.length !== 6043) throw Error('REGISTRY_SCOPE');
  const registry = new Map();
  let located = 0;
  let gpsCount = 0;
  let officialCount = 0;
  for (const row of catalog.stores) {
    const {code, name, center, lat, lng} = row;
    const addressHash = coordinateAddressHash(row.address);
    if (!/^[A-Z]\d{1,20}$/.test(code) || registry.has(code) || row.registered !== true ||
        typeof name !== 'string' || name.length > 200 || (row.address && !addressHash)) throw Error('REGISTRY_IDENTITY');
    const hasPoint = hasFixedCoordinatePoint(row);
    if (hasPoint && !addressHash || !hasPoint && (lat != null || lng != null)) throw Error('REGISTRY_POINT');
    const proof = ledger.records[code]?.at(-1)?.point;
    if (proof) {
      if (!proof.verifiedAt || proof.addressHash !== addressHash || !hasPoint ||
          proof.lat !== lat || proof.lng !== lng) throw Error('REGISTRY_POINT_BINDING');
      if (proof.measurementKind === 'DELIVERY_COMPLETION_GPS') gpsCount++;
      else if (proof.measurementKind === 'BUILDING_LOCATION' && proof.evidenceSource === 'OFFICIAL_ADDRESS_DATA') officialCount++;
      else throw Error('REGISTRY_POINT_SOURCE');
    }
    if (hasPoint) located++;
    registry.set(code, {code, name, center, address:row.address || '', addressHash, lat, lng, hasPoint, proof,
      matchHash:addressHash && /^[a-f0-9]{64}$/.test(row.matchHash || '') ? row.matchHash : null});
  }
  if (located !== 4737 + expectedGps + expectedOfficial || gpsCount !== expectedGps || officialCount !== expectedOfficial ||
      Object.keys(ledger.records).length !== gpsCount + officialCount) throw Error('REGISTRY_COUNTS');
  return {registry, counts:{registered:registry.size, located, pending:registry.size-located, gpsCompletion:gpsCount, officialBuilding:officialCount}};
}

function mappedPoint(store, existing) {
  const sameManual = existing.coordinateSource === 'MANUAL_PIN' && sameAddress(existing, store.addressHash) &&
    existing.lat === store.lat && existing.lng === store.lng;
  return {
    lat:store.lat, lng:store.lng, coordinateStatus:'CONFIRMED',
    coordinateSource:store.proof?.coordinateSource || (sameManual ? 'MANUAL_PIN' : 'VERIFIED_STORE_POINT'),
    coordinateAccuracy:store.proof?.coordinateAccuracy || (sameManual ? 'MANUAL' : 'UNVERIFIED'),
    originalAddressHash:store.addressHash,
    coordinateEvidence:store.proof?.measurementKind || 'STAGE_REGISTRY_POINT'
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
    if (!store?.hasPoint || store.proof || rowCode(row) === 'S191541' || reviewedConflict(row) ||
        hasFixedCoordinatePoint(row) || row.coordinateSource === 'MANUAL_PIN' || !sameAddress(row, store.addressHash)) return row;
    return {...row, ...mappedPoint(store, row)};
  });
}

// A sealed publication can have fewer pins after a confirmed move or closure.
// Check the affected identities and their original bindings before using it.
function preservesVerifiedGeneration(previous, candidate) {
  if (candidate.index.asOf < previous.asOf || candidate.ledger.revision < previous.ledger.revision) return false;
  for (const [code, history] of Object.entries(previous.ledger.records)) {
    const next = candidate.ledger.records[code];
    if (!next || JSON.stringify(next.slice(0,history.length)) !== JSON.stringify(history)) return false;
  }
  const base = new Map(candidate.baseCatalog.stores.map(row => [row.code,row]));
  const currentBinding = (store, hash) => store.originalAddressHash === hash &&
    (store.coordinateSource === 'MANUAL_PIN' ||
      store.proof?.addressHash === hash && store.proof.lat === store.lat && store.proof.lng === store.lng);
  for (const [code, prior] of previous.registry) {
    const next = candidate.registry.get(code);
    const row = base.get(code);
    const evidence = row?.registryTransition;
    const changed = kind => /^[a-f0-9]{64}$/.test(evidence?.version || '') &&
      evidence.kind === kind && evidence.previousAddressHash === prior.addressHash;
    if (!next) {
      if (code === 'S191541' || row?.registered !== false || !changed('EXPLICIT_DELETION')) return false;
    } else if (prior.addressHash !== next.addressHash) {
      if (code === 'S191541' || !next.addressHash || coordinateAddressHash(row?.address) !== next.addressHash ||
          !changed('ADDRESS_CHANGED') || next.hasPoint && !currentBinding(next,next.addressHash)) return false;
    } else if (prior.hasPoint && (!next.hasPoint || prior.lat !== next.lat || prior.lng !== next.lng)) {
      const currentManual = next.coordinateSource === 'MANUAL_PIN' && next.hasPoint && currentBinding(next,next.addressHash);
      // Within the same publisher, a manual revert restores the sealed base or
      // the fixed ledger. It does not authorize loss of any verified base point.
      const restoredBase = previous.scheduled && prior.coordinateSource === 'MANUAL_PIN' &&
        row?.registered === true && coordinateAddressHash(row.address) === next.addressHash &&
        (next.hasPoint
          ? next.lat === row.lat && next.lng === row.lng || currentBinding(next,next.addressHash)
          : !hasFixedCoordinatePoint(row) && !next.proof);
      if (code === 'S191541' || !currentManual && !restoredBase) return false;
    }
  }
  return true;
}

export function createStageAbValidation({now = Date.now, tempRoot = tmpdir(), retainCoverageFiles = true} = {}) {
  let temporary, durable, scheduled, installation, lastTemporary;

  function fallback() {
    return temporary?.expiresAt > now() && (!durable || temporary.version>durable.version) ? temporary : durable || null;
  }
  function active() {
    const verified = fallback();
    if (!verified || !scheduled) return scheduled || verified;
    if (scheduled.reference !== verified) {
      scheduled.reference = verified;
      scheduled.compatible = preservesVerifiedGeneration(verified,scheduled.scheduled);
    }
    return scheduled.compatible ? scheduled : verified;
  }

  function followScheduled(generation, readDay, {baseline=false}={}) {
    if (!generation) return false;
    if (scheduled?.scheduled === generation) return active() === scheduled;
    const previous = scheduled?.scheduled;
    if (previous && (baseline || generation.index.asOf < previous.index.asOf ||
        !scheduled.baseline && generation.state.revision <= previous.state.revision)) return false;
    const selected = active();
    if (selected && !preservesVerifiedGeneration(selected,generation)) return false;
    const {registry,index,ledger,coverage,nearby,snapshot,state} = generation;
    const located = [...registry.values()].filter(row => row.hasPoint).length;
    const proof = Object.values(ledger.records).map(history => history.at(-1).point).filter(Boolean);
    const deliveries=generation.vehicleDelivery;
    let projectedNearby, resolver;
    scheduled = {scheduled:generation,baseline,directory:coverage,registry,ledger,
      get nearby() {
        if(!deliveries)return nearby;
        if(!projectedNearby){
          const vehicleEvidence=collectStageVehicleWeekdays(deliveries,registry);
          const unverifiedVehicleSources=['yeongnam','osanColdStorage'].filter(source=>
            !deliveries.completeSources[SYNC_DELIVERY_SOURCES[source]].length);
          projectedNearby={...nearby,vehicleDays:vehicleEvidence.vehicleDays,vehicleCounts:vehicleEvidence.counts,unverifiedVehicleSources};
        }
        return projectedNearby;
      },
      snapshot,asOf:index.asOf,
      reference:fallback(),compatible:true,
      generation:index.sha256,expiresAt:Infinity,
      get resolver() {return resolver ??= createFixedCoordinateResolver(ledger);},
      counts:{registered:registry.size,located,pending:registry.size-located,
        gpsCompletion:proof.filter(row=>row.measurementKind==='DELIVERY_COMPLETION_GPS').length,
        officialBuilding:proof.filter(row=>row.measurementKind==='BUILDING_LOCATION').length,
        officialAddressApproximate:proof.filter(row=>row.measurementKind==='ADDRESS_LOCATION').length},
      evidence:{coordinateAppliedAt:state.committedAt,coordinateScope:baseline?'STAGE_VERIFIED_OFFLINE_BASELINE':'STAGE_APPROVED_SCHEDULED_GENERATION',
        pendingCoordinates:registry.size-located,coverageGeneratedAt:index.generatedAt,
        coverageSourceObservedAt:index.sourceObservedAt,coverageAsOf:index.asOf},
      get bundledAddress() {return fallback()?.bundledAddress;},
      readNearbyDay:date=>readDay(date,generation),
      async archived(date) {
        const day = await readDay(date==='latest'?index.asOf:date,generation).catch(()=>null);
        return archivedOpsmapAssignments(day,generation) ?? fallback()?.archived?.(date,registry) ?? null;
      }};
    if (active() !== scheduled) return false;
    // Build the private index as the verified projection becomes available.
    void Promise.resolve().then(() => preparePreservedAddressIndex(snapshot)).catch(() => {});
    return true;
  }

  async function load(bytes, expected, durableRead) {
    const bundle = JSON.parse(await DECOMPRESS(bytes, {maxOutputLength:5 * 1024 * 1024}));
    const indexBytes = Buffer.from(bundle[INDEX], 'base64');
    const index = parseCoverageIndex(indexBytes);
    const ledger = readFixedCoordinateLedger(Buffer.from(bundle[LEDGER], 'base64'), expected.ledger);
    if (index.sha256 !== expected.generation) throw Error('STAGE_GENERATION');
    const files = new Map([[INDEX, indexBytes]]);
    for (const ref of [index.catalog, ...PERIODS.map(days => index.windows[days])]) {
      const name = ref.sha256 + '.json';
      const data = Buffer.from(bundle[name], 'base64');
      if (data.length !== ref.bytes || sha256(data) !== ref.sha256) throw Error('STAGE_BLOB_INTEGRITY');
      files.set(name, data);
    }
    const bundledAddress = expected.addressIndex ? createOfficialAddressLookup(
      Buffer.from(bundle['opsmap-official-address-index-v1.json'], 'base64'), {sha256:expected.addressIndex}) : null;
    const addressReview = expected.addressReview ? createOfficialAddressReview(
      Buffer.from(bundle['opsmap-official-address-review-v1.json'], 'base64'), {sha256:expected.addressReview}) : null;
    const archived = expected.archive
      ? readStageArchivedDelivery(Buffer.from(bundle[expected.addressIndex ? 'opsmap-stage-dated-delivery-v1.json' : DELIVERY_ARCHIVE], 'base64'), expected.archive) : null;
    const catalog = JSON.parse(files.get(index.catalog.sha256 + '.json'));
    const {registry, counts} = registryFromCatalog(catalog, ledger, expected);
    const nearby = expected.nearby ? readStageNearbyEvidence(Buffer.from(bundle['opsmap-stage-nearby-v1.json'], 'base64'), {
      expected:expected.nearby, generation:index.sha256, registry, window:JSON.parse(files.get(index.windows[90].sha256 + '.json'))
    }) : null;
    if (Object.keys(bundle).length !== files.size + 1 + Number(!!archived) + Number(!!bundledAddress) + Number(!!addressReview) + Number(!!nearby)) {
      throw Error('STAGE_BUNDLE_SCOPE');
    }
    const directory = retainCoverageFiles ? await mkdtemp(path.join(tempRoot, 'opsmap-ab-stage-')) : null;
    try {
      if (directory) for (const [name, data] of files) await writeFile(path.join(directory, name), data, {mode:0o600, flag:'wx'});
      const appliedAt = now();
      const evidence = {
        coordinateAppliedAt:new Date(appliedAt).toISOString(),
        coordinateScope:durableRead?'STAGE_APPROVED_READ_ONLY_FILE':'STAGE_TEMPORARY',
        pendingCoordinates:counts.pending,
        coverageGeneratedAt:index.generatedAt,
        coverageSourceObservedAt:index.sourceObservedAt,
        coverageAsOf:index.asOf
      };
      const result = {directory, registry, ledger, counts, resolver:createFixedCoordinateResolver(ledger), asOf:index.asOf,
        ...(!retainCoverageFiles && {coverageIndex:index,readPostalCatalog:()=>catalog}),
        generation:index.sha256, version:expected.version, archived, nearby, evidence, expiresAt:durableRead?Infinity:appliedAt + TTL,
        bundledAddress:addressReview ? {lookup:query => bundledAddress?.lookup(query) || addressReview.lookup(query)} : bundledAddress};
      if (!durableRead) {
        temporary=result;
        lastTemporary={generation:result.generation,expiresAt:result.expiresAt};
        setTimeout(() => {
          if (temporary === result) temporary = null;
          if (directory) void rm(directory, {recursive:true, force:true}).catch(() => {});
        }, TTL).unref();
      } else {
        const previous=durable;
        durable=result;
        if (previous?.directory) setTimeout(() => {
          void rm(previous.directory, {recursive:true, force:true}).catch(() => {});
        },30_000).unref();
      }
      return result;
    } catch (error) {
      if (directory) await rm(directory, {recursive:true, force:true}).catch(() => {});
      throw error;
    }
  }

  async function activate(bytes, {durableRead=false} = {}) {
    const expected = Buffer.isBuffer(bytes) && bytes.length <= MAX_STAGE_BUNDLE_BYTES && bundles.get(sha256(bytes));
    if (!expected) throw Error('STAGE_BUNDLE_DIGEST');
    if (installation) {
      if (installation.expected !== expected || installation.durableRead!==durableRead) throw Error('STAGE_BUNDLE_LOADING');
      return installation.promise;
    }
    const prepared = durableRead ? durable : fallback();
    if (prepared?.version > expected.version) throw Error('STAGE_BUNDLE_REGRESSION');
    if (prepared?.version === expected.version && (!durableRead || prepared.expiresAt===Infinity)) return prepared;
    installation = {expected,durableRead,promise:load(bytes, expected,durableRead).finally(() => {installation = null;})};
    return installation.promise;
  }

  function snapshot(saved) {
    const prepared = active();
    if (!prepared) return saved;
    if (prepared.scheduled) return prepared.snapshot;
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

  function archivedAssignments(date) {
    const prepared = active();
    return prepared?.archived?.(date, prepared.registry) ?? null;
  }
  function addressGenerationError(generation, prepared) {
    if ((prepared?.generation ?? null) === generation) return null;
    return generation && lastTemporary?.generation===generation && lastTemporary.expiresAt<=now()
      ? 'STAGE_BATCH_GENERATION_EXPIRED' : 'STAGE_BATCH_GENERATION_CHANGED';
  }
  return {activate, active, snapshot, joinPayload, archivedAssignments, followScheduled, addressGenerationError};
}

function publicStatus(prepared) {
  return prepared ? {active:true, generation:prepared.generation, ...prepared.counts,
    expiresAt:Number.isFinite(prepared.expiresAt)?new Date(prepared.expiresAt).toISOString():null} : {active:false};
}

const externalAddressMisses=new Set(['ADDRESS_NOT_MATCHED','OFFICIAL_ADDRESS_UNAVAILABLE','OFFICIAL_ADDRESS_INDEX_UNAVAILABLE','OFFICIAL_COORDINATE_UNVERIFIED']);
const reviewAddressResults=new Set(['ADDRESS_AMBIGUOUS','OFFICIAL_ADDRESS_AMBIGUOUS','OFFICIAL_ADDRESS_REVIEW_REQUIRED',
  'STORED_COORDINATE_UNVERIFIED','OFFICIAL_COORDINATE_UNVERIFIED','INVALID_ADDRESS']);
const failedAddressResults=new Set(['OFFICIAL_ADDRESS_UNAVAILABLE','OFFICIAL_ADDRESS_INDEX_UNAVAILABLE','STORED_REGISTRY_UNAVAILABLE']);
const blockedExternalErrors=new Set(['GEOCODING_DISABLED','GEOCODE_DAILY_LIMIT','GEOCODE_AUTOMATICALLY_BLOCKED',
  'GEOCODE_RETRY_COOLDOWN','TARGET_APP_FREE_QUOTA_UNVERIFIED','TARGET_APP_KEYWORD_FREE_QUOTA_UNVERIFIED','GEOCODE_QUERY_INVALID']);
const addressState=status=>status==='STORED'?'STORED_VERIFIED':status==='OFFICIAL'?'OFFICIAL_VERIFIED':
  reviewAddressResults.has(status)?'CANDIDATE_REVIEW':failedAddressResults.has(status)?'LOOKUP_FAILED':'SOURCE_NOT_COVERED';

const dailyCenters=['osan','yeongnam','honam'];
export function stageNearbyDispatchDay(prepared,date,day) {
  const centers=Object.fromEntries(dailyCenters.map(center=>[center,'UNKNOWN']));
  const rows=new Map();
  if(day?.date===date&&Array.isArray(day.dispatch?.sources)) for(const center of dailyCenters){
    const view=archivedDatedDispatch(day,{center,generation:prepared.generation,
      sourceRunId:prepared.scheduled?.state?.runId,publishedAt:prepared.scheduled?.state?.committedAt});
    if(view?.sourceComplete!==true||view.scopeComplete!==true||view.date!==date)continue;
    centers[center]='VERIFIED';
    for(const row of view.rows){
      if(!row.vehicle||row.state==='CANCELLED'||!/^[A-Z]\d{1,20}$/.test(row.customerCode))continue;
      const key=`${center}|${row.customerCode}|${row.vehicle}`;
      const completed=row.state==='COMPLETED'||rows.get(key)?.completed===true;
      rows.set(key,{customerCode:row.customerCode,center,vehicle:row.vehicle,completed});
    }
  }
  const verified=Object.values(centers).filter(state=>state==='VERIFIED').length;
  return {contract:'opsmap-nearby-dispatch-day-v1',generation:prepared.generation,date,
    state:verified===dailyCenters.length?'VERIFIED':verified?'PARTIAL':'UNAVAILABLE',centers,rows:[...rows.values()]};
}

export function mountStageAbValidation(router, {requireStaff, isSessionCurrent, validation, readBaseVehicles, readSnapshot, readReadySnapshot, readOfficialIndex, readAddressMaster, externalAddressLookup,origin=STAGE_ORIGIN}) {
  const noStore = (_req, res, next) => {res.set('Cache-Control','private, no-store').vary('Cookie'); next();};
  const readVehicleDays=createLegacyNearbyVehicleReader();
  router.get(STAGE_BUNDLE_ROUTE, requireStaff, noStore, (_req, res) => res.json(publicStatus(validation.active())));
  router.get(STAGE_NEARBY_ROUTE, requireStaff, noStore, async (req, res) => {
    const prepared = validation.active();
    if(req.query.view==='day'){
      const {date,generation}=req.query;
      const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
      if(!isDay(date)||date>today||typeof generation!=='string'||!/^[a-f0-9]{64}$/.test(generation)||
         Object.keys(req.query).some(key=>!['view','date','generation'].includes(key)))
        return res.status(400).json({error:'STAGE_NEARBY_DAY_QUERY'});
      if(!prepared)return res.status(503).json({error:'STAGE_NEARBY_NOT_READY'});
      if(generation!==prepared.generation)return res.status(409).json({error:'STAGE_NEARBY_GENERATION_CHANGED'});
      let archive,result;
      try {
        archive=await prepared.readNearbyDay?.(date);
        result=stageNearbyDispatchDay(prepared,date,archive);
      } catch {result=stageNearbyDispatchDay(prepared,date,null);}
      return requireStaff(req,res,()=>{
        if(!isSessionCurrent(req,res.locals.staffSession?.key))return res.status(401).json({error:'STAFF_LOGIN_REQUIRED'});
        if(validation.active()!==prepared)return res.status(409).json({error:'STAGE_NEARBY_GENERATION_CHANGED'});
        return res.json(result);
      });
    }
    if (!prepared?.nearby) return res.status(503).json({error:'STAGE_NEARBY_NOT_READY'});
    if (req.query.generation && req.query.generation!==prepared.generation) return res.status(409).json({error:'STAGE_NEARBY_GENERATION_CHANGED'});
    const codes = [...prepared.registry.values()].filter(store => store.hasPoint).map(store => store.code);
    const [fixed,vehicles] = await Promise.all([
      req.query.view==='observed' ? null : readBaseVehicles?.(codes).catch(() => null),readVehicleDays(prepared)
    ]);
    return requireStaff(req, res, () => {
      if (validation.active() !== prepared) return res.status(409).json({error:'STAGE_NEARBY_GENERATION_CHANGED'});
      const {observedDates:_dates,...archive}=prepared.nearby;
      return res.json(stageNearbyResponse({...archive,...vehicles},fixed));
    });
  });
  router.get(STAGE_VEHICLE_DELIVERY_ROUTE, requireStaff, noStore, async (req,res)=>{
    const {generation,center,vehicle,offset='0',limit='200',box}=req.query;
    if(typeof generation!=='string'||!/^[a-f0-9]{64}$/.test(generation)||
        typeof offset!=='string'||!/^\d{1,5}$/.test(offset)||typeof limit!=='string'||!/^\d{1,3}$/.test(limit)) {
      return res.status(400).json({error:'STAGE_VEHICLE_DELIVERY_QUERY'});
    }
    const prepared=validation.active();
    const evidence=prepared?.scheduled?.vehicleDelivery;
    if(!evidence)return res.status(503).json({error:'STAGE_VEHICLE_DELIVERY_NOT_READY'});
    if(prepared.generation!==generation)return res.status(409).json({error:'STAGE_VEHICLE_DELIVERY_GENERATION_CHANGED'});
    let page;
    try {
      const values=box===undefined?undefined:typeof box==='string'&&box.length<=100?box.split(','):null;
      if(values!==undefined&&(!values||values.some(value=>!/^-?\d+(?:\.\d+)?$/.test(value))))throw Error('STAGE_VEHICLE_DELIVERY_QUERY');
      page=opsmapVehicleDeliveryPage(evidence,prepared.registry,{center,vehicle,offset:Number(offset),limit:Number(limit),box:values?.map(Number)});
    }
    catch {return res.status(400).json({error:'STAGE_VEHICLE_DELIVERY_QUERY'});}
    const codes=[...new Set(page.rows.map(row=>row.customerCode))];
    const fixed=codes.length?await Promise.resolve().then(()=>readBaseVehicles?.(codes)).catch(()=>null):null;
    return requireStaff(req,res,()=>{
      if(validation.active()!==prepared)return res.status(409).json({error:'STAGE_VEHICLE_DELIVERY_GENERATION_CHANGED'});
      return res.json(stageNearbyResponse({...page,sourceRunId:prepared.scheduled.state.runId||null},fixed));
    });
  });
  const addressStaff=(req,res,next)=>res.locals.staffSession?.key ? next() : requireStaff(req,res,next);
  router.post(STAGE_ADDRESS_BATCH_ROUTE,addressStaff,noStore,(req,res,next)=>{
    if(req.get('Origin')!==origin) return res.status(403).json({error:'STAGE_ORIGIN_REQUIRED'});
    if(!req.is('application/json')) return res.status(415).json({error:'STAGE_BATCH_MEDIA_TYPE'});
    return next();
  },express.json({limit:'96kb'}),async(req,res)=>{
    const {generation,queries,rows,includeCustomers,external}=req.body||{};
    const queryOk=query=>typeof query==='string'&&query.length>=2&&query.length<=200&&!/[\x00-\x1f]/.test(query);
    if(rows!==undefined){
      if(queries!==undefined||!(generation===null||typeof generation==='string'&&/^[a-f0-9]{64}$/.test(generation))||
        !Array.isArray(rows)||rows.length<1||rows.length>120||rows.some(row=>!Array.isArray(row)||row.length>2||!row.every(queryOk))||
        includeCustomers!==undefined&&(includeCustomers!==true||rows.length!==1)||
        external!==undefined&&(!['prepare','resolve'].includes(external)||includeCustomers!==true||!generation||
          !officialAddressKey(rows[0][0])||!externalCoordinateAddress(rows[0][0])||
          rows[0].some(query=>officialAddressKey(query)!==officialAddressKey(rows[0][0])))) {
        return res.status(400).json({error:'STAGE_BATCH_QUERY_INVALID'});
      }
      const started=performance.now();
      let outcomes=null, stateRows;
      res.once('finish',()=>console.info(JSON.stringify({component:'stage-address-batch',rows:rows.length,
        status:res.statusCode,durationMs:Math.round(performance.now()-started),outcomes,
        states:stateRows?.reduce((counts,{state})=>({...counts,[state]:(counts[state]||0)+1}),{})??null})));
      const prepared=validation.active();
      const generationError=validation.addressGenerationError(generation,prepared);
      if(generationError)return res.status(409).json({error:generationError});
      try{
        const loaded=generation!==null ? prepared?.scheduled?.snapshot||readReadySnapshot?.() : null;
        const immediate=loaded?.sourceGeneration===generation&&Array.isArray(loaded?.rows);
        const [saved,master]=await Promise.all([
          immediate?loaded:readSnapshot(),Promise.resolve().then(()=>readAddressMaster?.()).catch(()=>null)
        ]);
        const changed=validation.addressGenerationError(generation,validation.active());
        if(changed||validation.active()!==prepared||generation!==null&&saved?.sourceGeneration!==generation)
          return res.status(409).json({error:changed||'STAGE_BATCH_GENERATION_CHANGED'});
        const bundled=prepared?.bundledAddress, independent=readOfficialIndex?.();
        const official=bundled||independent?{lookup(query){
          const primary=bundled?.lookup(query);
          if(primary&&(!primary.kind||primary.kind==='EXACT'||primary.kind==='CHOOSE'))return primary;
          return independent?.lookup(query)??primary;
        }}:null;
        const snapshotReady=Array.isArray(saved?.rows);
        if(!snapshotReady&&!official&&!master)return res.status(503).json({error:'STAGE_BATCH_UNAVAILABLE',state:'LOOKUP_FAILED'});
        const preparing=performance.now();
        if(rows.some(row=>row.some(query=>!/^[A-Z]\d{1,20}$/i.test(query)))) {
          await Promise.all([preparePreservedAddressIndex(saved),prepareStageAddressMasterIndex(master)]);
        }
        if(res.destroyed||res.writableEnded)return;
        const matching=performance.now();
        const lookupTimings=includeCustomers?{}:null;
        const data=resolvePreservedAddressBatch(rows,snapshotReady?saved:{rows:[]},official,{includeCustomers,timings:lookupTimings,master,
          includeExternalEligibility:!!external}).map(row=>
          !snapshotReady&&['CUSTOMER_CODE_NOT_FOUND','ADDRESS_NOT_MATCHED'].includes(row.status)
            ?{status:'STORED_REGISTRY_UNAVAILABLE',state:'LOOKUP_FAILED'}:{...row,state:addressState(row.status)});
        stateRows=data;
        const matched=performance.now();
        outcomes=data.reduce((counts,{status})=>({...counts,[status]:(counts[status]||0)+1}),{});
        const baseTiming={
          'opsmap-address-read':preparing-started, 'opsmap-address-index':matching-preparing,
          'opsmap-address-match':matched-matching,
          ...(lookupTimings?{'opsmap-address-customer':lookupTimings.customer||0, 'opsmap-address-official':lookupTimings.official||0}:{})
        };
        const eligibleForExternal=externalAddressMisses.has(data[0].status)||data[0].externalEligible===true;
        delete data[0].externalEligible;
        const canLookup=external&&externalAddressLookup&&immediate&&eligibleForExternal;
        if(external==='resolve'&&!canLookup&&eligibleForExternal)data[0].state='LOOKUP_BLOCKED';
        let externalResult;
        if(canLookup){
          const sessionKey=res.locals.staffSession?.key;
          const assertCurrent=()=>{
            if(res.destroyed||res.writableEnded)throw Object.assign(Error('STAGE_ADDRESS_CANCELLED'),{code:'STAGE_ADDRESS_CANCELLED',status:499});
            if(!isSessionCurrent(req,sessionKey))throw Object.assign(Error('GEOCODE_SESSION_EXPIRED'),{code:'GEOCODE_SESSION_EXPIRED',status:401});
            if(validation.active()!==prepared)throw Object.assign(Error('STAGE_BATCH_GENERATION_CHANGED'),{code:'STAGE_BATCH_GENERATION_CHANGED',status:409});
          };
          assertCurrent();
          if(external==='prepare'){
            let reads=0;
            const precheck=performance.now();
            const record=state=>{
              if(reads)console.info(JSON.stringify({component:'stage-geocode-precheck',reads,state,ms:Math.round(performance.now()-precheck)}));
            };
            void externalAddressLookup.prepareReservation(()=>reads++).then(()=>record('READY'),()=>record('UNAVAILABLE'));
          }else{
            externalResult=await externalAddressLookup.lookup(rows[0][0],{mode:'address',assertCurrent});
            data[0].external=externalResult.data;
            data[0].state=externalResult.data.exact===true&&externalResult.data.resolution?.kind==='EXACT'?'EXTERNAL_VERIFIED':
              externalResult.data.resolution?.kind==='ZERO_RESULT'?'SOURCE_NOT_COVERED':'CANDIDATE_REVIEW';
            addStaffTiming(res,'geocodeLedger',externalResult.ledgerReservationMs);
            for(const [phase,ms] of Object.entries(externalResult.serverTimings||{}))addStaffTiming(res,phase,ms);
            if(Number.isFinite(externalResult.providerDurationMs))baseTiming['opsmap-kakao-provider']=externalResult.providerDurationMs;
            const github=externalResult.githubRequests;
            if(github?.writes)res.set('X-Opsmap-Geocode-Github',github.reads+','+github.writes);
          }
        }
        const checking=performance.now();
        const respond=()=>{
          if(res.destroyed||res.writableEnded)return;
          if(!isSessionCurrent(req,res.locals.staffSession?.key))return res.status(401).json({error:'STAFF_LOGIN_REQUIRED'});
          if(validation.active()!==prepared)return res.status(409).json({error:validation.addressGenerationError(generation,validation.active())||'STAGE_BATCH_GENERATION_CHANGED'});
          if(immediate&&includeCustomers&&!externalResult)res.locals.stageInlineStaffResponse=true;
          res.set('Server-Timing',Object.entries({...baseTiming,'opsmap-address-recheck':performance.now()-checking})
            .map(([key,duration])=>key+';dur='+duration.toFixed(2)).join(', '));
          return res.json({ok:true,generation,data});
        };
        return immediate&&includeCustomers&&!externalResult?respond():requireStaff(req,res,respond);
      }catch(error){
        if(res.destroyed||res.writableEnded)return;
        const code=external&&/^[A-Z_]+$/.test(error.code||'')?error.code:'STAGE_BATCH_UNAVAILABLE';
        const status=[400,401,403,409,429,502,503].includes(error.status)?error.status:503;
        const state=blockedExternalErrors.has(code)||status===429||[401,403,429].includes(error.providerHttp)?'LOOKUP_BLOCKED':'LOOKUP_FAILED';
        if(external==='resolve'&&stateRows?.[0])stateRows[0].state=state;
        return res.status(status).json({error:code,state,
          ...(Number.isInteger(error.providerHttp)?{providerHttp:error.providerHttp}:{})});
      }
    }
    if(external!==undefined||!/^[a-f0-9]{64}$/.test(generation||'')||!Array.isArray(queries)||queries.length<1||queries.length>120||
      !queries.every(queryOk)) {
      return res.status(400).json({error:'STAGE_BATCH_QUERY_INVALID'});
    }
    const prepared=validation.active();
    if(!prepared||prepared.generation!==generation)return res.status(409).json({error:'STAGE_BATCH_GENERATION_CHANGED'});
    try{
      const saved=await readSnapshot();
      if(saved?.sourceGeneration!==generation||validation.active()!==prepared)return res.status(409).json({error:'STAGE_BATCH_GENERATION_CHANGED'});
      if(queries.some(query=>!/^[A-Z]\d{1,20}$/i.test(query)))await preparePreservedAddressIndex(saved);
      if(res.destroyed||res.writableEnded)return;
      if(validation.active()!==prepared)return res.status(409).json({error:'STAGE_BATCH_GENERATION_CHANGED'});
      const data=queries.map(query=>{
        const match=searchPreservedRegistry(query,saved);
        // The legacy query-list contract only returns preserved evidence.
        return {customer:{data:match.data.slice(0,12),meta:{truncated:match.meta.truncated||match.data.length>12}},
          official:match.data.length?null:prepared.bundledAddress?.lookup(query) ?? null};
      });
      return requireStaff(req,res,()=>isSessionCurrent(req,res.locals.staffSession?.key)
        ?res.json({ok:true,generation,data}):res.status(401).json({error:'STAFF_LOGIN_REQUIRED'}));
    }catch{return res.status(503).json({error:'STAGE_BATCH_UNAVAILABLE'});}
  });
  router.post(STAGE_BUNDLE_ROUTE, requireStaff, noStore, (req,res,next) => {
    if (origin!==STAGE_ORIGIN || req.get('Origin') !== origin || req.get('X-Opsmap-Stage-Verification') !== '1') return res.status(403).json({error:'STAGE_ORIGIN_REQUIRED'});
    next();
  }, express.raw({type:'application/octet-stream',limit:MAX_STAGE_BUNDLE_BYTES,inflate:false}), async (req,res) => {
    try {
      if (!isSessionCurrent(req,res.locals.staffSession?.key)) return res.sendStatus(401);
      const prepared = await validation.activate(req.body);
      return requireStaff(req,res,() => res.json(publicStatus(prepared)));
    } catch {
      return res.status(422).json({error:'STAGE_BUNDLE_REJECTED'});
    }
  });

}
