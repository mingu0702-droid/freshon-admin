import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createOfficialAdminBoundaryQuery } from '../../src/officialAdminBoundaryQuery.js';
import { pointInGeometry } from '../../public/opsmap/admin-boundaries.mjs';

const baseDirectory = new URL('../../integrations/official-boundaries/', import.meta.url);
const locationOf = role => new URL('sgis-adm-20250630-' + role + '/', baseDirectory);
const sources = {
  overview: '2193450655b521a1c0315ab1330e5910f9aa4069aad3d81ddf176afc553b188d',
  nationwide: '36e2325be7867461450314b0f3071e11f3e67dce556879b5d5846fa7649a6e2a'
};
const origin = {
  label: '국가데이터처 SGIS 센서스용 행정 읍면동',
  url: 'https://www.data.go.kr/data/15129688/fileData.do',
  vintage: '2025-06-30',
  areaBasis: '공식 경계의 75m 표시용 파생본에서 계산한 구면 면적 근사',
  membership: '원본 해상도 경계 공간결합',
  display: '넓은 범위 75m 표시본, 상세 원본 경계, 화면 서브픽셀 단순화'
};

const degree = Math.PI / 180;
const earthRadiusKm = 6371.0088;
const mib = 1024 * 1024;
const overviewZoomLimit = 9;
const overviewDegreesPerPixel = 360 / (256 * 2 ** 8.4);
const geometryLimitBytes = 12 * mib;
const coordinateScale = 1_000_000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const inKorea = ({ lat, lng }) => Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= 33 && lat <= 39.5 && lng >= 124 && lng <= 132;
const asPolygons = geometry => geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
const empty = Object.freeze({ stores: 0, eligibleStores: 0, unknownStores: 0, visits: 0, latest: null,
  newActive: 0, newUnknown: 0, held: 0 });

async function readManifest(role) {
  const directory = locationOf(role);
  const bytes = await readFile(new URL('manifest.json', directory));
  if (bytes.length > 2 * mib || digest(bytes) !== sources[role]) throw Error('ADMIN_PROTOTYPE_MANIFEST');
  const manifest = JSON.parse(bytes);
  const entries = new Map();
  for (const row of manifest.entries) {
    if (!entries.has(row.shard)) entries.set(row.shard, []);
    entries.get(row.shard).push(row);
  }
  const shards = new Map(manifest.shards.map(proof => [proof.file, proof]));
  return { directory, count: manifest.featureCount, shards, entries };
}

async function readShard(index, proof) {
  const bytes = await readFile(new URL(proof.file, index.directory));
  if (bytes.length !== proof.gzipBytes || digest(bytes) !== proof.sha256) throw Error('ADMIN_PROTOTYPE_SHARD');
  const raw = gunzipSync(bytes, { maxOutputLength: proof.jsonBytes });
  if (raw.length !== proof.jsonBytes) throw Error('ADMIN_PROTOTYPE_SHARD');
  const { features } = JSON.parse(raw);
  if (features.length !== proof.featureCount) throw Error('ADMIN_PROTOTYPE_SHARD_COUNT');
  return features;
}

async function groupByOfficialBoundary(records) {
  const seen = new Set();
  const groups = new Map();
  const points = [];
  const located = [];
  const diagnostics = { matched: 0, ambiguous: 0, unmatched: 0, unlocated: 0,
    matchedVisits: 0, ambiguousVisits: 0, unmatchedVisits: 0, unlocatedVisits: 0,
    mappedStores: 0, unmappedStores: 0 };

  for (const row of records) {
    if (seen.has(row.code) || !/^[A-Z]\d{1,20}$/.test(row.code) || !Number.isSafeInteger(row.visits) || row.visits < 0) {
      throw Error('ADMIN_PROTOTYPE_RECORD');
    }
    seen.add(row.code);
    if (!inKorea(row)) {
      diagnostics.unlocated++;
      diagnostics.unlocatedVisits += row.visits;
      if (row.registered !== false) diagnostics.unmappedStores++;
      continue;
    }
    points.push({ lat: row.lat, lng: row.lng });
    located.push(row);
  }

  const query = createOfficialAdminBoundaryQuery({ maxCacheBytes: 2 * mib });
  const { metadata, matches } = await query(points, { geometry: false });
  if (metadata.pointJoinGeometry !== 'FULL_RESOLUTION' || matches.length !== located.length) {
    throw Error('ADMIN_PROTOTYPE_JOIN_CONTRACT');
  }
  for (const { index, adminCodes } of matches) {
    const row = located[index];
    if (adminCodes.length !== 1) {
      const state = adminCodes.length ? 'ambiguous' : 'unmatched';
      diagnostics[state]++;
      diagnostics[state + 'Visits'] += row.visits;
      if (row.registered !== false) diagnostics.unmappedStores++;
      continue;
    }
    diagnostics.matched++;
    diagnostics.matchedVisits += row.visits;
    const id = adminCodes[0];
    const region = groups.get(id) || { ...empty };
    if (row.registered !== false) {
      diagnostics.mappedStores++;
      region.stores++;
      if (row.candidateEligible === true) region.eligibleStores++;
      else region.unknownStores++;
      if (row.newActive) region.newActive++;
      if (row.newUnknown) region.newUnknown++;
      if (row.held) region.held++;
    }
    region.visits += row.visits;
    if (row.visits && row.latest && (!region.latest || row.latest > region.latest)) region.latest = row.latest;
    groups.set(id, region);
  }
  return { groups, diagnostics };
}

function boundsOf(ring) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) {
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  }
  return box;
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i];
    sum += (b[0] - a[0]) * (Math.sin(a[1] * degree) + Math.sin(b[1] * degree));
  }
  return Math.abs(sum * degree * earthRadiusKm ** 2 / 2);
}

function interiorCenter(polygon) {
  const outer = polygon[0], box = boundsOf(outer);
  for (const fraction of [0.5, 0.33, 0.67, 0.2, 0.8]) {
    const y = box[1] + (box[3] - box[1]) * fraction;
    const crossings = [];
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1], b = ring[i];
        if ((a[1] > y) !== (b[1] > y)) crossings.push(a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]));
      }
    }
    crossings.sort((a, b) => a - b);
    let best = null, width = 0;
    for (let i = 1; i < crossings.length; i += 2) {
      const length = crossings[i] - crossings[i - 1];
      if (length <= width) continue;
      const center = [(crossings[i] + crossings[i - 1]) / 2, y];
      if (pointInGeometry(center, { type: 'Polygon', coordinates: polygon })) best = center, width = length;
    }
    if (best) return best;
  }
  return outer[0];
}

function areaAndCenter(feature) {
  let total = 0, largest = -Infinity, primary;
  for (const polygon of asPolygons(feature.geometry)) {
    const area = ringArea(polygon[0]) - polygon.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0);
    total += Math.max(area, 0);
    if (area > largest) largest = area, primary = polygon;
  }
  return { areaKm2: total, center: interiorCenter(primary) };
}

function segmentDistance(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const squared = dx * dx + dy * dy;
  const fraction = squared ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / squared)) : 0;
  return (point[0] - a[0] - fraction * dx) ** 2 + (point[1] - a[1] - fraction * dy) ** 2;
}

function simplifyClosed(ring, limit) {
  if (ring.length <= 5) return ring;
  let farthest = 1, distance = 0;
  for (let i = 1; i < ring.length - 1; i++) {
    const value = segmentDistance(ring[i], ring[0], ring[0]);
    if (value > distance) farthest = i, distance = value;
  }

  const marked = new Uint8Array(ring.length);
  marked[0] = marked[farthest] = marked[ring.length - 1] = 1;
  const ranges = [[0, farthest], [farthest, ring.length - 1]];
  const limitSquared = limit * limit;
  while (ranges.length) {
    const [first, last] = ranges.pop();
    let highest = limitSquared, index = 0;
    for (let i = first + 1; i < last; i++) {
      const distance = segmentDistance(ring[i], ring[first], ring[last]);
      if (distance > highest) highest = distance, index = i;
    }
    if (index === 0) continue;
    marked[index] = 1;
    ranges.push([first, index], [index, last]);
  }
  const display = ring.filter((_point, index) => marked[index]);
  // Keep valid closed geometry when a very small ring collapses at this scale.
  if (display.length >= 4) return display;
  return ring;
}

const roundedRing = (ring, tolerance) => simplifyClosed(ring, tolerance)
  .map(([x, y]) => [Math.round(x * coordinateScale) / coordinateScale, Math.round(y * coordinateScale) / coordinateScale]);

function prepareShapes(geometry, degreesPerPixel, overview, viewport) {
  const tolerance = degreesPerPixel * (overview ? 1.25 : 0.4);
  const shapes = [];
  for (const polygon of asPolygons(geometry)) {
    const extent = boundsOf(polygon[0]);
    if (viewport && !intersects(viewport, extent)) continue;
    const size = Math.max(extent[2] - extent[0], extent[3] - extent[1]);
    // Small islands share the same stable simplification; omit them when the
    // viewport also includes a larger land part of the same 읍면동.
    const rings = [polygon[0]];
    for (const hole of polygon.slice(1)) {
      const bounds = boundsOf(hole);
      if (Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) >= degreesPerPixel) rings.push(hole);
    }
    shapes.push({ extent, size, rings: rings.map(ring => roundedRing(ring, tolerance)) });
  }
  return shapes;
}

function packShapes(shapes) {
  const lengths = shapes.map(shape => shape.rings.reduce((size, ring) => size + 1 + ring.length * 2, 6));
  const paths = new Int32Array(lengths.reduce((total, length) => total + length, 0));
  let start = 0;
  for (let index = 0; index < shapes.length; index++) {
    const { extent, rings } = shapes[index];
    paths[start] = lengths[index];
    paths[start + 1] = Math.floor(extent[0] * coordinateScale);
    paths[start + 2] = Math.floor(extent[1] * coordinateScale);
    paths[start + 3] = Math.ceil(extent[2] * coordinateScale);
    paths[start + 4] = Math.ceil(extent[3] * coordinateScale);
    paths[start + 5] = rings.length;
    let cursor = start + 6;
    for (const ring of rings) {
      paths[cursor++] = ring.length;
      for (const [x, y] of ring) {
        paths[cursor++] = Math.round(x * coordinateScale);
        paths[cursor++] = Math.round(y * coordinateScale);
      }
    }
    start += lengths[index];
  }
  return paths;
}

function unpackRings(paths, start) {
  const rings = [];
  const ringCount = paths[start + 5];
  let cursor = start + 6;
  for (let index = 0; index < ringCount; index++) {
    const ring = [];
    const length = paths[cursor++];
    for (let point = 0; point < length; point++) {
      ring.push([paths[cursor++] / coordinateScale, paths[cursor++] / coordinateScale]);
    }
    rings.push(ring);
  }
  return rings;
}

function unpackVisibleRings(paths, bbox, degreesPerPixel) {
  const kept = [];
  const [west, south, east, north] = bbox.map(value => value * coordinateScale);
  const minSize = degreesPerPixel * coordinateScale;
  let fallback = -1, largest = -Infinity;
  for (let start = 0; start < paths.length; start += paths[start]) {
    const left = paths[start + 1], bottom = paths[start + 2], right = paths[start + 3], top = paths[start + 4];
    if (left > east || right < west || bottom > north || top < south) continue;
    const size = Math.max(right - left, top - bottom);
    if (size >= minSize) kept.push(unpackRings(paths, start));
    else if (size > largest) largest = size, fallback = start;
  }
  if (!kept.length && fallback >= 0) kept.push(unpackRings(paths, fallback));
  return kept;
}

function visibleRings(shapes, bbox, minSize) {
  const kept = [];
  let fallback, largest = -Infinity;
  for (const { extent, size, rings } of shapes) {
    if (!intersects(bbox, extent)) continue;
    if (size < minSize) {
      if (size > largest) largest = size, fallback = rings;
      continue;
    }
    kept.push(rings);
  }
  // Preserve small 읍면동 on the national map even when their only land part
  // spans less than one screen pixel. Suppress only additional subpixel islands.
  if (!kept.length && fallback) kept.push(fallback);
  return kept;
}

export async function createLayer(records) {
  const overview = await readManifest('overview');
  const { groups, diagnostics } = await groupByOfficialBoundary(records);
  let detail, active, tail = Promise.resolve();
  const nationalGeometry = new Map();
  let geometryBytes = 0;
  const summaries = new Map();
  const measured = feature => {
    const code = feature.properties.adm_cd;
    if (!summaries.has(code)) summaries.set(code, areaAndCenter(feature));
    return summaries.get(code);
  };
  async function nationalShard(proof) {
    const previous = nationalGeometry.get(proof.file);
    if (previous) {
      nationalGeometry.delete(proof.file);
      nationalGeometry.set(proof.file, previous);
      return previous.features;
    }
    const features = (await readShard(overview, proof)).map(row => {
      const info = measured(row);
      const shapes = prepareShapes(row.geometry, overviewDegreesPerPixel, true);
      const paths = packShapes(shapes);
      return { id: row.properties.adm_cd, label: row.properties.adm_nm, ...info, paths };
    });
    // Only the nationwide display geometry is reused. Keep the original and
    // regional shards out of the cache and release their decoded coordinates.
    const bytes = features.reduce((sum, feature) => sum + feature.paths.byteLength + 256, 0);
    if (bytes <= geometryLimitBytes) {
      while (geometryBytes + bytes > geometryLimitBytes) {
        const oldest = nationalGeometry.keys().next().value;
        geometryBytes -= nationalGeometry.get(oldest).bytes;
        nationalGeometry.delete(oldest);
      }
      geometryBytes += bytes;
      nationalGeometry.set(proof.file, { bytes, features });
    }
    return features;
  }

  async function readFeatures({ bbox, zoom, width = 1200, height = 800 }) {
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite) ||
        bbox[0] >= bbox[2] || bbox[1] >= bbox[3] || !Number.isFinite(zoom) ||
        !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw Error('ADMIN_PROTOTYPE_VIEW');
    }
    const coarse = zoom < 13;
    const national = zoom < overviewZoomLimit;
    const index = coarse ? overview : (detail ||= await readManifest('nationwide'));
    const degreesPerPixel = Math.min((bbox[2] - bbox[0]) / width, (bbox[3] - bbox[1]) / height);
    const features = [];
    let intersecting = 0;
    for (const proof of index.shards.values()) {
      const wanted = new Set(index.entries.get(proof.file).filter(row => intersects(bbox, row.bbox)).map(row => row.code));
      if (!wanted.size) continue;
      intersecting += wanted.size;
      if (national) {
        for (const { id, label, areaKm2, center, paths } of await nationalShard(proof)) {
          if (!wanted.has(id)) continue;
          const rings = unpackVisibleRings(paths, bbox, degreesPerPixel);
          if (rings.length) features.push({ id, label, areaKm2, center, rings, ...(groups.get(id) || empty) });
        }
        continue;
      }
      if (!coarse && [...wanted].some(id => !summaries.has(id))) {
        const sourceProof = overview.shards.get(proof.file);
        for (const row of await readShard(overview, sourceProof)) if (wanted.has(row.properties.adm_cd)) measured(row);
      }
      for (const row of await readShard(index, proof)) {
        const { adm_cd: id, adm_nm: label } = row.properties;
        if (!wanted.has(id)) continue;
        const shapes = prepareShapes(row.geometry, degreesPerPixel, coarse, bbox);
        const rings = visibleRings(shapes, bbox, coarse ? degreesPerPixel : 0);
        if (!rings.length) continue;
        features.push({ id, label, rings, ...measured(row), ...(groups.get(id) || empty) });
      }
    }
    return { resolution: '읍면동', features, intersecting, displayDetail: coarse ? '75m 표시본' : '원본 상세' };
  }

  return {
    unit: '읍면동',
    source: origin,
    diagnostics: { ...diagnostics, boundaryUnits: overview.count, boundaryFeatures: overview.count,
      mappedVisits: diagnostics.matchedVisits,
      unmappedVisits: diagnostics.ambiguousVisits + diagnostics.unmatchedVisits + diagnostics.unlocatedVisits },
    view(request) {
      const key = JSON.stringify(request);
      if (active?.key === key) return active.result;
      const result = tail.then(() => readFeatures(request));
      active = { key, result };
      tail = result.then(() => undefined, () => undefined).finally(() => {
        if (active?.result === result) active = undefined;
      });
      return result;
    }
  };
}
