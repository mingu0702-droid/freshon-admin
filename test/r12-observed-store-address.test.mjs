import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {createObservedStoreAddressReader} from '../src/observedStoreAddressReader.js';import {deliverySourceObservation} from '../src/snapshotRefreshEvidence.js';
const date='2026-11-04',code='S990001',row={customerCode:code,customerName:'합성신규점',lastDeliveryDate:date};
const live=(stops=[{customerCode:code,address:'합성시 합성로 10 2층'}])=>({date,generatedAt:'2026-11-03T18:00:00Z',sourceObservation:deliverySourceObservation([{enteringDatedAt:date}],{date,complete:true,pages:1,resolveVehicle:()=> '101'}),vehicles:[{vehicle:'101',stops}]});
test('a snapshot-pinned exact date can supply a missing Customer address from existing Delivery reads',async()=>{
 let reads=0;const read=createObservedStoreAddressReader({readSnapshot:async()=>({rows:[row]}),readObservedDeliveryDate:async()=>{reads++;return live();}});
 const value=await read({customerCode:code,date});assert.equal(value.customerCode,code);assert.equal(value.deliveryDate,date);assert.equal(value.customerAddress,'합성시 합성로 10 2층');assert.equal(value.password,undefined);assert.equal(reads,1);
 assert.equal(await read({customerCode:'S990002',date}),null);assert.equal(await read({customerCode:code,date:'2026-11-03'}),null);assert.equal(reads,1);
});
test('incomplete dates, conflicting addresses and absent addresses are never guessed',async()=>{
 for(const source of [{...live(),sourceObservation:{...live().sourceObservation,complete:false}}, {...live(),date:'2026-11-03'},live([{customerCode:code,address:'합성시 합성로 10'},{customerCode:code,address:'합성시 다른로 99'}]),live([{customerCode:code,address:''}])]){
  const read=createObservedStoreAddressReader({readSnapshot:async()=>({rows:[row]}),readObservedDeliveryDate:async()=>source});await assert.rejects(read({customerCode:code,date}));
 }
});
test('the existing Delivery task builder reads the verified location.address contract without copying notes',()=>{
 const text=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8'),begin=text.indexOf('function buildStopFromDeliveryTaskRow('),end=text.indexOf('\n}\n',begin);
 assert(begin>=0&&end>begin);const context={taskRowNested:r=>({customer:r.customer||{},order:{}}),deliveryStopText:(r,keys)=>keys.map(k=>r?.[k]).find(v=>typeof v==='string'&&v.trim())||'',deliveryTaskStatus:()=>({status:'ASSIGNED'}),deliveryTaskVehicle:()=>'',normalizeVehicleValue:v=>v,extractPoint:()=>({})};
 vm.runInNewContext(text.slice(begin,end+2),context);
 const input={customer:{erpCode:code,name:'합성신규점'},location:{address:'합성시 합성로 10',addressDetail:'2층',message:'SYNTHETIC_PROTECTED_NOTE'}};
 const value=context.buildStopFromDeliveryTaskRow(input,'101',1);assert.equal(value.address,'합성시 합성로 10 2층');assert(!JSON.stringify(value).includes('SYNTHETIC_PROTECTED_NOTE'));
 assert.equal(context.buildStopFromDeliveryTaskRow({...input,address:'합성시 우선로 12'},'101',1).address,'합성시 우선로 12 2층');
});
