import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {createHash} from 'node:crypto';import {kakaoCoordinateResult,coordinateAddressHash,holdReviewedLegacyPoint} from '../src/opsmap-abc/opsmapAutoCoordinates.js';
const body=address=>({documents:[{address_name:address,x:'126.8',y:'37.6'}],meta:{is_end:true,total_count:1}});
test('official split aliases retain exact city, road or lot, and building identity',()=>{
 for(const [a,b] of [['인천 서구 합성로 24','인천광역시 검단구 합성로 24'],['인천 서구 합성로 406','인천광역시 서해구 합성로 406'],['인천 중구 합성로 185','인천광역시 영종구 합성로 185'],['경기 화성시 합성로 701','경기도 화성시 동탄구 합성로 701'],['경기 화성시 서신면 합성로 1149','경기도 화성시 만세구 서신면 합성로 1149']]){
  const hash=coordinateAddressHash(a);assert(kakaoCoordinateResult(body(b),a));assert.equal(coordinateAddressHash(a),hash);
  assert.equal(kakaoCoordinateResult(body(b.replace(/\d+$/,'99999')),a),null);
 }
});
test('district splitting cannot accept another city, street, lot suffix or ambiguous result',()=>{
 const query='인천 서구 합성로 24';for(const answer of ['서울 검단구 합성로 24','인천 영종구 합성로 24','인천 검단구 다른로 24','인천 검단구 합성로 24-1'])assert.equal(kakaoCoordinateResult(body(answer),query),null);
 const multiple=body('인천 검단구 합성로 24');multiple.documents.push(multiple.documents[0]);multiple.meta.total_count=2;assert.equal(kakaoCoordinateResult(multiple,query),null);
});
test('a spaced numbered branch road cannot be truncated into a different parent-road building',()=>{
 const c=vm.createContext({});for(const name of ['phase2b-ui-helpers.js','new-area-requests.js'])vm.runInContext(fs.readFileSync(new URL('../public/opsmap/'+name,import.meta.url),'utf8'),c);
 const query=c.NewAreaRequests.addressQuery('경기 합성시 합성대로 1313번길 2021, 1층',c.Phase2bUi.addressVariants);
 assert.equal(query,'경기 합성시 합성대로1313번길 2021');assert.notEqual(query,'경기 합성시 합성대로 1313');
});
test('a reviewed legacy point is held only for its exact customer and stored pair',()=>{
 const row={customerCode:'S990001',lat:37.5,lng:127,vehicle:'172',lastDeliveryDate:'2026-11-04'};
 const pointSha256=createHash('sha256').update(JSON.stringify([row.lat,row.lng])).digest('hex');
 const rules={[row.customerCode]:{legacyCoordinateHold:{basis:'SGIS_ADDRESS_DISTRICT_MISMATCH',pointSha256,currentAddressHash:'b'.repeat(64)}}};
 const next=holdReviewedLegacyPoint(row,rules);
 assert.deepEqual([next.lat,next.lng,next.coordinateStatus,next.resolutionStatus],[null,null,'CONFLICT','ADDRESS_CHANGED_REVIEW_REQUIRED']);
 assert.equal(next.vehicle,row.vehicle);assert.equal(next.lastDeliveryDate,row.lastDeliveryDate);assert.equal(row.lat,37.5);
 for(const change of [{customerCode:'S990002'},{lat:37.51},{coordinateSource:'MANUAL_PIN'},{originalAddressHash:'a'.repeat(64)}]){
  const newer={...row,...change};assert.equal(holdReviewedLegacyPoint(newer,rules),newer);
 }
});
