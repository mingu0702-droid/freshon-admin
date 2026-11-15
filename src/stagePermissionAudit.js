import {STAGE_ORIGIN,STAGE_SERVICE} from './stageScope.js';

const keys=[
  'OPSMAP_STAGE_DELIVERY_DATED_ENABLED','OPSMAP_STAGE_DELIVERY_DATED_REUSE_APPROVED','OPSMAP_STAGE_DELIVERY_DATED_COOKIE',
  'OPSMAP_STAGE_DELIVERY_PHOTO_AUTH_ENABLED','OPSMAP_STAGE_DELIVERY_PHOTO_USE_EXISTING_ADMIN',
  'OPSMAP_STAGE_DELIVERY_PHOTO_ID','OPSMAP_STAGE_DELIVERY_PHOTO_PASSWORD','DELIVERY_ADMIN_ID','DELIVERY_ADMIN_PASSWORD',
  'OPSMAP_STAGE_DELIVERY_DATED_VERIFIED_SOURCE_IDS','OPSMAP_PRIVATE_READER_URL','OPSMAP_PRIVATE_READER_SECRET',
  'OPSMAP_PRIVATE_READER_ENABLED','OPSMAP_SYNC_SOURCE_READ_APPROVED','FRESHON_COOKIE','FRESHON_ID','FRESHON_PASSWORD',
  'GITHUB_TOKEN','OPSMAP_SNAPSHOT_STORE_TOKEN','OPSMAP_SHADOW_GITHUB_READ_TOKEN','OPSMAP_STAGE_SYNC_READ_TOKEN',
  'OPSMAP_STAGE_SYNC_WRITE_TOKEN','OPSMAP_STAGE_SYNC_USE_SNAPSHOT_WRITER','OPSMAP_SHADOW_ARCHIVE_KEY_B64',
  'OPSMAP_STAGE_SYNC_JOB_SETTINGS_FILE','OPSMAP_STAGE_SYNC_TRIGGER_ID','OPSMAP_STAGE_SYNC_EXECUTOR_SHA256','OPSMAP_STAGE_SYNC_SCHEDULER_SECRET',
  'OPSMAP_STAGE_SYNC_READ_APPROVED','OPSMAP_STAGE_SYNC_REMOTE_APPROVED','OPSMAP_STAGE_SYNC_PUBLISH_APPROVED','OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED',
  'OPSMAP_STAGE_DRIVER_GOOGLE_SERVICE_ACCOUNT_FILE','OPSMAP_STAGE_DRIVER_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64',
  'OPSMAP_STAGE_KAKAO_MOBILITY_REST_API_KEY','OPSMAP_STAGE_ROAD_BUDGET_STORE_TOKEN'
];
const repository='https://api.github.com/repos/mingu0702-droid/freshon-cache';
const stageSnapshot=repository+'/contents/opsmap-stage/map-snapshot-v1.json?ref=stage%2Fopsmap-snapshots';
const date='2026-11-14';
const safeCode=error=>/^[A-Z_]{3,72}$/.test(error?.code || '')?error.code:'READ_PROBE_UNAVAILABLE';

export async function stagePermissionAudit({env,probeCenterRead,fetchImpl=fetch}) {
  if (env.RENDER_EXTERNAL_URL!==STAGE_ORIGIN||env.RENDER_SERVICE_ID!==STAGE_SERVICE) return null;
  const presence=Object.fromEntries(keys.map(key=>[key,typeof env[key]==='string'&&env[key].trim().length>0]));
  const centers=[];
  for (const center of ['osanColdStorage','yeongnam','honam']) {
    try { centers.push({center,...await probeCenterRead(date,center)}); }
    catch(error) { centers.push({center,state:'PROBE_FAILED',code:safeCode(error)}); }
  }
  const githubTokens=['OPSMAP_STAGE_SYNC_READ_TOKEN','OPSMAP_STAGE_SYNC_WRITE_TOKEN','OPSMAP_SNAPSHOT_STORE_TOKEN',
    'OPSMAP_SHADOW_GITHUB_READ_TOKEN','GITHUB_TOKEN'].filter(key=>presence[key]);
  const github=[];
  for (const key of githubTokens) {
    try {
      const options={method:'GET',redirect:'error',signal:AbortSignal.timeout(7000),
        headers:{Authorization:'Bearer '+env[key],Accept:'application/vnd.github+json','User-Agent':'opsmap-stage-permission-audit'}};
      const repo=await fetchImpl(repository,options);
      if (repo.status!==200) {
        await repo.body?.cancel().catch(()=>{});
        github.push({key,repoHttp:repo.status});
        continue;
      }
      const info=await repo.json();
      const permission=typeof info.permissions?.push==='boolean'?info.permissions.push:null;
      const snapshot=info.private===true?await fetchImpl(stageSnapshot,options):null;
      await snapshot?.body?.cancel().catch(()=>{});
      github.push({key,repoHttp:200,privateRepo:info.private===true,reportedPushPermission:permission,snapshotHttp:snapshot?.status??null});
    } catch(error) { github.push({key,code:safeCode(error)}); }
  }
  return {component:'opsmap-stage-permission-audit',date,presence,centers,github};
}
