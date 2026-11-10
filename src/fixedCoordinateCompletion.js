// Pure deterministic completion from an approved official index; no network or source writes.
import {createHash} from 'node:crypto';
import {coordinateAddressHash} from './opsmap-abc/opsmapAutoCoordinates.js';
import {approvedFixedAddressSource, officialAddressKey} from './opsmapOfficialAddressLookup.js';
import {hasFixedCoordinatePoint,createFixedCoordinateResolver,reviseFixedCoordinateLedger,
  validateFixedCoordinateLedger} from './fixedStoreCoordinates.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
const digest=v=>sha(JSON.stringify(v));
const HASH=/^[a-f0-9]{64}$/, CODE=/^[A-Z]\d{1,20}$/;
const addressOf=row=>row.customerAddress || row.basicAddress || row.address || '';
const sensitive=v=>/[\u0000-\u001f]|비밀번호|보안키|공동현관|bearer\s|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/i.test(v);
const needsCoordinate = row => !hasFixedCoordinatePoint(row) || row.addressChanged ||
  row.coordinateStatus === 'CONFLICT' || row.resolutionStatus === 'ADDRESS_CHANGED_REVIEW_REQUIRED';
const protectedPoint = (row,manualCodes) => {
  const code = row.customerCode || row.code;
  return code === 'S191541' || manualCodes.has(code) || row.coordinateSource === 'MANUAL_PIN';
};
const validAddress = address => typeof address === 'string' && address.length <= 500 && !sensitive(address) && !!coordinateAddressHash(address);
const prefix=(a,b)=>Object.entries(a.records).every(([code,h])=>
  JSON.stringify(b.records[code]?.slice(0,h.length))===JSON.stringify(h));

// The configured seed may predate additions committed by this worker. Never drop
// those additions, and never accept diverging histories as a newer generation.
export function continuingFixedLedger(current,supplied) {
  validateFixedCoordinateLedger(supplied);
  if(!current)return supplied;
  validateFixedCoordinateLedger(current);
  if(current.revision===supplied.revision){
    if(current.sha256!==supplied.sha256)throw Error('FIXED_COORDINATE_HISTORY_FORK');
    return current;
  }
  const [older,newer]=current.revision<supplied.revision?[current,supplied]:[supplied,current];
  if(!prefix(older,newer))throw Error('FIXED_COORDINATE_HISTORY_FORK');
  return newer;
}

export async function completeFixedCoordinatesFromCatalog(options, catalog) {
  const {stores,ledger,manualRows=[]} = options;
  const rows = createFixedCoordinateResolver(ledger,{manualRows}).join(stores);
  const manualCodes = new Set(manualRows.map(row=>row.customerCode));
  const addresses = new Set();
  const customers = [];
  for (const row of rows) {
    const address = addressOf(row);
    if (row.registered !== false && !protectedPoint(row,manualCodes) && needsCoordinate(row) && validAddress(address)) {
      addresses.add(address);
      customers.push({customerCode:row.customerCode || row.code,address});
    }
  }
  return completeFixedCoordinates({...options,index:await catalog.resolveMany([...addresses],customers)});
}

export function completeFixedCoordinates({stores,ledger,index,manualRows=[],now=Date.now,maxChanges=1000}={}) {
  validateFixedCoordinateLedger(ledger);
  if(!Array.isArray(stores)||stores.length>15000||typeof index?.resolve!=='function'||
     !Number.isInteger(maxChanges)||maxChanges<1||maxChanges>10000)throw Error('FIXED_COMPLETION_CONFIG');
  const updatedAt=new Date(now()).toISOString();
  const resolved=createFixedCoordinateResolver(ledger,{manualRows}).join(stores);
  const manualCodes=new Set(manualRows.map(row=>row.customerCode));
  const rows=[],replacements=[],decisions=[],seen=new Set();
  const record=(code,hash,status)=>decisions.push({customerCode:code,addressHash:hash||null,status});
  for(const row of resolved){
    const code=row.customerCode||row.code;
    if(!CODE.test(code)||seen.has(code))throw Error('FIXED_COMPLETION_CUSTOMER_ID');
    seen.add(code);
    if(row.registered===false)continue;
    const address=addressOf(row), hash=coordinateAddressHash(address);
    if(protectedPoint(row,manualCodes)){
      record(code,hash,'PRESERVED_MANUAL');continue;
    }
    if(!validAddress(address)){
      record(code,hash,'REVIEW_ADDRESS');continue;
    }
    if(row.currentAddressHash && row.currentAddressHash!==hash){
      record(code,hash,'REVIEW_ADDRESS_BINDING');continue;
    }
    if(!needsCoordinate(row)){
      record(code,hash,'PRESERVED_EXISTING');continue;
    }
    if(rows.length+replacements.length>=maxChanges){record(code,hash,'DEFERRED_BATCH_LIMIT');continue;}
    const evidence=index.resolve(address,code);
    if(!evidence){record(code,hash,index.status?.(address) || 'PENDING_OFFICIAL_COVERAGE');continue;}
    const key=officialAddressKey(address), observedAt=evidence.datasetDate+'T00:00:00.000Z';
    const fromCatalog=Object.hasOwn(evidence,'customerAddressHash');
    const addressLocation=evidence.measurementKind==='ADDRESS_LOCATION';
    const matchesAddress=fromCatalog
      ? evidence.customerAddressHash===hash && approvedFixedAddressSource(evidence.evidenceSource,evidence.sourceDataset)
      : evidence.evidenceSource==='OFFICIAL_ADDRESS_DATA' && key && evidence.addressSha256===sha(key);
    if(!matchesAddress||evidence.evidenceSource==='OPEN_ADDRESS_DATA'&&!addressLocation||
       !(evidence.measurementKind==='BUILDING_LOCATION'||fromCatalog&&addressLocation)||
       ![evidence.buildingSha256,evidence.datasetSha256,evidence.indexSha256].every(v=>HASH.test(v||''))||
       typeof evidence.lat!=='number'||typeof evidence.lng!=='number'||!hasFixedCoordinatePoint(evidence)||
       !/^\d{4}-\d{2}-\d{2}$/.test(evidence.datasetDate||'')||
       !Number.isFinite(Date.parse(observedAt))||new Date(observedAt).toISOString().slice(0,10)!==evidence.datasetDate||
       Date.parse(observedAt)>Date.parse(updatedAt))throw Error('FIXED_COMPLETION_EVIDENCE');
    const point={customerCode:code,addressHash:hash,lat:evidence.lat,lng:evidence.lng,
      coordinateSource:addressLocation?'ADDRESS_REPRESENTATIVE':'BUILDING_VERIFIED',
      coordinateAccuracy:addressLocation?'ADDRESS_APPROXIMATE':'BUILDING',evidenceSource:evidence.evidenceSource,
      evidenceSha256:digest({customerCode:code,addressHash:hash,...evidence}),observedAt,verifiedAt:updatedAt,
      measurementKind:evidence.measurementKind,
      ...(fromCatalog?{sourceDataset:evidence.sourceDataset,sourceDatasetSha256:evidence.datasetSha256}:{})};
    const previous=ledger.records[code]?.at(-1)?.point;
    if(previous){
      if(previous.addressHash===hash){record(code,hash,'REVIEW_EXISTING_EVIDENCE');continue;}
      if(previous.coordinateSource==='MANUAL_PIN'){record(code,hash,'PRESERVED_MANUAL');continue;}
      replacements.push({point,expectedAddressHash:previous.addressHash,currentAddressHash:hash});
      record(code,hash,'ADDRESS_CHANGED_REBOUND');
    }else{rows.push(point);record(code,hash,evidence.evidenceSource==='OPEN_ADDRESS_DATA'?'RESOLVED_OPEN_BUILDING':'RESOLVED_OFFICIAL');}
    // Equal coordinates are not duplicate customers. Each address/building
    // identity above is independently verified; stores retain separate codes.
  }
  const next=reviseFixedCoordinateLedger(ledger,{expectedRevision:ledger.revision,rows,replacements,updatedAt});
  const accepted=new Set([...rows,...replacements.map(item=>item.point)].map(point=>point.customerCode));
  const safeRows=stores.map(row=>{
    const code=row.customerCode||row.code, hash=coordinateAddressHash(addressOf(row));
    const conflict=row.addressChanged===true||row.coordinateStatus==='CONFLICT'||
      row.resolutionStatus==='ADDRESS_CHANGED_REVIEW_REQUIRED'||row.currentAddressHash&&row.currentAddressHash!==hash;
    if(!conflict)return row;
    const cleared={...row,lat:null,lng:null,...('latitude' in row?{latitude:null}:{}),
      ...('longitude' in row?{longitude:null}:{}),...('hasCoordinate' in row?{hasCoordinate:false}:{})};
    // Only newly accepted, address-bound official proof may resolve a stale conflict.
    return accepted.has(code)?{...cleared,addressChanged:false,coordinateStatus:'MISSING',
      resolutionStatus:'COORDINATE_CONFIRMED'}:{...cleared,coordinateStatus:'CONFLICT'};
  });
  const joined=createFixedCoordinateResolver(next,{manualRows}).join(safeRows);
  const active=joined.filter(row=>row.registered!==false);
  return {ledger:next,stores:joined,decisions,summary:{registered:active.length,
    located:active.filter(hasFixedCoordinatePoint).length,added:rows.length,rebound:replacements.length,
    pending:active.filter(row=>!hasFixedCoordinatePoint(row)).length,
    sourceCalls:0,byStatus:Object.fromEntries([...new Set(decisions.map(x=>x.status))]
      .map(status=>[status,decisions.filter(x=>x.status===status).length]))}};
}
