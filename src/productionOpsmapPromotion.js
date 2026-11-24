import {opsmapArchiveSite,opsmapArchiveWriteApproved,primaryPreservationEvidence,PRIMARY_ORIGIN} from './stageScope.js';
import {resolveProductionCredentials} from './productionOpsmapCandidate.js';
import {createProductionStaffSessionStore} from './opsmap-abc/staffSessionStore.js';
import {createProductionRoadBudget,productionRoadRouteFlag} from './opsmap-abc/productionRoadBudget.js';
import {createRoadRouteService} from './opsmap-abc/roadRouteService.js';
import {createProductionGeocodeBudgetGithubStore} from './opsmap-abc/manualPinGithubStore.js';
import {stageOpsmapDurableStorage,stageVerifiedBaselineConfig} from './opsmapDurableGeneration.js';
import {readApprovedOsanRegistryRecoveryManifest} from './stageNationalRegistry.js';

const archiveRepo='https://api.github.com/repos/mingu0702-droid/freshon-cache';
const archiveRoots={
  operationsArchive:'stage/opsmap-snapshots',wmsArchive:'stage/opsmap-wms-exports',
  legacySnapshotArchive:'production/opsmap-snapshots',legacyAuthArchive:'production/opsmap-auth',
  legacyPinsArchive:'production/opsmap-manual-pins',stagePinsArchive:'stage/opsmap-manual-pins'
};

async function checkArchiveBaselines(env,fetchImpl) {
  const evidence=primaryPreservationEvidence(env);
  const request=async suffix=>{
    const response=await fetchImpl(archiveRepo+suffix,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{
      Authorization:'Bearer '+env.OPSMAP_PRIMARY_ARCHIVE_READ_TOKEN,
      Accept:'application/vnd.github+json','User-Agent':'opsmap-primary-preservation'
    }});
    if(!response.ok)throw Error('OPSMAP_PRIMARY_ARCHIVE_UNAVAILABLE');
    return response.json();
  };
  if((await request('')).private!==true)throw Error('OPSMAP_PRIMARY_ARCHIVE_NOT_PRIVATE');
  for(const [key,branch] of Object.entries(archiveRoots)){
    const head=await request('/git/ref/heads/'+branch);
    if(!/^[a-f0-9]{40}$/.test(head.object?.sha||''))throw Error('OPSMAP_PRIMARY_ARCHIVE_REF');
    const pinned=await request('/git/commits/'+evidence[key]);
    if(pinned.sha!==evidence[key])throw Error('OPSMAP_PRIMARY_ARCHIVE_REF');
  }
}

export function primaryOperationalEnv(env) {
  if(opsmapArchiveSite(env)!=='primary')return null;
  const credentials=resolveProductionCredentials(env), write=opsmapArchiveWriteApproved(env);
  const receive=env.OPSMAP_PRIMARY_CLOCK_SECRET;
  if(env.OPSMAP_AUTH_ORIGIN!==PRIMARY_ORIGIN||!credentials.authToken||!credentials.sessionSecret||
      !(env.OPSMAP_AUTH_ID||env.MAP_STAFF_ID)||!(env.OPSMAP_AUTH_PASSWORD_HASH||env.MAP_STAFF_PASSWORD_HASH)) {
    throw Error('OPSMAP_PRIMARY_AUTH_REQUIRED');
  }
  if(write&&(typeof receive!=='string'||receive.length<32||receive.length>512||
      !/^\d{1,30}$/.test(env.OPSMAP_PRIMARY_CLOCK_TRIGGER_ID||'')||
      !/^[a-f0-9]{64}$/.test(env.OPSMAP_PRIMARY_CLOCK_EXECUTOR_SHA256||'')||
      receive===env.OPSMAP_STAGE_SYNC_SCHEDULER_SECRET||
      env.OPSMAP_PRIMARY_ARCHIVE_WRITE_TOKEN===env.OPSMAP_PRIMARY_ARCHIVE_READ_TOKEN))throw Error('OPSMAP_PRIMARY_CLOCK_CONFIG');
  return {...env,
    MAP_STAFF_ID:env.OPSMAP_AUTH_ID||env.MAP_STAFF_ID,
    MAP_STAFF_PASSWORD_HASH:env.OPSMAP_AUTH_PASSWORD_HASH||env.MAP_STAFF_PASSWORD_HASH,
    MAP_STAFF_SESSION_SECRET:credentials.sessionSecret,MAP_STAFF_ORIGIN:PRIMARY_ORIGIN,
    MAP_STAFF_IDLE_HOURS:env.OPSMAP_AUTH_IDLE_HOURS||'24',MAP_STAFF_MAX_HOURS:env.OPSMAP_AUTH_MAX_HOURS||'168',
    GITHUB_TOKEN:credentials.authToken,GITHUB_CACHE_REPO:env.OPSMAP_AUTH_STORE_REPO,
    OPSMAP_MANUAL_PIN_GITHUB_BRANCH:env.OPSMAP_AUTH_STORE_BRANCH,OPSMAP_PRODUCTION_SESSION_ENABLED:'1',
    OPSMAP_SNAPSHOT_STORE_TOKEN:env.OPSMAP_PRIMARY_ARCHIVE_READ_TOKEN,
    OPSMAP_SHADOW_GITHUB_READ_TOKEN:env.OPSMAP_PRIMARY_ARCHIVE_READ_TOKEN,
    OPSMAP_STAGE_SYNC_READ_TOKEN:env.OPSMAP_PRIMARY_ARCHIVE_READ_TOKEN,
    OPSMAP_STAGE_SYNC_WRITE_TOKEN:write?env.OPSMAP_PRIMARY_ARCHIVE_WRITE_TOKEN:undefined,
    OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_WRITE_TOKEN:write?env.OPSMAP_PRIMARY_ARCHIVE_WRITE_TOKEN:undefined,
    OPSMAP_STAGE_SYNC_USE_SNAPSHOT_WRITER:'0',OPSMAP_STAGE_FIXED_MASTER_SOURCE:'excel',
    OPSMAP_STAGE_SYNC_REMOTE_APPROVED:'1',OPSMAP_STAGE_SYNC_READ_APPROVED:'1',
    OPSMAP_STAGE_FIXED_MASTER_SYNC_APPROVED:'1',OPSMAP_STAGE_NATIONAL_REGISTRY_APPROVED:'1',
    OPSMAP_STAGE_SYNC_EXECUTION_OWNER:'render',OPSMAP_STAGE_SYNC_DURABLE_DISABLED:'0',
    OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED:write?'1':'0',OPSMAP_STAGE_SYNC_PUBLISH_APPROVED:write?'1':'0'
  };
}

export function primaryMapDispatch(operationalApp) {
  return (req,res,next)=>{
    const original=req.path, path=original.replace(/^\/opsmap(?=\/api\/)/,'');
    // These handlers keep the pre-existing Production session, pin-write and photo rules.
    if(/^\/api\/map-phase2b\/private\/(?:manual-pins|delivery-photos)(?:\/|$)/.test(path)){
      if(path===original)req.url='/opsmap'+req.url;
      return next();
    }
    if(/^\/opsmap(?:\/|$)/.test(original)||/^\/api\/map-phase2b(?:\/|$)/.test(path)||
        path==='/api/vehicle-driver-master'||path==='/api/health'||
        /^\/internal\/opsmap\/scheduled-sync(?:\/|$)/.test(path)){
      const originalUrl=req.url;
      if(path!==original)req.url=req.url.replace(/^\/opsmap/,'');
      return operationalApp(req,res,error=>{req.url=originalUrl;next(error);});
    }
    return next();
  };
}

export async function createPrimaryOperationalMap({env=process.env,fetchImpl=fetch}={}) {
  const operational=primaryOperationalEnv(env);
  if(!operational)return null;
  try {
    if(!stageVerifiedBaselineConfig(operational))throw Error('BASELINE_REQUIRED');
    stageOpsmapDurableStorage({env:operational,fetchImpl});
  } catch { throw Error('OPSMAP_PRIMARY_ARCHIVE_KEY_OR_BASELINE'); }
  if(primaryPreservationEvidence(operational)?.legacyRegistryHeldInArchive===1){
    try{
      if(!(await readApprovedOsanRegistryRecoveryManifest({env:operational}))?.held)throw Error('RECOVERY_MANIFEST_MISSING');
    }catch{throw Error('OPSMAP_PRIMARY_RECOVERY_MANIFEST');}
  }
  await checkArchiveBaselines(operational,fetchImpl);
  const [{createStageVerificationApp,createStageSyncReaders},{createStageShadowRuntime},{createStageWmsDispatchExportReader}]=
    await Promise.all([import('./stageVerificationEntry.js'),import('./shadowCoverage/stageArchive.js'),import('./opsmapWmsDispatchExport.js')]);
  const syncReaders=createStageSyncReaders({env:operational,fetchImpl});
  if(!syncReaders.nationalRegistry||!syncReaders.recentOperations)throw Error('OPSMAP_PRIMARY_ARCHIVE_READERS');
  const shadow=createStageShadowRuntime(operational,{fetchImpl});
  const readWmsExport=createStageWmsDispatchExportReader({env:operational,fetchImpl});
  const sessions=createProductionStaffSessionStore({env:operational,fetchImpl});
  const budget=createProductionRoadBudget({env,token:operational.GITHUB_TOKEN,fetchImpl});
  const {pinToken}=resolveProductionCredentials(env);
  const geocodeBudget=env.OPSMAP_PIN_STORE_REPO&&pinToken?
    createProductionGeocodeBudgetGithubStore({repo:env.OPSMAP_PIN_STORE_REPO,token:pinToken,
      branch:env.OPSMAP_PIN_STORE_BRANCH,fetchImpl}):null;
  const roadRouteService=createRoadRouteService({env:{...env,OPSMAP_ROAD_ROUTE_ENABLED:productionRoadRouteFlag(env)},
    budget,requireDurableBudget:true,fetchImpl});
  return createStageVerificationApp({env:shadow.env,fetchImpl,syncReaders,readWmsExport,
    readShadowDirectory:shadow.configured?shadow.readDirectory:undefined,
    primaryServices:{sessions,roadRouteService,geocodeBudget}});
}
