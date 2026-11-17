import { createHash } from 'node:crypto';
import { KAKAO_DIAGNOSTIC_ADDRESS } from './kakaoCoordinateConnection.js';

const script = `const status = document.querySelector('#status');
const run = document.querySelector('#run');
async function request(path, options = {}) {
  const response = await fetch('/api/map-phase2b/private/address-lookup' + path, {
    credentials: 'same-origin', cache: 'no-store', ...options
  });
  const payload = await response.json();
  return { response, payload };
}
async function configuration() {
  const { response, payload } = await request('/config');
  const data = payload.data || {};
  run.disabled = response.status !== 200 || data.diagnosticAvailable !== true;
  status.textContent = JSON.stringify({
    http: response.status, appId: data.configuredAppId,
    restKeyPresent: data.restKeyPresent, missingGateSettings: data.missingGateSettings,
    reason: data.reason || payload.error, enabled: data.enabled,
    diagnosticAvailable: data.diagnosticAvailable, dailyLimit: data.dailyLimit,
    dailyUsed: data.dailyUsed
  });
}
run.addEventListener('click', async () => {
  run.disabled = true;
  status.textContent = 'Checking';
  const started = performance.now();
  try {
    const { response, payload } = await request('-diagnostic', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: ${JSON.stringify(KAKAO_DIAGNOSTIC_ADDRESS)} })
    });
    const elapsedMs = Math.round(performance.now() - started);
    const data = payload.data || {};
    const coordinateReceived = data.documents?.some(row =>
      Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y))) ?? false;
    status.textContent = JSON.stringify({
      http: response.status, providerHttp: data.providerHttp ?? payload.providerHttp ?? null,
      exact: data.exact === true, coordinateReceived,
      error: payload.error || null, elapsedMs,
      serverTiming: response.headers.get('Server-Timing')
    });
  } catch { status.textContent = 'Connection interrupted. Check the usage ledger before retrying.'; }
}, { once: true });
configuration().catch(() => { status.textContent = 'Configuration could not be read.'; });`;

const scriptHash = createHash('sha256').update(script).digest('base64');
const html = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Stage Kakao address check</title>' +
  '<h1>Stage Kakao address check</h1><a href="/opsmap/">Staff sign-in</a>' +
  '<p><button id="run" type="button" disabled>Run one diagnostic</button></p>' +
  '<output id="status" role="status">Checking configuration</output><script>' + script + '</script></html>';

export function renderStageKakaoAddressDiagnostic(_req, res) {
  res.set({
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; script-src 'sha256-" + scriptHash + "'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  }).type('html').send(html);
}
