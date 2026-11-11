import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { latLngToCell } from 'h3-js';
import { openOpsmapSyncGenerationStore } from '../src/opsmapSyncGeneration.js';
import { privateCoverageDirectory } from '../src/shadowCoverage/coverageFiles.js';
import { readFreshonStoreStatusFile } from '../src/shadowCoverage/freshonStoreStatus.js';

async function verify([generationDirectory, file, expectedSha256, outputDirectory, orderFile, orderSha256]) {
  const output = await privateCoverageDirectory(outputDirectory, process.cwd());
  const store = await openOpsmapSyncGenerationStore(generationDirectory);
  const { state, registry } = await store.read();
  const index = await readFreshonStoreStatusFile({ file, expectedSha256, generation: state.generation,
    registry, orderFile, orderSha256 });
  const periods = [30, 60, 90];
  const summaries = periods.map(days => index.getOrderSummary(days));
  const counts = ['historicalNew', 'confirmedNewActive', 'newUnknown', 'newZero', 'newCancelledOnly',
    'held', 'heldOrderUnknown', 'heldOrderConflict', 'numberedWithVerifiedOrders', 'hiredWithVerifiedOrders'];
  const cells = [8, 9, 10, 11].map(resolution => {
    const located = [...registry.values()].filter(row => row.hasPoint);
    const ids = new Set(located.map(row => latLngToCell(row.lat, row.lng, resolution)));
    const windows = periods.map(days => {
      const count = Object.fromEntries(counts.map(key => [key, 0]));
      for (const id of ids) {
        const { orderFilter } = index.getCell(id, { days, limit: 1 });
        for (const key of counts) count[key] += orderFilter[key];
      }
      if (located.length === registry.size && counts.some(key => count[key] !== index.getOrderSummary(days)[key])) {
        throw Error('FRESHON_MIS_ORDER_H3_MISMATCH');
      }
      return { days, ...count };
    });
    return { resolution, windows };
  });
  const results = [];
  for (const customerCode of registry.keys()) {
    const latest = index.getOrderStatus(customerCode, 90);
    if (!latest.historicalNew && !latest.held) continue;
    results.push({ customerCode, currentVehicle: latest.currentVehicle, historicalNew: latest.historicalNew,
      held: latest.held, laterNumberedVehicle: latest.laterNumberedVehicle, hiredDispatched: latest.hiredDispatched,
      confirmedRegularTransition: latest.confirmedRegularTransition,
      periods: periods.map(days => {
        const status = index.getOrderStatus(customerCode, days);
        return { days, newActive: status.newActive, order: status.order, heldOrderConflict: status.heldOrderConflict,
          heldOrderConflictReason: status.heldOrderConflictReason };
      }) });
  }
  const privateBytes = Buffer.from(JSON.stringify({ metadata: index.metadata, stores: results }));
  const privateFile = 'FRESHON_MIS_ORDER_STATUS.private.json';
  await writeFile(path.join(output, privateFile), privateBytes, { flag: 'wx', mode: 0o600 });
  const evidence = { generation: state.generation, statusSha256: expectedSha256, orderSource: index.metadata.orderSource,
    orderSha256: index.metadata.orderSource === 'VERIFIED' ? orderSha256 : null, summaries, cells, privateFile,
    privateSha256: createHash('sha256').update(privateBytes).digest('hex') };
  await writeFile(path.join(output, 'FRESHON_MIS_ORDER_AUDIT.safe.json'), JSON.stringify(evidence, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ orderSource: evidence.orderSource, summaries, resolutions: cells.map(cell => cell.resolution) }));
}

verify(process.argv.slice(2)).catch(error => {
  console.error(/^FRESHON_[A-Z_]+$/.test(error.message) ? error.message : 'FRESHON_MIS_ORDER_VERIFICATION_FAILED');
  process.exitCode = 1;
});
