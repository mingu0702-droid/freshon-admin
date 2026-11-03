// Pinned projection adapter only: no geocoder, source read, publication or write.
import crypto from 'node:crypto';
import {validateSnapshotProjection} from './productionSnapshotStore.js';
import {validateSelectedDateCheckpoint} from './snapshotSelectedDateCheckpoint.js';
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const code=value=>typeof value==='string'&&/^[A-Z]\d{1,20}$/.test(value);
const point=value=>typeof value?.lat==='number'&&typeof value?.lng==='number'&&Number.isFinite(value.lat)&&Number.isFinite(value.lng)&&value.lat>=33&&value.lat<=39.5&&value.lng>=124&&value.lng<=132;
const fail=value=>{throw Object.assign(Error(value),{code:value});};
export function coordinateRecoveryDigest(value){return digest(value);}
// Coordinate-only publication preserves the original dated source observation.
// No new collection, visit, delivery-date or completeness claim is introduced.
export function rebindGpsRecoveryCheckpoint(previous,next,checkpoint,allowedCustomerCodes){
 validateSnapshotProjection(previous);validateSnapshotProjection(next);
 const allowed=new Set(allowedCustomerCodes||[]),coordinateFields=new Set(['lat','lng','coordinateSource','coordinateAccuracy','originalAddressHash']);
 const unchanged=row=>JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key])=>!coordinateFields.has(key))));
 if(!allowed.size||allowed.size>500||allowed.has('S191541')||[...allowed].some(value=>!code(value))||next.revision!==previous.revision+1||next.rows.length!==previous.rows.length)fail('GPS_CHECKPOINT_PUBLICATION');
 for(const key of ['schema','scope','latestDate','startDate','checkpointDate','sourceEvidence','rowCount'])if(JSON.stringify(previous[key])!==JSON.stringify(next[key]))fail('GPS_CHECKPOINT_SOURCE_CHANGED');
 let changed=0;
 for(let i=0;i<previous.rows.length;i++){
  const old=previous.rows[i],row=next.rows[i];
  if(unchanged(old)!==unchanged(row))fail('GPS_CHECKPOINT_MEMBERSHIP_CHANGED');
  if(JSON.stringify(old)===JSON.stringify(row))continue;
  if(!allowed.has(old.customerCode)||point(old)||old.coordinateSource==='MANUAL_PIN'||!point(row)||row.coordinateSource!=='RAW_GPS'||row.coordinateAccuracy!=='UNVERIFIED'||!hash(row.originalAddressHash))fail('GPS_CHECKPOINT_LOCATION_CHANGED');
  changed++;
 }
 if(changed!==allowed.size)fail('GPS_CHECKPOINT_COUNT');
 if(!checkpoint)return null;
 validateSelectedDateCheckpoint(checkpoint,{snapshot:previous});
 return validateSelectedDateCheckpoint({...checkpoint,snapshotRevision:next.revision,snapshotSha256:next.sha256,snapshotRowCount:next.rowCount},{snapshot:next});
}
export function applyCoordinateRecovery(snapshot,recovery,{expectedRecoveryHash,currentAddresses,expectedCurrentAddressHash,expectedSnapshotHash,protectedCustomerCodes=[]}={}){
 validateSnapshotProjection(snapshot);const rows=snapshot.rows;
 if(!Array.isArray(rows)||rows.length>50000||!hash(expectedRecoveryHash)||!hash(expectedCurrentAddressHash)||!hash(expectedSnapshotHash)||!Array.isArray(protectedCustomerCodes)||protectedCustomerCodes.some(value=>!code(value)))fail('COORDINATE_RECOVERY_PIN_REQUIRED');
 if(!recovery||recovery.schema!=='opsmap-current-address-coordinate-recovery-v1'||Object.keys(recovery).join('|')!=='schema|basis|rows|hash'||recovery.hash!==expectedRecoveryHash||digest({schema:recovery.schema,basis:recovery.basis,rows:recovery.rows})!==recovery.hash||!Array.isArray(recovery.rows)||recovery.rows.length>500)fail('COORDINATE_RECOVERY_INTEGRITY');
 const current=currentAddresses,basis=recovery.basis;
 if(!current||current.schema!=='opsmap-current-coordinate-addresses-v1'||Object.keys(current).join('|')!=='schema|sourceVersion|versionAfter|observedAt|addressRule|sourceReadHash|rows'||digest(current)!==expectedCurrentAddressHash||typeof current.sourceVersion!=='string'||!/^\d{1,32}$/.test(current.sourceVersion)||current.sourceVersion!==current.versionAfter||current.addressRule!=='NFKC_LOWERCASE_WS_TRIM_SHA256_UTF8_V1'||!hash(current.sourceReadHash)||!Number.isFinite(Date.parse(current.observedAt))||!Array.isArray(current.rows)||current.rows.length>500)fail('COORDINATE_RECOVERY_CURRENT_SOURCE');
 if(!basis||Object.keys(basis).join('|')!=='snapshotSha256|currentAddressObservationSha256|sourceVersion'||basis.snapshotSha256!==expectedSnapshotHash||basis.currentAddressObservationSha256!==expectedCurrentAddressHash||basis.sourceVersion!==current.sourceVersion)fail('COORDINATE_RECOVERY_SOURCE_MISMATCH');
 if(snapshot.sha256!==expectedSnapshotHash)fail('COORDINATE_RECOVERY_SNAPSHOT_MISMATCH');
 const addresses=new Map(),index=new Map(),protectedCodes=new Set(protectedCustomerCodes),changes=new Map(),seenCandidates=new Set();
 for(const row of current.rows){if(!row||Object.keys(row).join('|')!=='customerCode|addressHash'||!code(row.customerCode)||!hash(row.addressHash)||addresses.has(row.customerCode))fail('COORDINATE_RECOVERY_CURRENT_ROW');addresses.set(row.customerCode,row.addressHash);}
 for(const row of rows){const customerCode=row?.customerCode||row?.code;if(!code(customerCode)||index.has(customerCode))fail('COORDINATE_RECOVERY_CUSTOMER_IDENTITY');index.set(customerCode,row);}
 const allowed='customerCode|addressHash|lat|lng|coordinateSource|coordinateAccuracy|fieldAccuracyVerified|evidenceKind|evidenceHash|historicalSourceVersion';
 let preserved=0,manualProtected=0,addressChanged=0;
 for(const candidate of recovery.rows){
  if(!candidate||Object.keys(candidate).join('|')!==allowed||!code(candidate.customerCode)||!hash(candidate.addressHash)||!point(candidate)||!hash(candidate.evidenceHash)||typeof candidate.historicalSourceVersion!=='string'||!/^\d{1,32}$/.test(candidate.historicalSourceVersion)||candidate.fieldAccuracyVerified!==false||!['PINNED_HISTORICAL_GPS_SAME_CUSTOMER','VERIFIED_BUILDING_RECEIPT','EXACT_CURRENT_ADDRESS_GPS_DONOR'].includes(candidate.evidenceKind)||!['RAW_GPS','HISTORICAL_GPS_SAME_BUILDING','KAKAO_VERIFIED_BUILDING'].includes(candidate.coordinateSource)||candidate.coordinateAccuracy!==(candidate.coordinateSource==='RAW_GPS'?'UNVERIFIED':'BUILDING')||seenCandidates.has(candidate.customerCode))fail('COORDINATE_RECOVERY_CANDIDATE');
  seenCandidates.add(candidate.customerCode);
  if(candidate.evidenceKind==='PINNED_HISTORICAL_GPS_SAME_CUSTOMER'?candidate.coordinateSource!=='RAW_GPS':candidate.evidenceKind==='EXACT_CURRENT_ADDRESS_GPS_DONOR'?candidate.coordinateSource!=='HISTORICAL_GPS_SAME_BUILDING':candidate.coordinateSource==='RAW_GPS')fail('COORDINATE_RECOVERY_ACCURACY_PROMOTION');
  const row=index.get(candidate.customerCode);if(!row||addresses.get(candidate.customerCode)!==candidate.addressHash)fail('COORDINATE_RECOVERY_CURRENT_ADDRESS_MISMATCH');
  if(protectedCodes.has(candidate.customerCode)||row.coordinateSource==='MANUAL_PIN'){manualProtected++;continue;}
  if(point(row)){preserved++;continue;}
  const rowAddressHash=row.originalAddressHash||row.addressHash;
  if(rowAddressHash&&rowAddressHash!==candidate.addressHash){addressChanged++;continue;}
  changes.set(candidate.customerCode,candidate);
 }
 return {rows:rows.map(row=>{const candidate=changes.get(row.customerCode||row.code);return candidate?{...row,lat:candidate.lat,lng:candidate.lng,coordinateSource:candidate.coordinateSource,coordinateAccuracy:candidate.coordinateAccuracy,originalAddressHash:candidate.addressHash}:row;}),summary:{added:changes.size,preserved,manualProtected,addressChanged,sourceVersion:current.sourceVersion,recoveryHash:recovery.hash,currentAddressObservationHash:expectedCurrentAddressHash,snapshotHash:snapshot.sha256,geocoderCalls:0,writes:0}};
}
