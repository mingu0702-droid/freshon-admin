import test from 'node:test';
import assert from 'node:assert/strict';
import {projectFixedVehicles,inspectFixedMasterKeys} from '../src/fixedVehicleProjection.js';
import {fixedEnvelope,validateFixedEnvelope} from '../src/fixedVehicleStore.js';
test('Stage named vehicle projection and durable store retain numeric customer strings without broadening employee API',()=>{
 const data=projectFixedVehicles([{estCd:'000123',mainCarSeqNm:'용차A',logCd:'011'}]);
 assert.equal(data[0].customerCode,'000123');assert.equal(data[0].baseVehicle,'용차A');
 const envelope=fixedEnvelope(data,new Date().toISOString());
 assert.equal(validateFixedEnvelope(envelope).data[0].customerCode,'000123');
 assert.throws(()=>fixedEnvelope([{...data[0],customerCode:123}],new Date().toISOString()),/FIXED_STORE_INVALID/);
 assert.equal(inspectFixedMasterKeys([{estCd:123}]).invalid,1);
 assert.equal(/^[A-Z]\d+$/.test('000123'),false);
});
