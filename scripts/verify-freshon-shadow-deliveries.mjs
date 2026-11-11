import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { latLngToCell } from 'h3-js';
import { openOpsmapSyncGenerationStore } from '../src/opsmapSyncGeneration.js';
import { boundedRead, privateCoverageDirectory } from '../src/shadowCoverage/coverageFiles.js';
import { collectFreshonCompletedDeliveries } from '../src/shadowCoverage/freshonCompletedDeliveries.js';
import { createFreshonStoreStatusIndex } from '../src/shadowCoverage/freshonStoreStatus.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function verify([generationDirectory, file, expectedSha256, outputDirectory]) {
  const output = await privateCoverageDirectory(outputDirectory, process.cwd());
  const store = await openOpsmapSyncGenerationStore(generationDirectory);
  const active = await store.read();
  const { state, registry, vehicleDelivery } = active;
  const bytes = await boundedRead(file, 8 * 1024 * 1024);
  if (sha(bytes) !== expectedSha256) throw Error('FRESHON_SHADOW_FILE_DIGEST');
  const projection = JSON.parse(bytes);
  if (state.asOf !== projection.asOf || !vehicleDelivery ||
      JSON.stringify(vehicleDelivery.observedDates.osan) !== JSON.stringify(projection.deliveryObservedDates)) {
    throw Error('FRESHON_COMPLETED_DELIVERY_SCOPE');
  }
  const original = createFreshonStoreStatusIndex(projection, registry, state.generation);
  const candidates = new Set([...registry.keys()].filter(code => original.getDeliveryStatus(code) !== null));
  async function* readObservedDays() {
    for (const date of projection.deliveryObservedDates) {
      const day = await store.readDay(date, active);
      if (!day) throw Error('FRESHON_COMPLETED_DELIVERY_MISSING_DAY');
      yield day;
    }
  }
  projection.completedDeliveryEvidence = await collectFreshonCompletedDeliveries(readObservedDays(), candidates);
  const index = createFreshonStoreStatusIndex(projection, registry, state.generation);
  const periods = [30, 60, 90];
  const summaries = periods.map(days => index.getDeliverySummary(days));
  const fields = ['historicalNew', 'confirmedNewActive', 'newZero', 'newUnknown', 'held'];
  const located = [...candidates].map(code => registry.get(code)).filter(row => row.hasPoint);
  const cells = [8, 9, 10, 11].map(resolution => {
    const ids = new Set(located.map(row => latLngToCell(row.lat, row.lng, resolution)));
    const windows = periods.map(days => {
      const counts = Object.fromEntries(fields.map(key => [key, 0]));
      for (const id of ids) {
        const { deliveryFilter } = index.getCell(id, { days, limit: 1 });
        for (const key of fields) counts[key] += deliveryFilter[key];
      }
      if (located.length === candidates.size && fields.some(key => counts[key] !== index.getDeliverySummary(days)[key])) {
        throw Error('FRESHON_COMPLETED_DELIVERY_H3_MISMATCH');
      }
      return { days, ...counts };
    });
    return { resolution, windows };
  });
  const privateBytes = Buffer.from(JSON.stringify(projection));
  const privateFile = 'FRESHON_SHADOW_DELIVERY_STATUS.private.json';
  const evidence = { generation: state.generation, asOf: state.asOf, inputSha256: expectedSha256,
    deliveryUnknownDates: projection.deliveryUnknownDates, summaries, cells, privateFile, privateSha256: sha(privateBytes) };
  await writeFile(path.join(output, privateFile), privateBytes, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(output, 'FRESHON_SHADOW_DELIVERY_AUDIT.safe.json'), JSON.stringify(evidence, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ generation: evidence.generation, summaries, resolutions: cells.map(cell => cell.resolution),
    privateFile, privateSha256: evidence.privateSha256 }));
}

verify(process.argv.slice(2)).catch(error => {
  console.error(/^FRESHON_[A-Z_]+$/.test(error.message) ? error.message : 'FRESHON_COMPLETED_DELIVERY_VERIFICATION_FAILED');
  process.exitCode = 1;
});
