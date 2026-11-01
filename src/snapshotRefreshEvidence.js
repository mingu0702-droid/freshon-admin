// Read observations certify only the selected date, never collection/publication.
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const nextDay=value=>new Date(Date.parse(value)+86400000).toISOString().slice(0,10);
export function sourceTaskDate(value){
 if(validDay(value))return value;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value)||!validDay(value.slice(0,10))||!/(?:Z|[+-]\d\d:\d\d)$/.test(value))return null;
 const ms=Date.parse(value);return Number.isFinite(ms)?new Date(ms+9*3600000).toISOString().slice(0,10):null;
}
export function deliverySourceObservation(rows,{date,complete=false,pages=0,resolveVehicle=()=>''}={}){
 if(!validDay(date)||!Array.isArray(rows)||!Number.isInteger(pages)||pages<0||pages>20)throw Error('DELIVERY_OBSERVATION_CONTRACT');
 let matchingDateRows=0,wrongDateRows=0,unverifiedDateRows=0,unassignedRows=0,conflictingDateRows=0;
 for(const row of rows){
  const observed=sourceTaskDate(row?.enteringDatedAt??row?.deliveryDate??row?.carrier?.enteringDatedAt);
  const knownDates=[row?.enteringDatedAt,row?.deliveryDate,row?.carrier?.enteringDatedAt].map(sourceTaskDate).filter(Boolean);
  if(new Set(knownDates).size>1)conflictingDateRows++;
  if(!observed)unverifiedDateRows++;else if(observed===date)matchingDateRows++;else wrongDateRows++;
  if(!resolveVehicle(row))unassignedRows++;
 }
 return {source:'DELIVERY_ADMIN_READ',requestedDate:date,complete:complete===true,pages,responseRows:rows.length,matchingDateRows,wrongDateRows,unverifiedDateRows,unassignedRows,conflictingDateRows,dateVerified:rows.length>0&&matchingDateRows===rows.length&&conflictingDateRows===0};
}
export function assertDeliverySourceObservation(value,date){
 const fail=code=>{throw Object.assign(Error(code),{code});};
 if(!validDay(date)||value?.source!=='DELIVERY_ADMIN_READ'||value.requestedDate!==date)fail('DELIVERY_SOURCE_OBSERVATION_CONTRACT');
 const counts=['responseRows','matchingDateRows','wrongDateRows','unverifiedDateRows','unassignedRows'];
 if(counts.some(key=>!Number.isSafeInteger(value[key])||value[key]<0)||value.responseRows!==value.matchingDateRows+value.wrongDateRows+value.unverifiedDateRows||value.unassignedRows>value.responseRows||!Number.isSafeInteger(value.conflictingDateRows??0)||(value.conflictingDateRows??0)<0||(value.conflictingDateRows??0)>value.responseRows||!Number.isSafeInteger(value.pages)||value.pages<1||value.pages>20)fail('DELIVERY_SOURCE_OBSERVATION_CONTRACT');
 if(value.wrongDateRows||(value.conflictingDateRows||0)>0)fail('DELIVERY_SOURCE_DATE_MISMATCH');
 if(value.unverifiedDateRows)fail('DELIVERY_SOURCE_DATE_UNVERIFIED');
 if(value.complete!==true)fail('DELIVERY_SOURCE_INCOMPLETE');
 if(value.responseRows>0&&(value.dateVerified!==true||value.matchingDateRows!==value.responseRows))fail('DELIVERY_SOURCE_DATE_UNVERIFIED');
 return value;
}
export function deliverySourceReadState(value,{date,sourceFailed=false}={}){
 if(sourceFailed)return 'SOURCE_FAILED';
 try{assertDeliverySourceObservation(value,date);}catch(error){return error.code==='DELIVERY_SOURCE_DATE_MISMATCH'?'SOURCE_DATE_MISMATCH':error.code==='DELIVERY_SOURCE_DATE_UNVERIFIED'?'SOURCE_DATE_UNVERIFIED':error.code==='DELIVERY_SOURCE_INCOMPLETE'?'SOURCE_INCOMPLETE':'SOURCE_UNVERIFIED';}
 return value.responseRows===0?'NO_DISPATCH_OBSERVED':'SOURCE_DATE_OBSERVED';
}
export function snapshotRefreshEvidence({targetDate,previousThrough,completedDates=[],todayStatus=null,sourceFailed=false,checkedAt=new Date().toISOString()}={}){
 if(!validDay(targetDate)||previousThrough!==null&&(!validDay(previousThrough)||previousThrough>targetDate)||!Array.isArray(completedDates)||!Number.isFinite(Date.parse(checkedAt)))throw Error('SNAPSHOT_REFRESH_EVIDENCE_CONTRACT');
 let through=previousThrough;
 for(const date of completedDates){if(through===null||!validDay(date)||date!==nextDay(through)||date>targetDate)throw Error('SNAPSHOT_CHECKPOINT_NOT_CONTIGUOUS');through=date;}
 const backlog=through===null||through<targetDate,e=todayStatus?.sourceObservation;
 const sourceRead=e?.source==='DELIVERY_ADMIN_READ'&&e.requestedDate===targetDate&&todayStatus?.date===targetDate;
 const sourceReadState=deliverySourceReadState(sourceRead?e:null,{date:targetDate,sourceFailed});
 const actualCurrent=sourceReadState==='SOURCE_DATE_OBSERVED';
 const holiday=new Date(targetDate+'T00:00:00Z').getUTCDay()===0?'OSAN_SUNDAY':null;
 const phase=sourceFailed?'SOURCE_FAILED':through===null?'CHECKPOINT_UNVERIFIED':backlog?'PARTIAL':actualCurrent?'SOURCE_DATE_OBSERVED':sourceReadState==='NO_DISPATCH_OBSERVED'?'NO_DISPATCH_OBSERVED':'SOURCE_UNVERIFIED';
 return {refreshedThrough:through,refreshComplete:!backlog&&!sourceFailed&&actualCurrent,
  sourceFreshness:{targetDate,checkedThrough:through,checkedAt,phase,sourceReadState,holiday,sourceDateVerified:actualCurrent,sourceRows:sourceRead&&Number.isSafeInteger(e.responseRows)?e.responseRows:null,sourceReadComplete:sourceRead&&e.complete===true,collectionVerified:false,publicationVerified:false,automaticSyncVerified:false}};
}
