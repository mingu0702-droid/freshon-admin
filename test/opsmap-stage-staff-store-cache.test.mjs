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
  let at = 1794500000000, revision = 0, state, holdFile, beforeHold, failWrite = false, retryAt = 0, privateRepo = true;
  const requests = [];
  const sha = () => revision.toString(16).padStart(40, '0');
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
      assert.equal(data.sha, state ? sha() : undefined);
      if (failWrite) return new Response(null, {status:500});
      state = JSON.parse(Buffer.from(data.content, 'base64').toString());
      revision++;
      return Response.json({});
    }
    if (holdFile) {
      const gate = holdFile;
      holdFile = null;
      beforeHold();
      await gate;
    }
    if (!state) return new Response(null, {status:404});
    const etag = '"' + sha() + '"';
    if (options.headers['If-None-Match'] === etag) return new Response(null, {status:304});
    const body = Buffer.from(JSON.stringify(state));
    return Response.json({ sha: sha(), encoding: 'base64', size: body.length, content: body.toString('base64') }, { headers: { etag } });
  };
  return {
    requests, now: () => at, advance: ms => { at += ms; }, limit: ms => { retryAt = at + ms; },
    makePublic: () => { privateRepo = false; }, rejectWrites: () => { failWrite = true; },
    holdNextRead() {
      let release;
      holdFile = new Promise(resolve => { release = resolve; });
      return { started: new Promise(resolve => { beforeHold = resolve; }), release };
    },
    start: () => createStageStaffSessionStore({ env: config, fetchImpl: github, now: () => at })
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

test('Stage HTTP login, restart, rotation and logout respect the durable cache boundary', async t => {
  const password = 'SYNTHETIC_PASSWORD', origin = env.MAP_STAFF_ORIGIN;
  const config = { ...env, MAP_STAFF_PASSWORD_HASH: await createStaffPasswordHash(password) };
  const f = fixture(config);
  async function start() {
    const app = express(), auth = createMapStaffAuth({ env:config, now:f.now, sessionStore:f.start() });
    app.use('/auth',auth.router);
    app.get('/protected',auth.requireStaff,(_req,res)=>res.sendStatus(200));
    const server = app.listen(0,'127.0.0.1');
    await new Promise(resolve => server.once('listening',resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return (path, cookie, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method:body?'POST':'GET',headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{})},body:body&&JSON.stringify(body)
    });
  }
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
