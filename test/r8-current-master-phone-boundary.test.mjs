import test from 'node:test';
import assert from 'node:assert/strict';
import {attachDatedStopDriver,createDatedDriverRouteReader,createDriverAssignmentReader,createDriverContactReader} from '../src/privateDriverContact.js';
import {deliverySourceObservation} from '../src/snapshotRefreshEvidence.js';
const date='2026-11-02',vehicle='115',customerCode='T900001',name='합성기사',phone='010-0000-0000';
async function contact({generatedAt='2026-11-01T15:30:00Z',masterName=name,requestedDate=date,current=true}={}) {
 const route={date:requestedDate,vehicle,stops:[attachDatedStopDriver({vehicle,customerCode},{driverName:name})]};
 const readRoute=createDatedDriverRouteReader({today:()=>date,readTodayStatus:async()=>({date,vehicles:[route],sourceObservation:deliverySourceObservation([{deliveryDate:date}],{date,complete:true,pages:1})}),readStoredRoute:async()=>route});
 const readAssignment=createDriverAssignmentReader({readStoredRoute:current?readRoute:async()=>route});
 return createDriverContactReader({readAssignment,readDriverMaster:async()=>({generatedAt,sheetName:'SYNTHETIC',vehicles:[{vehicle,driverName:masterName,phone}]})})({date:requestedDate,vehicle,customerCode,context:'DATE_ROUTE'});
}
test('verified current Delivery and same KST-day master allow same-driver phone, including previous UTC day',async()=>{
 for(const generatedAt of ['2026-11-01T15:30:00Z','2026-11-02T03:30:00+09:00']) {
  const result=await contact({generatedAt});assert.equal(result.data.phone,phone);assert.equal(result.meta.phoneBasis,'CURRENT_DELIVERY_MATCHED_MASTER');assert.equal(result.meta.effectiveDateVerified,false);
 }
});
test('historical assignment and unverified current stored route cannot borrow current sheet phone',async()=>{
 for(const options of [{requestedDate:'2026-11-01'},{current:false},{generatedAt:'2026-11-01T14:59:59Z'}])assert.equal((await contact(options)).data.phone,null);
});
test('different current driver cannot borrow sheet phone',async()=>{assert.equal((await contact({masterName:'다른합성기사'})).data.phone,null);});
test('invalid, absent, and date-only master timestamps cannot certify a current snapshot',async()=>{
 for(const generatedAt of ['',date,'invalid','2026-11-02T99:00:00Z','2026-11-02T03:30:00'])assert.equal((await contact({generatedAt})).data.phone,null);
});
