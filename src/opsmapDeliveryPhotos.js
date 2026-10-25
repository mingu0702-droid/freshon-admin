import { createHash, randomBytes } from 'node:crypto';

export class DeliveryPhotoError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}
export const PHOTO_KINDS = new Set(['REFRIGERATOR_DOOR', 'ENTRANCE_LOCK']);
const fail = (code, status) => { throw new DeliveryPhotoError(code, status); };
const cleanText = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';
async function bounded(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) fail('PHOTO_TIMEOUT', 504);
  let abort;
  const deadline = new Promise((_, reject) => { abort = () => reject(new DeliveryPhotoError('PHOTO_TIMEOUT', 504)); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([promise, deadline]); } finally { signal.removeEventListener('abort', abort); }
}
export function deliveryDate(value) {
  if (typeof value !== 'string') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value ? value : '';
  }
  // Upstream timestamps must include an offset; server timezone cannot affect matching.
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) return '';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) : '';
}
export function validatePhotoQuery(query = {}) {
  const customerCode = query.customerCode;
  if (typeof customerCode !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(customerCode)) fail('INVALID_CUSTOMER_CODE', 400);
  if (query.date !== undefined && (!deliveryDate(query.date) || query.date.length !== 10)) fail('INVALID_DATE', 400);
  if (query.deliveryId !== undefined && (typeof query.deliveryId !== 'string' || !/^\d{1,20}$/.test(query.deliveryId) || !query.date)) fail('INVALID_DELIVERY_ID', 400);
  return { customerCode, date: query.date || '', deliveryId: query.deliveryId || '' };
}
function identityOf(task) {
  return { customerCode: task?.customer?.erpCode ?? task?.customerErpCode,
    date: deliveryDate(task?.carrier?.enteringDatedAt ?? task?.enteringDatedAt), deliveryId: String(task?.id ?? '') };
}
function exact(task, expected) {
  const actual = identityOf(task);
  if (actual.customerCode !== expected.customerCode || (expected.date && actual.date !== expected.date)
    || (expected.deliveryId && actual.deliveryId !== expected.deliveryId)) fail('DELIVERY_IDENTITY_MISMATCH', 409);
  if (!actual.date || !/^\d{1,20}$/.test(actual.deliveryId)) fail('UNVERIFIED', 503);
  return actual;
}
function unwrap(payload) { return payload?.data ?? payload; }

// Public Delivery Admin bundle confirms /api/bali/task/{taskId}, customer.erpCode,
// carrier.enteringDatedAt and taskAttachments[{typeText,text,images:[{url}]}].
// Live task ID equivalence and category labels require an authenticated one-record check.
// This adapter performs no login and makes no request until explicitly injected and enabled.
export function createDeliveryAdminPhotoSource({ requestJson, fetchImage, listDeliveryMetadata, allowedImageHosts = [], categoryMap = {}, firstPhotoKind = null } = {}) {
  if (typeof requestJson !== 'function' || typeof fetchImage !== 'function') fail('UNVERIFIED', 503);
  if (firstPhotoKind !== null && !PHOTO_KINDS.has(firstPhotoKind)) fail('UNVERIFIED', 503);
  const hosts = new Set(allowedImageHosts);
  const kinds = Object.fromEntries(Object.entries(categoryMap).filter(([, kind]) => PHOTO_KINDS.has(kind)));
  function permitted(task, attachmentIndex, imageIndex) {
    if (firstPhotoKind === null) return true;
    const first = task.taskAttachments.findIndex(attachment => kinds[attachment?.typeText] === firstPhotoKind && Array.isArray(attachment.images) && attachment.images.length);
    return first === attachmentIndex && imageIndex === 0;
  }
  function mediaAsset(raw) {
    let url;
    try { url = new URL(raw); } catch { fail('PHOTO_NOT_FOUND', 404); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.has(url.hostname)) fail('MEDIA_ORIGIN_REJECTED', 403);
    if (url.href.length > 8192) fail('INVALID_MEDIA_URL', 502);
    // Persist only the normalized asset identity digest; signed query strings may rotate.
    const fingerprint = createHash('sha256').update(url.origin + url.pathname).digest('hex');
    return { url, fingerprint };
  }
  async function detail(identity, signal) {
    const task = unwrap(await bounded(requestJson(`/api/bali/task/${identity.deliveryId}`, { method: 'GET', signal, maxResponseBytes: 65536 }), signal));
    exact(task, identity);
    if (!Array.isArray(task.taskAttachments) || task.taskAttachments.length > 20) fail('UNVERIFIED', 503);
    return task;
  }
  return {
    async list(identity, { signal } = {}) {
      if (identity.deliveryId) {
        const task = await detail(identity, signal), photos = [], notes = [];
        let unverified = false;
        for (const [attachmentIndex, attachment] of task.taskAttachments.entries()) {
          if (!Array.isArray(attachment.images) || attachment.images.length > 24) fail('UNVERIFIED', 503);
          if (attachment.text) notes.push(cleanText(attachment.text));
          const kind = kinds[attachment.typeText];
          if (!kind && attachment.images.length) { unverified = true; continue; }
          for (const [imageIndex, image] of attachment.images.entries()) {
            if (!permitted(task, attachmentIndex, imageIndex)) continue;
            const { fingerprint } = mediaAsset(image?.url);
            photos.push({ kind, ref: { attachmentIndex, imageIndex, fingerprint } });
          }
        }
        if (photos.length > 40) fail('PHOTO_LIMIT_EXCEEDED', 503);
        return [{ ...exact(task, identity), notes: notes.join('\n').slice(0, 4000), status: unverified ? 'UNVERIFIED' : photos.length ? 'READY' : 'EMPTY', photos }];
      }
      // Date discovery uses approved existing metadata only; never scan live delivery history.
      if (typeof listDeliveryMetadata !== 'function') fail('UNVERIFIED', 503);
      const rows = await bounded(listDeliveryMetadata(identity, { signal }), signal);
      if (!Array.isArray(rows) || rows.length > 32) fail('HISTORY_LIMIT_EXCEEDED', 422);
      return rows.map(row => ({ customerCode: row.customerCode, date: row.date, deliveryId: String(row.deliveryId),
        notes: '', status: 'UNVERIFIED', photos: [] }));
    },
    async openMedia(identity, ref, { signal } = {}) {
      const task = await detail(identity, signal);
      if (!permitted(task, ref.attachmentIndex, ref.imageIndex)) fail('PHOTO_FORBIDDEN', 403);
      const attachment = task.taskAttachments[ref.attachmentIndex];
      if (!kinds[attachment?.typeText]) fail('UNVERIFIED', 503);
      const { url, fingerprint } = mediaAsset(attachment?.images?.[ref.imageIndex]?.url);
      if (!/^[a-f0-9]{64}$/.test(ref.fingerprint || '') || fingerprint !== ref.fingerprint) fail('PHOTO_NOT_FOUND', 404);
      return bounded(fetchImage(url.href, { method: 'GET', redirect: 'error', credentials: 'omit', signal }), signal);
    }
  };
}

export function createDeliveryPhotoService({ source = null, enabled = false, now = Date.now, maxHandles = 128, handleTtlMs = 5 * 60000 } = {}) {
  const handles = new Map();
  function ready() {
    if (!(typeof enabled === 'function' ? enabled() === true : enabled === true)) fail('PHOTO_SOURCE_DISABLED', 503);
    if (!source?.list || !source?.openMedia) fail('SOURCE_UNAVAILABLE', 503);
  }
  function prune() { for (const [key, value] of handles) if (now() >= value.expiresAt) handles.delete(key); }
  return {
    async list(query, sessionKey, { signal } = {}) {
      ready(); const identity = validatePhotoQuery(query);
      if (!sessionKey) fail('STAFF_LOGIN_REQUIRED', 401);
      const rows = await bounded(source.list(identity, { signal }), signal);
      if (!Array.isArray(rows) || rows.length > 32) fail('INVALID_PHOTO_RESPONSE', 502);
      prune();
      const deliveries = rows.map(row => {
        if (row.customerCode !== identity.customerCode || !deliveryDate(row.date) || (identity.date && row.date !== identity.date)
          || !/^\d{1,20}$/.test(row.deliveryId) || (identity.deliveryId && row.deliveryId !== identity.deliveryId)) fail('DELIVERY_IDENTITY_MISMATCH', 409);
        if (!['READY', 'EMPTY', 'UNVERIFIED'].includes(row.status) || !Array.isArray(row.photos) || row.photos.length > 40) fail('INVALID_PHOTO_RESPONSE', 502);
        return { customerCode: row.customerCode, date: row.date, deliveryId: row.deliveryId,
          notes: cleanText(row.notes, 4000), status: row.status, photos: row.photos.map(photo => {
            if (!PHOTO_KINDS.has(photo.kind)) fail('UNVERIFIED', 503);
            while (handles.size >= maxHandles) handles.delete(handles.keys().next().value);
            const id = randomBytes(24).toString('base64url');
            handles.set(id, { sessionKey, identity: { customerCode: row.customerCode, date: row.date, deliveryId: row.deliveryId },
              ref: photo.ref, expiresAt: now() + handleTtlMs });
            const url = `/api/map-phase2b/private/delivery-photos/media/${id}`;
            return { id, kind: photo.kind, thumbnailUrl: url, url };
          }) };
      });
      return { customerCode: identity.customerCode, deliveries };
    },
    async openMedia(id, sessionKey, { signal } = {}) {
      ready(); prune();
      const handle = handles.get(id);
      if (!handle || !sessionKey || handle.sessionKey !== sessionKey) fail('PHOTO_NOT_FOUND', 404);
      return bounded(source.openMedia(handle.identity, handle.ref, { signal }), signal);
    }
  };
}
