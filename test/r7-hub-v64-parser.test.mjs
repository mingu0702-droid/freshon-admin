import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('v64 parser compatibility preserves table rows and accepts existing object response contracts',()=>{
 const context=vm.createContext({});
 vm.runInContext(fs.readFileSync(new URL('../integrations/hub/HubMapHttpApi.js',import.meta.url),'utf8'),context);
 vm.runInContext(fs.readFileSync(new URL('../integrations/hub/r7/HubSearchObjects.compatibility.js',import.meta.url),'utf8'),context);
 const row={customerCode:'S970001',customerName:'SYNTHETIC_ONLY',customerAddress:'서울특별시 가상로 10'};
 const cases=[
  {data:{headers:Object.keys(row),rows:[Object.values(row)]}},
  {data:[row]},
  {data:{items:[row]}},
  {data:{rows:[row]}},
  {data:{headers:Object.keys(row),rows:[row]}}
 ];
 for(const source of cases)assert.deepEqual(JSON.parse(JSON.stringify(context.hubSearchObjects_(source))),[row]);
 assert.deepEqual(JSON.parse(JSON.stringify(context.hubSearchObjects_({data:null}))),[]);
 // Compatibility in an older project without the HTTP facade remains unchanged.
 const fallback=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../integrations/hub/r7/HubSearchObjects.compatibility.js',import.meta.url),'utf8'),fallback);
 assert.deepEqual(JSON.parse(JSON.stringify(fallback.hubSearchObjects_(cases[0]))),[row]);
});
