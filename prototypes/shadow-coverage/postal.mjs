import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync, readSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const sources = {
  VWORLD_30054: {
    label: '행정안전부 국가기초구역 · 브이월드',
    url: 'https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=MK&dsId=30054',
    vintage: null
  },
  MOIS_15050416: {
    label: '행정안전부 구역의 도형 · 국가기초구역',
    url: 'https://www.data.go.kr/data/15050416/fileData.do',
    vintage: null
  },
  SEOUL_WFS: {
    label: '서울시 공개 WFS · 국가기초구역',
    url: 'https://energyinfo.seoul.go.kr/gis/wfs?service=WFS&version=2.0.0&request=GetCapabilities',
    vintage: null
  }
};
const bucketSize = 0.125;
const detailThreshold = 12.2;
const maxLineBytes = 8 * 1024 * 1024;
const sha256 = /^[a-f0-9]{64}$/;
const isBounds = (box) => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) &&
  box[0] < box[2] && box[1] < box[3];
const intersects = (a, b) => a[0] <= b[2] && a[1] <= b[3] && a[2] >= b[0] && a[3] >= b[1];
const isCoordinate = (point) => Array.isArray(point) && point.length === 2 &&
  Number.isFinite(point[0]) && Number.isFinite(point[1]) &&
  point[0] >= 123 && point[0] <= 133 && point[1] >= 32 && point[1] <= 40;
const includesPoint = (b, x, y) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

function assert(valid) {
  if (!valid) throw new Error('POSTAL_BOUNDARY_INTEGRITY');
}

function validRings(polygon) {
  return Array.isArray(polygon) && polygon.length > 0 && polygon.every((part) =>
    Array.isArray(part) && part.length > 0 && part.every((ring) => {
      if (!Array.isArray(ring) || ring.length < 4 || !ring.every(isCoordinate)) return false;
      const first = ring[0];
      const last = ring.at(-1);
      return first[0] === last[0] && first[1] === last[1];
    }));
}

// 0 outside, 1 boundary, 2 interior. Do not resolve shared edges arbitrarily.
function ringRelation(ring, x, y) {
  let inside = false;
  let [ax, ay] = ring[0];
  for (let i = 1; i < ring.length; i++) {
    const [bx, by] = ring[i];
    const tolerance = 1e-10;
    if (x >= Math.min(ax, bx) - tolerance && x <= Math.max(ax, bx) + tolerance &&
        y >= Math.min(ay, by) - tolerance && y <= Math.max(ay, by) + tolerance &&
        Math.abs((x - ax) * (by - ay) - (y - ay) * (bx - ax)) <=
          tolerance * Math.hypot(bx - ax, by - ay)) return 1;
    if ((ay > y) !== (by > y) && x < ax + ((bx - ax) * (y - ay)) / (by - ay)) inside = !inside;
    ax = bx;
    ay = by;
  }
  return inside ? 2 : 0;
}

function polygonRelation(rings, x, y) {
  let touches = false;
  for (const [outer, ...holes] of rings) {
    const relation = ringRelation(outer, x, y);
    if (relation === 1) touches = true;
    if (relation !== 2) continue;
    let holeRelation = 0;
    for (const hole of holes) {
      holeRelation = ringRelation(hole, x, y);
      if (holeRelation) break;
    }
    if (holeRelation === 0) return 2;
    if (holeRelation === 1) touches = true;
  }
  return touches ? 1 : 0;
}

function visitBuckets(buckets, box, visit) {
  const [west, south, east, north] = box.map((coordinate) => Math.floor(coordinate / bucketSize));
  for (let y = south; y <= north; y++) {
    for (let x = west; x <= east; x++) {
      const bucket = buckets.get(`${x},${y}`);
      if (bucket) for (const value of bucket) visit(value);
    }
  }
}

function indexRecords(records) {
  const buckets = new Map();
  for (let index = 0; index < records.length; index++) {
    const { lng, lat } = records[index];
    if (!isCoordinate([lng, lat])) continue;
    const key = `${Math.floor(lng / bucketSize)},${Math.floor(lat / bucketSize)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(index);
  }
  return buckets;
}

async function readRegion(path, file, visit) {
  const metadata = await stat(path);
  assert(metadata.isFile() && metadata.size === file.bytes);
  const digest = createHash('sha256');
  let offset = 0;
  let count = 0;
  let pending = '';
  for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 })) {
    digest.update(chunk);
    pending += chunk;
    let start = 0;
    let end;
    while ((end = pending.indexOf('\n', start)) !== -1) {
      const line = pending.slice(start, end);
      const length = Buffer.byteLength(line);
      assert(length > 0 && length <= maxLineBytes);
      const lineSha256 = createHash('sha256').update(line).digest('hex');
      visit(JSON.parse(line), { path, offset, length, lineSha256 });
      offset += length + 1;
      count++;
      start = end + 1;
    }
    pending = pending.slice(start);
    assert(pending.length <= maxLineBytes);
  }
  assert(!pending && count === file.count && offset === file.bytes && digest.digest('hex') === file.sha256);
}

function readGeometry(feature, fd, zoom) {
  const buffer = Buffer.allocUnsafe(feature.length);
  let bytesRead = 0;
  while (bytesRead < feature.length) {
    const amount = readSync(fd, buffer, bytesRead, feature.length - bytesRead, feature.offset + bytesRead);
    assert(amount > 0);
    bytesRead += amount;
  }
  assert(createHash('sha256').update(buffer).digest('hex') === feature.lineSha256);
  const geometry = JSON.parse(buffer.toString('utf8'));
  const rings = zoom < 14 ? geometry.regional : geometry.rings;
  return { ...feature.stats, rings };
}

function deliveryCounts(records) {
  return records.reduce((count, record) => count + record.visits, 0);
}

function unavailable(records, state, message) {
  return {
    unit: '우편번호', source: sources.VWORLD_30054,
    diagnostics: {
      state, message, mappedStores: 0, unmappedStores: records.length,
      mappedVisits: 0, unmappedVisits: deliveryCounts(records), boundaryFeatures: 0
    },
    view: () => ({ resolution: '5자리', features: [] })
  };
}

async function loadBoundaries(records, directory) {
  const manifestPath = join(directory, 'manifest.json');
  assert((await stat(manifestPath)).size <= 32 * 1024);
  const { schema, origin, vintage, latestSourceChange, retrievedAt, attributesSha256, regions } = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(schema === 'opsmap-postal-boundaries-v1' && Object.hasOwn(sources, origin));
  if (origin === 'SEOUL_WFS') {
    assert(vintage === null && /^\d{4}-\d{2}-\d{2}$/.test(latestSourceChange) &&
      Number.isFinite(Date.parse(retrievedAt)) && sha256.test(attributesSha256));
  } else {
    assert(/^\d{4}-(0[1-9]|1[0-2])$/.test(vintage));
  }
  assert(Array.isArray(regions) && regions.length > 0 && regions.length <= 17);
  const buckets = indexRecords(records);
  const matches = Array.from({ length: records.length }, () => ({ zones: [], relation: 0 }));
  const features = new Map();
  const regionFiles = new Set();
  for (const file of regions) {
    assert(/^postal-[0-9]{2}\.ndjson$/.test(file.basename) && !regionFiles.has(file.basename) &&
      sha256.test(file.sha256) && sha256.test(file.sourceSha256) && Number.isSafeInteger(file.count) &&
      file.count > 0 && Number.isSafeInteger(file.bytes) && file.bytes <= 512 * 1024 * 1024);
    regionFiles.add(file.basename);
    await readRegion(join(directory, file.basename), file, (zone, location) => {
      assert(typeof zone.id === 'string' && /^\d{5}$/.test(zone.id) && !features.has(zone.id) &&
        typeof zone.label === 'string' && zone.label.length > 0 && zone.label.length <= 120 &&
        Number.isFinite(zone.areaKm2) && zone.areaKm2 > 0 && isBounds(zone.bbox) &&
        isCoordinate(zone.bbox.slice(0, 2)) && isCoordinate(zone.bbox.slice(2)) &&
        isCoordinate(zone.center) && includesPoint(zone.bbox, ...zone.center) &&
        validRings(zone.rings) && validRings(zone.overview) && validRings(zone.regional));
      const stats = {
        id: zone.id, label: zone.label, areaKm2: zone.areaKm2, center: zone.center,
        stores: 0, visits: 0, latest: null, newActive: 0, newUnknown: 0, held: 0,
        eligibleStores: 0, unknownStores: 0
      };
      // Keep only the verified coarse geometry in memory. Regional views can
      // draw every visible zone without rereading and decoding the raw rings.
      const feature = { ...location, bbox: zone.bbox, stats, overview: JSON.stringify(zone.overview) };
      features.set(zone.id, feature);
      visitBuckets(buckets, zone.bbox, (index) => {
        const { lng, lat } = records[index];
        if (!includesPoint(zone.bbox, lng, lat)) return;
        const relation = polygonRelation(zone.rings, lng, lat);
        if (!relation || relation < matches[index].relation) return;
        if (relation > matches[index].relation) matches[index] = { zones: [feature], relation };
        else matches[index].zones.push(feature);
      });
    });
  }
  let mappedStores = 0;
  let mappedVisits = 0;
  let ambiguousStores = 0;
  for (let index = 0; index < records.length; index++) {
    const { zones } = matches[index];
    if (zones.length !== 1) {
      ambiguousStores += Number(zones.length > 1);
      continue;
    }
    const record = records[index];
    const { stats } = zones[0];
    mappedStores++;
    mappedVisits += record.visits;
    stats.stores++;
    stats.visits += record.visits;
    stats.newActive += Number(record.newActive === true);
    stats.newUnknown += Number(record.newUnknown === true);
    stats.held += Number(record.held === true);
    stats.eligibleStores += Number(record.candidateEligible === true);
    stats.unknownStores += Number(record.candidateEligible !== true);
    if (record.latest && (!stats.latest || record.latest > stats.latest)) stats.latest = record.latest;
  }
  const extent = [...features.values()];
  const expectedRegions = new Set(['11', '26', '27', '28', '30', '31', '36', '41', '43', '44', '47', '48', '50']);
  const hasRegion = (region) => regionFiles.has(`postal-${region}.ndjson`);
  const nationwide = [...expectedRegions].every(hasRegion) && (hasRegion('42') || hasRegion('51')) &&
    (hasRegion('45') || hasRegion('52')) && (hasRegion('46') && hasRegion('29') || hasRegion('53'));
  const repairedBoundaries = regions.reduce((sum, file) => sum + (file.repaired || 0), 0);
  const publicationVintage = origin === 'SEOUL_WFS' ? `배포 기준일 미공개 · 원천 최신 변경일 ${latestSourceChange}` : vintage;
  const diagnostics = {
    state: 'READY', message: nationwide ? null : '일부 시도 국가기초구역만 연결됐습니다.',
    nationwide, regions: regions.length, boundaryFeatures: features.size, ambiguousStores, repairedBoundaries,
    latestSourceChange, retrievedAt,
    mappedStores, unmappedStores: records.length - mappedStores,
    mappedVisits, unmappedVisits: deliveryCounts(records) - mappedVisits
  };
  return {
    unit: '우편번호', source: { ...sources[origin], vintage: publicationVintage }, diagnostics,
    view({ bbox, zoom }) {
      if (diagnostics.state === 'BOUNDARIES_INVALID') throw new Error('POSTAL_BOUNDARY_INTEGRITY');
      if (!isBounds(bbox) || !Number.isFinite(zoom)) return { resolution: '5자리', features: [] };
      const descriptors = new Map();
      try {
        const selected = [];
        for (const feature of extent) {
          if (!intersects(feature.bbox, bbox)) continue;
          if (zoom < 10 && !feature.stats.stores) continue;
          if (zoom < detailThreshold) {
            selected.push({ ...feature.stats, rings: JSON.parse(feature.overview) });
          } else {
            if (!descriptors.has(feature.path)) descriptors.set(feature.path, openSync(feature.path, 'r'));
            selected.push(readGeometry(feature, descriptors.get(feature.path), zoom));
          }
        }
        return { resolution: '5자리', features: selected };
      } catch {
        diagnostics.state = 'BOUNDARIES_INVALID';
        diagnostics.message = '조회 중 국가기초구역 도형 파일 검증에 실패했습니다.';
        throw new Error('POSTAL_BOUNDARY_INTEGRITY');
      } finally {
        for (const descriptor of descriptors.values()) closeSync(descriptor);
      }
    }
  };
}

export async function createLayer(records, options = {}) {
  const directory = options.postalBoundaryDir || process.env.OPSMAP_POSTAL_BOUNDARIES;
  if (!directory) return unavailable(records, 'BOUNDARIES_UNAVAILABLE', '공식 국가기초구역 도형 파일이 연결되지 않았습니다.');
  try {
    return await loadBoundaries(records, directory);
  } catch (error) {
    if (error.code === 'ENOENT') return unavailable(records, 'BOUNDARIES_UNAVAILABLE', '공식 국가기초구역 도형 파일을 찾을 수 없습니다.');
    return unavailable(records, 'BOUNDARIES_INVALID', '국가기초구역 도형 파일 검증에 실패했습니다.');
  }
}
