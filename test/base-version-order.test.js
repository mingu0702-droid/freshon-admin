import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../public/map-period-ui.js',import.meta.url),'utf8'),ctx);
const ui=ctx.MapPeriodUi;
test('late master result cannot regress version, time or explicit unassigned value',()=>{
 const current={customerCode:'S99731',baseVehicle:'',baseVehicleState:'UNASSIGNED',baseVehicleVersion:'new',baseVehicleCheckedAt:'2026-09-29T00:00:00Z'};
 const late={...current,baseVehicle:'221',baseVehicleState:'VERIFIED_MASTER',baseVehicleVersion:'old',baseVehicleCheckedAt:'2026-09-24T00:00:00Z'};
 assert.equal(ui.mergeBaseVehicles(new Map([['S99731',current]]),[late]).get('S99731').baseVehicle,'');
});
test('new verified change and deletion supersede old base vehicle',()=>{
 const old={customerCode:'S99731',baseVehicle:'221',baseVehicleState:'VERIFIED_MASTER',baseVehicleVersion:'old',baseVehicleCheckedAt:'2026-09-24T00:00:00Z'};
 for(const state of ['UNASSIGNED','NOT_IN_MASTER']){
  const next={...old,baseVehicle:'',baseVehicleState:state,baseVehicleVersion:'new',baseVehicleCheckedAt:'2026-09-29T00:00:00Z'};
  assert.equal(ui.mergeBaseVehicles(new Map([['S99731',old]]),[next]).get('S99731').baseVehicleState,state);
 }
});
test('same-time conflicting version and missing-time regression fail closed',()=>{
 const before={version:'a',checkedAt:'2026-09-29T00:00:00Z'};
 assert.equal(ui.acceptsBaseVersion(before,{...before,version:'b'}),false);
 assert.equal(ui.acceptsBaseVersion(before,{}),false);
 assert.equal(ui.acceptsBaseVersion(before,before),true);
});
