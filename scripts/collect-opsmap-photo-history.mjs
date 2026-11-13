import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { boundedRead, privateCoverageDirectory } from '../src/shadowCoverage/coverageFiles.js';
import { createOpsmapPhotoIndex, createPhotoIndexCollector, validatePhotoIndexPlan } from '../src/opsmapPhotoIndex.js';
import { createStageOperationalPhotoExtension } from '../src/opsmapStagePhotos.js';
import { readStaffDriverHistory } from '../src/opsmap-abc/mapPeriod.js';
import { createReadDeadline } from '../src/opsmap-abc/readDeadline.js';
import { callHub } from '../src/opsmap-abc/phase2bHubReadClient.js';
import { STAGE_ORIGIN, STAGE_SERVICE } from '../src/stageScope.js';

// node scripts/collect-opsmap-photo-history.mjs initial|incremental <absolute-plan.json> <from> <through>
// The protected plan and its expected SHA-256 are supplied by the operator.
// Plan from/through covers the store, while each invocation reads <=31 days.
async function main() {
  const [mode, file, from, through, ...extra] = process.argv.slice(2);
  const {OPSMAP_PHOTO_HISTORY_DIRECTORY:directory, OPSMAP_PHOTO_HISTORY_PLAN_SHA256:expected} = process.env;
  if (extra.length || !['initial','incremental'].includes(mode) || !path.isAbsolute(file || '') || !/^[a-f0-9]{64}$/.test(expected || '')) {
    throw Error('PHOTO_HISTORY_COMMAND_INVALID');
  }
  const realFile = await fs.realpath(file);
  await privateCoverageDirectory(path.dirname(realFile), process.cwd());
  await privateCoverageDirectory(directory, process.cwd());
  const bytes = await boundedRead(realFile, 1024 * 1024);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('PHOTO_HISTORY_PLAN_DIGEST_MISMATCH');
  const plan = validatePhotoIndexPlan(JSON.parse(bytes));
  const photos = createStageOperationalPhotoExtension({env:{...process.env, RENDER_EXTERNAL_URL:STAGE_ORIGIN, RENDER_SERVICE_ID:STAGE_SERVICE}});
  if (!process.env.HUB_API_URL || !process.env.HUB_API_SECRET || !photos.diagnostics().enabled ||
      !(photos.diagnostics().credentialsConfigured || photos.diagnostics().cookieConfigured)) {
    throw Error('PHOTO_HISTORY_APPROVED_SOURCES_REQUIRED');
  }
  const index = createOpsmapPhotoIndex({directory});
  let hubPageCalls = 0;
  const collect = createPhotoIndexCollector({index,
    async readHubCandidates(query, {signal}) {
      const budget = createReadDeadline({milliseconds:20000});
      const abort = () => budget.abort();
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, {once:true});
      try {
        return await readStaffDriverHistory(query, (params, options) => {
          hubPageCalls++;
          return callHub('staffDriverHistory', params, {...options, privateRead:true, useCache:false, maxResponseBytes:512 * 1024});
        }, {budget, requireDelivery:true});
      } finally { signal?.removeEventListener('abort', abort); budget.dispose(); }
    },
    async readTask(identity, options) {
      await pause(500, undefined, {signal:options.signal});
      return photos.readIndexTask(identity, options);
    }
  });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const result = await collect({plan, from, through, mode, signal:controller.signal});
  const {state, scope, counts} = await index.read({customerCode:plan.customerCode});
  console.log(JSON.stringify({mode, ...result, hubPageCalls, state, scope, counts}));
  if (result.authFailures || result.failures) process.exitCode = 2;
}

main().catch(error => {
  const safe = [error.code, error.message].find(code => /^PHOTO_HISTORY_[A-Z_]+$/.test(code || ''));
  console.error(safe || 'PHOTO_HISTORY_COLLECTION_FAILED');
  process.exitCode = 1;
});
