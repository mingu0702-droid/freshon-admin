// Local candidate. Callbacks must be uncached, bounded, read-only transports.
// No Properties, writer, credential, endpoint, publication, or scheduling API.
import { createHash } from 'node:crypto';
import { isDay, validActualVehicle } from '../public/hybrid-map-contract.mjs';
import { DAILY_ROUTE_COLUMNS } from './hybridSourceProviders.js';

export const PUBLIC_DAY_FIELDS = Object.freeze(DAILY_ROUTE_COLUMNS.filter(key => !['driverName', 'driverPhone', 'accessMemo'].includes(key)));
const defaults = Object.freeze({ maxSheetRows: 250000, dateChunkRows: 10000, rowChunkRows: 100, maxDateRows: 20000,
  maxSelectedBytes: 4 * 1048576, maxProjectedCells: 600000, maxIoCalls: 128, timeoutMs: 15000, cacheTtlMs: 15000, maxCacheEntries: 4 });
const ceilings = { ...defaults, rowChunkRows: 300, maxIoCalls: 256, timeoutMs: 30000, cacheTtlMs: 60000 };
const known = new Set(['RO_DAY_INPUT', 'RO_DAY_BUSY', 'RO_DAY_TIMEOUT', 'RO_DAY_ABORTED', 'RO_DAY_READ_FAILED', 'RO_DAY_METADATA',
  'RO_DAY_NATIVE_UNAVAILABLE', 'RO_DAY_SOURCE_MOVED', 'RO_DAY_DATE_INVALID', 'RO_DAY_RANGE', 'RO_DAY_ROW_INVALID',
  'RO_DAY_DUPLICATE', 'RO_DAY_CAPACITY', 'RO_DAY_BYTE_LIMIT', 'RO_DAY_CELL_LIMIT', 'RO_DAY_IO_LIMIT', 'RO_DAY_CONTENT_MOVED']);
const fail = code => { throw Error(code); };
const hash = () => createHash('sha256');
const digest = value => hash().update(JSON.stringify(value)).digest('hex');
const codeValid = value => typeof value === 'string' && /^[A-Z]\d+$/.test(value);
const privatePattern = /비밀번호|출입번호|도어락|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/;
const metadataTextFields = new Set(['customerName', 'customerAddress', 'detailAddress', 'deliveryArea']);
function publicString(value, max = 400) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number' || typeof value === 'number' && !Number.isFinite(value)) fail('RO_DAY_ROW_INVALID');
  const text = String(value);
  if (text.length > max || /[\x00-\x1f]/.test(text)) fail('RO_DAY_ROW_INVALID');
  return text;
}
function checkedLimits(input = {}) {
  if (Object.keys(input).some(key => !(key in defaults))) fail('RO_DAY_INPUT');
  const limits = { ...defaults, ...input };
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > ceilings[key]) fail('RO_DAY_INPUT');
  return limits;
}
function metadata(value, sourceId, sheetId, limits) {
  if (!value || value.sourceId !== sourceId || value.sheetId !== sheetId || value.sourceScope !== 'CURRENT_ONLY'
    || !Number.isSafeInteger(value.lastRow) || value.lastRow < 1 || value.lastRow - 1 > limits.maxSheetRows
    || value.columnCount !== 17 || JSON.stringify(value.headers) !== JSON.stringify(DAILY_ROUTE_COLUMNS)) fail('RO_DAY_METADATA');
  const native = value.nativeVersionKind === 'NATIVE_DRIVE_VERSION' && value.nativeVersionFresh === true
    && typeof value.nativeVersion === 'string' && /^[1-9]\d{0,31}$/.test(value.nativeVersion) ? value.nativeVersion : null;
  return { sourceId, sheetId, sourceScope: 'CURRENT_ONLY', lastRow: value.lastRow, columnCount: 17,
    headers: [...DAILY_ROUTE_COLUMNS], nativeVersion: native, modifiedTime: typeof value.modifiedTime === 'string' ? value.modifiedTime : null };
}
const shape = meta => JSON.stringify([meta.sourceId, meta.sheetId, meta.lastRow, meta.columnCount, meta.headers]);
function publicRow(raw, date) {
  if (!raw || raw.deliveryDate !== date || !codeValid(raw.customerCode) || !validActualVehicle(raw.confirmedVehicle)
    || raw.hashKey !== [date, raw.customerCode, raw.confirmedVehicle].join('|')) fail('RO_DAY_ROW_INVALID');
  const content = {}, withheld = [];
  for (const key of PUBLIC_DAY_FIELDS) {
    const text = publicString(raw[key]);
    if (metadataTextFields.has(key) && privatePattern.test(text)) { content[key] = ''; withheld.push(key); }
    else content[key] = text;
  }
  const name = content.customerName, address = [content.customerAddress.trim(), content.detailAddress.trim()].filter(Boolean).join(' ');
  if (name.length > 200 || address.length > 250) fail('RO_DAY_ROW_INVALID');
  return { content, row: Object.freeze({ deliveryDate: date, customerCode: raw.customerCode, confirmedVehicle: raw.confirmedVehicle,
    sourceKey: raw.hashKey, customerName: name, address, lat: null, lng: null,
    ...(withheld.length ? { metadataIssue: 'PUBLIC_METADATA_REVIEW_REQUIRED' } : {}) }), withheld };
}

export function createReadOnlyDayEvidence({ sourceId, sheetId, readMetadata, readDateColumn, readRows, now = Date.now, limits: inputLimits } = {}) {
  if (typeof sourceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sourceId) || !Number.isSafeInteger(sheetId) || sheetId < 0
    || [readMetadata, readDateColumn, readRows, now].some(fn => typeof fn !== 'function')) fail('RO_DAY_INPUT');
  const limits = checkedLimits(inputLimits), cache = new Map();
  let active = null;
  function remember(date, update) {
    const previous = cache.get(date) || { available: false, date };
    cache.delete(date); cache.set(date, { ...previous, ...update });
    while (cache.size > limits.maxCacheEntries) cache.delete(cache.keys().next().value);
  }
  function peek(date) {
    if (!isDay(date)) fail('RO_DAY_INPUT');
    const entry = cache.get(date) || { available: false, date };
    const ageMs = entry.checkedAtMs === undefined ? null : Math.max(0, now() - entry.checkedAtMs);
    const verifying = active?.date === date;
    const stale = !entry.available || verifying || !!entry.lastError || ageMs >= limits.cacheTtlMs;
    return Object.freeze({ ...entry, ageMs, stale: !!stale, status: verifying ? 'VERIFYING' : entry.lastError ? 'LAST_READ_FAILED'
      : !entry.available ? 'UNAVAILABLE' : stale ? 'STALE' : 'RECENT_OBSERVATION',
      usableForVerifiedQuery: false, requiresCaptureForQuery: true, currentnessGuaranteed: false, dataRowsCached: 0 });
  }
  async function capture({ date, proof = 'NATIVE_VERSION', signal } = {}) {
    if (!isDay(date) || !['NATIVE_VERSION', 'CONTENT_OBSERVATION'].includes(proof)) fail('RO_DAY_INPUT');
    if (active) fail('RO_DAY_BUSY');
    const controller = new AbortController(), state = { date, controller }, startedAt = now();
    const budget = { ioCalls: 0, projectedCells: 0, maximumDateChunkRows: 0, maximumTargetChunkRows: 0, selectedRowsRetained: 0 };
    let abortCode = 'RO_DAY_ABORTED', rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const stop = code => { if (!controller.signal.aborted) { abortCode = code; controller.abort(); rejectAbort(Error(code)); } };
    const onExternalAbort = () => stop('RO_DAY_ABORTED');
    const timer = setTimeout(() => stop('RO_DAY_TIMEOUT'), limits.timeoutMs);
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    active = state;
    function guard() {
      if (controller.signal.aborted) fail(abortCode);
      if (!Number.isFinite(now()) || now() - startedAt >= limits.timeoutMs) { stop('RO_DAY_TIMEOUT'); fail('RO_DAY_TIMEOUT'); }
    }
    async function invoke(fn, args, cells = 0) {
      guard();
      if (budget.ioCalls + 1 > limits.maxIoCalls) fail('RO_DAY_IO_LIMIT');
      if (budget.projectedCells + cells > limits.maxProjectedCells) fail('RO_DAY_CELL_LIMIT');
      budget.ioCalls++; budget.projectedCells += cells;
      let result;
      try { result = await fn({ ...args, sourceId, sheetId, sourceScope: 'CURRENT_ONLY', signal: controller.signal, maxResponseBytes: 262144 }); }
      catch { if (controller.signal.aborted) fail(abortCode); fail('RO_DAY_READ_FAILED'); }
      guard(); return result;
    }
    async function pass(keepRows) {
      const before = metadata(await invoke(readMetadata, {}), sourceId, sheetId, limits);
      if (proof === 'NATIVE_VERSION' && !before.nativeVersion) fail('RO_DAY_NATIVE_UNAVAILABLE');
      const dateHash = hash().update(shape(before)), positions = [];
      for (let startRow = 2; startRow <= before.lastRow; startRow += limits.dateChunkRows) {
        const count = Math.min(limits.dateChunkRows, before.lastRow - startRow + 1);
        const values = await invoke(readDateColumn, { startRow, count, columns: ['deliveryDate'] }, count);
        if (!Array.isArray(values) || values.length !== count) fail('RO_DAY_RANGE');
        if (Buffer.byteLength(JSON.stringify(values)) > 262144) fail('RO_DAY_BYTE_LIMIT');
        budget.maximumDateChunkRows = Math.max(budget.maximumDateChunkRows, count);
        for (let i = 0; i < count; i++) {
          const value = values[i], rowNumber = startRow + i;
          if (value !== '' && !isDay(value)) fail('RO_DAY_DATE_INVALID');
          dateHash.update(JSON.stringify([rowNumber, value]) + '\n');
          if (value === date) { positions.push(rowNumber); if (positions.length > limits.maxDateRows) fail('RO_DAY_CAPACITY'); }
        }
      }
      const dateColumnFingerprint = dateHash.digest('hex'), locatorFingerprint = digest(positions);
      const contentHash = hash().update(JSON.stringify([sourceId, sheetId, date, PUBLIC_DAY_FIELDS]));
      const rows = [], ranges = [], seen = new Set(); let selectedBytes = 2, withheldRows = 0;
      for (let at = 0; at < positions.length;) {
        const startRow = positions[at]; let count = 1;
        while (count < limits.rowChunkRows && at + count < positions.length && positions[at + count] === startRow + count) count++;
        const values = await invoke(readRows, { startRow, count, columns: [...PUBLIC_DAY_FIELDS] }, count * PUBLIC_DAY_FIELDS.length);
        if (!Array.isArray(values) || values.length !== count) fail('RO_DAY_RANGE');
        budget.maximumTargetChunkRows = Math.max(budget.maximumTargetChunkRows, count);
        let responseBytes = 2;
        for (let i = 0; i < count; i++) {
          const checked = publicRow(values[i], date);
          if (seen.has(checked.row.sourceKey)) fail('RO_DAY_DUPLICATE'); seen.add(checked.row.sourceKey);
          const publicContent = JSON.stringify([startRow + i, checked.content, checked.withheld]);
          responseBytes += Buffer.byteLength(publicContent) + 1;
          if (responseBytes > 262144) fail('RO_DAY_BYTE_LIMIT');
          contentHash.update(publicContent + '\n');
          selectedBytes += Buffer.byteLength(JSON.stringify(checked.row)) + 1;
          if (selectedBytes > limits.maxSelectedBytes) fail('RO_DAY_BYTE_LIMIT');
          if (checked.withheld.length) withheldRows++;
          if (keepRows) rows.push(checked.row);
        }
        if (keepRows) ranges.push(Object.freeze({ startRow, count }));
        at += count;
      }
      const after = metadata(await invoke(readMetadata, {}), sourceId, sheetId, limits);
      if (shape(before) !== shape(after) || before.modifiedTime && after.modifiedTime && before.modifiedTime !== after.modifiedTime
        || proof === 'NATIVE_VERSION' && before.nativeVersion !== after.nativeVersion) fail('RO_DAY_SOURCE_MOVED');
      return { before, after, count: positions.length, rows, ranges, dateColumnFingerprint, locatorFingerprint,
        contentFingerprint: contentHash.digest('hex'), selectedBytes, withheldRows };
    }
    async function perform() {
      if (signal?.aborted) stop('RO_DAY_ABORTED');
      const first = await pass(proof === 'NATIVE_VERSION');
      if (proof === 'CONTENT_OBSERVATION') {
        const second = await pass(false);
        if (shape(first.after) !== shape(second.before) || first.count !== second.count || first.contentFingerprint !== second.contentFingerprint
          || first.locatorFingerprint !== second.locatorFingerprint || first.dateColumnFingerprint !== second.dateColumnFingerprint
          || first.after.modifiedTime && second.before.modifiedTime && first.after.modifiedTime !== second.before.modifiedTime) fail('RO_DAY_CONTENT_MOVED');
      }
      guard();
      const checkedAtMs = now(), checkedAt = new Date(checkedAtMs).toISOString(), native = proof === 'NATIVE_VERSION';
      budget.selectedRowsRetained = native ? first.rows.length : 0;
      const evidence = Object.freeze({ kind: native ? 'NATIVE_VERSION_SNAPSHOT' : 'REPEATED_CONTENT_OBSERVATION', date, count: first.count,
        verified: native, atomic: false, consistency: native ? 'NATIVE_VERSION_BRACKETED' : 'REPEATED_CONTENT_ONLY',
        nativeVersionBracketMatched: native, readPasses: native ? 1 : 2, checkedAt, contentFingerprint: first.contentFingerprint,
        dateColumnFingerprint: first.dateColumnFingerprint, locatorFingerprint: first.locatorFingerprint, fieldsCovered: PUBLIC_DAY_FIELDS,
        withheldRows: first.withheldRows, ingestionComplete: null, coverageComplete: native, limits: Object.freeze({ ...budget }) });
      remember(date, { available: true, verified: native, evidenceKind: evidence.kind, count: first.count,
        contentFingerprint: first.contentFingerprint, checkedAt, checkedAtMs, lastError: null });
      if (!native) return Object.freeze({ sourceId, sheetId, sourceScope: 'CURRENT_ONLY', headers: [...DAILY_ROUTE_COLUMNS], date,
        revisionProof: Object.freeze({ kind: 'CONTENT_OBSERVATION' }), evidence, nativeRevisionVerified: false,
        verified: false, atomic: false, coverageComplete: false, rowsExcluded: true });
      return Object.freeze({ sourceId, sheetId, sourceScope: 'CURRENT_ONLY', headers: [...DAILY_ROUTE_COLUMNS], date,
        rows: Object.freeze(first.rows), revisionProof: Object.freeze({ kind: 'NATIVE_DRIVE_VERSION', before: first.before.nativeVersion, after: first.after.nativeVersion }),
        locator: Object.freeze({ date, scope: 'ALL_MATCHING_CURRENT_ROWS', complete: true, sourceVersion: first.before.nativeVersion,
          count: first.count, ranges: Object.freeze(first.ranges), fingerprint: first.locatorFingerprint }), evidence });
    }
    // A transport that ignores cancellation keeps this one slot until it drains.
    // A timeout never permits an unbounded set of orphan reads to accumulate.
    const work = perform().finally(() => { if (active === state) active = null; });
    try { return await Promise.race([work, aborted]); }
    catch (error) {
      const code = known.has(error?.message) ? error.message : 'RO_DAY_READ_FAILED';
      remember(date, { lastError: code }); throw Error(code);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onExternalAbort);
    }
  }
  return { capture, peek, stats: () => ({ active: !!active, cachedEvidence: cache.size, dataRowsCached: 0 }) };
}
