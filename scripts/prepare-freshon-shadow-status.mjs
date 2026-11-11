import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { latLngToCell } from 'h3-js';
import { validateFixedEnvelope } from '../src/fixedVehicleStore.js';
import { openOpsmapSyncGenerationStore } from '../src/opsmapSyncGeneration.js';
import { completeSyncObservation } from '../src/opsmapSyncPolicy.js';
import { boundedRead, datesFor, privateCoverageDirectory } from '../src/shadowCoverage/coverageFiles.js';
import { buildFreshonStoreStatus, createFreshonStoreStatusIndex } from '../src/shadowCoverage/freshonStoreStatus.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const kstDate = value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10);
const labels = new Set(['오산신규', '오산보류']);

async function run([generationDir, fixedDir, partialDir, followupFile, historyFile, expectedHistorySha, outputDir]) {
  if (!outputDir || !/^[a-f0-9]{64}$/.test(expectedHistorySha || '')) throw Error('FRESHON_SHADOW_ARGUMENTS');
  const output = await privateCoverageDirectory(outputDir, process.cwd());
  const source = await openOpsmapSyncGenerationStore(generationDir);
  const active = await source.read();
  if (!active?.vehicleDelivery) throw Error('FRESHON_SHADOW_ARCHIVE_UNAVAILABLE');
  const { state, registry } = active;
  const dates = datesFor(state.asOf, 90);
  const observedDeliveryDates = active.vehicleDelivery.observedDates.osan;

  const fixedManifest = JSON.parse(await boundedRead(path.join(fixedDir, 'FIXED_MASTER_EXPORT.safe.json'), 16000));
  const compressed = await boundedRead(path.join(fixedDir, 'fixed-vehicle-projection-v1.json.gz'), 1024 * 1024);
  if (sha(compressed) !== fixedManifest.sha256) throw Error('FRESHON_SHADOW_FIXED_DIGEST');
  const raw = gunzipSync(compressed, { maxOutputLength: 8 * 1024 * 1024 });
  if (sha(raw) !== fixedManifest.uncompressedSha256) throw Error('FRESHON_SHADOW_FIXED_DIGEST');
  const { envelope } = validateFixedEnvelope(JSON.parse(raw), { materialize: false });
  const current = { date: kstDate(envelope.checkedAt), complete: false, rows: envelope.rows
    .filter(([code, , , status]) => registry.has(code) && status === 'VERIFIED_MASTER')
    .map(([code, vehicle]) => ({ code, vehicle })) };

  const fixed = [];
  const fixedPages = [];
  for (const center of ['OSAN', 'YEONGNAM', 'HONAM']) {
    const bytes = await boundedRead(path.join(partialDir, `${center}_SOURCE_PAGE0.json`));
    const page = JSON.parse(bytes);
    const date = kstDate(page.observedAt);
    if (!dates.includes(date) || page.complete !== false || page.rows?.length !== 1000) throw Error('FRESHON_SHADOW_PAGE_SCOPE');
    for (const row of page.rows) {
      if (labels.has(row.mainCarSeqNm)) fixed.push({ code: row.customerCode, date, vehicle: row.mainCarSeqNm });
    }
    fixedPages.push({ center, date, sha256: sha(bytes), loaded: page.rows.length, declared: page.declaredCount });
  }
  const followupBytes = await boundedRead(followupFile);
  const followup = JSON.parse(followupBytes);
  const followupDate = kstDate(followup.observedAt);
  if (!dates.includes(followupDate) || !Array.isArray(followup.targets)) throw Error('FRESHON_SHADOW_FOLLOWUP_SCOPE');
  for (const row of followup.targets) {
    if (labels.has(row.current?.baseVehicle)) fixed.push({ code: row.customerCode, date: followupDate, vehicle: row.current.baseVehicle });
  }

  const dispatch = [], deliveries = [], completeDispatchDates = [];
  const historyBytes = await boundedRead(historyFile);
  if (sha(historyBytes) !== expectedHistorySha) throw Error('FRESHON_SHADOW_HISTORY_DIGEST');
  const history = JSON.parse(historyBytes);
  if (history.source !== 'FRESHON_DAILY_ROUTES_SHEETS_READONLY' || history.scope !== 'DATED_ROUTE_BASE_VEHICLE_OBSERVATIONS' ||
      history.start !== dates[0] || history.end !== state.asOf || !Number.isFinite(Date.parse(history.sheetModifiedAt)) ||
      !Array.isArray(history.rows) || !Number.isSafeInteger(history.selectedRows) || history.rows.length > history.selectedRows) {
    throw Error('FRESHON_SHADOW_HISTORY_SCOPE');
  }
  const sourceRows = new Set();
  for (const row of history.rows) {
    if (!Array.isArray(row) || row.length !== 6) throw Error('FRESHON_SHADOW_HISTORY_ROW');
    const [sourceRow, code, date, vehicle, confirmedVehicle, addressHash] = row;
    if (!Number.isSafeInteger(sourceRow) || sourceRow < 2 || sourceRows.has(sourceRow) || !labels.has(vehicle)) {
      throw Error('FRESHON_SHADOW_HISTORY_ROW');
    }
    sourceRows.add(sourceRow);
    fixed.push({ code, date, vehicle });
    dispatch.push({ code, date, vehicle: confirmedVehicle, addressHash, addressHashKind: 'delivery' });
  }
  const observed = new Set(observedDeliveryDates);
  for (const date of dates) {
    const day = await source.readDay(date, active);
    if (!day || day.planningOnly) continue;
    if (completeSyncObservation(day, ['osan'], ['1', '2'])) completeDispatchDates.push(date);
    for (const [, code, vehicle, center, addressHash, status] of day.tasks || []) {
      if (center === 'osan' && status !== 'CANCELLED' && addressHash) {
        dispatch.push({ code, date, vehicle: vehicle || null, addressHash, addressHashKind: 'delivery' });
      }
    }
    if (!observed.has(date)) continue;
    for (const [, code, vehicle, center, addressHash] of day.visits) {
      if (center === 'osan' && addressHash) {
        deliveries.push({ code, date, vehicle: vehicle || null, addressHash, addressHashKind: 'delivery' });
      }
    }
  }
  // Dated rows and snapshots establish observations. A complete change or order
  // source is still required to establish exact transitions or a true absence.
  const projection = buildFreshonStoreStatus({ generation: state.generation, registry, asOf: state.asOf,
    observedDeliveryDates, current, fixed, dispatch, deliveries });
  const index = createFreshonStoreStatusIndex(projection, registry, state.generation);
  const privateBytes = Buffer.from(JSON.stringify(projection));
  const counts = { ...index.summary,
    geocoded: [...registry.values()].filter(row => row.hasPoint).length,
    currentKnown: projection.stores.filter(row => row.currentKnown).length,
    storesWithLastDelivery: projection.stores.filter(row => row.lastDelivery).length,
    storesWithLastDispatch: projection.stores.filter(row => row.lastDispatch).length,
    addressMismatches: projection.addressMismatches };
  const rollingStart = datesFor(current.date, 90)[0];
  const rolling = { start: rollingStart, end: current.date, evidenceThrough: state.asOf,
    scope: 'PARTIAL', observedNew: 0, observedHeld: 0 };
  for (const row of projection.stores) {
    const seen = new Set(row.fixedObservations.filter(item => item.date >= rollingStart && item.date <= current.date)
      .map(item => item.vehicle));
    if (seen.has('오산신규')) rolling.observedNew++;
    if (seen.has('오산보류')) rolling.observedHeld++;
  }
  const h3 = [8, 9, 10, 11].map(resolution => {
    const cells = new Set([...registry.values()].filter(row => row.hasPoint)
      .map(row => latLngToCell(row.lat, row.lng, resolution)));
    const stats = { resolution, occupiedCells: cells.size, registered: 0, observedNew: 0, observedHeld: 0 };
    for (const id of cells) {
      const { counts: cell } = index.getCell(id, { limit: 1 });
      for (const key of ['registered', 'observedNew', 'observedHeld']) stats[key] += cell[key];
    }
    if (stats.registered !== counts.geocoded || stats.observedNew !== counts.observedNew || stats.observedHeld !== counts.observedHeld) {
      throw Error('FRESHON_SHADOW_H3_TOTAL');
    }
    return stats;
  });
  const evidence = { generation: state.generation, asOf: state.asOf, start: projection.start,
    currentAsOf: current.date, completeDispatchDates, observedDeliveryDays: observed.size,
    unknownDeliveryDays: projection.deliveryUnknownDates, counts, rolling, h3, fixedPages,
    fixedMasterVersion: envelope.version, followupDate, followupSha256: sha(followupBytes),
    datedRoutes: { source: history.source, modifiedAt: history.sheetModifiedAt, selectedRows: history.selectedRows,
      rowsWithinWindow: history.rows.length, sha256: expectedHistorySha },
    historicLabelsOutsideRegistry: {
      new: new Set(fixed.filter(row => row.vehicle === '오산신규' && !registry.has(row.code)).map(row => row.code)).size,
      held: new Set(fixed.filter(row => row.vehicle === '오산보류' && !registry.has(row.code)).map(row => row.code)).size
    },
    output: { file: 'freshon-store-status.private.json', bytes: privateBytes.length, sha256: sha(privateBytes) } };
  await writeFile(path.join(output, evidence.output.file), privateBytes, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(output, 'FRESHON_SHADOW_STATUS.safe.json'), JSON.stringify(evidence, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ counts, rolling, observedDeliveryDays: observed.size, unknownDeliveryDays: projection.deliveryUnknownDates.length,
    completeDispatchDays: completeDispatchDates.length, h3, historicLabelsOutsideRegistry: evidence.historicLabelsOutsideRegistry,
    generation: state.generation, output: evidence.output }));
}

run(process.argv.slice(2)).catch(error => {
  console.error(error.code || (/^FRESHON_SHADOW_[A-Z_]+$/.test(error.message) ? error.message : 'FRESHON_SHADOW_PREPARATION_FAILED'));
  process.exitCode = 1;
});
