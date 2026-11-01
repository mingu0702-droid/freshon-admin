import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {deliverySourceObservation} from '../src/snapshotRefreshEvidence.js';import {phase2bSnapshotMeta} from '../src/phase2bOperations.js';
const code=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const body=code.slice(code.indexOf('async function fetchDeliveryTaskRowsForDate('),code.indexOf('async function buildDailyRouteFromDeliveryAdmin('));
async function observe(pages){let calls=0;const context=vm.createContext({URLSearchParams,deliverySourceObservation,deliveryTaskVehicle:r=>r.vehicle,extractDeliveryTaskRows:p=>p.data,deliveryAdminJson:async()=>pages[calls++]});vm.runInContext(body,context);const rows=await context.fetchDeliveryTaskRowsForDate('2026-11-02');return {e:rows.sourceObservation,calls};}
const row=id=>({id,enteringDatedAt:'2026-11-02T00:00:00+09:00',vehicle:'101'});
test('short source page is complete only when declared counts and distinct task identities agree',async()=>{
 const good=await observe([{data:[row(1)],totalElements:1,totalPages:1}]);assert.equal(good.e.complete,true);assert.equal(good.calls,1);const exact=await observe([{data:Array.from({length:300},(_,i)=>row(i+1)),totalElements:300,totalPages:1}]);assert.equal(exact.e.complete,true);assert.equal(exact.calls,1);
 for(const p of [{data:[row(1)],totalElements:2,totalPages:1},{data:[row(1),row(1)],totalElements:2,totalPages:1},{data:[row(1)]},{data:[{}],totalElements:1,totalPages:1}])assert.equal((await observe([p])).e.complete,false);
 const changed=await observe([{data:Array.from({length:300},(_,i)=>row(i+1)),totalElements:301,totalPages:2},{data:[row(301)],totalElements:302,totalPages:2}]);assert.equal(changed.e.complete,false);assert.equal(changed.calls,2);
});
test('a recent legacy snapshot cannot certify business freshness from generatedAt or refreshComplete alone',()=>{
 const now=Date.now(),base={generatedAt:new Date(now).toISOString(),refreshedThrough:'2026-11-02',refreshComplete:true};
 assert.equal(phase2bSnapshotMeta(base,now).stale,true);assert.equal(phase2bSnapshotMeta(base,now).sourceVerified,false);
 const verified={...base,sourceFreshness:{sourceDateVerified:true,targetDate:'2026-11-02',checkedThrough:'2026-11-02',phase:'SOURCE_DATE_OBSERVED'}};assert.equal(phase2bSnapshotMeta(verified,now).sourceVerified,true);assert.equal(phase2bSnapshotMeta(verified,now).stale,false);assert.equal(phase2bSnapshotMeta({...verified,sourceFreshness:{...verified.sourceFreshness,checkedThrough:'2026-11-01'}},now).stale,true);
 assert.equal(phase2bSnapshotMeta({...verified,sourceFreshness:{...verified.sourceFreshness,targetDate:'2026-11-01'}},now).stale,true);
});
