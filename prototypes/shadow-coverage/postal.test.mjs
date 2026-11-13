import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLayer } from './postal.mjs';

const testView = { bbox: [126.9, 36.9, 128.1, 38.1], zoom: 13 };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const rectangle = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
function fixtureZone(id, bbox, center, holes = []) {
  const rings = [[rectangle(...bbox), ...holes]];
  return { id, label: '격자 ' + id, areaKm2: 1, center, bbox, rings, overview: rings, regional: rings };
}
function record(lng, lat, visits, extra = {}) {
  return { lng, lat, visits, latest: null, newActive: false, newUnknown: false, held: false,
    candidateEligible: false, ...extra };
}

test('postal classification keeps holes, shared edges, leading zeros and uncertainty', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'opsmap-postal-fixture-'));
  context.after(() => rm(directory, { recursive: true }));
  const left = fixtureZone('01001', [127, 37, 127.2, 37.2], [127.05, 37.05], [rectangle(127.08, 37.08, 127.10, 37.10)]);
  const right = fixtureZone('01002', [127.2, 37, 127.4, 37.2], [127.3, 37.1]);
  left.overview = [[rectangle(...left.bbox)]];
  const content = [left, right].map((zone) => JSON.stringify(zone)).join('\n') + '\n';
  const basename = 'postal-41.ndjson';
  await writeFile(join(directory, basename), content);
  const manifest = {
    schema: 'opsmap-postal-boundaries-v1', origin: 'VWORLD_30054', vintage: '2026-11',
    regions: [{ basename, count: 2, bytes: Buffer.byteLength(content), sha256: hash(content), sourceSha256: hash('fixture') }]
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const records = [record(127.02, 37.04, 3, { newActive: true, candidateEligible: true }),
    record(127.04, 37.08, 0, { newUnknown: true }), record(127.20, 37.10, 1),
    record(127.09, 37.09, 2), record(null, null, 9)];
  const layer = await createLayer(records, { postalBoundaryDir: directory });
  assert.equal(layer.diagnostics.state, 'READY');
  assert.equal(layer.diagnostics.mappedStores, 2);
  assert.equal(layer.diagnostics.ambiguousStores, 1);
  assert.equal(layer.diagnostics.unmappedStores, 3);
  assert.equal(layer.diagnostics.mappedVisits, 3);
  assert.equal(layer.diagnostics.unmappedVisits, 12);
  const { features } = layer.view(testView);
  assert.deepEqual(features.map((feature) => [feature.id, feature.stores, feature.visits, feature.newActive,
    feature.newUnknown, feature.eligibleStores, feature.unknownStores]), [
    ['01001', 2, 3, 1, 1, 1, 1], ['01002', 0, 0, 0, 0, 0, 0]
  ]);
  assert.deepEqual(layer.view({ ...testView, zoom: 7 }).features.map((feature) => feature.id), ['01001']);
  assert.deepEqual(layer.view({ ...testView, zoom: 10.65 }).features, [
    { ...features[0], rings: left.overview }, { ...features[1], rings: right.overview }
  ]);
  assert.equal(layer.view({ ...testView, bbox: [126, 35, 126.5, 35.5] }).features.length, 0);

  await writeFile(join(directory, basename), content.replace('"areaKm2":1', '"areaKm2":2'));
  assert.throws(() => layer.view(testView), /POSTAL_BOUNDARY_INTEGRITY/);
  assert.equal(layer.diagnostics.state, 'BOUNDARIES_INVALID');
  const changed = await createLayer(records, { postalBoundaryDir: directory });
  assert.equal(changed.diagnostics.state, 'BOUNDARIES_INVALID');
  assert.equal(changed.diagnostics.unmappedVisits, 15);
});

test('missing postal data keeps observation totals unassigned', async () => {
  const absent = await createLayer([record(127, 37, 8)], { postalBoundaryDir: join(import.meta.dirname, 'missing-boundary-fixture') });
  assert.equal(absent.diagnostics.state, 'BOUNDARIES_UNAVAILABLE');
  assert.equal(absent.diagnostics.unmappedStores, 1);
  assert.equal(absent.diagnostics.unmappedVisits, 8);
  assert.deepEqual(absent.view(testView), { resolution: '5자리', features: [] });
});
