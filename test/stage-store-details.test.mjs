import assert from 'node:assert/strict';
import test from 'node:test';
import { createStageStoreDetails } from '../src/stageStoreDetails.js';

const generation = 'a'.repeat(64);
const customer = { customerCode:'S990001',date:'2026-11-14' };
const saved = {customerCode:customer.customerCode,address:'서울 중구 예시로 15',detailAddress:'2층',
  originalAddressHash:'b'.repeat(64)};
const publication = row => ({generation,asOf:'2026-11-07',snapshot:{sourceGeneration:generation,rows:[row]}});

test('a verified address is available independently of the latest source and retains its basis date',async()=>{
  const read=createStageStoreDetails({publication:()=>publication(saved)});
  const result=await read(customer,{load:()=>assert.fail('preserved address should not call Hub')});
  assert.equal(result.value.address,saved.address);
  assert.equal(result.value.detailAddress,'2층');
  assert.equal(result.value.detailDate,customer.date);
  assert.equal(result.value.sourceDate,'2026-11-07');
  assert.equal(result.value.sourceBasis,'STAGE_VERIFIED_REGISTRY');
  const changed=createStageStoreDetails({publication:()=>publication({...saved,addressChanged:true})});
  await assert.rejects(changed(customer,{load:async()=>{throw Error('HUB_INTERNAL_ERROR');}}),/HUB_INTERNAL_ERROR/);
  await assert.rejects(changed(customer,{automatic:true,load:()=>assert.fail()}),/DETAIL_SELECTION_REQUIRED/);
});

test('duplicate source requests share work, and 429 blocks a second request until Retry-After',async()=>{
  let now=0,calls=0,resolve;
  const read=createStageStoreDetails({publication:()=>publication(saved),now:()=>now});
  const load=()=>{calls++;return new Promise(done=>{resolve=done;});};
  const first=read(customer,{refresh:true,load});
  const joined=read(customer,{refresh:true,load});
  await Promise.resolve();
  await assert.rejects(read({...customer,customerCode:'S990002'},{refresh:true,load}),/DETAIL_SOURCE_BUSY/);
  resolve({value:{customerCode:'S990001'},meta:{cache:'MISS'}});
  assert.equal((await first).meta.cache,'MISS');
  assert.equal((await joined).meta.cache,'COALESCED');
  assert.equal(calls,1);
  await assert.rejects(read(customer,{refresh:true,load:()=>{
    calls++;throw Object.assign(Error('HUB_RATE_LIMITED'),{upstreamStatus:429,retryAfter:90});
  }}),error=>error.status===429&&error.retryAfter===90);
  now=89_000;
  await assert.rejects(read(customer,{refresh:true,load}),error=>error.status===429&&error.retryAfter===1);
  assert.equal((await read(customer,{load})).meta.cache,'PRESERVED');
  assert.equal(calls,2);
  now=90_000;
  const recovered=read(customer,{refresh:true,load});
  await Promise.resolve();
  resolve({value:{customerCode:customer.customerCode},meta:{}});
  await recovered;
  assert.equal(calls,3);
});
