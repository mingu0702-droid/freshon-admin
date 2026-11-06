import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KAKAO_EXPECTED_APP_ID } from '../src/opsmap-abc/kakaoCoordinateConnection.js';
import '../public/opsmap/kakao-directions-adapter.js';

const adapter = globalThis.KakaoDirectionsAdapter;
// Public request example endpoints. https://developers.kakaomobility.com/guide/navi-api/directions
const sample = Object.freeze({
  mode: 'MANUAL_WAYPOINTS', requestId: 'r17-directions-diagnostic',
  origin: { id: 'origin', lng: 127.10764191124568, lat: 37.402464820205246 },
  waypoints: [],
  destination: { id: 'destination', lng: 127.11056336672839, lat: 37.39419693653072 }
});
const fail = code => Object.assign(Error(code), { code });
const kstDay = time => new Date(time + 9 * 3600000).toISOString().slice(0, 10);

function approvedKey(proof, env, time) {
  const verified = Date.parse(proof?.observedAt);
  if (proof?.schema !== 1 || proof.source !== 'KAKAO_DEVELOPERS_CONSOLE' ||
      proof.appId !== KAKAO_EXPECTED_APP_ID || proof.api !== 'directions' ||
      proof.providerPaidDisabled !== true || !Number.isFinite(verified) ||
      verified > time || time - verified > 30 * 60000 || kstDay(verified) !== kstDay(time)) {
    throw fail('PAID_OFF_EVIDENCE_REQUIRED');
  }
  const key = String(env.KAKAO_MOBILITY_REST_API_KEY || env.KAKAO_REST_API_KEY || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(key)) throw fail('PRODUCTION_REST_KEY_REQUIRED');
  if (!/^[a-f0-9]{64}$/.test(proof.restKeySha256 || '') ||
      createHash('sha256').update(key).digest('hex') !== proof.restKeySha256) {
    throw fail('PRODUCTION_REST_KEY_APP_UNVERIFIED');
  }
  return key;
}

function requestOnce(url, key) {
  return new Promise((resolve, reject) => {
    // Single new connection, no redirects or retry handler.
    const outgoing = request(url, {
      method: 'GET', agent: false, signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'KakaoAK ' + key, Accept: 'application/json' }
    }, resolve);
    outgoing.once('error', reject);
    outgoing.end();
  });
}

async function readPayload(response) {
  if (!/json/i.test(response.headers['content-type'] || '')) throw fail('INVALID_RESPONSE');
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.byteLength;
    if (size > 8388608) throw fail('INVALID_RESPONSE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function runDiagnostic({ proof, receiptPath, env = process.env, now = Date.now, send = requestOnce }) {
  const key = approvedKey(proof, env, now());
  await mkdir(dirname(receiptPath), { recursive: true });
  const receipt = await open(receiptPath, 'wx', 0o600).catch(error => {
    throw fail(error.code === 'EEXIST' ? 'DIAGNOSTIC_ALREADY_RESERVED' : 'DIAGNOSTIC_RECEIPT_UNAVAILABLE');
  });
  const result = { state: 'RESERVED', providerHttp: null, geometryVerified: false };
  try {
    await receipt.writeFile(JSON.stringify(result));
    await receipt.sync();
    // From here the receipt must be kept, including on timeout or unknown outcome.
    try {
      const plan = adapter.plan(sample);
      const url = new URL(plan.path, 'https://apis-navi.kakaomobility.com');
      for (const [name, value] of Object.entries(plan.query)) {
        if (value !== '') url.searchParams.set(name, value);
      }
      const response = await send(url, key);
      result.providerHttp = Number.isInteger(response.statusCode) ? response.statusCode : null;
      try {
        if (result.providerHttp === 200) {
          const route = adapter.fromProvider(await readPayload(response), sample);
          result.geometryVerified = route.state === 'success' && route.complete === true &&
            route.distanceMeters > 0 && route.durationSeconds > 0;
        }
      } finally {
        response.destroy();
      }
    } catch {
      // Report the observed status only. Transport errors and bodies may carry secrets.
    }
    result.state = 'FINISHED';
    await receipt.truncate(0);
    await receipt.write(JSON.stringify(result), 0, 'utf8');
    await receipt.sync();
    return result;
  } finally {
    await receipt.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const proofPath = process.argv[2];
    if (!proofPath || process.argv.length !== 3 || !process.env.LOCALAPPDATA) throw fail('DIAGNOSTIC_PROOF_PATH_REQUIRED');
    const proof = await readFile(proofPath, 'utf8').then(JSON.parse).catch(() => { throw fail('PAID_OFF_EVIDENCE_REQUIRED'); });
    const receiptPath = join(process.env.LOCALAPPDATA, 'OpsmapAuth', 'r17-directions-provider-attempt.once.json');
    const result = await runDiagnostic({ proof, receiptPath });
    console.log(JSON.stringify(result));
    process.exitCode = result.geometryVerified ? 0 : 1;
  } catch (error) {
    const publicCodes = new Set(['PAID_OFF_EVIDENCE_REQUIRED', 'PRODUCTION_REST_KEY_REQUIRED', 'PRODUCTION_REST_KEY_APP_UNVERIFIED', 'DIAGNOSTIC_ALREADY_RESERVED', 'DIAGNOSTIC_RECEIPT_UNAVAILABLE', 'DIAGNOSTIC_PROOF_PATH_REQUIRED']);
    console.log(JSON.stringify({ state: 'BLOCKED', providerHttp: null, error: publicCodes.has(error.code) ? error.code : 'DIAGNOSTIC_LOCAL_FAILURE' }));
    process.exitCode = 1;
  }
}
