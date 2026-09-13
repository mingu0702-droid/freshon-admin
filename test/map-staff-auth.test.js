import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMapStaffAuth, createStaffPasswordHash, verifyStaffPassword, STAFF_IDLE_MS, STAFF_MAX_MS } from '../src/mapStaffAuth.js';
import { staffSetupValues } from '../scripts/setup-map-staff.mjs';
import { staffCustomerDetail } from '../src/mapStaffDetail.js';
import { staffLatency } from '../src/staffLatency.js';

// Synthetic credentials only: exercise the requested six-character minimum.
const password = 'Ab12cd';
test('staff sessions: public/private/admin separation, Origin, expiry, logout, rotation, throttling', async t => {
  const values = await staffSetupValues(password, password);
  assert.equal(await verifyStaffPassword(password, values.hash), true);
  assert.equal(await verifyStaffPassword('incorrect synthetic', values.hash), false);
  assert.equal(values.secret.length, 43);
  await assert.rejects(staffSetupValues(password, 'different'));
  assert.equal(STAFF_MAX_MS, 8 * 60 * 60 * 1000);
  await assert.rejects(staffSetupValues('Ab123', 'Ab123'), /PASSWORD_LENGTH/);
  const env = { MAP_STAFF_ID: 'abc', MAP_STAFF_PASSWORD_HASH: values.hash, MAP_STAFF_SESSION_SECRET: values.secret,
    RENDER_EXTERNAL_URL: 'https://stage.example.test', PUBLIC_VIEW: 'true', ADMIN_TOKEN: 'SYNTHETIC-machine-only' };
  let time = 1000;
  const auth = createMapStaffAuth({ env, now: () => time }), app = express();
  app.use(staffLatency);
  app.use('/api/map-phase2b/auth', auth.router);
  app.get('/api/map-phase2b/private/detail', auth.requireStaff, (_req, res) => res.json({ privateRead: true }));
  app.get('/api/collector/delivery', (req, res) => res.sendStatus(req.get('x-admin-token') === env.ADMIN_TOKEN ? 200 : 401));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  const login = (body = { id: env.MAP_STAFF_ID, password }, origin = env.RENDER_EXTERNAL_URL) => fetch(base + '/api/map-phase2b/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
  const detail = () => fetch(base + '/api/map-phase2b/private/detail', { headers: { Cookie: cookie } });
  assert.equal((await detail()).status, 401);
  assert.equal((await login(undefined, 'https://attacker.invalid')).status, 403);
  assert.equal((await login({ id: 'wrong', password })).status, 401);
  const ok = await login(); assert.equal(ok.status, 200);
  assert.match(ok.headers.get('server-timing'), /authVerify;dur=/);
  assert.deepEqual(JSON.parse(ok.headers.get('x-staff-cookie-policy')), {httpOnly:true,secure:true,sameSite:'Strict'});
  const header = ok.headers.get('set-cookie');
  for (const flag of ['__Host-map-staff=', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(header.includes(flag));
  assert.ok(!header.includes('Domain='));
  cookie = header.split(';')[0];
  assert.equal((await detail()).status, 200);
  assert.equal((await detail()).headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + '/api/collector/delivery', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await fetch(base + '/api/collector/delivery', { headers: { 'x-admin-token': env.ADMIN_TOKEN } })).status, 200);
  time += STAFF_IDLE_MS;
  assert.equal((await detail()).status, 401);
  cookie = (await login()).headers.get('set-cookie').split(';')[0];
  const logout = await fetch(base + '/api/map-phase2b/auth/logout', { method: 'POST', headers: { Origin: env.RENDER_EXTERNAL_URL, Cookie: cookie } });
  assert.equal(logout.status, 200); assert.equal((await detail()).status, 401);
  cookie = (await login()).headers.get('set-cookie').split(';')[0];
  time += STAFF_MAX_MS;
  assert.equal((await detail()).status, 401);
  cookie = (await login()).headers.get('set-cookie').split(';')[0];
  env.MAP_STAFF_SESSION_SECRET = 'a'.repeat(43);
  assert.equal((await detail()).status, 401);
  for (let i = 0; i < 10; i++) await login({ id: 'wrong', password: 'wrong' });
  assert.equal((await login()).status, 429);
  time += 16 * 60 * 1000;
  env.WEB_CONCURRENCY = '2';
  assert.equal((await login()).status, 503);
  env.WEB_CONCURRENCY = '1'; env.MAP_STAFF_PASSWORD_HASH = '';
  assert.equal((await login()).status, 503);
});

test('six-character password allows digits without forcing a mixed composition', async () => {
  const hash = await createStaffPasswordHash('123456');
  assert.equal(await verifyStaffPassword('123456', hash), true);
  assert.notEqual(hash, '123456');
});

test('private projection excludes raw prose, claims and owner phones; exact password string', () => {
  const row = staffCustomerDetail({ accessMemo: '출입방법: 후문\n비밀번호: 0012*#/\n특이사항: 냉장실\n클레임: 비밀번호 9999\n점주 연락처: 010-0000-0000\n경계 없는 자유 원문',
    rawMemo: 'NEVER_RETURN', ownerPhone: '010-0000-0000' }, { customerCode: 'TEST_CUSTOMER', date: '2026-08-11' });
  assert.equal(row.password, '0012*#/');
  assert.equal(row.accessInfo, '후문');
  assert.equal(row.specialRemark, '냉장실');
  assert.equal(row.deliveryPattern, null);
  assert.equal('rawMemo' in row, false);
  assert.equal('ownerPhone' in row, false);
  assert.ok(!JSON.stringify(row).includes('9999'));
});
