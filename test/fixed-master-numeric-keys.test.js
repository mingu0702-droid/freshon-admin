import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {isFixedMasterCustomerKey,normalizeFixedMasterCustomerKey} from '../src/fixedMasterCustomerKey.js';
import {createFixedVehicleReader,projectFixedVehicles,inspectFixedMasterKeys} from '../src/fixedVehicleProjection.js';
import * as rootStore from '../src/fixedVehicleStore.js';
import * as abcStore from '../src/opsmap-abc/fixedVehicleStore.js';
import {createFixedVehicleCache} from '../src/fixedVehicleCache.js';
import {mountMapDataFreshness} from '../src/mapDataFreshness.js';

const row=customerCode=>({customerCode,baseVehicle:'221',baseVehicleGroup:'osan',baseVehicleState:'VERIFIED_MASTER'});
const checkedAt=new Date(Date.now()-1000).toISOString();
const rehash=value=>({...value,version:crypto.createHash('sha256').update(JSON.stringify({schema:value.schema,checkedAt:value.checkedAt,rows:value.rows})).digest('hex')});

test('fixed master numeric string contract is bounded and keeps leading zeros',()=>{
 for(const key of ['0','000123','123','S123','A'+'1'.repeat(63),'1'.repeat(64)])assert.equal(isFixedMasterCustomerKey(key),true);
 assert.equal(normalizeFixedMasterCustomerKey('000123'),'000123');
 assert.equal(normalizeFixedMasterCustomerKey(' s123 '),'S123');
 for(const key of [123,0,NaN,null,{},'','1'.repeat(65),'A'+'1'.repeat(64),'+123','-123','1.0','1e3','12A','A','CUSTOMER123','１２３','123\n'])assert.equal(isFixedMasterCustomerKey(key),false);
});

test('projection preserves numeric identities and uses only primary fixed dispatch',()=>{
 const rows=projectFixedVehicles([{estCd:'000123',mainCarSeqNm:'221',carSeqMonNm:'838'},{estCd:'123',carSeqMonNm:'838'},{estCd:'S123',mainCarSeqNm:'122'}]);
 assert.deepEqual(rows.map(r=>r.customerCode),['000123','123','S123']);
 assert.equal(rows[0].baseVehicle,'221');assert.equal(rows[1].baseVehicle,'');assert.equal(rows[1].baseVehicleState,'UNASSIGNED');
 assert.equal(projectFixedVehicles([{estCd:'000123',mainCarSeqNm:'221'},{estCd:'000123',mainCarSeqNm:'122'}])[0].baseVehicleState,'CONFLICT');
});

test('primary fixed dispatch keeps status labels and roundtrips proof of an explicit blank',()=>{
 const projected=projectFixedVehicles([
  {estCd:'S1',logCd:'011',mainCarSeqNm:'오산 신규'},
  {estCd:'S2',logCd:'011',mainCarSeqNm:'보류'},
  {estCd:'S3',logCd:'011',mainCarSeqNm:' １１４ 호차 '},
  {estCd:'S4',logCd:'011',mainCarSeqNm:null,carSeqMonNm:'101'},
  {estCd:'S5',logCd:'011',carSeqMonNm:'122'},
  {estCd:'S6',logCd:'011',mainCarSeqNm:'미확인'},
  {estCd:'S7',logCd:'013',mainCarSeqNm:'척01'},
  {estCd:'S8',logCd:'013',mainCarSeqNm:' 용09 호차 '},
  {estCd:'S9',logCd:'013',mainCarSeqNm:'호남 신규'},
 ]);
 assert.deepEqual(projected.map(r=>r.baseVehicle),['오산신규','오산보류','114','','','','척01','용09','호남신규']);
 assert.equal(projected[3].baseVehicleEmptyVerified,true);
 assert.equal(projected[3].weekdays.Mon,'101');
 assert.equal(projected[4].baseVehicleEmptyVerified,undefined);
 assert.equal(projected[5].baseVehicleEmptyVerified,undefined);
 const [duplicate]=projectFixedVehicles([{estCd:'S4',mainCarSeqNm:''},{estCd:'S4'}]);
 assert.equal(duplicate.baseVehicleEmptyVerified,undefined);
 for(const store of [rootStore,abcStore]){
  const envelope=store.fixedEnvelope(projected,checkedAt);
  assert.deepEqual(store.validateFixedEnvelope(envelope).data,projected);
  assert.equal(envelope.rows[3].length,6);
  assert.equal(envelope.rows[4].length,5);
  assert.throws(()=>store.fixedEnvelope([{...projected[0],baseVehicleEmptyVerified:true}],checkedAt),/FIXED_STORE_INVALID/);
 }
});

test('profile separates accepted numeric strings from unsupported numeric contracts',()=>{
 const profile=inspectFixedMasterKeys([{estCd:'000123'},{estCd:'1'.repeat(65)},{estCd:123},{estCd:'S1'}]);
 assert.equal(profile.numericOnly,2);assert.equal(profile.acceptedNumeric,1);assert.equal(profile.unsupportedNumeric,1);
 assert.equal(profile.valid,2);assert.equal(profile.invalid,2);assert.equal(profile.nonString,1);
 assert.equal(JSON.stringify(profile).includes('000123'),false);
});

test('complete page scan includes every numeric row and still verifies the first page',async()=>{
 const calls=[];
 const rows=Array.from({length:1001},(_,i)=>({estCd:i<990?'S'+i:String(i).padStart(8,'0'),mainCarSeqNm:'221',totalCnt:1001}));
 const reader=createFixedVehicleReader({ensureSession:async()=>{},extractRows:p=>p.data,readJson:async(_u,o)=>{
  const q=new URLSearchParams(o.body),center=q.get('logCd'),page=Number(q.get('page'));calls.push([center,page]);
  return {status:200,data:center==='011'?rows.slice(page*1000,(page+1)*1000):[]};
 }});
 const result=await reader();assert.equal(result.data.length,1001);assert.equal(result.meta.sourceRows,1001);
 assert.equal(result.data.filter(r=>/^\d+$/.test(r.customerCode)).length,11);
 assert.deepEqual(calls,[['011',0],['011',1],['011',0],['012',0],['013',0]]);
 assert.equal(reader.getProgress().complete,true);assert.equal(result.meta.centers[0].declaredRows,1001);
});

for(const [name,store] of [['root',rootStore],['ABC',abcStore]]){
 test(name+' tuple roundtrip preserves exact numeric identity and detects duplicates',()=>{
  const saved=store.fixedEnvelope([row('000123'),row('123'),row('S123')],checkedAt);
  assert.deepEqual(store.validateFixedEnvelope(saved).data.map(r=>r.customerCode),['000123','123','S123']);
  assert.equal(store.validateFixedEnvelope(saved,{materialize:false}).envelope,saved);
  assert.throws(()=>store.fixedEnvelope([row('000123'),row('000123')],checkedAt),/FIXED_STORE_INVALID/);
  for(const code of [123,'1'.repeat(65),'+123','1.0','12A']){
   assert.throws(()=>store.fixedEnvelope([row(code)],checkedAt),/FIXED_STORE_INVALID/);
   const invalid=structuredClone(saved);invalid.rows[0][0]=code;assert.throws(()=>store.validateFixedEnvelope(rehash(invalid)),/FIXED_STORE_INVALID/);
  }
 });
}

test('cache refresh and process reconstruction preserve numeric rows and original alpha identity',async()=>{
 let value=rootStore.fixedEnvelope([row('S1')],checkedAt);
 const store={load:async()=>value,save:async v=>{value=structuredClone(v);},acquire:async()=>true,renew:async()=>{},release:async()=>{}};
 const cache=createFixedVehicleCache({store,ttl:0,reader:async()=>({data:[row('S1'),row('000123'),row('123')]})});
 await cache.get(['S1']);await cache.settled();
 const restart=createFixedVehicleCache({store,ttl:60000,reader:async()=>{throw Error('unexpected read');}});
 const result=await restart.get(['S1','000123','123']);
 assert.deepEqual(result.data.map(r=>r.customerCode),['S1','000123','123']);assert.equal(result.meta.total,3);
});

test('HTTP customer subset validation remains strict and cannot expose numeric keys',async t=>{
 const saved=rootStore.fixedEnvelope([row('S1'),row('000123')],checkedAt);
 const app=express();mountMapDataFreshness(app,{baseStore:{load:async()=>saved},readBaseVehicleMaster:async()=>{throw Error('unexpected read');},callHub:async()=>({data:{}}),requireView:(_q,_r,n)=>n(),previewEnabled:()=>true,modelStatus:()=>({})});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}/api/map-phase2b/preview/base-vehicles`;
 assert.equal((await fetch(base+'?customerCode=000123')).status,400);
 assert.equal((await fetch(base+'?customerCode=S1')).status,200);
});
