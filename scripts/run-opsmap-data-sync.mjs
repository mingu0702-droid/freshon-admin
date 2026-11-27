import {createOfficialAddressLookup} from '../src/opsmapOfficialAddressLookup.js';
import {openPublicAddressCatalog} from '../src/opsmapPublicAddressCatalog.js';
import {completeFixedCoordinates, completeFixedCoordinatesFromCatalog} from '../src/fixedCoordinateCompletion.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {createCustomerRegistry} from '../src/customerRegistry.js';
import {readFixedCoordinateLedger} from '../src/fixedStoreCoordinates.js';
import {createOpsmapDataSync, startOpsmapDataSync} from '../src/opsmapDataSync.js';
import {callHub} from '../src/opsmap-abc/phase2bHubReadClient.js';
import {privateReaderEndpoint} from '../src/opsmap-abc/privateReaderEndpoint.js';
import {createManualMapPins} from '../src/opsmap-abc/manualMapPins.js';
import {opsmapArchiveSite,opsmapArchiveWriteApproved} from '../src/stageScope.js';
import {createStageDatedDeliveryReader} from '../src/stageDatedDelivery.js';
import {createStageRecentOrdersReader} from '../src/stageRecentOrders.js';
import {boundedRead, privateCoverageDirectory} from '../src/shadowCoverage/coverageFiles.js';
import {atomicCoverageWrite} from '../src/shadowCoverage/fileStore.js';
import {checkStageVerifiedBaseline,createOpsmapDurableGeneration,stageOpsmapDurableStorage,stageVerifiedBaselineConfig} from '../src/opsmapDurableGeneration.js';
import {claimQueuedOpsmapSchedule,independentStageSync,opsmapScheduleConfig,publishOpsmapScheduledRun,
  verifyOpsmapScheduleReceipt} from '../src/opsmapScheduledRun.js';
import {verifyStageScheduledTask,stageWmsNightDate} from '../src/stageScheduledJobs.js';
import {readIndependentStageScopes} from '../src/stageIndependentSyncScope.js';
import {STAGE_OSAN_SYNC_CENTERS,STAGE_OSAN_SYNC_SOURCE_IDS,SYNC_DELIVERY_SOURCES} from '../src/opsmapSyncPolicy.js';
import {createStageDailyFixedMasterReader,FIXED_MASTER_SCOPE_INPUT_LIMIT,stageFixedMasterBaseline,stageFixedMasterStorage,stageFixedMasterSyncEnabled} from '../src/stageFixedMasterSync.js';
import {runStageFixedMaster} from '../src/stageFixedMasterWorker.js';
import {createStageStaffRegistryAsset} from '../src/stageStaffRegistryAsset.js';
import {createStageWmsDispatchExportReader} from '../src/opsmapWmsDispatchExport.js';
import {createStageNationalRegistryStorage,createStageNationalRegistrationSource,stageNationalRegistryEnabled,
  createStageNationalRegistryReader,readApprovedOsanRegistryRecovery,readApprovedOsanRegistryRecoveryManifest,
  readStageNationalRegistryRows,scopedNationalRegistryMembership,
  syncStageNationalRegistry,verifiedNationalRegistryMembership} from '../src/stageNationalRegistry.js';
import {createStageRecentOperationsSeed,createStageRecentOperationsStore,historicalRecoveryOutcome,stageRecentOperationsSyncEnabled,
  syncStageRecentOperations} from '../src/stageRecentOperations.js';
import {recentOperationsBaseline} from '../src/stageRecentOperationsManifest.js';
import {planStageNightOrderExclusions,stageNightOrderScope} from '../src/stageNightOrderScope.js';

const appRoot = fileURLToPath(new URL('../',import.meta.url));
const env = process.env;

function report(result) {
  console.log(JSON.stringify({component:'opsmap-data-sync',state:result.state,revision:result.revision ?? null,
    generation:result.generation ?? null,runId:result.runId??null,observedToday:result.observedToday===true,
    sourceReadComplete:result.sourceReadComplete===true,lastSuccessAt:result.lastSuccessAt ?? result.completedAt ?? null}));
}

async function buildWorker({mode,settingsFile,durable,recordSource}) {
  const settingsRoot = await privateCoverageDirectory(path.dirname(settingsFile),appRoot);
  const readSettings = async () => JSON.parse(await boundedRead(path.join(settingsRoot,path.basename(settingsFile)),32_768));
  const config = await readSettings();
  if(durable && path.isAbsolute(config.directory || '')){
    const parent=await privateCoverageDirectory(path.dirname(config.directory),appRoot);
    const spool=path.join(parent,path.basename(config.directory));
    try {await fs.mkdir(spool,{mode:0o700});}
    catch(error) {if(error.code!=='EEXIST'||(await fs.lstat(spool)).isSymbolicLink())throw error;}
  }
  const directory = await privateCoverageDirectory(config.directory,appRoot);
  if (!durable && !path.isAbsolute(config.ledgerFile || '')) throw Error('OPSMAP_SYNC_LEDGER_PATH');
  const ledgerFolder = !durable ? await privateCoverageDirectory(path.dirname(config.ledgerFile),appRoot) : null;
  let readRegistry, readDay, readManualPins;
  if (mode !== 'bootstrap' && (!opsmapArchiveSite(env) || !opsmapArchiveWriteApproved(env) ||
      env.OPSMAP_SYNC_SOURCE_READ_APPROVED !== '1')) {
    throw Error('OPSMAP_SYNC_SOURCE_APPROVAL_REQUIRED');
  }
  if (durable) {
    if (Object.keys(config.deliveryCenters || {}).length!==1 || config.deliveryCenters?.osan!==STAGE_OSAN_SYNC_CENTERS.osan) {
      throw Error('DELIVERY_SOURCE_CENTER_CONFIG');
    }
    if (!Array.isArray(config.deliveryVerifiedSourceIds) || config.deliveryVerifiedSourceIds.length!==1 ||
        config.deliveryVerifiedSourceIds[0]!==STAGE_OSAN_SYNC_SOURCE_IDS[0]) {
      throw Error('DELIVERY_SOURCE_ENTITLEMENT_UNVERIFIED');
    }
    const delivery = createStageDatedDeliveryReader({env,syncCenters:STAGE_OSAN_SYNC_CENTERS,recordSource});
    if (!delivery.configured) throw Error('DELIVERY_SOURCE_SESSION_REQUIRED');
    readDay = delivery.readObservation;
    const restored = await durable.restoreSpool(directory);
    if (!restored) {
      const baselineConfig=stageVerifiedBaselineConfig(env);
      if (!baselineConfig) throw Error('OPSMAP_OSAN_BASELINE_REQUIRED');
      const store=createOpsmapDurableGeneration({...stageOpsmapDurableStorage({env,baselineKey:baselineConfig.baselineKey}),appRoot});
      try {
        checkStageVerifiedBaseline(await store.readBaseline(baselineConfig.ref));
        await store.restoreSpool(directory,{useVerifiedBaseline:true});
      } finally { await store.dispose().catch(()=>{}); }
    }
    return createOpsmapDataSync({directory,readDay,appRoot,readMissingDay:durable.readDay,osanOnly:true});
  }
  if (mode !== 'bootstrap') {
    const protectedHub = privateReaderEndpoint('customerRegistry');
    if (!protectedHub.isolated || protectedHub.url === env.HUB_API_URL || protectedHub.secret === env.HUB_API_SECRET) throw Error('OPSMAP_SYNC_HUB_SCOPE');
    const stateFile = path.join(directory,'registry-checkpoint.private.json');
    const registry = createCustomerRegistry({callHub,
      async readState() {
        try {return JSON.parse(await boundedRead(stateFile,12*1024*1024));}
        catch(error) {if(error.code==='ENOENT')return null;throw error;}
      },
      writeState:value => atomicCoverageWrite(stateFile,JSON.stringify(value))});
    readRegistry = async () => {
      try {
        const status = await registry.refresh({maxPages:36,deadline:Date.now()+180_000});
        if (!['UPDATED','NOOP'].includes(status.phase)) throw Error('OPSMAP_SYNC_REGISTRY_INCOMPLETE');
        const snapshot=await registry.read();
        recordSource?.('customerRegistry');
        return snapshot;
      } catch(error) {
        recordSource?.('customerRegistry',null,error);
        throw error;
      }
    };
    const delivery = createStageDatedDeliveryReader({env,syncCenters:config.deliveryCenters,recordSource});
    if(!delivery.configured)throw Error('DELIVERY_SOURCE_SESSION_REQUIRED');
    readDay = delivery.readObservation;
    if (config.manualPinFile) {
      const folder = await privateCoverageDirectory(path.dirname(config.manualPinFile),appRoot);
      const file = await fs.realpath(path.join(folder,path.basename(config.manualPinFile)));
      if (path.dirname(file) !== folder) throw Error('OPSMAP_SYNC_MANUAL_PIN_PATH');
      let registryByCode;
      const manual = createManualMapPins({env:{OPSMAP_MANUAL_PIN_STORE_FILE:file},appRoot,async readCustomer(code) {
        const row = registryByCode.get(code);
        return row && {customerCode:code,address:row.basicAddress};
      }});
      const refreshRegistry = readRegistry;
      readRegistry = async () => {
        const snapshot = await refreshRegistry();
        registryByCode = new Map(snapshot.rows.map(row => [row.customerCode,row]));
        return snapshot;
      };
      readManualPins = () => manual.projection();
    }
  }
  let completeCoordinates;
  if (config.publicAddressCatalog || config.officialCoordinateIndex) {
    if (env.OPSMAP_SYNC_FIXED_COORDINATES_APPROVED!=='1') throw Error('OPSMAP_SYNC_COORDINATE_APPROVAL_REQUIRED');
    let index, indexKey;
    completeCoordinates=async options=>{
      const settings=await readSettings();
      if (config.publicAddressCatalog) {
        const catalog = settings.publicAddressCatalog;
        const key = JSON.stringify(catalog);
        if (key !== indexKey) {
          index = await openPublicAddressCatalog(catalog, {appRoot});
          indexKey = key;
        }
        return completeFixedCoordinatesFromCatalog(options,index);
      }
      const {file,sha256}=settings.officialCoordinateIndex||{};
      if (!path.isAbsolute(file||'')) throw Error('OPSMAP_SYNC_OFFICIAL_INDEX_PATH');
      const key=file+'|'+sha256;
      if(key!==indexKey){
        const folder=await privateCoverageDirectory(path.dirname(file),appRoot);
        const actual=await fs.realpath(path.join(folder,path.basename(file)));
        if(path.dirname(actual)!==folder) throw Error('OPSMAP_SYNC_OFFICIAL_INDEX_PATH');
        const checked=createOfficialAddressLookup(await boundedRead(actual,512*1024),{sha256});
        index=checked;indexKey=key;
      }
      return completeFixedCoordinates({...options,index});
    };
  }
  const readLedger = async () => {
    const updated = await readSettings();
    if (updated.directory !== config.directory || updated.ledgerFile !== config.ledgerFile) throw Error('OPSMAP_SYNC_STORAGE_CHANGED');
    return readFixedCoordinateLedger(await boundedRead(path.join(ledgerFolder,path.basename(config.ledgerFile)),8*1024*1024),updated.ledgerSha256);
  };
  return createOpsmapDataSync({directory,seed:config.seed,readLedger,readRegistry,readDay,readManualPins,appRoot,completeCoordinates});
}

async function readScheduledInput() {
  let input='';
  for await (const chunk of process.stdin) {
    input+=chunk;
    if (Buffer.byteLength(input)>FIXED_MASTER_SCOPE_INPUT_LIMIT) throw Error('OPSMAP_SCHEDULE_RECEIPT');
  }
  const job=JSON.parse(input);
  const config=opsmapScheduleConfig(env);
  const receipt=job.scheduledKind?verifyStageScheduledTask(job,config.secret):
    verifyOpsmapScheduleReceipt(job?.receipt??job,config);
  return {...job,receipt};
}

function scheduledQueueRunner() {
  if (!independentStageSync(env) || env.OPSMAP_STAGE_SYNC_RUNNER_APPROVED!=='1')
    throw Error('OPSMAP_SCHEDULE_RUNNER_NOT_APPROVED');
  const store=stageFixedMasterStorage({env,write:true});
  const settingsFile=env.OPSMAP_STAGE_SYNC_JOB_SETTINGS_FILE || null;
  if (settingsFile && !path.isAbsolute(settingsFile)) throw Error('OPSMAP_SYNC_USAGE');
  const config=opsmapScheduleConfig(env);
  return {
    claim:()=>claimQueuedOpsmapSchedule({store,config,prepare:()=>readIndependentStageScopes(env)}),
    async execute({receipt,input}) {
      await runScheduled({...input,receipt},settingsFile);
      console.log(JSON.stringify({component:'opsmap-independent-run',state:'WORKER_EXITED',runId:receipt.runId}));
    }
  };
}

async function watchScheduledQueue(runner) {
  let handledDate=null;
  while (true) {
    const kst=new Date(Date.now()+9*3600000).toISOString();
    const minute=Number(kst.slice(11,13))*60+Number(kst.slice(14,16));
    if (minute>=360 && minute<430 && handledDate!==kst.slice(0,10)) {
      let job;
      try {
        job=await runner.claim();
        if (job) {
          handledDate=job.receipt.date;
          await runner.execute(job);
        }
      } catch (error) {
        const code=error.code || error.message;
        console.log(JSON.stringify({component:'opsmap-independent-run',state:'FAILED',runId:job?.receipt.runId??null,
          error:/^(?:FIXED_(?:MASTER|STORE)|OPSMAP_(?:SCHEDULE|DURABLE)|STAGE_)_[A-Z_]{1,70}$/.test(code||'')?code:'OPSMAP_INDEPENDENT_FAILED'}));
      }
    }
    await sleep(60_000);
  }
}

async function run() {
  const [mode,settingsFile,...backfillDates] = process.argv.slice(2);
  if (mode==='watch-scheduled-queue' && settingsFile===undefined) return watchScheduledQueue(scheduledQueueRunner());
  if (mode==='run-scheduled-queue' && settingsFile===undefined) {
    const runner=scheduledQueueRunner(),job=await runner.claim();
    if (!job) throw Error('OPSMAP_SCHEDULE_DISPATCH_NOT_READY');
    return runner.execute(job);
  }
  if (!['bootstrap','once','watch','scheduled','fixed-scheduled'].includes(mode) ||
      (mode==='fixed-scheduled'?settingsFile!==undefined:!path.isAbsolute(settingsFile || ''))) throw Error('OPSMAP_SYNC_USAGE');
  if(mode==='scheduled'||mode==='fixed-scheduled'){
    if(env.OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED!=='1'||independentStageSync(env)||backfillDates.length)
      throw Error('OPSMAP_SCHEDULE_SOURCE_CONFIG');
    return runScheduled(await readScheduledInput(),settingsFile);
  }
  const worker=await buildWorker({mode,settingsFile});
  if (mode !== 'watch') {report(await worker.sync({bootstrap:mode==='bootstrap',backfillDates}));return;}
  if (backfillDates.length) throw Error('OPSMAP_SYNC_USAGE');
  const stop = startOpsmapDataSync(worker,{onResult:report});
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
}

async function runScheduled(job,settingsFile){
    const mode=settingsFile?'scheduled':'fixed-scheduled';
    const {receipt}=job;
    const fixedScope=job?.fixedScope;
    const verifiedChanges=env.OPSMAP_STAGE_NATIONAL_REGISTRY_VERIFIED_CHANGES_APPROVED==='1';
    async function readNightOrderScope() {
      const archive=createStageRecentOperationsStore({env});
      const saved=await archive?.read().catch(()=>null);
      return stageNightOrderScope(saved?.ledger,receipt.date);
    }
    async function refreshExclusions(orderScope,codes) {
      if(!orderScope.allDaysVerified)return new Set();
      const manifest=await readApprovedOsanRegistryRecoveryManifest({env}).catch(()=>null);
      if(!manifest)return new Set();
      const review=planStageNightOrderExclusions(orderScope,codes,new Set(manifest.rows.map(([code])=>code)),
        env.OPSMAP_STAGE_NIGHT_ORDER_EXCLUSIONS_SHA256);
      if(review.reviewSha256)console.info(JSON.stringify({component:'opsmap-night-order-review',runId:receipt.runId,
        proposed:review.proposed,sha256:review.reviewSha256}));
      return review.skip;
    }
    const memory=phase=>{
      const {rss,heapUsed,external,arrayBuffers}=process.memoryUsage();
      console.log(JSON.stringify({component:'opsmap-stage-job-memory',runId:receipt.runId,
        phase,rss,heapUsed,external,arrayBuffers}));
    };
    const runNationalRegistry = async () => {
      if (!stageNationalRegistryEnabled(env)) return;
      const component='opsmap-national-registry-sync';
      try {
        const staff=createStageStaffRegistryAsset({env});
        if (!staff) throw Error('NATIONAL_REGISTRY_SCOPE_UNAVAILABLE');
        const {snapshot,meta}=await staff.read();
        const expected=meta.officialLocations;
        if (!expected || ![expected.yeongnam,expected.honam].every(count=>Number.isSafeInteger(count)&&count>0) ||
            snapshot.rows.filter(row=>row.verifiedLocation).length!==expected.yeongnam+expected.honam)
          throw Error('NATIONAL_REGISTRY_SCOPE_UNAVAILABLE');
        const membershipFor=async readRegistry=>{
          const recovered=await readApprovedOsanRegistryRecovery({env,readRegistry});
          return scopedNationalRegistryMembership(job?.registryScope,snapshot.rows,recovered);
        };
        const source=verifiedChanges?{
          async prepareSource(previous,ref){
            const membership=await membershipFor(async()=>({ref,rows:previous}));
            const orderScope=await readNightOrderScope();
            const selection=verifiedNationalRegistryMembership(membership,previous,{
              orderCustomersByCenter:orderScope.byCenter});
            selection.skipRefresh=await refreshExclusions(orderScope,[...selection.membership.keys()]);
            const readCenter=createStageNationalRegistrationSource({env,...selection});
            return {...selection,async readCenter(center){
              memory('REGISTRY_'+center.toUpperCase()+'_START');
              const result=await readCenter(center);
              memory('REGISTRY_'+center.toUpperCase()+'_END');
              return result;
            }};
          },
          async confirmCenterMoves(codes){
            if(env.OPSMAP_STAGE_FIXED_MASTER_SOURCE!=='excel')return new Map();
            try{
              const store=stageFixedMasterStorage({env});
              const daily=createStageDailyFixedMasterReader({store,baseline:stageFixedMasterBaseline({env,store})});
              const observation=await daily.readObservation(receipt.date,codes);
              if(observation?.meta.state!=='SCHEDULED_OBSERVATION'||observation.meta.runId!==receipt.runId)return new Map();
              return new Map(observation.data.filter(row=>row.baseVehicleState==='VERIFIED_MASTER'||
                row.baseVehicleEmptyVerified===true).map(row=>[row.customerCode,row.baseVehicleGroup]));
            }catch{return new Map();}
          }
        }:{readCenter:createStageNationalRegistrationSource({env,membership:await membershipFor(()=>{
          const store=createStageNationalRegistryStorage({env});
          return createStageNationalRegistryReader({store})?.read();
        })})};
        const value=await syncStageNationalRegistry({store:createStageNationalRegistryStorage({env,write:true}),receipt,
          ...source,readOfficial:async()=>snapshot.rows});
        console.log(JSON.stringify({component,runId:receipt.runId,state:value.state,count:value.count,
          checkedAt:value.checkedAt,matchedByCenter:value.counts,...(value.changes?{changes:value.changes}:{})}));
        return value;
      } catch(error) {
        const code=error.code || error.message || '';
        console.log(JSON.stringify({component,runId:receipt.runId,state:'FAILED',
          error:/^(?:NATIONAL_REGISTRY|FIXED_STORE)_[A-Z_]+$/.test(code)?code:'NATIONAL_REGISTRY_SOURCE_FAILED'}));
        if (job.scheduledKind||mode==='fixed-scheduled'&&!stageFixedMasterSyncEnabled(env)) throw error;
      }
    };
    const runFixedMaster = async () => {
      if (!stageFixedMasterSyncEnabled(env)) return;
      try {
        const skipRefresh=verifiedChanges&&fixedScope?
          await refreshExclusions(await readNightOrderScope(),fixedScope.codes):undefined;
        return await runStageFixedMaster({env,receipt,scope:fixedScope,skipRefresh});
      } catch(error) {
        const code=error.code || error.message || '';
        console.log(JSON.stringify({component:'opsmap-fixed-master-sync',runId:receipt.runId,state:'FAILED',
          error:/^FIXED_(?:MASTER|STORE)_[A-Z_]{1,70}$/.test(code)?code:'FIXED_MASTER_DAILY_FAILED'}));
        if (job.scheduledKind||mode==='fixed-scheduled') throw error;
      }
    };
    const runRecentOperations=async()=>{
      if (!stageRecentOperationsSyncEnabled(env)) return;
      const component='opsmap-recent-operations-sync';
      try {
        const readDelivery=env.OPSMAP_STAGE_RECENT_OPERATIONS_DELIVERY_APPROVED==='1' ?
          createStageDatedDeliveryReader({env,syncCenters:{osan:SYNC_DELIVERY_SOURCES.osan,
            yeongnam:SYNC_DELIVERY_SOURCES.yeongnam,honam:SYNC_DELIVERY_SOURCES.honam}}).readRecentOperations : null;
        const readOrders=createStageRecentOrdersReader({env,onDiagnostic:value=>console.info(JSON.stringify({
          component:'opsmap-recent-orders-source',runId:receipt.runId,...value
        }))});
        const deliveryDiagnostics=value=>console.info(JSON.stringify({
          component:'opsmap-recent-delivery-source',runId:receipt.runId,...value
        }));
        const readLatestDay=readDelivery||readOrders?async(date,deliveryCenters,orderCenters,onScopeDiagnostic)=>{
          const deliveries=readDelivery?await readDelivery(date,deliveryCenters,deliveryDiagnostics).catch(()=>[]):[];
          memory('AFTER_DELIVERY');
          const orders=readOrders?await readOrders(date,orderCenters,{onScopeDiagnostic}).catch(()=>[]):[];
          memory('AFTER_ORDERS');
          return [...deliveries,...orders];
        }:null;
        const autoRepair=env.OPSMAP_STAGE_RECENT_OPERATIONS_AUTO_REPAIR_APPROVED==='1';
        const approvedScopeLimit=env.OPSMAP_STAGE_RECENT_OPERATIONS_REPAIR_SCOPE_LIMIT;
        const recoveryScopeLimit=approvedScopeLimit===undefined?1:/^[1-3]$/.test(approvedScopeLimit)?Number(approvedScopeLimit):0;
        const recoverySources=[
          ...(readOrders?['freshon_orders']:[]),
          ...(readDelivery?['delivery_admin']:[])
        ];
        const readHistoricalScope=autoRepair?async({date,centerKey,source},signal)=>{
          const skip=new Set(['osan','yeongnam','honam'].filter(center=>center!==centerKey));
          let outcome;
          const capture=value=>{if(value.centerKey===centerKey)outcome=value.state;};
          const rows=source==='freshon_orders'?await readOrders(date,skip,{signal,allowLogin:false,onScopeDiagnostic:capture}):
            await readDelivery(date,skip,value=>{deliveryDiagnostics(value);capture(value);},signal);
          return {rows,state:historicalRecoveryOutcome(outcome)};
        }:undefined;
        const repair=/^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(env.OPSMAP_STAGE_RECENT_OPERATIONS_REPAIR_REQUEST||'');
        const repairDate=repair?.[2]===receipt.date?repair[1]:undefined;
        const retryDates=env.OPSMAP_STAGE_RECENT_OPERATIONS_RETRY_DATES?.split(',').map(date=>date.trim());
        const exportReader=createStageWmsDispatchExportReader({env});
        const noteNightDispatch=value=>console.info(JSON.stringify({
          component:'opsmap-freshon-night-dispatch',runId:receipt.runId,...value
        }));
        const readNightDispatch=opsmapArchiveSite(env)==='primary'&&opsmapArchiveWriteApproved(env)&&
          env.OPSMAP_STAGE_WMS_FRESHON_VALIDATION_APPROVED==='1'?async date=>{
            const {createStageNightDispatchArchive,collectStageNightDispatchRun,nightDispatchOperations,nightDispatchBaselineEnd}
              =await import('../src/stageNightDispatchArchive.js');
            if(date<=nightDispatchBaselineEnd){
              noteNightDispatch({date,state:'ALREADY_ARCHIVED'});
              return {scopes:[]};
            }
            try{
              const {config}=await import('../src/config.js');
              const origin='https://mis.freshon.co.kr';
              if(new URL(config.freshonBaseUrl).origin!==origin)throw Error('NIGHT_DISPATCH_AUTH_SCOPE');
              const {loginFreshonOverHttp}=await import('../src/scraper/freshonHttpSession.js');
              const {createStageFreshonNightDispatchReader}=await import('../src/stageFreshonNightDispatch.js');
              const read=createStageFreshonNightDispatchReader({login:({signal})=>
                loginFreshonOverHttp({origin,userId:config.freshonId,password:config.freshonPassword,signal})});
              const archive=createStageNightDispatchArchive({env,write:true});
              const {scopes,saveProgress}=await collectStageNightDispatchRun({date,archive,read,onCenter:noteNightDispatch});
              memory('AFTER_NIGHT_DISPATCH');
              return {scopes:nightDispatchOperations(scopes),saveProgress};
            }catch(error){
              const code=error?.code??error?.message;
              noteNightDispatch({date,state:'SOURCE_UNAVAILABLE',error:
                /^(?:NIGHT_DISPATCH|FIXED_STORE)_[A-Z_]+$/.test(code??'')?code:'NIGHT_DISPATCH_UNAVAILABLE'});
              return {scopes:[]};
            }
          }:undefined;
        const result=await syncStageRecentOperations({store:createStageRecentOperationsStore({env,write:true}),receipt,
          readLatestDay,readLatestDispatch:date=>exportReader?.(date).catch(()=>null),
          readNightDispatch,onNightDispatch:noteNightDispatch,
          retryDates,repairDate,readHistoricalScope,recoverySources,recoveryScopeLimit,
          readSeed:createStageRecentOperationsSeed({env,manifest:recentOperationsBaseline})});
        console.log(JSON.stringify({component,runId:receipt.runId,...result}));
        return result;
      } catch(error) {
        const code=error.code||error.message;
        console.log(JSON.stringify({component,runId:receipt.runId,state:'FAILED',
          error:/^(?:RECENT_OPERATIONS|FIXED_STORE)_[A-Z_]+$/.test(code||'')?code:'RECENT_OPERATIONS_SYNC_FAILED'}));
        if (job.scheduledKind||mode==='fixed-scheduled'&&!stageFixedMasterSyncEnabled(env)&&!stageNationalRegistryEnabled(env)) throw error;
      }
    };
    const runMasterJobs=async()=>{
      // Record the closed-day result before the slower master reads.
      try {await runRecentOperations();}
      finally {
        try {await runFixedMaster();}
        finally {await runNationalRegistry();}
      }
    };
    async function runWms(night=false){
      if(night&&env.OPSMAP_STAGE_WMS_NIGHT_SLOT_APPROVED!=='1')return {state:'SKIPPED'};
      const {syncStageFreshonWmsDispatch}=await import('../src/stageFreshonWmsWorkbookGate.js');
      const date=night?stageWmsNightDate(receipt):receipt.date;
      const verifyWindow=()=>{if(night)stageWmsNightDate(receipt);};
      return syncStageFreshonWmsDispatch({env,date,observedAt:new Date().toISOString(),reconcileExisting:night,
        fetchImpl:(...args)=>{verifyWindow();return fetch(...args);},
        login:async()=>{
          const {config}=await import('../src/config.js');
          if(new URL(config.freshonBaseUrl).origin!=='https://mis.freshon.co.kr')throw Error('WMS_EXPORT_FRESHON_SCOPE');
          const {loginFreshonSession}=await import('../src/scraper/freshonDailyRoute.js');
          verifyWindow();
          return loginFreshonSession();
        }});
    }
    async function runPostal(){
      const [{createStageCurrentPostalRefreshStore},{createStageCurrentPostalProjectInputs},
        {refreshStageCurrentPostalRegistration,readStageCurrentPostalFallback}]=await Promise.all([
          import('../src/shadowCoverage/postalCurrentRegistrationStore.js'),
          import('../src/shadowCoverage/postalCurrentRegistrationInputs.js'),
          import('../src/shadowCoverage/postalCurrentRegistrationRefresh.js')]);
      const store=createStageCurrentPostalRefreshStore({env,write:true});
      const nationalStorage=createStageNationalRegistryStorage({env});
      if(!store||!nationalStorage)return {state:'SKIPPED'};
      const nationalReader=createStageNationalRegistryReader({store:nationalStorage});
      const inputs=await createStageCurrentPostalProjectInputs({env});
      try{
        return await refreshStageCurrentPostalRegistration({store,...inputs,readRegistry:()=>nationalReader.read(),
          readRegistryVersion:async()=> (await nationalStorage.readHead()).value?.current?.version,
          readRegistryRows:version=>readStageNationalRegistryRows(nationalStorage,version),
          fallback:()=>readStageCurrentPostalFallback({env})});
      }finally{await inputs.dispose();}
    }
    async function runGeneration(){
      let durable;
      try{
        durable=createOpsmapDurableGeneration({...stageOpsmapDurableStorage({env,write:true}),appRoot});
        const result=await publishOpsmapScheduledRun({
          createWorker:recordSource=>buildWorker({mode,settingsFile,durable,recordSource}),durable,receipt});
        report(result);
        return result;
      }finally{await durable?.dispose().catch(()=>{});}
    }
    if(job.scheduledKind){
      const executors={generation:runGeneration,recent:runRecentOperations,fixed:runFixedMaster,national:runNationalRegistry,
        wms:runWms,'wms-night':()=>runWms(true),postal:runPostal};
      memory('START');
      const result=await executors[job.scheduledKind]?.()??{state:'SKIPPED'};
      memory('END');
      console.log(JSON.stringify({component:'opsmap-stage-job-result',runId:receipt.runId,job:job.scheduledKind,
        state:result.state,error:result.error}));
      return;
    }
    if(mode==='fixed-scheduled')return runMasterJobs();
    try{await runGeneration();}
    finally{await runMasterJobs();}
}

try { await run(); }
catch (error) {
  const value = error.code || error.message || '';
  console.error(/^[A-Z][A-Z_0-9]{1,95}$/.test(value) ? value : 'OPSMAP_SYNC_FAILED');
  process.exitCode = 1;
}
