import test from 'node:test';
import assert from 'node:assert/strict';
import {createFixedVehicleCache} from '../src/fixedVehicleCache.js';
import {fixedEnvelope} from '../src/fixedVehicleStore.js';
test('volatile source pause reuses the old verified cache without new source reads or writes',async()=>{
 let reads=0,writes=0;const code='T900001';
 const old=fixedEnvelope([{customerCode:code,baseVehicle:'101',baseVehicleGroup:'osan',baseVehicleState:'VERIFIED_MASTER'}],'2026-10-01T00:00:00.000Z');
 const cache=createFixedVehicleCache({readOnly:true,reader:async()=>{reads++;throw Error('UNEXPECTED_SOURCE_READ');},store:{load:async()=>old,save:async()=>{writes++;}},now:()=>Date.parse('2026-11-02T00:00:00Z')});
 const result=await cache.get([code]);assert.equal(result.ok,true);assert.equal(result.data[0].baseVehicle,'101');assert.equal(result.meta.stale,true);assert.equal(result.meta.refresh,'READ_ONLY');
 await cache.refresh();await cache.get([code]);assert.equal(reads,0);assert.equal(writes,0);
});
