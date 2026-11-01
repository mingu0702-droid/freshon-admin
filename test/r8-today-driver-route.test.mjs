import test from 'node:test';
import assert from 'node:assert/strict';
import {createDatedDriverRouteReader,createDriverAssignmentReader,createDriverContactReader} from '../src/privateDriverContact.js';
import {deliverySourceObservation} from '../src/snapshotRefreshEvidence.js';
const date='2026-11-02',vehicle='115',customerCode='T900001';
const observation=deliverySourceObservation([{deliveryDate:date}],{date,complete:true,pages:1});
const route={date,vehicle,driverName:'합성기사',stops:[{vehicle,customerCode}]};
const status={date,sourceObservation:observation,vehicles:[route]};
const input={date,vehicle,customerCode,context:'DATE_ROUTE'};
function reader(value=status,readStoredRoute=()=>{throw Error('unexpected fallback');}) {return createDatedDriverRouteReader({today:()=>date,readTodayStatus:async()=>value,readStoredRoute});}
test('today uses complete Delivery evidence and never stored route; missing phone cannot borrow undated master',async()=>{
 const assignment=createDriverAssignmentReader({readStoredRoute:reader()});
 const read=createDriverContactReader({readAssignment:assignment,readDriverMaster:async()=>({generatedAt:date,vehicles:[{vehicle,driverName:route.driverName,phone:'010-0000-0000'}]})});
 assert.deepEqual((await read(input)).data,{driverName:route.driverName,phone:null});
});
test('past uses existing stored route; future fails before any source read',async()=>{
 let calls=0;const read=reader(status,async(d,v)=>{calls++;return {date:d,vehicle:v};});
 assert.deepEqual(await read('2026-11-01',vehicle),{date:'2026-11-01',vehicle});
 await assert.rejects(()=>read('2026-11-03',vehicle),e=>e.status===409);assert.equal(calls,1);
});
test('partial, wrong-date, unverified, duplicate vehicle, wrong stop vehicle and absent customer fail closed',async()=>{
 const variants=[{...status,sourceObservation:{...observation,complete:false}},{...status,sourceObservation:{...observation,requestedDate:'2026-11-01'}},{...status,sourceObservation:{...observation,dateVerified:false}},{...status,date:'2026-11-01'},{...status,vehicles:[route,route]},{...status,vehicles:[{...route,date:'2026-11-01'}]},{...status,vehicles:[{...route,stops:[{vehicle:'122',customerCode}]}]},{...status,vehicles:[{...route,stops:[{vehicle,customerCode:'T900002'}]}]}];
 for(const value of variants)await assert.rejects(()=>createDriverAssignmentReader({readStoredRoute:reader(value)})(input),e=>[404,409].includes(e.status));
});
test('Delivery upstream 401 is a source failure, not employee-session failure',async()=>{
 const read=createDatedDriverRouteReader({today:()=>date,readTodayStatus:async()=>{throw Object.assign(Error('private'),{status:401});}});
 await assert.rejects(()=>read(date,vehicle),e=>e.status===503&&e.code==='DRIVER_ASSIGNMENT_SOURCE_UNAVAILABLE');
});
test('actual per-stop replacement driver wins without borrowing another master phone',async()=>{
 const value={...status,vehicles:[{...route,stops:[{vehicle,customerCode,driverName:'대체합성기사'}]}]};
 const read=createDriverContactReader({readAssignment:createDriverAssignmentReader({readStoredRoute:reader(value)}),readDriverMaster:async()=>({generatedAt:date,vehicles:[{vehicle,driverName:route.driverName,phone:'010-0000-0000',effectiveDate:'2026-10-01'}]})});
 assert.deepEqual((await read(input)).data,{driverName:'대체합성기사',phone:null});
});
