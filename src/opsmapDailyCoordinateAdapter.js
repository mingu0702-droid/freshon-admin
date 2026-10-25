import { createHash } from 'node:crypto';
import { createCoordinateIngestion } from './opsmapCoordinateIngestion.js';
import { coordinateAddressHash } from './opsmapAutoCoordinates.js';

export const coordinateContractHash = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const hashValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const codeValid = value => typeof value === 'string' && /^[A-Z]\d{1,20}$/.test(value);
const dayValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const pointValid = row => typeof row?.lat === 'number' && typeof row?.lng === 'number' && Number.isFinite(row.lat) && Number.isFinite(row.lng) && row.lat >= 33 && row.lat <= 39.5 && row.lng >= 124 && row.lng <= 132;
const samePoint = (a, b) => Math.abs(a.lat - b.lat) <= 0.00001 && Math.abs(a.lng - b.lng) <= 0.00001;

/** Private, pinned B input bridge. The addressless B overlay is snapshot-bound;
 * a future day must still provide its own current customer address evidence. */
export function normalizeBVerifiedCoordinates({ dayEnvelope, hubRows, recoveredEvidence, pins = {} } = {}) {
  if (!Array.isArray(dayEnvelope?.data) || !Array.isArray(hubRows) || !Array.isArray(recoveredEvidence?.evidence) ||
      dayEnvelope.data.length > 5000 || hubRows.length > 50000 || recoveredEvidence.evidence.length > 50000 ||
      !dayValid(dayEnvelope.meta?.date)) throw Error('B_COORDINATE_INPUT_INVALID');
  for (const [name, value] of Object.entries({ dayDataHash: dayEnvelope.data, hubRowsHash: hubRows, recoveredEvidenceHash: recoveredEvidence })) {
    if (!hashValid(pins[name]) || coordinateContractHash(value) !== pins[name]) throw Error('B_COORDINATE_INPUT_PIN_MISMATCH');
  }
  const byHub = new Map(), recovered = new Map(), seen = new Set(), rows = [], rejected = {};
  for (const row of hubRows) { if (byHub.has(row[0])) throw Error('B_COORDINATE_CUSTOMER_DUPLICATE'); byHub.set(row[0], row); }
  for (const row of recoveredEvidence.evidence) { if (recovered.has(row.customerCode)) throw Error('B_COORDINATE_CUSTOMER_DUPLICATE'); recovered.set(row.customerCode, row); }
  const reject = reason => { rejected[reason] = (rejected[reason] || 0) + 1; };
  for (const tuple of dayEnvelope.data) {
    const code = tuple[0];
    if (!codeValid(code) || seen.has(code)) throw Error('B_COORDINATE_CUSTOMER_DUPLICATE'); seen.add(code);
    const point = { lat: tuple[3], lng: tuple[4] }, hub = byHub.get(code);
    if (!pointValid(point)) { reject('NO_VERIFIED_COORDINATE'); continue; }
    if (!hub || hub[1] !== tuple[1]) { reject('CUSTOMER_IDENTITY_MISMATCH'); continue; }
    const addressHash = coordinateAddressHash(hub[2]);
    if (!addressHash) { reject('ADDRESS_REQUIRED'); continue; }
    const evidence = recovered.get(code);
    if (evidence) {
      const observed = Date.parse(evidence.source?.sourceUpdatedAt);
      if (evidence.addressHash !== addressHash || evidence.customerNameHash !== coordinateContractHash(tuple[1]) || !pointValid(evidence) || !samePoint(point, evidence) ||
          evidence.source?.coordinateSource !== 'RAW_GPS' || evidence.source?.geocodeStatus !== 'OK' ||
          !Number.isFinite(observed) || observed > Date.parse(dayEnvelope.meta.date + 'T23:59:59+09:00')) { reject('B_EVIDENCE_MISMATCH'); continue; }
    } else if (!pointValid({ lat: hub[3], lng: hub[4] }) || !samePoint(point, { lat: hub[3], lng: hub[4] })) { reject('EXISTING_HUB_COORDINATE_MISMATCH'); continue; }
    rows.push({ customerCode: code, addressHash, ...point, coordinateSource: evidence ? 'RAW_GPS' : 'STORED_MATCH', geocodeStatus: 'OK', verified: true });
  }
  return { schema: 'opsmap-c-verified-customer-address-v1', rows, summary: { sourceStores: dayEnvelope.data.length, accepted: rows.length, rejected: dayEnvelope.data.length - rows.length, reasons: rejected }, pins: { ...pins } };
}

/** Accept only a successful return from Customer's existing
 * freshonImportDailyDispatchForDateRender_(date, rebuildMapCache).
 * This module installs no trigger and never calls or writes Customer/Hub. */
export function normalizeCustomerDailyCollection(result, {
  date, collectionComplete = false, businessCoverageVerified = false, sourceSnapshotHash = null, expectedVisits
} = {}) {
  if (!dayValid(date) || collectionComplete !== true || !Array.isArray(result?.rows) || result.rows.length > 5000 ||
      result.ok === false || result.status && !['DONE', 'OK', 'SUCCEEDED'].includes(result.status) ||
      ![result.added, result.updated ?? 0, result.skipped, result.failed].every(n => Number.isSafeInteger(n) && n >= 0) || result.failed !== 0 ||
      result.added + (result.updated ?? 0) + result.skipped !== result.rows.length || expectedVisits !== undefined && expectedVisits !== result.rows.length ||
      sourceSnapshotHash !== null && !hashValid(sourceSnapshotHash)) throw Error('CUSTOMER_DAILY_COLLECTION_INCOMPLETE');
  const rows = result.rows.map(row => {
    if (!row || row.deliveryDate !== date) throw Error('CUSTOMER_DAILY_COLLECTION_DATE_MISMATCH');
    const event = { customerCode: row.customerCode, customerAddress: row.customerAddress ?? row.address ?? '', deliveryDate: date };
    for (const key of ['sourceUpdatedAt', 'updatedAt', 'active', 'closed', 'customerStatus', 'lifecycleStatus', 'operation']) if (row[key] !== undefined) event[key] = row[key];
    return event;
  });
  return { rows, collection: { status: 'SUCCEEDED', complete: true, date, visits: rows.length, uniqueCustomers: new Set(rows.map(row => row.customerCode)).size,
    businessCoverage: businessCoverageVerified === true ? 'VERIFIED' : 'UNCONFIRMED', sourceSnapshotHash } };
}

const failureReasons = new Set(['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_AUTH_REQUIRED', 'PROVIDER_REQUEST_REJECTED', 'PROVIDER_RATE_LIMIT', 'PROVIDER_BLOCKED', 'RETRY_EXHAUSTED']);
function summarize(normalized, result) {
  const codes = [...new Set(normalized.rows.map(row => row.customerCode))], reasons = {};
  const currentAddresses = new Map();
  for (const row of normalized.rows) {
    const hashes = currentAddresses.get(row.customerCode) || new Set(); hashes.add(coordinateAddressHash(row.customerAddress)); currentAddresses.set(row.customerCode, hashes);
  }
  let matched = 0, inactive = 0, unknown = 0, failed = 0;
  for (const code of codes) {
    const record = result.state.customers[code];
    const addresses = currentAddresses.get(code);
    if (record?.status === 'READY' && (addresses.size !== 1 || !addresses.has(record.addressHash))) { unknown++; reasons.CURRENT_ADDRESS_UNCONFIRMED = (reasons.CURRENT_ADDRESS_UNCONFIRMED || 0) + 1; }
    else if (record?.status === 'READY') matched++;
    else if (record?.status === 'INACTIVE') inactive++;
    else { const reason = record?.reason || 'CUSTOMER_CODE_INVALID'; reasons[reason] = (reasons[reason] || 0) + 1; if (failureReasons.has(reason)) failed++; else unknown++; }
  }
  const coverageVerified = normalized.collection.businessCoverage === 'VERIFIED';
  const status = unknown + failed ? matched ? 'PARTIAL' : 'UNCONFIRMED' : coverageVerified ? 'COMPLETE' : 'COVERAGE_UNCONFIRMED';
  return { status, matched, failed, unknown, inactive, total: codes.length, reasons, requests: result.metrics.requests,
    reused: result.metrics.reused, addressCacheReused: result.metrics.addressCacheReused, geocoded: result.metrics.geocoded,
    displayCoordinateCount: matched > 0 ? matched : status === 'COMPLETE' ? 0 : null,
    displayLabel: matched > 0 ? `좌표 ${matched}개` : status === 'COMPLETE' ? '좌표 0개' : '좌표 미확인' };
}

export function createDailyCoordinateAdapter(options = {}) {
  const ingestion = createCoordinateIngestion(options);
  return {
    async afterCustomerDailyCollection(result, context) {
      const normalized = normalizeCustomerDailyCollection(result, context);
      try {
        const resolved = await ingestion.ingest(normalized.rows);
        const currentAddresses = {};
        for (const event of normalized.rows) {
          const hash = coordinateAddressHash(event.customerAddress), previous = currentAddresses[event.customerCode];
          currentAddresses[event.customerCode] = previous && previous !== hash ? 'CONFLICT' : hash;
        }
        return { ...resolved, collection: normalized.collection, coordinates: summarize(normalized, resolved), currentAddresses };
      } catch {
        // Collection is already complete; coordinate storage/provider setup failure
        // must neither rewrite its success nor publish a normal zero-coordinate day.
        return { collection: normalized.collection, coordinates: { status: 'FAILED', matched: 0, failed: normalized.collection.uniqueCustomers,
          unknown: 0, inactive: 0, total: normalized.collection.uniqueCustomers, reasons: { COORDINATE_PROCESSING_FAILED: normalized.collection.uniqueCustomers }, displayCoordinateCount: null, displayLabel: '좌표 미확인' },
          state: null, currentAddresses: {}, candidates: [], review: [] };
      }
    },
    projectDayEnvelope: projectDailyCoordinateEnvelope
  };
}

/** Source hash + date + each current address must agree before touching compact
 * tuples. Historical B code overlap alone is deliberately insufficient. */
export function projectDailyCoordinateEnvelope(envelope, run) {
  if (!Array.isArray(envelope?.data) || envelope.data.length > 5000 || run?.collection?.status !== 'SUCCEEDED' || !run.state ||
      run.collection.date !== envelope.meta?.date || !hashValid(run.collection.sourceSnapshotHash) ||
      envelope.meta?.sourceCandidateHash !== run.collection.sourceSnapshotHash) throw Error('COORDINATE_PROJECTION_SOURCE_UNVERIFIED');
  const projectedCodes = new Set(envelope.data.map(tuple => tuple[0]));
  if (projectedCodes.size !== envelope.data.length || projectedCodes.size !== run.collection.uniqueCustomers ||
      [...projectedCodes].some(code => !Object.hasOwn(run.currentAddresses, code))) throw Error('COORDINATE_PROJECTION_COVERAGE_MISMATCH');
  let present = 0, preservedExisting = 0;
  const existingAddressHashes = run.existingAddressHashes || {};
  const revokedCustomerCodes = new Set(run.revokedCustomerCodes || []);
  const data = envelope.data.map(tuple => {
    const next = [...tuple], record = run.state.customers[tuple[0]], hash = run.currentAddresses[tuple[0]];
    if (!hashValid(hash) || record?.addressHash !== hash || record.status !== 'READY' || !pointValid(record)) {
      const existing = { lat: tuple[3], lng: tuple[4] }, previous = run.previousCoordinates?.[tuple[0]];
      const oldHash = existingAddressHashes[tuple[0]] || (pointValid(previous) && samePoint(existing, previous) ? previous.addressHash : null);
      const changed = hashValid(oldHash) && hashValid(hash) && oldHash !== hash;
      const conflict = hash === 'CONFLICT' || ['SOURCE_EVENT_CONFLICT', 'VERIFIED_COORDINATE_CONFLICT', 'ADDRESS_CACHE_CONFLICT'].includes(record?.reason);
      const revoked = revokedCustomerCodes.has(tuple[0]) || record?.status === 'INACTIVE' || changed || conflict;
      const sameAddressProved = hashValid(hash) && oldHash === hash;
      if (pointValid(existing) && !revoked && (!record || sameAddressProved)) {
        present++; preservedExisting++; return next;
      }
      next[3] = null; next[4] = null; return next;
    }
    const previous = run.previousCoordinates?.[tuple[0]], existing = { lat: tuple[3], lng: tuple[4] };
    const oldHash = existingAddressHashes[tuple[0]] || (pointValid(previous) && samePoint(existing, previous) ? previous.addressHash : null);
    if (pointValid(existing) && !samePoint(record, existing) && (!hashValid(oldHash) || oldHash === hash)) throw Error('COORDINATE_PROJECTION_POINT_CONFLICT');
    next[3] = record.lat; next[4] = record.lng; present++; return next;
  });
  return { ...envelope, data, meta: { ...envelope.meta, coordinateStatus: { ...run.coordinates, preservedExisting,
      displayCoordinateCount: present > 0 ? present : run.coordinates.displayCoordinateCount },
    coordinateReadiness: run.coordinates.status, coordinateCompleteness: run.coordinates.status === 'COMPLETE' ? 'VERIFIED' : 'UNCONFIRMED',
    coordinateProvenance: { ...envelope.meta.coordinateProvenance, joined: true, present, source: 'C_DAILY_CANDIDATE',
      verification: run.coordinates.status === 'COMPLETE' ? 'VERIFIED' : 'UNCONFIRMED' } } };
}
