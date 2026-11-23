import express from 'express';
import compression from 'compression';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {mountProductionMapApi} from './opsmap-abc/productionMapIntegration.js';
import {callHub as hubRead} from './opsmap-abc/phase2bHubReadClient.js';
import {createFixedVehicleCache} from './opsmap-abc/fixedVehicleCache.js';
import {createFixedVehicleFileStore} from './opsmap-abc/fixedVehicleStore.js';
import {canonicalFixedMasterVehicle} from './fixedMasterVehicle.js';
import {createManualMapPins} from './opsmap-abc/manualMapPins.js';
import {createRoadRouteService,isRoadRouteRequest} from './opsmap-abc/roadRouteService.js';
import {createStageRoadBudget,createStageSharedRoadTrial} from './opsmap-abc/productionRoadBudget.js';
import {createRecordedRoadRouteReader} from './opsmap-abc/recordedRoadRoute.js';
import {staffStoreDetail} from './opsmap-abc/mapStaffDetail.js';
import {createPrivateGithubJsonStore} from './fixedVehicleStore.js';
import {createManualPinGithubStore,createStageGeocodeBudgetStore} from './manualPinGithubStore.js';
import {createStageStaffSessionStore} from './staffSessionStore.js';
import {createProductionSnapshotStore,materializeSnapshot} from './productionSnapshotStore.js';
import {STAGE_ORIGIN,STAGE_SERVICE,STAGE_BUNDLE_ROUTE,STAGE_ADDRESS_BATCH_ROUTE,createStageAbValidation,mountStageAbValidation} from './stageAbValidation.js';
import {phase2bSnapshotMeta} from './phase2bOperations.js';
import {mountPrivateCustomerSearch} from './privateCustomerSearch.js';
import {createStageStaffRegistryAsset,mountStageStaffRegistry} from './stageStaffRegistryAsset.js';
import {createStageNationalRegistryReader,createStageNationalRegistryStorage,stageNationalRegistryScope} from './stageNationalRegistry.js';
import {createRecentOperationsReader,createStageRecentOperationsSeed,createStageRecentOperationsStore,
  mountRecentOperations} from './stageRecentOperations.js';
import {recentOperationsBaseline} from './stageRecentOperationsManifest.js';
import {createStageStoreDetails} from './stageStoreDetails.js';
import {redactPublicData} from './publicDataSecurity.js';
import {createStageOperationalPhotoExtension} from './opsmapStagePhotos.js';
import {mountShadowCoverage} from './shadowCoverage/routes.js';
import {createStagePostalAssets} from './shadowCoverage/stagePostalAssets.js';
import {stageCurrentPostalRegistrationReader} from './shadowCoverage/postalCurrentRegistrationAsset.js';
import {createCoverageStatusReader} from './shadowCoverage/storeStatus.js';
import {createStageDatedDeliveryReader} from './stageDatedDelivery.js';
import {createOpsmapDispatchReferenceReader,mountOpsmapDispatchReference} from './opsmapDispatchReference.js';
import {createStageWmsDispatchExportReader} from './opsmapWmsDispatchExport.js';
import {createStageDriverContacts} from './stageDriverContacts.js';
import {archivedDatedDispatch,DATED_DELIVERY_CONTRACT,vehicleId} from './datedDeliveryContract.js';
import {createKakaoCoordinateConnection} from './opsmap-abc/kakaoCoordinateConnection.js';
import {createOfficialAddressLookup,createTemporaryOfficialAddressLookup,readStageOfficialAddressSupplement,readStageOfficialAddressReview} from './opsmapOfficialAddressLookup.js';
import {createStageGenerationRestore} from './stageGenerationRestore.js';
import {openOpsmapSyncGenerationStore} from './opsmapSyncGeneration.js';
import {checkStageVerifiedBaseline,createOpsmapDurableGeneration,stageOpsmapDurableStorage,stageVerifiedBaselineConfig} from './opsmapDurableGeneration.js';
import {mountOpsmapScheduledRun,opsmapScheduleConfig} from './opsmapScheduledRun.js';
import {createStageDailyFixedMasterReader, FIXED_MASTER_DAILY_TTL, isFixedMasterDay,
  stageFixedMasterScope, stageFixedMasterStorage, stageFixedMasterSyncEnabled} from './stageFixedMasterSync.js';
import {STAGE_OSAN_SYNC_SOURCE_IDS,SYNC_DELIVERY_SOURCES} from './opsmapSyncPolicy.js';
import {addressRegionParts} from '../public/opsmap/vehicle-picker-regions.js';
import {opsmapDispatchDate} from './snapshotRefreshEvidence.js';

const stageOrigin = STAGE_ORIGIN;
const stageService = STAGE_SERVICE;
const repo = 'mingu0702-droid/freshon-cache';
const github = `https://api.github.com/repos/${repo}`;
const pinsBranch = 'stage/opsmap-manual-pins';
const snapshotBranch = 'stage/opsmap-snapshots';
const publicDir = fileURLToPath(new URL('../public/opsmap/', import.meta.url));
const excelBrowserScript = createRequire(import.meta.url).resolve('xlsx/dist/xlsx.full.min.js');
const readActions = new Set([
  'mapModelStatus', 'mapBounds', 'mapCoordinateSupplement', 'datedAssignments', 'periodAssignments', 'routePlan', 'routeStops',
  'customerDetailsStatus', 'customerDetail', 'staffCustomerDetail', 'customerDetailPrepared', 'staffDriverHistory',
  'customerSearch', 'unifiedSearch', 'customerRegistry'
]);
const officialAddressIndexRoute = '/api/map-phase2b/private/stage-official-address-index';
const addressDiagnosticRoute = '/api/map-phase2b/private/address-lookup-diagnostic';
const readPosts = new Set(['/api/map-phase2b/preview/base-vehicles', '/api/map-phase2b/private/address-lookup', STAGE_BUNDLE_ROUTE, STAGE_ADDRESS_BATCH_ROUTE, officialAddressIndexRoute]);
const deliveryReadActions = new Set(['routePlan','routeStops','datedAssignments','periodAssignments']);
const authPosts = new Set(['/api/map-phase2b/auth/login', '/api/map-phase2b/auth/logout']);
const normalizeCell = value => typeof value === 'string' ? value.trim() : '';
const normalizeDateValue = value => {
  const day = normalizeCell(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0,10) === day ? day : '';
};

export function stageSnapshotBaseVehicles(snapshot) {
  const rows = new Map();
  let version, checkedAt;
  for (const row of snapshot?.rows || []) {
    if (row.baseVehicleSource !== 'FIXED_DISPATCH_PRIMARY' || !/^[a-f0-9]{64}$/.test(row.baseVehicleVersion || '') ||
      !Number.isFinite(Date.parse(row.baseVehicleCheckedAt))) continue;
    version ??= row.baseVehicleVersion;
    checkedAt ??= row.baseVehicleCheckedAt;
    if (version !== row.baseVehicleVersion || checkedAt !== row.baseVehicleCheckedAt) return null;
    rows.set(row.customerCode,{customerCode:row.customerCode,baseVehicle:canonicalFixedMasterVehicle(row.baseVehicle),baseVehicleGroup:row.baseVehicleGroup || '',
      ...(row.baseVehicleState==='UNASSIGNED'&&row.baseVehicleEmptyVerified===true?{baseVehicleEmptyVerified:true}:{}),
      baseVehicleState:row.baseVehicleState,baseVehicleSource:row.baseVehicleSource,baseVehicleVersion:version,baseVehicleCheckedAt:checkedAt,baseVehicleStale:true});
  }
  if (!rows.size) return null;
  const meta={basis:'FIXED_DISPATCH_PRIMARY',source:'STAGE_SNAPSHOT',version,checkedAt,total:rows.size,stale:true,refresh:'READ_ONLY',cacheState:'PRESENT'};
  return {get(codes) {
    const data=codes.map(customerCode=>rows.get(customerCode) || {customerCode,baseVehicle:'',baseVehicleGroup:'',baseVehicleState:'UNKNOWN',
      baseVehicleSource:meta.basis,baseVehicleVersion:version,baseVehicleCheckedAt:checkedAt,baseVehicleStale:true});
    return {ok:true,data,meta};
  }};
}

function stageHubUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.origin === 'https://script.google.com' && !url.username && !url.password && !url.search && !url.hash &&
      /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname);
  } catch {return false;}
}

function stageGithub(fetchImpl, {files, branch, writable, allowBlob = false, directory = 'opsmap-stage'}) {
  return (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    const endpoint = `${url.origin}${url.pathname}`;
    const file = files.find(name => endpoint === `${github}/contents/${directory}/${name}`);
    const query = url.searchParams;
    const read = method === 'GET' && (file && query.size === 1 && query.get('ref') === branch || !url.search &&
      (endpoint === github || allowBlob && endpoint.startsWith(`${github}/git/blobs/`) && /^[a-f0-9]{40}$/.test(endpoint.split('/').at(-1))));
    const write = method === 'PUT' && file && file === writable && !url.search && JSON.parse(options.body).branch === branch;
    if ((!read && !write) || url.username || url.password || url.hash) throw new Error('STAGE_STORE_SCOPE_REJECTED');
    return fetchImpl(input, {...options, redirect:'error'});
  };
}

export function createStageSyncReaders({env,fetchImpl=fetch,now=Date.now}) {
  return {
    nationalRegistry:createStageNationalRegistryStorage({env,fetchImpl,now}),
    recentOperations:createStageRecentOperationsStore({env,fetchImpl,now}),
    fixedMaster:()=>stageFixedMasterStorage({env,fetchImpl})
  };
}

export function createStageVerificationApp({env = process.env, fetchImpl = fetch, readHub = hubRead, readShadowDirectory, syncReaders,
  readWmsExport = createStageWmsDispatchExportReader({env,fetchImpl}),
  openScheduledStore = openOpsmapSyncGenerationStore, readVerifiedVehicleRegistration, now = Date.now, snapshotWaitMs = 2500} = {}) {
  const today=()=>new Date(now()+9*3600000).toISOString().slice(0,10);
  if (env.RENDER_EXTERNAL_URL !== stageOrigin || (env.RENDER_SERVICE_ID && env.RENDER_SERVICE_ID !== stageService)) throw new Error('EXACT_STAGE_ORIGIN_REQUIRED');
  if (![env.HUB_API_URL,env.OPSMAP_PRIVATE_READER_URL].every(stageHubUrl)) throw new Error('STAGE_READ_SOURCE_CONFIG');
  const stageAddressApproved = env.RENDER_SERVICE_ID === stageService && env.OPSMAP_STAGE_KAKAO_ADDRESS_APPROVED === '1' &&
    /^(?:[1-9][0-9]?|100)$/.test(env.OPSMAP_KAKAO_GEOCODING_DAILY_LIMIT || '') && !!env.GITHUB_TOKEN;
  const exactStageService = env.RENDER_SERVICE_ID === stageService;
  const stageRoadApproved = exactStageService && env.OPSMAP_STAGE_ROAD_ROUTE_APPROVED === '1';
  const stageRoadRequested = env.OPSMAP_STAGE_ROAD_ROUTE_ENABLED === '1';
  const sharedRoadTrial = exactStageService && env.OPSMAP_STAGE_ROAD_SHARED_TRIAL !== undefined;
  const stageRoadKey = exactStageService ? String(env.OPSMAP_STAGE_KAKAO_MOBILITY_REST_API_KEY || (sharedRoadTrial ? env.KAKAO_REST_API_KEY : '') || '').trim() : '';
  const stageRoadBudgetToken = exactStageService ? String(env.OPSMAP_STAGE_ROAD_BUDGET_STORE_TOKEN || (sharedRoadTrial ? env.GITHUB_TOKEN : '') || '').trim() : '';
  const roadSettings = {
    serviceVerified:exactStageService,
    approvalConfigured:Boolean(env.OPSMAP_STAGE_ROAD_ROUTE_APPROVED),
    approvalValueValid:['0','1'].includes(env.OPSMAP_STAGE_ROAD_ROUTE_APPROVED),
    approved:stageRoadApproved,
    switchConfigured:Boolean(env.OPSMAP_STAGE_ROAD_ROUTE_ENABLED),
    switchValueValid:['0','1'].includes(env.OPSMAP_STAGE_ROAD_ROUTE_ENABLED),
    requested:stageRoadRequested,
    ignoredSharedSwitch:['1','true'].includes(env.OPSMAP_ROAD_ROUTE_ENABLED) || env.OPSMAP_PRODUCTION_ROAD_ROUTE_ENABLED === '1',
    budgetTokenConfigured:Boolean(stageRoadBudgetToken),
    deployment:/^[a-f0-9]{40}$/i.test(env.RENDER_GIT_COMMIT || '') ? env.RENDER_GIT_COMMIT : null
  };
  const roadBudgetFile = 'road-budget-v1.json';
  const roadRouteBudget = !stageRoadApproved ? null : sharedRoadTrial ? createStageSharedRoadTrial({
    key:stageRoadKey,token:stageRoadBudgetToken,grant:env.OPSMAP_STAGE_ROAD_SHARED_TRIAL,now,
    fetchImpl:stageGithub(fetchImpl,{directory:'opsmap-production',files:[roadBudgetFile],branch:'production/opsmap-auth',writable:roadBudgetFile})
  }) : createStageRoadBudget({
    key:stageRoadKey,token:stageRoadBudgetToken,now,
    fetchImpl:stageGithub(fetchImpl,{files:[roadBudgetFile],branch:pinsBranch,writable:roadBudgetFile})
  });
  const roadEnabled = stageRoadApproved && stageRoadRequested;
  const driverContacts = createStageDriverContacts({env,fetchImpl,now});
  const stage = {...env, OPSMAP_STAGE_VERIFY_ONLY:'1', MAP_STAFF_ORIGIN:stageOrigin, OPSMAP_MANUAL_PIN_WRITES:'0',
    OPSMAP_MANUAL_PIN_STORE_FILE:undefined, OPSMAP_MANUAL_PIN_SEARCH_CACHE_FILE:undefined, OPSMAP_PRIVATE_DETAIL_CACHE_ENABLED:'0',
    OPSMAP_DRIVER_CONTACT_ENABLED:driverContacts.configured?'1':'0',
    OPSMAP_KAKAO_GEOCODING_ENABLED:stageAddressApproved ? env.OPSMAP_KAKAO_GEOCODING_ENABLED : '0',
    OPSMAP_KAKAO_DIAGNOSTIC_ENABLED:stageAddressApproved ? env.OPSMAP_KAKAO_DIAGNOSTIC_ENABLED : '0',
    OPSMAP_KAKAO_KEYWORD_FREE_QUOTA_VERIFIED:stageAddressApproved && env.OPSMAP_STAGE_KAKAO_PLACE_APPROVED === '1'
      ? env.OPSMAP_KAKAO_KEYWORD_FREE_QUOTA_VERIFIED : '0', OPSMAP_ROAD_ROUTE_ENABLED:roadEnabled?'1':'0'};
  const roadService = createRoadRouteService({
    env:{OPSMAP_ROAD_ROUTE_ENABLED:stage.OPSMAP_ROAD_ROUTE_ENABLED,KAKAO_MOBILITY_REST_API_KEY:stageRoadKey,
      OPSMAP_ROAD_ROUTE_CACHE_MS:stage.OPSMAP_ROAD_ROUTE_CACHE_MS,OPSMAP_ROAD_ROUTE_TIMEOUT_MS:stage.OPSMAP_ROAD_ROUTE_TIMEOUT_MS},
    fetchImpl,now,budget:roadRouteBudget,requireDurableBudget:true
  });
  const roadRouteService = {
    ...roadService,
    ...(sharedRoadTrial?{
      authorizeRequest({recorded,manual,body}){
        if(recorded||!manual)throw Object.assign(Error('CALL_POLICY_UNCONFIRMED'),{code:'CALL_POLICY_UNCONFIRMED',status:403});
        if(body?.waypoints?.length!==2)throw Object.assign(Error('INVALID_MANUAL_ROUTE'),{code:'INVALID_MANUAL_ROUTE',status:400});
      },
      async route(body){
        const result=await roadService.route(body);
        return {...result,data:{...result.data,manualOnly:true}};
      }
    }:{}),
    async readiness(){
      return {...await roadService.readiness(),stage:roadSettings};
    }
  };
  const postalEnabled = stage.OPSMAP_SHADOW_COVERAGE_FORMAT==='postal';
  const remotePostal = postalEnabled ? createStagePostalAssets({env:stage,fetchImpl,now}) : null;
  const staffRegistry = createStageStaffRegistryAsset({env:stage,fetchImpl,now});
  const syncStorage = syncReaders ?? createStageSyncReaders({env:stage,fetchImpl,now});
  const nationalRegistry = createStageNationalRegistryReader({store:syncStorage.nationalRegistry,now,
    log:result=>console.info(JSON.stringify({component:'stage-national-registry-readback',...result}))});
  const readCurrentPostalRegistration = postalEnabled && nationalRegistry ? stageCurrentPostalRegistrationReader({env:stage,fetchImpl,
    approvedRelease:{ref:'a0b2746a9b7c7d85e728bf4f303bf02b5631a947',
      sha256:'03195e7bae0dffe989204d7a248c5c42ffdcde13887dca7a196d227c882cea50'},
    readRegistry:()=>nationalRegistry.read(),
    readRegistryVersion:async()=> (await syncStorage.nationalRegistry.readHead()).value?.current?.version}) : null;
  const readRecentOperations = createRecentOperationsReader({now,
    readSeed:createStageRecentOperationsSeed({env:stage,fetchImpl,manifest:recentOperationsBaseline,
      log:value=>console.info(JSON.stringify({component:'stage-recent-operations-baseline',...value}))}),
    store:syncStorage.recentOperations});
  const validation = createStageAbValidation({now,retainCoverageFiles:!postalEnabled});
  const generationRestore=createStageGenerationRestore({env:stage,validation,now});
  let baselineConfig, baselineStore, baselineRefresh, baselineRestoreMs, baselineState='NOT_CONFIGURED';
  if(stage.RENDER_SERVICE_ID===STAGE_SERVICE){
    try {
      baselineConfig=stageVerifiedBaselineConfig(stage);
      if(baselineConfig)baselineState='PENDING';
    } catch { baselineState='UNAVAILABLE'; }
  }
  function refreshBaseline(){
    if(!baselineConfig||['VERIFIED','SUPERSEDED'].includes(baselineState))return;
    baselineRefresh??=(async()=>{
      const started=performance.now();
      let timing;
      baselineStore ||= createOpsmapDurableGeneration({
        ...stageOpsmapDurableStorage({env:stage,fetchImpl,baselineKey:baselineConfig.baselineKey}),now,readOnlyView:true,retainCoverageFiles:!postalEnabled,
        onRestoreTiming:value=>{timing=value;}
      });
      const candidate=checkStageVerifiedBaseline(await baselineStore.readBaseline(baselineConfig.ref));
      baselineState=validation.followScheduled(candidate,baselineStore.readDay,{baseline:true})?'VERIFIED':'SUPERSEDED';
      baselineRestoreMs=Math.round(performance.now()-started);
      console.info(JSON.stringify({component:'opsmap-stage-baseline',...timing,restoreMs:baselineRestoreMs,
        processUptimeMs:Math.round(process.uptime()*1000),maxRssMiB:Math.round(process.resourceUsage().maxRSS/1024)}));
    })().catch(async()=>{baselineState='UNAVAILABLE';await baselineStore?.dispose().catch(()=>{});baselineStore=null;})
      .finally(()=>{baselineRefresh=null;});
    return baselineRefresh;
  }
  const scheduledEnabled = stage.RENDER_SERVICE_ID===stageService && stage.OPSMAP_STAGE_SYNC_READ_APPROVED==='1';
  const remoteEnabled=scheduledEnabled && stage.OPSMAP_STAGE_SYNC_REMOTE_APPROVED==='1';
  let scheduledStore, scheduledRefresh, scheduledSuccessAt = null;
  let scheduledRun=null,scheduledFailure=null,scheduledError=null,scheduledSources={};
  let scheduledState = scheduledEnabled?'PENDING':'NOT_CONFIGURED';
  async function refreshScheduled() {
    if (!scheduledEnabled) return;
    scheduledRefresh ??= (async()=>{
      scheduledStore ||= remoteEnabled
        ? createOpsmapDurableGeneration({...stageOpsmapDurableStorage({env:stage,fetchImpl}),now,readOnlyView:true,retainCoverageFiles:!postalEnabled})
        : await openScheduledStore(stage.OPSMAP_STAGE_SYNC_DIR,{writable:false});
      const result=remoteEnabled?await scheduledStore.readWithStatus():
        {generation:await scheduledStore.read(),status:await scheduledStore.readStatus()};
      const {generation:candidate,status}=result;
      scheduledError=result.error||null;
      if(remoteEnabled&&status) {
        scheduledRun=status.run||null;
        scheduledFailure=status.lastFailure||null;
        scheduledSources=status.sources||{};
      }
      if (!candidate) throw Error('OPSMAP_SYNC_NOT_PUBLISHED');
      if (!validation.followScheduled(candidate,scheduledStore.readDay)) {
        scheduledState='LAST_VERIFIED_RETAINED';
        return;
      }
      const current=status?.generation===candidate.index.sha256&&(!remoteEnabled||status.revision===candidate.state.revision);
      if (current && Number.isFinite(Date.parse(status.lastSuccessAt))) scheduledSuccessAt=status.lastSuccessAt;
      scheduledState=remoteEnabled&&!current?'LAST_VERIFIED_RETAINED':'VERIFIED_SCHEDULED_PROJECTION';
    })().catch(error=>{
      const code=error.code||error.message;
      scheduledError=/^[A-Z][A-Z_0-9]{1,95}$/.test(code||'')?code:'OPSMAP_SYNC_STATUS_UNAVAILABLE';
      scheduledState=validation.active()?.scheduled?'LAST_VERIFIED_RETAINED':'UNAVAILABLE';
    })
      .finally(()=>{scheduledRefresh=null;});
    return scheduledRefresh;
  }
  const officialIndex = createTemporaryOfficialAddressLookup({sha256:stage.OPSMAP_STAGE_OFFICIAL_ADDRESS_INDEX_SHA256});
  const supplementalOfficialIndex=readStageOfficialAddressSupplement(stage,{onReject:()=>
    console.warn(JSON.stringify({component:'stage-official-address-supplement',state:'REJECTED'}))});
  const supplementalOfficialReview=readStageOfficialAddressReview(stage,{onReject:()=>
    console.warn(JSON.stringify({component:'stage-official-address-review',state:'REJECTED'}))});
  let preservedOfficialIndex = null, coverageOfficialIndex = null;
  if(stage.RENDER_SERVICE_ID===STAGE_SERVICE) {
    try {
      preservedOfficialIndex=createOfficialAddressLookup(readFileSync('/etc/secrets/opsmap-stage-official-address-index-v2.json'),{
        // The two stored matches are bound to the approved A ledger and original 58-row addresses.
        sha256:'85c1ea71bd58cbdea3ede8940a23a6d6779d7f4bee1c412836959e3d4b17951d',allowMixed:true,allowStored:true
      });
    } catch(error) {
      if(error.code!=='ENOENT') console.warn(JSON.stringify({component:'stage-official-address-index',state:'REJECTED'}));
    }
    try {
      coverageOfficialIndex=createOfficialAddressLookup(readFileSync('/etc/secrets/opsmap-stage-coverage-address-index-v2.json'),{
        sha256:'9613e87049231f3afecfd9c2e763f30ae1bba4321bc2437566b3f2dd17c0eba9',allowMixed:true
      });
    } catch(error) {
      if(error.code!=='ENOENT') console.warn(JSON.stringify({component:'stage-coverage-address-index',state:'REJECTED'}));
    }
  }
  const readOfficialIndex=()=>{
    const temporary=officialIndex.active();
    if(!temporary&&!preservedOfficialIndex&&!coverageOfficialIndex&&!supplementalOfficialIndex&&!supplementalOfficialReview)return null;
    return {lookup:query=>temporary?.lookup(query)??preservedOfficialIndex?.lookup(query)??
      coverageOfficialIndex?.lookup(query)??supplementalOfficialIndex?.lookup(query)??supplementalOfficialReview?.lookup(query)??null};
  };
  const geocodeBudgetFile = 'geocode-budget-v1.json';
  const geocodeBudget = stageAddressApproved ? createStageGeocodeBudgetStore({repo,token:stage.GITHUB_TOKEN,branch:pinsBranch,
    fetchImpl:stageGithub(fetchImpl,{files:[geocodeBudgetFile],branch:pinsBranch,writable:geocodeBudgetFile})}) : null;
  const addressLookupService = createKakaoCoordinateConnection({env:stage,fetchImpl,store:geocodeBudget,
    stageAddressApproved,independentAddressLookup:()=>{
      const bundled=validation.active()?.bundledAddress,index=readOfficialIndex();
      return (bundled||index)?{lookup(query){
        const existing=bundled?.lookup(query);
        if(existing&&existing.kind!=='MANUAL')return existing;
        const point=index?.lookup(query);
        return point&&(!point.coordinateKind||point.coordinateKind==='BUILDING')?point:existing??null;
      }}:null;
    }});
  let fallbackCoverageDirectory;
  let coverageState = readShadowDirectory || stage.OPSMAP_SHADOW_DATA_DIR ? 'ready' : 'unavailable';
  const coverageFor = active => active?.scheduled?.prepareCoverage?.() ?? active?.directory;
  function coverageDirectory() {
    const active = validation.active();
    if (active) return coverageFor(active);
    fallbackCoverageDirectory ??= Promise.resolve()
      .then(() => readShadowDirectory ? readShadowDirectory() : stage.OPSMAP_SHADOW_DATA_DIR)
      .catch(() => null).then(directory => {
        coverageState = directory ? 'ready' : 'unavailable';
        return directory;
      });
    return fallbackCoverageDirectory.then(directory => coverageFor(validation.active()) ?? directory);
  }
  const sessions = createStageStaffSessionStore({env:stage,fetchImpl:stageGithub(fetchImpl,{files:['staff-sessions-v1.json'],branch:pinsBranch,writable:'staff-sessions-v1.json'})});
  const snapshotFetch = stageGithub(fetchImpl,{files:['map-snapshot-v1.json','map-date-checkpoint-v1.json','fixed-vehicle-projection-v1.json'],branch:snapshotBranch,allowBlob:true});
  const snapshotStore = createProductionSnapshotStore({env:stage,token:stage.OPSMAP_SNAPSHOT_STORE_TOKEN || stage.GITHUB_TOKEN,fetchImpl:snapshotFetch});
  const masterStore = createPrivateGithubJsonStore({env:{GITHUB_CACHE_REPO:repo,GITHUB_TOKEN:stage.OPSMAP_SNAPSHOT_STORE_TOKEN || stage.GITHUB_TOKEN,GITHUB_CACHE_BRANCH:snapshotBranch,GITHUB_CACHE_DIR:'opsmap-stage'},fetchImpl:snapshotFetch});
  let snapshot = null, snapshotPending = null, snapshotBase = null, joinedSnapshot = null;
  let fileRestorePending = null;
  let nextSnapshotCheck = 0;
  let snapshotReadState=snapshotStore?(baselineConfig?'DEFERRED':'PENDING'):'NOT_CONFIGURED', snapshotVerifiedAt=null;
  async function readBaseSnapshot() {
    if (now() < nextSnapshotCheck) return snapshot;
    snapshotPending ??= Promise.resolve().then(()=>snapshotStore?.load()).then(value => {
      nextSnapshotCheck = now() + 60_000;
      if (!value) {
        snapshotReadState=snapshot?'LAST_VERIFIED_RETAINED':snapshotStore?'NOT_AVAILABLE':'NOT_CONFIGURED';
        return snapshot;
      }
      const previous = snapshot?.preservation;
      if (previous && (value.revision < previous.revision || value.revision === previous.revision &&
          value.sha256 !== previous.version || value.latestDate < snapshot.latestDate)) {
        throw Error('STAGE_SNAPSHOT_SOURCE_REGRESSION');
      }
      if (value.sha256 !== previous?.version) {
        snapshot = materializeSnapshot(value);
        snapshotBase = stageSnapshotBaseVehicles(snapshot);
      }
      snapshotReadState='VERIFIED_STORED_PROJECTION';
      snapshotVerifiedAt=new Date(now()).toISOString();
      const loaded = snapshot;
      // A checkpoint can arrive separately for an unchanged projection.
      void snapshotStore.loadSelectedDateCheckpoint(value).then(checkpoint => {
        if (checkpoint && snapshot === loaded && loaded.selectedDateCheckpoint?.checkedAt !== checkpoint.checkedAt) {
          snapshot = {...loaded, selectedDateCheckpoint:checkpoint};
        }
      }).catch(() => {});
      return loaded;
    }).catch(error => {
      nextSnapshotCheck = now() + 60_000;
      snapshotReadState=snapshot?'LAST_VERIFIED_RETAINED':'UNAVAILABLE';
      if (!snapshot) throw error;
      return snapshot;
    }).finally(() => {snapshotPending = null;});
    return snapshotPending;
  }
  function selectSnapshot(saved) {
    const bundle = validation.active();
    if (bundle?.scheduled) return bundle.scheduled.snapshot;
    if (!bundle) {joinedSnapshot = null; return saved;}
    if (joinedSnapshot?.bundle !== bundle || joinedSnapshot.base !== saved) {
      joinedSnapshot = {bundle, base:saved, snapshot:validation.snapshot(saved)};
    }
    return joinedSnapshot.snapshot;
  }
  function snapshotRecovery() {
    if (!baselineConfig&&snapshotPending || scheduledRefresh || fileRestorePending || baselineRefresh) return 'RESTORING';
    const fileState=generationRestore.status().state;
    if ([snapshotReadState,scheduledState,fileState].includes('LAST_VERIFIED_RETAINED')) return 'LAST_VERIFIED_RETAINED';
    if ([snapshotReadState,scheduledState,fileState,baselineState].some(state=>['UNAVAILABLE','NOT_AVAILABLE'].includes(state))) return 'UNAVAILABLE';
    return snapshot || validation.active() ? 'READY' : 'UNAVAILABLE';
  }
  async function readSnapshot() {
    // A configured Stage baseline must be verified before serving its map.
    // The legacy snapshot is still available to routes that explicitly need it.
    const ready=()=>!baselineConfig||validation.active()?selectSnapshot(snapshot):null;
    const current=ready();
    if (current && validation.active()) return current;
    const reads = [scheduledRefresh,fileRestorePending,baselineRefresh].filter(Boolean);
    if(!baselineConfig)reads.unshift(readBaseSnapshot().catch(()=>null));
    if(!reads.length)return current;
    let timer;
    // An existing copy may be served as soon as either source validates it. Bound a cold HTTP read.
    try {
      const deadline = new Promise(resolve=>{timer=setTimeout(resolve,snapshotWaitMs);});
      if (current) {
        await Promise.race([reads[0],deadline]);
        return ready() || current;
      }
      await Promise.race([
        Promise.any(reads.map(read=>Promise.resolve(read).then(()=>{
          if (!ready()) throw Error('STAGE_SNAPSHOT_NOT_AVAILABLE');
        }))).catch(()=>{}),
        deadline
      ]);
      return ready();
    } finally {clearTimeout(timer);}
  }
  const callHub = async (action, params, options) => {
    if (!readActions.has(action)) throw new Error('STAGE_HUB_WRITE_REJECTED');
    const payload = await readHub(action, params, action==='datedAssignments' ? {...options,
      useCache:false,privateRead:true,maxResponseBytes:1536*1024,deadline:Math.min(options?.deadline??Infinity,Date.now()+12_000)} : options);
    return deliveryReadActions.has(action) ? validation.joinPayload(payload) : payload;
  };
  const readRecordedRoadRoute = createRecordedRoadRouteReader({callHub,async readVehicleCenter({vehicle}) {
    const saved = await readSnapshot();
    if(saved&&!snapshotBase)await readBaseSnapshot().catch(()=>null);
    if (!saved || !snapshotBase) return null;
    const groups = new Set(saved.rows.filter(row=>row.baseVehicle===vehicle && row.baseVehicleState==='VERIFIED_MASTER' &&
      row.baseVehicleSource==='FIXED_DISPATCH_PRIMARY' && /^[a-f0-9]{64}$/.test(row.baseVehicleVersion || '')).map(row=>row.baseVehicleGroup));
    return groups.size===1 ? [...groups][0] : null;
  }});
  const photos = createStageOperationalPhotoExtension({env:stage,fetchImpl,defaultDate:today});
  const fixedBaseline = stage.OPSMAP_STAGE_FIXED_MASTER_FILE ? createFixedVehicleFileStore({env:stage}) : {
    async load() {return (await masterStore.read('fixed-vehicle-projection-v1.json')).value;}
  };
  const dailyMaster=stageFixedMasterSyncEnabled(stage);
  let dailyFixedStorage;
  const fixedStore=dailyMaster ? createStageDailyFixedMasterReader({baseline:fixedBaseline,store:{
    read(...args) {return (dailyFixedStorage ??= syncStorage.fixedMaster()).read(...args);}
  }}) : fixedBaseline;
  const fixed = createFixedVehicleCache({readOnly:true,reloadReadOnlyAfterMs:dailyMaster?300_000:60_000,
    ...(dailyMaster?{ttl:FIXED_MASTER_DAILY_TTL}:{}),now,store:fixedStore});
  let fixedMasterEvidence=null, lastSyncDiagnostic=null;
  const base={async get(codes) {
    const primary=await fixed.get(codes), meta=primary.meta;
    fixedMasterEvidence={
      state:primary.phase||'READY',checkedAt:meta?.checkedAt||null,stale:meta?.stale!==false,
      sourceObservedAt:meta?.sourceObservedAt||null,sourceObservationDate:meta?.sourceObservationDate||null,
      scheduledState:meta?.scheduledState||(dailyMaster?'NOT_OBSERVED':'NOT_CONFIGURED'),
      scheduledLastSuccessAt:meta?.scheduledLastSuccessAt||null,lastError:meta?.lastError||null
    };
    if (primary.ok) return primary;
    try {await readBaseSnapshot();} catch {return primary;}
    const fallback=snapshotBase?.get(codes);
    return fallback?{...fallback,meta:{...fallback.meta,primaryCacheState:primary.meta?.cacheState,lastError:primary.meta?.lastError}}:primary;
  }};
  const pinStore = stage.OPSMAP_MANUAL_PIN_STORE_KIND === 'github' || stage.OPSMAP_ROAD_BUDGET_STORE_KIND === 'github-stage' ? createManualPinGithubStore({
    repo, token:stage.GITHUB_TOKEN, branch:pinsBranch,
    fetchImpl:stageGithub(fetchImpl,{files:['manual-pins-v1.json'],branch:pinsBranch})
  }) : null;
  const manual = createManualMapPins({env:stage,store:pinStore && {transaction:work=>pinStore.transaction(state=>work(state))},
    authorizeWrite:()=>false,readCustomer:async code=>{
      const row=(await readSnapshot())?.rows.find(item=>item.customerCode===code);
      if (row?.address) return row;
      const response=await callHub('customerDetail',{customerCode:code},{useCache:false,privateRead:true,maxResponseBytes:65536});
      return staffStoreDetail(response?.data,{customerCode:code,date:null});
    }});
  const app = express(), router = express.Router();
  async function readScheduleRegistry() {
    if (validation.active()) return validation.active();
    const pending=refreshBaseline() || fileRestorePending || scheduledRefresh;
    if (!pending) return validation.active();
    let timer;
    try {
      await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(resolve,15_000);})]);
    } finally {clearTimeout(timer);}
    return validation.active();
  }
  mountOpsmapScheduledRun(app,{env:stage,now,readFixedScope:async()=>{
    if (!staffRegistry) return null;
    const [active,additional]=await Promise.all([readScheduleRegistry(),staffRegistry.read()]);
    return stageFixedMasterScope(active,additional,await nationalRegistry?.read());
  },readNationalScope:async()=>{
    return stageNationalRegistryScope(await readScheduleRegistry());
  }});
  // Start after listen and reuse the same in-flight, read-only load as user queries.
  if(stage.RENDER_SERVICE_ID===stageService) app.once('opsmap-stage-listening',()=>{
    void remotePostal?.verifyReference();
    let registryAuditPending, registryAudited=false;
    function auditRegionalCoordinates() {
      const current=validation.active();
      if (!staffRegistry || registryAudited || registryAuditPending || !(current?.registry instanceof Map)) return;
      registryAuditPending=staffRegistry.read().then(({snapshot,meta})=>{
        if(validation.active()!==current || snapshot.rows.some(row=>current.registry.has(row.customerCode))) return;
        if(!meta.officialLocations)return;
        const {yeongnam,honam}=meta.officialLocations;
        console.info(JSON.stringify({component:'stage-national-coordinate-audit',registered:current.registry.size+snapshot.rows.length,
          existingCoordinates:current.counts.located,regionalLocations:{yeongnam,honam},located:current.counts.located+yeongnam+honam}));
        registryAudited=true;
      }).catch(()=>{}).finally(()=>{registryAuditPending=null;});
    }
    const refresh=()=>{
      if(snapshotStore&&!baselineConfig)void readBaseSnapshot().catch(()=>{});
      if(generationRestore.status().state!=='NOT_CONFIGURED') {
        fileRestorePending ??= generationRestore.refresh().finally(()=>{fileRestorePending=null;});
      }
      void Promise.resolve(refreshBaseline()).then(auditRegionalCoordinates);
      void refreshScheduled();
      auditRegionalCoordinates();
    };
    refresh();
    setInterval(refresh,60_000).unref();
  });
  const datedSourceIds=new Set(['1',...String(stage.OPSMAP_STAGE_DELIVERY_DATED_VERIFIED_SOURCE_IDS||'').split(',').map(id=>id.trim())]);
  const readDatedDelivery = createStageDatedDeliveryReader({env:stage,fetchImpl,now,
    syncCenters:Object.fromEntries(Object.entries(SYNC_DELIVERY_SOURCES).filter(([,id])=>datedSourceIds.has(id)))});
  const dispatchDate=readDatedDelivery.configured?()=>opsmapDispatchDate(now()):undefined;
  app.disable('x-powered-by');
  app.get('/api/health',(_req,res)=>res.json({ok:true,scope:'stage',release:/^[a-f0-9]{40}$/.test(stage.RENDER_GIT_COMMIT || '') ? stage.RENDER_GIT_COMMIT : null}));
  app.get(['/','/index.html','/map-phase2b-preview.html'],(_req,res)=>res.redirect(302,'/opsmap/'));
  app.use('/opsmap',router);
  app.use((req,res,next)=>req.path.startsWith('/api/') ? router(req,res,next) : next());
  router.use(compression());
  router.use((req,res,next)=>{
    let route;
    try {route=decodeURIComponent(req.path).toLowerCase().replace(/\/$/,'');} catch {return res.status(400).end();}
    if (/^\/(?:internal|api\/collector|api\/map-phase2b\/admin)(?:\/|$)/.test(route)) return res.status(404).end();
    if (req.method==='GET' || req.method==='HEAD' || req.method==='POST' && (authPosts.has(route) || readPosts.has(route) ||
        route===addressDiagnosticRoute&&stageAddressApproved || isRoadRouteRequest(req))) return next();
    return res.status(403).json({error:'STAGE_READ_ONLY'});
  });
  let staffView;
  const readStageStoreDetail = createStageStoreDetails({now,publication:()=>{
    const active=validation.active();
    if (!active) return null;
    return {generation:active.generation,asOf:active.asOf,snapshot:selectSnapshot(snapshot)};
  }});
  mountProductionMapApi(router,{
    previewEnabled:()=>true,requireView:(req,res,next)=>staffView(req,res,next),readPhase2bSnapshot:readSnapshot,
    getSnapshotMemory:()=>validation.active() ? validation.active().scheduled?.snapshot || joinedSnapshot?.snapshot || snapshot : snapshot,
    phase2bKstDate:today,phase2bDispatchDate:dispatchDate,normalizeCell,normalizeDateValue,phase2bSnapshotMeta,phase2bTodayStatus:readDatedDelivery,
    callHub,readStageStoreDetail,secret:'',authOptions:{env:stage,sessionStore:sessions,cookieName:'__Host-map-staff'},
    sharedBaseCache:base,hybridEnabled:()=>false,roadRouteService,readRecordedRoadRoute,addressLookupService,
    getShadowCoverageState:()=>validation.active() || !postalEnabled && coverageState==='ready' ? 'ready' :
      baselineRefresh || scheduledRefresh || fileRestorePending ? 'restoring' : 'unavailable',
    getLocalDataEvidence:()=>validation.active()?.evidence || null,
    readArchivedAssignments:validation.archivedAssignments,
    mountPrivateExtensions:binding=>{
      const {requireStaff,requireStageRead,isSessionCurrent}=binding;
      staffView = requireStaff;
      mountStageStaffRegistry({app:router,requireStaff,asset:staffRegistry,nationalRegistry,
        getVerifiedRegistry:()=>validation.active()?.registry,now});
      if (stage.RENDER_SERVICE_ID === STAGE_SERVICE) {
        mountRecentOperations(router,{requireStaff,read:readRecentOperations,now});
        driverContacts.mount(binding,{readBaseVehicles:codes=>base.get(codes),
          readDatedAssignment:readDatedDelivery.readDriverAssignment,readVerifiedVehicleRegistration});
        mountStageAbValidation(router,{...binding,validation,readSnapshot,readReadySnapshot:()=>selectSnapshot(snapshot),readOfficialIndex,
          readAddressMaster:()=>nationalRegistry?.read(),
          readBaseVehicles:codes=>base.get(codes),externalAddressLookup:stageAddressApproved?addressLookupService:null});
        if (dailyMaster) router.get('/api/map-phase2b/private/fixed-master-observation',requireStaff,async(req,res)=>{
          const {date,customerCodes}=req.query;
          const codes=typeof customerCodes==='string'&&customerCodes.length<=8000 ? customerCodes.split(',') : [];
          if (!isFixedMasterDay(date) || date>today() || !codes.length || codes.length>500 ||
              codes.some(code=>!/^[A-Z]\d{1,20}$/.test(code)) ||
              Object.keys(req.query).some(key=>key!=='date'&&key!=='customerCodes')) {
            return res.status(400).json({error:'FIXED_MASTER_OBSERVATION_QUERY'});
          }
          try {
            const observation=await fixedStore.readObservation(date,codes);
            return requireStaff(req,res,()=>observation ? res.json(observation) :
              res.status(404).json({error:'FIXED_MASTER_OBSERVATION_UNCONFIRMED',date,data:null}));
          } catch {
            return requireStaff(req,res,()=>res.status(503).json({error:'FIXED_MASTER_OBSERVATION_UNAVAILABLE',date,data:null}));
          }
        });
        router.get('/api/map-phase2b/private/stage-sync-evidence',requireStaff,(_req,res)=>{
          const generation=validation.active();
          const applied=generation?.scheduled?.snapshot||joinedSnapshot?.snapshot||(!generation?snapshot:null);
          const windowDays=generation?.scheduled?.vehicleDelivery?.observedDates.all?.length ?? generation?.nearby?.observedDays;
          const sourceRunId=generation?.scheduled?.state.runId || null;
          const persisted=generation?.scheduled?.state;
          const {secret,scheduleId,executorHash}=opsmapScheduleConfig(stage);
          const requiredSourceIds=STAGE_OSAN_SYNC_SOURCE_IDS;
          const confirmedSourceIds=requiredSourceIds.filter(id=>
            generation?.scheduled?.vehicleDelivery?.completeSources[id]?.includes(scheduledRun?.date));
          const automaticSyncVerified=remoteEnabled && scheduledState==='VERIFIED_SCHEDULED_PROJECTION' && !!sourceRunId &&
            persisted?.osanDeliveryThrough===scheduledRun?.date &&
            ['PUBLISHED','VERIFIED_NOOP'].includes(scheduledRun?.state) && scheduledRun.sourceReadComplete===true &&
            confirmedSourceIds.length===requiredSourceIds.length &&
            scheduledRun.generation===generation.generation &&
            scheduledRun.date===today() && Number.isFinite(Date.parse(scheduledSuccessAt));
          const evidence={
            automaticSyncVerified,
            liveDeliveryByCenter:readDatedDelivery.sourceStatus(),
            sources:Object.fromEntries(['customerRegistry',...Object.values(SYNC_DELIVERY_SOURCES).map(id=>'delivery:'+id)].map(id=>[
              id,scheduledSources[id]||{lastSuccessAt:null,error:null}
            ])),
            fixedMaster:fixedMasterEvidence,
            snapshot:{state:snapshotReadState,verifiedAt:snapshotVerifiedAt,generatedAt:snapshot?.generatedAt||null,latestDate:snapshot?.latestDate||null,
              revision:snapshot?.preservation?.revision||null,selectedDateStorageVerified:snapshot?.selectedDateCheckpoint?.selectedDateStorageVerified===true},
            serving:{latestDate:applied?.latestDate||null,generatedAt:applied?.generatedAt||null,generation:applied?.sourceGeneration||null,
              osanDeliveryThrough:applied?.osanDeliveryThrough||null,
              rowCount:applied?.rows?.length??null},
            coverage:{state:generation?'VERIFIED_STAGE_GENERATION':coverageState,generation:generation?.generation||null,
              asOf:generation?.asOf||null,scope:generation?.evidence.coordinateScope||null,restore:generationRestore.status(),baselineState,
              publishedAt:generation?.evidence.coverageGeneratedAt||null,unknownDays:Number.isInteger(windowDays)?90-windowDays:null,
              registered:generation?.counts.registered??null,located:generation?.counts.located??null},
            scheduled:{state:scheduledState,error:scheduledError,previousVerifiedRetained:scheduledState==='LAST_VERIFIED_RETAINED',
              revision:generation?.scheduled?.state.revision||null,requiredSourceIds,confirmedSourceIds,
              config:{readerApproved:scheduledEnabled,remoteApproved:remoteEnabled,writerApproved:stage.OPSMAP_STAGE_SYNC_PUBLISH_APPROVED==='1',
                schedulerApproved:stage.OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED==='1',deliveryConfigured:readDatedDelivery.configured,
                deliveryEventApproved:stage.OPSMAP_STAGE_DELIVERY_EVENT_READ_APPROVED==='1',sourceReadsApproved:stage.OPSMAP_SYNC_SOURCE_READ_APPROVED==='1',
                triggerIdConfigured:/^\d{1,30}$/.test(scheduleId||''),executorConfigured:/^[a-f0-9]{64}$/.test(executorHash||''),
                hmacConfigured:typeof secret==='string'&&secret.length>=32&&secret.length<=512,
                archiveKeyConfigured:/^[A-Za-z0-9+/]{43}=$/.test(stage.OPSMAP_STAGE_SYNC_ARCHIVE_KEY_B64||''),
                jobSettingsPathConfigured:path.isAbsolute(stage.OPSMAP_STAGE_SYNC_JOB_SETTINGS_FILE||''),
                storageReaderCredentialPresent:!!(stage.OPSMAP_STAGE_SYNC_READ_TOKEN||stage.OPSMAP_SNAPSHOT_STORE_TOKEN||stage.OPSMAP_SHADOW_GITHUB_READ_TOKEN),
                storageWriterCredentialPresent:!!(stage.OPSMAP_STAGE_SYNC_WRITE_TOKEN||
                  stage.OPSMAP_STAGE_SYNC_USE_SNAPSHOT_WRITER==='1'&&stage.OPSMAP_SNAPSHOT_STORE_TOKEN)},
              release:sourceRunId?{sourceRunId,generation:persisted.generation,ledgerSha256:persisted.ledgerSha256,
                snapshotSha256:persisted.snapshotSha256,coverageIndexSha256:persisted.indexSha256,observationHash:persisted.observationHash}:null,
              publishedAt:generation?.scheduled?.state.committedAt||null,lastSuccessAt:scheduledSuccessAt,sourceRunId,
              nextRun:{state:scheduledRun?.triggerId?'TRIGGER_OBSERVED_NEXT_TIME_UNVERIFIED':'TRIGGER_UNVERIFIED',at:null},
              run:scheduledRun?{runId:scheduledRun.runId,triggerId:scheduledRun.triggerId,executorHash:scheduledRun.principal,
                state:scheduledRun.state,date:scheduledRun.date,startedAt:scheduledRun.startedAt,completedAt:scheduledRun.completedAt||null,
                sourceReadComplete:scheduledRun.sourceReadComplete===true}:null,
              lastFailure:scheduledFailure?{runId:scheduledFailure.runId,at:scheduledFailure.completedAt,code:scheduledFailure.error,
                date:scheduledFailure.failedDate,center:scheduledFailure.failedCenter,sourceId:scheduledFailure.failedSourceId||null}:null}
          };
          const diagnostic=JSON.stringify({component:'stage-map-sync',snapshotState:evidence.snapshot.state,
            storedThrough:evidence.snapshot.latestDate,servingThrough:evidence.serving.latestDate,generation:evidence.serving.generation,
            coverageThrough:evidence.coverage.asOf,unconfirmedDays:evidence.coverage.unknownDays,fixedMaster:evidence.fixedMaster,
            scheduledState:evidence.scheduled.state,lastSuccessAt:evidence.scheduled.lastSuccessAt,
            lastError:evidence.scheduled.lastFailure?.code||evidence.scheduled.error,
            deliveryByCenter:Object.fromEntries(Object.entries(evidence.liveDeliveryByCenter).map(([center,result])=>[
              center,{date:result.checkedDate,lastSuccessDate:result.lastSuccessDate,complete:result.complete,error:result.error}
            ]))});
          if(diagnostic!==lastSyncDiagnostic){lastSyncDiagnostic=diagnostic;console.info(diagnostic);}
          return res.set('Cache-Control','private, no-store').vary('Cookie').json(evidence);
        });
        router.get('/api/map-phase2b/private/dated-delivery',requireStaff,async(req,res)=>{
          const privateResponse=()=>res.set('Cache-Control','private, no-store').vary('Cookie');
          privateResponse();
          const {date,center='osan',vehicle:queryVehicle}=req.query;
          const vehicle=queryVehicle===undefined?null:vehicleId(queryVehicle);
          if (typeof date!=='string'||normalizeDateValue(date)!==date||date>(dispatchDate?.()||today())||
              typeof center!=='string'||!Object.hasOwn(SYNC_DELIVERY_SOURCES,center)||
              queryVehicle!==undefined&&(typeof queryVehicle!=='string'||!vehicle)||
              Object.keys(req.query).some(key=>!['date','center','vehicle'].includes(key))) {
            return res.status(400).json({error:'DELIVERY_QUERY_INVALID'});
          }
          const active=validation.active();
          const sourceId=SYNC_DELIVERY_SOURCES[center];
          const source=scheduledSources['delivery:'+sourceId];
          const scopedSuccessAt=source?.lastSuccessDate===date?source.lastSuccessAt:null;
          const retained=async error=>{
            const archive=await active?.readNearbyDay?.(date).catch(()=>null);
            return archivedDatedDispatch(archive,{center,vehicle,generation:active?.generation,
              sourceRunId:active?.scheduled?.state.runId,publishedAt:active?.scheduled?.state.committedAt,lastSuccessAt:scopedSuccessAt,error});
          };
          try {
            const data=await readDatedDelivery.readContract(date,center,vehicle);
            const archive=await retained('DELIVERY_SOURCE_REGRESSION');
            return requireStaff(req,res,()=>privateResponse().json(archive?.source.uniqueDeliveries>data.source.uniqueDeliveries?archive:data));
          } catch (failure) {
            const error=/^DELIVERY_SOURCE_[A-Z_]+$/.test(failure.code||'')?failure.code:'DELIVERY_SOURCE_READ_UNAVAILABLE';
            const saved=await retained(error);
            return requireStaff(req,res,()=>{
              console.info(JSON.stringify({component:'stage-dated-delivery',status:saved?200:503,code:error,
                date,center,sourceId,vehicleFiltered:vehicle!==null,retained:Boolean(saved)}));
              return saved?privateResponse().json(saved):privateResponse().status(503).json({contract:DATED_DELIVERY_CONTRACT,
                date,center,sourceId,vehicle,generation:null,sourceGeneration:null,sourceRunId:null,state:'SOURCE_UNAVAILABLE',error,
                source:{kind:'DELIVERY_ADMIN_READ',observedAt:null},sourceComplete:false,currentReadComplete:false,scopeComplete:false,confirmedEmpty:false,
                previousVerifiedRetained:false,lastSuccessAt:scopedSuccessAt,rows:null,activeCount:null,chronology:null,chronologyTies:null});
            });
          }
        });
        router.post(officialAddressIndexRoute,requireStaff,(req,res,next)=>{
          res.set('Cache-Control','private, no-store').vary('Cookie');
          if (req.get('Origin') !== stageOrigin || req.get('X-Opsmap-Stage-Verification') !== '1') return res.status(403).json({error:'STAGE_ORIGIN_REQUIRED'});
          if (!req.is('application/json')) return res.status(415).json({error:'OFFICIAL_ADDRESS_INDEX_MEDIA_TYPE'});
          return next();
        },express.raw({type:'application/json',limit:'512kb',inflate:false}),(req,res)=>{
          if (!isSessionCurrent(req,res.locals.staffSession?.key)) return res.status(401).json({error:'AUTH_REQUIRED'});
          if (!/^[a-f0-9]{64}$/.test(stage.OPSMAP_STAGE_OFFICIAL_ADDRESS_INDEX_SHA256 || '')) return res.status(503).json({error:'OFFICIAL_ADDRESS_INDEX_DISABLED'});
          try {return res.json({ok:true,...officialIndex.activate(req.body)});}
          catch {return res.status(400).json({error:'OFFICIAL_ADDRESS_INDEX_REJECTED'});}
        });
      }
      const coverageAppRoot=fileURLToPath(new URL('../',import.meta.url));
      let pendingStoreStatus;
      const statusApproved=stage.RENDER_SERVICE_ID===STAGE_SERVICE && stage.OPSMAP_STAGE_STORE_STATUS_APPROVED==='1';
      const readCoverageStatus = createCoverageStatusReader({
        readFixed:codes=>base.get(codes),
        readEvidence:statusApproved ? generation=>{
          const active=validation.active();
          if (!active?.registry || active.generation!==generation) return null;
          if (pendingStoreStatus?.generation!==generation) {
            const request={generation};
            request.promise=import('./shadowCoverage/freshonStoreStatus.js').then(({readFreshonStoreStatusFile})=>
              readFreshonStoreStatusFile({file:stage.OPSMAP_STAGE_STORE_STATUS_FILE,expectedSha256:stage.OPSMAP_STAGE_STORE_STATUS_SHA256,
                appRoot:coverageAppRoot,generation,registry:active.registry,
                // The scheduled release retains the verified registry. Keep the approved
                // status file at its original date and recheck every address binding.
                verifiedBaselineGeneration:active.scheduled?.state.osanDeliveryThrough?baselineConfig?.ref.generation:undefined})).catch(error=>{
              if (pendingStoreStatus===request) pendingStoreStatus=undefined;
              throw error;
            });
            pendingStoreStatus=request;
          }
          return pendingStoreStatus.promise;
        } : undefined,
        readSnapshot:generation=>{
          const active=validation.active();
          return active?.generation===generation ? active.scheduled?.snapshot : null;
        }, now
      });
      let providerReader;
      const providerApproved=stage.RENDER_SERVICE_ID===STAGE_SERVICE&&stage.OPSMAP_STAGE_PROVIDER_COVERAGE_APPROVED==='1';
      const readProviderCoverage=providerApproved?async()=>{
        providerReader??=import('./shadowCoverage/providerInput.js').then(({createProviderCoverageReader})=>
          createProviderCoverageReader({directory:stage.OPSMAP_STAGE_PROVIDER_COVERAGE_DIR,appRoot:coverageAppRoot,
            expected:Object.fromEntries(['FRESHON','CJ','NAVER_SHOPPING'].map(provider=>[
              provider,stage['OPSMAP_STAGE_PROVIDER_'+provider+'_SHA256']
            ]).filter(([,digest])=>digest!==undefined))}));
        return (await providerReader)();
      }:undefined;
      const postalCoverage = mountShadowCoverage({...binding,staffResponseGuarded:true,readDirectory:postalEnabled?undefined:coverageDirectory,
        appRoot:coverageAppRoot,readProviderCoverage,readStatus:readCoverageStatus,
        postal:postalEnabled?{directory:stage.OPSMAP_SHADOW_POSTAL_DIR,assetSource:remotePostal,
          readPublication:()=>{
            const active=validation.active();
            const scheduled=active?.scheduled;
            const index=scheduled?.index ?? active?.coverageIndex;
            // The verified registry and coverage index identify one publication.
            return index && {index,folder:active.directory,readCatalog:scheduled?.readPostalCatalog ?? active.readPostalCatalog};
          },
          boundarySha256:remotePostal?.config.boundary ?? stage.OPSMAP_SHADOW_POSTAL_BOUNDARY_SHA256,
          releaseSha256:remotePostal?.config.release ?? stage.OPSMAP_SHADOW_POSTAL_RELEASE_SHA256,
          detailsDirectory:stage.OPSMAP_SHADOW_POSTAL_DETAILS_DIR,detailsIndexSha256:remotePostal?.config.details ?? stage.OPSMAP_SHADOW_POSTAL_DETAILS_SHA256,
          overviewDirectory:stage.OPSMAP_SHADOW_POSTAL_OVERVIEW_DIR,overviewSha256:remotePostal?.config.overview ?? stage.OPSMAP_SHADOW_POSTAL_OVERVIEW_SHA256,
          reviewDirectory:stage.OPSMAP_SHADOW_POSTAL_REVIEW_DIR,reviewSha256:remotePostal?.config.review ?? stage.OPSMAP_SHADOW_POSTAL_REVIEW_SHA256,
          readFixed:codes=>base.get(codes),readOperations:readRecentOperations.ledger,
          readCurrentRegistration:readCurrentPostalRegistration}:undefined,
        readRunId:generation=>{const active=validation.active();return active?.generation===generation?active.scheduled?.state.runId || null:null;},
        readPreservedMap:()=>{const saved=selectSnapshot(snapshot);return saved && {count:saved.rows.length,asOf:saved.latestDate};}});
      manual.mount(binding);
      photos.mount(binding);
      mountPrivateCustomerSearch({app:router,requireStaff,readSnapshot,allowPreservedBatch:true,searchMaster:(q,options)=>callHub('customerSearch',{q,limit:50},{...options,useCache:false,privateRead:true,maxResponseBytes:65536})});
      const snapshotProjections=new WeakMap();
      router.get('/api/map-phase2b/preview/snapshot',requireStageRead,async(req,res)=>{
        try {
          const immediate=validation.active()?.scheduled?.snapshot;
          const saved=immediate||await readSnapshot();
          res.set('Cache-Control','private, no-store').vary('Cookie');
          if(baselineRestoreMs!==undefined)res.set('X-Opsmap-Restore-Ms',String(baselineRestoreMs));
          if (!saved) {
            const recovery=snapshotRecovery();
            if(recovery==='RESTORING')res.set('Retry-After','2');
            return res.status(503).json({error:recovery==='RESTORING'?'PHASE2B_SNAPSHOT_RESTORING':'PHASE2B_SNAPSHOT_UNAVAILABLE',recovery});
          }
          const recovery=snapshotRecovery();
          const meta = {...phase2bSnapshotMeta(saved), sourceGeneration:saved.sourceGeneration || null,sourceRunId:saved.sourceRunId || null,
            ...(saved.osanDeliveryThrough?{osanDeliveryThrough:saved.osanDeliveryThrough}:{}),
            recovery,...(recovery==='RESTORING'?{retryAfterMs:2000}:{})};
          // Only share the encoded, redacted response for this exact Snapshot and metadata.
          const stamp=JSON.stringify(meta);
          let projection=snapshotProjections.get(saved.rows);
          if(projection?.stamp!==stamp){
            const rows=redactPublicData(saved.rows);
            if(saved.source==='STAGE_VERIFIED_REGISTRY'){
              const active=validation.active();
              const registry=active?.generation===saved.sourceGeneration?active.registry:null;
              for(const row of rows){
                const area=addressRegionParts(registry?.get(row.customerCode)?.address||row.address||row.basicAddress);
                if(area){
                  row.addressMunicipality=area.municipality;
                  row.addressAdministrativeRegion=area.region;
                }
                for(const field of ['address','basicAddress','customerAddress','latestAddress','addressDetail'])delete row[field];
              }
            }
            projection={stamp,body:Buffer.from(JSON.stringify({ok:true,data:rows,meta,error:null}))};
            snapshotProjections.set(saved.rows,projection);
          }
          const respond=()=>res.type('application/json').send(projection.body);
          if(!immediate)return requireStaff(req,res,respond);
          if(!isSessionCurrent(req,res.locals.staffSession?.key))return res.status(401).json({error:'STAFF_LOGIN_REQUIRED'});
          res.locals.stageInlineStaffResponse=true;
          return respond();
        } catch {return res.status(503).json({error:'PHASE2B_SNAPSHOT_UNAVAILABLE'});}
      });
      if (stage.RENDER_SERVICE_ID===STAGE_SERVICE) {
        const read = createOpsmapDispatchReferenceReader({
          getPublication() {
            const active = validation.active();
            if (!active) return null;
            const state = active.scheduled?.state;
            const source = scheduledSources['delivery:'+SYNC_DELIVERY_SOURCES.osan];
            return {generation:active.generation, registry:active.registry, postalGeneration:(active.scheduled?.index??active.coverageIndex)?.sha256,
              runId:state?.runId, publishedAt:state?.committedAt ?? null, readDay:active.readNearbyDay,
              dispatchDates:active.scheduled?.vehicleDelivery?.observedDates?.osan,
              observedAt:date=>source?.lastSuccessDate===date ? source.lastSuccessAt : null};
          },
          readRetainedDated:readDatedDelivery.readRetained,
          retainedDatedDates:readDatedDelivery.retainedDates,
          readWmsExport,
          readPostcodes:(codes,generation)=>generation ? postalCoverage?.dispatchPostcodes(codes,generation) : null,
        });
        mountOpsmapDispatchReference(router,{requireStaff,read,today,onDay:({date,route,amounts})=>{
          if (!(readWmsExport.hasVerifiedSource?.(date)??readWmsExport.dates?.includes(date))) return;
          console.info(JSON.stringify({component:'stage-wms-export-day',date,
            route:{state:route.state,source:route.source??null,rows:route.rows.length,projectionFailure:route.projectionFailure??null},
            amounts:{state:amounts.state,vehicles:amounts.vehicles.length,exportFailure:amounts.exportFailure??null}}));
        }});
      }
      router.get('/api/map-phase2b/preview/route-plan',requireStaff,async(req,res)=>{
        const date=normalizeDateValue(req.query.date),vehicle=normalizeCell(req.query.vehicle);
        if (!date || !vehicle || vehicle.length>40) return res.status(400).json({error:'INVALID_ROUTE'});
        try {
          const payload = await callHub('routePlan',{date,vehicle});
          return requireStaff(req,res,()=>res.set('Cache-Control','private, no-store').json(redactPublicData(payload)));
        }
        catch {return res.status(503).json({error:'ROUTE_SOURCE_UNAVAILABLE'});}
      });
      router.get('/api/map-phase2b/preview/today-status',requireStaff,async(req,res)=>{
        const date=normalizeDateValue(req.query.date);
        if(!date || date>(dispatchDate?.() || today()) || Object.keys(req.query).length!==1) return res.status(400).json({error:'INVALID_DATE'});
        try {
          const data=await readDatedDelivery(date);
          return requireStaff(req,res,()=>res.set('Cache-Control','private, no-store').json({ok:true,data:redactPublicData(data),error:null}));
        } catch(failure) {
          return res.set('Cache-Control','private, no-store').status(503).json({error:'DELIVERY_STATUS_UNAVAILABLE',
            sourceCode:/^DELIVERY_SOURCE_[A-Z_]+$/.test(failure.code||'') ? failure.code : 'DELIVERY_SOURCE_READ_UNAVAILABLE'});
        }
      });
      router.get('/vehicle-data.js',requireStaff,async(_req,res)=>{
        try {
          const saved=await readSnapshot();
          if (!saved) return res.status(503).json({error:'REFERENCE_DATA_UNAVAILABLE'});
          const vehicles=new Map();
          for (const row of saved.rows) {
            const vehicle=row.baseVehicle || row.vehicle;
            if (vehicle && !vehicles.has(vehicle)) vehicles.set(vehicle,{vehicle,group:row.baseVehicleGroup || row.centerGroup || '',customers:[]});
          }
          const source={vehicles:[...vehicles.values()]};
          return res.type('js').set('Cache-Control','private, no-store').send(`window.VEHICLE_AREA_DATA=${JSON.stringify(source)};`);
        } catch {return res.status(503).json({error:'REFERENCE_DATA_UNAVAILABLE'});}
      });
    }
  });
  router.use('/api',(_req,res)=>res.status(404).json({error:'OPSMAP_API_NOT_AVAILABLE'}));
  router.get('/',(_req,res)=>res.sendFile('map-phase2b-preview.html',{root:publicDir}));
  router.get('/vendor/xlsx.full.min.js',(_req,res)=>res.sendFile(excelBrowserScript,{maxAge:'1h'}));
  router.use(express.static(publicDir));
  if (exactStageService) {
    void roadRouteService.readiness().then(({stage,enabled,keyConfigured,budgetVerified,budgetError,blockedReasons})=>{
      console.info(JSON.stringify({component:'stage-road-readiness',event:'startup',stage,enabled,keyConfigured,budgetVerified,budgetError,blockedReasons}));
    }).catch(()=>{
      console.warn(JSON.stringify({component:'stage-road-readiness',event:'startup',stage:roadSettings,error:'READINESS_UNAVAILABLE'}));
    });
  }
  return app;
}
