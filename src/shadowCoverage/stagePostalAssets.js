import { createDecipheriv, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { STAGE_ORIGIN, STAGE_SERVICE } from '../stageScope.js';

const MiB = 1024 * 1024;
const maxHeaderBytes = 512 * 1024;
const SHA = /^[0-9a-f]{64}$/;
const dataUrl = 'https://api.github.com/repos/mingu0702-droid/freshon-cache/contents/opsmap-stage/postal-v1/';
export const postalAssetPacks = Object.freeze({ core: 5 * MiB, release: MiB, national: 16 * MiB,
  regional: 24 * MiB, detail: 32 * MiB, history: 8 * MiB });
export const sealedPostalPacks = new Set(['release', 'history']);
const fixedFiles = {
  core: ['geometry/manifest.json', 'geometry/areas.bin', 'overview/overview-index.json', 'overview/overview-tiles.gz'],
  release: ['postal-release.json.gz', 'postal-assignment-review.json'],
  history: ['details-index.json.gz', 'customer-history.bin']
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function checkFiles(pack, entries, length) {
  const required = fixedFiles[pack];
  const tile = /^(?:national|regional|detail)-\d{1,3}-\d{1,3}-\d{1,2}\.gz$/;
  const names = new Set();
  let total = 0;
  if (!Array.isArray(entries) || !entries.length || entries.length > 4096) throw Error('POSTAL_ASSET_FORMAT');
  for (const entry of entries) {
    const name = entry?.name;
    const allowed = required ? required.includes(name) : typeof name === 'string' && tile.test(name) && name.startsWith(pack + '-');
    if (!allowed || names.has(name) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 ||
        entry.bytes > 8 * MiB || !SHA.test(entry.sha256 || '')) throw Error('POSTAL_ASSET_FORMAT');
    names.add(name);
    total += entry.bytes;
  }
  if (total !== length || required && required.some(name => !names.has(name))) throw Error('POSTAL_ASSET_FORMAT');
}

async function installFiles(pack, archive, length, destination, key) {
  let read;
  let handle;
  try {
    if (sealedPostalPacks.has(pack)) {
      const encrypted = await readFile(archive);
      const decrypt = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
      decrypt.setAAD(Buffer.from('opsmap-stage-postal-v1/' + pack));
      decrypt.setAuthTag(encrypted.subarray(-16));
      const clear = Buffer.concat([decrypt.update(encrypted.subarray(12, -16)), decrypt.final()]);
      length = clear.length;
      read = async (offset, size) => clear.subarray(offset, offset + size);
    } else {
      handle = await open(archive, 'r');
      read = async (offset, size) => {
        const bytes = Buffer.allocUnsafe(size);
        let cursor = 0;
        while (cursor < size) {
          const result = await handle.read(bytes, cursor, size - cursor, offset + cursor);
          if (!result.bytesRead) throw Error('POSTAL_ASSET_FORMAT');
          cursor += result.bytesRead;
        }
        return bytes;
      };
    }
    if (length <= 4) throw Error('POSTAL_ASSET_FORMAT');
    const headerSize = (await read(0, 4)).readUInt32LE(0);
    if (!headerSize || headerSize > maxHeaderBytes || headerSize + 4 >= length) throw Error('POSTAL_ASSET_FORMAT');
    const header = JSON.parse((await read(4, headerSize)).toString('utf8'));
    if (header.schema !== 1 || header.pack !== pack) throw Error('POSTAL_ASSET_FORMAT');
    let offset = headerSize + 4;
    checkFiles(pack, header.files, length - offset);
    for (const entry of header.files) {
      const bytes = await read(offset, entry.bytes);
      if (hash(bytes) !== entry.sha256) throw Error('POSTAL_ASSET_INTEGRITY');
      const output = join(destination, entry.name);
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
      offset += entry.bytes;
    }
  } finally {
    await handle?.close();
  }
}

function configuration(env) {
  let config;
  try { config = JSON.parse(env.OPSMAP_SHADOW_POSTAL_REMOTE_CONFIG); }
  catch { throw Error('POSTAL_ASSET_CONFIG'); }
  if (config?.schema !== 1 || !/^[0-9a-f]{40}$/.test(config.ref || '') ||
      !['generation', 'boundary', 'release', 'overview', 'details', 'review'].every(key => SHA.test(config[key] || '')) ||
      !Object.entries(postalAssetPacks).every(([name, max]) => {
        const pack = config.packs?.[name];
        return Number.isSafeInteger(pack?.bytes) && pack.bytes >= 64 && pack.bytes <= max && SHA.test(pack.sha256 || '');
      })) throw Error('POSTAL_ASSET_CONFIG');
  return config;
}

export const stagePostalReadToken = env => env.OPSMAP_SNAPSHOT_STORE_TOKEN || env.GITHUB_TOKEN;

export function createStagePostalAssets({ env = process.env, fetchImpl = fetch, tempRoot = tmpdir(), now = Date.now,
  log = value => console.info(JSON.stringify(value)) } = {}) {
  if (!env.OPSMAP_SHADOW_POSTAL_REMOTE_CONFIG) return null;
  if (env.RENDER_SERVICE_ID !== STAGE_SERVICE || env.RENDER_EXTERNAL_URL !== STAGE_ORIGIN) throw Error('POSTAL_ASSET_STAGE_SCOPE');
  const config = configuration(env);
  const token = stagePostalReadToken(env);
  const encodedKey = env.OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64 || '';
  const key = Buffer.from(encodedKey, 'base64');
  if (!token || key.length !== 32 || key.toString('base64') !== encodedKey) throw Error('POSTAL_ASSET_CONFIG');
  const installed = new Map(), pending = new Map(), retryAfter = new Map();
  let temporary, remoteRetryAfter = 0;
  const request = name => fetchImpl(dataUrl + name + '?ref=' + config.ref, { method: 'GET', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json', 'Accept-Encoding': 'identity' },
    signal: AbortSignal.timeout(45_000) });

  async function restore(pack) {
    const expected = config.packs[pack];
    const root = await (temporary ??= mkdtemp(join(tempRoot, 'opsmap-postal-assets-')).catch(error => {
      temporary = null;
      throw error;
    }));
    const destination = await mkdtemp(join(root, pack + '-'));
    const archive = join(destination, 'download.pack');
    const started = performance.now();
    try {
      const response = await request(pack + '.bin');
      if (!response.ok || !response.body) {
        if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
          if (Number.isSafeInteger(reset) && reset > now()) remoteRetryAfter = reset;
        }
        await response.body?.cancel();
        throw Error('POSTAL_ASSET_DOWNLOAD');
      }
      let received = 0;
      const digest = createHash('sha256');
      const check = new Transform({ transform(chunk, _encoding, done) {
        received += chunk.length;
        if (received > expected.bytes) return done(Error('POSTAL_ASSET_INTEGRITY'));
        digest.update(chunk);
        return done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), check, createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
      if (received !== expected.bytes || digest.digest('hex') !== expected.sha256) throw Error('POSTAL_ASSET_INTEGRITY');
      const downloaded = performance.now();
      await installFiles(pack, archive, received, destination, key);
      await unlink(archive);
      log({ component: 'opsmap-postal-assets', pack, bytes: received, downloadMs: Math.round(downloaded - started),
        installMs: Math.round(performance.now() - downloaded), maxRssKiB: process.resourceUsage().maxRSS });
      return destination;
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => {});
      retryAfter.set(pack, now() + 5_000);
      const code = ['POSTAL_ASSET_FORMAT', 'POSTAL_ASSET_INTEGRITY', 'POSTAL_ASSET_DOWNLOAD'].includes(error.message)
        ? error.message : 'POSTAL_ASSET_UNAVAILABLE';
      log({ component: 'opsmap-postal-assets', pack, error: code });
      throw Error(code);
    }
  }

  function read(pack) {
    if (installed.has(pack)) return Promise.resolve(installed.get(pack));
    if (pending.has(pack)) return pending.get(pack);
    if (now() < Math.max(retryAfter.get(pack) || 0, remoteRetryAfter)) return Promise.reject(Error('POSTAL_ASSET_RETRY_LATER'));
    const task = restore(pack).then(folder => {
      installed.set(pack, folder);
      return folder;
    }).finally(() => pending.delete(pack));
    pending.set(pack, task);
    return task;
  }

  return {
    config,
    async verifyReference() {
      try {
        const response = await request('manifest.safe.json');
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw Error('POSTAL_ASSET_REFERENCE');
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 8192) throw Error('POSTAL_ASSET_REFERENCE');
          chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const matches = ['schema', 'generation', 'boundary', 'release', 'overview', 'details', 'review']
          .every(name => value[name] === config[name]) && Object.keys(postalAssetPacks).every(name =>
          value.packs?.[name]?.sha256 === config.packs[name].sha256 && value.packs[name].bytes === config.packs[name].bytes);
        if (!matches) throw Error('POSTAL_ASSET_REFERENCE');
        log({ component: 'opsmap-postal-reference', state: 'VERIFIED', generation: config.generation });
      } catch {
        log({ component: 'opsmap-postal-reference', state: 'UNAVAILABLE' });
      }
    },
    async base() {
      const [core, release] = await Promise.all([read('core'), read('release')]);
      return { directory: release, geometry: join(core, 'geometry'), overview: join(core, 'overview'), review: release };
    },
    tiles: tier => read(tier),
    details: () => read('history')
  };
}
