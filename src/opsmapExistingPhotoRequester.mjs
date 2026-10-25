const ORIGIN = 'https://delivery-bali.chabyulhwa.com';
const rejected = (code, status) => Object.assign(new Error(code), { code, status });
const cancelBody = response => { try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {} };
export const APPROVED_SINGLE_PHOTO_SCOPE = Object.freeze({ customerCode: 'S91260', date: '2026-10-23', deliveryId: '2293136' });

// Stage read-only exception is narrower than the legacy source requester. It
// never starts/refreshes login, and requires an existing unexpired memory session.
export function isApprovedSinglePhotoRawRead({enabled, hasMemorySession, pathname, options={}}={}) {
  return enabled === true && hasMemorySession === true
    && pathname === `/api/bali/task/${APPROVED_SINGLE_PHOTO_SCOPE.deliveryId}`
    && (options.method ?? 'GET') === 'GET' && options.redirect === 'error' && options.cache === 'no-store'
    && options.timeoutMs === 8000
    && Object.keys(options).every(key=>['method','signal','redirect','cache','timeoutMs'].includes(key));
}

// Bind only to A's existing in-process raw deliveryAdminFetch function.
// Credentials remain in its existing closure. This module cannot start login.
export function createExistingDeliveryAdminPhotoRequester({ enabled = false, rawRequest,
  hasMemorySession = () => false, baseUrl = ORIGIN, allowedDeliveryId = '', maxTaskReads = 2 } = {}) {
  if (typeof hasMemorySession !== 'function' || !Number.isInteger(maxTaskReads) || maxTaskReads < 1 || maxTaskReads > 2) {
    throw rejected('PHOTO_BINDING_CONFIG_REJECTED', 503);
  }
  let validOrigin = false;
  try {
    const url = new URL(baseUrl);
    validOrigin = url.origin === ORIGIN && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
  } catch {}
  const validId = typeof allowedDeliveryId === 'string' && /^\d{1,20}$/.test(allowedDeliveryId);
  let taskReads = 0;
  const hasApprovedSession = () => {
    if (enabled !== true || !validOrigin || !validId || typeof rawRequest !== 'function') return false;
    try { return hasMemorySession() === true; } catch { return false; }
  };
  async function approvedRequest(path, options = {}) {
    if (path !== `/api/bali/task/${allowedDeliveryId}` || (options.method ?? 'GET') !== 'GET'
      || Object.keys(options).some(key => !['method', 'signal', 'redirect', 'cache', 'maxResponseBytes'].includes(key))) {
      throw rejected('INVALID_PHOTO_REQUEST', 400);
    }
    if (!hasApprovedSession()) throw rejected('UPSTREAM_AUTH_REQUIRED', 401);
    if (options.signal?.aborted) throw rejected('PHOTO_TIMEOUT', 504);
    if (taskReads >= maxTaskReads) throw rejected('PHOTO_RATE_LIMITED', 429);
    taskReads++;
    let response;
    try {
      // Explicitly omit caller headers/cookie/body/URL overrides and auth helpers.
      response = await rawRequest(path, { method: 'GET', signal: options.signal,
        redirect: 'error', cache: 'no-store', timeoutMs: 8000 });
    } catch (error) {
      const status = [401, 403, 404, 410, 429, 504].includes(error?.status) ? error.status : 502;
      throw rejected(status === 401 ? 'UPSTREAM_AUTH_REQUIRED' : status === 504 ? 'PHOTO_TIMEOUT' : 'PHOTO_LOOKUP_FAILED', status);
    }
    if (options.signal?.aborted || !hasApprovedSession()) {
      cancelBody(response);
      throw rejected(options.signal?.aborted ? 'PHOTO_TIMEOUT' : 'UPSTREAM_AUTH_REQUIRED', options.signal?.aborted ? 504 : 401);
    }
    return response;
  }
  return Object.freeze({ approvedRequest, hasApprovedSession,
    diagnostics: () => Object.freeze({ enabled: enabled === true, approvedSession: hasApprovedSession(), taskReads, maxTaskReads }) });
}

// Discovery is limited to the already approved record. It never scans history.
export function createApprovedDeliveryMetadata(scope) {
  if (!scope || typeof scope.customerCode !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(scope.customerCode)
    || typeof scope.deliveryId !== 'string' || !/^\d{1,20}$/.test(scope.deliveryId)
    || typeof scope.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(scope.date)
    || !Number.isFinite(Date.parse(scope.date)) || new Date(scope.date).toISOString().slice(0, 10) !== scope.date) {
    throw rejected('PHOTO_BINDING_CONFIG_REJECTED', 503);
  }
  const approved = Object.freeze({ customerCode: scope.customerCode, date: scope.date, deliveryId: scope.deliveryId });
  return async (identity = {}) => {
    if (identity.customerCode !== approved.customerCode || (identity.date && identity.date !== approved.date)
      || (identity.deliveryId && identity.deliveryId !== approved.deliveryId)) throw rejected('PHOTO_FORBIDDEN', 403);
    return [{ ...approved }];
  };
}

// Exact, single-use local verification policy. It never acquires a session.
export function restrictApprovedSinglePhotoSource(source, scope) {
  const metadata = createApprovedDeliveryMetadata(scope);
  if (typeof source?.list !== 'function' || typeof source?.openMedia !== 'function') throw rejected('PHOTO_BINDING_CONFIG_REJECTED', 503);
  let selected = null, mediaReads = 0;
  const sameRef = (a, b) => a && b && a.attachmentIndex === b.attachmentIndex && a.imageIndex === b.imageIndex && a.fingerprint === b.fingerprint;
  const exact = identity => {
    if (identity?.customerCode !== scope.customerCode || identity?.date !== scope.date || identity?.deliveryId !== scope.deliveryId) throw rejected('PHOTO_FORBIDDEN', 403);
  };
  return Object.freeze({
    async list(identity, options = {}) {
      // Discovery remains local metadata; a mismatched identity never reaches upstream.
      if (!identity?.deliveryId) return (await metadata(identity)).map(row => ({ ...row, notes: '', status: 'UNVERIFIED', photos: [] }));
      exact(identity);
      const rows = await source.list(identity, options);
      if (!Array.isArray(rows) || rows.length !== 1) throw rejected('INVALID_PHOTO_RESPONSE', 502);
      const row = rows[0]; exact(row);
      const first = row.photos?.find(photo => photo.kind === 'REFRIGERATOR_DOOR');
      selected = first ? Object.freeze({ ...first.ref }) : null;
      return [{ customerCode: scope.customerCode, date: scope.date, deliveryId: scope.deliveryId, notes: '',
        status: first ? 'READY' : row.status === 'EMPTY' ? 'EMPTY' : 'UNVERIFIED', photos: first ? [{ kind: 'REFRIGERATOR_DOOR', ref: selected }] : [] }];
    },
    async openMedia(identity, ref, options = {}) {
      exact(identity);
      if (!sameRef(selected, ref)) throw rejected('PHOTO_FORBIDDEN', 403);
      if (mediaReads >= 1) throw rejected('PHOTO_RATE_LIMITED', 429);
      mediaReads++;
      return source.openMedia(identity, ref, options);
    }
  });
}

// Attach inside the existing server process. The caller supplies its unchanged
// raw requester/session closure and existing authenticated C extension factory.
// No standalone authentication server, login, worker, or credential bridge starts.
export function createApprovedExistingPhotoMount({ enabled = false, rawRequest, prepareSource,
  hasMemorySession = () => false, baseUrl = ORIGIN, createExtension } = {}) {
  if (typeof createExtension !== 'function') throw rejected('PHOTO_BINDING_CONFIG_REJECTED', 503);
  const scope = APPROVED_SINGLE_PHOTO_SCOPE;
  const binding = createExistingDeliveryAdminPhotoRequester({ enabled, rawRequest, hasMemorySession,
    baseUrl, allowedDeliveryId: scope.deliveryId, maxTaskReads: 2 });
  return createExtension({ ...binding, enabled, prepareSource,
    listDeliveryMetadata: createApprovedDeliveryMetadata(scope),
    firstPhotoKind: 'REFRIGERATOR_DOOR',
    restrictSource: source => restrictApprovedSinglePhotoSource(source, scope),
    transportOptions: { timeoutMs: 8000, maxJsonBytes: 65536 },
    maxConcurrent: 1, maxImageBytes: 4 * 1024 * 1024, timeoutMs: 8000
  });
}
