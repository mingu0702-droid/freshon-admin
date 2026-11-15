import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { gzipSync, inflateRawSync } from 'node:zlib';
import express from 'express';
import { applyPostalAssignmentReview, classifyPostalZone, createScope, encodePostalTileResponse,
  POSTAL_DENSITY_HIGH } from '../src/shadowCoverage/postal.js';
import { mountPostalCoverage } from '../src/shadowCoverage/postalRoutes.js';
import { createPostalGeometryReader, postalWorldProjection } from '../public/opsmap/postal-coverage-map.mjs';
import { decodePostalOverview, decodePostalTile, encodePostalZone, exactPostalPosition, postalText, postalTilePosition, postalTilesLevel,
  POSTAL_AREA_BYTES, splitPostalBootstrap } from '../public/opsmap/postal-geometry.mjs';

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

test('an assignment review withholds geometry without removing held visits or historical statuses', () => {
  const generation = 'a'.repeat(64), boundary = 'b'.repeat(64), releaseSha = 'c'.repeat(64);
  const [pending, neighbor, resolved] = ['Z90000000000000000001','Z90000000000000000002','Z90000000000000000003'];
  const day = '2026-11-07';
  const release = { generation,boundary,asOf:day,periods:{90:{
    observed:{ all:[day],osan:[day] }, unverified:{ all:[],osan:[] }, missing:[], unidentified:0,
    recorded:[5,0,0,0],unplaced:[0,0,0,0],unplacedBoundary:[0,0,0,0],unavailableCodes:[[],[],[],[]],
    rows:[[pending,[[0,2,day,[]]]],[resolved,[[0,3,day,[]]]]], states:[[pending,5]],
  }} };
  const codes = new Map([pending,neighbor,resolved].map((id,i) => [id,{area:i<2?1234:1235,registered:true,center:0}]));
  const review = { schema:'opsmap-postal-assignment-review-v1',generation,boundary,release:releaseSha,
    previousMismatch:[pending],unresolved:[],addressMismatch:[] };
  const effective = applyPostalAssignmentReview(review,release,releaseSha,codes);
  assert.equal(codes.get(pending).area,1234);
  assert.equal(effective.get(pending).area,null);
  assert.throws(() => applyPostalAssignmentReview({...review,unresolved:[pending]},release,releaseSha,codes),
    /POSTAL_ASSIGNMENT_REVIEW_INVALID/);
  assert.throws(() => applyPostalAssignmentReview(review,release,'d'.repeat(64),codes),/POSTAL_ASSIGNMENT_REVIEW_INVALID/);

  const areas = Buffer.alloc(POSTAL_AREA_BYTES*2);
  for (const [i,id] of [1234,1235].entries()) {
    areas.writeUInt32LE(id,i*POSTAL_AREA_BYTES);
    areas.writeDoubleLE(1,i*POSTAL_AREA_BYTES+12);
  }
  const {groups,summary,candidates} = createScope(release,effective,areas,90,'all',2);
  assert.deepEqual([summary.registered,summary.visits,summary.assignmentHeldStores,summary.assignmentHeldVisits],[3,5,1,2]);
  assert.deepEqual([summary.located,summary.unmatchedStores,summary.newActive,summary.held],[2,1,1,1]);
  assert.equal(groups.get(1234).status,'UNKNOWN');
  assert.equal(groups.get(1234).visits,0);
  assert.equal(groups.get(1235).visits,3);
  assert.equal(candidates.length,0);
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

test('a compressed postal response contains the complete frame in one gzip member', async () => {
  const prefix = Buffer.from('overview');
  const pieces = ['one', 'two'].map(piece => gzipSync(piece));
  const plain = await encodePostalTileResponse(pieces,6,false,undefined,prefix);
  assert.equal(plain.toString(),'overviewonetwo');
  for (const header of [undefined, prefix]) {
    const encoded = await encodePostalTileResponse(pieces,6,true,undefined,header);
    // A raw inflater stops at the end of the first deflate stream, as Chrome does for HTTP gzip.
    const { buffer, engine } = inflateRawSync(encoded.subarray(10), { info:true });
    assert.equal(buffer.toString(),header ? 'overviewonetwo' : 'onetwo');
    assert.equal(engine.bytesWritten + 18,encoded.length);
  }
});

test('the first viewport frame verifies the complete tile list and seeds the viewport cache', async t => {
  const tile = Buffer.from([80,67,79,49,1,210,9,1,3,20,19,12,0,11,20]);
  const view = { overview:'a'.repeat(64), tiles:[['overview-1-1-0',tile.length,3]] };
  const frame = info => {
    const json = Buffer.from(JSON.stringify(info));
    const header = Buffer.alloc(8);
    header.write('PVF1');
    header.writeUInt32LE(json.length,4);
    const result = Buffer.concat([header,json,tile]);
    return result.buffer.slice(result.byteOffset,result.byteOffset + result.length);
  };
  const packet = splitPostalBootstrap(frame(view));
  assert.deepEqual(packet.view,view);
  assert.throws(() => splitPostalBootstrap(frame({...view,tiles:[...view.tiles,...view.tiles]})),/POSTAL_BOOTSTRAP_INVALID/);
  assert.throws(() => splitPostalBootstrap(frame(view).slice(0,-1)),/POSTAL_BOOTSTRAP_INVALID/);
  const request = t.mock.method(globalThis,'fetch',async () => { throw Error('UNEXPECTED_TILE_REQUEST'); });
  const reader = createPostalGeometryReader('/postal');
  const [zones] = reader.acceptBootstrap(packet.view,packet.bytes,1.5);
  assert.equal(zones[0].id,1234);
  assert.deepEqual(await reader.read(view,new AbortController().signal),[zones]);
  assert.equal(request.mock.callCount(),0);
  assert.equal(reader.metrics().tiles,1);
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

test('postal history rejects customer identifiers in the request URL', async t => {
  const app = express();
  mountPostalCoverage({ app, postal:{}, appRoot:process.cwd(), requireStaff(req, res, next) {
    return req.get('X-Fixture-Staff') === 'test' ? next() : res.sendStatus(401);
  } });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const url = new URL('/api/map-phase2b/private/shadow-coverage/postal/history',
    'http://127.0.0.1:' + server.address().port);
  url.searchParams.set('area', '01234');
  url.searchParams.set('generation', 'a'.repeat(64));
  const staff = { 'X-Fixture-Staff':'test' };
  const code = 'Z99999999999999999999';
  const headers = { ...staff, 'X-Map-Customer-Code':code };
  assert.equal((await fetch(url, { headers:{ 'X-Map-Customer-Code':code } })).status, 401);
  assert.equal((await fetch(url, { headers:staff })).status, 400);
  const allowed = await fetch(url, { headers });
  assert.equal(allowed.status, 503);
  assert.equal(allowed.headers.get('Cache-Control'), 'private, no-store');
  assert.equal((await allowed.json()).error, 'POSTAL_DATA_UNCONFIGURED');

  url.searchParams.set('code', code);
  for (const requestHeaders of [staff, headers]) {
    const rejected = await fetch(url, { headers:requestHeaders });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { ok:false, error:'POSTAL_QUERY_INVALID' });
  }
});
