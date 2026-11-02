import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBaseTerritories,baseTerritoryAvailability} from '../public/opsmap/territory-policy.mjs';
import {boundaries} from './fixtures/admin-boundaries.mjs';
const version='a'.repeat(64),checkedAt='2026-11-02T18:28:48.039Z',now=Date.parse(checkedAt)+3600000;
const source='FIXED_DISPATCH_PRIMARY';
const row=()=>({customerCode:'S1',lat:37.1,lng:127.1,baseVehicle:'101',baseVehicleGroup:'osan',baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:source,baseVehicleStale:true,baseVehicleVersion:version,baseVehicleCheckedAt:checkedAt});
const reference=()=>({version,checkedAt,source});
const master=()=>({version,checkedAt,stale:true,refresh:'RUNNING',lastError:null});

test('default stale-current policy remains closed even for a recently verified source',()=>{
 const stores=[row()],model=buildBaseTerritories(stores,boundaries);assert.equal(model.groups.length,0);assert.equal(model.referenceMaster,null);assert.equal(baseTerritoryAvailability(stores,master(),model,{now}).reason,'MASTER_STALE');
});

test('only explicit recent verified primary reference can render without changing source currentness',()=>{
 const stores=[row()],before=structuredClone(stores),model=buildBaseTerritories(stores,boundaries,{referenceMaster:reference(),now});
 assert.equal(model.groups[0].state,'ready');assert.equal(model.groups[0].matchedCount,1);assert.equal(model.version,version);assert.equal(model.currentness,'VERIFIED_SNAPSHOT_REFRESHING');assert.deepEqual(stores,before);
 const input=master(),snapshot=structuredClone(input),availability=baseTerritoryAvailability(stores,input,model,{now});assert.equal(availability.reason,null);assert.equal(availability.currentness,'VERIFIED_SNAPSHOT_REFRESHING');assert.equal(availability.checkedAt,checkedAt);assert.equal(availability.stale,true);assert.equal(availability.refresh,'RUNNING');assert.equal(availability.vehicles[0].state,'ready');assert.deepEqual(input,snapshot);
});

test('reference age is bounded to 24h and future or malformed timestamps are rejected',()=>{
 assert.equal(buildBaseTerritories([row()],boundaries,{referenceMaster:reference(),now:Date.parse(checkedAt)+86400000}).groups.length,1);
 for(const time of [Date.parse(checkedAt)+86400001,Date.parse(checkedAt)-1,NaN])assert.equal(buildBaseTerritories([row()],boundaries,{referenceMaster:reference(),now:time}).groups.length,0);
 for(const value of ['2026-09-24T00:00:00Z','invalid','2026-11-02']){const r={...row(),baseVehicleCheckedAt:value};assert.equal(buildBaseTerritories([r],boundaries,{referenceMaster:{...reference(),checkedAt:value},now}).groups.length,0);}
});

test('unverified, non-primary, mismatched checkedAt or conflicting versions cannot become references',()=>{
 for(const edit of [r=>r.baseVehicleState='UNASSIGNED',r=>r.baseVehicleSource='DATED_VISITS',r=>r.baseVehicleVersion='b'.repeat(64),r=>r.baseVehicleVersion='bad',r=>r.baseVehicleCheckedAt='2026-11-02T18:28:49.039Z',r=>delete r.baseVehicleCheckedAt,r=>delete r.baseVehicleStale]){const r=row();edit(r);const model=buildBaseTerritories([r],boundaries,{referenceMaster:reference(),now});assert.equal(model.groups.length,0);assert.equal(model.referenceMaster,null);}
 for(const invalid of [{...reference(),source:'DATED_VISITS'},{...reference(),version:'bad'}])assert.equal(buildBaseTerritories([row()],boundaries,{referenceMaster:invalid,now}).groups.length,0);
 const model=buildBaseTerritories([row(),{...row(),customerCode:'S2',baseVehicleVersion:'b'.repeat(64)}],boundaries,{referenceMaster:reference(),now});assert.equal(model.groups.length,0);
});

test('availability revalidates age and source identity instead of trusting a cached reference model',()=>{
 const stores=[row()],model=buildBaseTerritories(stores,boundaries,{referenceMaster:reference(),now});
 assert.equal(baseTerritoryAvailability(stores,master(),model,{now:Date.parse(checkedAt)+86400001}).reason,'MASTER_STALE');
 for(const changed of [{...master(),version:'b'.repeat(64)},{...master(),checkedAt:'2026-11-02T18:28:49.039Z'}])assert.equal(baseTerritoryAvailability(stores,changed,model,{now}).reason,'MASTER_STALE');
 assert.equal(baseTerritoryAvailability([{...row(),baseVehicleState:'UNKNOWN'}],master(),model,{now}).reason,'MASTER_STALE');
});
