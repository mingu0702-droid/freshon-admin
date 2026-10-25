/* Optional, pinned coordinate-only overlay. No source IO, publication, or storage. */
const encoder=new TextEncoder();
export async function coordinateDigest(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(value))))].map(n=>n.toString(16).padStart(2,'0')).join('');}
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const coordinate=(lat,lng)=>typeof lat==='number'&&typeof lng==='number'&&Number.isFinite(lat)&&Number.isFinite(lng)&&lat>=33&&lat<=39.5&&lng>=124&&lng<=132;
export async function applyVerifiedCoordinateOverlay(envelope,overlay,{expectedOverlayHash}={}){
  if(!hash(expectedOverlayHash)||overlay?.hash!==expectedOverlayHash)throw Error('COORDINATE_OVERLAY_PIN');
  if(overlay?.schema!=='opsmap-verified-coordinate-overlay-v1'||!overlay.base||!Array.isArray(overlay.rows)||overlay.rows.length>1262)throw Error('COORDINATE_OVERLAY_SCHEMA');
  if(Object.keys(overlay).some(k=>!['schema','base','rows','hash'].includes(k)))throw Error('COORDINATE_OVERLAY_FIELDS');
  if(await coordinateDigest({schema:overlay.schema,base:overlay.base,rows:overlay.rows})!==overlay.hash)throw Error('COORDINATE_OVERLAY_HASH');
  const rows=envelope?.data,meta=envelope?.meta,b=overlay.base;
  if(Object.keys(b).some(k=>!['date','sourceVersion','sourceCandidateHash','dataHash','rowCount','existingCoordinateCount'].includes(k))||!hash(b.dataHash)||!Number.isInteger(b.rowCount)||b.rowCount<1||b.rowCount>15000||!Number.isInteger(b.existingCoordinateCount)||b.existingCoordinateCount<0||overlay.rows.length>b.rowCount-b.existingCoordinateCount)throw Error('COORDINATE_BASE_SCHEMA');
  if(!Array.isArray(rows)||rows.length!==b.rowCount||meta?.date!==b.date||meta?.sourceVersion!==b.sourceVersion||meta?.sourceCandidateHash!==b.sourceCandidateHash||await coordinateDigest(rows)!==b.dataHash)throw Error('COORDINATE_BASE_MISMATCH');
  const index=new Map();let existing=0;
  for(const [i,row]of rows.entries()){
    if(!Array.isArray(row)||row.length!==10||typeof row[0]!=='string'||index.has(row[0]))throw Error('COORDINATE_BASE_IDENTITY');
    index.set(row[0],i);if(coordinate(row[3],row[4]))existing++;
    else if(row[3]!==null||row[4]!==null)throw Error('COORDINATE_PARTIAL_EXISTING');
  }
  if(existing!==b.existingCoordinateCount)throw Error('COORDINATE_BASE_COUNT');
  const changes=new Map();
  for(const point of overlay.rows){
    if(!point||Object.keys(point).some(k=>!['customerCode','lat','lng','customerNameHash','evidenceHash'].includes(k))||!coordinate(point.lat,point.lng)||!hash(point.customerNameHash)||!hash(point.evidenceHash)||changes.has(point.customerCode))throw Error('COORDINATE_POINT_INVALID');
    const i=index.get(point.customerCode);if(i===undefined)throw Error('COORDINATE_CUSTOMER_MISSING');
    if(rows[i][3]!==null||rows[i][4]!==null)throw Error('COORDINATE_EXISTING_IMMUTABLE');
    if(await coordinateDigest(rows[i][1])!==point.customerNameHash)throw Error('COORDINATE_NAME_MISMATCH');
    changes.set(point.customerCode,point);
  }
  const data=rows.map(row=>{const p=changes.get(row[0]);if(!p)return row;const next=row.slice();next[3]=p.lat;next[4]=p.lng;return next;});
  return {...envelope,data,meta:{...meta,coordinatePresentCount:existing+changes.size,coordinateMissingCount:rows.length-existing-changes.size,coordinateOverlay:{hash:overlay.hash,baseDataHash:b.dataHash,added:changes.size,existingPreserved:existing,source:'EXISTING_CUSTOMER_RAW_GPS_VERIFIED_AGAINST_PINNED_HUB'}}};
}
