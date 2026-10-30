import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../../public/manual-map-pins.mjs',import.meta.url),'utf8');
function harness(){
  const begin=source.indexOf('function apply(row){'),end=source.indexOf('\nasync function refresh()',begin);
  assert.ok(begin>=0&&end>begin);
  const marker=source.match(/const ORIGINAL_PIN_BASE[^\n]*/)?.[0]||'';
  const ctx={Map,WeakMap,Symbol,Object,Number};
  vm.createContext(ctx);
  vm.runInContext(`let records=new Map(),bases=new WeakMap();${marker}\n${source.slice(begin,end)}\nglobalThis.api={apply,records};`,ctx);
  return ctx.api;
}
const row=()=>({customerCode:'S970001',lat:37.4,lng:127.1,coordinateSource:'KAKAO_BUILDING_EXACT_ADDRESS',coordinateAccuracy:'BUILDING',coordinateStatus:'CONFIRMED'});
const manual={customerCode:'S970001',latitude:37.5,longitude:127.2,resolutionStatus:'MANUAL_CONFIRMED'};
test('confirmed overlay does not mutate Customer address',()=>{
  const h=harness(),r={...row(),address:'SYNTHETIC_ADDRESS'};h.records.set(r.customerCode,manual);h.apply(r);assert.equal(r.lat,37.5);assert.equal(r.coordinateSource,'MANUAL_PIN');assert.equal(r.address,'SYNTHETIC_ADDRESS');
});
test('reverting an overlay restores original row',()=>{
  const h=harness(),r=row();h.records.set(r.customerCode,manual);h.apply(r);h.records.clear();h.apply(r);assert.equal(r.lat,37.4);assert.equal(r.coordinateSource,'KAKAO_BUILDING_EXACT_ADDRESS');
});
test('reverting a search/detail clone restores source coordinate, not a stale manual overlay',()=>{
  const h=harness(),r=row();h.records.set(r.customerCode,manual);h.apply(r);const search={...r};h.apply(search);h.records.clear();h.apply(r);h.apply(search);assert.equal(search.lat,37.4);assert.equal(search.coordinateSource,'KAKAO_BUILDING_EXACT_ADDRESS');
});
test('address mismatch and later removal cannot turn conflict coordinates into the source baseline',()=>{
  const h=harness(),r=row();h.records.set(r.customerCode,{...manual,resolutionStatus:'ADDRESS_CHANGED_REVIEW_REQUIRED'});h.apply(r);const copy={...r};h.apply(copy);h.records.clear();h.apply(copy);assert.equal(copy.lat,37.4);assert.equal(copy.coordinateSource,'KAKAO_BUILDING_EXACT_ADDRESS');
});
test('saved manual coordinates remain unchanged while a projection query is unavailable',()=>{
 const h=harness(),r=row();h.records.set(r.customerCode,manual);h.apply(r);const copy={...r};h.apply(copy);assert.equal(copy.lat,37.5);assert.equal(copy.coordinateSource,'MANUAL_PIN');
});
test('original-coordinate provenance is not serialized in JSON exports',()=>{
 const h=harness(),r=row();h.records.set(r.customerCode,manual);h.apply(r);const serialized=JSON.stringify(r);assert.ok(!serialized.includes('opsmap-original-pin-base'));assert.ok(!serialized.includes('37.4'));assert.equal(JSON.parse(serialized).lat,37.5);
});
test('copying a different customer cannot inherit another customer coordinate baseline',()=>{
 const h=harness(),r=row();h.records.set(r.customerCode,manual);h.apply(r);const other={...r,customerCode:'S970002',lat:36,lng:128,coordinateSource:'KAKAO_VERIFIED_BUILDING'};h.apply(other);assert.equal(other.lat,36);assert.equal(other.coordinateSource,'KAKAO_VERIFIED_BUILDING');
});
test('a genuine missing coordinate remains missing when an isolated override is removed',()=>{
 const h=harness(),r={...row(),lat:null,lng:null,coordinateStatus:'MISSING',coordinateSource:''};h.records.set(r.customerCode,manual);h.apply(r);const copy={...r};h.apply(copy);h.records.clear();h.apply(copy);assert.equal(copy.lat,null);assert.equal(copy.lng,null);assert.equal(copy.coordinateStatus,'MISSING');
});
