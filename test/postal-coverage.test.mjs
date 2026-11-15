import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPostalZone, POSTAL_DENSITY_HIGH } from '../src/shadowCoverage/postal.js';
import { decodePostalTile, encodePostalZone, exactPostalPosition, postalText, postalTilePosition, postalTilesLevel } from '../public/opsmap/postal-geometry.mjs';

const outer = [[127,37],[127.05,37],[127.05,37.05],[127,37.05],[127,37]];
const hole = [[127.01,37.01],[127.03,37.01],[127.03,37.03],[127.01,37.03],[127.01,37.01]];
const zone = { id:'01234', bbox:[127,37,127.05,37.05] };

test('density uses area and a fixed inclusive threshold, evidence separates candidate from unknown', () => {
  assert.equal(POSTAL_DENSITY_HIGH, 100);
  assert.equal(classifyPostalZone({ visits:100, registered:1, eligible:0 }, 1), 'HIGH');
  assert.equal(classifyPostalZone({ visits:100, registered:1, eligible:0 }, 2), 'LOW');
  assert.equal(classifyPostalZone({ visits:1, registered:0, eligible:0 }, 1), 'LOW');
  assert.equal(classifyPostalZone({ visits:0, registered:2, eligible:2 }, 1), 'CANDIDATE');
  assert.equal(classifyPostalZone({ visits:0, registered:2, eligible:1 }, 1), 'UNKNOWN');
  assert.equal(classifyPostalZone({ visits:0, registered:0, eligible:0 }, 1), 'UNKNOWN');
});

test('binary geometry identifies the same area with leading zero, holes and shared edges', () => {
  const header = Buffer.alloc(8);
  header.write('PCG1');
  header.writeInt32LE(1, 4);
  const buffer = Buffer.concat([header, encodePostalZone(zone, [outer.slice(0,-1), hole.slice(0,-1)])]);
  const [shape] = decodePostalTile(buffer);
  assert.equal(postalText(shape.id), '01234');
  const original = exactPostalPosition([[outer,hole]]);
  for (const [lng, lat, expected] of [[127.04,37.04,2],[127.02,37.02,0],[127.01,37.02,1],
    [127,37.01,1],[126.9,37.01,0]]) {
    assert.equal(original(lng,lat), expected);
    assert.equal(postalTilePosition(shape,lng,lat), expected);
  }
  assert.throws(() => decodePostalTile(buffer.subarray(0,-4)), /POSTAL_TILE_INVALID/);
});

test('one zoom tier is chosen for the viewport and wide fields never load exact shapes', () => {
  assert.equal(postalTilesLevel([124,32.9,132,39]), 'national');
  assert.equal(postalTilesLevel([126.7,36.9,127.4,37.5]), 'regional');
  assert.equal(postalTilesLevel([127.03,37.10,127.10,37.19]), 'detail');
});
