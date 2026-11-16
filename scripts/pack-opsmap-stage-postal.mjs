import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { postalAssetPacks, sealedPostalPacks } from '../src/shadowCoverage/stagePostalAssets.js';

const [releaseRoot, detailsRoot, overviewRoot, reviewRoot, proofFile, target, keyFile] = process.argv.slice(2);
if (![releaseRoot, detailsRoot, overviewRoot, reviewRoot, proofFile, target, keyFile].every(value => isAbsolute(value || ''))) {
  throw Error('Usage: pack-opsmap-stage-postal <release> <details> <overview> <review> <proof> <new-output> <new-key-file>');
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const verified = (bytes, expected) => {
  if (digest(bytes) !== expected) throw Error('POSTAL_INPUT_DIGEST');
  return bytes;
};
const proof = JSON.parse(await readFile(proofFile, 'utf8'));
const proofs = Object.fromEntries(proof.files.map(entry => [entry.kind, entry.digest]));
const geometry = join(releaseRoot, 'geometry');
const manifestBytes = verified(await readFile(join(geometry, 'manifest.json')), proofs.boundary);
const manifest = JSON.parse(manifestBytes);
const areas = verified(await readFile(join(geometry, 'areas.bin')), manifest.areas.sha256);
const overviewIndex = verified(await readFile(join(overviewRoot, 'overview-index.json')), proofs.overview);
const overview = JSON.parse(overviewIndex);
const overviewTiles = verified(await readFile(join(overviewRoot, 'overview-tiles.gz')), overview.archive.sha256);
const release = verified(await readFile(join(releaseRoot, 'postal-release.json.gz')), proofs.release);
const detailIndex = verified(await readFile(join(detailsRoot, 'details-index.json.gz')), proofs.details);
const review = verified(await readFile(join(reviewRoot, 'postal-assignment-review.json')), proofs.review);
const history = await readFile(join(detailsRoot, 'customer-history.bin'));
const detail = JSON.parse(gunzipSync(detailIndex, { maxOutputLength: 8 * 1024 * 1024 }));
const active = JSON.parse(gunzipSync(release, { maxOutputLength: 5 * 1024 * 1024 }));
const checkedReview = JSON.parse(review);

if ([detail, active, checkedReview].some(value => value.generation !== proof.generation || value.boundary !== proofs.boundary) ||
    detail.asOf !== proof.evidenceThrough || active.asOf !== proof.evidenceThrough || detail.release !== proofs.release ||
    checkedReview.release !== proofs.release || overview.boundary !== proofs.boundary || history.length !== detail.bytes) {
  throw Error('POSTAL_INPUT_GENERATION');
}
let cursor = 0;
for (const [, offset, size, , expected] of detail.parts) {
  if (offset !== cursor || !Number.isSafeInteger(size) || size < 1 || size + offset > history.length) throw Error('POSTAL_INPUT_HISTORY');
  verified(history.subarray(offset, offset + size), expected);
  cursor += size;
}
if (cursor !== history.length) throw Error('POSTAL_INPUT_HISTORY');

const key = randomBytes(32);
const packs = {};
const entry = (name, bytes) => ({ name, bytes });
await mkdir(target, { mode: 0o700 });
async function pack(name, files) {
  const placements = files.map(value => ({ name: value.name, bytes: value.bytes.length, sha256: digest(value.bytes) }));
  const header = Buffer.from(JSON.stringify({ schema: 1, pack: name, files: placements }));
  const preamble = Buffer.alloc(4);
  preamble.writeUInt32LE(header.length);
  let payload = Buffer.concat([preamble, header, ...files.map(item => item.bytes)]);
  if (sealedPostalPacks.has(name)) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('opsmap-stage-postal-v1/' + name));
    payload = Buffer.concat([iv, cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  }
  if (payload.length > postalAssetPacks[name]) throw Error('POSTAL_PACK_LIMIT');
  await writeFile(join(target, name + '.bin'), payload, { flag: 'wx', mode: 0o600 });
  packs[name] = { sha256: digest(payload), bytes: payload.length, files: files.length };
}

await pack('core', [entry('geometry/manifest.json', manifestBytes), entry('geometry/areas.bin', areas),
  entry('overview/overview-index.json', overviewIndex), entry('overview/overview-tiles.gz', overviewTiles)]);
for (const tier of ['national', 'regional', 'detail']) {
  const files = [];
  for (const tile of manifest.tiers[tier]) {
    if (!/^(?:national|regional|detail)-\d{1,3}-\d{1,3}-\d{1,2}$/.test(tile.id) || !tile.id.startsWith(tier + '-')) {
      throw Error('POSTAL_INPUT_TILE');
    }
    const name = tile.id + '.gz';
    const bytes = verified(await readFile(join(geometry, name)), tile.sha256);
    if (bytes.length !== tile.bytes) throw Error('POSTAL_INPUT_TILE');
    files.push(entry(name, bytes));
  }
  await pack(tier, files);
}
await pack('release', [entry('postal-release.json.gz', release), entry('postal-assignment-review.json', review)]);
await pack('history', [entry('details-index.json.gz', detailIndex), entry('customer-history.bin', history)]);
await writeFile(keyFile, key.toString('base64'), { flag: 'wx', mode: 0o600 });
const { boundary, overview: overviewHash, release: releaseHash, details, review: reviewHash } = proofs;
const config = { schema: 1, generation: proof.generation, boundary, overview: overviewHash, release: releaseHash,
  details, review: reviewHash, packs };
await writeFile(join(target, 'manifest.safe.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ generation: config.generation, through: proof.evidenceThrough,
  bytes: Object.values(packs).reduce((sum, value) => sum + value.bytes, 0), packs: Object.keys(packs) }));
