import { createHash } from 'node:crypto';
import { planHybridPeriod } from './hybridMapPlan.js';
import {validActualVehicle,matchesVehicle} from '../public/hybrid-map-contract.mjs';
const fail = code => { throw new Error(code); };
const hashRows = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const fields = ['deliveryDate','customerCode','confirmedVehicle','count','driverKey'];
// Adapters must enforce maxResponseBytes while streaming HTTP, before JSON.parse.
// This isolated module has no fetch, credentials, legacy restore or production registration.
export function createHybridPeriodReader({ readVerifiedPage, readCurrentPage, now = Date.now,
  maxConcurrent = 2, maxQueryDays = 7, maxPageRows = 300, maxDayRows = 20000, maxPageBytes = 262144,
  maxCacheBytes = 1048576, maxCacheEntries = 4, ttlMs = 60000, timeoutMs = 10000, backoffMs = 1000 } = {}) {
  if (typeof readVerifiedPage !== 'function' || typeof readCurrentPage !== 'function'
      || ![maxConcurrent,maxQueryDays,maxPageRows,maxDayRows,maxPageBytes,maxCacheBytes,maxCacheEntries,ttlMs,timeoutMs,backoffMs].every(n => Number.isSafeInteger(n) && n > 0)
      || maxConcurrent > 8 || maxQueryDays > 90 || maxPageRows > 1000 || maxCacheEntries > 64 || maxCacheBytes > 8 * 1048576) fail('INVALID_READER_LIMITS');
  const cache = new Map(), pending = new Map(), failures = new Map();
  let bytes = 0, active = 0, peakActive = 0;
  function remove(key) { const entry = cache.get(key); if (entry) { bytes -= entry.bytes; cache.delete(key); } }
  function prune() {
    for (const [key, entry] of cache) if (entry.expiresAt <= now()) remove(key);
    while (cache.size > maxCacheEntries || bytes > maxCacheBytes) remove(cache.keys().next().value);
    for (const [key, until] of failures) if (until <= now()) failures.delete(key);
  }
  function validate(page, step, cursor) {
    if (!page || typeof page.revision !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(page.revision)
        || page.source !== 'Freshon' || !Array.isArray(page.data) || page.data.length > maxPageRows
        || !Number.isSafeInteger(page.total) || page.total < 0 || page.total > maxDayRows
        || typeof page.complete !== 'boolean'
        || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(page.nextCursor)))
        || page.complete !== (page.nextCursor === null) || (page.nextCursor !== null && page.nextCursor === cursor)) fail('DAY_PAGE_INCOMPLETE');
    if (step.ref && page.revision !== step.ref.revision) fail('DAY_REVISION_CHANGED');
    const data = page.data.map(row => {
      if (!row || Object.keys(row).some(k => !fields.includes(k)) || row.deliveryDate !== step.date
          || !/^[A-Z]\d+$/.test(row.customerCode || '') || !validActualVehicle(row.confirmedVehicle)
          || !Number.isSafeInteger(row.count) || row.count < 1
          || (row.driverKey !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(row.driverKey))) fail('DAY_ROW_INVALID');
      return Object.freeze(Object.fromEntries(fields.filter(k => row[k] !== undefined).map(k => [k, row[k]])));
    });
    const clean = Object.freeze({ revision: page.revision, source: 'Freshon', data: Object.freeze(data), total: page.total, complete: page.complete, nextCursor: page.nextCursor });
    if (Buffer.byteLength(JSON.stringify(clean)) > maxPageBytes) fail('DAY_PAGE_TOO_LARGE');
    return clean;
  }
  function load(step, cursor) {
    prune();
    const key = JSON.stringify([step.version,step.mode,step.date,step.ref?.revision || '',cursor]);
    const entry = cache.get(key);
    if (entry) { cache.delete(key); cache.set(key, entry); return Promise.resolve(entry.value); }
    if (pending.has(key)) return pending.get(key);
    if (failures.has(key)) return Promise.reject(new Error('DAY_READ_BACKOFF'));
    if (active >= maxConcurrent) return Promise.reject(new Error('DAY_READ_BUSY'));
    active++; peakActive = Math.max(peakActive, active);
    const controller = new AbortController();
    let timer;
    const operation = Promise.resolve().then(() => (step.mode === 'VERIFIED_DAY' ? readVerifiedPage : readCurrentPage)({
      date: step.date, ref: step.ref, cursor, limit: maxPageRows, maxResponseBytes: maxPageBytes,
      version: step.version, source: 'CURRENT_ONLY', signal: controller.signal
    })).then(page => validate(page, step, cursor));
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('DAY_READ_TIMEOUT')); }, timeoutMs); });
    const result = Promise.race([operation, deadline]).then(value => {
      // Current mutable pages are not cached: only one in-flight request is shared.
      if (step.mode === 'VERIFIED_DAY') {
        const size = Buffer.byteLength(JSON.stringify(value));
        if (size <= maxCacheBytes) { remove(key); cache.set(key, {value, bytes: size, expiresAt: now() + ttlMs}); bytes += size; prune(); }
      }
      return value;
    }).catch(error => {
      failures.delete(key); failures.set(key, now() + backoffMs);
      while (failures.size > 32) failures.delete(failures.keys().next().value);
      throw error;
    });
    pending.set(key, result);
    // An adapter ignoring abort retains its slot until it settles. Never accumulate orphan requests.
    operation.catch(() => {}).finally(() => { clearTimeout(timer); active--; if (pending.get(key) === result) pending.delete(key); });
    return result;
  }
  async function* read(manifest, query) {
    const plan = planHybridPeriod(manifest, query);
    if (plan.steps.length > maxQueryDays) fail('QUERY_PAGINATION_REQUIRED');
    for (const [stepIndex, step] of plan.steps.entries()) {
      let cursor = null, revision, total, readCount = 0;
      const cursors = new Set(), identities = new Set(), digest = createHash('sha256');
      digest.update('[');
      do {
        const page = await load(step, cursor);
        if (revision !== undefined && (revision !== page.revision || total !== page.total)) fail('DAY_REVISION_CHANGED');
        revision = page.revision; total = page.total;
        for (const row of page.data) {
          const identity = [row.deliveryDate,row.customerCode,row.confirmedVehicle,row.driverKey || ''].join('|');
          if (identities.has(identity)) fail('DAY_DUPLICATE_ROW');
          identities.add(identity); if (readCount++) digest.update(','); digest.update(JSON.stringify(row));
        }
        if (readCount > total || (!page.complete && (!page.data.length || readCount >= total)) || (page.complete && readCount !== total)) fail('DAY_PAGE_INCOMPLETE');
        if (page.nextCursor && cursors.has(page.nextCursor)) fail('DAY_CURSOR_LOOP');
        if (page.nextCursor) cursors.add(page.nextCursor);
        cursor = page.nextCursor;
        if (!cursor) {
          digest.update(']'); const actualHash = digest.digest('hex');
          if (step.ref && (readCount !== step.ref.count || actualHash !== step.ref.hash)) fail('DAY_HASH_CHANGED');
        }
        // Earlier pages are explicitly provisional until the day's terminal hash is checked.
        yield Object.freeze({ data: Object.freeze(page.data.filter(row => matchesVehicle(row.confirmedVehicle,step.vehicle))),
          meta: Object.freeze({ version: plan.version, date: step.date, revision, source: 'Freshon',
            dayComplete: !cursor, verified: !cursor && step.mode === 'VERIFIED_DAY', provisional: Boolean(cursor),
            queryReadComplete: !cursor && stepIndex === plan.steps.length - 1,
            currentDayCompletenessUnconfirmed: step.mode !== 'VERIFIED_DAY', fetchedAt: now(), archiveIncluded: false }) });
      } while (cursor);
    }
  }
  return { read, stats: () => { prune(); return {active,peakActive,inFlight:pending.size,cacheEntries:cache.size,cacheBytes:bytes,backoffEntries:failures.size}; } };
}
export { hashRows as hashHybridRows };
