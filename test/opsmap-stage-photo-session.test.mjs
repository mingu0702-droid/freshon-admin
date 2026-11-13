import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createStageOperationalPhotoExtension} from '../src/opsmapStagePhotos.js';
import {createStageDeliveryAdminPhotoSession, STAGE_DELIVERY_ORIGIN} from '../src/opsmapStageDeliveryAdminSession.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from '../src/stageAbValidation.js';

const stageEnv = {
  RENDER_EXTERNAL_URL:STAGE_ORIGIN, RENDER_SERVICE_ID:STAGE_SERVICE,
  OPSMAP_STAGE_DELIVERY_PHOTO_AUTH_ENABLED:'1', OPSMAP_STAGE_DELIVERY_PHOTO_ID:'stage-fixture',
  OPSMAP_STAGE_DELIVERY_PHOTO_PASSWORD:'fixture-secret'
};
const api = '/api/map-phase2b/private/delivery-photos';
const customerCode = 'S990001', date = '2026-11-04', deliveryId = '990001';
const query = '?customerCode=' + customerCode + '&date=' + date;
const exact = api + query + '&deliveryId=' + deliveryId;
const sourceTask = {id:deliveryId, customer:{erpCode:customerCode}, carrier:{enteringDatedAt:date + 'T00:00:00+09:00'}};
const approvedDetail = new URL('/api/bali/task/' + deliveryId, STAGE_DELIVERY_ORIGIN);
const issueCookie = (generation = 1, maxAge = 1200) => new Response(null, {
  status:204, headers:{'Set-Cookie':'fixture_session=issued-' + generation + '; Path=/; HttpOnly; Secure; Max-Age=' + maxAge}
});

async function fixture({env = stageEnv, onLogin, sourceStatus, lifetime = 1200} = {}) {
  const app = express(), reads = [], media = [];
  let now = Date.now(), allowed = true, logins = 0;
  const requireStaff = (req, res, next) => {
    if (!allowed || req.get('x-staff') !== 'first') return res.status(401).end();
    const expiresAt = Date.now() + 60000;
    res.locals.staffSession = {key:'first', expiresAt, idleExpiresAt:expiresAt};
    return next();
  };
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    assert.equal(options.cache, 'no-store');
    if (options.method === 'POST') {
      logins++;
      assert.equal(url.href, STAGE_DELIVERY_ORIGIN + '/api/auth/login');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers.Cookie, undefined);
      assert.equal(options.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(options.body), {username:'stage-fixture', password:'fixture-secret'});
      return onLogin ? onLogin(logins, options.signal) : issueCookie(logins, lifetime);
    }
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    if (url.hostname === 'static.chabyulhwa.com') {
      media.push(url.pathname);
      assert.equal(options.headers.Cookie, undefined);
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.credentials, 'omit');
      return new Response('stage-media-fixture', {headers:{'Content-Type':'image/png'}});
    }
    assert.equal(url.origin, STAGE_DELIVERY_ORIGIN);
    assert.match(options.headers.Cookie || '', /^fixture_session=issued-\d+$/);
    assert.equal(options.headers.Authorization, undefined);
    reads.push(url.pathname);
    const error = sourceStatus?.(url, options.headers.Cookie);
    if (error) return new Response(null, {status:error});
    if (url.pathname === '/api/bali/task') {
      assert.equal(url.searchParams.get('customerErpCodeLike'), customerCode);
      return Response.json({data:{content:[sourceTask], totalElements:1, totalPages:1}});
    }
    if (url.pathname.endsWith('/status-record')) return Response.json({data:[{id:'1', taskId:deliveryId, taskAttachments:[
      {typeText:'냉장고 문은 잘 닫았나요?', images:[{url:'https://static.chabyulhwa.com/fixture.png?signature=fixture'}]}
    ]}]});
    assert.equal(url.href, approvedDetail.href);
    return Response.json({data:sourceTask});
  };
  createStageOperationalPhotoExtension({env, fetchImpl, defaultDate:() => date, now:() => now}).mount({
    app, requireStaff, isSessionCurrent:(req, key) => allowed && req.get('x-staff') === key, previewEnabled:() => true
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  return {get:(url, staff = 'first') => fetch(origin + url, {headers:{'x-staff':staff}}),
    stats:() => ({logins, reads:reads.length, media:media.length}),
    advance(ms) { now += ms; }, logout() { allowed = false; },
    close:() => new Promise(resolve => server.close(resolve))};
}

test('approved Stage login is lazy, staff-bound and single flight, and media refreshes an expired session', async () => {
  const f = await fixture({lifetime:30});
  try {
    assert.equal((await f.get(api + '/config', 'anonymous')).status, 401);
    assert.equal((await f.get(exact, 'anonymous')).status, 401);
    assert.equal((await f.get(api + '/media/not-a-handle')).status, 404);
    assert.equal((await f.get(api + '?customerCode=invalid%2F')).status, 400);
    const config = await (await f.get(api + '/config')).json();
    assert.deepEqual(config.data, {enabled:true, cookieConfigured:false, sourceSession:false, indexedHistoryConfigured:false,
      sourceAuth:'NOT_VERIFIED', metadataConfigured:true, authMode:'APPROVED_ACCOUNT', credentialsConfigured:true});
    assert.deepEqual(f.stats(), {logins:0, reads:0, media:0});
    const [discovery, detail] = await Promise.all([f.get(api + query), f.get(exact)]);
    assert.equal(discovery.status, 200);
    assert.equal(detail.status, 200);
    const text = await detail.text();
    assert(!/fixture-secret|stage-fixture|issued-|static.chabyulhwa.com|signature=/.test(text));
    const [row] = JSON.parse(text).data.deliveries;
    assert.equal(row.status, 'READY');
    assert.equal(row.photos[0].kind, 'REFRIGERATOR_DOOR');
    assert.equal(f.stats().logins, 1);
    assert.equal((await (await f.get(api + '/config')).json()).data.sourceAuth, 'VERIFIED');
    f.advance(30001);
    assert.equal((await (await f.get(api + '/config')).json()).data.sourceAuth, 'EXPIRED');
    assert.equal(f.stats().logins, 1);
    const image = await f.get(row.photos[0].thumbnailUrl);
    assert.equal(image.status, 200);
    assert.match(image.headers.get('cache-control'), /no-store/);
    assert.equal(await image.text(), 'stage-media-fixture');
    assert.equal(f.stats().logins, 2);
    assert.equal(f.stats().media, 1);
    f.logout();
    assert.equal((await f.get(row.photos[0].url)).status, 401);
    assert.equal(f.stats().media, 1);
  } finally { await f.close(); }

  const restarted = await fixture();
  try {
    assert.equal((await (await restarted.get(api + '/config')).json()).data.sourceSession, false);
    assert.equal((await restarted.get(exact)).status, 200);
    assert.equal(restarted.stats().logins, 1);
  } finally { await restarted.close(); }
});

test('account mode cannot use wrong Stage identity, missing account values, disabled feature or legacy credentials', async () => {
  for (const env of [
    {...stageEnv, RENDER_SERVICE_ID:'production', DELIVERY_ADMIN_ID:'legacy-prod', OPSMAP_STAGE_DELIVERY_PHOTO_COOKIE:'legacy=cookie'},
    {...stageEnv, OPSMAP_STAGE_DELIVERY_PHOTO_PASSWORD:'', DELIVERY_ADMIN_PASSWORD:'legacy-prod', OPSMAP_STAGE_DELIVERY_PHOTO_COOKIE:'legacy=cookie'},
    {...stageEnv, OPSMAP_STAGE_DELIVERY_PHOTOS_ENABLED:'0'}
  ]) {
    const f = await fixture({env});
    try {
      const response = await f.get(exact);
      const disabled = env.OPSMAP_STAGE_DELIVERY_PHOTOS_ENABLED === '0';
      assert.equal(response.status, disabled ? 503 : 502);
      assert.equal((await response.json()).error.code, disabled ? 'PHOTO_SOURCE_DISABLED' : 'UPSTREAM_AUTH_REQUIRED');
      assert.equal((await (await f.get(api + '/config')).json()).data.cookieConfigured, false);
      assert.deepEqual(f.stats(), {logins:0, reads:0, media:0});
    } finally { await f.close(); }
  }
});

test('only explicit Stage photo approval can reuse an account already stored on Stage', async () => {
  const env = {RENDER_EXTERNAL_URL:STAGE_ORIGIN, RENDER_SERVICE_ID:STAGE_SERVICE,
    DELIVERY_ADMIN_ID:'stage-fixture', DELIVERY_ADMIN_PASSWORD:'fixture-secret'};
  for (const [overrides, expected] of [
    [{},502],
    [{OPSMAP_STAGE_DELIVERY_PHOTO_USE_EXISTING_ADMIN:'1', RENDER_SERVICE_ID:'production'},502],
    [{OPSMAP_STAGE_DELIVERY_PHOTO_USE_EXISTING_ADMIN:'1', OPSMAP_STAGE_DELIVERY_PHOTO_AUTH_ENABLED:'1'},502],
    [{OPSMAP_STAGE_DELIVERY_PHOTO_USE_EXISTING_ADMIN:'1'},200]
  ]) {
    const f = await fixture({env:{...env,...overrides},lifetime:30});
    try {
      const result = await f.get(exact);
      assert.equal(result.status,expected);
      if (expected===502) { assert.deepEqual(f.stats(),{logins:0,reads:0,media:0}); continue; }
      assert.equal(f.stats().logins,1);
      const [row] = (await result.json()).data.deliveries;
      f.advance(30001);
      assert.equal((await f.get(row.photos[0].thumbnailUrl)).status,200);
      assert.equal(f.stats().logins,2);
      f.logout();
      assert.equal((await f.get(row.photos[0].url)).status,401);
    } finally { await f.close(); }
  }
});

test('an upstream 401 renews the Stage session once and cooldown suppresses a repeated rejection', async () => {
  const renewed = await fixture({sourceStatus:(_url, cookie) => cookie.endsWith('-1') ? 401 : null});
  try {
    const [a, b] = await Promise.all([renewed.get(api + query), renewed.get(exact)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(renewed.stats().logins, 2);
  } finally { await renewed.close(); }
  const failed = await fixture({sourceStatus:() => 401});
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await failed.get(exact);
      assert.equal(response.status, 502);
      assert.deepEqual((await response.json()).error, {code:'UPSTREAM_AUTH_REQUIRED', stage:'source-session', sourceHttpStatus:401});
    }
    assert.deepEqual(failed.stats(), {logins:2, reads:2, media:0});
  } finally { await failed.close(); }
});

test('access errors never trigger a second login and failed login responses expose only safe codes', async () => {
  for (const [http, code] of [[403,'PHOTO_FORBIDDEN'], [404,'PHOTO_NOT_FOUND'], [502,'PHOTO_LOOKUP_FAILED'], [503,'PHOTO_UPSTREAM_UNAVAILABLE']]) {
    const f = await fixture({sourceStatus:() => http});
    try {
      const response = await f.get(exact);
      assert.equal(response.status, http);
      assert.equal((await response.json()).error.code, code);
      assert.deepEqual(f.stats(), {logins:1, reads:1, media:0});
    } finally { await f.close(); }
  }
  for (const [onLogin, expected] of [
    [() => new Response('fixture-secret', {status:401}), 'UPSTREAM_AUTH_REQUIRED'],
    [() => new Response(null, {status:302, headers:{Location:'https://other.example', 'Set-Cookie':'fixture_session=unapproved'}}), 'PHOTO_LOGIN_REDIRECT_REJECTED'],
    [() => Response.json({success:true}), 'PHOTO_LOGIN_SESSION_MISSING'],
    [() => { throw Error('fixture-secret'); }, 'PHOTO_LOGIN_NETWORK_ERROR']
  ]) {
    const f = await fixture({onLogin});
    try {
      const response = await f.get(exact);
      assert.equal(response.status, 502);
      const raw = await response.text();
      assert(!/fixture-secret|other.example|unapproved/.test(raw));
      assert.equal(JSON.parse(raw).error.code, expected);
      assert.equal(JSON.parse(raw).error.stage, 'source-login');
      assert.deepEqual(f.stats(), {logins:1, reads:0, media:0});
    } finally { await f.close(); }
  }
});

test('cancelled callers do not cancel a shared login with another waiter, and bearer credentials stay scoped', async () => {
  let completeLogin;
  let started = 0;
  const session = createStageDeliveryAdminPhotoSession({id:'fixture-user', password:'fixture-pass', fetchImpl:async (input, options) => {
    if (options.method === 'POST') {
      started++;
      return new Promise(resolve => { completeLogin = () => resolve(Response.json({data:{accessToken:'fixture-token'}})); });
    }
    assert.equal(input.origin, STAGE_DELIVERY_ORIGIN);
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    return Response.json({ok:true});
  }});
  const controller = new AbortController();
  const first = session.prepareSession({signal:controller.signal});
  const second = session.prepareSession();
  await Promise.resolve();
  controller.abort();
  await assert.rejects(first, {code:'PHOTO_TIMEOUT'});
  completeLogin();
  assert.equal(await second, undefined);
  assert.equal(started, 1);
  assert.equal((await session.read(approvedDetail)).status, 200);
  await assert.rejects(session.read(new URL('https://static.chabyulhwa.com/image.png')), {code:'INVALID_PHOTO_REQUEST'});
});
