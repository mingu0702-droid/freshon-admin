import crypto from 'node:crypto';
import {createPrivateDetailReadScope} from './opsmap-abc/privateDetailRequest.js';
import {prepareRecoveryCoordinateAddress} from './coordinateLookupOutcome.js';
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
 const prepared=prepareRecoveryCoordinateAddress(address);
 if(!prepared.query||!['ROAD','LOT'].includes(prepared.addressKind))return null;
 return text(prepared.query).replace(/^(서울)(?:특별시|시)/,'$1').replace(/^(부산|대구|인천|광주|대전|울산)광역시/,'$1')
  .replace(/^경기도/,'경기').replace(/^강원(?:특별자치도|도)/,'강원').replace(/^제주(?:특별자치도|도)/,'제주')
  .replace(/^전북특별자치도/,'전북').replace(/^전라([북남])도/,'전$1').replace(/^충청([북남])도/,'충$1').replace(/^경상([북남])도/,'경$1');
}
export function searchPreservedRegistry(query,snapshot){
 const rows=snapshot.rows,index=snapshotIndex(snapshot);
 const matchedBy=code(query.toUpperCase())?'CODE':'ADDRESS';
 if(matchedBy==='ADDRESS'&&!index.byAddress){
  const byAddress=new Map();
  for(const row of rows){const key=exactAddressKey(row.address);if(!key||!code(row.customerCode))continue;
   const matches=byAddress.get(key)||[];matches.push(row);byAddress.set(key,matches);}
  index.byAddress=byAddress;
 }
 const matches=matchedBy==='CODE'?index.byCode.get(query.toUpperCase())||[]:index.byAddress.get(exactAddressKey(query))||[];
 return {ok:true,data:matches.slice(0,50).map(row=>({...projection(row),matchedBy})),
  meta:{source:'STAGE_VERIFIED_REGISTRY',currentness:'PRESERVED_VALIDATION',customerMatchVerified:false,complete:false,truncated:matches.length>50}};
}
export async function searchCustomerSummaries({query,snapshot,searchMaster,signal,deadline}){
 const rows=snapshot?.rows||[],index=snapshotIndex(snapshot),byCode={get:key=>index.byCode.get(key)?.at(-1)},needle=text(query),exact=byCode.get(query.toUpperCase());
 const local=exact?[exact]:rows.filter(r=>text(r.customerName).includes(needle)||[r.address,r.customerAddress].some(v=>v&&text(v).includes(needle))).slice(0,50);
 if(exact)return {ok:true,data:local.map(projection),meta:{source:'EXISTING_PRODUCTION_SNAPSHOT',matchedBy:'CODE',customerMatchVerified:false,complete:false,currentness:'UNCONFIRMED'}};
 let value,sourceError;
 try{
  if(!searchMaster)throw Error('SEARCH_SOURCE_UNCONFIGURED');
  const payload=await searchMaster(query,{signal,deadline});value=payload?.data;
  if(payload?.ok!==true||value?.contract!=='customer-search-v1'||value.queryHash!==sha(query)||typeof value.complete!=='boolean'||typeof value.truncated!=='boolean'||!Array.isArray(value.rows)||value.rows.length>50||value.rows.some(r=>!code(r.customerCode)||typeof r.customerName!=='string'||r.customerName.length>200||!/^[a-f0-9]{64}$/.test(r.addressHash)||!['CODE','NAME','ADDRESS'].includes(r.matchedBy))||new Set(value.rows.map(r=>r.customerCode)).size!==value.rows.length)throw Error('SEARCH_SOURCE_CONTRACT');
 }catch(error){sourceError=/^(?:SEARCH|HUB|PRIVATE_READER)_[A-Z_]+$/.test(error.message||'')?error.message:'SEARCH_SOURCE_UNAVAILABLE';}
 if(!value||sourceError){if(local.length)return {ok:true,data:local.map(projection),meta:{source:'EXISTING_PRODUCTION_SNAPSHOT',customerMatchVerified:false,complete:false,partial:true,sourceError}};throw Object.assign(Error(sourceError||'SEARCH_SOURCE_UNAVAILABLE'),{code:sourceError});}
 const combined=new Map(local.map(r=>[r.customerCode,projection(r)]));
 for(const row of value.rows){const old=byCode.get(row.customerCode),hash=old?.originalAddressHash||old?.addressHash,changed=!!hash&&hash!==row.addressHash;
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
