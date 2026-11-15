const px = 1e6;
export const POSTAL_TILE_LIMIT = 1024 * 1024;
export const POSTAL_AREA_BYTES = 36;
export const POSTAL_LEVELS = ['national', 'regional', 'detail'];

export function postalText(id) {
  return String(id).padStart(5, '0');
}

export function postalTilesLevel(box) {
  const span = Math.max(box[2] - box[0], box[3] - box[1]);
  return span > 1.65 ? 'national' : span > .16 ? 'regional' : 'detail';
}

export function intersects(a, b) {
  return a[0] <= b[2] && a[1] <= b[3] && a[2] >= b[0] && a[3] >= b[1];
}

export function encodePostalZone(zone, rings) {
  const count = rings.reduce((sum, ring) => sum + ring.length, 0);
  const words = new Int32Array(6 + rings.length + count * 2);
  words[0] = Number(zone.id);
  words[1] = rings.length;
  words.set(zone.bbox.map(v => Math.round(v * px)), 2);
  let offset = 6;
  for (const ring of rings) {
    words[offset++] = ring.length;
    for (const [lng, lat] of ring) {
      words[offset++] = Math.round(lng * px);
      words[offset++] = Math.round(lat * px);
    }
  }
  return Buffer.from(words.buffer);
}

export function encodePostalArea(zone) {
  const row = Buffer.alloc(POSTAL_AREA_BYTES);
  row.writeUInt32LE(Number(zone.id), 0);
  row.writeInt32LE(Math.round(zone.center[1] * px), 4);
  row.writeInt32LE(Math.round(zone.center[0] * px), 8);
  row.writeDoubleLE(zone.areaKm2, 12);
  zone.bbox.forEach((value, i) => row.writeInt32LE(Math.round(value * px), 20 + i * 4));
  return row;
}

// 0 outside, 1 on an edge, 2 inside. Reject ambiguous shared-edge matches.
function ringRelation(points, from, to, x, y, epsilon) {
  let inside = false;
  let ax = points[to - 2], ay = points[to - 1];
  for (let i = from; i < to; i += 2) {
    const bx = points[i], by = points[i + 1];
    if (bx === ax && by === ay) continue;
    if (x >= Math.min(ax, bx) - epsilon && x <= Math.max(ax, bx) + epsilon &&
        y >= Math.min(ay, by) - epsilon && y <= Math.max(ay, by) + epsilon &&
        Math.abs((x - ax) * (by - ay) - (y - ay) * (bx - ax)) <= epsilon * Math.hypot(bx - ax, by - ay)) return 1;
    if ((ay > y) !== (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)) inside = !inside;
    ax = bx;
    ay = by;
  }
  return inside ? 2 : 0;
}

export function exactPostalPosition(rings) {
  const polygons = rings.map(part => part.map(ring => Float64Array.from(ring.flat())));
  return (lng, lat) => {
    let edge = false;
    for (const [outer, ...holes] of polygons) {
      const result = ringRelation(outer, 0, outer.length, lng, lat, 1e-10);
      if (result === 1) edge = true;
      if (result !== 2) continue;
      let inside = true;
      for (const hole of holes) {
        const relation = ringRelation(hole, 0, hole.length, lng, lat, 1e-10);
        if (relation === 1) edge = true;
        if (relation) { inside = false; break; }
      }
      if (inside) return 2;
    }
    return edge ? 1 : 0;
  };
}

export function decodePostalTile(buffer) {
  const source = new DataView(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength);
  const words = new Int32Array(source.buffer, source.byteOffset, source.byteLength / 4);
  if (words[0] !== 0x31474350 || words[1] < 1 || words[1] > 10000) throw Error('POSTAL_TILE_INVALID');
  const zones = [];
  let i = 2;
  for (let row = 0; row < words[1]; row++) {
    const id = words[i++], count = words[i++];
    if (id < 1000 || id > 99999 || !Number.isInteger(count) || count < 1 || count > 800) throw Error('POSTAL_TILE_INVALID');
    const box = [words[i++], words[i++], words[i++], words[i++]];
    const rings = [];
    for (let ring = 0; ring < count; ring++) {
      const size = words[i++] * 2;
      if (!Number.isInteger(size) || size < 6 || size + i > words.length) throw Error('POSTAL_TILE_INVALID');
      rings.push(words.subarray(i, i + size));
      i += size;
    }
    zones.push({ id, box, rings });
  }
  if (i !== words.length) throw Error('POSTAL_TILE_INVALID');
  return zones;
}

export function postalTilePosition(zone, lng, lat) {
  const x = lng * px, y = lat * px;
  if (!intersects(zone.box, [x, y, x, y])) return 0;
  let inside = false;
  for (const ring of zone.rings) {
    const relation = ringRelation(ring, 0, ring.length, x, y, .15);
    if (relation === 1) return 1;
    if (relation === 2) inside = !inside;
  }
  return inside ? 2 : 0;
}
