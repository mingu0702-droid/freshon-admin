import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStagePostalAssets } from '../src/shadowCoverage/stagePostalAssets.js';
import { STAGE_ORIGIN, STAGE_SERVICE } from '../src/stageScope.js';

const sha = data => createHash('sha256').update(data).digest('hex');
const key = Buffer.alloc(32, 0x5a);
const ref = 'ab'.repeat(20);
const names = {
  core: ['geometry/manifest.json', 'geometry/areas.bin', 'overview/overview-index.json', 'overview/overview-tiles.gz'],
  release: ['postal-release.json.gz', 'postal-assignment-review.json'],
  national: ['national-1-2-3.gz'], regional: ['regional-1-2-3.gz'], detail: ['detail-1-2-3.gz'],
  history: ['details-index.json.gz', 'customer-history.bin']
};

function archive(pack, paths) {
  const bodies = paths.map(name => Buffer.from(`${pack}/${name}`));
  const header = Buffer.from(JSON.stringify({ schema: 1, pack, files: paths.map((name, at) => ({
    name, bytes: bodies[at].length, sha256: sha(bodies[at])
  })) }));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(header.length);
  const clear = Buffer.concat([size, header, ...bodies]);
  if (!['history', 'release'].includes(pack)) return clear;
  const iv = Buffer.alloc(12, pack === 'history' ? 1 : 2);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`opsmap-stage-postal-v1/${pack}`));
  return Buffer.concat([iv, cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
}

async function fixture(t, override = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'postal-assets-test-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const blobs = Object.fromEntries(Object.entries({ ...names, ...override }).map(([pack, paths]) => [pack, archive(pack, paths)]));
  const packs = Object.fromEntries(Object.entries(blobs).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }]));
  const fields = Object.fromEntries(['generation', 'overview', 'boundary', 'release', 'review', 'details'].map(name => [name, sha(name)]));
  const env = { RENDER_SERVICE_ID: STAGE_SERVICE, RENDER_EXTERNAL_URL: STAGE_ORIGIN, GITHUB_TOKEN: 'fixture-only',
    OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64: key.toString('base64'),
    OPSMAP_SHADOW_POSTAL_REMOTE_CONFIG: JSON.stringify({ schema: 1, ref, ...fields, packs }) };
  return { tmp, env, blobs };
}

test('postal assets fetch cold on demand, pin the private ref and coalesce to one download per pack', async t => {
  const { tmp, env, blobs } = await fixture(t);
  const calls = [], logs = [];
  const fetchImpl = async (url, request) => {
    const path = new URL(url);
    assert.equal(path.origin, 'https://api.github.com');
    assert.match(path.pathname, /^\/repos\/mingu0702-droid\/freshon-cache\/contents\/opsmap-stage\/postal-v1\//);
    assert.equal(path.searchParams.get('ref'), ref);
    assert.equal(request.redirect, 'error');
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.Authorization, 'Bearer fixture-only');
    const name = path.pathname.split('/').at(-1).split('.')[0];
    calls.push(name);
    return new Response(blobs[name]);
  };
  const create = () => createStagePostalAssets({ env, fetchImpl, tempRoot: tmp, log: row => logs.push(row) });
  const assets = create();
  assert.deepEqual(calls, []);
  const [base, second] = await Promise.all([assets.base(), assets.base()]);
  assert.deepEqual(second, base);
  assert.deepEqual(calls.sort(), ['core', 'release']);
  assert.equal(await readFile(join(base.geometry, 'areas.bin'), 'utf8'), 'core/geometry/areas.bin');
  assert.equal(await readFile(join(base.review, 'postal-assignment-review.json'), 'utf8'), 'release/postal-assignment-review.json');
  const [a, b] = await Promise.all([assets.tiles('detail'), assets.tiles('detail')]);
  assert.equal(a, b);
  assert.deepEqual(await readdir(a), names.detail);
  assert.equal(await readFile(join(await assets.details(), 'customer-history.bin'), 'utf8'), 'history/customer-history.bin');
  assert.deepEqual(calls.sort(), ['core', 'detail', 'history', 'release']);
  assert(logs.every(row => row.bytes > 0 && row.downloadMs >= 0));
  assert.notEqual((await create().base()).directory, base.directory);
  assert.equal(calls.filter(x => x === 'core').length, 2);
});

test('postal assets fail closed on changed SHA, apply a short backoff and retry cleanly', async t => {
  const { tmp, env, blobs } = await fixture(t);
  let fetches = 0, time = 0;
  const assets = createStagePostalAssets({ env, tempRoot: tmp, now: () => time, log: () => {}, fetchImpl: async () => {
    fetches++;
    return new Response(fetches === 1 ? Buffer.concat([blobs.national, Buffer.from([0])]) : blobs.national);
  } });
  await assert.rejects(assets.tiles('national'), /POSTAL_ASSET_INTEGRITY/);
  await assert.rejects(assets.tiles('national'), /POSTAL_ASSET_RETRY_LATER/);
  assert.equal(fetches, 1);
  time = 5001;
  assert.deepEqual(await readdir(await assets.tiles('national')), names.national);
  assert.equal(fetches, 2);
});

test('postal assets reject unexpected paths and invalid decryption or deployment scopes', async t => {
  const { tmp, env, blobs } = await fixture(t, { detail: ['../detail-1-2-3.gz'] });
  const init = override => createStagePostalAssets({ env: { ...env, ...override }, tempRoot: tmp, log: () => {},
    fetchImpl: async url => new Response(blobs[new URL(url).pathname.split('/').at(-1).split('.')[0]]) });
  await assert.rejects(init({}).tiles('detail'), /POSTAL_ASSET_FORMAT/);
  await assert.rejects(init({ OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64: Buffer.alloc(32, 0x7f).toString('base64') }).details(), /POSTAL_ASSET_UNAVAILABLE/);
  assert.throws(() => init({ RENDER_SERVICE_ID: 'another-service' }), /POSTAL_ASSET_STAGE_SCOPE/);
});

test('detail view reads only the requested pinned range and verifies it against the boundary manifest', async t => {
  const entries = ['detail-41-52-0.gz','detail-83-93-0.gz'];
  const { tmp, env, blobs } = await fixture(t,{ detail:entries });
  const tiles = entries.map(name => {
    const bytes = Buffer.from('detail/' + name);
    return { id:name.slice(0,-3), bytes:bytes.length, sha256:sha(bytes) };
  });
  const selected = tiles[1], blob = blobs.detail;
  const calls = [];
  const assets = createStagePostalAssets({ env, tempRoot:tmp, log:()=>{}, fetchImpl:async (url,options)=>{
    calls.push(url);
    assert.equal(url,'https://raw.githubusercontent.com/mingu0702-droid/freshon-cache/' + ref + '/opsmap-stage/postal-v1/detail.bin');
    assert.equal(options.headers.Authorization,'Bearer fixture-only');
    assert.equal(options.headers.Range,'bytes=' + (blob.length - selected.bytes) + '-' + (blob.length - 1));
    const bytes = blob.subarray(-selected.bytes);
    return new Response(bytes,{ status:206,headers:{
      'Content-Range':'bytes ' + (blob.length - bytes.length) + '-' + (blob.length - 1) + '/' + blob.length,
      'Content-Length':bytes.length
    } });
  } });
  assert.equal((await assets.viewportTile(selected,tiles)).toString(),'detail/' + entries[1]);
  assert.equal(calls.length,1);
  assert.deepEqual(await readdir(tmp),[],'the whole pack must not get downloaded or expanded for a viewport');
});

test('unsupported and corrupted ranges fail closed and permit the original verified pack path', async t => {
  const { tmp, env, blobs } = await fixture(t);
  const bytes = Buffer.from('detail/' + names.detail[0]), blob = blobs.detail;
  const tile = { id:names.detail[0].slice(0,-3), bytes:bytes.length, sha256:sha(bytes) };
  for (const mode of ['no-range','wrong-offset','corrupt']) {
    let cancelled = false, ranges = 0, packs = 0;
    const assets = createStagePostalAssets({ env,tempRoot:tmp,log:()=>{},fetchImpl:async url=>{
      if (new URL(url).hostname === 'api.github.com') {
        packs++;
        return new Response(blob);
      }
      ranges++;
      if (mode === 'no-range') return new Response(new ReadableStream({ cancel(){ cancelled = true; } }));
      const start = blob.length - bytes.length + (mode === 'wrong-offset' ? 1 : 0);
      return new Response(Buffer.alloc(bytes.length),{ status:206,headers:{
        'Content-Range':'bytes ' + start + '-' + (blob.length - 1) + '/' + blob.length,
        'Content-Length':bytes.length
      } });
    } });
    assert.equal(await assets.viewportTile(tile,[tile]),null,mode);
    if (mode === 'no-range') assert.equal(cancelled,true,'an unexpected full response is cancelled');
    assert.equal(await assets.viewportTile(tile,[tile]),null,'backoff does not repeat a bad Range request');
    assert.equal(ranges,1);
    assert.deepEqual(await readFile(join(await assets.tiles('detail'),names.detail[0])),bytes);
    assert.equal(packs,1);
  }
});
