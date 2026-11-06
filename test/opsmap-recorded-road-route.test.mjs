import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import express from 'express';
import {REGISTERED_OSAN_CENTER} from '../src/opsmap-abc/centerSettings.js';
import {createStoreRoadBudget} from '../src/opsmap-abc/hubRoadBudget.js';
import {createRecordedRoadRouteReader} from '../src/opsmap-abc/recordedRoadRoute.js';
import {createRoadRouteService,mountRoadRouteRoutes} from '../src/opsmap-abc/roadRouteService.js';

const date='2026-11-07',vehicle='101',identity={date,vehicle};
const stop=(sequence,customerCode='R101')=>({deliveryDate:date,confirmedVehicle:'101호차',sequence,customerCode,
  customerName:'Fixture store',customerAddress:'Fixture street',driverPhone:'private',latitude:37+sequence*.001,longitude:127+sequence*.001});
const page=(rows,meta={})=>({ok:true,data:rows,meta:{limit:32,total:rows.length,returned:rows.length,nextCursor:null,...meta}});
const center=REGISTERED_OSAN_CENTER;
const reader=(payload,readVehicleCenter=async()=>'osan')=>createRecordedRoadRouteReader({callHub:async()=>payload,readVehicleCenter});

test('recorded route verifies source order, preserves repeated visits and ends at the last delivery',async()=>{
  const read=createRecordedRoadRouteReader({callHub:async(action,params,options)=>{
    assert.equal(action,'routeStops');
    assert.deepEqual(params,{...identity,limit:32});
    assert.equal(options.privateRead,true);
    assert.equal(options.useCache,false);
    return page([stop(9),stop(2),stop(6,'R102')]);
  },readVehicleCenter:async params=>{
    assert.deepEqual(params,identity);
    return 'osan';
  }});
  const result=await read(identity,center);
  assert.deepEqual(result.data.stops.map(row=>[row.order,row.customerCode]),[[2,'R101'],[6,'R102'],[9,'R101']]);
  assert.deepEqual(result.draft.origin,{id:'CENTER_osan',lat:center.lat,lng:center.lng});
  assert.deepEqual(result.draft.waypoints.map(row=>[row.order,row.lat]),[[1,37.002],[2,37.006]]);
  assert.equal(result.draft.destination.lat,37.009);
  assert.equal(result.data.stops[0].address,'Fixture street');
  assert(!JSON.stringify(result).includes('driverPhone'));
  assert.equal((await reader(page([]))(identity,center)).draft,null);
  assert.equal((await reader(page(Array.from({length:31},(_,index)=>stop(index+1))))(identity,center)).draft.waypoints.length,30);
});

test('recorded route rejects incomplete, mismatched, unordered, unlocated or oversized source rows',async()=>{
  const cases=[
    [page([stop(1)],{nextCursor:'pending'}),'ROUTE_SOURCE_UNVERIFIED'],
    [page([stop(1)],{total:2}),'ROUTE_SOURCE_UNVERIFIED'],
    [page([{...stop(1),deliveryDate:'2026-11-06'}]),'ROUTE_IDENTITY_MISMATCH'],
    [page([{...stop(1),confirmedVehicle:'102'}]),'ROUTE_IDENTITY_MISMATCH'],
    [page([stop(1),stop(1)]),'RECORDED_ORDER_REQUIRED'],
    [page([stop(null)]),'RECORDED_ORDER_REQUIRED'],
    [page([{...stop(1),latitude:null}]),'STOP_COORDINATES_MISSING'],
    [page(Array.from({length:32},(_,index)=>stop(index+1))),'WAYPOINT_LIMIT']
  ];
  for(const [payload,code] of cases)await assert.rejects(reader(payload)(identity,center),{code});
  for(const location of ['honam',null]){
    const unconfirmed=await reader(page([stop(1)]),async()=>location)(identity,center);
    assert.equal(unconfirmed.data.origin,null);
    assert.equal(unconfirmed.draft,null);
    assert.equal(unconfirmed.data.stops.length,1);
  }
  assert.equal((await reader(page([stop(1)]))(identity,{...center,verified:false})).data.origin,null);
  await assert.rejects(reader(page([]))({...identity,date:'2026-11-31'},center),{code:'INVALID_MANUAL_ROUTE'});
});

const key='synthetic-stage-rest-key',now=()=>Date.parse('2026-11-07T03:00:00Z');
const accountHash=createHash('sha256').update(key).digest('hex');
const env={OPSMAP_ROAD_ROUTE_ENABLED:'1',KAKAO_MOBILITY_REST_API_KEY:key};
const request={mode:'MANUAL_WAYPOINTS',requestId:1,origin:{id:'o',lat:37,lng:127},waypoints:[],destination:{id:'d',lat:37.1,lng:127.1}};
const ledger=()=>({manualPins:{schema:1},roadBudget:{accountHash,scope:'CUMULATIVE_APPROVED_ACCOUNT',
  policy:'FREE_ONLY',providerPaidDisabled:true,servicePermissionVerified:true,approvedApis:['directions'],approvalId:'fixture-approval',
  verifiedAt:'2026-11-07T02:59:00Z',expiresAt:'2026-11-07T03:10:00Z',limit:2,used:0,monthlyFreeRemainingAtApproval:10,
  providerDailyUsedAtApproval:{directions:0},apis:{directions:{freeRemainingAtApproval:10,used:0},waypoints:{freeRemainingAtApproval:0,used:0}}}});
function stage(initial,extra={}){
  let state=initial,writes=0,calls=0;
  const store={transaction:work=>work(structuredClone(state),async next=>{state=next;writes++;})};
  const routeEnv={...env,...extra.env};
  const budget=createStoreRoadBudget({store,env:routeEnv,accountHash,now});
  const service=createRoadRouteService({env:routeEnv,budget,requireDurableBudget:true,now,fetchImpl:async(url,options)=>{
    calls++;
    assert.equal(new URL(url).pathname,'/v1/directions');
    assert(!new URL(url).searchParams.has('waypoints'));
    assert.equal(options.headers.Authorization,'KakaoAK '+key);
    return new Response(null,{status:403});
  }});
  return {service,get writes(){return writes;},get calls(){return calls;}};
}

test('Stage diagnostics inspect a missing ledger with provider and writes closed',async()=>{
  const f=stage({},{env:{OPSMAP_ROAD_ROUTE_ENABLED:'0',KAKAO_MOBILITY_REST_API_KEY:''}});
  const status=await f.service.readiness();
  assert.deepEqual(status.blockedReasons,['FEATURE_DISABLED','KEY_MISSING','ROAD_BUDGET_UNVERIFIED']);
  assert.equal(status.budgetError,'ROAD_BUDGET_LEDGER_MISSING');
  assert.equal(status.providerConnectivity,'NOT_CHECKED');
  assert.equal(status.apis.waypoints.permission,'UNVERIFIED');
  await assert.rejects(f.service.route(request),{code:'FEATURE_DISABLED'});
  assert.equal(f.calls,0);
  assert.equal(f.writes,0);
});

test('Stage ledger authorizes only its verified API and distinguishes provider permission failure',async()=>{
  const f=stage(ledger());
  const status=await f.service.readiness();
  assert.equal(status.budgetVerified,true);
  assert.equal(status.apis.directions.canRequest,true);
  assert.equal(status.apis.directions.permission,'VERIFIED_BY_APPROVED_LEDGER');
  assert.equal(status.apis.waypoints.permission,'NOT_APPROVED');
  assert.deepEqual(status.apis.waypoints.blockedReasons,['ROAD_BUDGET_API_UNVERIFIED']);
  assert.equal(f.writes,0);
  const waypoints=Array.from({length:6},(_,i)=>({id:'w'+i,order:i+1,lat:37+(i+1)*.001,lng:127.001}));
  await assert.rejects(f.service.route({...request,waypoints}),{code:'CALL_POLICY_BLOCKED',budgetError:'ROAD_BUDGET_API_UNVERIFIED',providerApi:'waypoints'});
  assert.equal(f.calls,0);
  assert.equal(f.writes,0);
  await assert.rejects(f.service.route(request),{code:'PERMISSION_DENIED',providerHttp:403,providerApi:'directions'});
  assert.equal(f.calls,1);
  assert.equal(f.writes,1);
  const mismatched=stage(ledger(),{env:{KAKAO_MOBILITY_REST_API_KEY:'different-key'}});
  await assert.rejects(mismatched.service.route(request),{code:'CALL_POLICY_BLOCKED',budgetError:'ROAD_BUDGET_ACCOUNT_MISMATCH'});
  assert.equal(mismatched.calls,0);
  assert.equal(mismatched.writes,0);
});

test('staff recorded stops GET is read only and recorded POST requires a verified automatic origin',async t=>{
  let centerId='honam',hubReads=0;
  const read=createRecordedRoadRouteReader({
    callHub:async()=>{hubReads++;return page([stop(1)]);},
    readVehicleCenter:async()=>centerId
  });
  const app=express(),stageOrigin='https://stage.synthetic.test';
  const f=stage({},{env:{OPSMAP_ROAD_ROUTE_ENABLED:'0'}});
  const requireStaff=(q,r,next)=>q.get('x-fixture-staff')==='yes'?next():r.status(401).end();
  mountRoadRouteRoutes({app,requireStaff,jsonBody:express.json(),service:f.service,
    env:{MAP_STAFF_ORIGIN:stageOrigin},readRecordedRoute:input=>read(input,center)});
  const server=app.listen(0,'127.0.0.1');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/api/map-phase2b/private/road-route';
  const get=base+'/recorded-stops?'+new URLSearchParams(identity);
  assert.equal((await fetch(get)).status,401);
  assert.equal(hubReads,0);
  const response=await fetch(get,{headers:{'x-fixture-staff':'yes'}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  const result=await response.json();
  assert.equal(result.meta.source,'HUB_ROUTE_STOPS');
  assert.equal(result.data.origin,null);
  assert.equal(result.data.stops[0].order,1);
  const post=()=>fetch(base,{method:'POST',headers:{'x-fixture-staff':'yes','content-type':'application/json',origin:stageOrigin},body:JSON.stringify(identity)});
  assert.equal((await (await post()).json()).error,'ORIGIN_UNCONFIRMED');
  centerId='osan';
  assert.equal((await (await post()).json()).error,'FEATURE_DISABLED');
  assert.equal(f.writes,0);
  assert.equal(f.calls,0);
});
