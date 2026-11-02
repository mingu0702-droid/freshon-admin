import {driverVehicle,driverPhone} from './privateDriverContact.js';
import {assertDeliverySourceObservation,sourceTaskDate} from './snapshotRefreshEvidence.js';

const text=v=>typeof v==='string'?v.normalize('NFKC').trim():'';
const day=v=>sourceTaskDate(v);
const fail=(code,status=503)=>Object.assign(Error(code),{code,status});
const name=v=>{const s=text(v);return s&&s.length<=100&&!/[\r\n]/.test(s)&&!/^(?:미확인|미상|미등록|unknown|null|undefined|\[?redacted\]?)$/i.test(s)?s:null;};

async function boundedRead(read,budget){
  budget.check();
  const signal=budget.signal;
  let abort;
  try{
    const value=await Promise.race([Promise.resolve().then(read),new Promise((_,reject)=>{
      abort=()=>reject(signal.reason||Object.assign(Error('HISTORY_UPSTREAM_TIMEOUT'),{name:'AbortError'}));
      if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    })]);
    budget.check();return value;
  }finally{if(abort)signal.removeEventListener('abort',abort);}
}

// One selected/last-observed date through the existing cached/inflight reader.
// Never a collector, current-driver substitution, period scan, or source write.
export function createStoredStaffDriverHistoryReader({readSnapshot,readObservedDeliveryDate}={}){
  return async({customerCode,startDate,endDate},{budget}={})=>{
    if(!budget?.signal||typeof budget.check!=='function')throw fail('HISTORY_REQUEST_BUDGET_REQUIRED');
    if(!/^[A-Z]\d{3,}$/.test(customerCode)||day(startDate)!==startDate||day(endDate)!==endDate||startDate>endDate)throw fail('HISTORY_INVALID_INPUT',400);
    if(!readSnapshot||!readObservedDeliveryDate)throw fail('HISTORY_STORED_READER_UNAVAILABLE');
    const snapshot=await boundedRead(()=>readSnapshot(),budget);
    if(!Array.isArray(snapshot?.rows))throw fail('HISTORY_SNAPSHOT_UNAVAILABLE');
    const customer=snapshot.rows.find(row=>text(row?.customerCode||row?.code).toUpperCase()===customerCode);
    const hints=new Set(),add=v=>{const date=day(v);if(date&&date>=startDate&&date<=endDate)hints.add(date);};
    for(const row of [...(Array.isArray(customer?.history)?customer.history:[]),...(Array.isArray(customer?.relations)?customer.relations:[])])add(row?.deliveryDate||row?.date);
    if(customer?.isActualDateStop===true)add(customer.lastDeliveryDate);
    // Explicit single-day requests do not depend on a 90-day read model.
    if(customer&&startDate===endDate)add(startDate);
    const date=[...hints].sort().at(-1),result=[];
    if(!date)return {data:result,meta:{source:'EXISTING_DELIVERY_DATE_READER',readModel:null,coverage:'OBSERVED_DATE_ONLY_RANGE_UNCONFIRMED',coverageComplete:false,verifiedDates:[],recordState:customer?'NO_DATED_ASSIGNMENT_EVIDENCE':'CUSTOMER_NOT_IN_SNAPSHOT',checkedRecordDates:[],dateReadCount:0,projectionLimited:true}};
    let live;
    try{live=await boundedRead(()=>readObservedDeliveryDate(date),budget);}
    catch(error){if(error?.name==='AbortError'||budget.signal.aborted)throw error;throw fail('HISTORY_DELIVERY_SOURCE_UNAVAILABLE');}
    try{assertDeliverySourceObservation(live?.sourceObservation,date);}catch{throw fail('HISTORY_SOURCE_IDENTITY_MISMATCH',409);}
    if(live?.date!==date||!Array.isArray(live.vehicles))throw fail('HISTORY_SOURCE_IDENTITY_MISMATCH',409);
    const seenVehicles=new Set();
    for(const route of live.vehicles){
      if(!route||typeof route!=='object')throw fail('HISTORY_SOURCE_IDENTITY_MISMATCH',409);
      if(!Array.isArray(route.stops)||route.stops.some(stop=>!stop||typeof stop!=='object'))throw fail('HISTORY_SOURCE_IDENTITY_MISMATCH',409);
      const matches=route.stops.filter(row=>text(row.customerCode||row.code).toUpperCase()===customerCode);
      if(!matches.length)continue;
      const vehicle=driverVehicle(route.vehicle);
      if(!vehicle||seenVehicles.has(vehicle)||day(route.date||live.date)!==date||!Array.isArray(route.stops))throw fail('HISTORY_SOURCE_IDENTITY_MISMATCH',409);
      seenVehicles.add(vehicle);
      if(matches.some(stop=>(stop.vehicle&&driverVehicle(stop.vehicle)!==vehicle)||(stop.deliveryDate&&day(stop.deliveryDate)!==date)))throw fail('HISTORY_SOURCE_IDENTITY_MISMATCH',409);
      for(const stop of matches){
        // Only the exact dated task's identity; never a current master/route label.
        const driverName=name(stop.driverName);
        result.push({deliveryDate:date,vehicle,driverName,driverPhone:driverName?driverPhone(stop.driverPhone):null,
          deliveryId:text(stop.deliveryId)||null,kind:stop.kind==='COMPLETED'||stop.status==='COMPLETED'?'COMPLETED':'ASSIGNED',driverState:driverName?'DATED_SOURCE':'UNOBSERVED'});
      }
    }
    return {data:result,meta:{source:'DELIVERY_ADMIN_DATE_OBSERVATION',readModel:null,coverage:'OBSERVED_DATE_ONLY_RANGE_UNCONFIRMED',coverageComplete:false,verifiedDates:[],
      recordState:result.length?'DATED_RECORDS_OBSERVED':'NO_MATCHING_RECORD',checkedRecordDates:[date],sourceReadFailures:0,dateReadCount:1,projectionLimited:startDate!==endDate||hints.size>1}};
  };
}
