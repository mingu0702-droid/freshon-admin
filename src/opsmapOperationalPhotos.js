import {createSharedInflightRead} from './sharedInflightRead.js';
import {createDeliveryAdminPhotoSource, DeliveryPhotoError, deliveryDate, validatePhotoQuery, validDeliveryId} from './opsmapDeliveryPhotos.js';
import {createDeliveryAdminPhotoTransport, DELIVERY_ADMIN_PHOTO_CATEGORY_MAP, DELIVERY_ADMIN_PHOTO_HOSTS, deliveryPhotoUpstreamError} from './opsmapDeliveryAdminTransport.js';
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
export function createOperationalPhotoMetadataReader({readTaskRows, defaultDate, customerScoped = false} = {}) {
  const active=createSharedInflightRead({maxEntries:8,timeoutMs:15000,
    error:code=>new DeliveryPhotoError(code==='READ_BUSY'?'PHOTO_RATE_LIMITED':'PHOTO_TIMEOUT',code==='READ_BUSY'?429:504)}), identities=new Map();
  return async (query, {signal} = {}) => {
    if (typeof readTaskRows !== 'function') fail('SOURCE_UNAVAILABLE');
    const date = query.date || (typeof defaultDate === 'function' ? defaultDate() : '');
    if (!deliveryDate(date) || date.length !== 10) fail('INVALID_DATE', 400);
    if (signal?.aborted) fail('PHOTO_TIMEOUT', 504);
    const key = query.customerCode + ':' + date, now = Date.now();
    for (const [id, entry] of identities) if (entry.expiresAt <= now) identities.delete(id);
    if (identities.has(key)) return identities.get(key).records.map(row => ({...row}));
    const activeKey = customerScoped ? key : date;
    const rows=await active.read(activeKey,sharedSignal=>readTaskRows(date,{signal:sharedSignal,
      ...(customerScoped?{customerCode:query.customerCode}:{})}),{signal});
    if (!Array.isArray(rows) || rows.length > 10000) fail('INVALID_PHOTO_RESPONSE', 502);
    if (signal?.aborted) fail('PHOTO_TIMEOUT', 504);
    const records = new Map();
    for (const task of rows) {
      const customerCode = task?.customer?.erpCode ?? task?.customerErpCode;
      if (customerCode !== query.customerCode) continue;
      const observedDate = deliveryDate(task?.carrier?.enteringDatedAt ?? task?.enteringDatedAt ?? task?.deliveryDate);
      const deliveryId = String(task?.id ?? '');
      if (observedDate !== date || !validDeliveryId(task?.id)) fail('PHOTO_IDENTITY_UNVERIFIED');
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
  hasMemorySession, prepareSession, prepareHistorySession = false, prepareMediaSession = false, canPrepareSource, listDeliveryMetadata,
  onSourceVerified, readIndexedHistory, imageFetch = globalThis.fetch} = {}) {
  const isEnabled = () => typeof enabled === 'function' ? enabled() === true : enabled === true;
  const hasSession = () => isEnabled() && typeof hasMemorySession === 'function' && hasMemorySession() === true;
  const ensureSession = async (identity, {signal} = {}) => {
    if (!isEnabled()) fail('PHOTO_SOURCE_DISABLED');
    validatePhotoQuery({customerCode:identity.customerCode, ...(identity.date ? {date:identity.date} : {}), ...(identity.deliveryId ? {deliveryId:identity.deliveryId} : {})});
    // The injected routine is the existing Delivery Admin authentication flow.
    // This feature contains no credential store, login endpoint or retry login.
    if (typeof rawRequest !== 'function' && typeof prepareSession === 'function') fail('SOURCE_UNAVAILABLE');
    if (!hasSession() && typeof prepareSession === 'function') {
      try { await waitForPhotoOperation(() => prepareSession({signal}), signal); }
      catch (error) {
        if (error instanceof DeliveryPhotoError) throw error;
        if (Number.isInteger(error?.status)) throw deliveryPhotoUpstreamError(error.status, 'source-login');
        throw new DeliveryPhotoError('UPSTREAM_AUTH_REQUIRED', 502, {stage:'source-login'});
      }
    }
    if (signal?.aborted) fail('PHOTO_TIMEOUT', 504);
    if (!hasSession()) fail('UPSTREAM_AUTH_REQUIRED', 502);
  };
  const transport = createDeliveryAdminPhotoTransport({approvedRequest:rawRequest, imageFetch, hasApprovedMediaSession:hasSession,
    hasApprovedSession:() => hasSession() || (isEnabled() && canPrepareSource?.() === true)});
  const pending=createSharedInflightRead({maxEntries:8,timeoutMs:15000,
    error:code=>new DeliveryPhotoError(code==='READ_BUSY'?'PHOTO_RATE_LIMITED':'PHOTO_TIMEOUT',code==='READ_BUSY'?429:504)});
  const requestJson=(path,options={})=>pending.read(path,signal=>
    transport.requestJson(path,{...options,signal}),{signal:options.signal});
  const metadata = async (identity, options) => {
    await ensureSession(identity, options);
    if (typeof listDeliveryMetadata !== 'function') fail('SOURCE_UNAVAILABLE');
    return listDeliveryMetadata(identity, options);
  };
  const photoSource = createDeliveryAdminPhotoSource({...transport, requestJson, listDeliveryMetadata: metadata,
    categoryMap: DELIVERY_ADMIN_PHOTO_CATEGORY_MAP, allowedImageHosts: DELIVERY_ADMIN_PHOTO_HOSTS, readTaskStatusRecords:true,
    onIdentityVerified:onSourceVerified});
  const readHistory = createDeliveryPhotoHistoryReader({
    searchFrontDoorTasks:transport.searchFrontDoorTasks, listHistoryRecord:photoSource.listHistoryRecord
  });
  const source = {
    ...photoSource,
    readIndexedHistory,
    async openMedia(identity, ref, options) {
      if (prepareMediaSession) await ensureSession(identity, options);
      return photoSource.openMedia(identity, ref, options);
    },
    async list(identity, options) {
      const rows = await photoSource.list(identity, options);
      onSourceVerified?.();
      return rows;
    },
    async listHistory(identity, options) {
      if (prepareHistorySession) {
        const started = performance.now();
        try { await ensureSession(identity, options); }
        finally { options.observe?.('photo_session', performance.now() - started); }
      }
      if (!hasSession()) throw new DeliveryPhotoError('UPSTREAM_AUTH_REQUIRED', 502, {stage:'source-session'});
      const history = await readHistory(identity, options);
      onSourceVerified?.();
      return history;
    }
  };
  return {
    async readIndexTask({customerCode, date, deliveryId} = {}, options) {
      const identity = validatePhotoQuery({customerCode, date, deliveryId});
      if (!identity.deliveryId) fail('INVALID_PHOTO_REQUEST', 400);
      await ensureSession(identity, options);
      const [row] = await photoSource.list(identity, options);
      return row;
    },
    diagnostics: () => ({enabled: isEnabled(), sourceSession: hasSession(), metadataConfigured: typeof listDeliveryMetadata === 'function'}),
    mount: ({app, requireStaff, isSessionCurrent, previewEnabled}, {historyOnly = false} = {}) => mountOpsmapDeliveryPhotoRoutes({app, requireStaff, isSessionCurrent, historyOnly,
      source, enabled: () => isEnabled() && previewEnabled() === true, prepareSource: ensureSession,
      prepareDiscovery: true, timeoutMs: 15000, maxConcurrent: 3, maxImageBytes: 4 * 1024 * 1024})
  };
}
