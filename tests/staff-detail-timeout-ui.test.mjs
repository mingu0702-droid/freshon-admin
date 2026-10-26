import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(process.env.OPSMAP_QA_DEPENDENCY_PACKAGE || path.join(root, 'package.json'));
const { chromium } = require('playwright');
const scripts = Object.fromEntries(await Promise.all(['map-staff-entry.js', 'map-staff.js'].map(async name => [name, await fs.readFile(path.join(root, 'public', name))])));
const initialSession = { authenticated: true, configured: true, expiresAt: Date.now() + 3600000, idleExpiresAt: Date.now() + 1800000 };
const calls = { session: 0, login: 0, logout: 0, protectedDetail: 0, publicDetail: 0, nonLoopback: 0 };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><header id="approvedSiteHeader"></header><script src="/map-staff-entry.js"></script><script src="/map-staff.js"></script></body></html>');
  }
  if (scripts[url.pathname.slice(1)]) { res.setHeader('Content-Type', 'application/javascript; charset=utf-8'); return res.end(scripts[url.pathname.slice(1)]); }
  if (url.pathname === '/api/map-phase2b/auth/session') { calls.session++; return res.end(JSON.stringify(initialSession)); }
  if (/\/auth\/(login|logout)$/.test(url.pathname)) { calls[url.pathname.endsWith('/login') ? 'login' : 'logout']++; res.statusCode = 403; return res.end('{}'); }
  if (['/vehicle-data.js', '/admin-features.js'].includes(url.pathname)) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    return res.end(`window.${url.pathname === '/vehicle-data.js' ? 'VEHICLE_AREA_DATA' : 'ADMIN_FEATURES'} = {};`);
  }
  if (url.pathname === '/api/map-phase2b/private/customer-detail') {
    calls.protectedDetail++;
    return setTimeout(() => { res.statusCode = 504; res.end(JSON.stringify({ ok: false, data: null, error: 'DETAIL_UPSTREAM_TIMEOUT' })); }, 4805);
  }
  if (url.pathname === '/api/map-phase2b/preview/customer-detail') { calls.publicDetail++; return res.end(JSON.stringify({ ok: true, data: { customerCode: 'S000001', customerName: 'LOCAL_UI_ONLY' } })); }
  res.statusCode = 404; res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
let evidence;
try {
  const context = await browser.newContext();
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { calls.nonLoopback++; return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => document.body.dataset.mapStaffState === 'authenticated');
  const before = await page.evaluate(() => window.MapStaffEntry.session());
  await page.evaluate(() => window.MapStaff.open({ kind: 'notes', customerCode: 'S000001', date: '2026-10-26' }));
  await page.waitForFunction(() => document.querySelector('#mapStaffDialog').dataset.state === 'error');
  const result = await page.evaluate(async () => {
    const dialog = document.querySelector('#mapStaffDialog');
    const publicResponse = await fetch('/api/map-phase2b/preview/customer-detail?customerCode=S000001');
    return { message: dialog.textContent, state: dialog.dataset.state, session: window.MapStaffEntry.session(), entryState: document.body.dataset.mapStaffState,
      publicStatus: publicResponse.status, publicBody: await publicResponse.json(), metrics: JSON.parse(document.querySelector('#staffRequestMetrics').textContent) };
  });
  assert(result.message.includes('원천 응답 시간이 초과되었습니다.'));
  assert(result.message.includes('공개 고객정보와 지도는 계속 사용할 수 있습니다.'));
  assert(!/로그인|HUB_TIMEOUT|DETAIL_UPSTREAM_TIMEOUT|504/.test(result.message));
  assert.deepEqual(result.session, before);
  assert.equal(result.entryState, 'authenticated');
  assert.equal(result.publicStatus, 200);
  assert.equal(result.publicBody.ok, true);
  assert.equal(result.metrics.length, 1);
  assert.equal(result.metrics[0].status, 504);
  assert(result.metrics[0].browserTotalMs >= 4805 && result.metrics[0].browserTotalMs < 5000, 'Must reproduce the observed sub-5000ms 504 boundary');
  // Entry startup and MapStaff.open each confirm the session before the detail.
  assert.deepEqual(calls, { session: 2, login: 0, logout: 0, protectedDetail: 1, publicDetail: 1, nonLoopback: 0 });
  evidence = { scope: 'Local HTTP replay of observed Stage 4805ms HTTP504; actual entry and detail UI scripts; synthetic local session only', stageRequests: 0, credentialReads: 0,
    stageAuthOrSourcePassEstablished: false, replayDelayMs: 4805, status: 504, browserElapsedMs: result.metrics[0].browserTotalMs,
    timeoutMessage: '원천 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.', clientSessionRetained: true, nextPublicStatus: result.publicStatus,
    automaticDetailRetry: false, calls, result: 'PASS' };
  await context.close();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
await fs.writeFile(path.join(root, 'evidence/staff-detail-timeout-ui.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence));
