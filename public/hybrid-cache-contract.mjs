import {isDay,validActualVehicle} from './hybrid-map-contract.mjs';
const only=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const token=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
export function checkDateCatalog(c){
 if(!only(c,['schema','version','basis','completedThrough','expectedThrough','completionVerified','gaps','startDate','endDate','days','publication'])||c.schema!=='hybrid-date-catalog-v1'||c.publication!=='PUBLISHED'||!token(c.version)||!token(c.basis)||!isDay(c.startDate)||!isDay(c.endDate)||c.startDate>c.endDate||c.completedThrough!==c.endDate||c.expectedThrough!==c.completedThrough||c.completionVerified!==true||!Array.isArray(c.gaps)||c.gaps.length||!Array.isArray(c.days)||c.days.length>5000)throw Error('HYBRID_DATE_CATALOG_UNAVAILABLE');
 const dates=new Set();for(const r of c.days){if(!only(r,['date','revision','basis','kind','source','complete','verified','hash','count','bytes'])||!isDay(r.date)||dates.has(r.date)||r.basis!==c.basis||r.kind!=='period'||r.source!=='Freshon'||!token(r.revision)||r.verified!==true||r.complete!==true||!/^[a-f0-9]{64}$/.test(r.hash)||!Number.isSafeInteger(r.count)||r.count<0||r.count>20000||!Number.isSafeInteger(r.bytes)||r.bytes<2||r.bytes>4194304)throw Error('HYBRID_DATE_CATALOG_UNAVAILABLE');dates.add(r.date);}return c;
}
const plain=(v,n)=>typeof v==='string'&&v.length<=n&&!/[\r\n\x00-\x1f]|비밀번호|출입번호|도어락|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}|bearer\s|(?:password|token|secret)\s*[:=]/i.test(v);
// Persist only verified, public business master fields. Never copy arbitrary UI rows.
export function publicMasterSnapshot(value){
 if(!Array.isArray(value?.data)||value.data.length>15000)throw Error('CACHE_MASTER');
 const meta=value.meta,keys=['complete','periodHistoryLoaded','sourceObservedAt','startDate','endDate','version','sourceGeneration'];
 if(!meta||meta.complete!==true||meta.periodHistoryLoaded!==false||!Number.isSafeInteger(meta.version)||meta.version<1||!Number.isSafeInteger(meta.sourceGeneration)||meta.sourceGeneration<1||!isDay(meta.startDate)||!isDay(meta.endDate)||!Number.isFinite(Date.parse(meta.sourceObservedAt)))throw Error('CACHE_MASTER');
 const codes=new Set(),data=value.data.map(r=>{
  if(!r||!/^[A-Z]\d+$/.test(r.customerCode)||codes.has(r.customerCode)||!plain(r.customerName,200)||!plain(r.address,250)||!plain(r.deliveryPattern,80)||!validActualVehicle(r.baseVehicle)||!Array.isArray(r.weekdayVehicles)||r.weekdayVehicles.length!==7||r.weekdayVehicles.some(v=>!/^\d{0,3}$/.test(v))||!(r.lat===null&&r.lng===null||Number.isFinite(r.lat)&&r.lat>=33&&r.lat<=39.5&&Number.isFinite(r.lng)&&r.lng>=124&&r.lng<=132))throw Error('CACHE_MASTER');
  codes.add(r.customerCode);const s=r.residentSummary;
  if(!only(s,['verified','scope','startDate','endDate','count','lastDeliveryDate'])||typeof s.verified!=='boolean'||s.scope!=='PUBLISHED_ONLY'||!isDay(s.startDate)||!isDay(s.endDate)||!Number.isSafeInteger(s.count)||s.count<0||s.lastDeliveryDate!==''&&!isDay(s.lastDeliveryDate))throw Error('CACHE_MASTER');
  return {customerCode:r.customerCode,customerName:r.customerName,address:r.address,lat:r.lat,lng:r.lng,deliveryPattern:r.deliveryPattern,vehicle:r.baseVehicle,baseVehicle:r.baseVehicle,weekdayVehicles:[...r.weekdayVehicles],lastDeliveryDate:s.lastDeliveryDate,history:[],relations:[],residentSummary:{...s}};
 });
 return {ok:true,data,meta:Object.fromEntries(keys.map(k=>[k,meta[k]]))};
}
export function checkSnapshot(kind,value){
 if(kind==='catalog')return checkDateCatalog(value);
 if(kind==='general'){const safe=publicMasterSnapshot(value);if(JSON.stringify(safe)!==JSON.stringify(value))throw Error('CACHE_PROTECTED_OR_INVALID');return value;}
 throw Error('CACHE_KIND');
}

