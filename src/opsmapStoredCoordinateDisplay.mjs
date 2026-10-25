import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validCode = value => typeof value === 'string' && /^[A-Z]\d{1,20}$/.test(value);
const validPoint = row => typeof row?.lat === 'number' && typeof row?.lng === 'number' && Number.isFinite(row.lat) && Number.isFinite(row.lng) &&
  row.lat >= 33 && row.lat <= 39.5 && row.lng >= 124 && row.lng <= 132;
const samePoint = (a, b) => Math.abs(a.lat - b.lat) <= 0.00001 && Math.abs(a.lng - b.lng) <= 0.00001;
const sources = new Set(['MANUAL_VERIFIED', 'STORED_MATCH', 'RAW_GPS', 'KAKAO_EXACT_ADDRESS', 'GEOCODE_EXACT']);

// Exact code/address-hash display join only. This consumes C-normalized verified
// points and current private hash evidence; it never creates a collection receipt
// or invokes C collection/geocoding/storage/publication machinery.
export function projectStoredCoordinateDisplay({ sourceBytes, targetPin, currentAddressEvidence, verifiedCoordinates, existingAddressHashes = {} } = {}) {
  const bytes = typeof sourceBytes === 'string' ? Buffer.from(sourceBytes, 'utf8') : sourceBytes;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1024 * 1024 || !validHash(targetPin?.inputFileSha256) ||
      !validHash(targetPin?.sourceCandidateHash) || sha(bytes) !== targetPin.inputFileSha256) throw Error('STORED_DISPLAY_INPUT_PIN_MISMATCH');
  const envelope = JSON.parse(Buffer.from(bytes).toString('utf8')), meta = envelope.meta, evidence = currentAddressEvidence;
  if (!Array.isArray(envelope.data) || envelope.data.length > 5000 || meta?.date !== targetPin.date ||
      meta.sourceCandidateHash !== targetPin.sourceCandidateHash || meta.published !== false || meta.productionEligible !== false ||
      meta.businessCoverageVerified !== false || !Number.isSafeInteger(meta.returnedVisits) || meta.returnedVisits < 0 || meta.returnedVisits > 5000 ||
      evidence?.schema !== 'opsmap-current-address-hashes-v1' || evidence.date !== targetPin.date ||
      evidence.target?.fileSha256 !== targetPin.inputFileSha256 || evidence.target?.sourceCandidateHash !== targetPin.sourceCandidateHash ||
      !/^\d{1,32}$/.test(String(evidence.source?.versionBefore ?? '')) || String(evidence.source.versionBefore) !== String(evidence.source.versionAfter) ||
      !Array.isArray(evidence.rows) || evidence.rows.length > 5000 || !Array.isArray(verifiedCoordinates) || verifiedCoordinates.length > 50000) throw Error('STORED_DISPLAY_SOURCE_UNVERIFIED');
  const codes = new Set(envelope.data.map(tuple => tuple[0]));
  if (codes.size !== envelope.data.length || [...codes].some(code => !validCode(code))) throw Error('STORED_DISPLAY_CUSTOMER_COVERAGE_MISMATCH');
  const current = new Map();
  for (const row of evidence.rows) {
    if (!row || Object.keys(row).some(key => !['customerCode', 'addressHash'].includes(key)) || !validCode(row.customerCode) || !validHash(row.addressHash)) throw Error('STORED_DISPLAY_HASH_ROW_INVALID');
    const hashes = current.get(row.customerCode) || new Set(); hashes.add(row.addressHash); current.set(row.customerCode, hashes);
  }
  if (current.size !== codes.size || [...codes].some(code => !current.has(code)) ||
      evidence.rows.length !== meta.returnedVisits && evidence.rows.length !== codes.size) throw Error('STORED_DISPLAY_CUSTOMER_COVERAGE_MISMATCH');
  const points = new Map(), verifiedCustomers = new Set();
  for (const row of verifiedCoordinates) {
    if (!validCode(row?.customerCode) || !validHash(row.addressHash) || !validPoint(row) || row.verified !== true ||
        row.geocodeStatus !== 'OK' || !sources.has(row.coordinateSource || row.source)) continue;
    verifiedCustomers.add(row.customerCode);
    const key = row.customerCode + ':' + row.addressHash, previous = points.get(key);
    points.set(key, previous === 'CONFLICT' || previous && !samePoint(previous, row) ? 'CONFLICT' : row);
  }
  const reasons = {};
  let matched = 0, preservedExisting = 0, unknown = 0, present = 0, revoked = 0;
  const data = envelope.data.map(tuple => {
    const next = [...tuple], code = tuple[0], hashes = current.get(code), existing = { lat: tuple[3], lng: tuple[4] };
    const currentHash = hashes.size === 1 ? hashes.values().next().value : null;
    if (Object.hasOwn(existingAddressHashes, code) && !validHash(existingAddressHashes[code])) throw Error('STORED_DISPLAY_EXISTING_HASH_INVALID');
    const addressChanged = currentHash && existingAddressHashes[code] && existingAddressHashes[code] !== currentHash;
    const point = currentHash ? points.get(code + ':' + currentHash) : null;
    if (point && point !== 'CONFLICT') {
      if (validPoint(existing) && !samePoint(existing, point) && !addressChanged) throw Error('STORED_DISPLAY_POINT_CONFLICT');
      next[3] = point.lat; next[4] = point.lng; matched++; present++; return next;
    }
    unknown++;
    const reason = !currentHash ? 'CURRENT_ADDRESS_CONFLICT' : point === 'CONFLICT' ? 'VERIFIED_COORDINATE_CONFLICT' :
      verifiedCustomers.has(code) ? 'VERIFIED_ADDRESS_HASH_MISMATCH_CAUSE_UNKNOWN' : 'NO_VERIFIED_CUSTOMER_POINT';
    reasons[reason] = (reasons[reason] || 0) + 1;
    // Missing/failed new evidence cannot erase a valid existing point. Actual
    // changed-address proof or contradictory evidence explicitly revokes it.
    if (validPoint(existing) && !addressChanged && currentHash && point !== 'CONFLICT') { preservedExisting++; present++; }
    else { if (validPoint(existing)) revoked++; next[3] = null; next[4] = null; }
    return next;
  });
  const coordinates = { status: present > 0 ? 'PARTIAL' : 'UNCONFIRMED', matched, unknown, failed: 0,
    total: codes.size, preservedExisting, revoked, reasons, displayCoordinateCount: present > 0 ? present : null,
    displayLabel: present > 0 ? `좌표 ${present}개 · 나머지 미확인` : '좌표 미확인' };
  const hashRows = [...current].sort(([a], [b]) => a.localeCompare(b)).map(([code, hashes]) => [code, [...hashes].sort()]);
  return {
    envelope: { ...envelope, data, meta: { ...meta, coordinateStatus: coordinates, coordinateReadiness: 'PARTIAL', coordinateCompleteness: 'UNCONFIRMED',
      coordinateProvenance: { ...meta.coordinateProvenance, joined: true, present, source: 'C_STORED_ADDRESS_HASH_DISPLAY_ONLY',
        verification: 'UNCONFIRMED', collectionReceiptAvailable: false } } },
    summary: { ...coordinates, currentHashRows: evidence.rows.length, sourceVersion: String(evidence.source.versionAfter) },
    proof: { date: targetPin.date, inputFileSha256: targetPin.inputFileSha256, sourceCandidateHash: targetPin.sourceCandidateHash,
      canonicalCurrentHashEvidenceSha256: sha(JSON.stringify(hashRows)), collectionReceiptAvailable: false,
      addressNormalization: 'HASH_ONLY_NO_RAW_ADDRESS_RENORMALIZATION', addressChangeCause: 'UNKNOWN_WITHOUT_RAW_ADDRESS_EVIDENCE',
      rawAddressesRetained: false, published: false, productionEligible: false, businessCoverage: 'UNCONFIRMED' }
  };
}
