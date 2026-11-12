import assert from 'node:assert/strict';
import test from 'node:test';
import '../public/opsmap/map-view-policy.js';

test('detailed map keeps all visible stores and groups only exact co-locations', () => {
  const rows = Array.from({ length: 305 }, (_, i) => ({ customerCode: `S${i}`, lat: 37.5, lng: 127 + i / 10000 }));
  rows.push({ customerCode: 'S305', lat: rows[0].lat, lng: rows[0].lng });
  rows.push({ customerCode: 'S306', lat: 38.5, lng: 128 });
  const { stableClusters, storePinLevel } = globalThis.MapViewPolicy;
  const project = row => ({ x: (row.lng - 127) * 10000 + 100, y: 100 });
  const viewport = { width: 700, height: 500 };
  const markers = stableClusters(rows, project, storePinLevel, 'S0', viewport, {
    grouping: 'locations', protectedCodes: ['S305'], maxMarkers: 120
  });
  const codes = markers.flatMap(marker => marker.memberCodes || [marker.customerCode]);
  assert.equal(markers.length, 305);
  assert.equal(codes.length, 306);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(!codes.includes('S306'));
  assert.deepEqual(markers.find(marker => marker.clusterKind === 'location').memberCodes.sort(), ['S0', 'S305']);
});

test('a line label stays on the visible part of a segment when its midpoint leaves the map', () => {
  const { lineLabelPoint } = globalThis.MapViewPolicy;
  const box = { left: 20, right: 200, top: 40, bottom: 100 };
  assert.deepEqual(lineLabelPoint({x:50,y:70},{x:550,y:70},box),{x:125,y:70});
  assert.equal(lineLabelPoint({x:50,y:120},{x:550,y:120},box),null);
});
