import { createHash, randomBytes } from 'node:crypto';

export class DeliveryPhotoError extends Error {
  constructor(code, status = 503, detail = {}) { super(code); this.code = code; this.status = status;
    if (typeof detail.stage === 'string') this.stage = detail.stage;
    if (Number.isInteger(detail.sourceHttpStatus)) this.sourceHttpStatus = detail.sourceHttpStatus;
  }
}
export const FRONT_DOOR_PHOTO_KIND = 'FRONT_DOOR_DELIVERY';
const FRONT_DOOR_PHOTO_LABEL = '상품을 잘 적치하셨나요? - 매장 문 앞';
export const PHOTO_KINDS = new Set(['REFRIGERATOR_DOOR', 'ENTRANCE_LOCK', FRONT_DOOR_PHOTO_KIND]);
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
  if (!actual.date || !/^\d{1,20}$/.test(actual.deliveryId)) fail('PHOTO_IDENTITY_UNVERIFIED', 503);
  return actual;
}
function unwrap(payload) { return payload?.data ?? payload; }

function matchesFrontDoorCompletion(record) {
  return (record.status === undefined || record.status === 'COMPLETED')
    && (record.statusText === undefined || record.statusText === '배송완료')
    && (record.completeType === undefined || record.completeType === 'FRONT_DOOR')
    && (record.completeTypeText === undefined || record.completeTypeText === '매장문앞');
}

export function hasFrontDoorCompletion(record) {
  return record && (record.status === 'COMPLETED' || record.statusText === '배송완료')
    && record.completeTypeText === '매장문앞' && matchesFrontDoorCompletion(record);
}

export const validDeliveryId = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^\d{1,20}$/.test(String(value));

// Public Delivery Admin bundle confirms /api/bali/task/{taskId}, customer.erpCode,
// carrier.enteringDatedAt and taskAttachments[{typeText,text,images:[{url}]}].
// Live task ID equivalence and category labels require an authenticated one-record check.
// This adapter performs no login and makes no request until explicitly injected and enabled.
export function createDeliveryAdminPhotoSource({ requestJson, fetchImage, listDeliveryMetadata, allowedImageHosts = [], categoryMap = {}, firstPhotoKind = null, readTaskStatusRecords = false } = {}) {
  if (typeof requestJson !== 'function' || typeof fetchImage !== 'function') fail('UNVERIFIED', 503);
  if (firstPhotoKind !== null && !PHOTO_KINDS.has(firstPhotoKind)) fail('UNVERIFIED', 503);
  const hosts = new Set(allowedImageHosts);
  const kinds = new Map(Object.entries(categoryMap).filter(([, kind]) => PHOTO_KINDS.has(kind) && kind !== FRONT_DOOR_PHOTO_KIND));
  const photoKind = (attachment, history) => history
    ? (attachment?.typeText === FRONT_DOOR_PHOTO_LABEL ? FRONT_DOOR_PHOTO_KIND : undefined)
    : kinds.get(attachment?.typeText);
  function attachmentImages(attachment) {
    if (!attachment || typeof attachment !== 'object' || !Array.isArray(attachment.images)) fail('PHOTO_IMAGES_INVALID', 503);
    if (attachment.images.length > 24) fail('PHOTO_IMAGE_LIMIT_EXCEEDED', 503);
    const rows = [];
    for (const [imageIndex, image] of attachment.images.entries()) {
      if (!image || typeof image !== 'object' || Array.isArray(image)) fail('PHOTO_IMAGES_INVALID', 503);
      if (Object.hasOwn(image, 'images')) {
        // Existing source groups may contain one nested images array. No arbitrary recursion.
        if (Object.hasOwn(image, 'url') || !Array.isArray(image.images) || Object.hasOwn(image, 'typeText') && image.typeText !== attachment.typeText) fail('PHOTO_IMAGES_INVALID', 503);
        if (image.images.length > 24) fail('PHOTO_IMAGE_LIMIT_EXCEEDED', 503);
        for (const [childImageIndex, child] of image.images.entries()) {
          if (!child || typeof child !== 'object' || Array.isArray(child) || Object.hasOwn(child, 'images') || typeof child.url !== 'string' || Object.hasOwn(child, 'typeText') && child.typeText !== attachment.typeText) fail('PHOTO_IMAGES_INVALID', 503);
          rows.push({imageIndex, childImageIndex, image: child});
        }
      } else {
        if (typeof image.url !== 'string' || Object.hasOwn(image, 'typeText') && image.typeText !== attachment.typeText) fail('PHOTO_IMAGES_INVALID', 503);
        rows.push({imageIndex, childImageIndex: null, image});
      }
      if (rows.length > 24) fail('PHOTO_IMAGE_LIMIT_EXCEEDED', 503);
    }
    return rows;
  }
  function permitted(task, attachmentIndex, imageIndex, childImageIndex = null) {
    if (firstPhotoKind === null) return true;
    for (const [index, attachment] of task.taskAttachments.entries()) {
      if (photoKind(attachment, false) !== firstPhotoKind) continue;
      const first = attachmentImages(attachment)[0];
      if (first) return index === attachmentIndex && first.imageIndex === imageIndex && first.childImageIndex === childImageIndex;
    }
    return false;
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
  async function detail(identity, signal, history = false) {
    let task = unwrap(await bounded(requestJson(`/api/bali/task/${identity.deliveryId}`, { method: 'GET', signal, maxResponseBytes: 65536 }), signal));
    exact(task, identity);
    if (history && !matchesFrontDoorCompletion(task)) fail('PHOTO_IDENTITY_UNVERIFIED', 503);
    if (readTaskStatusRecords === true) {
      // Public task screen reads attachments from taskStatusRecord, separately
      // from its parent task. Parent identity must pass before this second GET.
      const payload = unwrap(await bounded(requestJson(`/api/bali/task/${identity.deliveryId}/status-record`, {method:'GET', signal, maxResponseBytes:65536}), signal));
      const records = Array.isArray(payload) ? payload : payload && typeof payload === 'object' && !Array.isArray(payload) && Object.hasOwn(payload, 'taskAttachments') ? [payload] : null;
      if (!records || records.length > 32) fail('PHOTO_ATTACHMENTS_INVALID', 503);
      const attachments = [];
      const validateExplicit = (value, root = false) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PHOTO_ATTACHMENTS_INVALID', 503);
        // record.id is the status event ID. Only explicit parent-task IDs bind it.
        if ((!root && Object.hasOwn(value, 'id') && String(value.id) !== identity.deliveryId)
          || Object.hasOwn(value, 'taskId') && String(value.taskId) !== identity.deliveryId) fail('DELIVERY_IDENTITY_MISMATCH', 409);
        for (const code of [value.customerCode, value.customerErpCode, value.customer?.erpCode]) if (code !== undefined && code !== identity.customerCode) fail('DELIVERY_IDENTITY_MISMATCH', 409);
        for (const date of [value.enteringDatedAt, value.deliveryDate, value.carrier?.enteringDatedAt]) if (date !== undefined && deliveryDate(date) !== identity.date) fail('DELIVERY_IDENTITY_MISMATCH', 409);
      };
      for (const [recordIndex, record] of records.entries()) {
        validateExplicit(record, true);
        if (Object.hasOwn(record, 'task')) validateExplicit(record.task);
        if (history && (record.status !== 'COMPLETED' || !hasFrontDoorCompletion(record))) continue;
        if (!Array.isArray(record.taskAttachments)) fail('PHOTO_ATTACHMENTS_INVALID', 503);
        if (history && !validDeliveryId(record.id)) fail('PHOTO_IDENTITY_UNVERIFIED', 503);
        const recordFingerprint = createHash('sha256').update(JSON.stringify({source:'TASK_STATUS_RECORD', ...identity, recordIndex, id:record.id ?? null})).digest('hex');
        for (const attachment of record.taskAttachments) {
          if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) fail('PHOTO_ATTACHMENTS_INVALID', 503);
          if (history && !photoKind(attachment, true)) continue;
          attachments.push({...attachment, photoRecordFingerprint:recordFingerprint, ...(history ? {photoRecordId:String(record.id)} : {})});
          if (attachments.length > 20) fail('PHOTO_ATTACHMENT_LIMIT_EXCEEDED', 503);
        }
      }
      task = {...task, taskAttachments:attachments};
    }
    if (!Array.isArray(task.taskAttachments)) {
      const error=new DeliveryPhotoError('PHOTO_ATTACHMENTS_INVALID',503,{stage:'source-attachments'});
      // Fixed shape enums only; no attachment body, URL or protected text.
      error.attachmentState=!Object.hasOwn(task,'taskAttachments')?'MISSING':task.taskAttachments===null?'NULL':typeof task.taskAttachments==='object'?'OBJECT':'SCALAR';
      throw error;
    }
    if (task.taskAttachments.length > 20) fail('PHOTO_ATTACHMENT_LIMIT_EXCEEDED', 503);
    return task;
  }
  return {
    async listHistoryRecord(identity, { signal } = {}) {
      if (readTaskStatusRecords !== true) fail('UNVERIFIED', 503);
      const task = await detail(identity, signal, true), photos = [];
      for (const [attachmentIndex, attachment] of task.taskAttachments.entries()) {
        for (const {imageIndex, childImageIndex, image} of attachmentImages(attachment)) {
          const {fingerprint} = mediaAsset(image.url);
          photos.push({kind:FRONT_DOOR_PHOTO_KIND, recordId:attachment.photoRecordId,
            ref:{attachmentIndex, imageIndex, ...(childImageIndex === null ? {} : {childImageIndex}), fingerprint,
              recordFingerprint:attachment.photoRecordFingerprint, history:true}});
        }
      }
      if (photos.length > 40) fail('PHOTO_LIMIT_EXCEEDED', 503);
      return {...exact(task, identity), notes:'', status:photos.length ? 'READY' : 'EMPTY', photos};
    },
    async list(identity, { signal } = {}) {
      if (identity.deliveryId) {
        const task = await detail(identity, signal), photos = [], notes = [];
        let unverified = false;
        for (const [attachmentIndex, attachment] of task.taskAttachments.entries()) {
          const images = attachmentImages(attachment);
          if (attachment.text) notes.push(cleanText(attachment.text));
          const kind = photoKind(attachment, false);
          if (!kind && images.length) { unverified = true; continue; }
          for (const {imageIndex, childImageIndex, image} of images) {
            if (!permitted(task, attachmentIndex, imageIndex, childImageIndex)) continue;
            const { fingerprint } = mediaAsset(image?.url);
            photos.push({ kind, ref: { attachmentIndex, imageIndex, ...(childImageIndex === null ? {} : {childImageIndex}), fingerprint,
              ...(readTaskStatusRecords === true ? {recordFingerprint:attachment.photoRecordFingerprint} : {}) } });
          }
        }
        if (photos.length > 40) fail('PHOTO_LIMIT_EXCEEDED', 503);
        // A narrowed verification category is not evidence that other photos are absent.
        if (!photos.length && firstPhotoKind !== null && task.taskAttachments.some(a => attachmentImages(a).length)) unverified = true;
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
      const history = ref.history === true;
      if (history && readTaskStatusRecords !== true) fail('PHOTO_FORBIDDEN', 403);
      const task = await detail(identity, signal, history);
      if (!permitted(task, ref.attachmentIndex, ref.imageIndex, ref.childImageIndex ?? null)) fail('PHOTO_FORBIDDEN', 403);
      const attachment = task.taskAttachments[ref.attachmentIndex];
      if (readTaskStatusRecords === true && attachment?.photoRecordFingerprint !== ref.recordFingerprint) fail('PHOTO_NOT_FOUND', 404);
      if (!photoKind(attachment, history)) fail('UNVERIFIED', 503);
      const entry = attachmentImages(attachment).find(r => r.imageIndex === ref.imageIndex && r.childImageIndex === (ref.childImageIndex ?? null));
      if (!entry) fail('PHOTO_NOT_FOUND', 404);
      const { url, fingerprint } = mediaAsset(entry.image.url);
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
  function publish(rows, identity, sessionKey, history = false) {
    if (!Array.isArray(rows) || rows.length > 32) fail('INVALID_PHOTO_RESPONSE', 502);
    prune();
    return rows.map(row => {
      if (row.customerCode !== identity.customerCode || !deliveryDate(row.date) || (identity.date && row.date !== identity.date)
        || !/^\d{1,20}$/.test(row.deliveryId) || (identity.deliveryId && row.deliveryId !== identity.deliveryId)) fail('DELIVERY_IDENTITY_MISMATCH', 409);
      if (!['READY', 'EMPTY', 'UNVERIFIED'].includes(row.status) || !Array.isArray(row.photos) || row.photos.length > 40
        || (history && (row.status !== 'READY' || !row.photos.length))) fail('INVALID_PHOTO_RESPONSE', 502);
      return { customerCode: row.customerCode, date: row.date, deliveryId: row.deliveryId,
        notes: history ? '' : cleanText(row.notes, 4000), status: row.status, photos: row.photos.map(photo => {
          if (history ? photo.kind !== FRONT_DOOR_PHOTO_KIND || !validDeliveryId(photo.recordId) || photo.ref?.history !== true
            : !PHOTO_KINDS.has(photo.kind) || photo.kind === FRONT_DOOR_PHOTO_KIND) fail('UNVERIFIED', 503);
          while (handles.size >= maxHandles) handles.delete(handles.keys().next().value);
          const id = randomBytes(24).toString('base64url');
          handles.set(id, { sessionKey, identity: { customerCode: row.customerCode, date: row.date, deliveryId: row.deliveryId },
            ref: photo.ref, expiresAt: now() + handleTtlMs });
          const url = `/api/map-phase2b/private/delivery-photos/media/${id}`;
          return { id, kind: photo.kind, thumbnailUrl: url, url, ...(history ? {recordId:String(photo.recordId)} : {}) };
        }) };
    });
  }
  return {
    async list(query, sessionKey, { signal } = {}) {
      ready(); const identity = validatePhotoQuery(query);
      if (!sessionKey) fail('STAFF_LOGIN_REQUIRED', 401);
      const rows = await bounded(source.list(identity, { signal }), signal);
      return { customerCode: identity.customerCode, deliveries:publish(rows, identity, sessionKey) };
    },
    async listHistory(query, sessionKey, {signal} = {}) {
      ready();
      if (Object.keys(query).some(key => key !== 'customerCode')) fail('INVALID_PHOTO_REQUEST', 400);
      const identity = validatePhotoQuery(query);
      if (!sessionKey) fail('STAFF_LOGIN_REQUIRED', 401);
      const history = await bounded(source.listHistory(identity, {signal}), signal);
      if (history?.coverage !== 'INCOMPLETE') fail('INVALID_PHOTO_RESPONSE', 502);
      return {customerCode:identity.customerCode, coverage:history.coverage, deliveries:publish(history.deliveries, identity, sessionKey, true)};
    },
    async openMedia(id, sessionKey, { signal } = {}) {
      ready(); prune();
      const handle = handles.get(id);
      if (!handle || !sessionKey || handle.sessionKey !== sessionKey) fail('PHOTO_NOT_FOUND', 404);
      return bounded(source.openMedia(handle.identity, handle.ref, { signal }), signal);
    }
  };
}
