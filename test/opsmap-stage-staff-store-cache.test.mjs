import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createMapStaffAuth, createStaffPasswordHash } from '../src/opsmap-abc/mapStaffAuth.js';
import { createStageStaffSessionStore } from '../src/staffSessionStore.js';

const env = {
  OPSMAP_STAGE_VERIFY_ONLY: '1', GITHUB_CACHE_REPO: 'mingu0702-droid/freshon-cache', GITHUB_TOKEN: 'fixture',
  OPSMAP_MANUAL_PIN_GITHUB_BRANCH: 'stage/opsmap-manual-pins', MAP_STAFF_SESSION_SECRET: 'x'.repeat(43),
  MAP_STAFF_ID: 'fixture', MAP_STAFF_ORIGIN: 'https://stage.example.test'
};
const key = 'a'.repeat(64), fingerprint = 'b'.repeat(64);

function fixture(config = env) {
  let at = 1794500000000, revision = 0, state, failWrite = false, conflicts = 0, retryAt = 0, privateRepo = true;
  const requests = [];
  const gates = new Map();
  const sha = () => revision.toString(16).padStart(40, '0');
  function holdNext(step) {
    let start, release;
    const started = new Promise(resolve => { start = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    gates.set(step, { start, released });
    return { started, release };
  }
  async function pause(step) {
    const gate = gates.get(step);
    if (!gate) return;
    gates.delete(step);
    gate.start();
    await gate.released;
  }
  function read(options) {
    if (!state) return new Response(null, {status:404});
    const etag = '"' + sha() + '"';
    if (options.headers['If-None-Match'] === etag) return new Response(null, {status:304});
    const body = Buffer.from(JSON.stringify(state));
    return Response.json({ sha: sha(), encoding: 'base64', size: body.length, content: body.toString('base64') }, { headers: { etag } });
  }
  const github = async (url, options) => {
    const path = new URL(url).pathname;
    const target = path.endsWith('/freshon-cache') ? 'repository' : 'session';
    const method = options.method || 'GET';
    assert(target === 'repository' || path.endsWith('/opsmap-stage/staff-sessions-v1.json'));
    requests.push([target, method]);
    if (retryAt > at) return new Response(null, { status: 403, headers: {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(retryAt / 1000)
    } });
    if (target === 'repository') {
      const etag = privateRepo ? '"private"' : '"public"';
      return options.headers['If-None-Match'] === etag ? new Response(null, {status:304}) :
        Response.json({ private: privateRepo, permissions: { push: true } }, { headers: { etag } });
    }
    if (method === 'PUT') {
      const data = JSON.parse(options.body);
      assert.equal(data.branch, 'stage/opsmap-manual-pins');
      await pause('write');
      if (conflicts > 0) {
        conflicts--;
        return new Response(null, {status:409});
      }
      if (data.sha !== (state ? sha() : undefined)) return new Response(null, {status:409});
      if (failWrite) return new Response(null, {status:500});
      state = JSON.parse(Buffer.from(data.content, 'base64').toString());
      revision++;
      return Response.json({});
    }
    await pause('read');
    const response = read(options);
    await pause('response');
    return response;
  };
  return {
    requests, now: () => at, advance: ms => { at += ms; }, limit: ms => { retryAt = at + ms; },
    makePublic: () => { privateRepo = false; }, rejectWrites: () => { failWrite = true; },
    conflictWrites: count => { conflicts = count; }, holdNextRead: () => holdNext('read'),
    holdNextResponse: () => holdNext('response'), holdNextWrite: () => holdNext('write'),
    holdNextAcknowledgment: () => holdNext('acknowledgment'),
    start: () => createStageStaffSessionStore({ env: config, fetchImpl: github, now: () => at, wait: async ms => {
      assert.equal(ms, 4000);
      await pause('acknowledgment');
      at += ms;
    } })
  };
}

const future = f => ({ expiresAt: f.now() + 600000, idleExpiresAt: f.now() + 120000 });

test('cold and warm Stage reads share a verified file, then revalidate with ETags', async () => {
  const f = fixture(), saved = future(f);
  await f.start().set(key, saved, fingerprint);
  f.requests.length = 0;
  const restarted = f.start();
  const replies = await Promise.all(Array.from({length:30}, () => restarted.get(key, fingerprint)));
  assert.deepEqual(replies, Array(30).fill(saved));
  assert.deepEqual(f.requests, [['repository','GET'], ['session','GET']]);
  for (let i = 0; i < 30; i++) assert.deepEqual(await restarted.get(key, fingerprint), saved);
  assert.equal(restarted.stats().cacheHits, 30);
  assert.equal(restarted.stats().joinedReads, 29);
  assert.equal(f.requests.length, 2);
  f.advance(4000);
  assert.deepEqual(await restarted.get(key, fingerprint), saved);
  assert.equal(restarted.stats().notModified, 1);
  assert.deepEqual(f.requests.at(-1), ['session','GET']);
  f.advance(56000);
  assert.deepEqual(await restarted.get(key, fingerprint), saved);
  assert.equal(restarted.stats().repositoryReads, 2);
  assert.equal(restarted.stats().notModified, 3);
  f.makePublic();
  const writes = restarted.stats().sessionWrites;
  await assert.rejects(restarted.set(key, saved, fingerprint), /STAFF_SESSION_STORE_UNAVAILABLE/);
  assert.equal(restarted.stats().sessionWrites, writes);
  await assert.rejects(restarted.get(key, fingerprint), /STAFF_SESSION_STORE_UNAVAILABLE/);
});

test('GitHub 403 at quota zero suppresses every read and write until reset', async () => {
  const f = fixture(), store = f.start(), saved = future(f);
  await store.set(key, saved, fingerprint);
  f.advance(60000);
  f.limit(30000);
  const before = f.requests.length;
  await assert.rejects(store.get(key, fingerprint), { message:'STAFF_SESSION_STORE_UNAVAILABLE', retryAfterMs:30000 });
  for (let i = 0; i < 12; i++) await assert.rejects(store.get('f'.repeat(64), fingerprint), /STAFF_SESSION_STORE_UNAVAILABLE/);
  await assert.rejects(store.delete(key), /STAFF_SESSION_STORE_UNAVAILABLE/);
  assert.equal(f.requests.length, before + 1);
  assert.equal(store.stats().cooldownSkips, 13);
  f.advance(29999);
  await assert.rejects(store.get(key, fingerprint), { retryAfterMs:1 });
  assert.equal(f.requests.length, before + 1);
  f.advance(1);
  assert.deepEqual(await store.get(key, fingerprint), saved);
  assert.equal(f.requests.length, before + 3);
});

test('expiry and credential revision are enforced inside the cache interval', async () => {
  const f = fixture(), store = f.start(), saved = { ...future(f), idleExpiresAt: f.now() + 1000 };
  await store.set(key, saved, fingerprint);
  assert.deepEqual(await store.get(key, fingerprint), saved);
  assert.equal(await store.get(key, 'c'.repeat(64)), null);
  const before = f.requests.length;
  f.advance(1000);
  assert.equal(await store.get(key, fingerprint), null);
  assert.equal(f.requests.length, before);
  assert.equal(await store.touch(key, future(f), fingerprint), false);
});

test('CAS deletion cannot race with a stale in-flight read or an activity refresh', async () => {
  const f = fixture(), store = f.start(), saved = future(f);
  await store.set(key, saved, fingerprint);
  f.advance(4000);
  const gate = f.holdNextRead(), reading = store.get(key, fingerprint);
  await gate.started;
  const deletion = store.delete(key);
  gate.release();
  await deletion;
  assert.equal(await reading, null);
  assert.equal(await store.touch(key, future(f), fingerprint), false);
  assert.equal(await f.start().get(key, fingerprint), null);
});

test('a failed CAS cannot promote an unpersisted session into the read cache', async () => {
  const f = fixture(), store = f.start(), saved = future(f);
  await store.set(key, saved, fingerprint);
  f.rejectWrites();
  await assert.rejects(store.set('e'.repeat(64), saved, fingerprint), /STAFF_SESSION_STORE_UNAVAILABLE/);
  assert.equal(await store.get('e'.repeat(64), fingerprint), null);
  assert.deepEqual(await store.get(key, fingerprint), saved);
});

test('CAS retry is bounded and uses the durable state without resurrecting deleted sessions', async () => {
  const f = fixture(), a = f.start(), b = f.start(), fresh = 'e'.repeat(64);
  await a.set(key, future(f), fingerprint);
  f.conflictWrites(4);
  await assert.rejects(a.set(fresh, future(f), fingerprint), /STAFF_SESSION_STORE_UNAVAILABLE/);
  assert.equal(a.stats().casConflicts, 3);
  assert.equal(await a.get(fresh, fingerprint), null);
  f.conflictWrites(0);
  const gate = f.holdNextWrite(), touching = a.touch(key, future(f), fingerprint);
  await gate.started;
  try { await b.delete(key); } finally { gate.release(); }
  assert.equal(await touching, false);
  assert.equal(a.stats().casConflicts, 4);
  assert.equal(await f.start().get(key, fingerprint), null);
});

test('a stale worker cannot restore credentials retired by a successful CAS', async () => {
  const f = fixture(), a = f.start(), b = f.start(), oldAttempt = 'e'.repeat(64), newKey = 'd'.repeat(64);
  const rotated = 'c'.repeat(64), session = future(f);
  await a.set(key, session, fingerprint);
  const gate = f.holdNextWrite(), stale = a.set(oldAttempt, session, fingerprint);
  const rejected = assert.rejects(stale, /STAFF_SESSION_STORE_UNAVAILABLE/);
  await gate.started;
  try { await b.set(newKey, session, rotated); } finally { gate.release(); }
  await rejected;
  assert.equal(a.stats().casConflicts, 1);
  const writes = a.stats().sessionWrites;
  await assert.rejects(a.set(oldAttempt, session, fingerprint), /STAFF_SESSION_STORE_UNAVAILABLE/);
  assert.equal(a.stats().sessionWrites, writes);
  const restored = f.start();
  assert.equal(await restored.get(key, fingerprint), null);
  assert.equal(await restored.get(oldAttempt, fingerprint), null);
  assert.deepEqual(await restored.get(newKey, rotated), session);
});

test('a pre-revocation read cannot start a new lease after the revocation is acknowledged', async () => {
  const f = fixture(), a = f.start(), b = f.start();
  await a.set(key, future(f), fingerprint);
  const gate = f.holdNextResponse(), stale = b.get(key, fingerprint);
  const rejected = assert.rejects(stale, /STAFF_SESSION_STORE_UNAVAILABLE/);
  await gate.started;
  try { await a.delete(key); } finally { gate.release(); }
  await rejected;
  assert.equal(await b.get(key, fingerprint), null);
});

async function startHttp(t, f, config) {
  const store = f.start(), app = express();
  const auth = createMapStaffAuth({ env: config, now: f.now, sessionStore: store });
  app.use('/auth', auth.router);
  app.get('/protected', auth.requireStaff, (_req, res) => res.sendStatus(200));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {
    store,
    request: (path, cookie, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body ? 'POST' : 'GET', headers: { origin: env.MAP_STAFF_ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body && JSON.stringify(body)
    })
  };
}

test('two concurrent Stage HTTP logins both persist when the first CAS loses', { timeout: 10000 }, async t => {
  const password = 'SYNTHETIC_PASSWORD';
  const config = { ...env, MAP_STAFF_PASSWORD_HASH: await createStaffPasswordHash(password) };
  const f = fixture(config), a = await startHttp(t, f, config), b = await startHttp(t, f, config);
  const credentials = { id: env.MAP_STAFF_ID, password };
  const original = await a.request('/auth/login', null, credentials);
  assert.equal(original.status, 200);
  f.requests.length = 0;
  const gate = f.holdNextWrite(), first = a.request('/auth/login', null, credentials);
  await gate.started;
  let second;
  try { second = await b.request('/auth/login', null, credentials); } finally { gate.release(); }
  const responses = [await first, second];
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(a.store.stats().casConflicts, 1);
  assert.equal(b.store.stats().casConflicts, 0);
  assert.equal(f.requests.length, 10);
  const restored = await startHttp(t, f, config);
  for (const response of [original, ...responses]) {
    const cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await restored.request('/protected', cookie)).status, 200);
  }
});

test('logout acknowledges only after the other worker can no longer approve its cached session', { timeout: 10000 }, async t => {
  const password = 'SYNTHETIC_PASSWORD';
  const config = { ...env, MAP_STAFF_PASSWORD_HASH: await createStaffPasswordHash(password) };
  const f = fixture(config), a = await startHttp(t, f, config), b = await startHttp(t, f, config);
  const login = await a.request('/auth/login', null, { id: env.MAP_STAFF_ID, password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await b.request('/protected', cookie)).status, 200);
  const acknowledgment = f.holdNextAcknowledgment();
  let responded = false;
  const logout = a.request('/auth/logout', cookie, {}).then(response => { responded = true; return response; });
  await acknowledgment.started;
  try {
    assert.equal((await a.request('/protected', cookie)).status, 401);
    assert.equal(responded, false);
  } finally { acknowledgment.release(); }
  assert.equal((await logout).status, 200);
  assert.equal((await b.request('/protected', cookie)).status, 401);
});

test('Stage HTTP login, restart, rotation and logout respect the durable cache boundary', async t => {
  const password = 'SYNTHETIC_PASSWORD';
  const config = { ...env, MAP_STAFF_PASSWORD_HASH: await createStaffPasswordHash(password) };
  const f = fixture(config), start = async () => (await startHttp(t, f, config)).request;
  const login = async (app, pass = password, cookie) => {
    const response = await app('/auth/login',cookie,{id:env.MAP_STAFF_ID,password:pass});
    assert.equal(response.status,200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const app = await start(), original = await login(app), restarted = await start();
  assert.equal((await restarted('/protected',original)).status,200);
  assert.equal((await (await restarted('/auth/session',original)).json()).policy.loginAttemptLimit,100);
  const second = await login(restarted,password,original);
  assert.equal((await restarted('/protected',original)).status,401);
  assert.equal((await restarted('/protected',second)).status,200);
  config.MAP_STAFF_PASSWORD_HASH = await createStaffPasswordHash('SYNTHETIC_ROTATED_PASSWORD');
  assert.equal((await restarted('/protected',second)).status,401);
  const third = await login(restarted,'SYNTHETIC_ROTATED_PASSWORD');
  const logout = await restarted('/auth/logout',third,{});
  assert.equal(logout.status,200);
  assert.equal((await restarted('/protected',third)).status,401);
  const afterLogout = await start();
  assert.equal((await afterLogout('/protected',third)).status,401);
  const fourth = await login(afterLogout,'SYNTHETIC_ROTATED_PASSWORD');
  f.advance(4000);
  f.limit(30000);
  const unavailable = await afterLogout('/protected',fourth);
  assert.equal(unavailable.status,503);
  assert.equal(unavailable.headers.get('retry-after'),'30');
  assert.deepEqual(await unavailable.json(),{error:'STAFF_SESSION_STORE_UNAVAILABLE'});
  const unconfirmed = await afterLogout('/auth/logout',fourth,{});
  assert.equal(unconfirmed.status,503);
  assert.match(unconfirmed.headers.get('set-cookie'), /__Host-opsmap-staff=;/);
  assert.equal((await afterLogout('/protected',fourth)).status,401);
});
