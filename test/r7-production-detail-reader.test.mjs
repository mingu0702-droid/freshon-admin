import test from 'node:test';import assert from 'node:assert/strict';
import {createProductionDetailReader,readProductionManualPinCustomer} from '../src/productionOpsmapCandidate.js';
import fs from 'node:fs';import vm from 'node:vm';
test('Production forwards only enabled protected actions to the isolated reader without losing deadlines',async()=>{
 const calls=[],old=async(...a)=>{calls.push(['old',...a]);return 'old';},fresh=async(...a)=>{calls.push(['protected',...a]);return 'protected';};
 const params={customerCode:'S970001'},options={deadline:12345,privateRead:true,maxResponseBytes:65536,signal:new AbortController().signal};
 const read=createProductionDetailReader(old,{env:{OPSMAP_PRIVATE_READER_ENABLED:'true'},protectedRead:fresh});
 for(const action of ['customerDetail','staffCustomerDetail']){assert.equal(await read(action,params,options),'protected');assert.equal(calls.at(-1)[3],options);}
 for(const action of ['mapBounds','periodAssignments','stageReadModelRequest'])assert.equal(await read(action,params,options),'old');
 assert.equal(await createProductionDetailReader(old,{env:{},protectedRead:fresh})('customerDetail',params,options),'old');
});
test('manual projection Customer fallback uses the isolated current reader without changing saved pins',async()=>{
 let legacyReads=0;const readers={readPhase2bSnapshot:async()=>({rows:[]}),readManualPinCustomer:async()=>{legacyReads++;throw Error('OLD_HUB_NOT_USED');}};
 const row=await readProductionManualPinCustomer(readers,'S970001',{env:{OPSMAP_PRIVATE_READER_ENABLED:'true'},protectedRead:async(action,params,options)=>{
  assert.equal(action,'customerDetail');assert.deepEqual(params,{customerCode:'S970001'});assert.equal(options.privateRead,true);assert.equal(options.useCache,false);assert(options.deadline>Date.now());
  return {ok:true,data:{customerCode:'S970001',customerName:'합성 매장',customerAddress:'서울 강남구 합성로 100'}};
 }});assert.equal(legacyReads,0);assert.equal(row.customerCode,'S970001');assert.equal(row.address,'서울 강남구 합성로 100');
});
test('private browser request distinguishes timeout from deliberate selection cancellation',async()=>{
 const source=fs.readFileSync(new URL('../public/opsmap/map-staff.js',import.meta.url),'utf8');
 const request=source.slice(source.indexOf('  async function request('),source.indexOf('  function deadline('));
 let timeout;const context=vm.createContext({AbortController,performance,setTimeout:fn=>{timeout=fn;return 1;},clearTimeout(){},fetch:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))))});
 vm.runInContext('let controller=null,authController=null;const metrics=[],trace={};function deadline(){};'+request,context);
 const timed=vm.runInContext("request('private/customer-current-detail')",context);timeout();await assert.rejects(timed,error=>error.status===504&&error.message==='REQUEST_TIMEOUT');
 const cancelled=vm.runInContext("request('private/customer-current-detail')",context);vm.runInContext('controller.abort()',context);await assert.rejects(cancelled,error=>error.name==='AbortError'&&!error.status);
});
