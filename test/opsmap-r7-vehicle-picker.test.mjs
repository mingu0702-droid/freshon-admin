import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/phase2b-ui-helpers.js';
const ui=globalThis.Phase2bUi;
test('regular, sub-vehicle and rental identifiers share deterministic numeric ordering',()=>{
  assert.deepEqual(['용34','203','202-2','101','용02','202-1','102','202','용01'].sort(ui.compareVehicles),['101','102','202','202-1','202-2','203','용01','용02','용34']);
  assert.equal(ui.vehicleMatches('용3','용34'),true);assert.equal(ui.vehicleMatches('02','202-1'),true);assert.equal(ui.vehicleMatches('용','202'),false);
});
test('center grouping requires dispatch evidence; address and actual vehicle cannot supply a base center',()=>{
  const row={baseVehicle:'202',baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:'a'.repeat(64),baseVehicleGroup:'osan',baseVehicleStale:true,baseVehicleCheckedAt:'2026-09-24T00:00:00Z'};
  assert.deepEqual(ui.vehicleFacet([row],'202'),{center:'osan',region:'',stale:true,checkedAt:'2026-09-24',conflict:false,verified:true});
  assert.equal(ui.vehicleFacet([{vehicle:'202',vehicleGroup:'honam',address:'전북특별자치도 시험로 1'}],'202').center,'');
  assert.equal(ui.vehicleFacet([row,{...row,baseVehicleGroup:'honam'}],'202').conflict,true);
  assert.equal(ui.vehicleFacet([row,{...row,baseVehicleGroup:''}],'202').center,'');
  assert.equal(ui.vehicleFacet([row,{...row,baseVehicleVersion:'b'.repeat(64)}],'202').center,'');
});
test('dated vehicle grouping uses its explicit dispatch center without relabeling fixed assignment',()=>{
  const row={vehicle:'용34',dispatchCenterCode:'012',baseVehicle:'101',baseVehicleGroup:'osan'};
  assert.equal(ui.vehicleFacet([row],'용34',{dated:true}).center,'yeongnam');
  assert.equal(ui.vehicleFacet([row],'용34').center,'');
});
