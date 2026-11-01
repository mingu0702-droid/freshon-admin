import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceTaskDate,deliverySourceObservation,assertDeliverySourceObservation,deliverySourceReadState,snapshotRefreshEvidence} from '../src/snapshotRefreshEvidence.js';
const date='2026-11-02';
const observe=(rows,options={})=>deliverySourceObservation(rows,{date,pages:1,complete:true,resolveVehicle:()=> '101',...options});

test('D+1 uses the source timestamp in Korea and rejects an impossible calendar date',()=>{
 assert.equal(sourceTaskDate('2026-11-01T15:00:00Z'),date);
 assert.equal(sourceTaskDate('2026-11-02T00:01:00+09:00'),date);
 assert.equal(sourceTaskDate('2026-11-02T23:30:00-05:00'),'2026-11-03');
 assert.equal(sourceTaskDate('2026-02-30T00:00:00+09:00'),null);
 assert.equal(sourceTaskDate('2026-11-02T00:00:00'),null);
});
test('conflicting source delivery dates cannot be relabelled as the requested day',()=>{
 const observed=observe([{enteringDatedAt:date,deliveryDate:'2026-11-01'}]);
 assert.equal(observed.conflictingDateRows,1);assert.equal(observed.dateVerified,false);
 assert.throws(()=>assertDeliverySourceObservation(observed,date),{code:'DELIVERY_SOURCE_DATE_MISMATCH'});
 assert.equal(deliverySourceReadState(observed,{date}),'SOURCE_DATE_MISMATCH');
});
test('mixed old rows and rows without a source date fail closed independently',()=>{
 assert.throws(()=>assertDeliverySourceObservation(observe([{enteringDatedAt:date},{enteringDatedAt:'2026-10-31'}]),date),{code:'DELIVERY_SOURCE_DATE_MISMATCH'});
 assert.throws(()=>assertDeliverySourceObservation(observe([{id:'SYNTHETIC'}]),date),{code:'DELIVERY_SOURCE_DATE_UNVERIFIED'});
});
test('partial pagination and a zero-request claim cannot certify source completion',()=>{
 assert.throws(()=>assertDeliverySourceObservation(observe([{deliveryDate:date}],{complete:false}),date),{code:'DELIVERY_SOURCE_INCOMPLETE'});
 assert.throws(()=>assertDeliverySourceObservation(observe([],{pages:0}),date),{code:'DELIVERY_SOURCE_OBSERVATION_CONTRACT'});
 assert.throws(()=>assertDeliverySourceObservation({...observe([{deliveryDate:date}]),matchingDateRows:0},date),{code:'DELIVERY_SOURCE_OBSERVATION_CONTRACT'});
});
test('no dispatch is a current-read result even when the historical cursor is unknown',()=>{
 const e=observe([]),result=snapshotRefreshEvidence({targetDate:date,previousThrough:null,todayStatus:{date,sourceObservation:e}});
 assert.equal(result.sourceFreshness.phase,'CHECKPOINT_UNVERIFIED');
 assert.equal(result.sourceFreshness.sourceReadState,'NO_DISPATCH_OBSERVED');
 assert.equal(result.refreshComplete,false);assert.equal(result.sourceFreshness.automaticSyncVerified,false);
});
test('source failure is distinct from an empty successful read without mutating the cursor',()=>{
 const result=snapshotRefreshEvidence({targetDate:date,previousThrough:null,sourceFailed:true});
 assert.equal(result.sourceFreshness.sourceReadState,'SOURCE_FAILED');assert.equal(result.refreshedThrough,null);
});
test('actual dated rows do not certify collection, publication or automatic synchronization',()=>{
 const result=snapshotRefreshEvidence({targetDate:date,previousThrough:date,todayStatus:{date,sourceObservation:observe([{deliveryDate:date}])}});
 assert.equal(result.sourceFreshness.sourceReadState,'SOURCE_DATE_OBSERVED');
 assert.equal(result.sourceFreshness.sourceDateVerified,true);
 assert.equal(result.sourceFreshness.collectionVerified,false);assert.equal(result.sourceFreshness.publicationVerified,false);assert.equal(result.sourceFreshness.automaticSyncVerified,false);
});
test('explicit partial display can retain only date-verified nonempty rows without completion claims',()=>{
 const partial=observe([{deliveryDate:date}],{complete:false});
 assert.equal(assertDeliverySourceObservation(partial,date,{requireComplete:false}),partial);
 assert.equal(deliverySourceReadState(partial,{date}),'SOURCE_INCOMPLETE');
 assert.throws(()=>assertDeliverySourceObservation(observe([],{complete:false}),date,{requireComplete:false}),{code:'DELIVERY_SOURCE_INCOMPLETE'});
 assert.throws(()=>assertDeliverySourceObservation(observe([{deliveryDate:'2026-10-31'}],{complete:false}),date,{requireComplete:false}),{code:'DELIVERY_SOURCE_DATE_MISMATCH'});
});
test('safe date observations contain only bounded primary and distinct secondary calendar counts',()=>{
 const rows=Array.from({length:12},(_,i)=>({enteringDatedAt:`2026-11-${String(i+1).padStart(2,'0')}`,deliveryDate:'2026-11-02',carrier:{enteringDatedAt:'2026-11-02'},customerCode:'PRIVATE_CUSTOMER',password:'PRIVATE_PASSWORD'}));
 rows.push({enteringDatedAt:'invalid',deliveryDate:date},{deliveryDate:'2026-11-01T15:00:00Z'},{enteringDatedAt:'invalid',deliveryDate:'PRIVATE_RAW_DATE'});
 const e=observe(rows);
 assert.equal(e.dateCountBasis,'PRIMARY_FIRST_NON_NULLISH_SECONDARY_DISTINCT_DATES_PER_ROW');
 assert.deepEqual(e.dateFieldPrecedence,['enteringDatedAt','deliveryDate','carrier.enteringDatedAt']);
 assert.equal(e.observedDateCounts.length,10);assert.equal(e.observedDateCountsTruncated,true);
 assert.deepEqual(e.observedDateCounts.find(x=>x.date===date),{date,rows:2});
 assert.deepEqual(e.secondaryDateCounts,[{date,rows:13}]);assert.equal(e.secondaryDateCountsTruncated,false);
 assert.equal(e.unverifiedDateRows,2);assert.equal(e.conflictingDateRows,11);assert.equal(e.dateVerified,false);
 assert.equal(JSON.stringify(e).includes('PRIVATE_'),false);
 const secondary=observe(Array.from({length:12},(_,i)=>({enteringDatedAt:date,deliveryDate:`2026-10-${String(i+1).padStart(2,'0')}`})));
 assert.equal(secondary.secondaryDateCounts.length,10);assert.equal(secondary.secondaryDateCountsTruncated,true);
 assert.deepEqual(secondary.observedDateCounts,[{date,rows:12}]);
});
