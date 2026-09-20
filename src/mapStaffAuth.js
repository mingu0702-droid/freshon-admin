import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import argon2 from 'argon2';
import { addStaffTiming } from './staffLatency.js';

const scrypt = promisify(crypto.scrypt);
export const STAFF_COOKIE = '__Host-map-staff';
export const STAFF_IDLE_MS = 30 * 60 * 1000;
export const STAFF_MAX_MS = 8 * 60 * 60 * 1000;
const params = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const digest = value => crypto.createHash('sha256').update(String(value)).digest();
const equal = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const legacyHash = hash => /^scrypt\$131072\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(hash || '');
const argonHash = hash => /^\$argon2id\$v=19\$m=19456,(?:t=2,p=1|p=1,t=2)\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(hash || '');
const validHash = hash => legacyHash(hash) || argonHash(hash);
const argonParams = { type: argon2.argon2id, version: 0x13, memoryCost: 19456, timeCost: 2, parallelism: 1, hashLength: 32 };

// OWASP Argon2id baseline; native async worker, never on the JS event loop.
// Existing scrypt hashes remain valid until the operator replaces only the hash.
export async function createStaffPasswordHash(password) {
  if (typeof password !== 'string' || password.length < 6 || Buffer.byteLength(password) > 1024) throw new Error('PASSWORD_LENGTH');
  const salt = crypto.randomBytes(16);
  return argon2.hash(password, { ...argonParams, salt });
}
export async function verifyStaffPassword(password, hash) {
  if (!validHash(hash) || typeof password !== 'string' || Buffer.byteLength(password) > 1024) return false;
  if (argonHash(hash)) return argon2.verify(hash, password);
  const parts = hash.split('$');
  const result = await scrypt(password, Buffer.from(parts[4], 'base64url'), 32, params);
  return crypto.timingSafeEqual(result, Buffer.from(parts[5], 'base64url'));
}

// Deliberately single-process. A restart/credential rotation revokes all sessions.
// Scaling this service requires a shared store first; never enable cluster workers.
export function createMapStaffAuth({ env = process.env, now = Date.now } = {}) {
  const sessions = new Map(), attempts = new Map();
  let fingerprint = '', verifying = false;
  const cookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };
  const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); res.set('Vary', 'Cookie'); next(); };
  function configuration() {
    const id = env.MAP_STAFF_ID || '', hash = env.MAP_STAFF_PASSWORD_HASH || '', secret = env.MAP_STAFF_SESSION_SECRET || '';
    const nextFingerprint = digest([id, hash, secret, env.RENDER_EXTERNAL_URL || ''].join('\n')).toString('hex');
    if (fingerprint !== nextFingerprint) { sessions.clear(); fingerprint = nextFingerprint; }
    let origin = '';
    try { const u = new URL(env.RENDER_EXTERNAL_URL || env.MAP_STAFF_ORIGIN || ''); if (u.protocol === 'https:' && u.pathname === '/') origin = u.origin; } catch {}
    const ready = Boolean(id && id.length <= 128 && validHash(hash) && /^[A-Za-z0-9_-]{43,128}$/.test(secret)
      && secret !== env.ADMIN_TOKEN && secret !== env.HUB_API_SECRET && origin
      && Number(env.WEB_CONCURRENCY || 1) === 1 && Number(env.MAP_STAFF_INSTANCE_COUNT || 1) === 1);
    return { id, hash, secret, origin, ready };
  }
  function sameOrigin(req, config) {
    if (req.get('sec-fetch-site') && !['same-origin', 'none'].includes(req.get('sec-fetch-site'))) return false;
    return req.get('origin') === config.origin;
  }
  function sessionKey(req, config) {
    const cookies = String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${STAFF_COOKIE}=`));
    if (cookies.length !== 1) return '';
    const value = cookies[0].slice(STAFF_COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return '';
    return crypto.createHmac('sha256', config.secret).update(value).digest('hex');
  }
  function readSession(req, touch = true) {
    const config = configuration();
    if (!config.ready) return null;
    if (req.get('origin') && req.get('origin') !== config.origin) return null;
    if (req.get('sec-fetch-site') && !['same-origin', 'none'].includes(req.get('sec-fetch-site'))) return null;
    const key = sessionKey(req, config), session = sessions.get(key), time = now();
    if (!session || time >= session.expiresAt || time >= session.idleExpiresAt) { sessions.delete(key); return null; }
    if (touch) session.idleExpiresAt = Math.min(session.expiresAt, time + STAFF_IDLE_MS);
    return { key, ...session };
  }
  const requireStaff = (req, res, next) => noStore(req, res, () => {
    const started = performance.now();
    const session = readSession(req);
    addStaffTiming(res, 'session', performance.now() - started);
    if (!session) return res.status(401).json({ error: 'STAFF_LOGIN_REQUIRED' });
    res.locals.sensitiveAuthenticated = true;
    res.locals.staffSession = session;
    res.set('X-Staff-Expires-At', String(session.expiresAt));
    res.set('X-Staff-Idle-Expires-At', String(session.idleExpiresAt));
    next();
  });
  function limited(req) {
    const time = now(), windowMs = 15 * 60 * 1000;
    for (const [key, item] of attempts) if (time >= item.until) attempts.delete(key);
    // socket peer only: do NOT trust arbitrary X-Forwarded-For. Global budget
    // protects the shared account even if the reverse proxy has multiple peers.
    const peer = digest(req.socket.remoteAddress || 'unknown').toString('hex');
    const keys = [['global', 30], [peer, 10]];
    for (const [key, limit] of keys) if ((attempts.get(key)?.count || 0) >= limit) return true;
    if (attempts.size > 1024) return true;
    for (const [key] of keys) { const item = attempts.get(key) || { count: 0, until: time + windowMs }; item.count++; attempts.set(key, item); }
    return false;
  }
  const router = express.Router();
  router.use(noStore);
  router.use(express.json({ limit: '4kb' }));
  router.get('/session', (req, res) => {
    // Status polling must not extend the idle deadline.
    const started = performance.now();
    const session = readSession(req, false);
    addStaffTiming(res, 'session', performance.now() - started);
    return res.json({ authenticated: Boolean(session), configured: configuration().ready,
      expiresAt: session?.expiresAt || null, idleExpiresAt: session?.idleExpiresAt || null });
  });
  router.post('/login', async (req, res) => {
    const config = configuration();
    if (!config.ready) return res.status(503).json({ error: 'STAFF_AUTH_NOT_CONFIGURED' });
    if (!sameOrigin(req, config) || !req.is('application/json')) return res.status(403).json({ error: 'ORIGIN_REJECTED' });
    if (limited(req) || verifying) { res.set('Retry-After', '60'); return res.status(429).json({ error: 'LOGIN_RETRY_LATER' }); }
    if (typeof req.body?.id !== 'string' || req.body.id.length > 128 || typeof req.body?.password !== 'string' || Buffer.byteLength(req.body.password) > 1024) return res.status(401).json({ error: 'LOGIN_FAILED' });
    verifying = true;
    try {
      const verifyStarted = performance.now();
      const valid = await verifyStaffPassword(req.body.password, config.hash);
      addStaffTiming(res, 'authVerify', performance.now() - verifyStarted);
      const current = configuration();
      if (!valid || !equal(req.body.id, config.id) || !current.ready || !equal(current.hash, config.hash) || !equal(current.secret, config.secret) || !equal(current.id, config.id)) return res.status(401).json({ error: 'LOGIN_FAILED' });
      const sessionStarted = performance.now(), time = now();
      for (const [key, session] of sessions) if (time >= session.expiresAt || time >= session.idleExpiresAt) sessions.delete(key);
      if (sessions.size >= 1000) return res.status(503).json({ error: 'LOGIN_RETRY_LATER' });
      sessions.delete(sessionKey(req, config));
      const token = crypto.randomBytes(32).toString('base64url');
      const key = crypto.createHmac('sha256', config.secret).update(token).digest('hex');
      const session = { expiresAt: time + STAFF_MAX_MS, idleExpiresAt: time + STAFF_IDLE_MS };
      sessions.set(key, session);
      res.cookie(STAFF_COOKIE, token, { ...cookieOptions, maxAge: STAFF_MAX_MS });
      addStaffTiming(res, 'session', performance.now() - sessionStarted);
      return res.json({ authenticated: true, ...session });
    } catch { return res.status(503).json({ error: 'LOGIN_UNAVAILABLE' }); }
    finally { verifying = false; if (req.body) req.body.password = ''; }
  });
  router.post('/logout', (req, res) => {
    const started = performance.now();
    const config = configuration();
    if (!config.ready || !sameOrigin(req, config)) return res.status(403).json({ error: 'ORIGIN_REJECTED' });
    sessions.delete(sessionKey(req, config));
    res.clearCookie(STAFF_COOKIE, cookieOptions);
    addStaffTiming(res, 'session', performance.now() - started);
    return res.json({ authenticated: false });
  });
  return { router, requireStaff };
}
