import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { gzipSync, inflateRawSync } from 'node:zlib';
import express from 'express';
import { applyPostalAssignmentReview, classifyPostalZone, createScope, encodePostalTileResponse,
  POSTAL_DENSITY_HIGH } from '../src/shadowCoverage/postal.js';
import { mountPostalCoverage } from '../src/shadowCoverage/postalRoutes.js';
import { datesFor } from '../src/shadowCoverage/coverageFiles.js';
import { createPostalGeometryReader, postalWorldProjection } from '../public/opsmap/postal-coverage-map.mjs';
import { coverageCenterBounds } from '../public/opsmap/coverage-center-viewport.mjs';
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

test('a registered postal area needs the full center period before absence becomes verified', () => {
  const day='2026-11-07', days=30, dates=datesFor(day,days);
  const code='T900001', codes=new Map([[code,{area:1234,registered:true,center:0}]]);
  const areas=Buffer.alloc(POSTAL_AREA_BYTES);
  areas.writeUInt32LE(1234,0);
  areas.writeDoubleLE(1,12);
  const period={observed:{all:dates,osan:dates},unverified:{all:[],osan:[dates[0]]},
    recorded:[0,0,0,0],unplaced:[0,0,0,0],unplacedBoundary:[0,0,0,0],unavailableCodes:[[],[],[],[]],
    missing:[],unidentified:0,rows:[],states:[]};
  const release={asOf:day,periods:{30:period}};
  const state=()=>createScope(release,codes,areas,days,'osan',1).groups.get(1234).status;
  assert.equal(state(),'UNKNOWN','one unverified date can hide deliveries');
  period.unverified.osan=[];
  assert.equal(state(),'CANDIDATE');
  period.unavailableCodes[0].push(code);
  assert.equal(state(),'UNKNOWN','unplaced evidence can hide this store’s deliveries');
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

test('postal scopes retain registered non-Osan areas when only Osan has observed deliveries', () => {
  const day = '2026-11-07';
  const entries = [
    ['T900001',1234,0,127.1,37.1],
    ['T900002',1235,1,129.1,35.2],
    ['T900003',1236,2,126.9,35.1],
    ['T900004',1237,3,127.5,36.0],
  ];
  const codes = new Map(entries.map(([code,area,center]) => [code,{area,center,registered:true}]));
  const areas = Buffer.alloc(POSTAL_AREA_BYTES * entries.length);
  for (const [index,[,id,,lng,lat]] of entries.entries()) {
    areas.writeUInt32LE(id,index*POSTAL_AREA_BYTES);
    areas.writeDoubleLE(1,index*POSTAL_AREA_BYTES+12);
    const center = ['osan','yeongnam','honam','all'][index];
    const [west,south,east,north] = coverageCenterBounds(center);
    assert.ok(west < lng && lng < east && south < lat && lat < north);
  }
  const period = {
    observed:{all:[day],osan:[day],yeongnam:[],honam:[]},
    unverified:{all:[],osan:[],yeongnam:[],honam:[]},
    recorded:[2,0,0,0], unplaced:[0,0,0,0], unplacedBoundary:[0,0,0,0], missing:[],
    unavailableCodes:[[],[],[],[]], unidentified:0, rows:[['T900001',[[0,2,day,[]]]]], states:[],
  };
  const release = {asOf:day,periods:{30:period,60:period,90:period}};
  for (const days of [30,60,90]) {
    const all = createScope(release,codes,areas,days,'all',4);
    assert.deepEqual([all.summary.registered,all.summary.recorded,all.summary.scopedAreas,all.summary.unverifiedScopedAreas],
      [4,2,4,3]);
    const osan = createScope(release,codes,areas,days,'osan',4);
    assert.deepEqual([osan.summary.registered,osan.summary.recorded,osan.summary.low],[1,2,1]);
    for (const [center,id] of [['yeongnam',1235],['honam',1236]]) {
      const {groups,summary,candidates,completeness} = createScope(release,codes,areas,days,center,4);
      assert.deepEqual([summary.registered,summary.scopedAreas,summary.unverifiedScopedAreas,summary.recorded],[1,1,1,0]);
      assert.deepEqual([...groups.keys()],[id]);
      assert.equal(groups.get(id).status,'UNKNOWN');
      assert.equal(completeness.missing.length,days);
      assert.equal(candidates.length,0);
    }
  }
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
  reader.clear(true);
  assert.equal(reader.hasOverview(),true);
  assert.deepEqual(await reader.read(view,new AbortController().signal),[zones]);
  await assert.rejects(reader.read({...view,overview:'b'.repeat(64)},new AbortController().signal), /UNEXPECTED_TILE_REQUEST/);
  assert.equal(request.mock.callCount(),1);
  reader.clear();
  assert.equal(reader.hasOverview(),false);
  assert.equal(reader.metrics().bytes,0);
});

test('a new viewport frame transfers only uncached tiles within its approved boundary version', async t => {
  const boundary = 'c'.repeat(64);
  const ids = ['detail-1-1-0','detail-1-1-1'];
  const zone = { id:'01234', bbox:[127,37,127.001,37.001] };
  const tileHeader = Buffer.alloc(8);
  tileHeader.write('PCG1');
  tileHeader.writeUInt32LE(1,4);
  const tile = Buffer.concat([tileHeader,encodePostalZone(zone,[[[127,37],[127.001,37],[127,37.001]]])]);
  const makeFrame = (tiles, frameTiles, content) => {
    const metadata = Buffer.from(JSON.stringify({ boundary,tiles,frameTiles }));
    const prefix = Buffer.alloc(8);
    prefix.write('PVF1');
    prefix.writeUInt32LE(metadata.length,4);
    const packet = Buffer.concat([prefix,metadata,content]);
    return packet.buffer.slice(packet.byteOffset,packet.byteOffset + packet.length);
  };
  const reader = createPostalGeometryReader('/postal');
  const request = t.mock.method(globalThis,'fetch',async () => { throw Error('UNEXPECTED_TILE_REQUEST'); });
  const tiles = ids.map(id=>[id,tile.length]);
  const first = splitPostalBootstrap(makeFrame(tiles.slice(0,1),undefined,tile));
  assert.equal(reader.acceptBootstrap(first.view,first.bytes,0)[0][0].id,1234);
  assert.equal(reader.knownTiles(boundary),boundary + ':' + ids[0]);
  const second = splitPostalBootstrap(makeFrame(tiles,ids.slice(1),tile));
  assert.equal(reader.acceptBootstrap(second.view,second.bytes,0),null);
  assert.equal((await reader.read(second.view,new AbortController().signal)).length,2);
  const reuse = splitPostalBootstrap(makeFrame(tiles,[],Buffer.alloc(0)));
  assert.equal(reader.acceptBootstrap(reuse.view,reuse.bytes,0),null);
  assert.equal((await reader.read(reuse.view,new AbortController().signal)).length,2);
  assert.equal(request.mock.callCount(),0);
  for (const invalid of [['detail-2-3-4'],ids.toReversed(),[ids[0],ids[0]]]) {
    assert.throws(()=>splitPostalBootstrap(makeFrame(tiles,invalid,tile)),/POSTAL_BOOTSTRAP_INVALID/);
  }
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

test('overlapping postal viewports fetch and decode each immutable tile only once', async t => {
  const files = new Map(['detail-1','detail-2','detail-3'].map((id,index) => {
    const header = Buffer.alloc(8);
    header.write('PCG1');
    header.writeInt32LE(1,4);
    return [id,Buffer.concat([header,encodePostalZone({...zone,id:1234+index},[outer.slice(0,-1)])])];
  }));
  const requests = [], resolve = [];
  t.mock.method(globalThis,'fetch',async url => new Promise(done => {
    const ids = new URL(url,'http://fixture').searchParams.get('ids').split(',');
    requests.push(ids);
    resolve.push(() => done(new Response(Buffer.concat(ids.map(id => files.get(id))))));
  }));
  const reader = createPostalGeometryReader('/postal');
  const signal = new AbortController().signal;
  const view = (...ids) => ({boundary:'a'.repeat(64),tiles:ids.map(id => [id,files.get(id).length])});
  const first = reader.read(view('detail-1','detail-2'),signal);
  const second = reader.read(view('detail-3','detail-2'),signal);
  assert.deepEqual(requests,[['detail-1','detail-2'],['detail-3']]);
  resolve[1]();
  resolve[0]();
  assert.deepEqual((await first).map(zones => zones[0].id),[1234,1235]);
  assert.deepEqual((await second).map(zones => zones[0].id),[1236,1235]);
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

test('supplemental postal registration route is opt-in and session-protected', async t => {
  const app=express();
  const denied=(_req,res)=>res.sendStatus(401);
  mountPostalCoverage({app:app,postal:{},appRoot:process.cwd(),requireStaff:denied});
  const enabled=express();
  let read=0;
  mountPostalCoverage({app:enabled,postal:{readCurrentRegistration:()=>{read++;}},appRoot:process.cwd(),
    requireStaff(req,res,next){return req.get('X-Fixture-Staff')==='test'?next():res.sendStatus(401);}});
  const servers=[app,enabled].map(item=>item.listen(0,'127.0.0.1'));
  t.after(()=>servers.forEach(server=>{server.closeAllConnections();server.close();}));
  await Promise.all(servers.map(server=>once(server,'listening')));
  const url=server=>new URL('/api/map-phase2b/private/shadow-coverage/postal/current-registration',
    'http://127.0.0.1:'+server.address().port);
  assert.equal((await fetch(url(servers[0]))).status,404);
  const available=url(servers[1]);
  const staff={'X-Fixture-Staff':'test'};
  assert.equal((await fetch(available)).status,401);
  assert.equal((await fetch(available,{headers:staff})).status,400);
  available.searchParams.set('registry','a'.repeat(64));
  available.searchParams.set('generation','b'.repeat(64));
  const response=await fetch(available,{headers:staff});
  assert.equal(response.status,503);
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  assert.equal(read,0,'unconfigured geometry must fail before the supplemental asset');
});

test('dispatch density supports a bounded seven-day scope and staff-only generation-bound detail',async t=>{
  const app=express();
  const postalRegistration=()=>{};
  postalRegistration.dispatchDensityAssignments=()=>{assert.fail('Missing verified geometry must fail first');};
  mountPostalCoverage({app,appRoot:process.cwd(),postal:{readCurrentRegistration:postalRegistration,readOperations:()=>{}},
    requireStaff(req,res,next){return req.get('X-Fixture-Staff')==='test'?next():res.sendStatus(401);}});
  const http=app.listen(0,'127.0.0.1');
  t.after(()=>{http.closeAllConnections();http.close();});
  await once(http,'listening');
  const url=new URL('/api/map-phase2b/private/shadow-coverage/postal/dispatch-density','http://127.0.0.1:'+http.address().port);
  const headers={'X-Fixture-Staff':'test'};
  url.searchParams.set('days','7');
  url.searchParams.set('generation','a'.repeat(64));
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(url,{headers})).status,503);
  url.searchParams.set('area','06241');
  assert.equal((await fetch(url,{headers})).status,400);
  url.searchParams.set('registry','b'.repeat(64));
  assert.equal((await fetch(url,{headers})).status,503);
  url.searchParams.set('days','8');
  assert.equal((await fetch(url,{headers})).status,400);
});
