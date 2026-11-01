import test from 'node:test';
import assert from 'node:assert/strict';
import {attachDatedStopDriver,createDriverAssignmentReader} from '../src/privateDriverContact.js';
import {redactPublicData} from '../src/publicDataSecurity.js';
test('per-stop replacement contact remains private across assignment, JSON, spread and public redaction',async()=>{
 const date='2026-11-02',vehicle='115',customerCode='T900001',phone='010-0000-0000';
 const stop=attachDatedStopDriver({customerCode,vehicle},{driverName:' 대체합성기사 ',driverPhone:phone});
 const route={date,vehicle,driverName:'기존합성기사',sourceRouteIdentityVerified:true,stops:[stop]};
 const read=createDriverAssignmentReader({readStoredRoute:async()=>({...route})});
 const result=await read({date,vehicle,customerCode,context:'DATE_ROUTE'});
 assert.equal(result.driverName,'대체합성기사');assert.equal(result.driverPhone,phone);
 assert.equal(stop.driverPhone,phone);assert.equal(Object.getOwnPropertyDescriptor(stop,'driverPhone').enumerable,false);
 assert.equal({...stop}.driverName,'대체합성기사');assert.equal(Object.hasOwn({...stop},'driverPhone'),false);
 assert.equal(JSON.stringify(route).includes('driverPhone'),false);assert.equal(JSON.stringify(route).includes(phone),false);
 assert.equal(JSON.stringify(redactPublicData(route)).includes(phone),false);
 assert.equal(attachDatedStopDriver({}).driverName,'');assert.equal(attachDatedStopDriver({},{driverName:' ',driverPhone:'bad'}).driverPhone,null);
});
