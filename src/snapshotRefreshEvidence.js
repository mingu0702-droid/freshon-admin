// Read observations certify only the selected date, never collection/publication.
const validDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const nextDay=value=>new Date(Date.parse(value)+86400000).toISOString().slice(0,10);
export function sourceTaskDate(value){
 if(validDay(value))return value;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(value)||!/(?:Z|[+-]\d\d:\d\d)$/.test(value))return null;
 const ms=Date.parse(value);return Number.isFinite(ms)?new Date(ms+9*3600000).toISOString().slice(0,10):null;
}
export function deliverySourceObservation(rows,{date,complete=false,pages=0,resolveVehicle=()=>''}={}){
 if(!validDay(date)||!Array.isArray(rows)||!Number.isInteger(pages)||pages<0||pages>20)throw Error('DELIVERY_OBSERVATION_CONTRACT');
 let matchingDateRows=0,wrongDateRows=0,unverifiedDateRows=0,unassignedRows=0;
 for(const row of rows){
  const observed=sourceTaskDate(row?.enteringDatedAt??row?.deliveryDate??row?.carrier?.enteringDatedAt);
  if(!observed)unverifiedDateRows++;else if(observed===date)matchingDateRows++;else wrongDateRows++;
  if(!resolveVehicle(row))unassignedRows++;
 }
 return {source:'DELIVERY_ADMIN_READ',requestedDate:date,complete:complete===true,pages,responseRows:rows.length,matchingDateRows,wrongDateRows,unverifiedDateRows,unassignedRows,dateVerified:rows.length>0&&matchingDateRows===rows.length};
}
export function snapshotRefreshEvidence({targetDate,previousThrough,completedDates=[],todayStatus=null,sourceFailed=false,checkedAt=new Date().toISOString()}={}){
 if(!validDay(targetDate)||!validDay(previousThrough)||previousThrough>targetDate||!Array.isArray(completedDates)||!Number.isFinite(Date.parse(checkedAt)))throw Error('SNAPSHOT_REFRESH_EVIDENCE_CONTRACT');
 let through=previousThrough;
 for(const date of completedDates){if(!validDay(date)||date!==nextDay(through)||date>targetDate)throw Error('SNAPSHOT_CHECKPOINT_NOT_CONTIGUOUS');through=date;}
 const backlog=through<targetDate,e=todayStatus?.sourceObservation;
 const sourceRead=e?.source==='DELIVERY_ADMIN_READ'&&e.requestedDate===targetDate&&todayStatus?.date===targetDate;
 const actualCurrent=sourceRead&&e.complete===true&&e.dateVerified===true&&Number.isSafeInteger(e.responseRows)&&e.responseRows>0&&e.matchingDateRows===e.responseRows&&e.wrongDateRows===0&&e.unverifiedDateRows===0;
 const holiday=new Date(targetDate+'T00:00:00Z').getUTCDay()===0?'OSAN_SUNDAY':null;
 const phase=backlog?'PARTIAL':sourceFailed?'SOURCE_FAILED':actualCurrent?'SOURCE_DATE_OBSERVED':sourceRead&&e.complete===true&&e.responseRows===0?'NO_DISPATCH_OBSERVED':'SOURCE_UNVERIFIED';
 return {refreshedThrough:through,refreshComplete:!backlog&&!sourceFailed&&actualCurrent,
  sourceFreshness:{targetDate,checkedThrough:through,checkedAt,phase,holiday,sourceDateVerified:actualCurrent,sourceRows:sourceRead&&Number.isSafeInteger(e.responseRows)?e.responseRows:null,sourceReadComplete:sourceRead&&e.complete===true,collectionVerified:false,publicationVerified:false,automaticSyncVerified:false}};
}
