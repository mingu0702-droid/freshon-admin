import assert from 'node:assert/strict';
import test from 'node:test';
import {customerRegistryAddressHash} from '../src/customerRegistry.js';
import {mergeStageNationalRegistry} from '../src/stageNationalRegistry.js';

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
  assert.deepEqual(merged.map(row=>row.basicAddress),observed.map(row=>row.basicAddress));
  assert.deepEqual(merged.map(row=>row.verifiedLocation),official.map(({verifiedLocation},index)=>({
    ...verifiedLocation,addressHash:observed[index].addressHash
  })));
  assert.deepEqual(official.map(row=>row.verifiedLocation.addressHash),before.map(row=>row.addressHash));
  assert.deepEqual(mergeStageNationalRegistry(merged,observed,official),merged);
});

test('a name, unit, ambiguous lot, different center, or missing official proof never inherit a point',()=>{
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
  ]) assert.equal(mergeStageNationalRegistry([official],[observed],references)[0].verifiedLocation,undefined);
  const lot=record('T2','honam',parcel);
  assert.equal(mergeStageNationalRegistry([lot],[record('T2','honam',parcel+' (다른동)')],[point(lot)])[0].verifiedLocation,undefined);
});
