import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPostalZone, POSTAL_DENSITY_HIGH } from '../src/shadowCoverage/postal.js';
import { createPostalGeometryReader, postalWorldProjection } from '../public/opsmap/postal-coverage-map.mjs';
import { decodePostalOverview, decodePostalTile, encodePostalZone, exactPostalPosition, postalText, postalTilePosition, postalTilesLevel } from '../public/opsmap/postal-geometry.mjs';

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

test('compact display tiles preserve zip identity, signed coordinates and exact vertex count', () => {
  const bytes = Buffer.from([80,67,79,49,1,210,9,1,3,20,19,12,0,11,20]);
  const [shape] = decodePostalOverview(bytes,3);
  assert.equal(postalText(shape.id),'01234');
  assert.deepEqual([...shape.rings[0]],[10,-10,16,-10,10,0]);
  assert.deepEqual(shape.box,[10,-10,16,0]);
  assert.throws(() => decodePostalOverview(bytes.subarray(0,-1),3), /POSTAL_OVERVIEW_TILE_INVALID/);
  assert.throws(() => decodePostalOverview(bytes,4), /POSTAL_OVERVIEW_TILE_INVALID/);
});

test('screen projection must match the Kakao plane before requesting indexed tiles', () => {
  class Coords {
    constructor(x,y) { Object.assign(this,{ x,y }); }
    toLatLng() { return this; }
    toCoords() { return this; }
    getX() { return this.x; }
    getY() { return this.y; }
  }
  const center = new Coords(500000,972532);
  const pointFromCoords = ({x,y}) => ({ x:Math.round(x / 4096) - 20, y:Math.round(-y / 4096) + 35 });
  const projection = postalWorldProjection({Coords},{pointFromCoords},center);
  assert.deepEqual(projection,{ x:500000,y:972532,sx:1/4096,sy:1/4096 });
  const distorted = ({x,y}) => ({ x:Math.round(x / 4096 + y / 512), y:Math.round(-y / 4096) });
  assert.equal(postalWorldProjection({Coords},{pointFromCoords:distorted},center),null);
  assert.equal(postalWorldProjection({},{pointFromCoords},center),null);
});

test('a superseded viewport shares immutable tiles until the map is closed', async t => {
  const header = Buffer.alloc(8);
  header.write('PCG1');
  header.writeInt32LE(1,4);
  const bytes = Buffer.concat([header, encodePostalZone(zone,[outer.slice(0,-1)])]);
  const finish = [];
  const request = t.mock.method(globalThis,'fetch',async (_url,{signal}) => new Promise((resolve,reject) => {
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    finish.push(()=>resolve(new Response(bytes)));
  }));
  const view = { boundary:'a'.repeat(64), tiles:[['national-1',bytes.length]] };
  const reader = createPostalGeometryReader('/postal');
  const superseded = new AbortController(), active = new AbortController();
  const rejected = assert.rejects(reader.read(view,superseded.signal),{name:'AbortError'});
  superseded.abort();
  const second = reader.read(view,active.signal);
  assert.equal(request.mock.callCount(),1);
  finish.shift()();
  await rejected;
  assert.equal((await second)[0][0].id,1234);
  await reader.read(view,active.signal);
  assert.equal(request.mock.callCount(),1);
  reader.clear();
  const closed = assert.rejects(reader.read(view,active.signal),{name:'AbortError'});
  reader.clear();
  await closed;
  assert.equal(reader.metrics().tiles,0);
});
