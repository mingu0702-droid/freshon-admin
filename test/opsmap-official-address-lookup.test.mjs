import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOfficialAddressLookup,officialAddressKey} from '../src/opsmapOfficialAddressLookup.js';
import {createKakaoCoordinateConnection} from '../src/opsmap-abc/kakaoCoordinateConnection.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const address = '경기도 합성시 합성대로 77번길 24-1';
const row = {addressSha256:digest('경기도합성시합성대로77번길24-1'),buildingSha256:digest('synthetic building'),lat:37.4,lng:127.1};
const document = {
  schema:'opsmap-official-address-index-v1',source:'https://www.data.go.kr/data/15083033/fileData.do',
  date:'2026-09-30',datasetSha256:digest('synthetic archive'),rows:[row]
};
const bytes = value => Buffer.from(JSON.stringify(value));
const create = value => {const payload=bytes(value);return createOfficialAddressLookup(payload,{sha256:digest(payload)});};

test('only an exact normalized whole building address resolves',()=>{
  const index=create(document);
  assert.equal(officialAddressKey('경기 합성시 합성대로77번길 24-1 (합성동)'), '경기도합성시합성대로77번길24-1');
  assert.deepEqual(index.lookup(address),{lat:37.4,lng:127.1});
  assert.deepEqual(index.lookup('경기 합성시 합성대로77번길24-1 (합성동)'),{lat:37.4,lng:127.1});
  for(const invalid of ['경기 합성시 합성대로77번길 24','경기 합성시 합성대로77번길 24-11','서울 합성시 합성대로77번길 24-1','합성시 합성대로77번길 24-1','합성상호']) {
    assert.equal(index.lookup(invalid),null);
  }
});

test('digest, provenance, address hashes and bounds fail closed without including private fields',()=>{
  assert.throws(()=>createOfficialAddressLookup(bytes(document),{sha256:'a'.repeat(64)}),/OFFICIAL_ADDRESS_INDEX_DIGEST/);
  assert.throws(()=>create({...document,source:'https://example.invalid'}),/OFFICIAL_ADDRESS_INDEX_SCHEMA/);
  for(const rows of [[row,row],[{...row,lat:127.1}],[{...row,address}], [{...row,addressSha256:'X'.repeat(64)}]]){
    assert.throws(()=>create({...document,rows}),/OFFICIAL_ADDRESS_INDEX_ROW/);
  }
});

test('official-only relay is independent of the external ledger and is revoked with its index',async()=>{
  let current=create(document),providerCalls=0;
  const service=createKakaoCoordinateConnection({env:{},independentAddressLookup:()=>current,fetchImpl:()=>{providerCalls++;}});
  assert.deepEqual(await service.status(),{enabled:false,independentEnabled:true,reason:'TARGET_APP_FREE_QUOTA_UNVERIFIED',retention:'REQUEST_ONLY'});
  const result=await service.lookup(address,{mode:'official'});
  assert.deepEqual(result.data.documents,[{x:'127.1',y:'37.4'}]);
  assert.equal(result.data.source,'OFFICIAL_PUBLIC_BUILDING');
  assert.equal(result.data.coordinatePersistence,false);
  assert.equal((await service.lookup('경기도 합성시 합성로 900',{mode:'official'})).data.status,'ZERO_RESULT');
  await assert.rejects(service.lookup(address,{mode:'official',diagnostic:true}),/GEOCODE_QUERY_INVALID/);
  await assert.rejects(service.lookup(address,{mode:'official',assertCurrent:async()=>{throw Error('GEOCODE_SESSION_EXPIRED');}}),/GEOCODE_SESSION_EXPIRED/);
  await assert.rejects(service.lookup(address),/TARGET_APP_FREE_QUOTA_UNVERIFIED/);
  current=null;
  await assert.rejects(service.lookup(address,{mode:'official'}),/OFFICIAL_ADDRESS_LOOKUP_DISABLED/);
  assert.equal((await service.status()).independentEnabled,false);
  assert.equal(providerCalls,0);
});
