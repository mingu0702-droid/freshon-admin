import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createFixedCoordinateResolver,readFixedCoordinateLedger} from '../src/fixedStoreCoordinates.js';
import {coordinateAddressHash} from '../src/opsmap-abc/opsmapAutoCoordinates.js';

const address = '서울특별시 가상로 10';
const addressHash = coordinateAddressHash(address);
const updatedAt = '2026-11-07T00:00:00Z';
const gps = {customerCode:'S970001', addressHash, lat:37.5, lng:127, observedAt:updatedAt, verifiedAt:updatedAt,
  coordinateSource:'RAW_GPS', coordinateAccuracy:'UNVERIFIED', evidenceSource:'CUSTOMER_GPS_CACHE',
  measurementKind:'DELIVERY_COMPLETION_GPS', evidenceSha256:'a'.repeat(64)};
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function makeLedger(...points) {
  const records = Object.fromEntries(points.map(point => [point.customerCode, [{revision:1, updatedAt, rollbackOf:null, point}]]));
  const ledger = {schema:'opsmap-fixed-store-coordinates-v1', revision:1, records};
  return {...ledger, sha256:sha(ledger)};
}

test('shared point projection uses verified evidence and rejects address and held record conflicts', () => {
  const {verifiedAt, measurementKind, ...legacy} = {...gps, customerCode:'S970002'};
  const official = {...gps, customerCode:'S970003', coordinateSource:'BUILDING_VERIFIED', coordinateAccuracy:'BUILDING',
    evidenceSource:'OFFICIAL_ADDRESS_DATA', measurementKind:'BUILDING_LOCATION'};
  const ledger = makeLedger(gps,legacy,official,{...gps,customerCode:'S191541'});
  const verified = readFixedCoordinateLedger(Buffer.from(JSON.stringify(ledger)),ledger.sha256);
  assert.throws(() => readFixedCoordinateLedger(Buffer.from(JSON.stringify(ledger)),'0'.repeat(64)),/EXPECTED_HASH/);
  const resolver = createFixedCoordinateResolver(verified);
  const source = {code:gps.customerCode, address, lat:null, lng:null, vehicle:'101'};
  const projected = resolver.join([source])[0];
  assert.equal(projected.vehicle,'101');
  assert.equal(projected.lat,gps.lat);
  assert.equal(projected.coordinateAccuracy,'UNVERIFIED');
  assert.equal(projected.coordinateEvidence,measurementKind);
  assert.equal(resolver.get(official.customerCode,addressHash).coordinateAccuracy,'BUILDING');
  assert.equal(resolver.get(legacy.customerCode,addressHash),null);
  const previous = [{...source, currentAddressHash:'0'.repeat(64)}, {...source, address:'서울특별시 가상로 20'},
    {...source, coordinateStatus:'CONFLICT'}, {...source, addressChanged:true}, {...source, lat:37.1, lng:127},
    {...source, code:'S191541'}, {code:gps.customerCode, lat:null, lng:null}];
  assert.ok(resolver.join(previous).every((row,index) => row === previous[index]));
  const disallowed = makeLedger({...official,evidenceSource:'KAKAO'});
  assert.throws(() => createFixedCoordinateResolver(disallowed),/FIXED_COORDINATE_EVIDENCE/);
});

test('approved manual points override same-address points while holding stale and duplicate records', () => {
  const row = {customerCode:gps.customerCode, originalAddressHash:addressHash, lat:gps.lat, lng:gps.lng};
  const pin = {customerCode:gps.customerCode, originalAddressHash:addressHash, currentAddressHash:addressHash,
    latitude:37.52, longitude:127.1, coordinateEvidence:'CORRECTED_ADDRESS_CONFIRMED', resolutionStatus:'MANUAL_CONFIRMED'};
  const ledger = makeLedger(gps);
  const resolver = createFixedCoordinateResolver(ledger,{manualRows:[pin]});
  const projected = resolver.join([row])[0];
  assert.equal(projected.lat,pin.latitude);
  assert.equal(projected.coordinateSource,'MANUAL_PIN');
  assert.equal(projected.coordinateEvidence,'CORRECTED_ADDRESS_CONFIRMED');
  assert.equal(projected.coordinateAccuracy,'ADDRESS');
  assert.throws(() => createFixedCoordinateResolver(ledger,{manualRows:[pin,pin]}),/FIXED_COORDINATE_MANUAL/);
  assert.throws(() => createFixedCoordinateResolver(ledger,{manualRows:[{...pin,currentAddressHash:'0'.repeat(64)}]}),/FIXED_COORDINATE_MANUAL/);
  const held = createFixedCoordinateResolver(ledger,{manualRows:[{...pin,resolutionStatus:'ADDRESS_CHANGED_REVIEW_REQUIRED'}]});
  assert.equal(held.get(gps.customerCode,addressHash).coordinateSource,'RAW_GPS');
  const rolledBack = createFixedCoordinateResolver(ledger);
  assert.equal(rolledBack.join([row])[0],row);
});
