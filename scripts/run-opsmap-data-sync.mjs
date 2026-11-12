import {createOfficialAddressLookup} from '../src/opsmapOfficialAddressLookup.js';
import {openPublicAddressCatalog} from '../src/opsmapPublicAddressCatalog.js';
import {completeFixedCoordinates, completeFixedCoordinatesFromCatalog} from '../src/fixedCoordinateCompletion.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCustomerRegistry} from '../src/customerRegistry.js';
import {readFixedCoordinateLedger} from '../src/fixedStoreCoordinates.js';
import {createOpsmapDataSync, startOpsmapDataSync} from '../src/opsmapDataSync.js';
import {callHub} from '../src/opsmap-abc/phase2bHubReadClient.js';
import {privateReaderEndpoint} from '../src/opsmap-abc/privateReaderEndpoint.js';
import {createManualMapPins} from '../src/opsmap-abc/manualMapPins.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from '../src/stageScope.js';
import {createStageDatedDeliveryReader} from '../src/stageDatedDelivery.js';
import {boundedRead, privateCoverageDirectory} from '../src/shadowCoverage/coverageFiles.js';
import {atomicCoverageWrite} from '../src/shadowCoverage/fileStore.js';
import {createOpsmapDurableGeneration,stageOpsmapDurableStorage} from '../src/opsmapDurableGeneration.js';
import {opsmapScheduleConfig,publishOpsmapScheduledRun,verifyOpsmapScheduleReceipt} from '../src/opsmapScheduledRun.js';
import {SYNC_DELIVERY_SOURCES} from '../src/opsmapSyncPolicy.js';
import {createStageFixedMasterSource, stageFixedMasterBaseline, stageFixedMasterStorage,
  stageFixedMasterSyncEnabled, syncStageFixedMaster} from '../src/stageFixedMasterSync.js';

const appRoot = fileURLToPath(new URL('../',import.meta.url));
const env = process.env;

async function readFixedMasterPrivate(file, maxBytes) {
  if (!path.isAbsolute(file || '')) throw Error('FIXED_MASTER_DAILY_LEDGER');
  const root=await privateCoverageDirectory(path.dirname(file),appRoot);
  const resolved=await fs.realpath(path.join(root,path.basename(file)));
  if(path.dirname(resolved)!==root) throw Error('FIXED_MASTER_DAILY_LEDGER');
  return boundedRead(resolved,maxBytes);
}

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
  if (!path.isAbsolute(config.ledgerFile || '')) throw Error('OPSMAP_SYNC_LEDGER_PATH');
  const ledgerFolder = await privateCoverageDirectory(path.dirname(config.ledgerFile),appRoot);
  const readLedger = async () => {
    const updated = await readSettings();
    if (updated.directory !== config.directory || updated.ledgerFile !== config.ledgerFile) throw Error('OPSMAP_SYNC_STORAGE_CHANGED');
    return readFixedCoordinateLedger(await boundedRead(path.join(ledgerFolder,path.basename(config.ledgerFile)),8*1024*1024),updated.ledgerSha256);
  };
  let readRegistry, readDay, readManualPins;
  if (mode !== 'bootstrap') {
    if (env.RENDER_SERVICE_ID !== STAGE_SERVICE || env.RENDER_EXTERNAL_URL !== STAGE_ORIGIN || env.OPSMAP_SYNC_SOURCE_READ_APPROVED !== '1') {
      throw Error('OPSMAP_SYNC_SOURCE_APPROVAL_REQUIRED');
    }
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
    if(durable && Object.entries(SYNC_DELIVERY_SOURCES).some(([center,id])=>config.deliveryCenters?.[center]!==id)) {
      throw Error('DELIVERY_SOURCE_CENTER_CONFIG');
    }
    const verifiedSources=config.deliveryVerifiedSourceIds;
    if(durable && (!Array.isArray(verifiedSources)||verifiedSources.length!==4||
        Object.values(SYNC_DELIVERY_SOURCES).some(id=>!verifiedSources.includes(id)))) {
      throw Error('DELIVERY_SOURCE_ENTITLEMENT_UNVERIFIED');
    }
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
  if(durable&&!completeCoordinates)throw Error('OPSMAP_SCHEDULE_SOURCE_CONFIG');
  await durable?.restoreSpool(directory);
  return createOpsmapDataSync({directory,seed:config.seed,readLedger,readRegistry,readDay,readManualPins,appRoot,completeCoordinates,
    readMissingDay:durable?.readDay,requiredSourceIds:durable?Object.values(SYNC_DELIVERY_SOURCES):[]});
}

async function run() {
  const [mode,settingsFile,...backfillDates] = process.argv.slice(2);
  if (!['bootstrap','once','watch','scheduled','fixed-scheduled'].includes(mode) || !path.isAbsolute(settingsFile || '')) throw Error('OPSMAP_SYNC_USAGE');
  if(mode==='scheduled'||mode==='fixed-scheduled'){
    if(env.OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED!=='1'||backfillDates.length)throw Error('OPSMAP_SCHEDULE_SOURCE_CONFIG');
    let input='';
    for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>2048)throw Error('OPSMAP_SCHEDULE_RECEIPT');}
    const receipt=verifyOpsmapScheduleReceipt(JSON.parse(input),opsmapScheduleConfig(env));
    const scopeFile=env.OPSMAP_STAGE_FIXED_MASTER_SCOPE_FILE || settingsFile;
    if (stageFixedMasterSyncEnabled(env) && path.isAbsolute(scopeFile)) {
      try {
        const store=stageFixedMasterStorage({env,write:true});
        const source=createStageFixedMasterSource({env});
        const baseline=stageFixedMasterBaseline({env,store});
        const result=await syncStageFixedMaster({store,receipt,readMaster:source,loadBaseline:baseline.load,
          async readLedger() {
            const config=JSON.parse(await readFixedMasterPrivate(scopeFile,32_768));
            return readFixedCoordinateLedger(await readFixedMasterPrivate(config.ledgerFile,8*1024*1024),config.ledgerSha256);
          }});
        console.log(JSON.stringify({component:'opsmap-fixed-master-sync',runId:receipt.runId,state:result.state,version:result.version}));
      } catch(error) {
        const code=error.code || error.message || '';
        console.log(JSON.stringify({component:'opsmap-fixed-master-sync',runId:receipt.runId,state:'FAILED',
          error:/^FIXED_(?:MASTER|STORE)_[A-Z_]{1,70}$/.test(code)?code:'FIXED_MASTER_DAILY_FAILED'}));
        if (mode==='fixed-scheduled') throw error;
      }
    } else if (mode==='fixed-scheduled') throw Error('FIXED_MASTER_STAGE_SOURCE_SCOPE');
    if (mode==='fixed-scheduled') return;
    const durable=createOpsmapDurableGeneration({...stageOpsmapDurableStorage({env,write:true}),appRoot});
    try {report(await publishOpsmapScheduledRun({createWorker:recordSource=>buildWorker({mode,settingsFile,durable,recordSource}),durable,receipt}));}
    finally {await durable.dispose().catch(()=>{});}
    return;
  }
  const worker=await buildWorker({mode,settingsFile});
  if (mode !== 'watch') {report(await worker.sync({bootstrap:mode==='bootstrap',backfillDates}));return;}
  if (backfillDates.length) throw Error('OPSMAP_SYNC_USAGE');
  const stop = startOpsmapDataSync(worker,{onResult:report});
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
}

try { await run(); }
catch (error) {
  const value = error.code || error.message || '';
  console.error(/^[A-Z][A-Z_0-9]{1,95}$/.test(value) ? value : 'OPSMAP_SYNC_FAILED');
  process.exitCode = 1;
}
