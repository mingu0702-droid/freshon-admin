import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRoadRouteService,validRoadRouteRequest} from '../src/opsmap-abc/roadRouteService.js';
const context=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../public/opsmap/navigation-ui.js',import.meta.url),'utf8'),context);
const lookup=context.MapNavigationLookup;
const row=i=>({customerCode:'SYNTHETIC_'+i,customerName:'합성 / 매장, '+i,lat:37+i*.001,lng:127+i*.001});
const rows=n=>Array.from({length:n},(_,i)=>row(i));
test('official destination and from/to links encode names and preserve latitude/longitude',()=>{
  assert.equal(lookup.kakaoDestinationLink(row(1)),'https://map.kakao.com/link/to/'+encodeURIComponent(row(1).customerName)+',37.001,127.001');
  assert.equal(lookup.kakaoDestinationLink(row(1),row(0)),'https://map.kakao.com/link/from/'+encodeURIComponent(row(0).customerName)+',37,127/to/'+encodeURIComponent(row(1).customerName)+',37.001,127.001');
});
test('five via points use one official car link in exact input order',()=>{
  const segments=lookup.kakaoRouteLinks(rows(7));assert.equal(segments.length,1);assert.equal(segments[0].start,0);assert.equal(segments[0].end,6);
  assert.deepEqual(segments[0].url.split('/car/')[1].split('/').map(s=>decodeURIComponent(s.split(',')[0])),rows(7).map(r=>r.customerName));
});
test('6 through 30 via points split with shared boundaries and no omitted or reordered legs',()=>{
  for(const size of [8,14,32]){
    const points=rows(size),segments=lookup.kakaoRouteLinks(points),legs=[];
    for(const segment of segments){const names=segment.url.split('/car/')[1].split('/').map(s=>decodeURIComponent(s.split(',')[0]));assert(names.length>=2&&names.length<=7);assert.equal(names[0],points[segment.start].customerName);assert.equal(names.at(-1),points[segment.end].customerName);for(let i=segment.start;i<segment.end;i++)legs.push(i);}
    assert.deepEqual(legs,Array.from({length:size-1},(_,i)=>i));assert.equal(segments.length,Math.ceil((size-1)/6));
  }
});
test('any missing/conflicting/unlocated point blocks the complete external route instead of skipping',()=>{
  for(const invalid of [null,{...row(4),lat:NaN},{...row(4),coordinateStatus:'CONFLICT'},{...row(4),lng:140}]){const points=rows(14);points[8]=invalid;assert.throws(()=>lookup.kakaoRouteLinks(points));}
  assert.throws(()=>lookup.kakaoRouteLinks(rows(33)));assert.throws(()=>lookup.kakaoRouteLinks(rows(1)));assert.throws(()=>lookup.kakaoDestinationLink({...row(1),coordinateStatus:'CONFLICT'}));
});
test('internal max 30 via contract remains separate and disabled routing never reaches provider',async()=>{
  const points=rows(32).map((r,i)=>({id:'p'+i,lat:r.lat,lng:r.lng})),request={mode:'MANUAL_WAYPOINTS',requestId:1,origin:points[0],destination:points.at(-1),waypoints:points.slice(1,-1).map((p,i)=>({...p,order:i+1}))};
  assert.equal(validRoadRouteRequest(request).waypoints.length,30);
  let calls=0;const service=createRoadRouteService({env:{OPSMAP_ROAD_ROUTE_ENABLED:'0'},requireDurableBudget:true,fetchImpl:async()=>{calls++;throw Error('UNEXPECTED_NETWORK');}});
  const readiness=await service.readiness();assert.equal(readiness.canRequest,false);assert(readiness.blockedReasons.includes('FEATURE_DISABLED'));assert(readiness.blockedReasons.includes('KEY_MISSING'));assert(readiness.blockedReasons.includes('PERSISTENT_BUDGET_REQUIRED'));
  await assert.rejects(service.route(request),e=>e.code==='FEATURE_DISABLED');assert.equal(calls,0);
  const production=fs.readFileSync(new URL('../src/productionOpsmapCandidate.js',import.meta.url),'utf8');assert.match(production,/OPSMAP_ROAD_ROUTE_ENABLED:'0'/);
});
