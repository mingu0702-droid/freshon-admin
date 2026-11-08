import {createDecipheriv, createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {gunzip} from 'node:zlib';

const STAGE_ORIGIN = 'https://freshon-admin-stage-preview-template.onrender.com';
const STAGE_SERVICE = 'srv-da47hugu01pc73etpfa0';
const BLOB_API = 'https://api.github.com/repos/mingu0702-droid/freshon-cache/git/blobs/';
const MAX_ARCHIVE_BYTES = 1024 * 1024;
const MAX_RESTORED_BYTES = 4 * 1024 * 1024;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const decompress = promisify(gunzip);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export const STAGE_ARCHIVE_MAGIC = Buffer.from('OPSCOV2\0');
export const STAGE_ARCHIVE_ENV = Object.freeze({
  token: 'OPSMAP_SHADOW_GITHUB_READ_TOKEN',
  blob: 'OPSMAP_SHADOW_GITHUB_BLOB_SHA',
  hash: 'OPSMAP_SHADOW_ARCHIVE_SHA256',
  key: 'OPSMAP_SHADOW_ARCHIVE_KEY_B64'
});

async function readBlob({blob, token, fetchImpl, signal}) {
  const response = await fetchImpl(BLOB_API + blob, {
    method: 'GET', redirect: 'error', cache: 'no-store', signal,
    headers: {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2026-03-10'}
  });
  if (response.status !== 200 || !response.body ||
      Number(response.headers.get('content-length')) > MAX_ARCHIVE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw Error('COVERAGE_ARCHIVE_RESPONSE');
  }
  const bytes = Buffer.allocUnsafe(MAX_ARCHIVE_BYTES);
  let length = 0;
  for await (const chunk of response.body) {
    if (length + chunk.byteLength > bytes.length) throw Error('COVERAGE_ARCHIVE_SIZE');
    bytes.set(chunk, length);
    length += chunk.byteLength;
  }
  return bytes.subarray(0, length);
}

async function restoreFiles(bytes, tempRoot, appRoot) {
  if (bytes.length < 4) throw Error('COVERAGE_ARCHIVE_FORMAT');
  const indexBytes = bytes.readUInt32BE(0);
  let offset = 4 + indexBytes;
  if (!indexBytes || indexBytes > 16_384 || offset >= bytes.length) throw Error('COVERAGE_ARCHIVE_FORMAT');

  const {privateCoverageDirectory, readCoverageIndex} = await import('./store.js');
  const directory = await fs.mkdtemp(path.join(await fs.realpath(tempRoot), 'opsmap-shadow-'));
  try {
    await fs.chmod(directory, 0o700);
    await privateCoverageDirectory(directory, appRoot);
    const partialIndex = path.join(directory, 'coverage-index.json.pending');
    await fs.writeFile(partialIndex, bytes.subarray(4, offset), {flag: 'wx', mode: 0o400});
    const index = await readCoverageIndex(partialIndex);
    for (const ref of [index.catalog, index.windows[30], index.windows[60], index.windows[90]]) {
      const contents = bytes.subarray(offset, offset + ref.bytes);
      if (contents.length !== ref.bytes || sha256(contents) !== ref.sha256) {
        throw Error('COVERAGE_ARCHIVE_FILE_INTEGRITY');
      }
      await fs.writeFile(path.join(directory, ref.sha256 + '.json'), contents, {flag: 'wx', mode: 0o400});
      offset += ref.bytes;
    }
    if (offset !== bytes.length) throw Error('COVERAGE_ARCHIVE_FORMAT');
    await fs.rename(partialIndex, path.join(directory, 'coverage-index.json'));
    return directory;
  } catch (error) {
    for (const name of await fs.readdir(directory).catch(() => [])) {
      const file = path.join(directory, name);
      await fs.chmod(file, 0o600).catch(() => {});
      await fs.unlink(file).catch(() => {});
    }
    await fs.rmdir(directory).catch(() => {});
    throw error;
  }
}

export async function restoreStageShadowCoverage(env, {
  fetchImpl = fetch, tempRoot = '/tmp', appRoot = APP_ROOT, signal = AbortSignal.timeout(10_000)
} = {}) {
  if (env.RENDER_EXTERNAL_URL !== STAGE_ORIGIN || (env.RENDER_SERVICE_ID && env.RENDER_SERVICE_ID !== STAGE_SERVICE)) {
    throw Error('COVERAGE_ARCHIVE_STAGE_ONLY');
  }
  const token = env[STAGE_ARCHIVE_ENV.token];
  const blob = env[STAGE_ARCHIVE_ENV.blob];
  const expected = env[STAGE_ARCHIVE_ENV.hash];
  const key = Buffer.from(env[STAGE_ARCHIVE_ENV.key] || '', 'base64');
  if (!token || !/^[a-f0-9]{40}$/.test(blob || '') || !/^[a-f0-9]{64}$/.test(expected || '') ||
      key.length !== 32 || key.toString('base64') !== env[STAGE_ARCHIVE_ENV.key]) {
    throw Error('COVERAGE_ARCHIVE_CONFIG');
  }
  const archive = await readBlob({blob, token, fetchImpl, signal});
  const magicEnd = STAGE_ARCHIVE_MAGIC.length;
  const nonceEnd = magicEnd + NONCE_BYTES;
  const tagEnd = nonceEnd + TAG_BYTES;
  if (archive.length <= tagEnd || !archive.subarray(0, magicEnd).equals(STAGE_ARCHIVE_MAGIC) ||
      sha256(archive) !== expected) throw Error('COVERAGE_ARCHIVE_INTEGRITY');
  const decipher = createDecipheriv('aes-256-gcm', key, archive.subarray(magicEnd, nonceEnd));
  decipher.setAAD(STAGE_ARCHIVE_MAGIC);
  decipher.setAuthTag(archive.subarray(nonceEnd, tagEnd));
  const compressed = Buffer.concat([decipher.update(archive.subarray(tagEnd)), decipher.final()]);
  const bytes = await decompress(compressed, {maxOutputLength: MAX_RESTORED_BYTES});
  return restoreFiles(bytes, tempRoot, appRoot);
}

export async function stageShadowRuntimeEnv(env, options) {
  const runtime = {...env, OPSMAP_SHADOW_DATA_DIR: ''};
  for (const key of Object.values(STAGE_ARCHIVE_ENV)) delete runtime[key];
  try {
    runtime.OPSMAP_SHADOW_DATA_DIR = await restoreStageShadowCoverage(env, options);
  } catch {
    console.warn('[opsmap-shadow] COVERAGE_DATA_UNAVAILABLE');
  }
  return runtime;
}
