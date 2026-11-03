import test from 'node:test';import assert from 'node:assert/strict';
import {createCustomerRegistry,validateCustomerRegistryPage,validateCustomerRegistryState,customerRegistryAddressHash} from '../src/customerRegistry.js';
import {registryFixture,fixtureTime} from './customer-registry-fixture.mjs';

test('cold bootstrap reads only approved metadata, deduplicates latest updatedAt, and signs resumable pages',()=>{
 const f=registryFixture(),a=f.feed({limit:2}),b=f.feed({cursor:a.nextCursor,limit:2});
 assert.equal(a.mode,'FULL');assert.equal(a.sourceCount,3);assert.equal(a.sourceRows,4);assert.equal(a.afterCursor,null);assert.equal(a.complete,false);assert.equal(b.afterCursor,a.nextCursor);assert.equal(b.complete,true);
 assert.equal(a.rows[0].customerName,'합성 최신 A');assert.equal(a.rows[0].addressHash,customerRegistryAddressHash('서울 합성로 11'));assert.equal(a.rows[0].sourceUpdatedAt,fixtureTime);
 assert(!JSON.stringify([a,b]).includes('DO_NOT_READ'));assert(a.rows.every(r=>!('detailAddress' in r)&&!('lat' in r)&&!('phone' in r)));
 assert.throws(()=>f.feed({cursor:a.nextCursor.replace(/.$/,a.nextCursor.endsWith('A')?'B':'A')}),/REGISTRY_CURSOR_INVALID/);
 assert.equal(validateCustomerRegistryPage(a).rows.length,2);
});
test('cached NOOP reads no source and metadata probe reads no names or addresses',()=>{
 const f=registryFixture(),first=f.feed();f.reads.length=0;assert.equal(f.feed({afterVersion:first.version}).mode,'NOOP');assert.equal(f.reads.length,0);
 f.tick();assert.equal(f.feed({afterVersion:first.version}).mode,'NOOP');assert(f.reads.every(r=>!/'![BC]\d+/.test(r)));
});
test('new Customer without Delivery and changed address are emitted by code delta with selected row reads',()=>{
 const f=registryFixture(),first=f.feed();f.data.push(['S970004','합성 신규','서울 신규로 4','DO_NOT_READ',null,null,'DO_NOT_READ','2026-11-04T01:00:00.000Z',false]);f.data[2][2]='서울 이전로 21';f.data[2][7]='2026-11-04T01:00:00.000Z';f.tick();f.reads.length=0;
 const next=f.feed({afterVersion:first.version});assert.equal(next.mode,'DELTA');assert.deepEqual(next.rows.map(r=>r.customerCode),['S970001','S970004']);assert.equal(next.sourceCount,4);assert.notEqual(next.rows[0].addressHash,first.rows[0].addressHash);
 const privateRanges=f.reads.filter(r=>/'![BC]\d+/.test(r));assert.equal(privateRanges.length,4);assert(privateRanges.every(r=>{const m=r.match(/(\d+):[BC](\d+)$/);return m&&m[1]===m[2];}));
});
test('invalid rows and same-revision conflicts exclude only affected codes and report counts',()=>{
 const f=registryFixture();f.data.push(['INVALID-CODE','불량','',null,null,null,null,fixtureTime],['S970009','시각 미상','',null,null,null,null,''],['S970002','상충','서울 다른로 9',null,null,null,null,fixtureTime]);
 const v=f.feed();assert.deepEqual(v.rows.map(r=>r.customerCode),['S970001','S970003']);assert.equal(v.exclusions,2);assert.equal(v.conflicts,1);assert.equal(v.sourceUniqueCodes,5);
});
test('mid-read metadata mutation and empty source cannot certify a successful feed',()=>{
 const f=registryFixture();f.afterPrivateRead(()=>{f.data[0][7]='2026-11-05T00:00:00.000Z';});assert.throws(()=>f.feed(),/REGISTRY_SOURCE_CHANGED/);
 assert.throws(()=>registryFixture({rows:[]}).feed(),/REGISTRY_SOURCE_EMPTY/);
});
test('checkpointed pages resume after process restart without exposing partial registry',async()=>{
 const f=registryFixture();let saved=null;const storage={readState:async()=>saved,writeState:async value=>{saved=structuredClone(value);}};
 let registry=createCustomerRegistry({...storage,readPage:f.readPage,now:f.now,pageSize:2});assert.equal((await registry.refresh({maxPages:1})).phase,'PARTIAL');assert.equal((await registry.read()).rows.length,0);assert.equal(saved.pending.rows.length,2);validateCustomerRegistryState(saved);
 registry=createCustomerRegistry({...storage,readPage:f.readPage,now:f.now,pageSize:2});assert.equal((await registry.refresh()).phase,'UPDATED');assert.equal((await registry.read()).rows.length,3);assert.equal(saved.pending,null);assert.equal((await registry.refresh()).phase,'NOOP');
});
test('failed pages preserve previous registry and retry from the last persisted cursor',async()=>{
 const f=registryFixture();let fail=false,calls=0;const registry=createCustomerRegistry({readPage:async p=>{calls++;if(fail)throw Error('HUB_TIMEOUT');return f.readPage(p);},now:f.now,pageSize:2});
 await registry.refresh();const before=await registry.read();f.data[1][1]='합성 변경 B';f.data[1][7]='2026-11-04T02:00:00.000Z';f.tick();fail=true;await assert.rejects(registry.refresh(),/HUB_TIMEOUT/);assert.deepEqual((await registry.read()).rows,before.rows);
 fail=false;await registry.refresh();assert.equal((await registry.get('S970002')).customerName,'합성 변경 B');assert(calls>=4);
});
test('missing codes, invalid current rows and empty results never remove a previous customer',async()=>{
 const f=registryFixture(),registry=createCustomerRegistry({readPage:f.readPage,now:f.now});await registry.refresh();f.data.splice(1,1);f.tick();await registry.refresh();assert.equal((await registry.read()).rows.length,3);assert.equal(registry.status().sourceCount,2);
 f.data[1][7]='';f.tick();await registry.refresh();assert.equal((await registry.read()).rows.length,3);assert.equal(registry.status().exclusions,1);
 f.data.length=0;f.tick();await assert.rejects(registry.refresh(),/REGISTRY_SOURCE_EMPTY/);assert.equal((await registry.read()).rows.length,3);
});
test('explicit lifecycle alone enables deletion; absent lifecycle never infers a closed store',async()=>{
 const f=registryFixture({lifecycleField:'isDeleted'}),registry=createCustomerRegistry({readPage:f.readPage,now:f.now});await registry.refresh();f.data[1][8]=true;f.data[1][7]='2026-11-04T03:00:00.000Z';f.tick();await registry.refresh();assert.equal((await registry.get('S970002')).lifecycle,'DELETED');assert.equal((await registry.read()).rows.length,3);
 const noField=registryFixture();noField.data[1][8]=true;assert.equal(noField.feed().rows.find(r=>r.customerCode==='S970002').lifecycle,'ACTIVE');assert.equal(noField.feed().lifecycleField,null);
});
test('expired source cursor discards staging and safely restarts; corrupted state never advances',async()=>{
 const f=registryFixture();let saved=null;const registry=createCustomerRegistry({readPage:f.readPage,readState:async()=>saved,writeState:async v=>{saved=v;},pageSize:2,now:f.now});await registry.refresh({maxPages:1});f.cache.clear();assert.equal((await registry.refresh()).phase,'UPDATED');assert.equal((await registry.read()).rows.length,3);
 const corrupt=structuredClone(saved);corrupt.current.rows[0].customerName='변조';assert.throws(()=>validateCustomerRegistryState(corrupt),/REGISTRY_STATE_INTEGRITY/);
});
test('persistence failure cannot publish incoming rows or consume an uncommitted cursor',async()=>{
 const f=registryFixture();let failing=false,saved=null;const registry=createCustomerRegistry({readPage:f.readPage,readState:async()=>saved,writeState:async v=>{if(failing)throw Error('SYNTHETIC_SAVE_FAILURE');saved=v;},now:f.now});await registry.refresh();f.data[1][7]='2026-11-04T04:00:00.000Z';f.data[1][1]='저장 실패 변경';f.tick();failing=true;await assert.rejects(registry.refresh(),/SYNTHETIC_SAVE_FAILURE/);assert.equal((await registry.get('S970002')).customerName,'합성 B');assert.equal(saved.current.rows[1].customerName,'합성 B');
});
test('unknown fields, wrong address hashes, duplicate pages and unsigned cursors are rejected',async()=>{
 const f=registryFixture(),page=f.feed();assert.throws(()=>validateCustomerRegistryPage({...page,phone:'DO_NOT_RETURN'}),/REGISTRY_PAGE_CONTRACT/);assert.throws(()=>validateCustomerRegistryPage({...page,rows:[{...page.rows[0],addressHash:'0'.repeat(64)}]}),/REGISTRY_ROW_CONTRACT/);
 let n=0;const registry=createCustomerRegistry({now:f.now,pageSize:2,readPage:async p=>{const r=await f.readPage(p);if(n++)r.data.offset=0;return r;}});await assert.rejects(registry.refresh(),/REGISTRY_PAGE_CONTRACT|REGISTRY_PAGE_SEQUENCE/);assert.equal((await registry.read()).rows.length,0);
});
test('unchanged registry checks never rewrite the durable metadata file',async()=>{
 const f=registryFixture();let writes=0;const registry=createCustomerRegistry({readPage:f.readPage,writeState:async()=>{writes++;},now:f.now});await registry.refresh();assert.equal(writes,1);f.tick();await registry.refresh();assert.equal(writes,1);assert.equal(registry.status().phase,'NOOP');assert.equal((await registry.read()).checkedAt,new Date(f.now()).toISOString());
});
test('partially received new generation never replaces the prior published registry',async()=>{
 const f=registryFixture(),registry=createCustomerRegistry({readPage:f.readPage,now:f.now,pageSize:2});await registry.refresh();const before=(await registry.read()).rows;
 for(const row of f.data){row[1]+=' 갱신';row[7]='2026-11-04T05:00:00.000Z';}f.data[0][7]='2026-11-03T00:00:00.000Z';f.tick();assert.equal((await registry.refresh({maxPages:1})).phase,'PARTIAL');assert.deepEqual((await registry.read()).rows,before);await registry.refresh();assert((await registry.read()).rows.every(r=>r.customerName.endsWith('갱신')));
});
test('17060 synthetic source rows bootstrap 6004 unique customers through 31 bounded pages',async()=>{
 const rows=Array.from({length:17060},(_,i)=>['S'+(970000+i%6004),'합성 '+(i%6004),'서울 가상로 '+(i%6004),'DO_NOT_READ',null,null,'DO_NOT_READ',new Date(Date.parse(fixtureTime)+Math.floor(i/6004)*60000).toISOString(),false]);
 const f=registryFixture({rows});let pages=0;const registry=createCustomerRegistry({readPage:async p=>{pages++;return f.readPage(p);},now:f.now});await registry.refresh({maxPages:40});const result=await registry.read();assert.equal(result.rows.length,6004);assert.equal(result.sourceUniqueCodes,6004);assert.equal(result.sourceRows,17060);assert.equal(pages,31);assert(result.complete);assert(!JSON.stringify(result).includes('DO_NOT_READ'));
});
