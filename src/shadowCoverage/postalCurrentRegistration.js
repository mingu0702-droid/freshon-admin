import {customerRegistryAddressHash} from '../customerRegistry.js';
import {postalTilePosition} from '../../public/opsmap/postal-geometry.mjs';

const identifiable = /^[A-Z]\d{1,20}$/;
const centers = new Set(['osan','yeongnam','honam']);
const kinds = new Set(['BUILDING','ADDRESS']);
const within = (box,lat,lng) => lng>=box[0] && lng<=box[2] && lat>=box[1] && lat<=box[3];

export function isCurrentPostalPoint(row) {
  const {verifiedLocation:point,basicAddress,addressHash} = row;
  return Boolean(point && kinds.has(point.kind) && typeof basicAddress==='string' && basicAddress.trim() &&
    addressHash===customerRegistryAddressHash(basicAddress) && point.addressHash===addressHash &&
    Number.isFinite(point.lat) && Number.isFinite(point.lng) && within([124,33,132,39.5],point.lat,point.lng));
}

// Callers supply checked national rows and authenticated detail tiles. This
// projection is for current registration only. It carries no dated evidence.
export async function projectCurrentPostalRegistration(rows, existingCodes, detailTiles) {
  const candidates = new Map();
  const counts = {alreadyScoped:0,missingProof:0,ambiguous:0,outside:0,matched:0};
  const seen = new Set();
  for (const row of rows) {
    if (row?.lifecycle!=='ACTIVE') continue;
    const {customerCode:code,centerGroup,verifiedLocation:point} = row;
    if (!identifiable.test(code) || seen.has(code)) throw Error('POSTAL_CURRENT_REGISTRY_IDENTITY');
    seen.add(code);
    if (existingCodes.has(code)) {
      counts.alreadyScoped++;
      continue;
    }
    if (!isCurrentPostalPoint(row)) {
      counts.missingProof++;
      continue;
    }
    candidates.set(code,{lat:point.lat,lng:point.lng,center:centers.has(centerGroup)?centerGroup:null,area:null,ambiguous:false});
  }
  for await (const {box,zones} of detailTiles) {
    for (const candidate of candidates.values()) {
      const {lat,lng} = candidate;
      if (candidate.ambiguous || !within(box,lat,lng)) continue;
      for (const zone of zones) {
        const relation = postalTilePosition(zone,lng,lat);
        if (relation===1 || relation===2 && candidate.area!==null) {
          candidate.ambiguous=true;
          break;
        }
        if (relation===2) candidate.area=zone.id;
      }
    }
  }
  const assignments=new Map();
  for (const [code,{area,center,ambiguous}] of candidates) {
    if (ambiguous) counts.ambiguous++;
    else if (area===null) counts.outside++;
    else {
      assignments.set(code,{area,center});
      counts.matched++;
    }
  }
  return {assignments,counts};
}
