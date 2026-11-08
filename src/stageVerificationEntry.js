import express from 'express';
import compression from 'compression';
import {isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mountProductionMapApi} from './opsmap-abc/productionMapIntegration.js';
import {callHub as hubRead} from './opsmap-abc/phase2bHubReadClient.js';
import {createFixedVehicleCache} from './opsmap-abc/fixedVehicleCache.js';
import {createFixedVehicleFileStore} from './opsmap-abc/fixedVehicleStore.js';
import {createManualMapPins} from './opsmap-abc/manualMapPins.js';
import {createStoreRoadBudget} from './opsmap-abc/hubRoadBudget.js';
import {isRoadRouteRequest} from './opsmap-abc/roadRouteService.js';
import {createRecordedRoadRouteReader} from './opsmap-abc/recordedRoadRoute.js';
import {staffStoreDetail} from './opsmap-abc/mapStaffDetail.js';
import {createPrivateGithubJsonStore} from './fixedVehicleStore.js';
import {createManualPinGithubStore} from './manualPinGithubStore.js';
import {createStageStaffSessionStore} from './staffSessionStore.js';
import {createProductionSnapshotStore,materializeSnapshot} from './productionSnapshotStore.js';
import {phase2bSnapshotMeta} from './phase2bOperations.js';
import {mountPrivateCustomerSearch} from './privateCustomerSearch.js';
import {redactPublicData} from './publicDataSecurity.js';
import {createOperationalPhotoExtension} from './opsmapOperationalPhotos.js';
import {mountShadowCoverage} from './shadowCoverage/routes.js';

const stageOrigin = 'https://freshon-admin-stage-preview-template.onrender.com';
const stageService = 'srv-da47hugu01pc73etpfa0';
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
const readPosts = new Set(['/api/map-phase2b/preview/base-vehicles', '/api/map-phase2b/private/address-lookup']);
const authPosts = new Set(['/api/map-phase2b/auth/login', '/api/map-phase2b/auth/logout']);
const normalizeCell = value => typeof value === 'string' ? value.trim() : '';
const normalizeDateValue = value => {
  const day = normalizeCell(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0,10) === day ? day : '';
};
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0,10);
const deliveryUnavailable = () => { throw Object.assign(new Error('DELIVERY_SOURCE_READ_ONLY'), {code:'DELIVERY_SOURCE_READ_ONLY'}); };

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

function stagePhotoExtension(env, fetchImpl) {
  const cookie = String(env.OPSMAP_STAGE_DELIVERY_PHOTO_COOKIE || '').trim();
  const hasSession = /^[\x20-\x7e]{1,8192}$/.test(cookie);
  const sourceOrigin = 'https://delivery-bali.chabyulhwa.com';
  return createOperationalPhotoExtension({
    enabled: true, hasMemorySession: () => hasSession, imageFetch: fetchImpl,
    rawRequest: hasSession ? (pathname, {method, signal} = {}) => {
      const url = new URL(pathname, sourceOrigin);
      const detail = /^\/api\/bali\/task\/\d{1,20}(?:\/status-record)?$/.test(url.pathname) && !url.search;
      const list = url.pathname === '/api/bali/task' &&
        /^[A-Za-z0-9_-]{1,64}$/.test(url.searchParams.get('customerErpCodeLike') || '') &&
        url.searchParams.get('statusIn') === 'COMPLETED' && url.searchParams.get('completeTypeIn') === 'FRONT_DOOR';
      if (method !== 'GET' || url.origin !== sourceOrigin || url.username || url.password || url.hash || (!detail && !list)) {
        throw new Error('STAGE_PHOTO_READ_SCOPE_REJECTED');
      }
      return fetchImpl(url, {method, signal, redirect:'error', cache:'no-store', headers:{Accept:'application/json',Cookie:cookie}});
    } : undefined
  });
}

export function createStageVerificationApp({env = process.env, fetchImpl = fetch, readHub = hubRead} = {}) {
  if (env.RENDER_EXTERNAL_URL !== stageOrigin || (env.RENDER_SERVICE_ID && env.RENDER_SERVICE_ID !== stageService)) throw new Error('EXACT_STAGE_ORIGIN_REQUIRED');
  if (![env.HUB_API_URL,env.OPSMAP_PRIVATE_READER_URL].every(stageHubUrl)) throw new Error('STAGE_READ_SOURCE_CONFIG');
  const stage = {...env, OPSMAP_STAGE_VERIFY_ONLY:'1', MAP_STAFF_ORIGIN:stageOrigin, OPSMAP_MANUAL_PIN_WRITES:'0',
    OPSMAP_MANUAL_PIN_STORE_FILE:undefined, OPSMAP_MANUAL_PIN_SEARCH_CACHE_FILE:undefined, OPSMAP_PRIVATE_DETAIL_CACHE_ENABLED:'0'};
  const sessions = createStageStaffSessionStore({env:stage,fetchImpl:stageGithub(fetchImpl,{files:['staff-sessions-v1.json'],branch:pinsBranch,writable:'staff-sessions-v1.json'})});
  const snapshotFetch = stageGithub(fetchImpl,{files:['map-snapshot-v1.json','map-date-checkpoint-v1.json','fixed-vehicle-projection-v1.json'],branch:snapshotBranch,allowBlob:true});
  const snapshotStore = createProductionSnapshotStore({env:stage,token:stage.OPSMAP_SNAPSHOT_STORE_TOKEN || stage.GITHUB_TOKEN,fetchImpl:snapshotFetch});
  let snapshot = null, snapshotPending = null, snapshotBase = null;
  async function readSnapshot() {
    if (snapshot) return snapshot;
    snapshotPending ??= Promise.resolve(snapshotStore?.load()).then(value => {
      if (value) {
        snapshot = materializeSnapshot(value);
        snapshotBase = stageSnapshotBaseVehicles(snapshot);
      }
      return snapshot;
    }).finally(() => {snapshotPending = null;});
    return snapshotPending;
  }
  const callHub = (action, params, options) => {
    if (!readActions.has(action)) throw new Error('STAGE_HUB_WRITE_REJECTED');
    return readHub(action, params, options);
  };
  const readRecordedRoadRoute = createRecordedRoadRouteReader({callHub,async readVehicleCenter({vehicle}) {
    const saved = await readSnapshot();
    if (!saved || !snapshotBase) return null;
    const groups = new Set(saved.rows.filter(row=>row.baseVehicle===vehicle && row.baseVehicleState==='VERIFIED_MASTER' &&
      row.baseVehicleSource==='FIXED_DISPATCH_PRIMARY' && /^[a-f0-9]{64}$/.test(row.baseVehicleVersion || '')).map(row=>row.baseVehicleGroup));
    return groups.size===1 ? [...groups][0] : null;
  }});
  const photos = stagePhotoExtension(stage, fetchImpl);
  const masterStore = createPrivateGithubJsonStore({env:{GITHUB_CACHE_REPO:repo,GITHUB_TOKEN:stage.OPSMAP_SNAPSHOT_STORE_TOKEN || stage.GITHUB_TOKEN,GITHUB_CACHE_BRANCH:snapshotBranch,GITHUB_CACHE_DIR:'opsmap-stage'},fetchImpl:snapshotFetch});
  const fixed = createFixedVehicleCache({readOnly:true,store:stage.OPSMAP_STAGE_FIXED_MASTER_FILE ? createFixedVehicleFileStore({env:stage}) : {
    async load() {return (await masterStore.read('fixed-vehicle-projection-v1.json')).value;}
  }});
  const base={async get(codes) {
    const primary=await fixed.get(codes);
    if (primary.ok) return primary;
    try {await readSnapshot();} catch {return primary;}
    return snapshotBase?.get(codes) || primary;
  }};
  const budgetConfigured = stage.OPSMAP_ROAD_BUDGET_STORE_KIND === 'github-stage';
  const pinStore = stage.OPSMAP_MANUAL_PIN_STORE_KIND === 'github' || budgetConfigured ? createManualPinGithubStore({
    repo, token:stage.GITHUB_TOKEN, branch:pinsBranch,
    fetchImpl:stageGithub(fetchImpl,{files:['manual-pins-v1.json'],branch:pinsBranch,writable:budgetConfigured ? 'manual-pins-v1.json' : undefined})
  }) : null;
  const manual = createManualMapPins({env:stage,store:pinStore && {transaction:work=>pinStore.transaction(state=>work(state))},
    authorizeWrite:()=>false,readCustomer:async code=>{
      const row=(await readSnapshot())?.rows.find(item=>item.customerCode===code);
      if (row?.address) return row;
      const response=await callHub('customerDetail',{customerCode:code},{useCache:false,privateRead:true,maxResponseBytes:65536});
      return staffStoreDetail(response?.data,{customerCode:code,date:null});
    }});
  const roadRouteBudget = budgetConfigured ? createStoreRoadBudget({env:stage,accountHash:stage.OPSMAP_ROAD_BUDGET_ACCOUNT_SHA256,store:{
    transaction:work=>pinStore.transaction((state,save)=>{
      const {roadBudget:_previous,...pins}=structuredClone(state);
      return work(state,next=>{
        const {roadBudget,...after}=next;
        if (!roadBudget || !isDeepStrictEqual(pins,after)) throw new Error('STAGE_PIN_WRITE_REJECTED');
        return save(next);
      });
    })
  }}) : null;

  const app = express(), router = express.Router();
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
    if (req.method==='GET' || req.method==='HEAD' || req.method==='POST' && (authPosts.has(route) || readPosts.has(route) || isRoadRouteRequest(req))) return next();
    return res.status(403).json({error:'STAGE_READ_ONLY'});
  });
  mountProductionMapApi(router,{
    previewEnabled:()=>true,requireView:(_req,_res,next)=>next(),readPhase2bSnapshot:readSnapshot,getSnapshotMemory:()=>snapshot,
    phase2bKstDate:today,normalizeCell,normalizeDateValue,phase2bSnapshotMeta,phase2bTodayStatus:deliveryUnavailable,
    callHub,secret:'',authOptions:{env:stage,sessionStore:sessions,cookieName:'__Host-map-staff'},
    sharedBaseCache:base,hybridEnabled:()=>false,roadRouteBudget,readRecordedRoadRoute,
    shadowCoverageEnabled:Boolean(stage.OPSMAP_SHADOW_DATA_DIR),
    mountPrivateExtensions:binding=>{
      const {requireStaff}=binding;
      mountShadowCoverage({...binding,staffResponseGuarded:true,directory:stage.OPSMAP_SHADOW_DATA_DIR,appRoot:fileURLToPath(new URL('../',import.meta.url))});
      manual.mount(binding);
      photos.mount(binding,{historyOnly:true});
      mountPrivateCustomerSearch({app:router,requireStaff,readSnapshot,searchMaster:(q,options)=>callHub('customerSearch',{q,limit:50},{...options,useCache:false,privateRead:true,maxResponseBytes:65536})});
      router.get('/api/map-phase2b/preview/snapshot',requireStaff,async(req,res)=>{
        try {
          const saved=await readSnapshot();
          if (!saved) return res.status(503).json({error:'PHASE2B_SNAPSHOT_NOT_READY'});
          return requireStaff(req,res,()=>res.json({ok:true,data:redactPublicData(saved.rows),meta:phase2bSnapshotMeta(saved),error:null}));
        } catch {return res.status(503).json({error:'PHASE2B_SNAPSHOT_UNAVAILABLE'});}
      });
      router.get('/api/map-phase2b/preview/route-plan',requireStaff,async(req,res)=>{
        const date=normalizeDateValue(req.query.date),vehicle=normalizeCell(req.query.vehicle);
        if (!date || !vehicle || vehicle.length>40) return res.status(400).json({error:'INVALID_ROUTE'});
        try {return res.json(redactPublicData(await callHub('routePlan',{date,vehicle})));}
        catch {return res.status(503).json({error:'ROUTE_SOURCE_UNAVAILABLE'});}
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
