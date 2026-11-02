import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBaseTerritories} from '../public/opsmap/territory-policy.mjs';
import {boundaries} from './fixtures/admin-boundaries.mjs';

const base = {customerCode:'S990001',baseVehicle:'101',baseVehicleGroup:'osan',baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:'a'.repeat(64),baseVehicleStale:false,lat:37.1,lng:127.1};
test('independent QA: an unresolved coordinate cannot establish official administrative responsibility', () => {
  for (const patch of [{coordinateStatus:'CONFLICT'},{coordinateStatus:'UNVERIFIED'},{coordinateStatus:'MISSING'},{raw:{coordinateStatus:'CONFLICT'}},{resolutionStatus:'ADDRESS_CHANGED_REVIEW_REQUIRED'}]) {
    const group = buildBaseTerritories([{...base,...patch}],boundaries).groups[0];
    assert.equal(group.state,'unconfirmed',JSON.stringify(patch));
    assert.equal(group.features.length,0);
    assert.equal(group.locatedCount,0);
  }
  const group = buildBaseTerritories([{...base,coordinateSource:'RAW_GPS',coordinateAccuracy:'UNVERIFIED'}],boundaries).groups[0];
  assert.equal(group.state,'ready','GPS accuracy metadata is distinct from an unresolved coordinate status');
  assert.equal(group.features.length,1);
});
