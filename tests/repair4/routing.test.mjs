import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoadRouteService} from '../../src/roadRouteService.js';
import '../../public/manual-waypoints.js';
import '../../public/road-route-ui.js';
import '../../public/manual-road-route-ui.js';
import '../../public/navigation-ui.js';

const adapter=globalThis.KakaoDirectionsAdapter,manual=globalThis.ManualRoadRouteUi,lookup=globalThis.MapNavigationLookup;
const point=(id,lat=37.5,lng=127)=>({id,customerCode:id,customerName:'매장 '+id,lat,lng});
const body=points=>({mode:'MANUAL_WAYPOINTS',requestId:1,origin:points[0],waypoints:points.slice(1,-1).map((row,index)=>({...row,order:index+1})),destination:points.at(-1)});
const provider=(points)=>({routes:[{result_code:0,summary:{distance:(points.length-1)*100,duration:(points.length-1)*30},sections:points.slice(1).map((row,index)=>({distance:100,duration:30,roads:[{vertexes:[points[index].lng,points[index].lat,row.lng,row.lat]}]}))}]});
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const env={OPSMAP_ROAD_ROUTE_ENABLED:'1',KAKAO_REST_API_KEY:'synthetic-test-key'};
const A=point('A'),B=point('B',37.51,127.02),C=point('C',37.52,127.03);

test('two shops in one building and a center return retain four independent visits',()=>{
  const draft=globalThis.ManualWaypoints.createDraft();
  for(const row of [A,{...A,customerCode:'SHOP2',customerName:'샵앤샵'},B,A])draft.add(row);
  assert.deepEqual(draft.stops().map(row=>row.customerCode),['A','SHOP2','B','A']);
  const value=draft.validate();assert.equal(value.waypoints.length,2);
  const encoded=manual.requestBody(value,9);assert.equal(encoded.requestId,9);assert.equal(encoded.waypoints.length,2);
  assert.equal(encoded.origin.lat,encoded.destination.lat);assert.notEqual(encoded.origin.id,encoded.destination.id);
});

test('provider calculation coalesces only adjacent equal coordinates and preserves original leg numbers',()=>{
  const request=body([A,{...A,id:'SHOP2'},B,{...B,id:'SHOP4'},{...A,id:'RETURN'}]);
  const mapped=adapter.routePlan(request);assert.deepEqual(mapped.stationaryLegs,[0,2]);assert.deepEqual(mapped.providerLegs,[1,3]);
  const plan=adapter.plan(request);assert.equal(plan.query.origin,plan.query.destination);assert.equal(plan.query.waypoints,'127.02,37.51');
  const route=adapter.fromProvider(provider([A,B,A]),request);
  assert.equal(route.totalLegs,4);assert.equal(route.coveredLegs,4);assert.equal(route.distanceMeters,200);
  assert.deepEqual(route.legs.map(row=>[row.index,row.distanceMeters,row.stationary===true]),[[0,0,true],[1,100,false],[2,0,true],[3,100,false]]);
  assert.deepEqual(route.chunks[0].geometry.map(row=>row.legOffset),[1,3]);
  assert.deepEqual(globalThis.RoadRouteUi.roadSegments(route).map(row=>row.leg),[1,3]);
});

test('a route entirely inside one building is 0 km, retains visits and makes no provider call',async()=>{
  let calls=0;const service=createRoadRouteService({env:{},fetchImpl:()=>{calls++;throw Error('must not call');}});
  const request=body([A,{...A,id:'SHOP2'},{...A,id:'SHOP3'}]);
  const result=await service.route(request);assert.equal(calls,0);assert.equal(result.data.source,'stationary-stops');assert.equal(result.data.noDrivingRequired,true);assert.equal(result.data.distanceMeters,0);assert.equal(result.data.totalLegs,2);assert.deepEqual(result.data.stationaryLegs,[0,1]);assert.equal(result.meta.used,0);
  const changes=[];const controller=manual.createController({onChange:value=>changes.push(value),fetchImpl:async(_url,options)=>{const raw=JSON.parse(options.body);return response(await service.route(raw));}});
  await controller.load(request);assert.equal(changes.at(-1).state,'success');assert.equal(changes.at(-1).totalLegs,2);assert.equal(globalThis.RoadRouteUi.roadSegments(changes.at(-1)).length,0);
});

test('provider cache distinguishes different positions of stationary shops in the same driving route',async()=>{
  let calls=0;const service=createRoadRouteService({env,fetchImpl:async()=>{calls++;return response(provider([A,B]));}});
  const one=await service.route(body([A,{...A,id:'SHOP2'},B]));
  const two=await service.route(body([A,B,{...B,id:'SHOP3'}]));
  assert.equal(calls,2);assert.deepEqual(one.data.stationaryLegs,[0]);assert.deepEqual(two.data.stationaryLegs,[1]);
  const three=await service.route({...body([A,{...A,id:'SHOP2'},B]),requestId:8});assert.equal(calls,2);assert.equal(three.data.requestId,8);assert.equal(three.meta.cache,'HIT');
});

test('expanded same-building results pass the client boundary without losing a leg',async()=>{
  const request=body([A,{...A,id:'SHOP2'},B,C]);
  const changes=[];const controller=manual.createController({onChange:value=>changes.push(value),fetchImpl:async(_url,options)=>{const raw=JSON.parse(options.body);return response({ok:true,data:adapter.fromProvider(provider([A,B,C]),raw)});}});
  await controller.load(request);assert.equal(changes.at(-1).state,'success');assert.equal(changes.at(-1).totalLegs,3);assert.deepEqual(changes.at(-1).legs.map(leg=>leg.index),[0,1,2]);
});

test('a forged stationary leg for distinct locations is rejected by the client',async()=>{
  const changes=[];const controller=manual.createController({onChange:value=>changes.push(value),fetchImpl:async(_url,options)=>{
    const raw=JSON.parse(options.body),data=adapter.fromProvider(provider([A,B]),raw);data.stationaryLegs=[0];data.chunks[0].geometry=[];data.source='stationary-stops';data.noDrivingRequired=true;data.distanceMeters=0;data.durationSeconds=0;data.legs=[{index:0,distanceMeters:0,durationSeconds:0,stationary:true}];return response({ok:true,data});
  }});await controller.load(body([A,B]));assert.equal(changes.at(-1).state,'error');
});

test('a late error body from a cancelled request cannot overwrite a newer successful route',async()=>{
  const changes=[];let release,attempts=0;
  const controller=manual.createController({onChange:value=>changes.push(value),fetchImpl:async(_url,options)=>{
    attempts++;if(attempts===1)return new Response(new ReadableStream({start(stream){release=()=>{stream.enqueue(new TextEncoder().encode('{"error":"PERMISSION_DENIED"}'));stream.close();};}}),{status:403});
    const raw=JSON.parse(options.body);return response({ok:true,data:adapter.fromProvider(provider([A,B]),raw)});
  }});
  const old=controller.load(body([A,B]));await new Promise(resolve=>setTimeout(resolve,2));controller.cancel();
  await controller.load(body([A,B]));release();await old;await new Promise(resolve=>setTimeout(resolve,2));assert.equal(changes.at(-1).state,'success');assert.equal(changes.filter(value=>value.state==='error').length,0);
});

test('editing and cancellation prevent a late successful body from recreating the route',async()=>{
  const changes=[];let finish;
  const controller=manual.createController({onChange:value=>changes.push(value),fetchImpl:async(_url,options)=>{const raw=JSON.parse(options.body);return await new Promise(resolve=>finish=()=>resolve(response({ok:true,data:adapter.fromProvider(provider([A,B]),raw)})));}});
  const waiting=controller.load(body([A,B]));controller.cancel();finish();await waiting;assert.equal(changes.at(-1).state,'idle');assert.equal(changes.filter(value=>value.state==='success').length,0);
});

test('duplicate clicks while a route is pending do not issue a second provider request',async()=>{
  let finish,calls=0;const controller=manual.createController({onChange(){},fetchImpl:async(_url,options)=>{calls++;const raw=JSON.parse(options.body);return new Promise(resolve=>finish=()=>resolve(response({ok:true,data:adapter.fromProvider(provider([A,B]),raw)})));}});
  const waiting=controller.load(body([A,B]));await controller.load(body([A,B]));assert.equal(calls,1);finish();await waiting;assert.equal(controller.isLoading(),false);
});

test('same-name search is explicit and code resolution is case/space tolerant',()=>{
  const rows=[{...A,customerCode:'S123',customerName:'동탄 매장',address:'경기도 화성시 동탄로 1'},{...B,customerCode:'S456',customerName:'동탄 매장',address:'경기도 화성시 동탄로 2'}];
  assert.equal(lookup.resolve('동탄매장',rows).length,2);assert.equal(lookup.resolve(' s123 ',rows)[0].customerCode,'S123');assert.equal(lookup.search('화성시동탄로2',rows)[0].customerCode,'S456');assert.equal(lookup.resolve('동탄',rows).length,0);
});

test('distinct customer identities at the same building stay separate; conflicting one-code records cannot route',()=>{
  const rows=[{...A,customerCode:'S1',address:'주소 1'},{...A,customerCode:'S2',address:'주소 1'}];
  assert.equal(lookup.unique(rows).length,2);assert.equal(lookup.search('주소1',rows).length,2);
  const conflict=lookup.resolve('S1',[rows[0],{...rows[0],address:'주소 2'}]);assert.equal(conflict.length,1);assert.equal(lookup.located(conflict[0]),false);
});

test('the original 30-waypoint limit remains even when all visits share a location',()=>{
  assert.throws(()=>adapter.plan(body(Array.from({length:33},(_,i)=>({...A,id:'P'+i})))),error=>error.code==='WAYPOINT_LIMIT');
});

test('visit-list import preserves complete list order and separate shops at one coordinate',()=>{
  const shops=[{...A,customerCode:'S1'},{...A,customerCode:'S2'},B,C];
  const before=structuredClone(shops);assert.deepEqual(lookup.visitCodes(shops,shops),['S1','S2','B','C']);assert.deepEqual(shops,before);
});

test('visit-list import rejects missing coordinates, missing code, too many visits and unsupported duplicates without truncating',()=>{
  const many=Array.from({length:33},(_,i)=>point('P'+i,37.5+i/1000,127+i/1000));
  for(const rows of [[A],[A,{...B,lat:null}],[A,{...B,customerCode:''}],many,[A,B,B,C]]){
    const snapshot=structuredClone(rows);assert.throws(()=>lookup.visitCodes(rows,rows));assert.deepEqual(rows,snapshot);
  }
});

test('visit-list import checks current positions and permits explicit return to the first point',()=>{
  const roundtrip=[A,B,{...A}];assert.deepEqual(lookup.visitCodes(roundtrip,[A,B]),['A','B','A']);
  assert.throws(()=>lookup.visitCodes([A,B],[A,{...B,lat:B.lat+.01}]));
});

test('a geocoded temporary point gains a session-only identity without changing the source row',()=>{
  const registry=lookup.createTemporaryPlaces(),row={customerCode:'',customerName:'검색한 주소',address:'경기도 임시로 1',lat:37.4,lng:127.1,virtual:true},before=structuredClone(row);
  const one=registry.add(row),two=registry.add({...row});assert.match(one.customerCode,/^POINT_\d+$/);assert.equal(one.customerCode,two.customerCode);assert.deepEqual(row,before);assert.equal(registry.values().length,1);assert.equal(lookup.resolve(one.customerCode,registry.values())[0].address,row.address);
  registry.clear();assert.equal(registry.values().length,0);assert.equal(lookup.resolve(one.customerCode,registry.values()).length,0);
  assert.equal(registry.add({...row,lat:null}),null);assert.equal(registry.values().length,0);
});

test('deployed durable-budget requirement rejects missing and memory-only budgets before any paid request',async()=>{
  for(const budget of [null,{reserve:async()=>{}},{durable:true}]){
    let calls=0;const service=createRoadRouteService({env,budget,requireDurableBudget:true,fetchImpl:async()=>{calls++;return response(provider([A,B]));}});
    await assert.rejects(service.route(body([A,B])),error=>error.code==='PERSISTENT_BUDGET_REQUIRED'&&error.status===503);assert.equal(calls,0);assert.equal(service.configuration().durableBudgetRequired,true);
  }
});

test('durable-budget authorization is reserved before routing and its denial never calls the provider',async()=>{
  const events=[];const service=createRoadRouteService({env,requireDurableBudget:true,budget:{durable:true,reserve:async()=>events.push('reserved')},fetchImpl:async()=>{events.push('provider');return response(provider([A,B]));}});
  await service.route(body([A,B]));assert.deepEqual(events,['reserved','provider']);
  let calls=0;const denied=createRoadRouteService({env,requireDurableBudget:true,budget:{durable:true,reserve:async()=>{throw Object.assign(Error('budget'),{code:'QUOTA_EXCEEDED'});}},fetchImpl:async()=>{calls++;return response(provider([A,B]));}});
  await assert.rejects(denied.route(body([A,B])),error=>error.code==='QUOTA_EXCEEDED');assert.equal(calls,0);assert.equal(denied.configuration().used,0);
});

test('a zero-driving visit list consumes no external budget or provider request',async()=>{
  let calls=0;const service=createRoadRouteService({env,requireDurableBudget:true,budget:null,fetchImpl:async()=>{calls++;throw Error('unexpected');}});
  const result=await service.route(body([A,{...A,id:'SHOP2'}]));assert.equal(result.data.noDrivingRequired,true);assert.equal(result.meta.used,0);assert.equal(calls,0);
});

test('durable-budget refusal remains an explicit application error in the client',async()=>{
  assert.equal(await adapter.responseError(new Response('{"error":"PERSISTENT_BUDGET_REQUIRED"}',{status:503})),'PERSISTENT_BUDGET_REQUIRED');
});

test('HTTP 503 configuration refusals retain their exact code through the route controller',async()=>{
  for(const error of ['PERSISTENT_BUDGET_REQUIRED','FEATURE_DISABLED','KEY_MISSING']){
    const changes=[];const controller=manual.createController({onChange:value=>changes.push(value),fetchImpl:async()=>new Response(JSON.stringify({ok:false,error}),{status:503,headers:{'content-type':'application/json'}})});
    await controller.load(body([A,B]));assert.equal(changes.at(-1).state,'error');assert.equal(changes.at(-1).error,error);
  }
});

test('an application error with a code object is preserved in an HTTP 200 envelope',async()=>{
  const changes=[];const controller=manual.createController({onChange:value=>changes.push(value),fetchImpl:async()=>response({ok:false,error:{code:'PERSISTENT_BUDGET_REQUIRED'}})});
  await controller.load(body([A,B]));assert.equal(changes.at(-1).error,'PERSISTENT_BUDGET_REQUIRED');
});
