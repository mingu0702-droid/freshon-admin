import fs from 'node:fs/promises';
import path from 'node:path';
import {coordinateAddressHash} from './opsmap-abc/opsmapAutoCoordinates.js';
import {createFixedCoordinateResolver, hasFixedCoordinatePoint, validateFixedCoordinateLedger} from './fixedStoreCoordinates.js';
import {snapshotProjection, validateSnapshotProjection} from './productionSnapshotStore.js';
import {archiveAddressHash} from './stageArchivedDelivery.js';
import {boundedRead, isDay, privateCoverageDirectory} from './shadowCoverage/coverageFiles.js';
import {datesFor} from './shadowCoverage/coverageFiles.js';
import {atomicCoverageWrite} from './shadowCoverage/fileStore.js';
async function defaultCoverageBuilder(options) {
  const {buildShadowCoverage} = await import('../scripts/build-shadow-coverage.mjs');
  return buildShadowCoverage(options);
}
import {openOpsmapSyncGenerationStore, syncDigest, syncHash, syncSha256, SYNC_MAX_DAY_BYTES,
  validateOpsmapSyncDay} from './opsmapSyncGeneration.js';

import {completeSyncObservation,nextSyncEvidence,SYNC_CENTERS} from './opsmapSyncPolicy.js';
import {opsmapDispatchDate} from './snapshotRefreshEvidence.js';
import {collectOpsmapVehicleDelivery,MAX_VEHICLE_DELIVERY_BYTES,VEHICLE_DELIVERY_FILE} from './opsmapVehicleDeliveryEvidence.js';
import {continuingFixedLedger} from './fixedCoordinateCompletion.js';

const DAY = 86_400_000;
const kstDate = ms => new Date(ms + 9*3_600_000).toISOString().slice(0,10);
const dateBefore = date => new Date(Date.parse(date) - DAY).toISOString().slice(0,10);
const readJson = async (file, limit) => JSON.parse(await boundedRead(file,limit));
const isPrivateText = value => /[\u0000-\u001f]|비밀번호|보안키|공동현관|bearer\s|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/i.test(value);

function rebindCatalog(base, registry) {
  if (!registry) return base;
  if (registry.complete !== true || !syncHash(registry.version) || !Array.isArray(registry.rows) ||
      !registry.rows.length || registry.rows.length > 15_000) throw Error('OPSMAP_SYNC_REGISTRY');
  const rows = new Map(base.stores.map(row => [row.code,row]));
  const seen = new Set();
  for (const {customerCode:code, customerName:name, basicAddress:address, lifecycle} of registry.rows) {
    if (!/^[A-Z]\d{1,20}$/.test(code) || seen.has(code) || typeof address !== 'string' || address.length > 500 ||
        typeof name !== 'string' || name.length > 200 || isPrivateText(name+' '+address) ||
        !['ACTIVE','DELETED'].includes(lifecycle)) throw Error('OPSMAP_SYNC_REGISTRY_ROW');
    seen.add(code);
    const previous = rows.get(code);
    const previousAddressHash = coordinateAddressHash(previous?.address);
    if (lifecycle === 'DELETED') {
      if (previous?.registered && code !== 'S191541' && registry.deletionPolicy === 'EXPLICIT_ONLY' && registry.lifecycleField) {
        rows.set(code,{...previous,registered:false,registryTransition:{kind:'EXPLICIT_DELETION',
          previousAddressHash,version:registry.version}});
      }
      continue;
    }
    const binding = coordinateAddressHash(address);
    // An empty or malformed address from a partial update does not retire a proven pin.
    const validAddress = binding ? address : previous?.address || '';
    const same = previous && previousAddressHash === coordinateAddressHash(validAddress);
    if (code === 'S191541' && previous && !same) {
      rows.set(code,{...previous,name:name || previous.name,registered:true});
      continue;
    }
    const metadata = {...previous};
    if (previous && !same) {
      for (const key of ['originalAddressHash','currentAddressHash','coordinateAddressHash','addressHash',
        'latitude','longitude','hasCoordinate','coordinateStatus','coordinateAccuracy','coordinateEvidence',
        'addressChanged','resolutionStatus']) delete metadata[key];
      if (metadata.coordinateSource !== 'MANUAL_PIN') delete metadata.coordinateSource;
    }
    rows.set(code,{...metadata,code,name:name || previous?.name || code,address:validAddress,
      center:previous?.center || 'unknown',registered:true,lat:same?previous.lat:null,lng:same?previous.lng:null,
      ...(previous && !same?{reviewAddressChanged:true,registryTransition:{kind:'ADDRESS_CHANGED',
        previousAddressHash,version:registry.version}}:{}),
      matchHash:same?previous.matchHash:archiveAddressHash(validAddress)});
  }
  return {...base,stores:[...rows.values()]};
}

function preserveLedger(previous, next) {
  validateFixedCoordinateLedger(next);
  if (!previous) return;
  if (next.revision < previous.revision || next.revision === previous.revision && next.sha256 !== previous.sha256) {
    throw Error('OPSMAP_SYNC_LEDGER_REGRESSION');
  }
  for (const [code,history] of Object.entries(previous.records)) {
    if (JSON.stringify(next.records[code]?.slice(0,history.length)) !== JSON.stringify(history)) throw Error('OPSMAP_SYNC_LEDGER_HISTORY');
  }
}

function readAssignments(docs, saved) {
  const rows = new Map(saved?.rows.map(row => [row.customerCode,row]));
  const seen = new Map();
  for (const day of [...docs].sort((a,b) => a.date.localeCompare(b.date))) {
    for (const [,code,vehicle,center,hash,status] of day.tasks || []) {
      if (status === 'CANCELLED' || !hash) continue;
      const key = code+'|'+hash;
      if (seen.get(key)?.date !== day.date) seen.set(key,{date:day.date,center,vehicles:new Set(),completed:false});
      const found = seen.get(key);
      if (vehicle) found.vehicles.add(vehicle);
      found.completed ||= status === 'COMPLETED';
    }
  }
  return {rows,seen};
}

function snapshotRows(catalog, saved, docs) {
  const {rows,seen} = readAssignments(docs,saved);
  return catalog.stores.filter(row => row.registered).map(row => {
    const hash = coordinateAddressHash(row.address);
    const prior = rows.get(row.code);
    const same = hash && (prior?.originalAddressHash || prior?.addressHash) === hash;
    const match = seen.get(row.code+'|'+hash);
    const applied = match && (!same || match.date >= (prior.lastDeliveryDate || prior.deliveryDate || ''));
    const vehicle = applied && match.vehicles.size === 1 ? [...match.vehicles][0] : '';
    const point = hasFixedCoordinatePoint(row);
    return {...(same?prior:{}),customerCode:row.code,customerName:row.name,originalAddressHash:hash,
      centerGroup:applied && match.center !== 'unknown' ? match.center : row.center,
      lat:point?row.lat:null,lng:point?row.lng:null,coordinateStatus:point?'CONFIRMED':'MISSING',
      coordinateSource:point?(row.coordinateSource || 'VERIFIED_STORE_POINT'):'UNRESOLVED',
      coordinateAccuracy:row.coordinateAccuracy || 'UNVERIFIED',
      ...(row.reviewAddressChanged?{resolutionStatus:point?'COORDINATE_CONFIRMED':'ADDRESS_CHANGED_REVIEW_REQUIRED'}:{}),
      ...(applied?{vehicle,confirmedVehicle:vehicle,deliveryDate:match.date,
        lastDeliveryDate:match.completed?match.date:same?prior.lastDeliveryDate:undefined}:{} )};
  });
}

async function materializeDays({store, current, seed, changes, directory, targetDate, plannedDates}) {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const dates = {...current?.state.dates};
  const newDocs = new Map();
  if (!current) {
    const source = path.join(seed.directory,'observed-days');
    for (const name of (await fs.readdir(source)).sort()) {
      const date = name.slice(0,10);
      if (name !== date+'.json' || !isDay(date)) continue;
      const bytes = await boundedRead(path.join(source,name),SYNC_MAX_DAY_BYTES);
      const raw = JSON.parse(bytes);
      newDocs.set(date,validateOpsmapSyncDay({...raw,proofHash:raw.proofHash || syncSha256(bytes),completeCenters:raw.completeCenters || []},date));
    }
  }
  for (const [date,day] of changes) {
    if (!day) continue;
    const old = await store.readDay(date,current);
    // Omission and incomplete pages cannot erase previously observed deliveries.
    const ids = new Set((day.tasks || day.visits).map(row => row[0]));
    if (!old?.planningOnly && (old?.tasks || old?.visits || []).some(row => !ids.has(row[0]))) throw Error('OPSMAP_SYNC_DAY_REGRESSION');
    newDocs.set(date,day);
  }
  const latest=[...Object.keys(dates),...newDocs.keys()].filter(date=>date<=targetDate&&!plannedDates.has(date)).sort().at(-1);
  const floor=latest&&datesFor(latest,90)[0];
  for (const [date,hash] of Object.entries(dates)) {
    if (newDocs.has(date)) continue;
    if (!syncHash(hash)) throw Error('OPSMAP_SYNC_DAY_DIGEST');
    const target=path.join(directory,date+'.json');
    try {await fs.link(path.join(current.input,'observed-days',date+'.json'),target);}
    catch(error) {
      if(error.code!=='ENOENT') throw error;
      if(date>=floor) await atomicCoverageWrite(target,JSON.stringify(await store.readDay(date,current)));
    }
  }
  for (const [date,day] of newDocs) {
    const bytes = JSON.stringify(day);
    if (Buffer.byteLength(bytes) > SYNC_MAX_DAY_BYTES) throw Error('OPSMAP_SYNC_DAY_LIMIT');
    dates[date] = syncSha256(bytes);
    await atomicCoverageWrite(path.join(directory,date+'.json'),bytes);
  }
  return dates;
}

async function copyCoverageCache(source, output) {
  if (!source) return;
  await fs.mkdir(path.join(output,'days'),{recursive:true,mode:0o700});
  for (const name of await fs.readdir(path.join(source,'days')).catch(error=>{if(error.code==='ENOENT')return [];throw error;})) {
    if (isDay(name.slice(0,10)) && name === name.slice(0,10)+'.json') {
      await fs.copyFile(path.join(source,'days',name),path.join(output,'days',name));
    }
  }
  for (const name of await fs.readdir(source)) {
    if (/^admin-names-[a-f0-9]{64}\.json$/.test(name)) await fs.copyFile(path.join(source,name),path.join(output,name));
  }
}

export async function createOpsmapDataSync({directory, seed, readLedger, readRegistry, readDay, readMissingDay,
  readManualPins = async () => [], now = Date.now, appRoot = process.cwd(), includeOfficialRegions = true, buildCoverage = defaultCoverageBuilder,
  completeCoordinates,requiredSourceIds=[]} = {}) {
  const store = await openOpsmapSyncGenerationStore(directory,{appRoot,writable:true,readMissingDay});
  const statusFile = path.join(store.root,'sync-status.json');
  let flight;

  async function loadSeed() {
    if (!seed) throw Error('OPSMAP_SYNC_SEED_REQUIRED');
    const root = await privateCoverageDirectory(seed.directory,appRoot);
    const base = await boundedRead(path.join(root,'stores.private.json'),3*1024*1024);
    const source = await boundedRead(path.join(root,'source-import.safe.json'),32_768);
    if (syncSha256(base) !== seed.catalogSha256 || syncSha256(source) !== seed.sourceSha256) throw Error('OPSMAP_SYNC_SEED_DIGEST');
    const facts = JSON.parse(source);
    if (facts.sourceWrites !== 0 || !facts.sources?.current?.stable || !facts.sources?.archive?.stable ||
        !isDay(facts.end) || !Number.isFinite(Date.parse(facts.observedAt))) throw Error('OPSMAP_SYNC_SEED_EVIDENCE');
    return {directory:root,base:JSON.parse(base),facts,snapshot:seed.snapshot && validateSnapshotProjection(seed.snapshot)};
  }

  async function run({bootstrap = false, backfillDates = [], scheduledRun, durableActive} = {}) {
    const expected = await store.latestRevision();
    const current = await store.read();
    if (bootstrap && current) return {state:'NOOP',generation:current.index.sha256,revision:current.state.revision};
    if (scheduledRun && (!syncHash(scheduledRun.runId)||!isDay(scheduledRun.date)||!completeCoordinates)) throw Error('OPSMAP_SCHEDULE_SOURCE_CONFIG');
    if (scheduledRun?.runId && current?.state.runId===scheduledRun.runId && current.state.sourceReadComplete===true &&
        requiredSourceIds.every(id=>current.vehicleDelivery?.completeSources?.[id]?.includes(scheduledRun.date))) {
      return {state:'PUBLISHED',generation:current.index.sha256,revision:current.state.revision,observedToday:true,
        sourceReadComplete:true,observationHash:current.state.observationHash};
    }
    if (!bootstrap && (!readRegistry || !readDay)) throw Error('OPSMAP_SYNC_SOURCES_NOT_CONFIGURED');
    const initial = current ? null : await loadSeed();
    const target = scheduledRun?.date || kstDate(now());
    if (!Array.isArray(backfillDates) || backfillDates.length > 2 || backfillDates.some(date => !isDay(date) || date > target)) {
      throw Error('OPSMAP_SYNC_BACKFILL');
    }
    const yesterday=dateBefore(target);
    const plannedDates=new Set(current?.state.plannedDates || []);
    const catchupAfter=scheduledRun?(current?.state.catchupAfter || current?.state.asOf || initial?.facts.end):null;
    const catchup=isDay(catchupAfter)?datesFor(target,90).filter(date=>date>catchupAfter && date<yesterday &&
      (!current?.state.dates[date]||plannedDates.has(date))).slice(0,2):[];
    const datesToRead = bootstrap ? [] : [...new Set([yesterday,target,...catchup,...backfillDates])];
    const [registry, suppliedLedger] = await Promise.all([bootstrap?null:readRegistry(),readLedger()]);
    let ledger=completeCoordinates ? continuingFixedLedger(current?.ledger,suppliedLedger) : suppliedLedger;
    const manual = await readManualPins();
    preserveLedger(current?.ledger,ledger);
    const changes = new Map();
    for (const date of datesToRead) {
      const day = await readDay(date);
      if (scheduledRun && requiredSourceIds.length && !completeSyncObservation(day,SYNC_CENTERS,requiredSourceIds)) {
        throw Object.assign(Error('OPSMAP_SCHEDULE_SOURCE_INCOMPLETE'),{date});
      }
      if (day) changes.set(date,validateOpsmapSyncDay(day,date));
    }
    const todayEvidence=changes.get(target);
    const sourceReadComplete=completeSyncObservation(todayEvidence,SYNC_CENTERS,requiredSourceIds);
    if (scheduledRun && !sourceReadComplete) throw Object.assign(Error('OPSMAP_SCHEDULE_SOURCE_INCOMPLETE'),{date:target});
    if (scheduledRun) {
      const planned=opsmapDispatchDate(Date.parse(scheduledRun.issuedAt));
      if(planned>target) {
        const plan=await readDay(planned);
        if (!completeSyncObservation(plan,SYNC_CENTERS,requiredSourceIds) || plan.visits.length) {
          throw Object.assign(Error('OPSMAP_SCHEDULE_PLAN_INCOMPLETE'),{date:planned});
        }
        if (plan.sourceRows) changes.set(planned,validateOpsmapSyncDay({...plan,planningOnly:true},planned));
      }
    }
    for (const [date,day] of changes) {
      if (day.planningOnly) plannedDates.add(date);
      else plannedDates.delete(date);
    }
    const observationHash=scheduledRun?syncDigest([scheduledRun.runId,registry.version,[...changes].map(([date,day])=>[date,day.proofHash])]):null;
    const base = rebindCatalog(current?.baseCatalog || initial.base,registry);
    let completedStores=base.stores;
    if (completeCoordinates) {
      const result=await completeCoordinates({stores:base.stores,ledger,manualRows:manual,now});
      preserveLedger(ledger,result.ledger);ledger=result.ledger;completedStores=result.stores;
    }
    const catalog = {...base,stores:createFixedCoordinateResolver(ledger,{manualRows:manual}).join(completedStores)};
    const registryVersion = registry?.version || current?.state.registryVersion || initial?.facts.stores.registryVersion || null;
    const sameDays = [...changes].every(([date,doc]) => current?.state.dates[date] === syncDigest(doc));
    const fingerprint = syncDigest([registryVersion,base,ledger.sha256,manual]);
    if (current?.vehicleDelivery && current.state.fingerprint === fingerprint && sameDays && current.state.revision === expected &&
        (!scheduledRun || durableActive?.generation===current.index.sha256 && durableActive.revision===current.state.revision)) {
      return {state:'NOOP',generation:current.index.sha256,revision:current.state.revision,
        observedToday:changes.has(target),sourceReadComplete,observationHash};
    }
    const candidate = await store.candidate(expected);
    let published = false;
    try {
      const input = path.join(candidate.folder,'input');
      const coverage = path.join(candidate.folder,'coverage');
      const observed = path.join(input,'observed-days');
      const dates = await materializeDays({store,current,seed:initial,changes,directory:observed,targetDate:target,plannedDates});
      const asOf = Object.keys(dates).filter(date=>date<=target&&!plannedDates.has(date)).sort().at(-1);
      if (!isDay(asOf) || asOf > target) throw Error('OPSMAP_SYNC_DATE_FRONTIER');
      const source = current ? await readJson(path.join(current.input,'source-import.safe.json'),32_768) : initial.facts;
      const window = datesFor(asOf,90);
      const locations = new Map(catalog.stores.filter(row => row.registered && hasFixedCoordinatePoint(row))
        .map(row => [row.code,row.matchHash]));
      const vehicleDelivery=collectOpsmapVehicleDelivery(asOf,locations);
      const nearby = new Map();
      let count = 0, completed = 0;
      for (const date of window) {
        if (!dates[date] || plannedDates.has(date)) continue;
        const bytes = await boundedRead(path.join(observed,date+'.json'),SYNC_MAX_DAY_BYTES);
        if (syncSha256(bytes) !== dates[date]) throw Error('OPSMAP_SYNC_DAY_DIGEST');
        const day = JSON.parse(bytes);
        vehicleDelivery.add(day);
        count++;
        completed += day.visits.length;
        for (const [,code,vehicle,,addressHash] of day.visits) {
          if (!addressHash || locations.get(code) !== addressHash) continue;
          const entry = nearby.get(code) || {date:null,vehicles:new Set(),days:0};
          if (entry.date !== date) { entry.date = date; entry.vehicles.clear(); }
          if (/^(?:[용척]?\d{1,4})(?:-\d{1,3})?$/.test(vehicle)) entry.vehicles.add(vehicle);
          entry.days |= 1 << new Date(date).getUTCDay();
          nearby.set(code,entry);
        }
      }
      if (!current && (source.days !== count || source.completedUnique !== completed) && !changes.size) throw Error('OPSMAP_SYNC_SEED_COUNTS');
      const committedAt = new Date(now()).toISOString();
      const nextSource = {...source,start:window[0],end:asOf,days:count,completedUnique:completed,
        observedAt:changes.size && !sameDays?committedAt:source.observedAt,stores:{...source.stores,union:catalog.stores.length,
          registered:catalog.stores.filter(row => row.registered).length,located:catalog.stores.filter(hasFixedCoordinatePoint).length,registryVersion},
        ...(!bootstrap?{syncRead:{target,registryVersion,observedDates:[...changes.keys()].sort()}}:{})};
      const previousSnapshot = current?.sealedSnapshot || initial?.snapshot;
      const sealedSnapshot = snapshotProjection({version:'phase2b-map-snapshot-v1',latestDate:asOf,startDate:source.start,
        rows:snapshotRows(catalog,previousSnapshot,[...changes.values()].filter(day=>!day.planningOnly)),sourceFreshness:{targetDate:target,
          sourceReadComplete,sourceDateVerified:Boolean(todayEvidence),
          phase:bootstrap?'VERIFIED_SEED':'VERIFIED_SCHEDULED_READ'}},
      {now,revision:candidate.revision});
      const baseBytes = JSON.stringify(base), catalogBytes = JSON.stringify(catalog), ledgerBytes = JSON.stringify(ledger);
      const snapshotBytes = JSON.stringify(sealedSnapshot);
      await Promise.all([
        atomicCoverageWrite(path.join(input,'base.private.json'),baseBytes),atomicCoverageWrite(path.join(input,'stores.private.json'),catalogBytes),
        atomicCoverageWrite(path.join(input,'source-import.safe.json'),JSON.stringify(nextSource)),
        atomicCoverageWrite(path.join(candidate.folder,'fixed-store-coordinates-v1.json'),ledgerBytes),
        atomicCoverageWrite(path.join(candidate.folder,'snapshot.json'),snapshotBytes),copyCoverageCache(current?.coverage,coverage)
      ]);
      const built = await buildCoverage({inputDirectory:input,outputDirectory:coverage,includeOfficialRegions});
      const indexBytes = await boundedRead(path.join(coverage,'coverage-index.json'),16_384);
      const window90 = await readJson(path.join(coverage,built.index.windows[90].sha256+'.json'),3*1024*1024);
      const nearbyBytes = JSON.stringify({source:'STAGE_ARCHIVE_ADDRESS_BOUND',generation:built.index.sha256,
        start:window90.start,end:window90.end,observedDates:window90.observedDates.all,
        rows:[...nearby].map(([code,{date,vehicles,days}]) => [code,date,vehicles.size===1?[...vehicles][0]:'',days])});
      await atomicCoverageWrite(path.join(candidate.folder,'nearby.json'),nearbyBytes);
      const vehicleDeliveryBytes=JSON.stringify(vehicleDelivery.finish(built.index.sha256,window90.observedDates));
      if(Buffer.byteLength(vehicleDeliveryBytes)>MAX_VEHICLE_DELIVERY_BYTES)throw Error('OPSMAP_VEHICLE_DELIVERY_LIMIT');
      await atomicCoverageWrite(path.join(candidate.folder,VEHICLE_DELIVERY_FILE),vehicleDeliveryBytes);
      const ready = await store.publish(candidate,{fingerprint,asOf,committedAt,registryVersion,dates,generation:built.index.sha256,
        snapshotSha256:syncSha256(snapshotBytes),ledgerSha256:syncSha256(ledgerBytes),baseSha256:syncSha256(baseBytes),
        catalogSha256:syncSha256(catalogBytes),indexSha256:syncSha256(indexBytes),nearbySha256:syncSha256(nearbyBytes),
        vehicleDeliverySha256:syncSha256(vehicleDeliveryBytes),
        ...(plannedDates.size?{plannedDates:[...plannedDates].sort()}:{}),
        ...(scheduledRun?{runId:scheduledRun.runId,observationHash,sourceReadComplete,catchupAfter}:{} )});
      published = true;
      return {state:bootstrap?'SEEDED':'PUBLISHED',generation:ready.index.sha256,revision:ready.state.revision,
        observedToday:changes.has(target),sourceReadComplete,observationHash,metrics:built.metrics};
    } finally {
      if (!published) await store.discard(candidate).catch(() => {});
    }
  }

  function sync(options) {
    if (flight) return flight;
    flight = (async () => {
      const last = await readJson(statusFile,32_768).catch(() => null);
      const attemptedAt = new Date(now()).toISOString();
      try {
        const result = await run(options);
        const evidence=nextSyncEvidence(last,result,attemptedAt,new Date(now()).toISOString());
        await atomicCoverageWrite(statusFile,JSON.stringify(evidence));
        return {...result,lastSuccessAt:evidence.lastSuccessAt};
      } catch (error) {
        const code = /^[A-Z][A-Z_0-9]{1,95}$/.test(error.code || error.message) ? error.code || error.message : 'OPSMAP_SYNC_FAILED';
        await atomicCoverageWrite(statusFile,JSON.stringify({state:'FAILED',attemptedAt,error:code,
          lastSuccessAt:last?.lastSuccessAt || null,lastObservedAt:last?.lastObservedAt || null,
          observedToday:false,sourceReadComplete:false,generation:last?.generation || null})).catch(() => {});
        throw error;
      }
    })().finally(() => {flight = null;});
    return flight;
  }
  return {sync,read:store.read,readDay:store.readDay,status:() => readJson(statusFile,32_768).catch(() => null)};
}

export function startOpsmapDataSync(worker,{intervalMs = 15*60_000, retryMs = 60_000, onResult = () => {}} = {}) {
  if (!Number.isFinite(intervalMs) || !Number.isFinite(retryMs) || intervalMs < 1 || retryMs < 1) throw Error('OPSMAP_SYNC_SCHEDULE');
  let stopped = false, timer, failures = 0;
  async function tick() {
    let delay = intervalMs;
    try { onResult(await worker.sync()); failures = 0; }
    catch { delay = Math.min(intervalMs,retryMs * 2**Math.min(failures++,6)); }
    if (!stopped) timer = setTimeout(tick,delay);
  }
  timer = setTimeout(tick,0);
  return () => {stopped = true;clearTimeout(timer);};
}
