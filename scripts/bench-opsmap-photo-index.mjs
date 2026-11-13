import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOpsmapPhotoIndex, INDEX_PHOTO_KINDS, validatePhotoIndexPlan } from '../src/opsmapPhotoIndex.js';

if (!global.gc) throw Error('Run with node --expose-gc scripts/bench-opsmap-photo-index.mjs');
const directory = await mkdtemp(path.join(os.tmpdir(), 'photo-index-bench-'));
try {
  const day = 86400000, through = '2026-11-13', end = Date.parse(through), customerCode = 'S100', amount = 5000;
  const atDay = offset => new Date(end - offset * day).toISOString().slice(0, 10);
  const from = atDay(amount - 1), digest = 'a'.repeat(64);
  const plan = validatePhotoIndexPlan({customerCode, from, through, aliases:[], retentionProof:digest, identityProof:digest,
    verifiedRanges:[{from, through, evidenceSha256:digest}]});
  const now = () => end + 3 * 3600000;
  const index = createOpsmapPhotoIndex({directory, now});
  const indexBytes = await index.update(plan, async () => {
    const discovery = {};
    const tasks = Array.from({length:amount}, (_, i) => {
      const date = atDay(i);
      const photos = INDEX_PHOTO_KINDS.map((kind, j) => ({kind, ...(j === 0 ? {recordId:String(70000 + i)} : {}),
        ref:{kind, attachmentIndex:j, imageIndex:0, fingerprint:(i * 2 + j).toString(16).padStart(64, '0'), recordFingerprint:digest}}));
      discovery[date] = 'CHECKED';
      return {customerCode, date, deliveryId:String(90000 + i), state:'CHECKED', photos};
    });
    return {schema:1, plan, discovery, tasks};
  });
  const reader = createOpsmapPhotoIndex({directory, now});
  const milliseconds = [], heap = [], rss = [];
  for (let i = 0; i < 32; i++) {
    global.gc();
    const before = process.memoryUsage(), start = performance.now();
    const page = await reader.read({customerCode});
    milliseconds.push(performance.now() - start);
    const after = process.memoryUsage();
    heap.push(Math.max(0, after.heapUsed - before.heapUsed) / 1048576);
    rss.push(Math.max(0, after.rss - before.rss) / 1048576);
    assert.equal(page.items.length, 24);
    assert.equal(page.counts.REFRIGERATOR_DOOR, amount);
    assert.equal(page.state, 'COMPLETE');
  }
  const p95 = values => Number(values.sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1].toFixed(2));
  console.log(JSON.stringify({fixture:'synthetic single store', tasks:amount, photos:amount * 2, indexBytes, page:24,
    samples:milliseconds.length, p95Ms:p95(milliseconds), p95ObservedHeapGrowthMiB:p95(heap), p95ObservedRssGrowthMiB:p95(rss)}));
} finally {
  await rm(directory, {recursive:true, force:true});
}
