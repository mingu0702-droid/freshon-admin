import test from 'node:test';import assert from 'node:assert/strict';
import {createSharedInflightRead} from '../../src/sharedInflightRead.js';
import {createOperationalPhotoMetadataReader} from '../../src/opsmapOperationalPhotos.js';
import {resolvePreservedAddressBatch,searchPreservedRegistry,searchCustomerSummaries} from '../../src/privateCustomerSearch.js';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('20 concurrent readers share one upstream operation',async()=>{
 const shared=createSharedInflightRead();let calls=0;
 const values=await Promise.all(Array.from({length:20},()=>shared.read('x',async()=>{calls++;await pause(5);return 7;})));
 assert.equal(calls,1);assert(values.every(v=>v===7));assert.equal(shared.size(),0);
});
test('cancelling the first caller does not cancel another caller',async()=>{
 const shared=createSharedInflightRead(),a=new AbortController();let sourceSignal;
 const work=async signal=>{sourceSignal=signal;await pause(10);signal.throwIfAborted();return 1;};
 const first=shared.read('x',work,{signal:a.signal});const second=shared.read('x',work);
 const rejected=assert.rejects(first,{code:'READ_ABORTED'});await pause(1);a.abort();await rejected;
 assert.equal(await second,1);assert.equal(sourceSignal.aborted,false);
});
test('when all waiters cancel, the shared upstream is aborted',async()=>{
 const shared=createSharedInflightRead(),a=new AbortController(),b=new AbortController();let signal;
 const work=s=>{signal=s;return new Promise(()=>{});};
 const p=shared.read('x',work,{signal:a.signal}),q=shared.read('x',work,{signal:b.signal});
 const checked=Promise.all([assert.rejects(p),assert.rejects(q)]);await pause(1);a.abort();b.abort();await checked;
 assert.equal(signal.aborted,true);assert.equal(shared.size(),0);
});
test('timeout bounds even a source that ignores AbortSignal',async()=>{
 const shared=createSharedInflightRead({timeoutMs:5});await assert.rejects(shared.read('x',()=>new Promise(()=>{})),{code:'READ_TIMEOUT'});assert.equal(shared.size(),0);
});
test('pending-key limit rejects excess requests without dropping existing reads',async()=>{
 const shared=createSharedInflightRead({maxEntries:1,timeoutMs:10});const p=shared.read('x',()=>new Promise(()=>{}));
 await assert.rejects(shared.read('y',()=>1),{code:'READ_BUSY'});await assert.rejects(p,{code:'READ_TIMEOUT'});
});
test('no completed-result cache survives between reads',async()=>{
 const shared=createSharedInflightRead();let n=0;assert.equal(await shared.read('x',()=>++n),1);assert.equal(await shared.read('x',()=>++n),2);
});
test('photo metadata integrates cancellation isolation',async()=>{
 const a=new AbortController();let calls=0;
 const reader=createOperationalPhotoMetadataReader({customerScoped:true,readTaskRows:async(date,{signal})=>{
  calls++;await pause(10);signal.throwIfAborted();
  const rows=[{id:123,enteringDatedAt:date,customer:{erpCode:'T990001'}}];rows.sourceObservation={complete:true};return rows;
 }});
 const query={customerCode:'T990001',date:'2026-11-10'};
 const first=reader(query,{signal:a.signal}),second=reader(query);
 const fail=assert.rejects(first,{code:'PHOTO_TIMEOUT'});await pause(1);a.abort();await fail;
 assert.equal((await second)[0].deliveryId,'123');assert.equal(calls,1);
});
test('exact customer-code path does not construct the address index',()=>{
 let reads=0;const row={customerCode:'T990001',customerName:'합성',get address(){reads++;return '경기도 오산시 합성로 10';}};
 const snapshot={rows:[row],sourceGeneration:'g1'};
 for(let n=0;n<50;n++)assert.equal(searchPreservedRegistry('T990001',snapshot).data.length,1);
 assert.equal(reads,0);
});
test('same-address customers remain separately selectable',()=>{
 const rows=[1,2].map(n=>({customerCode:'T99000'+n,customerName:'합성'+n,address:'경기도 오산시 합성로 10'}));
 assert.equal(searchPreservedRegistry('경기 오산시 합성로 10',{rows}).data.length,2);
});
test('address cache invalidates when a generation changes',()=>{
 const rows=[{customerCode:'T990001',customerName:'합성',address:'경기도 오산시 합성로 10'}],snapshot={rows,sourceGeneration:'1'};
 assert.equal(searchPreservedRegistry('경기 오산시 합성로 10',snapshot).data.length,1);
 rows[0]={...rows[0],address:'경기도 오산시 합성로 20'};snapshot.sourceGeneration='2';
 assert.equal(searchPreservedRegistry('경기 오산시 합성로 10',snapshot).data.length,0);
 assert.equal(searchPreservedRegistry('경기 오산시 합성로 20',snapshot).data.length,1);
});
test('unknown address in preserved data is not certified absent from the current registry',()=>{
 const r=searchPreservedRegistry('경기 오산시 합성로 999',{rows:[]});assert.equal(r.meta.complete,false);assert.equal(r.meta.customerMatchVerified,false);
});
test('official road/lot identity can reuse a verified point but cannot revive a moved customer',()=>{
 const road='경기 오산시 합성로 10',lot='경기도 오산시 합성동 20';
 const index={lookup(query){assert.equal(query,lot);return {road,lot,kind:'MANUAL'};}};
 const row={customerCode:'T990001',address:road,lat:37.1,lng:127.1};
 assert.equal(resolvePreservedAddressBatch([[lot]],{rows:[row]},index)[0].status,'STORED');
 assert.deepEqual(resolvePreservedAddressBatch([[lot]],{rows:[{...row,addressChanged:true}]},index),[{status:'STORED_COORDINATE_UNVERIFIED'}]);
 assert.deepEqual(resolvePreservedAddressBatch([[lot]],{rows:[]},{lookup:()=>({lat:37.1,lng:127.1,coordinateKind:'PARCEL'})}),
  [{status:'OFFICIAL',point:{lat:37.1,lng:127.1,coordinateSource:'OFFICIAL_PUBLIC_PARCEL'}}]);
});
test('indexed customer search retains source metadata and does not call Hub for exact local code',async()=>{
 const snapshot={rows:[{customerCode:'T990001',customerName:'합성',lat:37.15,lng:127.05}]};
 const r=await searchCustomerSummaries({query:'T990001',snapshot,searchMaster:()=>{throw Error('must not run');}});
 assert.equal(r.data[0].customerCode,'T990001');assert.equal(r.meta.currentness,'UNCONFIRMED');
});
