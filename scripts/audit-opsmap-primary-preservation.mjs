import {createHash} from 'node:crypto';
import {readIndependentStageScopes} from '../src/stageIndependentSyncScope.js';
import {createProductionSnapshotStore} from '../src/productionSnapshotStore.js';
import {createCustomerRegistryStorage} from '../src/customerRegistryStorage.js';
import {validateCustomerRegistryState} from '../src/customerRegistry.js';
import {createStageNationalRegistryReader,createStageNationalRegistryStorage} from '../src/stageNationalRegistry.js';
import {createStageDailyFixedMasterReader,stageFixedMasterStorage,stageFixedMasterBaseline} from '../src/stageFixedMasterSync.js';
import {PRIMARY_ORIGIN,PRIMARY_SERVICE,STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageScope.js';

const repo='mingu0702-droid/freshon-cache';
const readToken=process.env.OPSMAP_SNAPSHOT_STORE_TOKEN;
const stage={...process.env,RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN,
  OPSMAP_STAGE_FIXED_MASTER_SYNC_APPROVED:'1',OPSMAP_STAGE_SYNC_REMOTE_APPROVED:'1',OPSMAP_STAGE_NATIONAL_REGISTRY_APPROVED:'1'};
const production={RENDER_SERVICE_ID:PRIMARY_SERVICE,RENDER_EXTERNAL_URL:PRIMARY_ORIGIN,
  OPSMAP_SNAPSHOT_STORE_ENABLED:'1',OPSMAP_SNAPSHOT_STORE_REPO:repo,OPSMAP_SNAPSHOT_STORE_BRANCH:'production/opsmap-snapshots'};
const branches={operationsArchive:'stage/opsmap-snapshots',wmsArchive:'stage/opsmap-wms-exports',
  legacySnapshotArchive:'production/opsmap-snapshots',legacyAuthArchive:'production/opsmap-auth',
  legacyPinsArchive:'production/opsmap-manual-pins',stagePinsArchive:'stage/opsmap-manual-pins'};

async function refs(){
  const get=async path=>{
    const response=await fetch('https://api.github.com/repos/'+repo+path,{redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Authorization:'Bearer '+readToken,Accept:'application/vnd.github+json','User-Agent':'opsmap-preservation-audit'}});
    if(response.status===404&&path.includes('/git/ref/'))return null;
    if(!response.ok)throw Error('OPSMAP_PRIMARY_ARCHIVE_UNAVAILABLE');
    return response.json();
  };
  if((await get('')).private!==true)throw Error('OPSMAP_PRIMARY_ARCHIVE_NOT_PRIVATE');
  return Object.fromEntries(await Promise.all(Object.entries(branches).map(async([name,branch])=>{
    const ref=await get('/git/ref/heads/'+branch);
    return [name,ref?.object?.sha||null];
  })));
}

async function manualPins(directory,ref){
  if(!/^[a-f0-9]{40}$/.test(ref||''))throw Error('OPSMAP_PRIMARY_PIN_REF');
  const url='https://api.github.com/repos/'+repo+'/contents/'+directory+'/manual-pins-v1.json?ref='+ref;
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000),
    headers:{Authorization:'Bearer '+readToken,Accept:'application/vnd.github+json','User-Agent':'opsmap-preservation-audit'}});
  if(!response.ok)throw Error('OPSMAP_PRIMARY_PIN_READ');
  const blob=await response.json();
  if(blob.encoding!=='base64'||typeof blob.content!=='string')throw Error('OPSMAP_PRIMARY_PIN_FORMAT');
  const raw=Buffer.from(blob.content,'base64');
  const sha=createHash('sha1').update('blob '+raw.length+'\0').update(raw).digest('hex');
  if(sha!==blob.sha||raw.length>512000)throw Error('OPSMAP_PRIMARY_PIN_INTEGRITY');
  const ledger=JSON.parse(raw).manualPins;
  if(ledger?.schema!==1||!ledger.customers||Array.isArray(ledger.customers)||typeof ledger.customers!=='object')
    throw Error('OPSMAP_PRIMARY_PIN_FORMAT');
  return ledger.customers;
}

function samePin(left,right){
  return !!left&&!!right&&/^[a-f0-9]{64}$/.test(left.originalAddressHash||'')&&
    left.originalAddressHash===right.originalAddressHash&&Number.isFinite(left.latitude)&&Number.isFinite(left.longitude)&&
    left.latitude===right.latitude&&left.longitude===right.longitude;
}

try{
  const before=await refs();
  const store=stageFixedMasterStorage({env:stage});
  const [{fixedScope:scope},fixed,national,legacy,registry,stagePins,legacyPins]=await Promise.all([
    readIndependentStageScopes(stage),
    createStageDailyFixedMasterReader({store,baseline:stageFixedMasterBaseline({env:stage,store})}).load(),
    createStageNationalRegistryReader({store:createStageNationalRegistryStorage({env:stage})}).read(),
    createProductionSnapshotStore({env:production,token:readToken}).load(),
    createCustomerRegistryStorage({env:production,token:readToken}).readState(),
    manualPins('opsmap-stage',before.stagePinsArchive),
    manualPins('opsmap-production',before.legacyPinsArchive)
  ]);
  if(JSON.stringify(before)!==JSON.stringify(await refs()))throw Error('OPSMAP_PRIMARY_ARCHIVE_MOVED');
  if(!legacy||!national||!fixed)throw Error('OPSMAP_PRIMARY_ARCHIVE_UNAVAILABLE');
  if(registry)validateCustomerRegistryState(registry);

  const stageCodes=new Set(scope.codes), currentFixed=new Map(fixed.rows.map(row=>[row[0],row]));
  const tombstones=new Set(national.rows.filter(row=>row.lifecycle==='DELETED').map(row=>row.customerCode));
  const legacyRegistry=new Map((registry?.current?.rows||[]).map(row=>[row.customerCode,row]));
  const legacyRegistryCandidates=new Set([
    ...legacy.rows.map(row=>row.customerCode),
    ...[...legacyRegistry.values()].filter(row=>row.lifecycle!=='DELETED').map(row=>row.customerCode)
  ]);
  const missing=[...legacyRegistryCandidates].filter(code=>!stageCodes.has(code)&&
    legacyRegistry.get(code)?.lifecycle!=='DELETED'&&
    !(tombstones.has(code)&&legacyRegistry.get(code)?.lifecycle!=='ACTIVE'));
  const unmatchedLifecycle={ACTIVE:0,UNKNOWN:0,NOT_IN_REGISTRY:0};
  for(const code of missing){
    const state=legacyRegistry.get(code)?.lifecycle;
    unmatchedLifecycle[state==='ACTIVE'?'ACTIVE':state?'UNKNOWN':'NOT_IN_REGISTRY']++;
  }
  const legacyFixed=legacy.rows.filter(row=>row.baseVehicleState==='VERIFIED_MASTER'&&row.baseVehicleSource==='FIXED_DISPATCH_PRIMARY');
  const disagreements=legacyFixed.filter(row=>currentFixed.get(row.customerCode)?.[1]!==row.baseVehicle);
  const newer=disagreements.filter(row=>currentFixed.has(row.customerCode)&&
    Number.isFinite(Date.parse(row.baseVehicleCheckedAt))&&Date.parse(row.baseVehicleCheckedAt)<Date.parse(fixed.checkedAt));
  const currentStagePins=Object.entries(stagePins).filter(([,row])=>row.current);
  const stagePinsUnconfirmed=currentStagePins.filter(([code,row])=>!samePin(row.current,legacyPins[code]?.current)).length;
  const evidence={schema:1,destination:PRIMARY_ORIGIN,...before,
    legacyRegistryChecked:legacyRegistryCandidates.size,legacyFixedChecked:legacyFixed.length,
    legacyRegistryUnconfirmed:missing.length,
    legacyFixedUnconfirmed:disagreements.length-newer.length,
    legacyRegistryVerified:!!registry?.current,stagePinsUnconfirmed};
  const ready=evidence.legacyRegistryVerified&&evidence.legacyRegistryUnconfirmed===0&&evidence.legacyFixedUnconfirmed===0&&
    evidence.stagePinsUnconfirmed===0&&
    Object.values(before).every(ref=>/^[a-f0-9]{40}$/.test(ref||''));
  console.log(JSON.stringify({ready,stageRegistry:stageCodes.size,stageFixed:fixed.count,
    stageFixedVersion:fixed.version,legacySnapshotVersion:legacy.sha256,legacySnapshotRows:legacy.rowCount,
    legacySnapshotOnly:legacy.rows.filter(row=>!stageCodes.has(row.customerCode)).length,
    conflictsSupersededByLaterFreshon:newer.length,unmatchedLifecycle,
    currentStagePins:currentStagePins.length,currentLegacyPins:Object.values(legacyPins).filter(row=>row.current).length,evidence}));
  if(!ready)process.exitCode=2;
}catch(error){
  const code=error.code||error.message;
  console.error(/^[A-Z][A-Z_0-9]{1,100}$/.test(code)?code:'OPSMAP_PRIMARY_PRESERVATION_FAILED');
  process.exitCode=1;
}
