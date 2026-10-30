import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read=file=>fs.readFileSync(new URL(file,import.meta.url),'utf8');
function setup({customer,route}={}) {
 const calls=[];
 const context=vm.createContext({getCustomers:params=>{calls.push({action:'customers',params:{...params}});return customer;},getDailyRoutes:params=>{calls.push({action:'routes',params:{...params}});return route;}});
 vm.runInContext(read('../integrations/hub/HubMapHttpApi.js'),context);
 vm.runInContext(read('../integrations/hub/r7/HubSearchObjects.compatibility.js'),context);
 vm.runInContext(read('../integrations/hub/r7/HubCustomerDetail.compatibility.js'),context);
 return {context,calls};
}
const code='S970001',row={customerCode:code,customerName:'SYNTHETIC_ONLY',customerAddress:'서울특별시 가상로 10',detailAddress:'2층'};
const response=data=>({ok:true,data});

test('current Customer is code-only and independent of missing or failed delivery records',()=>{
 const {context,calls}=setup({customer:response([row]),route:{ok:false,error:'MUST_NOT_BE_CALLED'}});
 const detail=context.hubMapHttpHandleCustomerDetail_({customerCode:code});
 assert.equal(detail.data.customerCode,code);assert.equal(detail.data.customerAddress,row.customerAddress);
 assert.deepEqual(calls,[{action:'customers',params:{customerCode:code,limit:1}}]);
});
test('dated lookup preserves route-first date filters and dated route precedence',()=>{
 const dated={...row,customerName:'SYNTHETIC_DATED',confirmedVehicle:'101'};
 const {context,calls}=setup({customer:response({headers:Object.keys(row),rows:[Object.values(row)]}),route:response({items:[dated]})});
 const detail=context.hubMapHttpHandleCustomerDetail_({customerCode:code,date:'2026-10-23'});
 assert.equal(detail.data.customerName,dated.customerName);assert.equal(detail.data.confirmedVehicle,'101');
 assert.deepEqual(calls.map(x=>x.action),['routes','customers']);
 for(const call of calls)assert.deepEqual(call.params,{customerCode:code,limit:1,startDate:'2026-10-23',endDate:'2026-10-23'});
});
test('wrong customer identities, ambiguous rows and unknown payload contracts are failures, never relabelled',()=>{
 for(const customer of [response([{...row,customerCode:'S970002'}]),response([row,{...row,customerAddress:'다른 가상로 20'}]),response({unrecognised:[row]})]) {
  const {context}=setup({customer});
  assert.throws(()=>context.hubMapHttpHandleCustomerDetail_({customerCode:code}),e=>e.safeCode==='INTERNAL_ERROR'&&e.safeHttpStatus===500);
 }
});
test('source failure and timeout are not misreported as customer NOT_FOUND; verified empty stays NOT_FOUND',()=>{
 for(const [customer,expected,http] of [[{ok:false,error:'API failed'},'INTERNAL_ERROR',500],[{ok:false,error:'read timeout'},'TIMEOUT',504],[response([]),'NOT_FOUND',404]]){
  const {context}=setup({customer});
  assert.throws(()=>context.hubMapHttpHandleCustomerDetail_({customerCode:code}),e=>e.safeCode===expected&&e.safeHttpStatus===http);
 }
 const {context,calls}=setup({customer:response([row]),route:{ok:false,error:'read timeout'}});
 assert.throws(()=>context.hubMapHttpHandleCustomerDetail_({customerCode:code,date:'2026-10-23'}),e=>e.safeCode==='TIMEOUT');assert.equal(calls.length,1);
});
