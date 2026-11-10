import {DeliveryPhotoError, deliveryDate, validatePhotoQuery, validDeliveryId} from './opsmapDeliveryPhotos.js';
import {deliveryPhotoUpstreamError, readBoundedPhotoLoginJson} from './opsmapDeliveryAdminTransport.js';
import {deliverySourceObservation, sourceTaskDate} from './snapshotRefreshEvidence.js';

const stage = 'source-task-search';
const fail = (code, status = 502) => { throw new DeliveryPhotoError(code, status, {stage:{PHOTO_IDENTITY_UNVERIFIED:'source-identity', PHOTO_TIMEOUT:'source-timeout'}[code] ?? stage}); };
const cancel = body => { try { Promise.resolve(body?.cancel?.()).catch(() => {}); } catch {} };
const extractDefault = payload => {
  if (Array.isArray(payload)) return payload;
  return payload?.data?.content ?? payload?.data?.items ?? payload?.data?.list ?? payload?.data?.rows
    ?? payload?.content ?? payload?.items ?? payload?.list ?? payload?.rows;
};
const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

// Existing GET task-list contract, with a single deadline covering every page and
// body read. This requester never invokes deliveryAdminJson or logs in on 401.
export function createOperationalPhotoTaskReader({rawRequest, extractRows = extractDefault, timeoutMs = 15000, customerScoped = false} = {}) {
  if (typeof rawRequest !== 'function' || typeof extractRows !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw Error('PHOTO_TASK_READER_CONFIG_REJECTED');
  const pageSize = customerScoped ? 50 : 300, maxPages = customerScoped ? 4 : 20;
  return async (date, {signal, customerCode} = {}) => {
    if (customerScoped) validatePhotoQuery({customerCode});
    if (!deliveryDate(date) || date.length !== 10) fail('INVALID_DATE', 400);
    const controller = new AbortController(), end = Date.now() + timeoutMs;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    const check = () => { if (controller.signal.aborted || Date.now() >= end) { abort(); fail('PHOTO_TIMEOUT', 504); } };
    const guarded = async (promise, onLate) => {
      check();let stop;
      const deadline = new Promise((_, reject) => { stop = () => reject(new DeliveryPhotoError('PHOTO_TIMEOUT', 504)); controller.signal.addEventListener('abort', stop, {once:true}); });
      try { return await Promise.race([promise, deadline]); }
      finally { controller.signal.removeEventListener('abort', stop); if (controller.signal.aborted && onLate) Promise.resolve(promise).then(onLate).catch(() => {}); }
    };
    const rows = [], seen = new Set();let complete = false, pages = 0, declaredTotal = null, declaredPages = null, pagingValid = true;
    try {
      for (let page = 0; page < maxPages; page++) {
        check();
        const query = new URLSearchParams({page:String(page), pageSize:String(pageSize)});
        if (customerScoped) query.set('customerErpCodeLike', customerCode);
        else query.set('logisticsCenterId', '1');
        query.append('enteringDatedAtBetween', date + 'T00:00:00+09:00');
        query.append('enteringDatedAtBetween', date + 'T00:00:00+09:00');
        const response = await guarded(Promise.resolve().then(() => {
          check();return rawRequest('/api/bali/task?' + query, {method:'GET', signal:controller.signal,
            redirect:'error', cache:'no-store', maxResponseBytes:customerScoped ? 256 * 1024 : 1048576, timeoutMs:Math.max(1, end - Date.now())});
        }), late => cancel(late?.body));
        if (response?.redirected) { cancel(response.body); fail('UPSTREAM_REDIRECT_REJECTED'); }
        if (response?.status !== 200) {
          cancel(response?.body);
          throw deliveryPhotoUpstreamError(response?.status, stage);
        }
        const payload = await readBoundedPhotoLoginJson(response, customerScoped ? 256 * 1024 : 1048576, controller.signal);check();
        if (payload?.ok === false || payload?.success === false || payload?.error) fail('PHOTO_LOOKUP_FAILED');
        const batch = extractRows(payload);
        if (!Array.isArray(batch) || batch.length > pageSize || rows.length + batch.length > 10000) fail('INVALID_PHOTO_RESPONSE');
        const total = count(payload?.totalElements ?? payload?.data?.totalElements), pageCount = count(payload?.totalPages ?? payload?.data?.totalPages);
        const returnedPage = payload?.number ?? payload?.data?.number;
        if (returnedPage != null && returnedPage !== page) fail('PHOTO_IDENTITY_UNVERIFIED', 503);
        if (total === null || pageCount === null || total > 10000 || total === 0 && pageCount > 1
          || total > 0 && pageCount !== Math.ceil(total / pageSize)) pagingValid = false;
        if (declaredTotal !== null && (declaredTotal !== total || declaredPages !== pageCount)) pagingValid = false;
        if (declaredTotal === null && total !== null) { declaredTotal = total; declaredPages = pageCount; }
        for (const task of batch) {
          const id = String(task?.id ?? '');
          const customerCode = task?.customer?.erpCode ?? task?.customerErpCode;
          const values = [task?.enteringDatedAt, task?.deliveryDate, task?.carrier?.enteringDatedAt].filter(value => value !== null && value !== undefined);
          if (!validDeliveryId(task?.id) || seen.has(id) || typeof customerCode !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(customerCode)
            || !values.length || values.some(value => sourceTaskDate(value) !== date)) fail('PHOTO_IDENTITY_UNVERIFIED', 503);
          seen.add(id);rows.push(task);
        }
        pages++;
        if (pagingValid && rows.length === declaredTotal && (declaredTotal === 0 || pages === declaredPages)) { complete = true;break; }
        if (batch.length < pageSize || declaredPages !== null && pages >= declaredPages) break;
      }
      check();
      Object.defineProperty(rows, 'sourceObservation', {value:deliverySourceObservation(rows, {date, complete, pages})});
      return rows;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') fail('PHOTO_TIMEOUT', 504);
      if (error instanceof DeliveryPhotoError) throw error;
      if (Number.isInteger(error?.status)) throw deliveryPhotoUpstreamError(error.status, stage);
      fail('PHOTO_LOOKUP_FAILED');
    } finally { clearTimeout(timer);signal?.removeEventListener('abort', abort); }
  };
}
