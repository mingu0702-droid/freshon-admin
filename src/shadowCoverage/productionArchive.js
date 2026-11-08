import { createDecipheriv, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { parseCoverageIndex, PERIODS, privateCoverageDirectory } from './coverageFiles.js';

const REPO_API = 'https://api.github.com/repos/mingu0702-droid/freshon-cache';
const MAGIC = Buffer.from('OPSCOV2\0');
const MAX_ARCHIVE_BYTES = 1024 * 1024;
const MAX_RESTORED_BYTES = 4 * 1024 * 1024;
const decompress = promisify(gunzip);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function archiveConfig(env) {
  const token = env.OPSMAP_PRODUCTION_SHADOW_GITHUB_READ_TOKEN;
  const blob = env.OPSMAP_PRODUCTION_SHADOW_GITHUB_BLOB_SHA;
  const archiveHash = env.OPSMAP_PRODUCTION_SHADOW_ARCHIVE_SHA256;
  const generation = env.OPSMAP_PRODUCTION_SHADOW_GENERATION_SHA256;
  const keyText = env.OPSMAP_PRODUCTION_SHADOW_ARCHIVE_KEY_B64 || '';
  const key = Buffer.from(keyText, 'base64');
  if (!token || !/^[a-f0-9]{40}$/.test(blob) || !/^[a-f0-9]{64}$/.test(archiveHash) ||
      !/^[a-f0-9]{64}$/.test(generation) || key.length !== 32 || key.toString('base64') !== keyText) return null;
  return { token, blob, archiveHash, generation, key };
}

async function readArchive({ token, blob }, fetchImpl) {
  const request = {
    method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2026-03-10' }
  };
  const repo = await fetchImpl(REPO_API, request);
  if (!repo.ok || (await repo.json()).private !== true) throw Error('COVERAGE_ARCHIVE_REPOSITORY');
  const response = await fetchImpl(REPO_API + '/git/blobs/' + blob, {
    ...request, headers: { ...request.headers, Accept: 'application/vnd.github.raw+json' }
  });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_ARCHIVE_BYTES) {
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

async function restoreArchive(config, { appRoot, fetchImpl, tempRoot }) {
  const archive = await readArchive(config, fetchImpl);
  const nonceEnd = MAGIC.length + 12;
  const tagEnd = nonceEnd + 16;
  if (archive.length <= tagEnd || !archive.subarray(0, MAGIC.length).equals(MAGIC) ||
      sha256(archive) !== config.archiveHash) throw Error('COVERAGE_ARCHIVE_INTEGRITY');
  const decipher = createDecipheriv('aes-256-gcm', config.key, archive.subarray(MAGIC.length, nonceEnd));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(archive.subarray(nonceEnd, tagEnd));
  const compressed = Buffer.concat([decipher.update(archive.subarray(tagEnd)), decipher.final()]);
  const bytes = await decompress(compressed, { maxOutputLength: MAX_RESTORED_BYTES });
  if (bytes.length < 4) throw Error('COVERAGE_ARCHIVE_FORMAT');
  const indexSize = bytes.readUInt32BE(0);
  let offset = 4 + indexSize;
  if (!indexSize || indexSize > 16_384 || offset >= bytes.length) throw Error('COVERAGE_ARCHIVE_FORMAT');
  const indexBytes = bytes.subarray(4, offset);
  const index = parseCoverageIndex(indexBytes);
  // Re-sealing with a Production key changes the ciphertext, but not the approved generation.
  if (index.sha256 !== config.generation) throw Error('COVERAGE_ARCHIVE_GENERATION');

  const folder = await fs.mkdtemp(path.join(await fs.realpath(tempRoot), 'opsmap-prod-shadow-'));
  try {
    await fs.chmod(folder, 0o700);
    await privateCoverageDirectory(folder, appRoot);
    for (const ref of [index.catalog, ...PERIODS.map(days => index.windows[days])]) {
      const contents = bytes.subarray(offset, offset + ref.bytes);
      if (contents.length !== ref.bytes || sha256(contents) !== ref.sha256) throw Error('COVERAGE_ARCHIVE_FILE_INTEGRITY');
      await fs.writeFile(path.join(folder, ref.sha256 + '.json'), contents, { flag: 'wx', mode: 0o400 });
      offset += ref.bytes;
    }
    if (offset !== bytes.length) throw Error('COVERAGE_ARCHIVE_FORMAT');
    await fs.writeFile(path.join(folder, 'coverage-index.json'), indexBytes, { flag: 'wx', mode: 0o400 });
    return folder;
  } catch (error) {
    for (const name of await fs.readdir(folder).catch(() => [])) {
      const file = path.join(folder, name);
      await fs.chmod(file, 0o600).catch(() => {});
      await fs.unlink(file).catch(() => {});
    }
    await fs.rmdir(folder).catch(() => {});
    throw error;
  }
}

export function createProductionShadowRuntime(env, { appRoot, fetchImpl = fetch, tempRoot = os.tmpdir() }) {
  const config = archiveConfig(env);
  let state = config ? 'restoring' : 'unavailable';
  let directory = null;
  if (config) setImmediate(async () => {
    try {
      directory = await restoreArchive(config, { appRoot, fetchImpl, tempRoot });
      state = 'ready';
    } catch {
      state = 'unavailable';
      console.warn('[opsmap-shadow] PRODUCTION_COVERAGE_DATA_UNAVAILABLE');
    }
  });
  return { state: () => state, readDirectory: () => directory };
}
