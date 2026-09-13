import { performance } from 'node:perf_hooks';

const endpoints = new Set([
  '/api/map-phase2b/auth/login', '/api/map-phase2b/auth/session', '/api/map-phase2b/auth/logout',
  '/api/map-phase2b/private/customer-detail', '/api/map-phase2b/preview/detail'
]);
export function addStaffTiming(res, name, duration) {
  if (res.locals.staffTiming && Number.isFinite(duration)) res.locals.staffTiming[name] = (res.locals.staffTiming[name] || 0) + duration;
}
export function staffLatency(req, res, next) {
  if (!endpoints.has(req.path)) return next();
  const started = performance.now(), receivedAt = new Date().toISOString(), endpoint = req.path;
  const timings = res.locals.staffTiming = { authVerify: 0, session: 0, upstream: 0, parseNormalize: 0, hub: 0 };
  const original = res.writeHead;
  res.writeHead = function (...args) {
    timings.total = performance.now() - started;
    res.setHeader('Server-Timing', Object.entries(timings).map(([name, ms]) => name + ';dur=' + ms.toFixed(2)).join(', '));
    res.setHeader('X-Request-Received-At', receivedAt);
    res.setHeader('X-App-Uptime-Ms', Math.round(process.uptime() * 1000));
    const cookie = String(res.getHeader('Set-Cookie') || '');
    if (cookie.includes('__Host-map-staff=')) {
      res.setHeader('X-Staff-Cookie-Policy', JSON.stringify({ httpOnly: /;\s*HttpOnly/i.test(cookie), secure: /;\s*Secure/i.test(cookie), sameSite: /;\s*SameSite=Strict/i.test(cookie) ? 'Strict' : 'OTHER' }));
    }
    return original.apply(this, args);
  };
  res.once('finish', () => console.info(JSON.stringify({
    component: 'staff-latency', endpoint, status: res.statusCode, receivedAt,
    ...Object.fromEntries(Object.entries(timings).map(([key, ms]) => [key + 'Ms', Math.round(ms * 100) / 100])),
    processUptimeMs: Math.round(process.uptime() * 1000)
  })));
  next();
}
