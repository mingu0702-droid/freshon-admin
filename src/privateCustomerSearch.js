import crypto from 'node:crypto';
import {createPrivateDetailReadScope} from './privateDetailRequest.js';
const code=v=>typeof v==='string'&&/^[A-Z]\d{1,20}$/.test(v);
const text=v=>String(v??'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,'');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function projection(row){
 const fields=['customerCode','customerName','lat','lng','coordinateSource','coordinateAccuracy','coordinateStatus','originalAddressHash','addressHash','addressChanged','resolutionStatus','sourceUpdatedAt','matchedBy','baseVehicle','baseVehicleGroup','baseVehicleState','baseVehicleSource','baseVehicleVersion','baseVehicleCheckedAt','baseVehicleStale','dispatchCenterCode','center','region','lastDeliveryDate'];
 const r=Object.fromEntries(fields.filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]]));
 if(/비밀번호|보안키|bearer\s|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/i.test(r.customerName||''))r.customerName=r.customerCode;
 return r;
}
export async function searchCustomerSummaries({query,snapshot,searchMaster,signal,deadline}){
 const rows=snapshot?.rows||[],byCode=new Map(rows.filter(r=>code(r.customerCode)).map(r=>[r.customerCode,r])),needle=text(query),exact=byCode.get(query.toUpperCase());
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
export function mountPrivateCustomerSearch({app,requireStaff,readSnapshot,searchMaster}){
 app.get('/api/map-phase2b/private/customer-search',requireStaff,async(req,res)=>{
  res.set('Cache-Control','private, no-store');let query;
  try{query=decodeURIComponent(req.get('x-map-customer-query')||'').normalize('NFKC').trim();}catch{return res.status(400).json({error:'INVALID_QUERY'});}
  if(query.length<2||query.length>200)return res.status(400).json({error:'INVALID_QUERY'});
  const scope=createPrivateDetailReadScope(req,res,{deadline:Date.now()+17000});
  try{const value=await searchCustomerSummaries({query,snapshot:await readSnapshot(),searchMaster,signal:scope.signal,deadline:scope.deadline});if(!scope.canRespond())return;return await requireStaff(req,res,()=>scope.canRespond()&&res.json(value));}
  catch(error){if(scope.canRespond())return res.status(503).json({ok:false,data:null,error:'CUSTOMER_SEARCH_UNAVAILABLE',meta:{customerMatchVerified:false,sourceError:/^(?:SEARCH|HUB|PRIVATE_READER)_[A-Z_]+$/.test(error.code||error.message||'')?error.code||error.message:'SEARCH_SOURCE_UNAVAILABLE'}});}
  finally{scope.dispose();}
 });
}
