import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createMapStaffAuth, createStaffPasswordHash } from '../src/opsmap-abc/mapStaffAuth.js';

const password = 'SYNTHETIC_STAGE_PASSWORD';
const hash = await createStaffPasswordHash(password);
const origin = 'https://stage.example.test';
const windowMs = 15 * 60 * 1000;

async function fixture(t, options = {}) {
  let clock = Date.now();
  const saved = new Map();
  const sessionStore = {
    kind: 'SYNTHETIC_DURABLE',
    async get(key, revision) { return saved.get(key)?.revision === revision ? saved.get(key).session : null; },
    async set(key, session, revision) { saved.set(key, { session, revision }); },
    async touch(key, session, revision) {
      if (saved.get(key)?.revision !== revision) return false;
      saved.set(key, { session, revision });
      return true;
    },
    async delete(key) { saved.delete(key); }
  };
  const env = { OPSMAP_STAGE_VERIFY_ONLY: '1', MAP_STAFF_ID: 'fixture', MAP_STAFF_ORIGIN: origin,
    MAP_STAFF_PASSWORD_HASH: hash, MAP_STAFF_SESSION_SECRET: 'a'.repeat(43), ...options };
  async function start() {
    const { router, requireStaff } = createMapStaffAuth({ env, sessionStore, now: () => clock });
    const app = express();
    app.use('/auth', router);
    app.get('/protected', requireStaff, (_req, res) => res.sendStatus(200));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const request = (path, headers, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body ? 'POST' : 'GET', headers: { origin, ...headers }, body: body && JSON.stringify(body)
    });
    return {
      login: (candidate = password, headers) => request('/auth/login', { 'content-type': 'application/json', ...headers }, { id: env.MAP_STAFF_ID, password: candidate }),
      protected: cookie => request('/protected', { cookie }),
      status: (cookie, activity) => request('/auth/session', { cookie, 'x-map-staff-activity': activity ? '1' : '0' })
    };
  }
  return { start, advance: ms => { clock += ms; } };
}

test('Stage admits 100 valid logins from one peer, including simultaneous employees', async t => {
  const f = await fixture(t), api = await f.start();
  const replies = await Promise.all(Array.from({ length: 100 }, () => api.login()));
  assert.deepEqual([...new Set(replies.map(reply => reply.status))], [200]);
  assert.equal(new Set(replies.map(reply => reply.headers.get('set-cookie'))).size, 100);
  const policy = (await (await api.status(replies[0].headers.get('set-cookie').split(';')[0])).json()).policy;
  assert.deepEqual([policy.loginAttemptLimit, policy.loginWindowMs], [100, windowMs]);
  const blocked = await api.login();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '900');
  assert.deepEqual(await blocked.json(), { error: 'LOGIN_RETRY_LATER' });
  f.advance(windowMs);
  assert.equal((await api.login()).status, 200);
});

test('concurrent bad passwords respect the separate peer cap', async t => {
  const f = await fixture(t), api = await f.start();
  assert.equal((await api.login('incorrect')).status, 401);
  assert.equal((await api.login()).status, 200);
  const replies = await Promise.all(Array.from({ length: 14 }, (_, i) => api.login('incorrect', { 'x-forwarded-for': `192.0.2.${i + 1}` })));
  assert.equal(replies.filter(reply => reply.status === 401).length, 9);
  assert.equal(replies.filter(reply => reply.status === 429).length, 5);
  f.advance(windowMs);
  assert.equal((await api.login()).status, 200);
});

test('Stage session expiry, rotation and restoration keep the live policy', async t => {
  const f = await fixture(t), first = await f.start();
  const initial = await first.login();
  const cookie = response => response.headers.get('set-cookie').split(';')[0];
  const old = cookie(initial);
  const restarted = await f.start();
  assert.equal((await restarted.protected(old)).status, 200);
  const replacement = cookie(await restarted.login(password, { cookie: old }));
  assert.equal((await restarted.protected(old)).status, 401);
  const before = await (await restarted.status(replacement)).json();
  const { idleMs, maxMs } = before.policy;
  assert.equal(idleMs, 8 * 60 * 60 * 1000);
  assert.equal(maxMs, 12 * 60 * 60 * 1000);
  f.advance(idleMs);
  assert.equal((await restarted.protected(replacement)).status, 401);
  const active = cookie(await restarted.login());
  f.advance(idleMs - 1000);
  assert.equal((await (await restarted.status(active, true)).json()).authenticated, true);
  f.advance(maxMs - idleMs + 1000);
  assert.equal((await restarted.protected(active)).status, 401);
});
