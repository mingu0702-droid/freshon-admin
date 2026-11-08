import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const SHA = /^[a-f0-9]{64}$/;
const MAX_SECRET_FILE_BYTES = 1_000_000;
export const MAX_BLOB_BYTES = 3 * 1024 * 1024;
export const PERIODS = [30, 60, 90];

export function isDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export async function privateCoverageDirectory(directory, appRoot) {
  if (!path.isAbsolute(directory || '')) throw Error('COVERAGE_PRIVATE_DIRECTORY_REQUIRED');
  const resolved = await fs.realpath(directory);
  const relative = path.relative(await fs.realpath(appRoot), resolved);
  if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
    throw Error('COVERAGE_OUTSIDE_APP_REQUIRED');
  }
  if (!(await fs.stat(resolved)).isDirectory()) throw Error('COVERAGE_PRIVATE_DIRECTORY_REQUIRED');
  return resolved;
}

export async function boundedRead(file, maxBytes = MAX_BLOB_BYTES) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw Error('COVERAGE_FILE_TOO_LARGE');
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw Error('COVERAGE_FILE_TOO_LARGE');
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readStoredCoverageFile(file, maxBytes) {
  try {
    return await boundedRead(file, maxBytes);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // Render Secret Files are mounted as text. Bound the encoded and restored sizes.
  const packedFile = path.join(path.dirname(file), 'opsmap-coverage-' + path.basename(file) + '.gz.b64');
  const encoded = (await boundedRead(packedFile, MAX_SECRET_FILE_BYTES)).toString('utf8').trim();
  const compressed = Buffer.from(encoded, 'base64');
  if (!compressed.length || compressed.toString('base64') !== encoded) throw Error('COVERAGE_ENCODING_INVALID');
  return gunzipSync(compressed, { maxOutputLength: maxBytes });
}

const validRef = ref => ref && SHA.test(ref.sha256 || '') &&
  Number.isInteger(ref.bytes) && ref.bytes > 0 && ref.bytes <= MAX_BLOB_BYTES;

export function parseCoverageIndex(bytes, { allowFixture = false } = {}) {
  const value = JSON.parse(bytes);
  const { sha256, ...body } = value;
  if (!SHA.test(sha256 || '') || createHash('sha256').update(JSON.stringify(body)).digest('hex') !== sha256 ||
      value.schema !== 1 || !isDay(value.asOf) || !Number.isFinite(Date.parse(value.generatedAt)) ||
      !Number.isFinite(Date.parse(value.sourceObservedAt)) || !validRef(value.catalog) ||
      !PERIODS.every(days => validRef(value.windows?.[days])) ||
      !(value.kind === 'OBSERVED' || allowFixture && value.kind === 'FIXTURE')) {
    throw Error('COVERAGE_INDEX_INVALID');
  }
  return value;
}
