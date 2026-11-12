import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import argon2 from 'argon2';
import { addStaffTiming } from './staffLatency.js';

const scrypt = promisify(crypto.scrypt);
export const STAFF_COOKIE = '__Host-opsmap-staff';
export const STAFF_IDLE_MS = 8 * 60 * 60 * 1000;
export const STAFF_MAX_MS = 12 * 60 * 60 * 1000;
export function staffSessionPolicy(env={}) {
  const idleHours=env.MAP_STAFF_IDLE_HOURS===undefined?8:Number(env.MAP_STAFF_IDLE_HOURS);
  const maxHours=env.MAP_STAFF_MAX_HOURS===undefined?12:Number(env.MAP_STAFF_MAX_HOURS);
  if(!Number.isInteger(idleHours)||!Number.isInteger(maxHours)||idleHours<1||idleHours>72||maxHours<idleHours||maxHours>168)throw Error('STAFF_SESSION_POLICY_INVALID');
  return {idleMs:idleHours*3600000,maxMs:maxHours*3600000};
}
const params = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
const digest = value => crypto.createHash('sha256').update(String(value)).digest();
const equal = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const legacyHash = hash => /^scrypt\$131072\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(hash || '');
const argonHash = hash => /^\$argon2id\$v=19\$m=19456,(?:t=2,p=1|p=1,t=2)\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(hash || '');
const validHash = hash => legacyHash(hash) || argonHash(hash);
const argonParams = { type: argon2.argon2id, version: 0x13, memoryCost: 19456, timeCost: 2, parallelism: 1, hashLength: 32 };
const loginWindowMs = 15 * 60 * 1000;

function stageLoginThrottle(env, now) {
  const limit = (name, ceiling) => {
    const value = env[name] === undefined ? ceiling : Number(env[name]);
    if (!Number.isInteger(value) || value < 1 || value > ceiling) throw Error('STAFF_LOGIN_POLICY_INVALID');
    return value;
  };
  const attemptLimit = limit('MAP_STAFF_LOGIN_ATTEMPT_LIMIT', 100);
  const failureLimit = limit('MAP_STAFF_LOGIN_FAILURE_LIMIT', 30);
  const peerLimit = limit('MAP_STAFF_LOGIN_PEER_FAILURE_LIMIT', 10);
  const peerFailures = new Map();
  let attempts, failures, tail = Promise.resolve();
  const active = (bucket, at) => bucket && at < bucket.until;
  const delay = (bucket, cap, at) => active(bucket, at) && bucket.count >= cap ? bucket.until - at : 0;
  const increment = (bucket, at) => active(bucket, at)
    ? { count: bucket.count + 1, until: bucket.until }
    : { count: 1, until: at + loginWindowMs };
  const failureDelay = (peer, at) => Math.max(delay(failures, failureLimit, at), delay(peerFailures.get(peer), peerLimit, at));
  return {
    attemptLimit,
    begin(req) {
      // A socket peer is stable and cannot be replaced with a client-supplied header.
      const peer = digest(req.socket.remoteAddress || 'unknown').toString('hex');
      const at = now();
      for (const [key, bucket] of peerFailures) if (!active(bucket, at)) peerFailures.delete(key);
      const retry = Math.max(delay(attempts, attemptLimit, at), failureDelay(peer, at));
      if (!retry) attempts = increment(attempts, at);
      return { peer, retry };
    },
    verify(peer, check) {
      // Queue only password checks. Argon2/scrypt uses one worker's memory and
      // queued checks see any failures that reached the cap ahead of them.
      const result = tail.then(async () => {
        const retry = failureDelay(peer, now());
        if (retry) return { retry };
        const valid = await check();
        if (!valid) {
          const at = now();
          failures = increment(failures, at);
          peerFailures.set(peer, increment(peerFailures.get(peer), at));
        }
        return { valid };
      });
      tail = result.then(() => {}, () => {});
      return result;
    }
  };
}

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

// The approved persistent store survives restarts; credential rotation still revokes sessions.
export function createMapStaffAuth({ env = process.env, now = Date.now, sessionStore } = {}) {
  const policy=staffSessionPolicy(env);
  const stageThrottle=env.OPSMAP_STAGE_VERIFY_ONLY==='1'?stageLoginThrottle(env,now):null;
  const sessions = new Map(), attempts = new Map();
  const revoked = new Set();
  const processStartedAt = new Date(now()).toISOString();
  let fingerprint = '', verifying = false;
  const cookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };
  const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); res.set('Vary', 'Cookie'); return next(); };
  function storeUnavailable(res, error, code = 'STAFF_SESSION_STORE_UNAVAILABLE') {
    if (stageThrottle && error?.retryAfterMs > 0) res.set('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
    return res.status(503).json({ error: code });
  }
  function configuration() {
    const id = env.MAP_STAFF_ID || '', hash = env.MAP_STAFF_PASSWORD_HASH || '', secret = env.MAP_STAFF_SESSION_SECRET || '';
    const nextFingerprint = digest([id, hash, secret, env.RENDER_EXTERNAL_URL || env.MAP_STAFF_ORIGIN || '',sessionStore?'DURABLE_SESSION_V2':'PROCESS_MEMORY'].join('\n')).toString('hex');
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
  function readMemorySession(req) {
    const config = configuration();
    if (!config.ready) return null;
    if (req.get('origin') && req.get('origin') !== config.origin) return null;
    if (req.get('sec-fetch-site') && !['same-origin', 'none'].includes(req.get('sec-fetch-site'))) return null;
    const key = sessionKey(req, config), session = sessions.get(key), time = now();
    if (revoked.has(key) || !session || time >= session.expiresAt || time >= session.idleExpiresAt) { sessions.delete(key); return null; }
    return { key, ...session };
  }
  async function readSession(req,touch=false){
    const config=configuration(),key=sessionKey(req,config),revision=fingerprint;
    if(!config.ready||!key||revoked.has(key)||req.get('origin')&&req.get('origin')!==config.origin||req.get('sec-fetch-site')&&!['same-origin','none'].includes(req.get('sec-fetch-site')))return null;
    if(sessionStore){const saved=await sessionStore.get(key,revision);if(revoked.has(key)||configuration().secret!==config.secret||fingerprint!==revision)return null;if(saved)sessions.set(key,saved);else sessions.delete(key);}
    const current=readMemorySession(req);if(!current)return null;
    if(touch){const updated={expiresAt:current.expiresAt,idleExpiresAt:Math.min(current.expiresAt,now()+policy.idleMs)};if(revoked.has(key))return null;if(sessionStore&&!(await sessionStore.touch(key,updated,revision)))return null;if(revoked.has(key)||fingerprint!==revision)return null;sessions.set(key,updated);return {key,...updated};}
    return current;
  }
  const requireStaff = (req, res, next) => noStore(req, res, async () => {
    const started = performance.now();
    // Ordinary/background map reads do not manufacture employee activity.
    // Only the explicit same-origin activity check below renews the idle lease.
    let session;try{session=await readSession(req,false);}catch(error){return storeUnavailable(res,error);}
    addStaffTiming(res, 'session', performance.now() - started);
    if (!session) return res.status(401).json({ error: 'STAFF_LOGIN_REQUIRED' });
    res.locals.sensitiveAuthenticated = true;
    res.locals.staffSession = session;
    res.set('X-Staff-Expires-At', String(session.expiresAt));
    res.set('X-Staff-Idle-Expires-At', String(session.idleExpiresAt));
    next();
  });
  function limited(req) {
    const time = now();
    for (const [key, item] of attempts) if (time >= item.until) attempts.delete(key);
    // socket peer only: do NOT trust arbitrary X-Forwarded-For. Global budget
    // protects the shared account even if the reverse proxy has multiple peers.
    const peer = digest(req.socket.remoteAddress || 'unknown').toString('hex');
    const keys = [['global', 30], [peer, 10]];
    for (const [key, limit] of keys) if ((attempts.get(key)?.count || 0) >= limit) return true;
    if (attempts.size > 1024) return true;
    for (const [key] of keys) { const item = attempts.get(key) || { count: 0, until: time + loginWindowMs }; item.count++; attempts.set(key, item); }
    return false;
  }
  const router = express.Router();
  router.use(noStore);
  router.use(express.json({ limit: '4kb' }));
  router.get('/session', async (req, res) => {
    // A trusted UI activity check can renew idle time; background status cannot.
    const started = performance.now();
    const activity = req.get('x-map-staff-activity') === '1'
      && (req.get('sec-fetch-site') === 'same-origin' || req.get('origin') === configuration().origin);
    const prior = sessions.get(sessionKey(req, configuration()));
    const expired = Boolean(prior && (now() >= prior.expiresAt || now() >= prior.idleExpiresAt));
    let session;try{session=await readSession(req,activity);}catch(error){return storeUnavailable(res,error);}
    addStaffTiming(res, 'session', performance.now() - started);
    return res.json({ authenticated: Boolean(session), configured: configuration().ready,
      expiresAt: session?.expiresAt || null, idleExpiresAt: session?.idleExpiresAt || null,
      reason: session ? null : expired ? 'SESSION_EXPIRED' : sessionKey(req, configuration()) ? 'SESSION_UNAVAILABLE' : 'SIGNED_OUT',
      policy: { ...policy, persistence: sessionStore?.kind||'PROCESS_MEMORY', processStartedAt,
        ...(session&&stageThrottle ? {loginAttemptLimit:stageThrottle.attemptLimit,loginWindowMs,
          storeReads:sessionStore?.stats?.()} : {}) } });
  });
  router.post('/login', async (req, res) => {
    const config = configuration();
    if (!config.ready) return res.status(503).json({ error: 'STAFF_AUTH_NOT_CONFIGURED' });
    if (!sameOrigin(req, config) || !req.is('application/json')) return res.status(403).json({ error: 'ORIGIN_REJECTED' });
    const rateLimited = delayMs => res.set('Retry-After', String(Math.ceil(delayMs / 1000))).status(429).json({ error: 'LOGIN_RETRY_LATER' });
    const admission = stageThrottle?.begin(req);
    if (admission?.retry) return rateLimited(admission.retry);
    if (!stageThrottle && (limited(req) || verifying)) return rateLimited(60000);
    if (!stageThrottle) verifying = true;
    try {
      const check = async () => {
        if (typeof req.body?.id !== 'string' || req.body.id.length > 128 || typeof req.body?.password !== 'string' || Buffer.byteLength(req.body.password) > 1024) return false;
        const verifyStarted = performance.now();
        const valid = await verifyStaffPassword(req.body.password, config.hash);
        addStaffTiming(res, 'authVerify', performance.now() - verifyStarted);
        return valid && equal(req.body.id, config.id);
      };
      const result = stageThrottle ? await stageThrottle.verify(admission.peer, check) : { valid: await check() };
      if (result.retry) return rateLimited(result.retry);
      const current = configuration();
      if (!result.valid || !current.ready || !equal(current.hash, config.hash) || !equal(current.secret, config.secret) || !equal(current.id, config.id)) return res.status(401).json({ error: 'LOGIN_FAILED' });
      const sessionStarted = performance.now(), time = now();
      for (const [key, session] of sessions) if (time >= session.expiresAt || time >= session.idleExpiresAt) sessions.delete(key);
      if (sessions.size >= 1000) return res.status(503).json({ error: 'LOGIN_RETRY_LATER' });
      const previousKey=sessionKey(req,config);if(previousKey){revoked.add(previousKey);sessions.delete(previousKey);if(sessionStore)await sessionStore.delete(previousKey);}
      const token = crypto.randomBytes(32).toString('base64url');
      const key = crypto.createHmac('sha256', config.secret).update(token).digest('hex');
      const session = { expiresAt: time + policy.maxMs, idleExpiresAt: time + policy.idleMs };
      if(sessionStore)await sessionStore.set(key,session,fingerprint);
      const afterSave=configuration();if(!afterSave.ready||!equal(afterSave.hash,config.hash)||!equal(afterSave.secret,config.secret))return res.status(503).json({error:'LOGIN_UNAVAILABLE'});
      sessions.set(key, session);
      res.cookie(STAFF_COOKIE, token, { ...cookieOptions, maxAge: policy.maxMs });
      addStaffTiming(res, 'session', performance.now() - sessionStarted);
      return res.json({ authenticated: true, ...session });
    } catch (error) { return storeUnavailable(res,error,'LOGIN_UNAVAILABLE'); }
    finally { if (!stageThrottle) verifying = false; if (req.body) req.body.password = ''; }
  });
  router.post('/logout', async (req, res) => {
    const started = performance.now();
    const config = configuration();
    if (!config.ready || !sameOrigin(req, config)) return res.status(403).json({ error: 'ORIGIN_REJECTED' });
    const key=sessionKey(req,config);
    if(key){
      revoked.add(key);sessions.delete(key);
      try{if(sessionStore)await sessionStore.delete(key);}
      catch(error){
        if(stageThrottle)res.clearCookie(STAFF_COOKIE,cookieOptions);
        return storeUnavailable(res,error);
      }
    }
    res.clearCookie(STAFF_COOKIE, cookieOptions);
    addStaffTiming(res, 'session', performance.now() - started);
    return res.json({ authenticated: false });
  });
  return { router, requireStaff, isSessionCurrent: (req, expectedKey) => {
    // Do not extend idle time or write headers while rechecking a media stream.
    const current = readMemorySession(req);
    return Boolean(current && current.key === expectedKey);
  } };
}
