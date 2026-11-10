import express from 'express';
import compression from 'compression';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {mountProductionMapApi} from './opsmap-abc/productionMapIntegration.js';
import {callHub as hubRead} from './opsmap-abc/phase2bHubReadClient.js';
import {createFixedVehicleCache} from './opsmap-abc/fixedVehicleCache.js';
import {createFixedVehicleFileStore} from './opsmap-abc/fixedVehicleStore.js';
import {createManualMapPins} from './opsmap-abc/manualMapPins.js';
import {isRoadRouteRequest} from './opsmap-abc/roadRouteService.js';
import {createRecordedRoadRouteReader} from './opsmap-abc/recordedRoadRoute.js';
import {staffStoreDetail} from './opsmap-abc/mapStaffDetail.js';
import {createPrivateGithubJsonStore} from './fixedVehicleStore.js';
import {createManualPinGithubStore,createStageGeocodeBudgetStore} from './manualPinGithubStore.js';
import {createStageStaffSessionStore} from './staffSessionStore.js';
import {createProductionSnapshotStore,materializeSnapshot} from './productionSnapshotStore.js';
import {STAGE_ORIGIN,STAGE_SERVICE,STAGE_BUNDLE_ROUTE,STAGE_ADDRESS_BATCH_ROUTE,createStageAbValidation,mountStageAbValidation} from './stageAbValidation.js';
import {phase2bSnapshotMeta} from './phase2bOperations.js';
import {mountPrivateCustomerSearch} from './privateCustomerSearch.js';
import {redactPublicData} from './publicDataSecurity.js';
import {createStageOperationalPhotoExtension} from './opsmapStagePhotos.js';
import {mountShadowCoverage} from './shadowCoverage/routes.js';
import {createStageDatedDeliveryReader} from './stageDatedDelivery.js';
import {createKakaoCoordinateConnection} from './opsmap-abc/kakaoCoordinateConnection.js';
import {createOfficialAddressLookup,createTemporaryOfficialAddressLookup} from './opsmapOfficialAddressLookup.js';
import {createStageGenerationRestore} from './stageGenerationRestore.js';
import {openOpsmapSyncGenerationStore} from './opsmapSyncGeneration.js';
import {createOpsmapDurableGeneration,stageOpsmapDurableStorage} from './opsmapDurableGeneration.js';
import {mountOpsmapScheduledRun} from './opsmapScheduledRun.js';
import {SYNC_DELIVERY_SOURCES} from './opsmapSyncPolicy.js';
import {opsmapDispatchDate} from './snapshotRefreshEvidence.js';

const stageOrigin = STAGE_ORIGIN;
const stageService = STAGE_SERVICE;
const repo = 'mingu0702-droid/freshon-cache';
const github = `https://api.github.com/repos/${repo}`;
const pinsBranch = 'stage/opsmap-manual-pins';
const snapshotBranch = 'stage/opsmap-snapshots';
const publicDir = fileURLToPath(new URL('../public/opsmap/', import.meta.url));
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
    rows.set(row.customerCode,{customerCode:row.customerCode,baseVehicle:row.baseVehicle || '',baseVehicleGroup:row.baseVehicleGroup || '',
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

function stageGithub(fetchImpl, {files, branch, writable, allowBlob = false}) {
  return (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    const endpoint = `${url.origin}${url.pathname}`;
    const file = files.find(name => endpoint === `${github}/contents/opsmap-stage/${name}`);
    const query = url.searchParams;
    const read = method === 'GET' && (file && query.size === 1 && query.get('ref') === branch || !url.search &&
      (endpoint === github || allowBlob && endpoint.startsWith(`${github}/git/blobs/`) && /^[a-f0-9]{40}$/.test(endpoint.split('/').at(-1))));
    const write = method === 'PUT' && file && file === writable && !url.search && JSON.parse(options.body).branch === branch;
    if ((!read && !write) || url.username || url.password || url.hash) throw new Error('STAGE_STORE_SCOPE_REJECTED');
    return fetchImpl(input, {...options, redirect:'error'});
  };
}

export function createStageVerificationApp({env = process.env, fetchImpl = fetch, readHub = hubRead, readShadowDirectory,
  openScheduledStore = openOpsmapSyncGenerationStore, now = Date.now, snapshotWaitMs = 2500} = {}) {
  const today=()=>new Date(now()+9*3600000).toISOString().slice(0,10);
  if (env.RENDER_EXTERNAL_URL !== stageOrigin || (env.RENDER_SERVICE_ID && env.RENDER_SERVICE_ID !== stageService)) throw new Error('EXACT_STAGE_ORIGIN_REQUIRED');
  if (![env.HUB_API_URL,env.OPSMAP_PRIVATE_READER_URL].every(stageHubUrl)) throw new Error('STAGE_READ_SOURCE_CONFIG');
  const stageAddressApproved = env.RENDER_SERVICE_ID === stageService && env.OPSMAP_STAGE_KAKAO_ADDRESS_APPROVED === '1' &&
    /^(?:[1-9][0-9]?|100)$/.test(env.OPSMAP_KAKAO_GEOCODING_DAILY_LIMIT || '') && !!env.GITHUB_TOKEN;
  const stage = {...env, OPSMAP_STAGE_VERIFY_ONLY:'1', MAP_STAFF_ORIGIN:stageOrigin, OPSMAP_MANUAL_PIN_WRITES:'0',
    OPSMAP_MANUAL_PIN_STORE_FILE:undefined, OPSMAP_MANUAL_PIN_SEARCH_CACHE_FILE:undefined, OPSMAP_PRIVATE_DETAIL_CACHE_ENABLED:'0',
    OPSMAP_KAKAO_GEOCODING_ENABLED:stageAddressApproved ? env.OPSMAP_KAKAO_GEOCODING_ENABLED : '0',
    OPSMAP_KAKAO_DIAGNOSTIC_ENABLED:stageAddressApproved ? env.OPSMAP_KAKAO_DIAGNOSTIC_ENABLED : '0',
    OPSMAP_KAKAO_KEYWORD_FREE_QUOTA_VERIFIED:stageAddressApproved && env.OPSMAP_STAGE_KAKAO_PLACE_APPROVED === '1'
      ? env.OPSMAP_KAKAO_KEYWORD_FREE_QUOTA_VERIFIED : '0', OPSMAP_ROAD_ROUTE_ENABLED:'0'};
  const validation = createStageAbValidation({now});
  const generationRestore=createStageGenerationRestore({env:stage,validation,now});
  let baselineConfig, baselineStore, baselineRefresh, baselineState='NOT_CONFIGURED';
  if(stage.RENDER_SERVICE_ID===STAGE_SERVICE){
    try {
      const config=JSON.parse(readFileSync('/etc/secrets/opsmap-stage-baseline-v1.json','utf8'));
      const baselineKey=Buffer.from(config.key||'','base64');
      if(baselineKey.length!==32||config.ref?.generation!=='afa2699571a45ef38300a2c4477b18e27b29e235dd24c3f252983d3c110b5014')throw Error('STAGE_BASELINE_CONFIG');
      baselineConfig={ref:config.ref,baselineKey};
      baselineState='PENDING';
    } catch(error) {
      if(error.code!=='ENOENT')baselineState='UNAVAILABLE';
    }
  }
  function refreshBaseline(){
    if(!baselineConfig||['VERIFIED','SUPERSEDED'].includes(baselineState))return;
    baselineRefresh??=(async()=>{
      baselineStore ||= createOpsmapDurableGeneration({...stageOpsmapDurableStorage({env:stage,fetchImpl,baselineKey:baselineConfig.baselineKey}),now});
      const candidate=await baselineStore.readBaseline(baselineConfig.ref);
      if(candidate.ledger.sha256!=='a239aaf9f5b8138daaa75a0d662d03964a93ef62bd85e21cc230418be22e6115'||
          candidate.registry.size!==6043||[...candidate.registry.values()].some(row=>!row.hasPoint)||!candidate.vehicleDelivery)throw Error('STAGE_BASELINE_SCOPE');
      baselineState=validation.followScheduled(candidate,baselineStore.readDay,{baseline:true})?'VERIFIED':'SUPERSEDED';
    })().catch(async()=>{baselineState='UNAVAILABLE';await baselineStore?.dispose().catch(()=>{});})
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
        ? createOpsmapDurableGeneration({...stageOpsmapDurableStorage({env:stage,fetchImpl}),now})
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
    if(!coverageOfficialIndex)return temporary || preservedOfficialIndex;
    return {lookup:query=>temporary?.lookup(query)??preservedOfficialIndex?.lookup(query)??coverageOfficialIndex.lookup(query)};
  };
  const geocodeBudgetFile = 'geocode-budget-v1.json';
  const geocodeBudget = stageAddressApproved ? createStageGeocodeBudgetStore({repo,token:stage.GITHUB_TOKEN,branch:pinsBranch,
    fetchImpl:stageGithub(fetchImpl,{files:[geocodeBudgetFile],branch:pinsBranch,writable:geocodeBudgetFile})}) : null;
  const addressLookupService = createKakaoCoordinateConnection({env:stage,fetchImpl,store:geocodeBudget,
    stageAddressApproved,independentAddressLookup:()=>{
      const index=readOfficialIndex();
      return validation.active()?.bundledAddress || (index&&{lookup(query){
        const point=index.lookup(query);
        return point?.coordinateKind&&point.coordinateKind!=='BUILDING'?null:point;
      }});
    }});
  let coverageState = 'restoring';
  const baseDirectory = Promise.resolve().then(() => readShadowDirectory ? readShadowDirectory() : stage.OPSMAP_SHADOW_DATA_DIR)
    .catch(() => null).then(directory => {coverageState = directory ? 'ready' : 'unavailable'; return directory;});
  const coverageDirectory = () => validation.active()?.directory || baseDirectory;
  const sessions = createStageStaffSessionStore({env:stage,fetchImpl:stageGithub(fetchImpl,{files:['staff-sessions-v1.json'],branch:pinsBranch,writable:'staff-sessions-v1.json'})});
  const snapshotFetch = stageGithub(fetchImpl,{files:['map-snapshot-v1.json','map-date-checkpoint-v1.json','fixed-vehicle-projection-v1.json'],branch:snapshotBranch,allowBlob:true});
  const snapshotStore = createProductionSnapshotStore({env:stage,token:stage.OPSMAP_SNAPSHOT_STORE_TOKEN || stage.GITHUB_TOKEN,fetchImpl:snapshotFetch});
  const masterStore = createPrivateGithubJsonStore({env:{GITHUB_CACHE_REPO:repo,GITHUB_TOKEN:stage.OPSMAP_SNAPSHOT_STORE_TOKEN || stage.GITHUB_TOKEN,GITHUB_CACHE_BRANCH:snapshotBranch,GITHUB_CACHE_DIR:'opsmap-stage'},fetchImpl:snapshotFetch});
  let snapshot = null, snapshotPending = null, snapshotBase = null, joinedSnapshot = null;
  let fileRestorePending = null;
  let nextSnapshotCheck = 0;
  let snapshotReadState=snapshotStore?'PENDING':'NOT_CONFIGURED', snapshotVerifiedAt=null;
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
    if (snapshotPending || scheduledRefresh || fileRestorePending || baselineRefresh) return 'RESTORING';
    const fileState=generationRestore.status().state;
    if ([snapshotReadState,scheduledState,fileState].includes('LAST_VERIFIED_RETAINED')) return 'LAST_VERIFIED_RETAINED';
    if ([snapshotReadState,scheduledState,fileState,baselineState].some(state=>['UNAVAILABLE','NOT_AVAILABLE'].includes(state))) return 'UNAVAILABLE';
    return snapshot || validation.active() ? 'READY' : 'UNAVAILABLE';
  }
  async function readSnapshot() {
    const current=selectSnapshot(snapshot);
    if (current && validation.active()) return current;
    const baseRead=readBaseSnapshot().catch(()=>null);
    if (current) return current;
    const restore = [scheduledRefresh,fileRestorePending,baselineRefresh].filter(Boolean);
    const reads = [baseRead,...restore];
    let timer;
    // An existing copy may be served as soon as either source validates it. Bound a cold HTTP read.
    try {
      await Promise.race([
        Promise.any(reads.map(read=>Promise.resolve(read).then(()=>{
          if (!selectSnapshot(snapshot)) throw Error('STAGE_SNAPSHOT_NOT_AVAILABLE');
        }))).catch(()=>{}),
        new Promise(resolve=>{timer=setTimeout(resolve,snapshotWaitMs);})
      ]);
      return selectSnapshot(snapshot);
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
    if (!saved || !snapshotBase) return null;
    const groups = new Set(saved.rows.filter(row=>row.baseVehicle===vehicle && row.baseVehicleState==='VERIFIED_MASTER' &&
      row.baseVehicleSource==='FIXED_DISPATCH_PRIMARY' && /^[a-f0-9]{64}$/.test(row.baseVehicleVersion || '')).map(row=>row.baseVehicleGroup));
    return groups.size===1 ? [...groups][0] : null;
  }});
  const photos = createStageOperationalPhotoExtension({env:stage,fetchImpl,defaultDate:today});
  const fixed = createFixedVehicleCache({readOnly:true,reloadReadOnlyAfterMs:60_000,now,store:stage.OPSMAP_STAGE_FIXED_MASTER_FILE ? createFixedVehicleFileStore({env:stage}) : {
    async load() {return (await masterStore.read('fixed-vehicle-projection-v1.json')).value;}
  }});
  const base={async get(codes) {
    const primary=await fixed.get(codes);
    if (primary.ok) return primary;
    try {await readSnapshot();} catch {return primary;}
    return snapshotBase?.get(codes) || primary;
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
  mountOpsmapScheduledRun(app,{env:stage,now});
  // Start after listen and reuse the same in-flight, read-only load as user queries.
  if(stage.RENDER_SERVICE_ID===stageService) app.once('opsmap-stage-listening',()=>{
    const refresh=()=>{
      if(snapshotStore)void readBaseSnapshot().catch(()=>{});
      if(generationRestore.status().state!=='NOT_CONFIGURED') {
        fileRestorePending ??= generationRestore.refresh().finally(()=>{fileRestorePending=null;});
      }
      void refreshBaseline();
      void refreshScheduled();
    };
    refresh();
    setInterval(refresh,60_000).unref();
  });
  const readDatedDelivery = createStageDatedDeliveryReader({env:stage, fetchImpl});
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
  mountProductionMapApi(router,{
    previewEnabled:()=>true,requireView:(req,res,next)=>staffView(req,res,next),readPhase2bSnapshot:readSnapshot,
    getSnapshotMemory:()=>validation.active() ? validation.active().scheduled?.snapshot || joinedSnapshot?.snapshot || snapshot : snapshot,
    phase2bKstDate:today,phase2bDispatchDate:dispatchDate,normalizeCell,normalizeDateValue,phase2bSnapshotMeta,phase2bTodayStatus:readDatedDelivery,
    callHub,secret:'',authOptions:{env:stage,sessionStore:sessions,cookieName:'__Host-map-staff'},
    sharedBaseCache:base,hybridEnabled:()=>false,roadRouteBudget:null,readRecordedRoadRoute,addressLookupService,
    getShadowCoverageState:()=>validation.active() ? 'ready' : coverageState,
    getLocalDataEvidence:()=>validation.active()?.evidence || null,
    readArchivedAssignments:validation.archivedAssignments,
    mountPrivateExtensions:binding=>{
      const {requireStaff,isSessionCurrent}=binding;
      staffView = requireStaff;
      if (stage.RENDER_SERVICE_ID === STAGE_SERVICE) {
        mountStageAbValidation(router,{...binding,validation,readSnapshot,readOfficialIndex,readBaseVehicles:codes=>base.get(codes)});
        router.get('/api/map-phase2b/private/stage-sync-evidence',requireStaff,(_req,res)=>{
          const generation=validation.active();
          const windowDays=generation?.scheduled?.vehicleDelivery?.observedDates.all?.length ?? generation?.nearby?.observedDays;
          const sourceRunId=generation?.scheduled?.state.runId || null;
          const requiredSourceIds=Object.values(SYNC_DELIVERY_SOURCES);
          const confirmedSourceIds=requiredSourceIds.filter(id=>
            generation?.scheduled?.vehicleDelivery?.completeSources[id]?.includes(scheduledRun?.date));
          const automaticSyncVerified=remoteEnabled && scheduledState==='VERIFIED_SCHEDULED_PROJECTION' && !!sourceRunId &&
            ['PUBLISHED','VERIFIED_NOOP'].includes(scheduledRun?.state) && scheduledRun.sourceReadComplete===true &&
            confirmedSourceIds.length===requiredSourceIds.length &&
            scheduledRun.generation===generation.generation &&
            scheduledRun.date===today() && Number.isFinite(Date.parse(scheduledSuccessAt));
          return res.set('Cache-Control','private, no-store').vary('Cookie').json({
            automaticSyncVerified,
            sources:Object.fromEntries(['customerRegistry',...requiredSourceIds.map(id=>'delivery:'+id)].map(id=>[
              id,scheduledSources[id]||{lastSuccessAt:null,error:null}
            ])),
            snapshot:{state:snapshotReadState,verifiedAt:snapshotVerifiedAt,latestDate:snapshot?.latestDate||null,
              revision:snapshot?.preservation?.revision||null,selectedDateStorageVerified:snapshot?.selectedDateCheckpoint?.selectedDateStorageVerified===true},
            coverage:{state:generation?'VERIFIED_STAGE_GENERATION':coverageState,generation:generation?.generation||null,
              asOf:generation?.asOf||null,scope:generation?.evidence.coordinateScope||null,restore:generationRestore.status(),baselineState,
              publishedAt:generation?.evidence.coverageGeneratedAt||null,unknownDays:Number.isInteger(windowDays)?90-windowDays:null,
              registered:generation?.counts.registered??null,located:generation?.counts.located??null},
            scheduled:{state:scheduledState,error:scheduledError,previousVerifiedRetained:scheduledState==='LAST_VERIFIED_RETAINED',
              revision:generation?.scheduled?.state.revision||null,requiredSourceIds,confirmedSourceIds,
              config:{readerApproved:scheduledEnabled,remoteApproved:remoteEnabled,writerApproved:stage.OPSMAP_STAGE_SYNC_PUBLISH_APPROVED==='1',
                schedulerApproved:stage.OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED==='1',deliveryConfigured:readDatedDelivery.configured,
                sourceReadsApproved:stage.OPSMAP_SYNC_SOURCE_READ_APPROVED==='1'},
              publishedAt:generation?.scheduled?.state.committedAt||null,lastSuccessAt:scheduledSuccessAt,sourceRunId,
              run:scheduledRun?{runId:scheduledRun.runId,triggerId:scheduledRun.triggerId,executorHash:scheduledRun.principal,
                state:scheduledRun.state,date:scheduledRun.date,startedAt:scheduledRun.startedAt,completedAt:scheduledRun.completedAt||null,
                sourceReadComplete:scheduledRun.sourceReadComplete===true}:null,
              lastFailure:scheduledFailure?{runId:scheduledFailure.runId,at:scheduledFailure.completedAt,code:scheduledFailure.error,
                date:scheduledFailure.failedDate,center:scheduledFailure.failedCenter,sourceId:scheduledFailure.failedSourceId||null}:null}
          });
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
      mountShadowCoverage({...binding,staffResponseGuarded:true,readDirectory:coverageDirectory,
        appRoot:coverageAppRoot,readProviderCoverage,
        readRunId:generation=>{const active=validation.active();return active?.generation===generation?active.scheduled?.state.runId || null:null;},
        readPreservedMap:()=>snapshot && {count:snapshot.rows.length,asOf:snapshot.latestDate}});
      manual.mount(binding);
      photos.mount(binding);
      mountPrivateCustomerSearch({app:router,requireStaff,readSnapshot,allowPreservedBatch:true,searchMaster:(q,options)=>callHub('customerSearch',{q,limit:50},{...options,useCache:false,privateRead:true,maxResponseBytes:65536})});
      router.get('/api/map-phase2b/preview/snapshot',requireStaff,async(req,res)=>{
        try {
          const saved=await readSnapshot();
          if (!saved) {
            const recovery=snapshotRecovery();
            if(recovery==='RESTORING')res.set('Retry-After','2');
            return res.status(503).json({error:recovery==='RESTORING'?'PHASE2B_SNAPSHOT_RESTORING':'PHASE2B_SNAPSHOT_UNAVAILABLE',recovery});
          }
          const rows = redactPublicData(saved.rows);
          if (saved.source === 'STAGE_VERIFIED_REGISTRY') {
            for (const row of rows) for (const field of ['address','basicAddress','customerAddress','latestAddress','addressDetail']) delete row[field];
          }
          const meta = {...phase2bSnapshotMeta(saved), sourceGeneration:saved.sourceGeneration || null,sourceRunId:saved.sourceRunId || null,
            recovery:snapshotRecovery()};
          return requireStaff(req,res,()=>res.set('Cache-Control','private, no-store').json({ok:true,data:rows,meta,error:null}));
        } catch {return res.status(503).json({error:'PHASE2B_SNAPSHOT_UNAVAILABLE'});}
      });
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
  router.use(express.static(publicDir));
  return app;
}
