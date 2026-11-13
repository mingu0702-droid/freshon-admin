import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeliveryPhotoService, DeliveryPhotoError, validatePhotoQuery } from './opsmapDeliveryPhotos.js';
import { deliveryPhotoUpstreamError } from './opsmapDeliveryAdminTransport.js';

const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
// Cleanup must never delay the bounded HTTP error when an upstream cancel hook
// does not settle. Promise rejection is consumed without logging private data.
const cancelBody = body => { try { Promise.resolve(body?.cancel?.()).catch(() => {}); } catch {} };
const SAFE_STAGES = new Set(['source-session','source-login','source-http','source-task-search','source-task-detail','source-content-type','source-json','source-identity','source-attachments','source-category','source-media','source-timeout','source-size','source-index','staff-session']);
const SAFE_SOURCE_CODES = new Set(['PHOTO_LOGIN_HTTP_ERROR','PHOTO_LOGIN_REDIRECT_REJECTED','PHOTO_LOGIN_NETWORK_ERROR','PHOTO_LOGIN_SESSION_MISSING','PHOTO_CONTENT_TYPE_INVALID','PHOTO_JSON_INVALID','PHOTO_BODY_UNAVAILABLE','PHOTO_JSON_TOO_LARGE','PHOTO_TIMEOUT']);
const SAFE_LOG_CODES = new Set([...SAFE_SOURCE_CODES,'STAFF_LOGIN_REQUIRED','UPSTREAM_AUTH_REQUIRED','DELIVERY_IDENTITY_MISMATCH','PHOTO_IDENTITY_UNVERIFIED','PHOTO_ATTACHMENTS_INVALID','PHOTO_ATTACHMENT_LIMIT_EXCEEDED','PHOTO_IMAGES_INVALID','PHOTO_IMAGE_LIMIT_EXCEEDED','PHOTO_FORBIDDEN','PHOTO_NOT_FOUND','PHOTO_RATE_LIMITED','PHOTO_LOOKUP_FAILED','PHOTO_UPSTREAM_UNAVAILABLE','PHOTO_MEDIA_AUTH_REQUIRED','INVALID_MEDIA_TYPE','MEDIA_TOO_LARGE','MEDIA_ORIGIN_REJECTED','INVALID_PHOTO_RESPONSE','PHOTO_SOURCE_DISABLED','PHOTO_APPROVAL_REQUIRED','SOURCE_UNAVAILABLE','UNVERIFIED']);
const sourceStage = error => SAFE_STAGES.has(error?.photoStage) ? error.photoStage : SAFE_STAGES.has(error?.stage) ? error.stage : ({PHOTO_APPROVAL_REQUIRED:'source-session',UPSTREAM_AUTH_REQUIRED:'source-session',STAFF_LOGIN_REQUIRED:'staff-session',DELIVERY_IDENTITY_MISMATCH:'source-identity',PHOTO_IDENTITY_UNVERIFIED:'source-identity',PHOTO_ATTACHMENTS_INVALID:'source-attachments',PHOTO_ATTACHMENT_LIMIT_EXCEEDED:'source-attachments',PHOTO_IMAGES_INVALID:'source-attachments',PHOTO_IMAGE_LIMIT_EXCEEDED:'source-attachments',PHOTO_TIMEOUT:'source-timeout',PHOTO_JSON_TOO_LARGE:'source-size',MEDIA_TOO_LARGE:'source-size',MEDIA_ORIGIN_REJECTED:'source-media',INVALID_MEDIA_TYPE:'source-media'})[error?.code] || undefined;
function failure(error, res) {
  const status = error instanceof DeliveryPhotoError ? error.status
    : error?.name === 'AbortError' ? 504 : SAFE_SOURCE_CODES.has(error?.code) && [413,504].includes(error?.status) ? error.status : [401, 403, 404, 410, 429].includes(error?.status) ? error.status : 502;
  const code = error instanceof DeliveryPhotoError ? error.code
    : SAFE_SOURCE_CODES.has(error?.code) ? error.code
    : status === 504 ? 'PHOTO_TIMEOUT' : status === 401 ? 'UPSTREAM_AUTH_REQUIRED'
      : status === 403 ? 'PHOTO_FORBIDDEN' : [404, 410].includes(status) ? 'PHOTO_NOT_FOUND' : status === 429 ? 'PHOTO_RATE_LIMITED' : 'PHOTO_LOOKUP_FAILED';
  // Upstream login failure must not log out a valid map staff session in the UI.
  const responseStatus = code === 'UPSTREAM_AUTH_REQUIRED' ? 502 : status;
  const safe={code};const stage=sourceStage(error)||sourceStage({code});if(stage)safe.stage=stage;
  if([200,400,401,403,404,409,410,413,422,429,500,502,503,504].includes(error?.sourceHttpStatus))safe.sourceHttpStatus=error.sourceHttpStatus;
  if(code==='PHOTO_ATTACHMENTS_INVALID'&&['MISSING','NULL','OBJECT','SCALAR'].includes(error?.attachmentState))safe.attachmentState=error.attachmentState;
  if (!res.headersSent) res.status(responseStatus).json({ ok: false, error: safe });
  else {
    // Stream errors cannot replace already-sent headers. Emit only fixed safe enums.
    const record={event:'OPSMAP_PHOTO_STREAM_FAILURE',stage:stage||'source-media',code:SAFE_LOG_CODES.has(code)?code:'PHOTO_LOOKUP_FAILED',httpStatus:[400,401,403,404,409,410,413,422,429,500,502,503,504].includes(responseStatus)?responseStatus:502,responseStarted:true};
    if(safe.sourceHttpStatus!==undefined)record.sourceHttpStatus=safe.sourceHttpStatus;
    console.warn(JSON.stringify(record)); res.destroy();
  }
}
export function mountDeliveryPhotoConfig({app, requireStaff}, diagnostics) {
  app.get('/api/map-phase2b/private/delivery-photos/config', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('Vary', 'Cookie');
    return requireStaff(req, res, () => res.json({ok:true, data:diagnostics()}));
  });
}

// Dependency injection preserves A's existing staff session and makes the feature default OFF.
export function mountOpsmapDeliveryPhotoRoutes({ app, requireStaff, isSessionCurrent = () => false, source = null, enabled = false, prepareSource,
  prepareDiscovery = false, historyOnly = false, timeoutMs = 8000, maxImageBytes = 4 * 1024 * 1024, maxConcurrent = 3, now = Date.now } = {}) {
  if (!app?.get || typeof requireStaff !== 'function') throw new Error('STAFF_AUTH_INJECTION_REQUIRED');
  const service = createDeliveryPhotoService({ source, enabled, now });
  let active = 0;
  const secure = (req, res, next) => {
    res.set('Cache-Control', 'private, no-store, max-age=0'); res.set('Pragma', 'no-cache');
    res.set('Vary', 'Cookie'); res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cross-Origin-Resource-Policy', 'same-origin'); res.set('Referrer-Policy', 'no-referrer');
    return requireStaff(req, res, next);
  };
  const handler = action => (req, res) => {
    if (active >= maxConcurrent) return failure(new DeliveryPhotoError('PHOTO_RATE_LIMITED', 429), res);
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    const abort = () => controller.abort(); req.once('aborted', abort); res.once('close', abort);
    const sessionKey = res.locals.staffSession?.key;
    Promise.resolve().then(() => action(req, res, controller.signal, sessionKey)).catch(error => failure(error, res))
      .finally(() => { clearTimeout(timer); req.off('aborted', abort); res.off('close', abort); active--; });
  };
  if (!historyOnly) app.get('/api/map-phase2b/private/delivery-photos', secure, handler(async (req, res, signal, sessionKey) => {
    // OFF must block validation, session preparation and any source activity.
    if (!(typeof enabled === 'function' ? enabled() === true : enabled === true)) throw new DeliveryPhotoError('PHOTO_SOURCE_DISABLED', 503);
    if (!isSessionCurrent(req, sessionKey)) throw new DeliveryPhotoError('STAFF_LOGIN_REQUIRED', 401);
    const identity = validatePhotoQuery(req.query);
    if ((identity.deliveryId || prepareDiscovery) && typeof prepareSource === 'function') {
      await prepareSource(identity, { signal });
      if (!isSessionCurrent(req, sessionKey)) throw new DeliveryPhotoError('STAFF_LOGIN_REQUIRED', 401);
    }
    const data = await service.list(req.query, sessionKey, { signal });
    // Session can expire or be revoked while the upstream request is in flight.
    await requireStaff(req, res, () => {
      if (!isSessionCurrent(req, sessionKey)) throw new DeliveryPhotoError('STAFF_LOGIN_REQUIRED', 401);
      res.json({ok:true, data});
    });
  }));
  app.get('/api/map-phase2b/private/delivery-photos/history', secure, handler(async (req, res, signal, sessionKey) => {
    if (!isSessionCurrent(req, sessionKey)) throw new DeliveryPhotoError('STAFF_LOGIN_REQUIRED', 401);
    const started = performance.now(), durations = new Map();
    const observe = (step, ms) => durations.set(step, (durations.get(step) || 0) + ms);
    let data;
    try { data = await service.listHistory(req.query, sessionKey, {signal, observe}); }
    finally {
      observe('photo_history', performance.now() - started);
      res.set('Server-Timing', [...durations].map(([step, ms]) => `${step};dur=${ms.toFixed(1)}`).join(', '));
    }
    await requireStaff(req, res, () => {
      if (!isSessionCurrent(req, sessionKey)) throw new DeliveryPhotoError('STAFF_LOGIN_REQUIRED', 401);
      res.json({ok:true, data});
    });
  }));
  app.get('/api/map-phase2b/private/delivery-photos/media/:id', secure, handler(async (req, res, signal, sessionKey) => {
    if (!isSessionCurrent(req, sessionKey)) throw new DeliveryPhotoError('STAFF_LOGIN_REQUIRED', 401);
    const upstream = await service.openMedia(req.params.id, sessionKey, { signal });
    if (!upstream || upstream.status !== 200) {
      cancelBody(upstream?.body);
      throw deliveryPhotoUpstreamError(upstream?.status, 'source-media');
    }
    const type = (upstream.headers?.get?.('content-type') || '').split(';')[0].trim();
    const length = Number(upstream.headers?.get?.('content-length') || 0);
    if (!MEDIA_TYPES.has(type) || !Number.isFinite(length) || length < 0 || length > maxImageBytes) {
      cancelBody(upstream.body);
      throw new DeliveryPhotoError(!MEDIA_TYPES.has(type) ? 'INVALID_MEDIA_TYPE' : 'MEDIA_TOO_LARGE', !MEDIA_TYPES.has(type) ? 502 : 413,{stage:!MEDIA_TYPES.has(type)?'source-media':'source-size',sourceHttpStatus:upstream.status});
    }
    let permitted = false;
    await requireStaff(req, res, () => { permitted = true; });
    if (!permitted) { cancelBody(upstream.body); return; }
    if (!isSessionCurrent(req, sessionKey)) { cancelBody(upstream.body); throw new DeliveryPhotoError('STAFF_LOGIN_REQUIRED', 401); }
    res.set('Content-Type', type);
    let count = 0;
    const limiter = new Transform({ transform(chunk, _encoding, done) {
      // Recheck the current existing session for every chunk; no photo bytes are cached.
      if (!isSessionCurrent(req, sessionKey) || now() >= Number(res.locals.staffSession?.expiresAt || 0) || now() >= Number(res.locals.staffSession?.idleExpiresAt || 0)) return done(new DeliveryPhotoError('STAFF_LOGIN_REQUIRED', 401));
      count += chunk.length;
      done(count > maxImageBytes ? new DeliveryPhotoError('MEDIA_TOO_LARGE', 413) : null, chunk);
    } });
    const body = upstream.body?.getReader ? Readable.fromWeb(upstream.body) : upstream.body;
    if (!body) throw new DeliveryPhotoError('PHOTO_BODY_UNAVAILABLE', 502, {stage:'source-media'});
    await pipeline(body, limiter, res, { signal });
  }));
  return { service };
}
