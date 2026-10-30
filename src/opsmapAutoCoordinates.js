// Candidate-only resolver. No network, source writes, publication or trigger APIs.
import { createHash } from 'node:crypto';

const sha = text => createHash('sha256').update(String(text), 'utf8').digest('hex');
const queues = new WeakMap();
const codeValid = value => typeof value === 'string' && /^[A-Z]\d{1,20}$/.test(value);
const pointValid = row => typeof row?.lat === 'number' && typeof row?.lng === 'number' &&
  Number.isFinite(row.lat) && Number.isFinite(row.lng) && row.lat >= 33 && row.lat <= 39.5 && row.lng >= 124 && row.lng <= 132;
const sensitive = /[\r\n\x00-\x1f]|비밀|비번|암호|출입|공동현관|현관|도어|잠금|패스워드|연락처|전화|연락|password|passcode|access\s*code|https?:|@|(?:\+?82[- ]?)?01[016789][- ]?\d{3,4}[- ]?\d{4}|[#*]/i;
const knownSources = new Set(['MANUAL_PIN', 'MANUAL_VERIFIED', 'STORED_MATCH', 'KAKAO_EXACT_ADDRESS', 'RAW_GPS', 'GEOCODE_EXACT']);

// Exactly the Customer map_coordinate_cache_v2 addressHash normalization.
export const normalizeCoordinateAddress = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim() : '';
export const coordinateAddressHash = value => { const text = normalizeCoordinateAddress(value); return text ? sha(text) : ''; };
// Private preparation only: never serialize rawBasic/rawDetail to a map/cache response.
// Identity uses the unchanged Customer hash rule; a simplified search is separate evidence.
export function preparePrivateCoordinateAddress(basicAddress, detailAddress = '') {
  const rawBasic = typeof basicAddress === 'string' ? basicAddress : '';
  const rawDetail = typeof detailAddress === 'string' ? detailAddress : '';
  const normalizedBasic = normalizeCoordinateAddress(rawBasic), normalizedDetail = normalizeCoordinateAddress(rawDetail);
  const buildingHints = [];
  let query = rawBasic.normalize('NFKC').replace(/\s+/g, ' ').trim();
  // Numeric land/building identifiers in the actual address are never rewritten.
  query = query.replace(/\(([^()]*)\)/g, (whole, text) => {
    if (/(?:빌딩|상가|아파트|타워|건물|센터|오피스텔)/.test(text) && !sensitive.test(text)) { buildingHints.push(text.trim()); return ' '; }
    return whole;
  }).replace(/\s+/g, ' ').trim();
  const suffix = query.match(/\s+((?:지하\s*)?\d+\s*층(?:\s*\d+\s*호)?|\d+\s*호)\s*$/);
  const prefix = suffix ? query.slice(0, suffix.index).trim() : '';
  const separableUnit = suffix && /(?:(?:대로|로|길)\s+(?:지하\s+)?|(?:동|읍|면|리)\s+(?:산\s*)?)\d+(?:-\d+)?/.test(prefix);
  const unitHint = separableUnit ? suffix[1] : null;
  if (separableUnit) query = prefix;
  const safeQuery = externalCoordinateAddress(query);
  const addressKind = /(?:대로|로|길)\s+(?:지하\s+)?\d+(?:-\d+)?/.test(query) ? 'ROAD' : /(?:동|읍|면|리)\s+(?:산\s*)?\d+(?:-\d+)?/.test(query) ? 'LOT' : 'UNCONFIRMED';
  return { rawBasic, rawDetail, normalizedBasic, normalizedDetail,
    addressHash: coordinateAddressHash(rawBasic), ruleVersion: 'NFKC_LOWERCASE_WS_TRIM_SHA256_UTF8_V1',
    query: safeQuery, queryHash: safeQuery ? coordinateAddressHash(safeQuery) : null,
    queryRuleVersion: 'NFKC_WS_BUILDING_UNIT_SPLIT_V1', addressKind, buildingHints, unitHint,
    status: safeQuery ? 'QUERY_PREPARED' : 'PRIVATE_OR_AMBIGUOUS_ADDRESS',
    geocodedAccuracy: 'BUILDING', storeInteriorVerified: false };
}
export function externalCoordinateAddress(value) {
  if (typeof value !== 'string' || sensitive.test(value)) return null;
  const text = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  // Preserve address precision; do not guess by stripping access notes or building/unit suffixes.
  if (text.length < 8 || text.length > 200 || sensitive.test(text) ||
      !/^[가-힣a-zA-Z0-9 ()·.,\-]+$/.test(text) || !/[가-힣]/.test(text) ||
      !/(?:시|군|구|읍|면|동|로|길|리)/.test(text) || !/\d/.test(text)) return null;
  return text;
}
export const createCoordinateState = () => ({ schema: 1, customers: {}, requests: {}, budgets: {} });

function time(value) {
  if (typeof value !== 'string') return NaN;
  const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T00:00:00+09:00' :
    /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T').replace(/T(\d):/, 'T0$1:') + '+09:00' : value;
  return Date.parse(text);
}
const dayKst = now => new Date(now + 9 * 3600000).toISOString().slice(0, 10);
function settings(input = {}) {
  const integer = (key, fallback, min, max) => {
    const value = input[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('COORDINATE_POLICY_INVALID');
    return value;
  };
  return {
    externalEnabled: input.externalEnabled === true && input.externalApproved === true,
    maxRequestsPerRun: integer('maxRequestsPerRun', 25, 0, 1000),
    maxDailyRequests: integer('maxDailyRequests', 100, 0, 10000),
    maxTotalRequests: integer('maxTotalRequests', 0, 0, 1000000),
    maxDailyCostMicros: integer('maxDailyCostMicros', 0, 0, 1e12),
    unitCostMicros: integer('unitCostMicros', 0, 0, 1e9),
    maxAttempts: integer('maxAttempts', 3, 1, 5),
    timeoutMs: integer('timeoutMs', 5000, 1, 30000),
    minIntervalMs: integer('minIntervalMs', 250, 0, 60000),
    retryBaseMs: integer('retryBaseMs', 60000, 1, 3600000)
  };
}
const sourcePriority = source => source === 'MANUAL_PIN' || source === 'MANUAL_VERIFIED' ? 0 : source === 'RAW_GPS' ? 1 : source === 'STORED_MATCH' ? 2 : 3;
const sourceAccuracy = (source, declared) => declared || (sourcePriority(source) === 0 ? 'MANUAL_POINT' : source === 'RAW_GPS' ? 'GPS' : sourcePriority(source) === 3 ? 'BUILDING' : 'UNCONFIRMED');
function evidenceIndex(rows) {
  if (!Array.isArray(rows) || rows.length > 50000) throw Error('COORDINATE_EVIDENCE_INVALID');
  const byKey = new Map();
  for (const row of rows) {
    if (!row || !codeValid(row.customerCode)) continue;
    const source = row.coordinateSource || row.source;
    const normalized = { lat: row.lat ?? row.latitude, lng: row.lng ?? row.longitude };
    if (!knownSources.has(source) || !pointValid(normalized) || row.geocodeStatus && row.geocodeStatus !== 'OK' || row.verified === false) continue;
    // The existing authenticated manual projection has no raw Customer address.
    if (source === 'MANUAL_PIN' && (row.resolutionStatus !== 'MANUAL_CONFIRMED' || !Number.isSafeInteger(row.revision) || row.revision < 1)) continue;
    const suppliedHash = source === 'MANUAL_PIN' ? row.originalAddressHash : row.addressHash;
    const hash = row.address ? coordinateAddressHash(row.address) : suppliedHash;
    if (!/^[a-f0-9]{64}$/.test(hash || '') || suppliedHash && suppliedHash !== hash) continue;
    const key = row.customerCode + ':' + hash;
    const group = byKey.get(key) || [];
    group.push({ ...normalized, source, coordinateAccuracy: sourceAccuracy(source, row.coordinateAccuracy), manual: sourcePriority(source) === 0 });
    byKey.set(key, group);
  }
  return byKey;
}
function choice(index, code, hash) {
  const all = index.get(code + ':' + hash) || [];
  if (!all.length) return null;
  const priority = Math.min(...all.map(row => sourcePriority(row.source)));
  const rows = all.filter(row => sourcePriority(row.source) === priority);
  if (rows.some(row => Math.abs(row.lat - rows[0].lat) > 0.00001 || Math.abs(row.lng - rows[0].lng) > 0.00001)) return { conflict: true };
  return rows[0];
}
// Cross-customer reuse requires address-level exact-match evidence. Raw GPS and
// customer-only/manual cache rows do not attest a shared address location.
function addressCacheIndex(rows) {
  if (!Array.isArray(rows) || rows.length > 50000) throw Error('COORDINATE_ADDRESS_CACHE_INVALID');
  const index = new Map();
  for (const row of rows) {
    if (!row || row.scope !== 'EXACT_ADDRESS' || row.verified !== true || row.exact !== true || !pointValid(row) ||
        !['KAKAO_EXACT_ADDRESS', 'GEOCODE_EXACT'].includes(row.coordinateSource || row.source) || row.geocodeStatus !== 'OK') continue;
    const hash = row.address ? coordinateAddressHash(row.address) : row.addressHash;
    if (!/^[a-f0-9]{64}$/.test(hash || '') || row.addressHash && row.addressHash !== hash) continue;
    const rows = index.get(hash) || []; rows.push(row); index.set(hash, rows);
  }
  return index;
}
function eventOf(row) {
  if (!row || !codeValid(row.customerCode)) return null;
  const address = typeof row.customerAddress === 'string' ? row.customerAddress : typeof row.address === 'string' ? row.address : '';
  // Collector updatedAt is regenerated during historical backfills. The delivery
  // date is authoritative unless an actual customer source timestamp is supplied.
  const revisionSource = row.sourceUpdatedAt ? 'SOURCE_UPDATED_AT' : row.deliveryDate ? 'DELIVERY_DATE' : 'UPDATED_AT';
  const revision = time(row.sourceUpdatedAt || row.deliveryDate || row.updatedAt);
  const deliveryTime = time(row.deliveryDate);
  const deliveryDate = Number.isFinite(deliveryTime) ? row.deliveryDate.slice(0, 10) : null;
  const sourceUpdatedAt = revisionSource === 'SOURCE_UPDATED_AT' && Number.isFinite(revision) ? new Date(revision).toISOString() : null;
  const hash = coordinateAddressHash(address);
  const explicitStatus = String(row.customerStatus || row.lifecycleStatus || row.operation || '').toUpperCase();
  const inactive = row.active === false || row.closed === true || ['CLOSED', 'DELETED', 'DELETE', '폐점', '삭제'].includes(explicitStatus);
  const relocating = ['RELOCATING', 'MOVED', '이전'].includes(explicitStatus);
  return { code: row.customerCode, address, hash, revision, revisionSource, deliveryDate, sourceUpdatedAt, inactive, relocating };
}

// Provider responses must identify the exact matched address. A confidence score alone is insufficient.
export function exactCoordinateResult(result, address) {
  if (!result || !pointValid(result) || result.exact !== true ||
      coordinateAddressHash(result.matchedAddress) !== coordinateAddressHash(address) ||
      result.ambiguous === true || result.confidence !== undefined && result.confidence < 0.99) return null;
  return { lat: result.lat, lng: result.lng };
}
export function kakaoCoordinateResult(body, address) {
  if (!body || !Array.isArray(body.documents) || body.documents.length > 30 || body.meta?.is_end === false) return null;
  const hash = coordinateAddressHash(address);
  const matches = body.documents.filter(row => [row.address_name, row.road_address?.address_name, row.address?.address_name].some(value => coordinateAddressHash(value) === hash));
  if (matches.length !== 1) return null;
  const point = { lat: Number(matches[0].y), lng: Number(matches[0].x), exact: true, matchedAddress: address };
  return pointValid(point) ? point : null;
}
async function boundedLookup(provider, address, key, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => provider.lookup({ address, requestKey: key, signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(Error('TIMEOUT'), { code: 'TIMEOUT' })); }, timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}
function providerFailure(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (status === 401 || status === 403) return { reason: 'PROVIDER_AUTH_REQUIRED', retry: false, stop: true };
  if (status === 429) return { reason: 'PROVIDER_RATE_LIMIT', retry: true, stop: true };
  if (error?.code === 'TIMEOUT' || error?.name === 'AbortError' || error?.name === 'TimeoutError') return { reason: 'PROVIDER_TIMEOUT', retry: true };
  return { reason: status >= 400 && status < 500 ? 'PROVIDER_REQUEST_REJECTED' : 'PROVIDER_UNAVAILABLE', retry: !(status >= 400 && status < 500) };
}

/** Shared state calls serialize. Persistent adapters must hold their transaction lock
 * and fsync checkpoint before each provider attempt; timeout reservations are never refunded. */
export async function runIncremental(input = {}) {
  const state = input.state || createCoordinateState();
  const prior = queues.get(state) || Promise.resolve();
  const pending = prior.catch(() => {}).then(() => resolveIncremental({ ...input, state }));
  queues.set(state, pending);
  try { return await pending; } finally { if (queues.get(state) === pending) queues.delete(state); }
}
async function resolveIncremental({ events = [], verifiedCoordinates = [], addressCoordinateCache = [], state, geocoder, policy = {}, now = Date.now, checkpoint = async () => {} }) {
  const cfg = settings(policy);
  if (state?.schema !== 1 || !state.customers || !state.requests || !state.budgets ||
      !Array.isArray(events) || events.length > 5000 || Object.keys(state.customers).length > 50000 || Object.keys(state.requests).length > 100000) throw Error('COORDINATE_STATE_INVALID');
  let totalAttempts = 0;
  for (const budget of Object.values(state.budgets)) {
    if (!Number.isSafeInteger(budget?.attempts) || budget.attempts < 0 || !Number.isSafeInteger(totalAttempts + budget.attempts)) throw Error('COORDINATE_STATE_INVALID');
    totalAttempts += budget.attempts;
  }
  const evidence = evidenceIndex(verifiedCoordinates), addressCache = addressCacheIndex(addressCoordinateCache), candidates = [], review = [];
  const metrics = { received: events.length, changed: 0, reused: 0, addressCacheReused: 0, geocoded: 0, requests: 0, deduplicated: 0, stale: 0, inactive: 0, reviewRequired: 0 };
  const grouped = new Map();
  for (const raw of events) {
    const event = eventOf(raw);
    if (!event) { review.push({ customerCode: null, status: 'REVIEW_REQUIRED', reason: 'CUSTOMER_CODE_INVALID' }); continue; }
    const old = grouped.get(event.code);
    if (!old || event.revision > old.revision || !Number.isFinite(old.revision) && Number.isFinite(event.revision)) grouped.set(event.code, event);
    else if (event.revision === old.revision && (event.hash !== old.hash || event.inactive !== old.inactive || event.relocating !== old.relocating)) old.conflict = true;
  }
  let providerStopped = false;
  for (const event of grouped.values()) {
    const previous = state.customers[event.code], stamp = now();
    const addReview = reason => {
      const record = { customerCode: event.code, addressHash: event.hash, revision: Number.isFinite(event.revision) ? event.revision : null, revisionSource: event.revisionSource, deliveryDate: event.deliveryDate, sourceUpdatedAt: event.sourceUpdatedAt, status: 'REVIEW_REQUIRED', reason };
      state.customers[event.code] = record; review.push({ ...record });
    };
    const addCandidate = (point, source) => {
      const record = { customerCode: event.code, addressHash: event.hash, revision: event.revision, revisionSource: event.revisionSource, deliveryDate: event.deliveryDate, sourceUpdatedAt: event.sourceUpdatedAt, status: 'READY', source, coordinateAccuracy: sourceAccuracy(source, point.coordinateAccuracy), lat: point.lat, lng: point.lng };
      state.customers[event.code] = record; candidates.push({ ...record, geocodeStatus: 'OK' });
    };
    if (!Number.isFinite(event.revision)) { addReview('SOURCE_TIME_REQUIRED'); continue; }
    if (previous && event.revision < previous.revision) { metrics.stale++; continue; }
    if (previous && event.revision === previous.revision && (previous.addressHash !== event.hash || previous.reason === 'SOURCE_EVENT_CONFLICT' || previous.status === 'INACTIVE' && !event.inactive)) event.conflict = true;
    if (event.conflict) { addReview('SOURCE_EVENT_CONFLICT'); continue; }
    if (!previous || previous.addressHash !== event.hash || (previous.status === 'INACTIVE') !== event.inactive) metrics.changed++;
    if (event.inactive) {
      state.customers[event.code] = { customerCode: event.code, addressHash: event.hash, revision: event.revision, revisionSource: event.revisionSource, deliveryDate: event.deliveryDate, sourceUpdatedAt: event.sourceUpdatedAt, status: 'INACTIVE', reason: 'EXPLICIT_CLOSURE' };
      metrics.inactive++; continue;
    }
    if (event.relocating && (!event.hash || previous?.addressHash === event.hash)) { addReview('RELOCATION_ADDRESS_REQUIRED'); continue; }
    if (!event.hash) { addReview('ADDRESS_REQUIRED'); continue; }
    const stored = choice(evidence, event.code, event.hash);
    if (stored?.conflict) { addReview('VERIFIED_COORDINATE_CONFLICT'); continue; }
    // Existing manual/GPS evidence outranks lower-priority automatic matches.
    // A new authoritative manual projection can replace a prior manual point.
    if (previous?.status === 'READY' && previous.addressHash === event.hash && pointValid(previous) && (!stored || sourcePriority(previous.source) < sourcePriority(stored.source))) {
      addCandidate(previous, previous.source); metrics.deduplicated++; continue;
    }
    if (stored) { addCandidate(stored, stored.source); metrics.reused++; continue; }
    if (previous?.status === 'READY' && previous.addressHash === event.hash && pointValid(previous)) {
      addCandidate(previous, previous.source); metrics.deduplicated++; continue;
    }
    const cached = addressCache.get(event.hash);
    if (cached?.length) {
      if (cached.some(row => Math.abs(row.lat - cached[0].lat) > 0.00001 || Math.abs(row.lng - cached[0].lng) > 0.00001)) { addReview('ADDRESS_CACHE_CONFLICT'); continue; }
      addCandidate(cached[0], cached[0].coordinateSource || cached[0].source); metrics.addressCacheReused++; continue;
    }
    const address = preparePrivateCoordinateAddress(event.address).query;
    if (!address) { addReview('ADDRESS_UNSAFE_OR_AMBIGUOUS'); continue; }
    // Share exact building-address lookups across customers and process restarts.
    const key = sha('EXACT_ADDRESS:' + coordinateAddressHash(address));
    const request = state.requests[key] || state.requests[sha(event.code + ':' + event.hash)];
    if (request?.status === 'READY' && pointValid(request)) { addCandidate(request, 'GEOCODE_EXACT'); metrics.deduplicated++; continue; }
    if (request?.status === 'PERMANENT_FAILURE') { addReview(request.reason); continue; }
    if (request?.attempts >= cfg.maxAttempts) { addReview('RETRY_EXHAUSTED'); continue; }
    if (request && request.nextAttemptAt > stamp) { addReview(request.status === 'IN_FLIGHT' ? 'REQUEST_IN_FLIGHT' : 'RETRY_PENDING'); continue; }
    const allowed = geocoder && typeof geocoder.lookup === 'function' && (geocoder.kind === 'mock' || geocoder.kind === 'external' && cfg.externalEnabled);
    if (!allowed) { addReview('GEOCODER_NOT_APPROVED'); continue; }
    if (geocoder.kind === 'external' && cfg.maxTotalRequests < 1) { addReview('GEOCODER_BUDGET_UNVERIFIED'); continue; }
    if (geocoder.kind === 'external' && totalAttempts >= cfg.maxTotalRequests) { addReview('BUDGET_LIMIT'); continue; }
    if (providerStopped) { addReview('PROVIDER_BLOCKED'); continue; }
    const day = dayKst(stamp), budget = state.budgets[day] || { attempts: 0, costMicros: 0, lastAttemptAt: null };
    const cost = geocoder.kind === 'mock' ? 0 : cfg.unitCostMicros;
    if (metrics.requests >= cfg.maxRequestsPerRun || budget.attempts >= cfg.maxDailyRequests || budget.costMicros + cost > cfg.maxDailyCostMicros) { addReview('BUDGET_LIMIT'); continue; }
    if (budget.lastAttemptAt !== null && stamp - budget.lastAttemptAt < cfg.minIntervalMs) { addReview('RATE_LIMIT_PENDING'); continue; }
    const attempt = { status: 'IN_FLIGHT', attempts: (request?.attempts || 0) + 1, nextAttemptAt: stamp + cfg.timeoutMs + cfg.retryBaseMs, reason: 'REQUEST_IN_FLIGHT' };
    state.requests[key] = attempt;
    totalAttempts++;
    state.budgets[day] = { attempts: budget.attempts + 1, costMicros: budget.costMicros + cost, lastAttemptAt: stamp };
    // Atomic durable reservation precedes any provider call, including every retry.
    await checkpoint(state);
    metrics.requests++;
    try {
      const result = await boundedLookup(geocoder, address, key, cfg.timeoutMs), point = exactCoordinateResult(result, address);
      if (!point) {
        attempt.status = 'PERMANENT_FAILURE'; attempt.reason = 'GEOCODE_MATCH_REVIEW_REQUIRED'; addReview(attempt.reason);
      } else {
        Object.assign(attempt, point, { status: 'READY', reason: null, nextAttemptAt: null });
        addCandidate(point, 'GEOCODE_EXACT'); metrics.geocoded++;
      }
    } catch (error) {
      const failure = providerFailure(error);
      attempt.status = failure.retry ? 'RETRY' : 'PERMANENT_FAILURE'; attempt.reason = failure.reason;
      attempt.nextAttemptAt = now() + cfg.retryBaseMs * 2 ** (attempt.attempts - 1);
      providerStopped ||= !!failure.stop;
      addReview(failure.reason);
    }
    await checkpoint(state);
  }
  metrics.reviewRequired = review.length;
  await checkpoint(state);
  return { state, candidates, review, metrics };
}
