import test from 'node:test';import assert from 'node:assert/strict';
import {snapshotProjection,materializeSnapshot,mergePreservedSnapshot,validateSnapshotProjection} from '../src/productionSnapshotStore.js';
import {coordinateRecoveryDigest as digest,applyCoordinateRecovery} from '../src/coordinateRecoveryAdapter.js';
const h=n=>String(n).repeat(64),version='44104';
function fixture(){
 const rows=[{customerCode:'T900001',customerName:'SYNTHETIC BASE',lat:37.1,lng:127.1,lastDeliveryDate:'2026-11-02',coordinateSource:'RAW_GPS'},...['T900002','T900003','T900004'].map(customerCode=>({customerCode,customerName:'SYNTHETIC ONLY',lat:null,lng:null,lastDeliveryDate:'2026-11-02',vehicle:'101'}))];
 const snapshot=snapshotProjection({version:'phase2b-map-snapshot-v1',rowCount:rows.length,rows,sourceFreshness:{checkedThrough:null}},{now:()=>Date.parse('2026-11-02T00:00:00Z')});
 const current={schema:'opsmap-current-coordinate-addresses-v1',sourceVersion:version,versionAfter:version,observedAt:'2026-11-02T00:00:00.000Z',addressRule:'NFKC_LOWERCASE_WS_TRIM_SHA256_UTF8_V1',sourceReadHash:h(1),rows:rows.map(row=>({customerCode:row.customerCode,addressHash:h(2)}))};
 const point=customerCode=>({customerCode,addressHash:h(2),lat:37.5,lng:127.5,coordinateSource:'KAKAO_VERIFIED_BUILDING',coordinateAccuracy:'BUILDING',fieldAccuracyVerified:false,evidenceKind:'VERIFIED_BUILDING_RECEIPT',evidenceHash:h(3),historicalSourceVersion:'40603'});
 const points=rows.map(row=>point(row.customerCode));
 const body={schema:'opsmap-current-address-coordinate-recovery-v1',basis:{snapshotSha256:snapshot.sha256,currentAddressObservationSha256:digest(current),sourceVersion:version},rows:points};const recovery={...body,hash:digest(body)};
 const options={expectedRecoveryHash:recovery.hash,currentAddresses:current,expectedCurrentAddressHash:digest(current),expectedSnapshotHash:snapshot.sha256,protectedCustomerCodes:['T900004']};return {snapshot,current,recovery,options};
}
const repin=recovery=>{const {hash,...body}=recovery;recovery.hash=digest(body);return recovery.hash;};
test('current code/address-bound recovery fills only unresolved points and survives the existing snapshot projection',()=>{
 const f=fixture(),before=JSON.stringify(f.snapshot),result=applyCoordinateRecovery(f.snapshot,f.recovery,f.options);
 assert.equal(result.summary.added,2);assert.equal(result.summary.preserved,1);assert.equal(result.summary.manualProtected,1);assert.equal(result.rows[0],f.snapshot.rows[0]);assert.equal(result.rows[3],f.snapshot.rows[3]);assert.equal(JSON.stringify(f.snapshot),before);
 const incoming={...materializeSnapshot(f.snapshot),rows:result.rows},saved=mergePreservedSnapshot(f.snapshot,incoming);
 validateSnapshotProjection(saved);assert.equal(saved.schema,1);assert.equal(saved.checkpointDate,null);assert.equal(saved.rows[1].originalAddressHash,h(2));assert.equal(saved.rows[1].coordinateAccuracy,'BUILDING');assert.equal(saved.rows[3].lat,null);assert.equal(saved.rows[0].lat,37.1);
});
test('altered current source, changed address, absent customer and changed baseline fail closed',()=>{
 const f=fixture();const changed=structuredClone(f.current);changed.versionAfter='44105';assert.throws(()=>applyCoordinateRecovery(f.snapshot,f.recovery,{...f.options,currentAddresses:changed,expectedCurrentAddressHash:digest(changed)}),{code:'COORDINATE_RECOVERY_CURRENT_SOURCE'});
 const address=structuredClone(f.recovery);address.rows[0].addressHash=h(4);assert.throws(()=>applyCoordinateRecovery(f.snapshot,address,{...f.options,expectedRecoveryHash:repin(address)}),{code:'COORDINATE_RECOVERY_CURRENT_ADDRESS_MISMATCH'});
 const absent=structuredClone(f.recovery);absent.rows[0].customerCode='T999999';assert.throws(()=>applyCoordinateRecovery(f.snapshot,absent,{...f.options,expectedRecoveryHash:repin(absent)}),{code:'COORDINATE_RECOVERY_CURRENT_ADDRESS_MISMATCH'});
 assert.throws(()=>applyCoordinateRecovery(f.snapshot,f.recovery,{...f.options,expectedSnapshotHash:h(5)}),{code:'COORDINATE_RECOVERY_SOURCE_MISMATCH'});
});
test('a row address hash that no longer matches current evidence remains unresolved',()=>{
 const f=fixture(),input=materializeSnapshot(f.snapshot);input.rows[1].originalAddressHash=h(4);const updated=snapshotProjection(input);f.recovery.basis.snapshotSha256=updated.sha256;
 const result=applyCoordinateRecovery(updated,f.recovery,{...f.options,expectedSnapshotHash:updated.sha256,expectedRecoveryHash:repin(f.recovery)});
 assert.equal(result.summary.addressChanged,1);assert.equal(result.rows[1].lat,null);assert.equal(result.rows[1].originalAddressHash,h(4));
});
test('duplicate points, invalid coordinates, tampering and GPS promotion are rejected',()=>{
 const f=fixture(),duplicate=structuredClone(f.recovery);duplicate.rows.push(duplicate.rows[0]);assert.throws(()=>applyCoordinateRecovery(f.snapshot,duplicate,{...f.options,expectedRecoveryHash:repin(duplicate)}),{code:'COORDINATE_RECOVERY_CANDIDATE'});
 const invalid=structuredClone(f.recovery);invalid.rows[0].lat=null;assert.throws(()=>applyCoordinateRecovery(f.snapshot,invalid,{...f.options,expectedRecoveryHash:repin(invalid)}),{code:'COORDINATE_RECOVERY_CANDIDATE'});
 const tampered=structuredClone(f.recovery);tampered.rows[0].lat=38;assert.throws(()=>applyCoordinateRecovery(f.snapshot,tampered,f.options),{code:'COORDINATE_RECOVERY_INTEGRITY'});
 const promoted=structuredClone(f.recovery);promoted.rows[1].coordinateSource='RAW_GPS';promoted.rows[1].coordinateAccuracy='UNVERIFIED';assert.throws(()=>applyCoordinateRecovery(f.snapshot,promoted,{...f.options,expectedRecoveryHash:repin(promoted)}),{code:'COORDINATE_RECOVERY_ACCURACY_PROMOTION'});
});
test('same-address GPS donors remain BUILDING while same-customer GPS keeps unverified accuracy',()=>{
 const f=fixture();f.recovery.rows[1].coordinateSource='HISTORICAL_GPS_SAME_BUILDING';f.recovery.rows[1].evidenceKind='EXACT_CURRENT_ADDRESS_GPS_DONOR';
 f.recovery.rows[2].coordinateSource='RAW_GPS';f.recovery.rows[2].coordinateAccuracy='UNVERIFIED';f.recovery.rows[2].evidenceKind='PINNED_HISTORICAL_GPS_SAME_CUSTOMER';
 const result=applyCoordinateRecovery(f.snapshot,f.recovery,{...f.options,expectedRecoveryHash:repin(f.recovery)});assert.equal(result.rows[1].coordinateAccuracy,'BUILDING');assert.equal(result.rows[2].coordinateAccuracy,'UNVERIFIED');assert.equal(result.rows[2].coordinateSource,'RAW_GPS');
});
