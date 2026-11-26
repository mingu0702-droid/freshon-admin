import crypto from 'node:crypto';
import {createPrivateDetailReadScope} from './opsmap-abc/privateDetailRequest.js';
import {prepareRecoveryCoordinateAddress} from './coordinateLookupOutcome.js';
import {officialAddressKey} from './opsmapOfficialAddressLookup.js';
const code=v=>typeof v==='string'&&/^[A-Z]\d{1,20}$/.test(v);
const text=v=>String(v??'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,'');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function projection(row){
 const fields=['customerCode','customerName','lat','lng','coordinateSource','coordinateAccuracy','coordinateEvidence','coordinateStatus','originalAddressHash','addressHash','addressChanged','resolutionStatus','sourceUpdatedAt','matchedBy','baseVehicle','baseVehicleGroup','baseVehicleState','baseVehicleSource','baseVehicleVersion','baseVehicleCheckedAt','baseVehicleStale','dispatchCenterCode','center','region','lastDeliveryDate'];
 const r=Object.fromEntries(fields.filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]]));
 if(/비밀번호|보안키|bearer\s|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/i.test(r.customerName||''))r.customerName=r.customerCode;
 return r;
}
const preservedIndexes=new WeakMap();
function snapshotIndex(snapshot){
 const rows=snapshot?.rows || [];
 const version=snapshot?.sourceGeneration || snapshot?.version || snapshot?.preservation?.version || null;
 let entry=preservedIndexes.get(rows);
 if(!entry||entry.version!==version||entry.length!==rows.length){
  const byCode=new Map();
  for(const row of rows){if(!code(row.customerCode))continue;const found=byCode.get(row.customerCode)||[];found.push(row);byCode.set(row.customerCode,found);}
  entry={version,length:rows.length,byCode,byAddress:null};preservedIndexes.set(rows,entry);
 }
 return entry;
}
function exactAddressKey(address){
 if(typeof address!=='string'||!address.trim())return null;
 const official=officialAddressKey(address);
 if(official)return official;
 const prepared=prepareRecoveryCoordinateAddress(address);
 if(!prepared.query||!['ROAD','LOT'].includes(prepared.addressKind))return null;
 return officialAddressKey(prepared.query);
}
function approvedAddressFields(row) {
 const addresses = [row.address || row.customerAddress || row.basicAddress || row.latestAddress];
 if (!row.addressChanged && row.resolutionStatus !== 'ADDRESS_CHANGED_REVIEW_REQUIRED') {
  addresses.push(row.customerAddress, row.roadAddress, row.roadNameAddress, row.lotAddress, row.jibunAddress);
 }
 return addresses;
}
function indexAddressRow(index, row) {
 if (!code(row.customerCode)) return;
 const keys = new Set();
 for (const address of new Set(approvedAddressFields(row))) {
  const key = exactAddressKey(address);
  if (key) keys.add(key);
 }
 for (const key of keys) {
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(row);
 }
}

// Prepare the same private index used by a foreground lookup. Yield between
// chunks so another staff request can still use the map during restoration.
export function preparePreservedAddressIndex(snapshot) {
 if (!Array.isArray(snapshot?.rows)) return Promise.resolve();
 const entry = snapshotIndex(snapshot);
 if (entry.byAddress) return Promise.resolve();
 entry.preparingAddress ??= (async () => {
  const byAddress = new Map();
  for (let i = 0; i < snapshot.rows.length; i++) {
   indexAddressRow(byAddress, snapshot.rows[i]);
   if ((i + 1) % 128 === 0) {
    await new Promise(resolve => setImmediate(resolve));
    if (entry.byAddress) return;
   }
  }
  entry.byAddress = byAddress;
 })().finally(() => { entry.preparingAddress = null; });
 return entry.preparingAddress;
}

function preservedMatches(query,snapshot,{singleLookup=false}={}){
 const rows=snapshot.rows,index=snapshotIndex(snapshot);
 const matchedBy=code(query.toUpperCase())?'CODE':'ADDRESS';
 const key=matchedBy==='ADDRESS'?exactAddressKey(query):null;
 if(matchedBy==='ADDRESS'&&!key)return {matches:[],matchedBy};
 if(singleLookup&&key&&!index.byAddress){
  // The final consecutive digits survive the same NFKC normalization used by the full index.
  // Filter candidates cheaply, then apply the identical exact-address test to each one.
  const numericSuffix=key.match(/\d{1,4}$/)?.[0];
  if(numericSuffix)return {matchedBy,matches:rows.filter(row=>code(row.customerCode)&&
    approvedAddressFields(row).some(address=>typeof address==='string'&&
      (address.includes(numericSuffix)||address.normalize('NFKC').includes(numericSuffix))&&exactAddressKey(address)===key))};
 }
 if(matchedBy==='ADDRESS'&&!index.byAddress){
  const byAddress=new Map();
  for (const row of rows) indexAddressRow(byAddress, row);
  index.byAddress=byAddress;
 }
 const matches=matchedBy==='CODE'?index.byCode.get(query.toUpperCase())||[]:index.byAddress.get(key)||[];
 return {matches,matchedBy};
}
export function searchPreservedRegistry(query,snapshot){
 const {matches,matchedBy}=preservedMatches(query,snapshot);
 return {ok:true,data:matches.slice(0,50).map(row=>({...projection(row),matchedBy})),
  meta:{source:'STAGE_VERIFIED_REGISTRY',currentness:'PRESERVED_VALIDATION',customerMatchVerified:false,complete:false,truncated:matches.length>50}};
}
const safePoint = ({lat,lng}={}) => Number.isFinite(lat)&&Number.isFinite(lng)&&lat>=33&&lat<=39.5&&lng>=124&&lng<=132 ? {lat,lng} : null;
const approvedPoint = row => !row.addressChanged && !['CONFLICT','UNVERIFIED','MISSING'].includes(row.coordinateStatus) &&
 row.resolutionStatus!=='ADDRESS_CHANGED_REVIEW_REQUIRED' && !/(?:_LIVE|_TEMPORARY)$/.test(row.coordinateSource||'') ? safePoint(row) : null;
const masterIndexes=new WeakMap();
function stageMasterSnapshot(master) {
 if (!Array.isArray(master?.rows)) return null;
 if (masterIndexes.has(master.rows)) return masterIndexes.get(master.rows);
 const registered=new Map();
 const rows=[];
 for (const row of master.rows) {
  if (!code(row?.customerCode)) continue;
  registered.set(row.customerCode,row);
  if (row.lifecycle!=='ACTIVE') continue;
  const point=row.verifiedLocation?.addressHash===row.addressHash&&/^[a-f0-9]{64}$/.test(row.addressHash||'') ? safePoint(row.verifiedLocation) : null;
  rows.push({customerCode:row.customerCode,address:row.basicAddress,...point});
 }
 const value={snapshot:{rows},registered};
 masterIndexes.set(master.rows,value);
 return value;
}
export function prepareStageAddressMasterIndex(master) {
 return preparePreservedAddressIndex(stageMasterSnapshot(master)?.snapshot);
}
export function resolvePreservedAddressBatch(rows,snapshot,officialIndex,{includeCustomers=false,timings,master,includeExternalEligibility=false}={}){
 const measure=(key,read)=>{
  if(!timings)return read();
  const start=performance.now();
  try{return read();}finally{timings[key]=(timings[key]||0)+performance.now()-start;}
 };
 const current=stageMasterSnapshot(master);
 const find=query=>measure('customer',()=>{
  const preserved=preservedMatches(query,snapshot,{singleLookup:includeCustomers}).matches.filter(row=>{
   const active=current?.registered.get(row.customerCode);
   if (!active) return true;
   const key=exactAddressKey(active.basicAddress);
   return active.lifecycle==='ACTIVE'&&key!==null&&key===exactAddressKey(row.address||row.customerAddress||row.basicAddress||row.latestAddress);
  });
  return current ? [...preserved,...preservedMatches(query,current.snapshot,{singleLookup:includeCustomers}).matches] : preserved;
 });
 return rows.map(queries=>{
  if(!queries.length)return {status:'INVALID_ADDRESS'};
  const isCode=code(queries[0].toUpperCase());
  const matched=new Set(queries.flatMap(find));
  let official,officialError=false;
  // A verified road/lot pair is one address identity, including when the postal point is unverified.
  if(!isCode&&![...matched].some(approvedPoint)){
   try{
    const hits=measure('official',()=>queries.map(query=>officialIndex?.lookup(query)).filter(Boolean));
    for(const alias of hits.flatMap(hit=>[hit.road,hit.lot]).filter(Boolean)){
     for(const row of find(alias))matched.add(row);
    }
    const signature=hit=>JSON.stringify([hit.kind||'EXACT',hit.points||[[hit.lat,hit.lng]]]);
    if(new Set(hits.map(signature)).size>1)return {status:'ADDRESS_AMBIGUOUS'};
    official=hits[0];
   }catch{officialError=true;}
  }
  const customers=includeCustomers&&matched.size?{customerCodes:[...new Set([...matched].map(row=>row.customerCode))].slice(0,50)}:{};
  if(matched.size){
   if([...matched].some(row=>row.addressChanged||row.coordinateStatus==='CONFLICT'||row.resolutionStatus==='ADDRESS_CHANGED_REVIEW_REQUIRED'))
    return {status:'STORED_COORDINATE_UNVERIFIED',...customers};
   const points=new Map();
   for(const row of matched){const point=approvedPoint(row);if(point)points.set(`${point.lat},${point.lng}`,point);}
   if(points.size>1)return {status:'ADDRESS_AMBIGUOUS',...customers,
    points:[...points.values()].slice(0,12).map(point=>({...point,coordinateSource:'STAGE_PRESERVED_COORDINATE'}))};
   if(points.size===1)return {status:'STORED',...customers,point:{...points.values().next().value,coordinateSource:'STAGE_PRESERVED_COORDINATE'}};
   if(isCode||!official)return {status:'STORED_COORDINATE_UNVERIFIED',...customers,
    ...(includeExternalEligibility&&!isCode?{externalEligible:true}:{})};
  }
  if(isCode)return {status:'CUSTOMER_CODE_NOT_FOUND'};
  if(officialError)return {status:'OFFICIAL_ADDRESS_UNAVAILABLE'};
  if(!official)return {status:officialIndex?'ADDRESS_NOT_MATCHED':'OFFICIAL_ADDRESS_INDEX_UNAVAILABLE'};
  const points=(official.points||[[official.lat,official.lng]]).map(([lat,lng])=>safePoint({lat,lng})).filter(Boolean);
  if(official.kind==='CHOOSE'&&points.length>1)return {status:'OFFICIAL_ADDRESS_AMBIGUOUS',...customers,points};
  if(official.coordinateKind==='STORED'&&points.length===1)return {status:'STORED',...customers,point:{...points[0],coordinateSource:'STAGE_PRESERVED_COORDINATE'}};
  if((!official.kind||official.kind==='EXACT')&&points.length===1)return {status:'OFFICIAL',...customers,point:{...points[0],
    coordinateSource:official.coordinateKind==='PARCEL'?'OFFICIAL_PUBLIC_PARCEL':official.coordinateKind==='ADDRESS'?'OFFICIAL_PUBLIC_ADDRESS':'OFFICIAL_PUBLIC_BUILDING'}};
  if(official.reviewOnly)return {status:'OFFICIAL_ADDRESS_REVIEW_REQUIRED',...customers};
  return {status:'OFFICIAL_COORDINATE_UNVERIFIED',...customers};
 });
}
export async function searchCustomerSummaries({query,snapshot,searchMaster,signal,deadline}){
 const rows=snapshot?.rows||[],index=snapshotIndex(snapshot),byCode={get:key=>index.byCode.get(key)?.at(-1)},needle=text(query),exact=byCode.get(query.toUpperCase());
 const addressQuery=!exact&&Boolean(exactAddressKey(query));
 let local;
 if(exact)local=[exact];
 else if(addressQuery)local=rows.length?preservedMatches(query,snapshot).matches.slice(0,50).map(row=>({...row,matchedBy:'ADDRESS'})):[];
 else local=rows.filter(r=>text(r.customerName).includes(needle)||[r.address,r.customerAddress].some(v=>v&&text(v).includes(needle))).slice(0,50);
 if(exact)return {ok:true,data:local.map(projection),meta:{source:'EXISTING_PRODUCTION_SNAPSHOT',matchedBy:'CODE',customerMatchVerified:false,complete:false,currentness:'UNCONFIRMED'}};
 let value,sourceError;
 try{
  if(!searchMaster)throw Error('SEARCH_SOURCE_UNCONFIGURED');
  const payload=await searchMaster(query,{signal,deadline});value=payload?.data;
  if(payload?.ok!==true||value?.contract!=='customer-search-v1'||value.queryHash!==sha(query)||typeof value.complete!=='boolean'||typeof value.truncated!=='boolean'||!Array.isArray(value.rows)||value.rows.length>50||value.rows.some(r=>!code(r.customerCode)||typeof r.customerName!=='string'||r.customerName.length>200||!/^[a-f0-9]{64}$/.test(r.addressHash)||!['CODE','NAME','ADDRESS'].includes(r.matchedBy))||new Set(value.rows.map(r=>r.customerCode)).size!==value.rows.length)throw Error('SEARCH_SOURCE_CONTRACT');
 }catch(error){sourceError=/^(?:SEARCH|HUB|PRIVATE_READER)_[A-Z_]+$/.test(error.message||'')?error.message:'SEARCH_SOURCE_UNAVAILABLE';}
 if(!value||sourceError){if(local.length)return {ok:true,data:local.map(projection),meta:{source:'EXISTING_PRODUCTION_SNAPSHOT',customerMatchVerified:false,complete:false,partial:true,sourceError}};throw Object.assign(Error(sourceError||'SEARCH_SOURCE_UNAVAILABLE'),{code:sourceError});}
 const combined=new Map(local.map(r=>[r.customerCode,projection(r)]));
 for(const row of value.rows){
  if(addressQuery&&row.matchedBy!=='ADDRESS')continue;
  const old=byCode.get(row.customerCode),hash=old?.originalAddressHash||old?.addressHash,changed=!!hash&&hash!==row.addressHash;
  combined.set(row.customerCode,projection({...old,customerCode:row.customerCode,customerName:row.customerName,lat:changed?null:old?.lat??null,lng:changed?null:old?.lng??null,matchedBy:row.matchedBy,addressChanged:changed,coordinateStatus:changed?'CONFLICT':old?.coordinateStatus,sourceUpdatedAt:row.sourceUpdatedAt}));}
 return {ok:true,data:[...combined.values()].slice(0,50),meta:{source:'CUSTOMER_CURRENT_METADATA',customerMatchVerified:value.complete===true,complete:value.complete,truncated:value.truncated||combined.size>50,totalMatches:value.totalMatches,sourceRows:value.sourceRows,currentness:'CURRENT_CUSTOMER_LOOKUP'}};
}
export function mountPrivateCustomerSearch({app,requireStaff,readSnapshot,searchMaster,allowPreservedBatch=false}){
 app.get('/api/map-phase2b/private/customer-search',requireStaff,async(req,res)=>{
  res.set('Cache-Control','private, no-store');let query;
  try{query=decodeURIComponent(req.get('x-map-customer-query')||'').normalize('NFKC').trim();}catch{return res.status(400).json({error:'INVALID_QUERY'});}
  if(query.length<2||query.length>200)return res.status(400).json({error:'INVALID_QUERY'});
  const scope=createPrivateDetailReadScope(req,res,{deadline:Date.now()+17000});
  try{
   const snapshot=await readSnapshot();
   const fromPreserved=allowPreservedBatch&&req.get('x-map-search-scope')==='new-area'&&snapshot?.source==='STAGE_VERIFIED_REGISTRY'&&Array.isArray(snapshot.rows);
   const value=fromPreserved?searchPreservedRegistry(query,snapshot):await searchCustomerSummaries({query,snapshot,searchMaster,signal:scope.signal,deadline:scope.deadline});
   if(!scope.canRespond())return;return await requireStaff(req,res,()=>scope.canRespond()&&res.json(value));
  }
  catch(error){if(scope.canRespond())return res.status(503).json({ok:false,data:null,error:'CUSTOMER_SEARCH_UNAVAILABLE',meta:{customerMatchVerified:false,sourceError:/^(?:SEARCH|HUB|PRIVATE_READER)_[A-Z_]+$/.test(error.code||error.message||'')?error.code||error.message:'SEARCH_SOURCE_UNAVAILABLE'}});}
  finally{scope.dispose();}
 });
}
