import { DeliveryPhotoError } from './opsmapDeliveryPhotos.js';

// Confirmed from the existing authenticated task screen and the public bundle's
// direct taskAttachment.typeText binding. Unknown labels stay UNVERIFIED.
export const DELIVERY_ADMIN_PHOTO_CATEGORY_MAP = Object.freeze({
  '냉장고 문은 잘 닫았나요?': 'REFRIGERATOR_DOOR',
  '매장 출입문은 잘 잠궜나요?': 'ENTRANCE_LOCK'
});
export const DELIVERY_ADMIN_PHOTO_HOSTS = Object.freeze(['static.chabyulhwa.com']);
const fail = (code, status = 502, detail = {}) => { throw new DeliveryPhotoError(code, status, detail); };
const safeHttp = value => [200,400,401,403,404,409,410,413,422,429,500,502,503,504].includes(value) ? value : undefined;
// An upstream cancel hook is untrusted too: initiate cleanup without waiting
// for a noncooperative cancellation promise or retaining this request forever.
const cancel = body => { try { Promise.resolve(body?.cancel?.()).catch(() => {}); } catch {} };

function statusError(status) {
  const detail = {stage:'source-http',sourceHttpStatus:safeHttp(status)};
  if (status === 401) fail('UPSTREAM_AUTH_REQUIRED',502,detail);
  if (status === 403) fail('PHOTO_FORBIDDEN',403,detail);
  if (status === 404 || status === 410) fail('PHOTO_NOT_FOUND',status,detail);
  if (status === 429) fail('PHOTO_RATE_LIMITED',429,detail);
  fail('PHOTO_LOOKUP_FAILED',502,detail);
}
async function guarded(promise, signal, onLate) {
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(new DeliveryPhotoError('PHOTO_TIMEOUT', 504));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([promise, stopped]); }
  finally {
    signal.removeEventListener('abort', abort);
    if (signal.aborted && onLate) Promise.resolve(promise).then(onLate).catch(() => {});
  }
}
async function readJson(response, limit, signal) {
  const type = (response.headers?.get?.('content-type') || '').split(';')[0].trim();
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)$/i.test(type)) {
    cancel(response.body); fail('PHOTO_CONTENT_TYPE_INVALID',502,{stage:'source-content-type',sourceHttpStatus:safeHttp(response.status)});
  }
  const rawLength = response.headers?.get?.('content-length');
  if (rawLength !== null && rawLength !== undefined && (!/^\d+$/.test(rawLength) || Number(rawLength) > limit)) {
    cancel(response.body); fail('PHOTO_JSON_TOO_LARGE',413,{stage:'source-size',sourceHttpStatus:safeHttp(response.status)});
  }
  const reader = response.body?.getReader?.();
  if (!reader) { cancel(response.body); fail('PHOTO_BODY_UNAVAILABLE',502,{stage:'source-json',sourceHttpStatus:safeHttp(response.status)}); }
  const chunks = []; let size = 0;
  try {
    while (true) {
      const item = await guarded(reader.read(), signal);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) fail('PHOTO_JSON_TOO_LARGE',413,{stage:'source-size',sourceHttpStatus:safeHttp(response.status)});
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('PHOTO_JSON_INVALID',502,{stage:'source-json',sourceHttpStatus:safeHttp(response.status)}); }
  } finally { cancel(reader); try { reader.releaseLock(); } catch {} }
}
// Reuse the same bounded JSON reader for an explicitly approved existing login.
export { readJson as readBoundedPhotoLoginJson };

// approvedRequest must be an existing, authorized, raw-Response requester that
// uses an already active Delivery Admin session. Do not inject the legacy
// deliveryAdminJson helper: it automatically logs in/relogs in on HTTP 401.
// No cookies, tokens, passwords, photos, signed URLs or task JSON are retained.
export function createDeliveryAdminPhotoTransport({ approvedRequest, hasApprovedSession = () => false,
  imageFetch = globalThis.fetch, allowedImageHosts = DELIVERY_ADMIN_PHOTO_HOSTS,
  timeoutMs = 8000, maxJsonBytes = 65536 } = {}) {
  if (typeof hasApprovedSession !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || !Number.isInteger(maxJsonBytes) || maxJsonBytes < 1 || maxJsonBytes > 65536
    || !Array.isArray(allowedImageHosts) || allowedImageHosts.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host))) {
    fail('INVALID_PHOTO_TRANSPORT_CONFIG', 503);
  }
  const hosts = new Set(allowedImageHosts);
  const approved = () => { if (hasApprovedSession() !== true) fail('UPSTREAM_AUTH_REQUIRED',502,{stage:'source-session'}); };
  async function run(signal, action) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, timeoutMs); timer.unref?.();
    try {
      if (controller.signal.aborted) fail('PHOTO_TIMEOUT', 504);
      approved();
      return await action(controller.signal);
    } catch (error) {
      if (error instanceof DeliveryPhotoError) throw error;
      if (controller.signal.aborted || error?.name === 'AbortError') fail('PHOTO_TIMEOUT', 504);
      // Preserve only a safe status from approved requesters, never their text,
      // headers, payloads, URLs or signed media details.
      if (safeHttp(error?.status)) statusError(error.status);
      fail('PHOTO_LOOKUP_FAILED');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return {
    async requestJson(path, { method = 'GET', signal, maxResponseBytes = maxJsonBytes } = {}) {
      if (method !== 'GET' || !/^\/api\/bali\/task\/\d{1,20}$/.test(path || '')) fail('INVALID_PHOTO_REQUEST', 400);
      if (typeof approvedRequest !== 'function') fail('SOURCE_UNAVAILABLE',503,{stage:'source-session'});
      if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) fail('INVALID_PHOTO_REQUEST', 400);
      return run(signal, async requestSignal => {
        const response = await guarded(Promise.resolve().then(() => approvedRequest(path, {
          method: 'GET', signal: requestSignal, redirect: 'error', cache: 'no-store',
          maxResponseBytes: Math.min(maxResponseBytes, maxJsonBytes)
        })), requestSignal, response => cancel(response?.body));
        try { approved(); } catch (error) { cancel(response?.body); throw error; }
        if (response?.redirected) { cancel(response.body); fail('UPSTREAM_REDIRECT_REJECTED',502,{stage:'source-http',sourceHttpStatus:safeHttp(response.status)}); }
        if (response?.status !== 200) { cancel(response?.body); statusError(response?.status); }
        const json = await readJson(response, Math.min(maxResponseBytes, maxJsonBytes), requestSignal);
        approved(); return json;
      });
    },
    async fetchImage(raw, { method = 'GET', signal } = {}) {
      let url; try { url = new URL(raw); } catch { fail('MEDIA_ORIGIN_REJECTED', 403); }
      if (method !== 'GET' || url.protocol !== 'https:' || url.username || url.password || url.port
        || !hosts.has(url.hostname) || url.href.length > 8192) fail('MEDIA_ORIGIN_REJECTED', 403);
      if (typeof imageFetch !== 'function') fail('UNVERIFIED', 503);
      return run(signal, async requestSignal => {
        // CDN fetch deliberately has no Delivery Admin Cookie/Authorization.
        const response = await guarded(Promise.resolve().then(() => imageFetch(url.href, {
          method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
          headers: { Accept: 'image/jpeg,image/png,image/webp,image/gif' }, signal: requestSignal
        })), requestSignal, response => cancel(response?.body));
        try { approved(); } catch (error) { cancel(response?.body); throw error; }
        if (response?.redirected) { cancel(response.body); fail('MEDIA_ORIGIN_REJECTED',403,{stage:'source-media',sourceHttpStatus:safeHttp(response.status)}); }
        return response; // The existing router streams and bounds image bytes.
      });
    }
  };
}
