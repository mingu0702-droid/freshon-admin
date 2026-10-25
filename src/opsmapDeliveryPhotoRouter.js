import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeliveryPhotoService, DeliveryPhotoError } from './opsmapDeliveryPhotos.js';

const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
// Cleanup must never delay the bounded HTTP error when an upstream cancel hook
// does not settle. Promise rejection is consumed without logging private data.
const cancelBody = body => { try { Promise.resolve(body?.cancel?.()).catch(() => {}); } catch {} };
function failure(error, res) {
  const status = error instanceof DeliveryPhotoError ? error.status
    : error?.name === 'AbortError' ? 504 : [401, 403, 404, 410, 429].includes(error?.status) ? error.status : 502;
  const code = error instanceof DeliveryPhotoError ? error.code
    : status === 504 ? 'PHOTO_TIMEOUT' : status === 401 ? 'UPSTREAM_AUTH_REQUIRED'
      : status === 403 ? 'PHOTO_FORBIDDEN' : [404, 410].includes(status) ? 'PHOTO_NOT_FOUND' : status === 429 ? 'PHOTO_RATE_LIMITED' : 'PHOTO_LOOKUP_FAILED';
  // Upstream login failure must not log out a valid map staff session in the UI.
  const responseStatus = !(error instanceof DeliveryPhotoError) && error?.status === 401 ? 502 : status;
  if (!res.headersSent) res.status(responseStatus).json({ ok: false, error: { code } });
  else res.destroy();
}
// Dependency injection preserves A's existing staff session and makes the feature default OFF.
export function mountOpsmapDeliveryPhotoRoutes({ app, requireStaff, isSessionCurrent = () => false, source = null, enabled = false,
  timeoutMs = 8000, maxImageBytes = 4 * 1024 * 1024, maxConcurrent = 3, now = Date.now } = {}) {
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
  app.get('/api/map-phase2b/private/delivery-photos', secure, handler(async (req, res, signal, sessionKey) => {
    const data = await service.list(req.query, sessionKey, { signal });
    // Session can expire or be revoked while the upstream request is in flight.
    requireStaff(req, res, () => res.json({ ok: true, data }));
  }));
  app.get('/api/map-phase2b/private/delivery-photos/media/:id', secure, handler(async (req, res, signal, sessionKey) => {
    const upstream = await service.openMedia(req.params.id, sessionKey, { signal });
    if (!upstream || upstream.status !== 200) {
      cancelBody(upstream?.body);
      const status = [401, 403, 404, 410, 429].includes(upstream?.status) ? upstream.status : 502;
      throw Object.assign(new Error('UPSTREAM_MEDIA_FAILED'), { status });
    }
    const type = (upstream.headers?.get?.('content-type') || '').split(';')[0].trim();
    const length = Number(upstream.headers?.get?.('content-length') || 0);
    if (!MEDIA_TYPES.has(type) || !Number.isFinite(length) || length < 0 || length > maxImageBytes) {
      cancelBody(upstream.body);
      throw new DeliveryPhotoError(!MEDIA_TYPES.has(type) ? 'INVALID_MEDIA_TYPE' : 'MEDIA_TOO_LARGE', !MEDIA_TYPES.has(type) ? 502 : 413);
    }
    let permitted = false;
    requireStaff(req, res, () => { permitted = true; });
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
    if (!body) throw new DeliveryPhotoError('PHOTO_NOT_FOUND', 404);
    await pipeline(body, limiter, res, { signal });
  }));
  return { service };
}
