import {createHash} from 'node:crypto';
import {opsmapScheduleConfig, verifyOpsmapScheduleReceipt} from '../src/opsmapScheduledRun.js';
import {
  createStageFixedMasterSource, stageFixedMasterBaseline, stageFixedMasterStorage,
  stageFixedMasterSyncEnabled, syncStageFixedMaster
} from '../src/stageFixedMasterSync.js';
import {readIndependentStageScopes} from '../src/stageIndependentSyncScope.js';
import {createStageNationalRegistryStorage,createStageNationalRegistrationSource,scopedNationalRegistryMembership,
  stageNationalRegistryEnabled,syncStageNationalRegistry} from '../src/stageNationalRegistry.js';

const env = process.env;

async function recoverNational() {
  if (!stageNationalRegistryEnabled(env)||env.OPSMAP_STAGE_NATIONAL_REGISTRY_RECOVERY_APPROVED!=='1'||
      !env.OPSMAP_STAGE_SYNC_WRITE_TOKEN) throw Error('NATIONAL_REGISTRY_RECOVERY_APPROVAL');
  if (!env.FRESHON_COOKIE&&!(env.FRESHON_ID&&env.FRESHON_PASSWORD)) throw Error('NATIONAL_REGISTRY_AUTH_REQUIRED');
  const budget=env.OPSMAP_STAGE_NATIONAL_REGISTRY_RECOVERY_MAX_REQUESTS;
  const maxRequests=Number(budget);
  if(!/^\d{1,4}$/.test(budget??'')||maxRequests<1||maxRequests>1081)throw Error('NATIONAL_REGISTRY_RECOVERY_BUDGET');
  if(!env.OPSMAP_STAGE_NATIONAL_REGISTRY_CONTRACT_JSON)throw Error('NATIONAL_REGISTRY_SOURCE_CONTRACT');
  const store=createStageNationalRegistryStorage({env,write:true});
  if(!store)throw Error('NATIONAL_REGISTRY_RECOVERY_APPROVAL');
  const date=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  const runId=createHash('sha256').update('opsmap-stage-national-registry-recovery:'+date).digest('hex');
  const readEnv=env.OPSMAP_SNAPSHOT_STORE_TOKEN?env:{...env,OPSMAP_SNAPSHOT_STORE_TOKEN:env.OPSMAP_STAGE_SYNC_WRITE_TOKEN};
  const {registryScope,staffProjection}=await readIndependentStageScopes(readEnv,{nationalOnly:true});
  const {snapshot,meta}=staffProjection;
  const expected=meta.officialLocations;
  if(!expected||![expected.yeongnam,expected.honam].every(count=>Number.isSafeInteger(count)&&count>0)||
      snapshot.rows.filter(row=>row.verifiedLocation).length!==expected.yeongnam+expected.honam)
    throw Error('NATIONAL_REGISTRY_SCOPE_UNAVAILABLE');
  const membership=scopedNationalRegistryMembership(registryScope,snapshot.rows);
  let calls=0;
  const charge=()=>{
    if(calls>=maxRequests)throw Error('NATIONAL_REGISTRY_RECOVERY_BUDGET');
    calls++;
  };
  const readCenter=createStageNationalRegistrationSource({env,membership,
    fetchImpl(...args){charge();return fetch(...args);},
    async login(){
      const {config}=await import('../src/config.js');
      if(new URL(config.freshonBaseUrl).origin!=='https://mis.freshon.co.kr')throw Error('NATIONAL_REGISTRY_SOURCE_SCOPE');
      charge();
      return (await import('../src/scraper/freshonDailyRoute.js')).loginFreshonSession();
    }});
  let result;
  try {
    result=await syncStageNationalRegistry({store,receipt:{date,runId},readCenter,readOfficial:async()=>snapshot.rows});
  } finally {
    console.info(JSON.stringify({component:'opsmap-national-registry-operator-budget',runId,date,calls,maxRequests}));
  }
  console.info(JSON.stringify({component:'opsmap-national-registry-sync',runId,state:result.state,version:result.version,
    count:result.count,checkedAt:result.checkedAt,matchedByCenter:result.counts}));
  if(!['PUBLISHED','VERIFIED_NOOP','ALREADY_VERIFIED'].includes(result.state))process.exitCode=1;
}

async function run() {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length || !['probe-source', 'verify-source', 'scheduled', 'recover','recover-national'].includes(mode)) {
    throw Error('FIXED_MASTER_INDEPENDENT_USAGE');
  }
  if(mode==='recover-national')return recoverNational();
  if (!stageFixedMasterSyncEnabled(env)) throw Error('FIXED_MASTER_STAGE_SOURCE_SCOPE');
  if (!env.FRESHON_COOKIE && !(env.FRESHON_ID && env.FRESHON_PASSWORD)) {
    throw Error('FIXED_MASTER_AUTH_REQUIRED');
  }
  let receipt;
  if (mode === 'scheduled') {
    if (env.OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED !== '1') throw Error('OPSMAP_SCHEDULE_SOURCE_CONFIG');
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 2048) throw Error('OPSMAP_SCHEDULE_RECEIPT');
    }
    receipt = verifyOpsmapScheduleReceipt(JSON.parse(input), opsmapScheduleConfig(env));
  }
  if (mode === 'recover') {
    // An explicitly enabled Stage operator run has its own idempotency key.
    // It never impersonates the Apps Script trigger or replays an old receipt.
    if (env.OPSMAP_STAGE_FIXED_MASTER_RECOVERY_APPROVED !== '1' || !env.OPSMAP_STAGE_SYNC_WRITE_TOKEN) {
      throw Error('FIXED_MASTER_RECOVERY_APPROVAL');
    }
    const date = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const runId = createHash('sha256').update('opsmap-stage-fixed-master-recovery:' + date).digest('hex');
    receipt = {date, runId};
  }
  const runId = receipt?.runId ?? null;
  const onScan = evidence => console.info(JSON.stringify({
    component: 'opsmap-fixed-master-pages', runId, ...evidence
  }));
  const onPage = evidence => console.info(JSON.stringify({
    component: 'opsmap-fixed-master-page-progress', runId, ...evidence
  }));
  const onPreflight = evidence => console.info(JSON.stringify({
    component: 'opsmap-fixed-master-center-preflight', runId, ...evidence
  }));
  if (mode === 'probe-source' || mode === 'verify-source') {
    const preflightOnly=mode==='probe-source';
    const result=await createStageFixedMasterSource({env,onScan,onPage,onPreflight,preflightOnly})();
    console.info(JSON.stringify({component:'opsmap-fixed-master-sync',state:preflightOnly?result.state:'SOURCE_VERIFIED'}));
    return;
  }
  const store = stageFixedMasterStorage({env, write: true});
  // The approved Stage writer can read that same private repository in recovery mode.
  const readEnv=mode==='recover'&&!env.OPSMAP_SNAPSHOT_STORE_TOKEN
    ? {...env,OPSMAP_SNAPSHOT_STORE_TOKEN:env.OPSMAP_STAGE_SYNC_WRITE_TOKEN}
    : env;
  const {fixedScope:scope} = await readIndependentStageScopes(readEnv);
  const baseline = stageFixedMasterBaseline({env, store});
  const result = await syncStageFixedMaster({
    store, receipt, scope, readMaster: createStageFixedMasterSource({env, onScan, onPage, onPreflight}),
    loadBaseline: baseline.load
  });
  console.info(JSON.stringify({component: 'opsmap-fixed-master-sync', ...result}));
  if (!['PUBLISHED', 'VERIFIED_NOOP', 'ALREADY_VERIFIED'].includes(result.state)) {
    process.exitCode = 1;
  }
}

try {
  await run();
} catch (error) {
  const code = error.code || error.message;
  console.error(/^(?:FIXED_(?:MASTER|STORE)|NATIONAL_REGISTRY|OPSMAP_(?:SCHEDULE|DURABLE)|STAGE_(?:BASELINE|STAFF_REGISTRY))_[A-Z_]{1,70}$/.test(code)
    ? code : 'FIXED_MASTER_INDEPENDENT_FAILED');
  process.exitCode = 1;
}
