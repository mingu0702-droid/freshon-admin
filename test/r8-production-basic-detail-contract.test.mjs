import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/opsmap/phase2b-ui-helpers.js';
import {staffStoreDetail} from '../src/opsmap-abc/mapStaffDetail.js';
const ui=globalThis.Phase2bUi,code='S970001',day='2026-10-23';
test('current Customer lookup explicitly accepts null delivery date without inventing source recency',()=>{
 const value=staffStoreDetail({customerCode:code,customerName:'SYNTHETIC',customerAddress:'합성로 1'},{customerCode:code,date:null});
 assert.equal(value.sourceBasis,'CURRENT_CUSTOMER_LOOKUP');assert.equal(ui.storeDetailMatches(value,code,day),true);assert.equal(value.businessCoverageVerified,false);
 assert.equal(ui.storeDetailMatches({...value,customerCode:'S970002'},code,day),false);assert.equal(ui.storeDetailMatches({...value,detailDate:day},code,day),false);
});
test('stored-day detail cannot be substituted for a different requested date',()=>{
 const value={customerCode:code,sourceBasis:'STORED_DAY',sourceDate:day,detailDate:day};
 assert.equal(ui.storeDetailMatches(value,code,day),true);assert.equal(ui.storeDetailMatches(value,code,'2026-10-31'),false);
 assert.equal(ui.storeDetailMatches({...value,sourceDate:'2026-10-22'},code,day),false);
 assert.equal(ui.storeDetailMatches({customerCode:code,detailDate:null},code,day),false);
});
