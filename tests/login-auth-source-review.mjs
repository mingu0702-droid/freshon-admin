import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourcePath = 'src/mapStaffAuth.js';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).replace(/\r\n/g, '\n');
const current = (await fs.readFile(path.join(root, sourcePath), 'utf8')).replace(/\r\n/g, '\n');
const segments = [
  ['hash_format_and_verification', 'const params =', '// Deliberately single-process.'],
  ['configuration_and_origin', '  function configuration()', '  function sessionKey('],
  ['rate_limit', '  function limited(', '  const router ='],
  ['login_handler', "  router.post('/login'", "  router.post('/logout'"],
];
const comparison = [];
for (const ref of ['c0e5ee7', 'a2ce400']) {
  const prior = git('show', `${ref}:${sourcePath}`);
  for (const [name, start, end] of segments) {
    const select = text => text.slice(text.indexOf(start), text.indexOf(end));
    assert(current.includes(start) && current.includes(end));
    assert.equal(select(current), select(prior), `${ref}:${name}`);
    comparison.push({ baseline: git('rev-parse', ref).trim(), section: name, unchanged: true });
  }
  const previousPackage = JSON.parse(git('show', `${ref}:package.json`));
  const currentPackage = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(previousPackage.dependencies.argon2, currentPackage.dependencies.argon2);
}
const sha = value => createHash('sha256').update(value).digest('hex');
const review = {
  baseCommit: git('rev-parse', '2775b83').trim(),
  scope: 'Tracked source comparison only; no environment file, runtime credential, hash value, remote login, service mutation or deployment access',
  credentialReads: 0, remoteRequests: 0, stageLoginValidated: false,
  authSourceSha256: sha(await fs.readFile(path.join(root, sourcePath))),
  entrySourceSha256: sha(await fs.readFile(path.join(root, 'public/map-staff-entry.js'))),
  comparison,
  observations: {
    environmentLoad: 'src/server.js imports config.js; src/config.js:3 invokes dotenv.config; productionMapIntegration.js:33 calls createMapStaffAuth(authOptions) whose default env is process.env',
    origin: 'src/mapStaffAuth.js:46 prefers RENDER_EXTERNAL_URL to MAP_STAFF_ORIGIN; :52 rejects mismatched Origin or cross-site sec-fetch-site; login returns 403 ORIGIN_REJECTED before password verification',
    argon2: 'Exact accepted Argon2id parameters and native argon2.verify remain identical to both baselines; generated settings are not newly changed',
    retry: 'Per-socket 10/global 30 attempts per 15 minutes, plus single in-flight verification, return 429 LOGIN_RETRY_LATER; Retry-After is a fixed 60 seconds and does not establish limiter expiry',
    injection: 'Auth reads process.env directly rather than config.envValue normalization; adding trim/unquoting would change credential semantics and is outside this UI patch',
    changedUi: 'public/map-staff-entry.js:70 preserves HTTP status for non-JSON responses; :226 only reports credential rejection for 401 LOGIN_FAILED; origin/service/transport/limiter are separately displayed',
    limitation: 'Local error rendering evidence cannot identify the actual Stage response status or prove the real password is accepted',
  },
};
await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
await fs.writeFile(path.join(root, 'evidence/login-auth-source-review.json'), JSON.stringify(review, null, 2) + '\n');
console.log(JSON.stringify({ unchangedAuthSections: comparison.length, stageRequests: 0, credentialReads: 0 }));
