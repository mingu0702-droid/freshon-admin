import { createHash } from 'node:crypto';
import { projectStoredCoordinateDisplay } from './opsmapStoredCoordinateDisplay.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const codeOK = value => typeof value === 'string' && /^[A-Z]\d{1,20}$/.test(value);
const pointOK = value => Number.isFinite(value?.lat) && Number.isFinite(value?.lng) && value.lat >= 33 && value.lat <= 39.5 && value.lng >= 124 && value.lng <= 132;
const same = (a, b) => Math.abs(a.lat - b.lat) <= 0.00001 && Math.abs(a.lng - b.lng) <= 0.00001;
export const ADDRESS_RULE = 'NFKC_LOWERCASE_WS_TRIM_SHA256_UTF8_V1';
// This boundary accepts private, hash-only observations, never raw addresses.
// Cached RAW_GPS is historical evidence, not a field-location certification.
export function joinCurrentCoordinateCache({ envelope, current, cache, pin } = {}) {
  const stable = source => /^\d{1,32}$/.test(String(source?.versionBefore ?? '')) && String(source.versionBefore) === String(source.versionAfter);
  const sourceBound = source => source?.spreadsheetId === pin?.spreadsheetId && typeof pin.spreadsheetId === 'string' && pin.spreadsheetId.length > 10 && Number.isSafeInteger(source.sheetId) && source.sheetId >= 0 && (typeof source.range === 'string' && source.range.length > 0 || Array.isArray(source.ranges) && source.ranges.length > 0 && source.ranges.length <= 3 && source.ranges.every(range => typeof range === 'string' && range.length > 0));
  if (!Array.isArray(envelope?.data) || envelope.data.length > 5000 || envelope.meta?.date !== pin?.date || envelope.meta.published !== false || envelope.meta.productionEligible !== false || envelope.meta.businessCoverageVerified !== false ||
      !isHash(pin.envelopeSha256) || hash(JSON.stringify(envelope)) !== pin.envelopeSha256 ||
      current?.schema !== 'opsmap-private-customer-address-v1' || current.date !== pin.date || current.rule !== ADDRESS_RULE || !stable(current.source) || !sourceBound(current.source) ||
      cache?.schema !== 'opsmap-current-coordinate-cache-v1' || cache.addressRule !== ADDRESS_RULE || !stable(cache.source) || !sourceBound(cache.source) ||
      String(cache.source.versionBefore) !== String(current.source.versionBefore) || !Array.isArray(current.rows) || current.rows.length > 5000 || !Array.isArray(cache.rows) || cache.rows.length > 10000 ||
      !isHash(pin.currentSha256) || hash(JSON.stringify(current)) !== pin.currentSha256 || !isHash(pin.cacheSha256) || hash(JSON.stringify(cache)) !== pin.cacheSha256) throw Error('CACHE_JOIN_PIN_OR_SOURCE_UNVERIFIED');
  const currentByCode = new Map(), candidates = new Map();
  for (const row of current.rows) {
    if (!row || Object.keys(row).some(k => !['customerCode', 'deliveryDate', 'addressHash', 'deliveryRows'].includes(k)) || row.deliveryDate !== pin.date || !codeOK(row.customerCode) || !isHash(row.addressHash) || row.deliveryRows !== undefined && (!Number.isSafeInteger(row.deliveryRows) || row.deliveryRows < 1)) throw Error('CACHE_JOIN_CURRENT_ROW_INVALID');
    const old = currentByCode.get(row.customerCode);
    if (old && old !== row.addressHash) throw Error('CACHE_JOIN_CURRENT_ADDRESS_CONFLICT');
    currentByCode.set(row.customerCode, row.addressHash);
  }
  const codes = envelope.data.map(row => row[0]);
  if (new Set(codes).size !== codes.length || currentByCode.size !== codes.length || current.rows.length !== codes.length && current.rows.length !== envelope.meta.returnedVisits || codes.some(code => !codeOK(code) || !currentByCode.has(code))) throw Error('CACHE_JOIN_COVERAGE_MISMATCH');
  for (const row of cache.rows) {
    if (!row || Object.keys(row).some(k => !['customerCode','addressHash','lat','lng','source','status','updatedAt','reference'].includes(k)) || !codeOK(row.customerCode) || !isHash(row.addressHash) || typeof row.reference !== 'string' || row.reference.length > 256) throw Error('CACHE_JOIN_CACHE_ROW_INVALID');
    const rows = candidates.get(row.customerCode) || []; rows.push(row); candidates.set(row.customerCode, rows);
  }
  let before = 0, matched = 0, intersection = 0, added = 0, conflicts = 0, preserved = 0;
  const reasons = {}, decisions = [];
  const data = envelope.data.map(tuple => {
    const next = [...tuple], customerCode = tuple[0], old = { lat: tuple[3], lng: tuple[4] }, hasOld = pointOK(old);
    if (hasOld) before++;
    const all = candidates.get(customerCode) || [], addressHash = currentByCode.get(customerCode);
    const valid = all.filter(row => row.addressHash === addressHash && row.status === 'OK' && row.source === 'RAW_GPS' && pointOK(row));
    const candidate = valid[0];
    let reason;
    if (candidate && valid.some(row => !same(candidate, row))) { conflicts++; reason = 'CACHE_DUPLICATE_POINT_CONFLICT_HELD'; }
    else if (candidate) {
      matched++;
      if (hasOld) intersection++;
      if (hasOld && !same(old, candidate)) { conflicts++; reason = 'EXISTING_POINT_CONFLICT_HELD'; }
      else { next[3] = candidate.lat; next[4] = candidate.lng; if (!hasOld) added++; reason = hasOld ? 'PRESERVED_EXACT_CACHE_MATCH' : 'ADDED_EXACT_CACHE_MATCH'; }
    } else reason = all.length ? 'CACHE_ADDRESS_STATUS_OR_POINT_MISMATCH' : 'CACHE_CUSTOMER_ABSENT';
    if (hasOld) preserved++;
    reasons[reason] = (reasons[reason] || 0) + 1;
    decisions.push({ customerCode, addressHash, reason, references: all.map(row => row.reference) });
    return next;
  });
  const totalCoordinates = before + added;
  return { envelope: { ...envelope, data, meta: { ...envelope.meta,
    coordinateStatus: { ...envelope.meta.coordinateStatus, status: conflicts ? 'PARTIAL_HELD' : 'PARTIAL', total: codes.length, displayCoordinateCount: totalCoordinates, unknown: codes.length - totalCoordinates, displayLabel: `좌표 ${totalCoordinates}개 · 나머지 미확인` },
    coordinateProvenance: { ...envelope.meta.coordinateProvenance, present:totalCoordinates, source:'CURRENT_HASH_AND_HISTORICAL_RAW_GPS_CACHE', verification:'UNCONFIRMED', collectionReceiptAvailable:false },
    coordinateCacheJoin: { date: pin.date, sourceVersion: String(current.source.versionAfter), status: conflicts ? 'PARTIAL_HELD' : 'PARTIAL', totalCoordinates, unknown: codes.length - totalCoordinates, fieldAccuracyVerified: false, businessCoverageVerified: false } } },
    summary: { customers: codes.length, before, matchedCache: matched, intersection, added, preserved, pointConflicts: conflicts, totalCoordinates, unknown: codes.length - totalCoordinates, reasons }, decisions,
    proof: { ...pin, rawAddressesRetained: false, writes: 0, published: false, sourceVersion: String(current.source.versionAfter), addressRule: ADDRESS_RULE, cacheFreshness: 'HISTORICAL_NOT_FIELD_ACCURACY_CERTIFIED' } };
}

// Existing display projection remains the baseline. The private reader's two
// validated outputs enter only after it; absent/unpinned observations throw and
// cannot mutate the baseline or silently activate user-reported aggregate data.
export function projectCurrentCustomerCache({ storedDisplayOptions, current, cache, pin } = {}) {
  const baseline = projectStoredCoordinateDisplay(storedDisplayOptions);
  const result = joinCurrentCoordinateCache({ envelope:baseline.envelope, current, cache, pin });
  return { ...result, baselineProof:baseline.proof, baselineSummary:baseline.summary };
}


