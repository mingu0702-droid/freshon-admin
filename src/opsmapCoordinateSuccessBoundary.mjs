import { createHash } from 'node:crypto';

// This is an opt-in local boundary around C. It contains no resolver, network,
// source writer, timer, route, trigger or publication implementation.
export const LOCAL_COORDINATE_POLICY = Object.freeze({
  externalEnabled: false, externalApproved: false,
  maxRequestsPerRun: 0, maxDailyRequests: 0, maxDailyCostMicros: 0,
  unitCostMicros: 0, maxAttempts: 1
});
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const unknown = () => ({ status: 'UNCONFIRMED', displayCoordinateCount: null, displayLabel: '좌표 미확인' });

export function createLocalCoordinateSuccessBoundary({ createOpsmapCDailyCandidate, coordinates = {}, enabled = false,
  syntheticTestProvider = null, syntheticTestPolicy = {} } = {}) {
  if (syntheticTestProvider && (syntheticTestProvider.kind !== 'mock' || typeof syntheticTestProvider.lookup !== 'function')) throw Error('SYNTHETIC_MOCK_PROVIDER_REQUIRED');
  const tickets = new WeakMap(), latestByDate = new Map();
  let sequence = 0, candidate;
  if (enabled === true) {
    if (typeof createOpsmapCDailyCandidate !== 'function') throw Error('C_DAILY_FACTORY_REQUIRED');
    candidate = createOpsmapCDailyCandidate({ coordinates: {
      store: coordinates.store, verifiedCoordinates: coordinates.verifiedCoordinates,
      addressCoordinateCache: coordinates.addressCoordinateCache, now: coordinates.now,
      geocoder: syntheticTestProvider, policy: syntheticTestProvider ? { ...syntheticTestPolicy,
        externalEnabled: false, externalApproved: false, maxDailyCostMicros: 0, unitCostMicros: 0 } : LOCAL_COORDINATE_POLICY
    }});
  }
  function begin(date) {
    if (!validDate(date)) throw Error('COORDINATE_CALLBACK_DATE_INVALID');
    const ticket = Object.freeze({});
    const state = { date, sequence: ++sequence, started: false };
    tickets.set(ticket, state);
    latestByDate.delete(date); latestByDate.set(date, state.sequence);
    if (latestByDate.size > 64) latestByDate.delete(latestByDate.keys().next().value);
    return ticket;
  }
  const active = state => latestByDate.get(state.date) === state.sequence;
  async function afterCustomerDailyCollection(result, { ticket, envelope, collectionComplete = false,
    sourceSnapshotHash, expectedVisits } = {}) {
    const stopped = status => ({ status, applied: false, envelope, coordinates: unknown() });
    if (enabled !== true) return stopped('OFF');
    if (syntheticTestProvider && envelope?.meta?.coordinateInputScope !== 'SYNTHETIC_FIXTURE_ONLY') return stopped('SYNTHETIC_INPUT_REQUIRED');
    const state = tickets.get(ticket);
    if (!state || !active(state)) return stopped('STALE_OR_UNBOUND_CALLBACK');
    if (state.started) return stopped('DUPLICATE_CALLBACK');
    if (!Array.isArray(envelope?.data) || envelope.data.length > 5000 ||
        envelope.meta?.date !== state.date || envelope.meta.published !== false || envelope.meta.productionEligible !== false ||
        envelope.meta.businessCoverageVerified !== false || !validHash(sourceSnapshotHash) ||
        envelope.meta.sourceCandidateHash !== sourceSnapshotHash || !Number.isSafeInteger(expectedVisits) ||
        expectedVisits < 0 || expectedVisits > 5000 || envelope.meta.returnedVisits !== expectedVisits) return stopped('SOURCE_BINDING_REJECTED');
    if (!Array.isArray(result?.rows) || ![result.added, result.updated ?? 0, result.skipped, result.failed].every(n => Number.isSafeInteger(n) && n >= 0) ||
        result.failed !== 0 || result.added + (result.updated ?? 0) + result.skipped !== result.rows.length) return stopped('CUSTOMER_RECEIPT_REJECTED');
    state.started = true;
    try {
      const envelopeHash = hash(envelope);
      const run = await candidate.afterCustomerDailyCollection(result, {
        date: state.date, collectionComplete, businessCoverageVerified: false, sourceSnapshotHash, expectedVisits
      });
      if (!active(state)) return stopped('STALE_OR_UNBOUND_CALLBACK');
      if (hash(envelope) !== envelopeHash) return stopped('SOURCE_CHANGED_DURING_CALLBACK');
      if (run?.collection?.status !== 'SUCCEEDED' || !run.state) return stopped('COORDINATE_PROCESSING_FAILED');
      const projected = candidate.projectDayEnvelope(envelope, run);
      // The projected compact envelope is returned only to the existing caller;
      // raw result rows, hashes, private state and provider errors are not returned.
      return { status: 'PROJECTED_LOCAL_ONLY', applied: true, envelope: projected,
        collection: { status: 'SUCCEEDED', businessCoverage: 'UNCONFIRMED' }, coordinates: projected.meta.coordinateStatus };
    } catch {
      return stopped('COLLECTION_OR_PROJECTION_REJECTED');
    }
  }
  return Object.freeze({ begin, afterCustomerDailyCollection });
}
