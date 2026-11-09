import {DeliveryPhotoError} from './opsmapDeliveryPhotos.js';
import {deliveryPhotoUpstreamError, readBoundedPhotoLoginJson, waitForPhotoSignal} from './opsmapDeliveryAdminTransport.js';

export const STAGE_DELIVERY_ORIGIN = 'https://delivery-bali.chabyulhwa.com';
const LOGIN_PATH = '/api/auth/login';
const SESSION_MS = 20 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 6000;
const COOLDOWN_MS = 30000;
const cancelBody = body => { try { Promise.resolve(body?.cancel?.()).catch(() => {}); } catch {} };

const loginError = (code, status = 502, sourceHttpStatus) =>
  new DeliveryPhotoError(code, status, {stage:'source-login', sourceHttpStatus});

function loginCookies(headers, now) {
  const cookies = new Map();
  const setCookies = headers?.getSetCookie?.() ?? [headers?.get?.('set-cookie')].filter(Boolean);
  for (const header of setCookies.slice(0, 16)) {
    const [pair, ...attributes] = header.split(';');
    const match = pair.trim().match(/^([!#$%&'*+.^_`|~0-9A-Za-z-]+)=([\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096})$/);
    if (!match) continue;
    const age = attributes.find(value => /^\s*max-age\s*=/i.test(value));
    const expiry = attributes.find(value => /^\s*expires\s*=/i.test(value));
    const rawAge = age?.slice(age.indexOf('=') + 1).trim();
    const ageSeconds = /^-?\d+$/.test(rawAge || '') ? Number(rawAge) : NaN;
    const deadline = Number.isFinite(ageSeconds) ? now + ageSeconds * 1000
      : expiry ? Date.parse(expiry.slice(expiry.indexOf('=') + 1)) : NaN;
    if (Number.isFinite(deadline) && deadline <= now) {
      cookies.delete(match[1]);
      continue;
    }
    cookies.set(match[1], {pair:match[0], deadline});
  }
  const value = [...cookies.values()].map(item => item.pair).join('; ');
  return value.length > 8192 ? {value:'', expiresAt:Infinity}
    : {value, expiresAt:Math.min(Infinity, ...[...cookies.values()].map(item => Number.isFinite(item.deadline) ? item.deadline : Infinity))};
}

function loginToken(payload) {
  // Same response aliases as the existing Delivery Admin login in server.js.
  const token = payload?.token || payload?.accessToken || payload?.access_token
    || payload?.data?.token || payload?.data?.accessToken || payload?.data?.access_token;
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) return {value:'', expiresAt:Infinity};
  let expiresAt = Infinity;
  const segments = token.split('.');
  if (segments.length === 3) {
    try {
      const {exp} = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
      if (Number.isSafeInteger(exp) && Number.isSafeInteger(exp * 1000)) expiresAt = exp * 1000;
    } catch { /* A token can be opaque. */ }
  }
  return {value:token, expiresAt};
}

export function createStageDeliveryAdminPhotoSession({id, password, fetchImpl = globalThis.fetch, now = Date.now}) {
  let session, pending, cooldownUntil = 0, cooldownError, state = 'NOT_VERIFIED';

  function activeSession() {
    if (session && session.expiresAt <= now()) {
      session = undefined;
      state = 'EXPIRED';
    }
    return session;
  }

  function applyCooldown(error) {
    cooldownError = error;
    cooldownUntil = now() + COOLDOWN_MS;
    state = error.sourceHttpStatus === 401 || error.code === 'PHOTO_LOGIN_SESSION_MISSING'
      ? 'AUTH_REQUIRED' : 'UNAVAILABLE';
  }

  async function login(signal) {
    const url = new URL(LOGIN_PATH, STAGE_DELIVERY_ORIGIN);
    let response;
    try {
      response = await waitForPhotoSignal(Promise.resolve().then(() => {
        if (signal.aborted) throw loginError('PHOTO_TIMEOUT', 504);
        // The existing server.js login's primary request contract.
        return fetchImpl(url, {method:'POST', redirect:'manual', cache:'no-store', credentials:'omit',
          headers:{Accept:'application/json', 'Content-Type':'application/json'},
          body:JSON.stringify({username:id, password}), signal});
      }), signal, late => cancelBody(late?.body));
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') throw loginError('PHOTO_TIMEOUT', 504);
      throw loginError('PHOTO_LOGIN_NETWORK_ERROR');
    }
    try {
      const status = response?.status;
      const redirected = status >= 300 && status < 400;
      const location = response?.headers?.get('location');
      let redirectOrigin = STAGE_DELIVERY_ORIGIN;
      if (location) {
        try { redirectOrigin = new URL(location, url).origin; } catch { redirectOrigin = ''; }
      }
      if (response?.redirected || redirected && redirectOrigin !== STAGE_DELIVERY_ORIGIN) {
        throw loginError('PHOTO_LOGIN_REDIRECT_REJECTED');
      }
      if (!response?.ok && !redirected) throw deliveryPhotoUpstreamError(status, 'source-login');
      const started = now(), cookie = loginCookies(response.headers, started);
      const type = (response.headers?.get('content-type') || '').split(';')[0].trim();
      const payload = response.body && /^application\/(?:json|[a-z0-9.+-]+\+json)$/i.test(type)
        ? await readBoundedPhotoLoginJson(response, 65536, signal) : null;
      if (payload?.ok === false || payload?.success === false || payload?.error) throw loginError('PHOTO_LOGIN_SESSION_MISSING');
      const token = loginToken(payload);
      const expiresAt = Math.min(started + SESSION_MS, cookie.expiresAt, token.expiresAt);
      if ((!cookie.value && !token.value) || expiresAt <= now()) throw loginError('PHOTO_LOGIN_SESSION_MISSING');
      return {cookie:cookie.value, token:token.value, expiresAt, sourceResponded:false};
    } finally {
      cancelBody(response?.body);
    }
  }

  function startLogin() {
    const controller = new AbortController();
    const flight = {controller, waiters:0};
    pending = flight;
    const deadline = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
    const signal = AbortSignal.any([controller.signal, deadline]);
    flight.promise = login(signal).then(next => {
      if (signal.aborted || pending !== flight) throw loginError('PHOTO_TIMEOUT', 504);
      session = next;
      cooldownUntil = 0;
      cooldownError = undefined;
      state = 'NOT_VERIFIED';
      return next;
    }).catch(error => {
      const safe = error instanceof DeliveryPhotoError ? error : loginError('PHOTO_LOGIN_NETWORK_ERROR');
      if (!controller.signal.aborted && pending === flight) applyCooldown(safe);
      throw safe;
    }).finally(() => {
      if (pending === flight) pending = undefined;
    });
    return flight;
  }

  async function ensureSession(signal) {
    if (signal?.aborted) throw loginError('PHOTO_TIMEOUT', 504);
    const current = activeSession();
    if (current) return current;
    if (cooldownError && now() < cooldownUntil) throw cooldownError;
    const flight = pending || startLogin();
    flight.waiters++;
    try {
      return signal ? await waitForPhotoSignal(flight.promise, signal) : await flight.promise;
    } finally {
      flight.waiters--;
      if (!flight.waiters && pending === flight) {
        pending = undefined;
        flight.controller.abort();
      }
    }
  }

  async function read(url, {signal} = {}) {
    if (!(url instanceof URL) || url.origin !== STAGE_DELIVERY_ORIGIN || url.username || url.password || url.hash) {
      throw new DeliveryPhotoError('INVALID_PHOTO_REQUEST', 400);
    }
    const send = credentials => {
      if (signal?.aborted) throw new DeliveryPhotoError('PHOTO_TIMEOUT', 504);
      return fetchImpl(url, {method:'GET', redirect:'error', cache:'no-store', credentials:'omit', signal,
        headers:{Accept:'application/json', ...(credentials.cookie ? {Cookie:credentials.cookie} : {}),
          ...(credentials.token ? {Authorization:'Bearer ' + credentials.token} : {})}});
    };
    let current = await ensureSession(signal);
    let response = await send(current);
    if (response?.status === 401) {
      cancelBody(response.body);
      if (session === current) {
        session = undefined;
        state = 'AUTH_REQUIRED';
      }
      current = await ensureSession(signal);
      response = await send(current);
      if (response?.status === 401 && session === current) {
        session = undefined;
        applyCooldown(deliveryPhotoUpstreamError(401));
      }
    }
    if (response?.status === 200 && session === current) current.sourceResponded = true;
    return response;
  }

  return {
    async prepareSession({signal} = {}) { await ensureSession(signal); },
    hasSession:() => Boolean(activeSession()),
    sourceState() { activeSession(); return state; },
    markVerified() { if (activeSession()?.sourceResponded) state = 'VERIFIED'; },
    read
  };
}
