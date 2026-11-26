import assert from 'node:assert/strict';
import test from 'node:test';
import {customerRegistryAddressHash} from '../src/customerRegistry.js';
import {assertStageNationalRegistryDelta,mergeStageNationalRegistry} from '../src/stageNationalRegistry.js';

const road='대구광역시 수성구 검증로 12';
const parcel='전북특별자치도 전주시 완산구 검증동 12-3';
const record=(customerCode,centerGroup,basicAddress)=>({
  customerCode,centerGroup,basicAddress,customerName:'검증용',lifecycle:'ACTIVE',
  addressHash:customerRegistryAddressHash(basicAddress)
});
const point=(row,kind='BUILDING')=>({...row,verifiedLocation:{kind,addressHash:row.addressHash,lat:35.65,lng:128.3}});

test('a complete official address retains its point when one locality annotation is appended',()=>{
  const before=[record('T1','yeongnam',road),record('T2','honam',parcel)];
  const official=[point(before[0]),point(before[1],'ADDRESS')];
  const observed=[record('T1','yeongnam',road+' (검증동)'),record('T2','honam',parcel+' (검증동)')];
  const merged=mergeStageNationalRegistry(before,observed,official);
  assert.deepEqual(merged.map(row=>row.basicAddress),before.map(row=>row.basicAddress));
  assert.deepEqual(merged.map(row=>row.verifiedLocation),official.map(row=>row.verifiedLocation));
  assert.deepEqual(official.map(row=>row.verifiedLocation.addressHash),before.map(row=>row.addressHash));
  assert.deepEqual(mergeStageNationalRegistry(merged,observed,official),merged);
});

test('unproved supplemental addresses cannot inherit a point or replace the prior verified address',()=>{
  const source=record('T1','yeongnam',road);
  const official=point(source);
  for(const [observed,references] of [
    [record('T1','yeongnam',road+' (검증동, 검증타워)'),[official]],
    [record('T1','yeongnam',road+' (검증동) 201호'),[official]],
    [record('T1','yeongnam',road+' (제2동)'),[official]],
    [record('T1','yeongnam',road.replace('12','13')+' (검증동)'),[official]],
    [record('T1','honam',road+' (검증동)'),[official]],
    [record('T1','yeongnam',road+' (검증동)'),[]],
    [record('T1','yeongnam',road+' (검증동)'),[point(source,'PARCEL')]],
    [record('T1','yeongnam',road+' (검증동)'),[{...official,lifecycle:'DELETED'}]],
    [record('T1','yeongnam',road+' (검증동)'),[point({...source,addressHash:'c'.repeat(64)})]],
    [record('T1','yeongnam','검증로 12 (검증동)'),[point(record('T1','yeongnam','검증로 12'))]]
  ])assert.equal(mergeStageNationalRegistry([],[observed],references)[0].verifiedLocation,undefined);
  const attempted={...source,basicAddress:road+' (검증동, 다른건물)'};
  delete attempted.addressHash;
  const review={};
  const held=mergeStageNationalRegistry([official],[attempted],[official],review)[0];
  assert.equal(held.basicAddress,source.basicAddress);
  assert.deepEqual(held.verifiedLocation,official.verifiedLocation);
  assert.equal(review.addressUnconfirmed,1);
  const lot=record('T2','honam',parcel);
  assert.equal(mergeStageNationalRegistry([],[record('T2','honam',parcel+' (다른동)')],[point(lot)])[0].verifiedLocation,undefined);
});

test('independent fields survive an absent value, and an actual move invalidates the old location',()=>{
  const prior={...point(record('T1','yeongnam',road)),sourceUpdatedAt:'2026-11-25T00:00:00Z'};
  const missing={customerCode:'T1',centerGroup:'yeongnam',customerName:'변경된 상호',basicAddress:'',
    lifecycle:'ACTIVE',sourceUpdatedAt:'2026-11-26T01:00:00Z'};
  const [named]=mergeStageNationalRegistry([prior],[missing],[]);
  assert.equal(named.customerName,'변경된 상호');
  assert.equal(named.basicAddress,road);
  assert.deepEqual(named.verifiedLocation,prior.verifiedLocation);

  const [noChange]=mergeStageNationalRegistry([named],[{...missing,customerName:'',basicAddress:road,
    sourceUpdatedAt:'2026-11-27T01:00:00Z'}],[]);
  assert.deepEqual(noChange,named);

  const [moved]=mergeStageNationalRegistry([named],[{...missing,basicAddress:road.replace('12','13')}],[prior]);
  assert.equal(moved.basicAddress,road.replace('12','13'));
  assert.equal(moved.verifiedLocation,undefined);

  const otherCenter={...missing,basicAddress:road,centerGroup:'honam'};
  assert.equal(mergeStageNationalRegistry([named],[otherCenter],[])[0].verifiedLocation,undefined);
  assert.deepEqual(mergeStageNationalRegistry([named],[otherCenter],[],
    {verifiedCenterMoves:new Set(['T1'])})[0].verifiedLocation,named.verifiedLocation);
});

test('a bulk location loss or meaningful field change is blocked before publication',()=>{
  const before=Array.from({length:110},(_,i)=>point(record('T'+(i+1),'yeongnam',road)));
  const annotations=before.map(row=>record(row.customerCode,'yeongnam',road+' (검증동)'));
  const same=mergeStageNationalRegistry(before,annotations,[]);
  assert.doesNotThrow(()=>assertStageNationalRegistryDelta(before,same));
  assert.deepEqual(same.map(row=>row.addressHash),before.map(row=>row.addressHash));
  const moved=before.map(row=>record(row.customerCode,'yeongnam',road.replace('12','13')));
  assert.throws(()=>assertStageNationalRegistryDelta(before,mergeStageNationalRegistry(before,moved,[])),
    {code:'NATIONAL_REGISTRY_LOCATION_LOSS'});
  const renamed=before.map(row=>({...row,customerName:'변경'}));
  assert.throws(()=>assertStageNationalRegistryDelta(before,renamed),{code:'NATIONAL_REGISTRY_BULK_CHANGE'});
});
