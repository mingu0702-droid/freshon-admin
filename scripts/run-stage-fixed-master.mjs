import {createHash} from 'node:crypto';
import {opsmapScheduleConfig, verifyOpsmapScheduleReceipt} from '../src/opsmapScheduledRun.js';
import {
  createStageFixedMasterSource,stageFixedMasterSyncEnabled,FIXED_MASTER_SCOPE_INPUT_LIMIT
} from '../src/stageFixedMasterSync.js';
import {verifyStageScheduledTask} from '../src/stageScheduledJobs.js';
import {runStageFixedMaster} from '../src/stageFixedMasterWorker.js';

const env = process.env;

async function readInput(limit) {
  let input='';
  for await(const chunk of process.stdin){
    input+=chunk;
    if(Buffer.byteLength(input)>limit)throw Error('OPSMAP_SCHEDULE_RECEIPT');
  }
  return JSON.parse(input);
}

async function run() {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length || !['probe-source', 'verify-source', 'scheduled', 'scheduled-task', 'recover'].includes(mode)) {
    throw Error('FIXED_MASTER_INDEPENDENT_USAGE');
  }
  if (!stageFixedMasterSyncEnabled(env)) throw Error('FIXED_MASTER_STAGE_SOURCE_SCOPE');
  if (!env.FRESHON_COOKIE && !(env.FRESHON_ID && env.FRESHON_PASSWORD)) {
    throw Error('FIXED_MASTER_AUTH_REQUIRED');
  }
  if(mode==='scheduled-task'){
    if(env.OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED!=='1')throw Error('OPSMAP_SCHEDULE_SOURCE_CONFIG');
    const job=await readInput(FIXED_MASTER_SCOPE_INPUT_LIMIT);
    const receipt=verifyStageScheduledTask(job,opsmapScheduleConfig(env).secret);
    if(job.scheduledKind!=='fixed') throw Error('OPSMAP_JOBS_TASK_AUTH');
    const result=await runStageFixedMaster({env,receipt,scope:job.fixedScope});
    console.info(JSON.stringify({component:'opsmap-stage-job-result',runId:receipt.runId,job:'fixed',state:result.state}));
    return;
  }
  let receipt;
  if (mode === 'scheduled') {
    if (env.OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED !== '1') throw Error('OPSMAP_SCHEDULE_SOURCE_CONFIG');
    receipt = verifyOpsmapScheduleReceipt(await readInput(2048), opsmapScheduleConfig(env));
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
  // The approved Stage writer can read that same private repository in recovery mode.
  const readEnv=mode==='recover'&&!env.OPSMAP_SNAPSHOT_STORE_TOKEN
    ? {...env,OPSMAP_SNAPSHOT_STORE_TOKEN:env.OPSMAP_STAGE_SYNC_WRITE_TOKEN}
    : env;
  const {readIndependentStageScopes}=await import('../src/stageIndependentSyncScope.js');
  const {fixedScope:scope}=await readIndependentStageScopes(readEnv);
  const result=await runStageFixedMaster({env,receipt,scope});
  if (!['PUBLISHED', 'VERIFIED_NOOP', 'ALREADY_VERIFIED'].includes(result.state)) {
    process.exitCode = 1;
  }
}

try {
  await run();
} catch (error) {
  const code = error.code || error.message;
  console.error(/^(?:FIXED_(?:MASTER|STORE)|OPSMAP_(?:SCHEDULE|DURABLE)|STAGE_(?:BASELINE|STAFF_REGISTRY))_[A-Z_]{1,70}$/.test(code)
    ? code : 'FIXED_MASTER_INDEPENDENT_FAILED');
  process.exitCode = 1;
}
