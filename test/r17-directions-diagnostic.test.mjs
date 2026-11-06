import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { runDiagnostic } from '../scripts/r17-directions-diagnostic.mjs';

const key = '0123456789abcdef'.repeat(2);
const now = () => Date.parse('2026-11-07T03:00:00Z');
const proof = {
  schema: 1, source: 'KAKAO_DEVELOPERS_CONSOLE', appId: '1464792', api: 'directions', providerPaidDisabled: true,
  observedAt: '2026-11-07T02:59:00Z', restKeySha256: createHash('sha256').update(key).digest('hex')
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'r17-directions-diagnostic-'));
  const receiptPath = join(directory, 'once.json');
  t.after(async () => {
    await unlink(receiptPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  });
  return { now, proof, env: { KAKAO_REST_API_KEY: key }, receiptPath };
}

test('verified proof reserves exactly one fixed public call across concurrent invocations', async t => {
  const options = await fixture(t);
  let sends = 0;
  options.send = async (url, credential) => {
    sends++;
    assert.equal(credential, key);
    assert.equal(url.origin + url.pathname, 'https://apis-navi.kakaomobility.com/v1/directions');
    assert.equal(url.searchParams.get('origin'), '127.10764191124568,37.402464820205246');
    assert.equal(url.searchParams.get('destination'), '127.11056336672839,37.39419693653072');
    assert.equal(url.searchParams.has('waypoints'), false);
    assert.deepEqual(JSON.parse(await readFile(options.receiptPath, 'utf8')), {state: 'RESERVED', providerHttp: null, geometryVerified: false});
    const payload = { routes: [{ result_code: 0, summary: { distance: 1000, duration: 300 },
      sections: [{ distance: 1000, duration: 300, roads: [{ vertexes: [127.1076, 37.4024, 127.1106, 37.3941] }] }] }] };
    return Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), {
      statusCode: 200, headers: { 'content-type': 'application/json' }
    });
  };
  const attempts = await Promise.allSettled([runDiagnostic(options), runDiagnostic(options)]);
  assert.equal(sends, 1);
  assert.deepEqual(attempts.find(attempt => attempt.status === 'fulfilled').value, {state: 'FINISHED', providerHttp: 200, geometryVerified: true, resultCode: 0, distanceMeters: 1000, durationSeconds: 300});
  assert.equal(attempts.find(attempt => attempt.status === 'rejected').reason.code, 'DIAGNOSTIC_ALREADY_RESERVED');
  const stored = await readFile(options.receiptPath, 'utf8');
  assert(!stored.includes(key) && !stored.includes('vertexes'));
});

test('proof failures do not reserve and an unknown transport outcome never retries', async t => {
  const options = await fixture(t);
  let sends = 0;
  options.send = async () => { sends++; throw Error('SYNTHETIC_PRIVATE_TRANSPORT_DETAILS'); };
  for (const invalid of [{ providerPaidDisabled: false }, { observedAt: '2026-11-06T02:59:00Z' }, { appId: '123456' }, { restKeySha256: 'a'.repeat(64) }]) {
    await assert.rejects(runDiagnostic({...options, proof: {...proof, ...invalid}}));
  }
  assert.equal(sends, 0);
  await assert.rejects(readFile(options.receiptPath), {code: 'ENOENT'});
  assert.deepEqual(await runDiagnostic(options), {state: 'FINISHED', providerHttp: null, geometryVerified: false});
  await assert.rejects(runDiagnostic(options), {code: 'DIAGNOSTIC_ALREADY_RESERVED'});
  assert.equal(sends, 1);
  assert(!(await readFile(options.receiptPath, 'utf8')).includes('SYNTHETIC_PRIVATE_TRANSPORT_DETAILS'));
});
