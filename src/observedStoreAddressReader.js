import {assertDeliverySourceObservation} from './snapshotRefreshEvidence.js';
// Selected store/date only, through the existing cached Delivery date reader.
// This is dated delivery evidence, never a current Customer-master substitute.
export function createObservedStoreAddressReader({readSnapshot,readObservedDeliveryDate}={}){
 return async({customerCode,date})=>{
  if(!/^[A-Z]\d{3,}$/.test(customerCode||'')||!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!readSnapshot||!readObservedDeliveryDate)return null;
  const snapshot=await readSnapshot(),known=snapshot?.rows?.find(r=>r.customerCode===customerCode);
  if(!known||known.lastDeliveryDate!==date)return null;
  const live=await readObservedDeliveryDate(date);assertDeliverySourceObservation(live?.sourceObservation,date);
  if(live.date!==date||!Array.isArray(live.vehicles))throw Error('ADDRESS_SOURCE_DATE_MISMATCH');
  const rows=live.vehicles.flatMap(v=>(v.stops||[]).filter(r=>String(r.customerCode||r.code||'').trim().toUpperCase()===customerCode));
  if(!rows.length)return null;
  const addresses=new Set(rows.map(r=>String(r.address||'').normalize('NFKC').replace(/\s+/g,' ').trim()));
  if(addresses.size!==1||!addresses.values().next().value)throw Error('ADDRESS_SOURCE_CONFLICT');
  return{customerCode,customerName:rows[0].customerName||rows[0].name||known.customerName||'',customerAddress:rows[0].address,
   detailAddress:null,deliveryDate:date,sourceObservedAt:live.generatedAt};
 };
}
