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
import {SYNC_CENTERS} from '../src/opsmapSyncPolicy.js';

const appRoot = fileURLToPath(new URL('../',import.meta.url));
const env = process.env;

function report(result) {
  console.log(JSON.stringify({component:'opsmap-data-sync',state:result.state,revision:result.revision ?? null,
    generation:result.generation ?? null,runId:result.runId??null,observedToday:result.observedToday===true,
    sourceReadComplete:result.sourceReadComplete===true,lastSuccessAt:result.lastSuccessAt ?? result.completedAt ?? null}));
}

async function buildWorker({mode,settingsFile,durable}) {
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
      const status = await registry.refresh({maxPages:36,deadline:Date.now()+180_000});
      if (!['UPDATED','NOOP'].includes(status.phase)) throw Error('OPSMAP_SYNC_REGISTRY_INCOMPLETE');
      return registry.read();
    };
    if(durable && SYNC_CENTERS.some(center=>!Object.hasOwn(config.deliveryCenters || {},center))) {
      throw Error('DELIVERY_SOURCE_CENTER_CONFIG');
    }
    const delivery = createStageDatedDeliveryReader({env,syncCenters:config.deliveryCenters});
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
    readMissingDay:durable?.readDay});
}

async function run() {
  const [mode,settingsFile,...backfillDates] = process.argv.slice(2);
  if (!['bootstrap','once','watch','scheduled'].includes(mode) || !path.isAbsolute(settingsFile || '')) throw Error('OPSMAP_SYNC_USAGE');
  if(mode==='scheduled'){
    if(env.OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED!=='1'||backfillDates.length)throw Error('OPSMAP_SCHEDULE_SOURCE_CONFIG');
    let input='';
    for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>2048)throw Error('OPSMAP_SCHEDULE_RECEIPT');}
    const receipt=verifyOpsmapScheduleReceipt(JSON.parse(input),opsmapScheduleConfig(env));
    const durable=createOpsmapDurableGeneration({...stageOpsmapDurableStorage({env,write:true}),appRoot});
    try {report(await publishOpsmapScheduledRun({createWorker:()=>buildWorker({mode,settingsFile,durable}),durable,receipt}));}
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
