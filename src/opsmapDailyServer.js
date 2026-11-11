import {createHash} from 'node:crypto';
import {mapReadFailure} from './opsmap-abc/mapReadFailure.js';

const text = value => typeof value==='string'?value.trim():'';
const token = value => text(value).toUpperCase().replace(/[\s-]+/g,'_');
const kinds = new Map([
  ['DIRECT_HANDOFF','DIRECT_HANDOFF'],['직접전달','DIRECT_HANDOFF'],
  ['DELIVERY_COMPLETED','DELIVERY_COMPLETED'],['배송완료','DELIVERY_COMPLETED']
]);
const done = new Set(['COMPLETED','DELIVERED','DELIVERY_COMPLETED','배송완료','직접전달']);
const open = new Set(['PENDING','BEFORE','OPEN','INCOMPLETE','ASSIGNED','DISPATCHED','IN_PROGRESS','미완료']);
const individual = new Set(['DRIVER_APP','COURIER_APP','INDIVIDUAL_DRIVER_EVENT']);
const excluded = new Set(['BULK','BATCH','AUTO_CLOSE','SYSTEM','SCHEDULED','ADMIN_BULK','APP_UNUSED','일괄완료','앱미사용']);
const flag = value => value?.bulk===true || value?.batch===true || value?.isBulk===true || value?.isBatch===true ||
  value?.isBulkCompleted===true || value?.batchId!=null || value?.appUsed===false ||
  [value?.source,value?.completionSource,value?.mode,value?.completionType].some(v=>excluded.has(token(v)));
const strictTime = value => typeof value==='string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value.slice(0,10))).toISOString().slice(0,10)===value.slice(0,10);

const utcTime=value=>{
  const fraction=/\.(\d{1,9})(?:Z|[+-]\d\d:\d\d)$/.exec(value)?.[1]||'';
  const normalized=new Date(Date.parse(value)).toISOString();
  return normalized.slice(0,19)+'.'+fraction.padEnd(9,'0')+'Z';
};

// A task status or completedAt by itself cannot distinguish a driver action from a bulk closure.
export function datedCompletionEvent(task) {
  const id=String(task?.id??'');
  if(!/^[A-Za-z0-9_-]{1,96}$/.test(id)||flag(task)||/^CANCEL/.test(token(task?.status||task?.taskStatus)))return null;
  const record=task.completionEvent;
  const events=[...(Array.isArray(task.deliveryEvents)?task.deliveryEvents.slice(0,100):[]), ...(record?[record]:[]),
    {type:task.completionType,status:task.status||task.taskStatus,source:task.completionSource,
      at:task.completedAt||task.completeDatedAt||task.deliveryCompletedAt}];
  let result=null;
  for(const event of events){
    if(!event||flag(event)||event.deliveryId!=null&&String(event.deliveryId)!==id)continue;
    const kind=kinds.get(token(event.type||event.eventType));
    const status=token(event.status||event.resultStatus||task.status||task.taskStatus);
    const at=event.at||event.occurredAt||event.completedAt;
    if(!kind||!done.has(status)||!individual.has(token(event.source||event.completionSource))||!strictTime(at))continue;
    const time=utcTime(at);
    if(!result||time.localeCompare(result.at)<0)result={kind,at:time,individual:true,
      deliveryId:createHash('sha256').update('delivery:'+id).digest('hex')};
  }
  return result;
}

export function validDeliveryPoint(point) {
  const value=v=>typeof v==='number'||typeof v==='string'&&/^-?\d+(?:\.\d+)?$/.test(v)?Number(v):NaN;
  const lat=value(point?.latitude),lng=value(point?.longitude);
  return point?.isEmpty===false&&lat>=33&&lat<=39.5&&lng>=124&&lng<=132;
}
const rawCompletionType=new Map([['DIRECT','DIRECT_HANDOFF'],['BASIC','DELIVERY_COMPLETED'],['FRONT_DOOR','DELIVERY_COMPLETED']]);
export function deliveryStatusRecordEvent(task,record) {
  if(!record||!task||!/^\d{1,20}$/.test(String(task.id))||String(record.taskId)!==String(task.id)
    ||!/^\d{1,20}$/.test(String(record.id))||flag(task)||flag(record)
    ||task.status!=='COMPLETED'||record.status!=='COMPLETED'||record.completeType!==task.completeType
    ||!rawCompletionType.has(record.completeType)||!text(record.createdBy)||excluded.has(token(record.createdBy))||!validDeliveryPoint(record.gpsPosition)
    ||!strictTime(record.createdAt)||!strictTime(task.completeDatedAt)
    ||Math.abs(Date.parse(record.createdAt)-Date.parse(task.completeDatedAt))>2000)return null;
  return {kind:rawCompletionType.get(record.completeType),at:utcTime(record.createdAt),individual:true,
    deliveryId:createHash('sha256').update('delivery:'+task.id).digest('hex')};
}

export function datedStopStatus(task,event) {
  const status=token(task?.status||task?.taskStatus);
  return event||done.has(status)?'COMPLETED':open.has(status)?'PENDING':'UNCONFIRMED';
}

export function datedSourceFailure(error) {
  const code=String(error?.code||error?.message||'').replace(/^HUB_/,'');
  const upstream=Number(error?.diagnostic?.status??error?.upstreamStatus??error?.status);
  if(error?.name==='AbortError'||/TIMEOUT|DEADLINE/.test(code))return {status:504,code:'DATED_SOURCE_TIMEOUT'};
  if(/INCOMPLETE|PARTIAL|^DATED_ASSIGNMENTS_|^DATED_SOURCE_(COUNT|DATE|IDENTITY)|INVALID_DATED_CONTRACT/.test(code))
    return {status:502,code:'DATED_ASSIGNMENTS_INCOMPLETE'};
  if([401,403,429,500,502,503].includes(upstream))return {status:upstream,code:'DATED_SOURCE_HTTP_'+upstream};
  if(error?.failureType==='auth'||/AUTH|SESSION_REQUIRED/.test(code))return {status:401,code:'DATED_SOURCE_AUTH_REQUIRED'};
  const failure=mapReadFailure(error,'DELIVERY');
  return {status:failure.status,code:failure.code};
}

export function dailyAssignmentContract(value,{generatedAt=new Date().toISOString(),sourceGeneration}={}) {
  const {meta,data}=value;
  const vehicles=new Map();
  for(const row of data){
    const vehicle=row.confirmedVehicle||row.vehicle||'미확인';
    const count=vehicles.get(vehicle)||{vehicle,plannedStops:0,completedStops:0,pendingStops:0,unknownStops:0};
    count.plannedStops++;
    count[row.status==='COMPLETED'?'completedStops':row.status==='PENDING'?'pendingStops':'unknownStops']++;
    vehicles.set(vehicle,count);
  }
  const revision=createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return {...value,meta:{...meta,contract:'opsmap-daily-v1',rowCount:data.length,plannedStops:data.length,vehicles:[...vehicles.values()],
    checkedAt:meta.generatedAt||generatedAt,sourceGeneration:meta.sourceGeneration??sourceGeneration??null,sourceRevision:revision}};
}
