import { cellArea, cellToBoundary, cellToLatLng, latLngToCell, UNITS } from 'h3-js';

const bucketSize = 0.125;
// A Korea R8 cell fits well inside this conservative center search margin.
// Finer cells use the same margin, then an exact ring-bounds check.
const edgeMargin = 0.03;

const isLocated = ({ lat, lng }) => Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= 33 && lat <= 39.5 && lng >= 124 && lng <= 132;

export function resolutionForZoom(zoom) {
  if (zoom >= 14) return 11;
  if (zoom >= 11.7) return 10;
  if (zoom >= 9.5) return 9;
  return 8;
}

function addToCell(cell, record) {
  cell.stores++;
  cell.visits += record.visits;
  cell.newActive += Number(record.newActive === true);
  cell.newUnknown += Number(record.newUnknown === true);
  cell.held += Number(record.held === true);
  cell.eligibleStores += Number(record.candidateEligible === true);
  cell.unknownStores += Number(record.candidateEligible !== true);
  if (record.latest && (!cell.latest || record.latest > cell.latest)) cell.latest = record.latest;
}

function buildIndex(records, resolution) {
  const cells = new Map();
  for (const record of records) {
    // Use the actual point at every resolution. A logical H3 parent can
    // differ from the cell that geographically contains this point.
    const id = latLngToCell(record.lat, record.lng, resolution);
    if (!cells.has(id)) cells.set(id, {
      id, stores: 0, visits: 0, latest: null, newActive: 0, newUnknown: 0,
      held: 0, eligibleStores: 0, unknownStores: 0
    });
    addToCell(cells.get(id), record);
  }

  const buckets = new Map();
  for (const cell of cells.values()) {
    const [lat, lng] = cellToLatLng(cell.id);
    cell.center = [lng, lat];
    const x = Math.floor(lng / bucketSize);
    const y = Math.floor(lat / bucketSize);
    if (!buckets.has(y)) buckets.set(y, new Map());
    const row = buckets.get(y);
    if (!row.has(x)) row.set(x, []);
    row.get(x).push(cell);
  }
  return { resolution, buckets };
}

function intersectsRingBounds(ring, [west, south, east, north]) {
  let left = Infinity;
  let bottom = Infinity;
  let right = -Infinity;
  let top = -Infinity;
  for (const [lng, lat] of ring) {
    left = Math.min(left, lng);
    bottom = Math.min(bottom, lat);
    right = Math.max(right, lng);
    top = Math.max(top, lat);
  }
  return left <= east && right >= west && bottom <= north && top >= south;
}

function selectCells(index, bbox) {
  const [west, south, east, north] = bbox;
  const left = Math.floor((west - edgeMargin) / bucketSize);
  const right = Math.floor((east + edgeMargin) / bucketSize);
  const bottom = Math.floor((south - edgeMargin) / bucketSize);
  const top = Math.floor((north + edgeMargin) / bucketSize);
  const features = [];
  for (const [y, row] of index.buckets) {
    if (y < bottom || y > top) continue;
    for (const [x, cells] of row) {
      if (x < left || x > right) continue;
      for (const cell of cells) {
        const [lng, lat] = cell.center;
        if (lng < west - edgeMargin || lng > east + edgeMargin ||
            lat < south - edgeMargin || lat > north + edgeMargin) continue;
        const ring = cellToBoundary(cell.id, true);
        if (!intersectsRingBounds(ring, bbox)) continue;
        features.push({
          ...cell,
          label: 'H3 ' + cell.id,
          rings: [[ring]],
          areaKm2: cellArea(cell.id, UNITS.km2)
        });
      }
    }
  }
  return features;
}

export async function createLayer(records) {
  const located = [];
  let mappedVisits = 0;
  let unmappedVisits = 0;
  for (const record of records) {
    if (isLocated(record)) {
      located.push(record);
      mappedVisits += record.visits;
    } else {
      unmappedVisits += record.visits;
    }
  }
  let index;
  return {
    unit: 'H3',
    source: { label: 'H3 공간 격자', url: 'https://h3geo.org/docs/api/indexing/', vintage: '4.x · R8–R11' },
    diagnostics: {
      mappedStores: located.length,
      unmappedStores: records.length - located.length,
      mappedVisits,
      unmappedVisits
    },
    view({ bbox, zoom }) {
      const resolution = resolutionForZoom(zoom);
      if (index?.resolution !== resolution) {
        index = undefined;
        index = buildIndex(located, resolution);
      }
      return { resolution: 'R' + resolution, features: selectCells(index, bbox) };
    }
  };
}
