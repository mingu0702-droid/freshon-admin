import test from 'node:test';import assert from 'node:assert/strict';import {kakaoCoordinateResult,coordinateAddressHash} from '../src/opsmap-abc/opsmapAutoCoordinates.js';
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
