import test from 'node:test';import assert from 'node:assert/strict';
import {completeFixedCoordinates,continuingFixedLedger} from '../../src/fixedCoordinateCompletion.js';
import {reviseFixedCoordinateLedger,validateFixedCoordinateLedger} from '../../src/fixedStoreCoordinates.js';
import {coordinateAddressHash} from '../../src/opsmap-abc/opsmapAutoCoordinates.js';
import {emptyLedger,address,store,index,now,hash} from './fixtures.mjs';
const run=(stores,extra={})=>completeFixedCoordinates({stores,ledger:emptyLedger(),index:index([[address(10)],[address(20)]]),now,...extra});
test('new registered store obtains a durable, address-bound ledger point',()=>{
 const r=run([store()]);assert.equal(r.summary.added,1);assert.equal(r.summary.pending,0);assert.equal(r.stores[0].lat,37.15);
 const point=r.ledger.records.T990001[0].point;assert.equal(point.addressHash,coordinateAddressHash(address(10)));
 assert.equal(point.measurementKind,'BUILDING_LOCATION');assert.equal(point.evidenceSource,'OFFICIAL_ADDRESS_DATA');validateFixedCoordinateLedger(r.ledger);
});
test('different stores at the same exact building coordinate are not rejected',()=>{
 const r=run([store(),store('T990002')]);assert.equal(r.summary.added,2);assert.equal(Object.keys(r.ledger.records).length,2);
 assert.equal(r.stores[0].lat,r.stores[1].lat);assert.notEqual(r.stores[0].code,r.stores[1].code);
});
test('independently verified neighboring addresses may share a building point',()=>{
 const r=run([store(),store('T990002',20)]);assert.equal(r.summary.located,2);assert.equal(r.summary.pending,0);
});
test('subsequent run reuses the fixed ledger without a new revision or lookup',()=>{
 const first=run([store()]);let calls=0;const second=run([store()],{ledger:first.ledger,index:{resolve(){calls++;throw Error('must not run');}}});
 assert.equal(second.ledger.sha256,first.ledger.sha256);assert.equal(calls,0);
});
test('verified move appends a new address binding and keeps the old history',()=>{
 const first=run([store()]);const next=run([store('T990001',20)],{ledger:first.ledger});
 assert.equal(next.summary.rebound,1);assert.equal(next.ledger.records.T990001.length,2);
 assert.deepEqual(next.ledger.records.T990001[0],first.ledger.records.T990001[0]);
 assert.equal(next.ledger.records.T990001.at(-1).point.addressHash,coordinateAddressHash(address(20)));
});
test('a normal overwrite at an unchanged address remains forbidden',()=>{
 const first=run([store()]);const point={...first.ledger.records.T990001[0].point,lat:37.2};
 assert.throws(()=>reviseFixedCoordinateLedger(first.ledger,{expectedRevision:1,rows:[point],updatedAt:new Date(now()).toISOString()}),/LOCKED/);
});
test('replacement requires the expected prior and latest address bindings',()=>{
 const first=run([store()]);const point={...first.ledger.records.T990001[0].point,addressHash:coordinateAddressHash(address(20))};
 assert.throws(()=>reviseFixedCoordinateLedger(first.ledger,{expectedRevision:1,replacements:[{point,expectedAddressHash:'0'.repeat(64),currentAddressHash:point.addressHash}],updatedAt:new Date(now()).toISOString()}),/REBIND_CONFLICT/);
});
test('manual fixed points override automatic candidates',()=>{
 const r=run([store()],{manualRows:[{customerCode:'T990001',originalAddressHash:coordinateAddressHash(address(10)),resolutionStatus:'MANUAL_CONFIRMED',latitude:37.2,longitude:127.2,coordinateEvidence:'DIRECT_SITE_MEASUREMENT'}]});
 assert.equal(r.stores[0].lat,37.2);assert.equal(r.summary.added,0);assert.equal(r.decisions[0].status,'PRESERVED_MANUAL');
});
test('protected legacy manual store is never written',()=>{
 const r=run([store('S191541')]);assert.equal(r.ledger.revision,0);assert.equal(r.decisions[0].status,'PRESERVED_MANUAL');
});
test('no official coverage stays pending rather than generating an approximate point',()=>{
 const r=run([store('T990003',999)]);assert.equal(r.summary.pending,1);assert.equal(r.stores[0].lat,null);assert.equal(r.ledger.revision,0);
});
test('untrusted or mismatched evidence is rejected',()=>{
 const good=index([[address(10)]]).resolve(address(10));
 for(const bad of [{...good,evidenceSource:'KAKAO_EXACT_ADDRESS'},{...good,addressSha256:'0'.repeat(64)},{...good,lat:0},{...good,datasetDate:'2027-01-01'}]){
  assert.throws(()=>run([store()],{index:{resolve:()=>bad}}),/EVIDENCE/);
 }
});
test('batch limit allows safe incremental completion',()=>{
 const first=run([store(),store('T990002',20)],{maxChanges:1});assert.equal(first.summary.pending,1);
 const second=run([store(),store('T990002',20)],{ledger:first.ledger,maxChanges:1});assert.equal(second.summary.pending,0);
});
test('original addresses are not edited and safe decisions omit them',()=>{
 const row=store();const before=structuredClone(row);const r=run([row]);assert.deepEqual(row,before);assert.equal(r.stores[0].address,before.address);
 assert(!JSON.stringify(r.decisions).includes(address(10)));
});
test('customer-code duplication fails instead of silently merging stores',()=>assert.throws(()=>run([store(),store()]),/CUSTOMER_ID/));
test('inactive stores are not automatically located',()=>assert.equal(run([store('T990001',10,{registered:false})]).summary.added,0));
test('new generations preserve an unchanged older input ledger',()=>{
 const initial=emptyLedger(),first=run([store()]);assert.equal(continuingFixedLedger(first.ledger,initial).sha256,first.ledger.sha256);
 assert.equal(continuingFixedLedger(initial,first.ledger).sha256,first.ledger.sha256);
});
test('divergent ledgers do not overwrite each other',()=>{
 const a=run([store()]).ledger,b=run([store('T990002',20)]).ledger;assert.throws(()=>continuingFixedLedger(a,b),/HISTORY_FORK/);
});
test('current-address conflict is retained for review',()=>{
 const r=run([store('T990001',10,{currentAddressHash:'0'.repeat(64)})]);assert.equal(r.summary.added,0);assert.equal(r.decisions[0].status,'REVIEW_ADDRESS_BINDING');
});

test('conflicted old coordinates are not counted as verified when the current address is unresolved',()=>{
 const result=completeFixedCoordinates({stores:[store('T990011',99,{lat:37.11,lng:127.01,addressChanged:true})],ledger:emptyLedger(),index:index([[address(10)]]),now});
 assert.equal(result.summary.located,0);assert.equal(result.summary.pending,1);assert.equal(result.stores[0].lat,null);
});
test('independent exact proof resolves stale conflict flags without changing the original address',()=>{
 const row=store('T990011',10,{lat:37.11,lng:127.01,addressChanged:true,coordinateStatus:'CONFLICT',resolutionStatus:'ADDRESS_CHANGED_REVIEW_REQUIRED'});
 const result=completeFixedCoordinates({stores:[row],ledger:emptyLedger(),index:index([[address(10),37.15,127.05]]),now});
 assert.equal(result.stores[0].lat,37.15);assert.equal(result.stores[0].addressChanged,false);
 assert.equal(result.stores[0].address,row.address);assert.equal(result.summary.located,1);assert.equal(row.lat,37.11);
});
test('conflicting current source hash is never cleared using a different address text',()=>{
 const row=store('T990011',10,{lat:37.11,lng:127.01,currentAddressHash:'f'.repeat(64)});
 const result=completeFixedCoordinates({stores:[row],ledger:emptyLedger(),index:index([[address(10)]]),now});
 assert.equal(result.summary.added,0);assert.equal(result.summary.pending,1);assert.equal(result.stores[0].lat,null);
});
