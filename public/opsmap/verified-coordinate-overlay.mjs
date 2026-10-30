/* Optional, pinned coordinate-only overlay. No source IO, publication, or storage. */
const encoder=new TextEncoder();
export async function coordinateDigest(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(value))))].map(n=>n.toString(16).padStart(2,'0')).join('');}
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const coordinate=(lat,lng)=>typeof lat==='number'&&typeof lng==='number'&&Number.isFinite(lat)&&Number.isFinite(lng)&&lat>=33&&lat<=39.5&&lng>=124&&lng<=132;
const buildingSource='KAKAO_BUILDING_EXACT_ADDRESS';
const addressPointSource='KAKAO_ADDRESS_REVALIDATION',aliasRule='PROVINCE_PREFIX_ALIAS_NFKC_WS_ONLY_V1';
const addressRule='NFKC_LOWERCASE_WS_TRIM_SHA256_UTF8_V1';
const buildingProof=p=>({customerCode:p.customerCode,sourceVersion:p.sourceVersion,addressHash:p.addressHash,queryHash:p.queryHash,queryRuleVersion:p.queryRuleVersion,lat:p.lat,lng:p.lng,coordinateSource:p.coordinateSource,accuracy:p.accuracy,storeInteriorVerified:p.storeInteriorVerified,matchedQueryExact:p.matchedQueryExact,rawSourceAddressExactClaimed:p.rawSourceAddressExactClaimed});
export const coordinateRevalidationProof=p=>({...buildingProof(p),provinceAliasEquivalenceHash:p.provinceAliasEquivalenceHash,
  provinceAliasRuleVersion:p.provinceAliasRuleVersion,matchKind:p.matchKind,providerEvidenceHash:p.providerEvidenceHash,
  queriedAt:p.queriedAt,sourceObservedAt:p.sourceObservedAt,addressObservationHistorical:p.addressObservationHistorical,
  currentAddressSinceObservationUnverified:p.currentAddressSinceObservationUnverified,revalidationOf:p.revalidationOf,revalidationApproval:p.revalidationApproval});
const revalidationFields=['provinceAliasEquivalenceHash','provinceAliasRuleVersion','matchKind','providerEvidenceHash','providerEvidence','queriedAt','sourceObservedAt','addressObservationHistorical','currentAddressSinceObservationUnverified','revalidationOf','revalidationApproval'];
export const buildingRecoveryProof=p=>({...buildingProof(p),buildingIdentityHash:p.buildingIdentityHash,sourceReadHash:p.sourceReadHash,receipt:p.receipt});
const recoverySources=['HISTORICAL_GPS_SAME_BUILDING','KAKAO_VERIFIED_BUILDING'];
const administrativeSources={
 HWASEONG_20260201:['2026-02-01T00:00:00+09:00','https://www.hscity.go.kr/www/partInfo/femaleFamily/Welfare8/Welfare8_1.jsp'],
 INCHEON_20260701:['2026-07-01T00:00:00+09:00','https://www.incheon.go.kr/IC040102'],
 SEOHAE_20260701:['2026-07-01T00:00:00+09:00','https://www.seohae.go.kr/open_content/main/bbs/bbsMsgDetail.do?bcd=report&msg_seq=18773']
};
async function administrativeReceiptValid(a,sourceHash,providerHash,queriedAt){
 const source=administrativeSources[a?.rule];
 if(!source||Object.keys(a).some(k=>!['kind','rule','sourceUrl','sourceUrlHash','sourceIdentityHash','providerIdentityHash','observedAt'].includes(k))||
  a.kind!=='OFFICIAL_ADMINISTRATIVE_REFORM'||a.sourceUrl!==source[1]||a.sourceIdentityHash!==sourceHash||a.providerIdentityHash!==providerHash||
  !hash(providerHash)||a.observedAt!==queriedAt||Date.parse(queriedAt)<Date.parse(source[0]))return false;
 const actual=[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(source[1])))].map(n=>n.toString(16).padStart(2,'0')).join('');
 return a.sourceUrlHash===actual;
}
async function validateBuildingRecovery(p,version){
 const r=p.receipt;
 if(!recoverySources.includes(p.coordinateSource)||p.accuracy!=='BUILDING'||p.sourceVersion!==version||p.storeInteriorVerified!==false||
  !hash(p.addressHash)||!hash(p.queryHash)||!hash(p.buildingIdentityHash)||!hash(p.sourceReadHash)||p.queryRuleVersion!=='BUILDING_REGION_ROAD_LOT_NUMBER_V1'||
  p.rawSourceAddressExactClaimed!==false||!r||r.schema!=='opsmap-current-building-recovery-v1'||
  Object.keys(r).some(k=>!['schema','sourceRow','versionBefore','versionAfter','currentAddressHash','buildingIdentityHash','sourceReadHash','observedAt','fieldAccuracyVerified','storeInteriorVerified','collisionCheckedAgainst','donor','provider'].includes(k))||
  !Number.isSafeInteger(r.sourceRow)||r.sourceRow<2||r.versionBefore!==version||r.versionAfter!==version||r.currentAddressHash!==p.addressHash||
  r.buildingIdentityHash!==p.buildingIdentityHash||r.sourceReadHash!==p.sourceReadHash||!Number.isFinite(Date.parse(r.observedAt))||
  r.fieldAccuracyVerified!==false||r.storeInteriorVerified!==false||!hash(r.collisionCheckedAgainst))throw Error('COORDINATE_RECOVERY_SOURCE');
 if(p.coordinateSource==='HISTORICAL_GPS_SAME_BUILDING'){
  const d=r.donor;
  if(r.provider!==undefined||!d||Object.keys(d).some(k=>!['customerCode','reference','addressHash','lat','lng','source','status','recordedAt','addressMatch'].includes(k))||
   !/^[A-Z]\d+$/.test(d.customerCode)||!/^map_coordinate_cache_v2!\d+$/.test(d.reference)||d.source!=='RAW_GPS'||d.status!=='OK'||d.lat!==p.lat||d.lng!==p.lng||
   !Number.isFinite(Date.parse(d.recordedAt))||Date.parse(d.recordedAt)>Date.parse(r.observedAt)||!['EXACT_CURRENT_BASIC_HASH','EXACT_CURRENT_BUILDING_QUERY_HASH'].includes(d.addressMatch)||
   d.addressHash!==(d.addressMatch==='EXACT_CURRENT_BASIC_HASH'?p.addressHash:p.queryHash)||p.matchedQueryExact!==false)throw Error('COORDINATE_RECOVERY_DONOR');
 }else{
  const d=r.provider;
  if(r.donor!==undefined||!d||Object.keys(d).some(k=>!['receipt','receiptHash','locationEvidenceFileHash','completeResultValidated','queriedAt'].includes(k))||
   !hash(d.locationEvidenceFileHash)||!hash(d.receiptHash)||await coordinateDigest(d.receipt)!==d.receiptHash||d.completeResultValidated!==true||
   !Number.isFinite(Date.parse(d.queriedAt))||Date.parse(d.queriedAt)<Date.parse(r.observedAt)||p.matchedQueryExact!==true||
   d.receipt?.schema!=='opsmap-kakao-building-receipt-summary-v1'||Object.keys(d.receipt).some(k=>!['schema','source','status','accuracy','documentCount','validPoint','queryHash','buildingIdentityHash','providerBuildingIdentityHash','buildingRuleVersion','sourceReceiptHash','administrativeMatch'].includes(k))||
   d.receipt.status!=='VERIFIED_BUILDING_ADDRESS'||d.receipt.source!=='KAKAO_ADDRESS_SEARCH'||d.receipt.accuracy!=='BUILDING'||!hash(d.receipt.sourceReceiptHash)||
   d.receipt.documentCount!==1||d.receipt.validPoint!==true||
   d.receipt.queryHash!==p.queryHash||d.receipt.buildingIdentityHash!==p.buildingIdentityHash||
   (d.receipt.administrativeMatch===undefined?d.receipt.providerBuildingIdentityHash!==p.buildingIdentityHash:
    !await administrativeReceiptValid(d.receipt.administrativeMatch,p.buildingIdentityHash,d.receipt.providerBuildingIdentityHash,d.queriedAt))||
   d.receipt.buildingRuleVersion!=='BUILDING_REGION_ROAD_LOT_NUMBER_V1')throw Error('COORDINATE_RECOVERY_PROVIDER');
 }
 if(await coordinateDigest(buildingRecoveryProof(p))!==p.evidenceHash)throw Error('COORDINATE_RECOVERY_EVIDENCE_HASH');
}
async function validateRevalidation(p,version){
  const r=p.providerEvidence,d=r?.documents?.[0],receiptFields=['schema','queryHash','ruleVersion','source','accuracy','storeInteriorVerified','documentCount','documents','status','reason','provinceAliasRuleVersion','queryEquivalenceHash','matchKind','providerEquivalenceHashes','addressType','completionBasis'];
  const docFields=['addressType','accuracy','buildingMetadataPresent','addressHash','roadAddressHash','lotAddressHash','validPoint'];
  if(p.coordinateSource!==addressPointSource||p.accuracy!=='ADDRESS_POINT'||p.storeInteriorVerified!==false||p.sourceVersion!==version||
    !hash(p.addressHash)||!hash(p.queryHash)||p.queryRuleVersion!=='NFKC_WS_BUILDING_UNIT_SPLIT_V1'||p.rawSourceAddressExactClaimed!==false||
    !hash(p.provinceAliasEquivalenceHash)||p.provinceAliasRuleVersion!==aliasRule||!['EXACT_ADDRESS_HASH','PROVINCE_PREFIX_ONLY'].includes(p.matchKind)||
    p.matchedQueryExact!==(p.matchKind==='EXACT_ADDRESS_HASH')||p.revalidationOf!==p.queryHash||p.revalidationApproval!=='actual-coordinate-revalidation-20261027'||
    p.addressObservationHistorical!==true||p.currentAddressSinceObservationUnverified!==true||!Number.isFinite(Date.parse(p.sourceObservedAt))||
    !Number.isFinite(Date.parse(p.queriedAt))||Date.parse(p.queriedAt)<Date.parse(p.sourceObservedAt)||
    !r||Object.keys(r).some(k=>!receiptFields.includes(k))||r.schema!==1||r.queryHash!==p.queryHash||r.ruleVersion!==addressRule||r.source!=='KAKAO_ADDRESS_SEARCH'||
    r.accuracy!=='ADDRESS_POINT'||r.storeInteriorVerified!==false||r.documentCount!==1||!Array.isArray(r.documents)||r.documents.length!==1||r.reason!==null||r.provinceAliasRuleVersion!==aliasRule||
    r.queryEquivalenceHash!==p.provinceAliasEquivalenceHash||r.matchKind!==p.matchKind||r.status!==(p.matchKind==='EXACT_ADDRESS_HASH'?'VERIFIED_ADDRESS_QUERY':'VERIFIED_PROVINCE_ALIAS_QUERY')||
    !['SDK_HAS_NEXT_PAGE','FIRST_PAGE_FEWER_THAN_REQUESTED_30'].includes(r.completionBasis)||!['ROAD_ADDR','REGION_ADDR'].includes(r.addressType)||
    !Array.isArray(r.providerEquivalenceHashes)||!r.providerEquivalenceHashes.length||r.providerEquivalenceHashes.length>3||r.providerEquivalenceHashes.some(v=>!hash(v))||
    !r.providerEquivalenceHashes.includes(p.provinceAliasEquivalenceHash)||!d||Object.keys(d).some(k=>!docFields.includes(k))||
    d.addressType!==r.addressType||d.accuracy!=='ADDRESS_POINT'||d.validPoint!==true||typeof d.buildingMetadataPresent!=='boolean'||
    [d.addressHash,d.roadAddressHash,d.lotAddressHash].some(v=>v!==null&&!hash(v))||![d.addressHash,d.roadAddressHash,d.lotAddressHash].some(hash)||
    ([d.addressHash,d.roadAddressHash,d.lotAddressHash].includes(p.queryHash))!==(p.matchKind==='EXACT_ADDRESS_HASH')||
    !hash(p.providerEvidenceHash)||await coordinateDigest(r)!==p.providerEvidenceHash||await coordinateDigest(coordinateRevalidationProof(p))!==p.evidenceHash)
    throw Error('COORDINATE_REVALIDATION_EVIDENCE');
}
export async function applyVerifiedCoordinateOverlay(envelope,overlay,{expectedOverlayHash,expectedSourceVersion}={}){
  if(!hash(expectedOverlayHash)||overlay?.hash!==expectedOverlayHash)throw Error('COORDINATE_OVERLAY_PIN');
  if(overlay?.schema!=='opsmap-verified-coordinate-overlay-v1'||!overlay.base||!Array.isArray(overlay.rows)||overlay.rows.length>1262)throw Error('COORDINATE_OVERLAY_SCHEMA');
  if(Object.keys(overlay).some(k=>!['schema','base','rows','hash','verification'].includes(k)))throw Error('COORDINATE_OVERLAY_FIELDS');
  const v=overlay.verification,building=v!==undefined;
  if(building&&(!v||Object.keys(v).some(k=>!['sourceVersion','versionBefore','versionAfter','sourceState','addressRuleVersion','fieldAccuracyVerified','businessCoverageVerified'].includes(k))||typeof expectedSourceVersion!=='string'||!/^[0-9]+$/.test(expectedSourceVersion)||v.sourceVersion!==expectedSourceVersion||v.versionBefore!==expectedSourceVersion||v.versionAfter!==expectedSourceVersion||v.sourceState!=='SOURCE_CONSISTENT_OBSERVATION'||v.addressRuleVersion!==addressRule||v.fieldAccuracyVerified!==false||v.businessCoverageVerified!==false))throw Error('COORDINATE_SOURCE_WINDOW');
  const content={schema:overlay.schema,base:overlay.base,...(building?{verification:v}:{}),rows:overlay.rows};
  if(await coordinateDigest(content)!==overlay.hash)throw Error('COORDINATE_OVERLAY_HASH');
  const rows=envelope?.data,meta=envelope?.meta,b=overlay.base;
  if(Object.keys(b).some(k=>!['date','sourceVersion','sourceCandidateHash','dataHash','rowCount','existingCoordinateCount'].includes(k))||!hash(b.dataHash)||!Number.isInteger(b.rowCount)||b.rowCount<1||b.rowCount>15000||!Number.isInteger(b.existingCoordinateCount)||b.existingCoordinateCount<0||overlay.rows.length>b.rowCount-b.existingCoordinateCount)throw Error('COORDINATE_BASE_SCHEMA');
  if(!Array.isArray(rows)||rows.length!==b.rowCount||meta?.date!==b.date||meta?.sourceVersion!==b.sourceVersion||meta?.sourceCandidateHash!==b.sourceCandidateHash||await coordinateDigest(rows)!==b.dataHash)throw Error('COORDINATE_BASE_MISMATCH');
  const index=new Map();let existing=0;
  for(const [i,row]of rows.entries()){
    if(!Array.isArray(row)||row.length!==10||typeof row[0]!=='string'||index.has(row[0]))throw Error('COORDINATE_BASE_IDENTITY');
    if(building&&(row[8]!==null||row[2]!==''))throw Error('COORDINATE_PRIVATE_RESERVED');
    index.set(row[0],i);if(coordinate(row[3],row[4]))existing++;
    else if(row[3]!==null||row[4]!==null)throw Error('COORDINATE_PARTIAL_EXISTING');
  }
  if(existing!==b.existingCoordinateCount)throw Error('COORDINATE_BASE_COUNT');
  const changes=new Map();
  for(const point of overlay.rows){
    const revalidated=building&&point?.coordinateSource===addressPointSource;
    const recovered=building&&recoverySources.includes(point?.coordinateSource);
    const allowed=['customerCode','lat','lng','customerNameHash','evidenceHash',...(building?['coordinateSource','accuracy','storeInteriorVerified','addressHash','sourceVersion','queryHash','queryRuleVersion','matchedQueryExact','rawSourceAddressExactClaimed',...(revalidated?revalidationFields:[]),...(recovered?['buildingIdentityHash','sourceReadHash','receipt']:[])]:[])];
    if(!point||Object.keys(point).some(k=>!allowed.includes(k))||!coordinate(point.lat,point.lng)||!hash(point.customerNameHash)||!hash(point.evidenceHash)||changes.has(point.customerCode))throw Error('COORDINATE_POINT_INVALID');
    if(recovered){await validateBuildingRecovery(point,v.sourceVersion);if(point.receipt.collisionCheckedAgainst!==b.dataHash)throw Error('COORDINATE_RECOVERY_COLLISION_BASIS');}
    else if(revalidated)await validateRevalidation(point,v.sourceVersion);
    else if(building&&(point.coordinateSource!==buildingSource||point.accuracy!=='BUILDING'||point.storeInteriorVerified!==false||point.sourceVersion!==v.sourceVersion||!hash(point.addressHash)||!hash(point.queryHash)||point.queryRuleVersion!=='NFKC_WS_BUILDING_UNIT_SPLIT_V1'||point.matchedQueryExact!==true||point.rawSourceAddressExactClaimed!==false||await coordinateDigest(buildingProof(point))!==point.evidenceHash))throw Error('COORDINATE_BUILDING_EVIDENCE');
    const i=index.get(point.customerCode);if(i===undefined)throw Error('COORDINATE_CUSTOMER_MISSING');
    if(rows[i][3]!==null||rows[i][4]!==null)throw Error('COORDINATE_EXISTING_IMMUTABLE');
    if(await coordinateDigest(rows[i][1])!==point.customerNameHash)throw Error('COORDINATE_NAME_MISMATCH');
    changes.set(point.customerCode,point);
  }
  const data=rows.map(row=>{const p=changes.get(row[0]);if(!p)return row;const next=row.slice();next[3]=p.lat;next[4]=p.lng;return next;});
  const addressPoints=[...changes.values()].filter(p=>p.coordinateSource===addressPointSource).length;
  return {...envelope,data,meta:{...meta,coordinatePresentCount:existing+changes.size,coordinateMissingCount:rows.length-existing-changes.size,coordinateOverlay:{hash:overlay.hash,baseDataHash:b.dataHash,added:changes.size,existingPreserved:existing,source:addressPoints?'MIXED_VERIFIED_COORDINATE_CANDIDATES':building?buildingSource:'EXISTING_CUSTOMER_RAW_GPS_VERIFIED_AGAINST_PINNED_HUB',...(building?{sourceVersion:v.sourceVersion,accuracy:addressPoints?'MIXED':'BUILDING',...(addressPoints?{byAccuracy:{BUILDING:changes.size-addressPoints,ADDRESS_POINT:addressPoints}}:{}),storeInteriorVerified:false,fieldAccuracyVerified:false,businessCoverageVerified:false}:{})}}};
}
