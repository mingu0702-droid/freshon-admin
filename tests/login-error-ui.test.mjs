import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(process.env.OPSMAP_QA_DEPENDENCY_PACKAGE || path.join(root, 'package.json'));
const { chromium } = require('playwright');
const script = await fs.readFile(path.join(root, 'public/map-staff-entry.js'));
const cases = [
  { name: 'credential_rejection', status: 401, body: { error: 'LOGIN_FAILED' }, text: '아이디와 비밀번호를 확인' },
  { name: 'origin_rejection', status: 403, body: { error: 'ORIGIN_REJECTED' }, text: '현재 접속 주소' },
  { name: 'rate_limit', status: 429, body: { error: 'LOGIN_RETRY_LATER' }, text: '일시 제한' },
  { name: 'configuration_unavailable', status: 503, body: { error: 'STAFF_AUTH_NOT_CONFIGURED' }, text: '직원 로그인 설정' },
  { name: 'verification_unavailable', status: 503, body: { error: 'LOGIN_UNAVAILABLE' }, text: '로그인 서비스에 연결' },
  { name: 'non_json_rate_limit', status: 429, raw: '<p>Unavailable</p>', text: '일시 제한' },
  { name: 'null_json_rate_limit', status: 429, body: null, text: '일시 제한' },
  { name: 'non_json_server_failure', status: 502, raw: '<p>Unavailable</p>', text: '로그인 서비스에 연결' },
  { name: 'invalid_success_response', status: 200, raw: '<p>Unavailable</p>', text: '로그인 응답을 확인' },
  { name: 'connection_failure', disconnect: true, text: '로그인 응답을 확인' },
];
let selected, localLoginPosts = 0, nonLoopbackRequests = 0;
const server = http.createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><script src="/map-staff-entry.js"></script></body></html>'); }
  if (req.url === '/map-staff-entry.js') { res.setHeader('Content-Type', 'application/javascript; charset=utf-8'); return res.end(script); }
  if (req.url === '/api/map-phase2b/auth/session') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ authenticated: false, configured: true })); }
  if (req.url === '/api/map-phase2b/auth/login' && req.method === 'POST') {
    localLoginPosts++;
    for await (const _chunk of req) { /* Deliberately do not retain submitted input. */ }
    if (selected.disconnect) return req.socket.destroy();
    res.statusCode = selected.status;
    res.setHeader('Content-Type', selected.raw ? 'text/html' : 'application/json');
    return res.end(selected.raw || JSON.stringify(selected.body));
  }
  res.statusCode = 404; res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const item of cases) {
    selected = item;
    const context = await browser.newContext();
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) { nonLoopbackRequests++; return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => console.error('LOCAL_UI_ERROR', error.message));
    await page.goto(origin);
    const button = page.getByRole('button', { name: '로그인', exact: true });
    await button.waitFor();
    await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
    await page.locator('input[name="username"]').fill('local-ui-only');
    await page.locator('input[name="password"]').fill('local-ui-only');
    await button.click();
    await page.waitForFunction(text => document.querySelector('#mapStaffEntry [role="status"]').textContent.includes(text), item.text);
    const text = await page.locator('#mapStaffEntry [role="status"]').textContent();
    assert.equal(await page.locator('input[name="password"]').inputValue(), '');
    assert.equal(await button.isEnabled(), true);
    if (item.name !== 'credential_rejection') assert(!text.includes('아이디와 비밀번호'));
    results.push({ case: item.name, responseStatus: item.status || null, message: text, passwordCleared: true, retryEnabled: true, result: 'PASS' });
    await context.close();
  }
  assert.equal(nonLoopbackRequests, 0);
  // Chromium may retry a reused local socket once after the disconnect case.
  assert(localLoginPosts >= cases.length && localLoginPosts <= cases.length + 1);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
const evidence = { scope: 'Local browser rendering of real HTTP failure responses; does not establish Stage login or real credential validity', realCredentialReads: 0, stageRequests: 0, nonLoopbackRequests, localLoginPosts, results };
await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
await fs.writeFile(path.join(root, 'evidence/login-error-ui.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ localUiCases: results.length, failed: 0, stageRequests: 0, nonLoopbackRequests }));
