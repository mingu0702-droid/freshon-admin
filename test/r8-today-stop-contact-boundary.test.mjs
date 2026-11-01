import test from 'node:test';
import assert from 'node:assert/strict';
import {attachDatedStopDriver,createDatedDriverRouteReader,createDriverAssignmentReader} from '../src/privateDriverContact.js';
import {deliverySourceObservation} from '../src/snapshotRefreshEvidence.js';
test('today selected stop cannot inherit summary contact; other actual stop remains available without mutating source',async()=>{
 const date='2026-11-02',vehicle='115',phone='010-0000-0000';
 const stops=[attachDatedStopDriver({vehicle,customerCode:'T900001'},{}),attachDatedStopDriver({vehicle,customerCode:'T900002'},{driverName:'대체합성기사',driverPhone:phone})];
 const route={date,vehicle,driverName:'첫합성기사',driverPhone:phone,stops};
 const status={date,vehicles:[route],sourceObservation:deliverySourceObservation([{deliveryDate:date}],{date,complete:true,pages:1})};
 const readRoute=createDatedDriverRouteReader({today:()=>date,readTodayStatus:async()=>status});
 const read=createDriverAssignmentReader({readStoredRoute:readRoute});
 const empty=await read({date,vehicle,customerCode:'T900001',context:'DATE_ROUTE'});
 assert.equal(empty.driverName,'');assert.equal(empty.driverPhone,null);
 const actual=await read({date,vehicle,customerCode:'T900002',context:'DATE_ROUTE'});
 assert.equal(actual.driverName,'대체합성기사');assert.equal(actual.driverPhone,phone);
 assert.equal(route.driverName,'첫합성기사');assert.equal(route.driverPhone,phone);assert.equal((await readRoute(date,vehicle)).stops,stops);
 const historical=createDatedDriverRouteReader({today:()=>date,readStoredRoute:async()=>route});
 assert.equal(await historical('2026-11-01',vehicle),route);
});
