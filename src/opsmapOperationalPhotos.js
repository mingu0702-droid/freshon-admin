import {createDeliveryAdminPhotoSource, DeliveryPhotoError, deliveryDate, validatePhotoQuery} from './opsmapDeliveryPhotos.js';
import {createDeliveryAdminPhotoTransport, DELIVERY_ADMIN_PHOTO_CATEGORY_MAP, DELIVERY_ADMIN_PHOTO_HOSTS} from './opsmapDeliveryAdminTransport.js';
import {mountOpsmapDeliveryPhotoRoutes} from './opsmapDeliveryPhotoRouter.js';
import {createDeliveryPhotoHistoryReader} from './opsmapDeliveryPhotoHistory.js';
export {createOperationalPhotoTaskReader} from './opsmapOperationalPhotoTaskReader.js';

const fail = (code, status = 503) => { throw new DeliveryPhotoError(code, status); };
async function waitForPhotoOperation(work, signal) {
  if (signal?.aborted) fail('PHOTO_TIMEOUT', 504);
  if (!signal) return work();
  let abort;
  const stopped = new Promise((_, reject) => { abort = () => reject(new DeliveryPhotoError('PHOTO_TIMEOUT', 504)); signal.addEventListener('abort', abort, {once:true}); });
  try { return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) fail('PHOTO_TIMEOUT', 504); return work(); }), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

// Read only the selected day through the existing Delivery reader; never scan history.
// Only three identity fields leave this adapter, without retaining source rows.
export function createOperationalPhotoMetadataReader({readTaskRows, defaultDate} = {}) {
  const active = new Map(), identities = new Map();
  return async (query, {signal} = {}) => {
    if (typeof readTaskRows !== 'function') fail('SOURCE_UNAVAILABLE');
    const date = query.date || (typeof defaultDate === 'function' ? defaultDate() : '');
    if (!deliveryDate(date) || date.length !== 10) fail('INVALID_DATE', 400);
    if (signal?.aborted) fail('PHOTO_TIMEOUT', 504);
    const key = query.customerCode + ':' + date, now = Date.now();
    for (const [id, entry] of identities) if (entry.expiresAt <= now) identities.delete(id);
    if (identities.has(key)) return identities.get(key).records.map(row => ({...row}));
    if (!active.has(date)) active.set(date, Promise.resolve().then(() => readTaskRows(date, {signal})).finally(() => active.delete(date)));
    const rows = await waitForPhotoOperation(() => active.get(date), signal);
    if (!Array.isArray(rows) || rows.length > 10000) fail('INVALID_PHOTO_RESPONSE', 502);
    if (signal?.aborted) fail('PHOTO_TIMEOUT', 504);
    const records = new Map();
    for (const task of rows) {
      const customerCode = task?.customer?.erpCode ?? task?.customerErpCode;
      if (customerCode !== query.customerCode) continue;
      const observedDate = deliveryDate(task?.carrier?.enteringDatedAt ?? task?.enteringDatedAt ?? task?.deliveryDate);
      const deliveryId = String(task?.id ?? '');
      if (observedDate !== date || !/^\d{1,20}$/.test(deliveryId)) fail('PHOTO_IDENTITY_UNVERIFIED');
      records.set(deliveryId, {customerCode, date, deliveryId});
      if (records.size > 32) fail('HISTORY_LIMIT_EXCEEDED', 422);
    }
    // A partial day may prove a matching record, never the absence of one.
    if (!records.size && rows.sourceObservation?.complete !== true) fail('SOURCE_UNAVAILABLE');
    while (identities.size >= 32) identities.delete(identities.keys().next().value);
    const result = [...records.values()];
    identities.set(key, {expiresAt:now + 30000, records:result});
    return result.map(row => ({...row}));
  };
}

// Operational access replaces the old single-record trial allowance. Existing
// staff/session checks, exact identity checks, stream limits and host checks remain.
export function createOperationalPhotoExtension({enabled = false, rawRequest,
  hasMemorySession, prepareSession, prepareHistorySession = false, listDeliveryMetadata, imageFetch = globalThis.fetch} = {}) {
  const isEnabled = () => typeof enabled === 'function' ? enabled() === true : enabled === true;
  const hasSession = () => isEnabled() && typeof hasMemorySession === 'function' && hasMemorySession() === true;
  const ensureSession = async (identity, {signal} = {}) => {
    if (!isEnabled()) fail('PHOTO_SOURCE_DISABLED');
    validatePhotoQuery({customerCode:identity.customerCode, ...(identity.date ? {date:identity.date} : {}), ...(identity.deliveryId ? {deliveryId:identity.deliveryId} : {})});
    // The injected routine is the existing Delivery Admin authentication flow.
    // This feature contains no credential store, login endpoint or retry login.
    if (!hasSession() && typeof prepareSession === 'function') await waitForPhotoOperation(() => prepareSession({signal}), signal);
    if (signal?.aborted) fail('PHOTO_TIMEOUT', 504);
    if (!hasSession()) fail('UPSTREAM_AUTH_REQUIRED', 502);
  };
  const transport = createDeliveryAdminPhotoTransport({approvedRequest: rawRequest, hasApprovedSession: hasSession, imageFetch});
  const pending = new Map();
  const requestJson = (path, options) => {
    // Share only an active exact-detail read. Delete immediately on settlement;
    // no persistent JSON/photo cache, including after process restart.
    if (!pending.has(path)) {
      const operation = transport.requestJson(path, options).finally(() => pending.delete(path));
      pending.set(path, operation);
    }
    return pending.get(path);
  };
  const metadata = async (identity, options) => {
    await ensureSession(identity, options);
    if (typeof listDeliveryMetadata !== 'function') fail('SOURCE_UNAVAILABLE');
    return listDeliveryMetadata(identity, options);
  };
  const photoSource = createDeliveryAdminPhotoSource({...transport, requestJson, listDeliveryMetadata: metadata,
    categoryMap: DELIVERY_ADMIN_PHOTO_CATEGORY_MAP, allowedImageHosts: DELIVERY_ADMIN_PHOTO_HOSTS, readTaskStatusRecords:true});
  const readHistory = createDeliveryPhotoHistoryReader({
    searchFrontDoorTasks:transport.searchFrontDoorTasks, listHistoryRecord:photoSource.listHistoryRecord, hasSession
  });
  const source = {...photoSource, async listHistory(identity, options) {
    if (prepareHistorySession && !hasSession()) {
      try { await ensureSession(identity, options); }
      catch { return {coverage:'INCOMPLETE', deliveries:[]}; }
    }
    return readHistory(identity, options);
  }};
  return {
    diagnostics: () => ({enabled: isEnabled(), sourceSession: hasSession(), metadataConfigured: typeof listDeliveryMetadata === 'function'}),
    mount: ({app, requireStaff, isSessionCurrent, previewEnabled}, {historyOnly = false} = {}) => mountOpsmapDeliveryPhotoRoutes({app, requireStaff, isSessionCurrent, historyOnly,
      source, enabled: () => isEnabled() && previewEnabled() === true, prepareSource: ensureSession,
      prepareDiscovery: true, timeoutMs: 15000, maxConcurrent: 3, maxImageBytes: 4 * 1024 * 1024})
  };
}
