import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {coordinateAddressHash,prepareApprovedCoordinateSearch} from '../src/opsmap-abc/opsmapAutoCoordinates.js';

const approved=[
 ['S990001','합성시 합성구 합성대로 123번길 1234, 1층','합성시 합성구 합성대로123번길 12-34','BUILDING'],
 ['S990002','합성시 합성동 700 (합성동)','합성시 합성대로123번길 24','BUILDING'],
 ['S990003','합성시 합성구 합성중앙로','합성시 합성구 합성중앙로 18','CAMPUS']
];
const rules=Object.fromEntries(approved.map(([customerCode,originalAddress,query,accuracy])=>[customerCode,{originalAddressHash:coordinateAddressHash(originalAddress),query,accuracy}]));
test('only injected customer and original-address bindings prepare a search correction',()=>{
 for(const [customerCode,originalAddress,query,accuracy]of approved){
  const input={customerCode,originalAddress,originalAddressHash:coordinateAddressHash(originalAddress),rules},before=JSON.stringify(input);
  const result=prepareApprovedCoordinateSearch(input);
  assert.equal(result.query,query);assert.equal(result.accuracy,accuracy);assert.equal(result.originalAddressHash,input.originalAddressHash);
  assert.equal(result.queryHash,coordinateAddressHash(query));assert.equal(result.storeInteriorVerified,false);assert.equal(JSON.stringify(input),before);
  assert.equal(prepareApprovedCoordinateSearch({...input,customerCode:'S990004'}),null);
  assert.equal(prepareApprovedCoordinateSearch({...input,originalAddress:originalAddress+'-1'}),null);
  assert.equal(prepareApprovedCoordinateSearch({...input,originalAddressHash:'f'.repeat(64)}),null);
 }
 assert.equal(prepareApprovedCoordinateSearch({customerCode:'S990001',originalAddress:approved[0][1]}),null);
 assert.equal(prepareApprovedCoordinateSearch({customerCode:'__proto__',originalAddress:approved[0][1],rules}),null);
 assert.equal(prepareApprovedCoordinateSearch({customerCode:'S990002',originalAddress:'합성시 합성동 700-1 (합성동)',rules}),null);
});
test('missing, inherited, malformed or unsafe injected rules cannot create a correction',()=>{
 const input={customerCode:'S990001',originalAddress:approved[0][1]};
 for(const injected of [null,[],{},Object.create(rules),{S990001:null},{S990001:[]},{S990001:{...rules.S990001,accuracy:'STORE_INTERIOR'}},{S990001:{...rules.S990001,query:'합성시 합성로 10 비밀번호 1234'}}])assert.equal(prepareApprovedCoordinateSearch({...input,rules:injected}),null);
});

const original='합성시 합성로 2021',query='합성시 합성로 20-21',code='S990001';
const correction=(extra={})=>({customerCode:code,originalAddressHash:coordinateAddressHash(original),query,queryHash:coordinateAddressHash(query),accuracy:'BUILDING',storeInteriorVerified:false,ruleVersion:'USER_CONFIRMED_SEARCH_ADDRESS_20261104',...extra});
const source=(extra={})=>({customerCode:code,address:original,locationState:'SOURCE_ROW',sourceBasis:'CURRENT_CUSTOMER_LOOKUP',coordinateSearch:correction(),...extra});
const row=(extra={})=>({customerCode:code,address:'',lat:null,lng:null,originalAddressHash:coordinateAddressHash(original),...extra});
function fixture(extra={}){
 const c=vm.createContext({AbortController,setTimeout,clearTimeout,crypto:webcrypto,TextEncoder});
 vm.runInContext(fs.readFileSync(new URL('../public/opsmap/map-address-locations.js',import.meta.url),'utf8'),c);
 const calls=[];const api=c.MapAddressLocations.create({queryFor:a=>a,readAddress:async()=>source(),lookup:async address=>{calls.push(address);return{lat:37.5,lng:127};},spacingMs:0,...extra});
 return {api,calls};
}
test('a synthetic correction searches its approved query while preserving the raw source and original hash',async()=>{
 const raw=row(),a={...raw,raw},before=JSON.stringify(raw),f=fixture();await f.api.ensure(a);
 assert.deepEqual(f.calls,[query]);assert.equal(a.address,'');assert.equal(a.originalAddressHash,coordinateAddressHash(original));
 assert.equal(JSON.stringify(raw),before);assert.equal(a.coordinateSource,'KAKAO_ADDRESS_LIVE');assert.equal(a.coordinateAccuracy,'BUILDING');
 assert.equal(a.storeInteriorVerified,false);assert.equal(f.api.summary().retention,'PAGE_MEMORY_ONLY');assert(!JSON.stringify(f.api.summary()).includes('37.5'));
});
test('a campus query remains approximate and never claims the store interior or a C/D location',async()=>{
 const f=fixture({readAddress:async()=>source({coordinateSearch:correction({accuracy:'CAMPUS'})})}),a=row();await f.api.ensure(a);
 assert.equal(a.coordinateAccuracy,'CAMPUS');assert.equal(a.coordinateStatus,'APPROXIMATE');assert.equal(a.resolutionStatus,'CAMPUS_ADDRESS_LOCATED');assert.equal(a.storeInteriorVerified,false);
 assert(!JSON.stringify(a).includes('C동'));assert(!JSON.stringify(a).includes('D동'));
});
test('wrong customer, source hash, query hash or verification metadata cannot authorize a correction',async()=>{
 for(const change of [{customerCode:'S990002'},{originalAddressHash:'f'.repeat(64)},{query:query+'-1'},{queryHash:'e'.repeat(64)},{accuracy:'STORE_INTERIOR'},{storeInteriorVerified:true},{ruleVersion:'UNAPPROVED'},{query:query+'\n'}]){
  const f=fixture({readAddress:async()=>source({coordinateSearch:correction(change)})}),a=row();await f.api.ensure(a);assert.deepEqual(f.calls,[original]);
 }
 const f=fixture(),a=row({originalAddressHash:'f'.repeat(64)});await f.api.ensure(a);assert.deepEqual(f.calls,[original]);
});
test('without browser SHA256 support an unverified correction never changes the query',async()=>{
 const f=fixture();const c=vm.createContext({AbortController,setTimeout,clearTimeout,TextEncoder});vm.runInContext(fs.readFileSync(new URL('../public/opsmap/map-address-locations.js',import.meta.url),'utf8'),c);
 const calls=[],api=c.MapAddressLocations.create({queryFor:a=>a,readAddress:async()=>source(),lookup:async address=>{calls.push(address);return null;}});await api.ensure(row());assert.deepEqual(calls,[original]);assert.equal(f.calls.length,0);
});
test('a source-address or hash change invalidates the correction and its old live point',async()=>{
 let current=source();const f=fixture({readAddress:async()=>current}),a=row();await f.api.ensure(a);
 current=source({address:'합성시 다른로 99'});a.originalAddressHash=coordinateAddressHash(current.address);f.api.apply(a);assert.equal(a.lat,null);
 await f.api.ensure(a);assert.deepEqual(f.calls,[query,current.address]);assert.equal(a.coordinateAccuracy,'BUILDING');
});
test('a correction does not leak to another customer with the same malformed source address',async()=>{
 const f=fixture(),a=row();await f.api.ensure(a);const b=row({customerCode:'S990002',address:original});await f.api.ensure(b);
 assert.deepEqual(f.calls,[query,original]);assert.equal(b.customerCode,'S990002');
});
test('a source hash change during an in-flight correction cannot project its late result',async()=>{
 let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r),f=fixture({lookup:async()=>{started();await gate;return{lat:37.5,lng:127};}}),a=row(),task=f.api.ensure(a);
 await ready;a.originalAddressHash=coordinateAddressHash('합성시 변경로 99');release();await task;assert.equal(a.lat,null);assert.equal(f.api.summary().located,0);
});
test('signout purges corrections and discards their in-flight provider points',async()=>{
 let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r),f=fixture({lookup:async()=>{started();await gate;return{lat:37.5,lng:127};}}),a=row(),task=f.api.ensure(a);
 await ready;f.api.clear();release();await task;assert.equal(a.lat,null);assert.equal(f.api.summary().located,0);
});
test('existing manual/GPS coordinates are preserved without source or lookup calls',async()=>{
 let reads=0;const f=fixture({readAddress:async()=>{reads++;return source();}});
 for(const coordinateSource of ['MANUAL_PIN','RAW_GPS']){const a=row({lat:37.4,lng:127.1,coordinateSource}),before=JSON.stringify(a);await f.api.ensure(a);assert.equal(JSON.stringify(a),before);}
 assert.equal(reads,0);assert.equal(f.calls.length,0);
});
test('a fresh selected detail can attach a correction for the same unchanged source address',async()=>{
 let changed;const done=new Promise(r=>changed=r),f=fixture({onChange:()=>changed()}),a=row({address:original});
 f.api.acceptAddress(a,source());await done;await f.api.ensure(a);assert.deepEqual(f.calls,[query]);assert.equal(a.address,original);
});
test('an authenticated registry projection validates its correction without any private detail read',async()=>{
 let reads=0;const f=fixture({readAddress:async()=>{reads++;throw Error('UNEXPECTED_DETAIL_READ');}}),raw=row({address:original,coordinateSearch:correction()}),a={...raw,raw},before=JSON.stringify(raw);
 await f.api.ensure(a);assert.deepEqual(f.calls,[query]);assert.equal(reads,0);assert.equal(JSON.stringify(raw),before);assert.equal(a.address,original);
});
test('a campus registry projection remains approximate without reading private detail',async()=>{
 let reads=0;const f=fixture({readAddress:async()=>{reads++;throw Error('UNEXPECTED_DETAIL_READ');}}),a=row({address:original,coordinateSearch:correction({accuracy:'CAMPUS'})});
 await f.api.ensure(a);assert.equal(reads,0);assert.equal(a.coordinateAccuracy,'CAMPUS');assert.equal(a.coordinateStatus,'APPROXIMATE');assert.equal(a.storeInteriorVerified,false);
});
test('a projection with an invalid original or query hash falls back without a private detail read',async()=>{
 for(const coordinateSearch of [correction({originalAddressHash:'f'.repeat(64)}),correction({queryHash:'e'.repeat(64)})]){
  let reads=0;const f=fixture({readAddress:async()=>{reads++;throw Error('UNEXPECTED_DETAIL_READ');}}),a=row({address:original,coordinateSearch});await f.api.ensure(a);assert.deepEqual(f.calls,[original]);assert.equal(reads,0);
 }
});
test('the automatic queue verifies a new projection even after an earlier original-address review',async()=>{
 let reads=0,changed;const done=new Promise(r=>changed=r),calls=[],f=fixture({readAddress:async()=>{reads++;throw Error('UNEXPECTED_DETAIL_READ');},lookup:async address=>{calls.push(address);return address===query?{lat:37.5,lng:127}:null;},onChange:()=>{if(calls.at(-1)===query)changed();}}),a=row({address:original});
 await f.api.ensure(a);a.coordinateSearch=correction();f.api.schedule([a]);await done;assert.deepEqual(calls,[original,query]);assert.equal(reads,0);assert.equal(a.coordinateSource,'KAKAO_ADDRESS_LIVE');
});
test('a projection hash change during SHA256 verification prevents lookup and point projection',async()=>{
 const f=fixture(),a=row({address:original,coordinateSearch:correction()}),task=f.api.ensure(a);a.originalAddressHash='f'.repeat(64);await task;assert.equal(a.lat,null);assert.equal(f.calls.length,0);
});
test('a new projection supersedes a prior live original-address point without a private detail read',async()=>{
 let changed;const done=new Promise(r=>changed=r),f=fixture({onChange:()=>{if(f.calls.length===2)changed();}}),a=row({address:original});
 await f.api.ensure(a);a.coordinateSearch=correction();f.api.schedule([a]);await done;assert.deepEqual(f.calls,[original,query]);assert.equal(a.coordinateAccuracy,'BUILDING');
});
test('a current registry withdrawal clears the approved live point and returns to the original query',async()=>{
 const calls=[],f=fixture({lookup:async address=>{calls.push(address);return address===query?{lat:37.5,lng:127}:null;}}),a=row({address:original,customerRegistryVersion:'registry-v1',coordinateSearch:correction()});
 await f.api.ensure(a);a.customerRegistryVersion='registry-v2';delete a.coordinateSearch;f.api.apply(a);
 assert.equal(a.lat,null);assert.equal(a.coordinateSource,'');assert.equal(a.coordinateAccuracy,'UNVERIFIED');assert.equal(f.api.summary().located,0);
 await f.api.ensure(a);assert.deepEqual(calls,[query,original]);assert.equal(a.lat,null);assert.equal(a.address,original);
});
test('a registry withdrawal also removes a correction installed through private detail',async()=>{
 const calls=[],f=fixture({lookup:async address=>{calls.push(address);return address===query?{lat:37.5,lng:127}:null;}}),a=row();await f.api.ensure(a);
 a.customerRegistryVersion='registry-v2';f.api.apply(a);assert.equal(a.lat,null);f.api.acceptAddress(a,source());await f.api.ensure(a);
 assert.deepEqual(calls,[query,original]);assert.equal(a.lat,null);
});
test('a corrected lookup response arriving after withdrawal cannot restore the old point',async()=>{
 let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r),calls=[],f=fixture({lookup:async address=>{calls.push(address);if(address===query){started();await gate;return{lat:37.5,lng:127};}return null;}}),a=row({address:original,customerRegistryVersion:'registry-v1',coordinateSearch:correction()}),task=f.api.ensure(a);
 await ready;a.customerRegistryVersion='registry-v2';delete a.coordinateSearch;f.api.apply(a);release();await task;assert.equal(a.lat,null);assert.equal(f.api.summary().located,0);
 await f.api.ensure(a);assert.deepEqual(calls,[query,original]);assert.equal(a.lat,null);
});
test('a stale selected copy cannot restore a withdrawn rule',async()=>{
 const calls=[],f=fixture({lookup:async address=>{calls.push(address);return address===query?{lat:37.5,lng:127}:null;}}),a=row({address:original,customerRegistryVersion:'registry-v1',coordinateSearch:correction()});
 await f.api.ensure(a);const stale={...a};a.customerRegistryVersion='registry-v2';delete a.coordinateSearch;f.api.apply(a);await f.api.ensure(stale);
 assert.deepEqual(calls,[query,original]);assert.equal(stale.lat,null);assert.equal(a.lat,null);
});
test('only a new canonical registry sync can reapprove a withdrawn rule',async()=>{
 const f=fixture(),a=row({address:original,customerRegistryVersion:'registry-v1',coordinateSearch:correction()});await f.api.ensure(a);
 a.customerRegistryVersion='registry-v2';delete a.coordinateSearch;f.api.onSourceSync('registry-v2',[a]);await f.api.ensure(a);
 const nextQuery='합성시 합성로 30';a.customerRegistryVersion='registry-v3';a.coordinateSearch=correction({query:nextQuery,queryHash:coordinateAddressHash(nextQuery)});
 f.api.onSourceSync('registry-v3',[a]);await f.api.ensure(a);assert.deepEqual(f.calls,[query,original,nextQuery]);assert.equal(a.coordinateSource,'KAKAO_ADDRESS_LIVE');
});
test('withdrawing a search correction preserves established manual and GPS coordinates',async()=>{
 const f=fixture();for(const coordinateSource of ['MANUAL_PIN','RAW_GPS']){
  const a=row({address:original,customerRegistryVersion:'registry-v2',lat:37.4,lng:127.1,coordinateSource}),before=JSON.stringify(a);f.api.apply(a);await f.api.ensure(a);assert.equal(JSON.stringify(a),before);
 }assert.equal(f.calls.length,0);
});
test('registry versions without any correction preserve an ordinary live exact-address point',async()=>{
 const f=fixture(),a=row({address:original});await f.api.ensure(a);assert.equal(f.api.summary().located,1);
 a.customerRegistryVersion='registry-v1';f.api.apply(a);a.customerRegistryVersion='registry-v2';f.api.apply(a);await f.api.ensure(a);
 assert.deepEqual(f.calls,[original]);assert.equal(a.lat,37.5);assert.equal(a.coordinateAccuracy,'BUILDING');assert.equal(f.api.summary().located,1);
});
test('a late private detail cannot replace the new canonical registry approval with an older query',async()=>{
 const f=fixture(),a=row({address:original,customerRegistryVersion:'registry-v1',coordinateSearch:correction()});await f.api.ensure(a);
 const oldSelected={...a},nextQuery='합성시 합성로 40';a.customerRegistryVersion='registry-v2';a.coordinateSearch=correction({query:nextQuery,queryHash:coordinateAddressHash(nextQuery)});f.api.onSourceSync('registry-v2',[a]);await f.api.ensure(a);
 f.api.acceptAddress(oldSelected,source());await Promise.resolve();await f.api.ensure(a);assert.deepEqual(f.calls,[query,nextQuery]);assert.equal(a.coordinateSource,'KAKAO_ADDRESS_LIVE');
});
