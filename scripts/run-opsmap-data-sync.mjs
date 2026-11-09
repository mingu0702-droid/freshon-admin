import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCustomerRegistry} from '../src/customerRegistry.js';
import {readFixedCoordinateLedger} from '../src/fixedStoreCoordinates.js';
import {createOpsmapDataSync, startOpsmapDataSync} from '../src/opsmapDataSync.js';
import {callHub} from '../src/opsmap-abc/phase2bHubReadClient.js';
import {privateReaderEndpoint} from '../src/opsmap-abc/privateReaderEndpoint.js';
import {createManualMapPins} from '../src/opsmap-abc/manualMapPins.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from '../src/stageAbValidation.js';
import {createStageDatedDeliveryReader} from '../src/stageDatedDelivery.js';
import {boundedRead, privateCoverageDirectory} from '../src/shadowCoverage/coverageFiles.js';
import {atomicCoverageWrite} from '../src/shadowCoverage/store.js';

const appRoot = fileURLToPath(new URL('../',import.meta.url));
const env = process.env;

function report(result) {
  console.log(JSON.stringify({component:'opsmap-data-sync',state:result.state,revision:result.revision ?? null,
    generation:result.generation ?? null,observedToday:result.observedToday===true,lastSuccessAt:result.lastSuccessAt ?? null}));
}

async function run() {
  const [mode,settingsFile,...backfillDates] = process.argv.slice(2);
  if (!['bootstrap','once','watch'].includes(mode) || !path.isAbsolute(settingsFile || '')) throw Error('OPSMAP_SYNC_USAGE');
  const settingsRoot = await privateCoverageDirectory(path.dirname(settingsFile),appRoot);
  const readSettings = async () => JSON.parse(await boundedRead(path.join(settingsRoot,path.basename(settingsFile)),32_768));
  const config = await readSettings();
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
    if (env.RENDER_SERVICE_ID !== STAGE_SERVICE || env.RENDER_EXTERNAL_URL !== STAGE_ORIGIN || env.OPSMAP_SYNC_SOURCE_READ_APPROVED !== '1' ||
        env.OPSMAP_STAGE_DELIVERY_DATED_ENABLED !== '1' || !env.OPSMAP_STAGE_DELIVERY_DATED_COOKIE?.trim()) throw Error('OPSMAP_SYNC_SOURCE_APPROVAL_REQUIRED');
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
    readDay = createStageDatedDeliveryReader({env,syncCenters:config.deliveryCenters}).readObservation;
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
  const worker = await createOpsmapDataSync({directory,seed:config.seed,readLedger,readRegistry,readDay,readManualPins,appRoot});
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
