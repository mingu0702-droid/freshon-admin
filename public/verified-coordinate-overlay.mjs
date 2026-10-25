/* Optional, pinned coordinate-only overlay. No source IO, publication, or storage. */
const encoder=new TextEncoder();
export async function coordinateDigest(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(value))))].map(n=>n.toString(16).padStart(2,'0')).join('');}
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const coordinate=(lat,lng)=>typeof lat==='number'&&typeof lng==='number'&&Number.isFinite(lat)&&Number.isFinite(lng)&&lat>=33&&lat<=39.5&&lng>=124&&lng<=132;
const buildingSource='KAKAO_BUILDING_EXACT_ADDRESS';
const addressRule='NFKC_LOWERCASE_WS_TRIM_SHA256_UTF8_V1';
const buildingProof=p=>({customerCode:p.customerCode,sourceVersion:p.sourceVersion,addressHash:p.addressHash,queryHash:p.queryHash,queryRuleVersion:p.queryRuleVersion,lat:p.lat,lng:p.lng,coordinateSource:p.coordinateSource,accuracy:p.accuracy,storeInteriorVerified:p.storeInteriorVerified,matchedQueryExact:p.matchedQueryExact,rawSourceAddressExactClaimed:p.rawSourceAddressExactClaimed});
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
    const allowed=['customerCode','lat','lng','customerNameHash','evidenceHash',...(building?['coordinateSource','accuracy','storeInteriorVerified','addressHash','sourceVersion','queryHash','queryRuleVersion','matchedQueryExact','rawSourceAddressExactClaimed']:[])];
    if(!point||Object.keys(point).some(k=>!allowed.includes(k))||!coordinate(point.lat,point.lng)||!hash(point.customerNameHash)||!hash(point.evidenceHash)||changes.has(point.customerCode))throw Error('COORDINATE_POINT_INVALID');
    if(building&&(point.coordinateSource!==buildingSource||point.accuracy!=='BUILDING'||point.storeInteriorVerified!==false||point.sourceVersion!==v.sourceVersion||!hash(point.addressHash)||!hash(point.queryHash)||point.queryRuleVersion!=='NFKC_WS_BUILDING_UNIT_SPLIT_V1'||point.matchedQueryExact!==true||point.rawSourceAddressExactClaimed!==false||await coordinateDigest(buildingProof(point))!==point.evidenceHash))throw Error('COORDINATE_BUILDING_EVIDENCE');
    const i=index.get(point.customerCode);if(i===undefined)throw Error('COORDINATE_CUSTOMER_MISSING');
    if(rows[i][3]!==null||rows[i][4]!==null)throw Error('COORDINATE_EXISTING_IMMUTABLE');
    if(await coordinateDigest(rows[i][1])!==point.customerNameHash)throw Error('COORDINATE_NAME_MISMATCH');
    changes.set(point.customerCode,point);
  }
  const data=rows.map(row=>{const p=changes.get(row[0]);if(!p)return row;const next=row.slice();next[3]=p.lat;next[4]=p.lng;return next;});
  return {...envelope,data,meta:{...meta,coordinatePresentCount:existing+changes.size,coordinateMissingCount:rows.length-existing-changes.size,coordinateOverlay:{hash:overlay.hash,baseDataHash:b.dataHash,added:changes.size,existingPreserved:existing,source:building?buildingSource:'EXISTING_CUSTOMER_RAW_GPS_VERIFIED_AGAINST_PINNED_HUB',...(building?{sourceVersion:v.sourceVersion,accuracy:'BUILDING',storeInteriorVerified:false,fieldAccuracyVerified:false,businessCoverageVerified:false}:{})}}};
}
