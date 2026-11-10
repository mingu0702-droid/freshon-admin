import {createHash} from 'node:crypto';
import {sourceTaskDate} from './snapshotRefreshEvidence.js';
import {SYNC_DELIVERY_SOURCES} from './opsmapSyncPolicy.js';

export const DATED_DELIVERY_CONTRACT = 'opsmap-dated-delivery-v1';
export const deliveryDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const deliveryTaskId = id => createHash('sha256').update('delivery:'+id).digest('hex');
export const vehicleId = value => {
  const id = String(value ?? '').trim().replace(/\s+/g, '').replace(/(?:호차|호|번)$/, '');
  return /^(?:[용척]?\d{1,4})(?:-\d{1,3})?$/.test(id) ? id : null;
};

export function confirmedTaskVehicle(task) {
  const carrier = task.carrier || task.carrierInfo || task.driver || {};
  const candidates = [task.confirmedVehicle, task.fixedNo, task.fixed_no, task.fixedNumber,
    task.fixedVehicleNo, task.carrierNo, task.vehicleNo, task.vehicle, carrier.fixedNo,
    carrier.fixed_no, carrier.fixedNumber, carrier.carrierNo, carrier.vehicleNo];
  let confirmed=null;
  for(const value of candidates) {
    if (value==null||value==='') continue;
    const id=vehicleId(value);
    if (id&&confirmed&&id!==confirmed) throw Object.assign(Error('DELIVERY_SOURCE_VEHICLE_CONFLICT'), {code:'DELIVERY_SOURCE_VEHICLE_CONFLICT'});
    if (id) confirmed=id;
  }
  return confirmed||vehicleId(carrier.name);
}

const completed = new Set(['COMPLETED', 'DELIVERED', 'DIRECT_DELIVERY', '배송완료', '직접전달']);
const open = new Set(['OPEN','BEFORE','PENDING','READY','ASSIGNED','IN_PROGRESS','DISPATCHED','WAITING','REQUESTED',
  'FAILED','FAIL','MISSED','MISSING','미완료','배송중']);
const typeSet = new Set(['DIRECT_HANDOFF','DELIVERY_COMPLETED','ADMIN_BULK','ADMIN_BULK_17','NO_INDIVIDUAL_RECORD','TIME_UNVERIFIED']);
const verificationSet = new Set(['VERIFIED_INDIVIDUAL','BULK_CONFIRMED','NO_INDIVIDUAL_RECORD','TIME_UNVERIFIED','EVENT_CONFLICT']);
const provenanceSet = new Set(['TASK_STATUS_RECORD','DELIVERY_TASK','DELIVERY_TASK_LIST']);
const sourceStatuses = new Set([...completed,...open,'CANCELLED','UNKNOWN']);
const tag = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const statusValue = task => tag(task.status || task.taskStatus || task.statusText);

export function deliveryTaskState(task) {
  const status = statusValue(task);
  if (/^CANCEL/.test(status) || status === '취소') return 'CANCELLED';
  return completed.has(status) ? 'COMPLETED' : 'OPEN';
}

function timestamp(value, date) {
  if (typeof value !== 'string' || !value.includes('T')) return null;
  const day=sourceTaskDate(value);
  const next=new Date(Date.parse(date)+86_400_000).toISOString().slice(0,10);
  if (day!==date && day!==next) return null;
  return new Date(value).toISOString();
}

function markers(record) {
  const origin = tag(record.eventSource || record.completionSource || record.channel);
  const action = tag(record.eventType || record.action);
  const batchId = [record.batchId,record.bulkJobId].some(value=>
    typeof value === 'string' && !!value.trim() || Number.isSafeInteger(value) && value > 0);
  const scheduled = ['SCHEDULED_BULK_17','ADMIN_BULK_17'].includes(action);
  const bulk = record.isBulk === true || record.bulkProcessed === true || batchId || scheduled ||
    ['ADMIN_BULK','BULK_COMPLETE','BATCH_COMPLETE'].some(marker=>marker===origin||marker===action);
  const individual = record.individualCompletion === true || origin === 'DRIVER_APP' || action === 'DRIVER_APP_COMPLETE';
  return {bulk, individual, scheduled};
}

function verifiedGpsRecord(record,task) {
  const g=record.gpsPosition;
  const lat=Number(g?.latitude),lng=Number(g?.longitude);
  const method=tag(record.completeType);
  return /^\d{1,20}$/.test(String(record.id??'')) && String(record.taskId)===String(task.id) &&
    !!method && method===tag(task.completeType) && g?.isEmpty===false && lat>=33 && lat<=39.5 && lng>=124 && lng<=132;
}

export function deliveryCompletion(task, {date, customerCode, vehicle}) {
  const sourceStatus = statusValue(task);
  const state = deliveryTaskState(task);
  const base = {sourceStatus:completed.has(sourceStatus) || open.has(sourceStatus) ? sourceStatus : state === 'CANCELLED' ? 'CANCELLED' : 'UNKNOWN',
    completionType:'NO_INDIVIDUAL_RECORD', individualCompletedAt:null, bulkProcessed:null,
    eventSource:'DELIVERY_TASK_LIST', verification:'NO_INDIVIDUAL_RECORD'};
  if (state !== 'COMPLETED') return base;
  if (!task.taskStatusRecords && !task.taskStatusRecord) {
    const mode=markers(task);
    if (!mode.bulk && !mode.individual) return base;
  }
  const inline = task.taskStatusRecords ?? task.taskStatusRecord ?? [];
  const records = Array.isArray(inline) ? inline : [inline];
  if (records.length > 32) return {...base, verification:'EVENT_CONFLICT'};
  const matches = new Map();
  let bulk = null, incomplete = null;
  for (const [index, record] of [...records, task].entries()) {
    if (!record || typeof record !== 'object') continue;
    const source = index === records.length ? 'DELIVERY_TASK' : 'TASK_STATUS_RECORD';
    if (!completed.has(statusValue(record)) || record.taskId != null && String(record.taskId) !== String(task.id) ||
        record.customerErpCode != null && record.customerErpCode !== customerCode ||
        record.customerCode != null && record.customerCode !== customerCode ||
        record.customer?.erpCode != null && record.customer.erpCode !== customerCode ||
        record.deliveryDate != null && sourceTaskDate(record.deliveryDate) !== date ||
        record.vehicle != null && vehicleId(record.vehicle) !== vehicle) continue;
    const mode = markers(record);
    const reported = record.eventAt || record.completedAt || record.completeDatedAt || record.deliveryCompletedAt ||
      (source==='TASK_STATUS_RECORD' ? record.createdAt : null);
    const time = timestamp(reported,date);
    if (mode.bulk) {
      const at17 = time && (new Date(time).getUTCHours()+9)%24 === 17;
      bulk = {...base, completionType:mode.scheduled || at17 ? 'ADMIN_BULK_17' : 'ADMIN_BULK', bulkProcessed:true,
        eventSource:source, verification:'BULK_CONFIRMED'};
      continue;
    }
    if (!mode.individual && !(source==='TASK_STATUS_RECORD' && verifiedGpsRecord(record,task))) continue;
    const sameSourceTime=Math.abs(Date.parse(time)-Date.parse(task.completeDatedAt))<=2000;
    if (!time || !mode.individual&&!sameSourceTime) {
      incomplete={...base,completionType:'TIME_UNVERIFIED',bulkProcessed:false,eventSource:source,verification:'TIME_UNVERIFIED'};
      continue;
    }
    const direct = [record.completeType, record.completeTypeText, statusValue(record)]
      .some(value=>['DIRECT','DIRECT_DELIVERY','DIRECT_HANDOFF','직접전달'].includes(tag(value).replace(/\s+/g,'')));
    const type = direct ? 'DIRECT_HANDOFF' : 'DELIVERY_COMPLETED';
    if (!matches.has(time+'|'+type)) matches.set(time+'|'+type,{...base,completionType:type,individualCompletedAt:time,
      bulkProcessed:false,eventSource:source,verification:'VERIFIED_INDIVIDUAL'});
  }
  if (matches.size > 1) return {...base, verification:'EVENT_CONFLICT'};
  return matches.values().next().value ?? bulk ?? incomplete ?? base;
}

export function validateDatedCompletion(record,date) {
  const time = record?.individualCompletedAt;
  const individual = record?.verification === 'VERIFIED_INDIVIDUAL';
  const bulk = record?.verification === 'BULK_CONFIRMED';
  if (!record || Object.keys(record).length !== 6 || !typeSet.has(record.completionType) ||
      !provenanceSet.has(record.eventSource) || !verificationSet.has(record.verification) ||
      ![true,false,null].includes(record.bulkProcessed) ||
      !sourceStatuses.has(record.sourceStatus) ||
      (individual ? timestamp(time,date) !== time || !time || record.bulkProcessed !== false ||
        !['DIRECT_HANDOFF','DELIVERY_COMPLETED'].includes(record.completionType) : time !== null) ||
      bulk !== (record.bulkProcessed === true) || bulk !== record.completionType.startsWith('ADMIN_BULK') ||
      !individual && ['DIRECT_HANDOFF','DELIVERY_COMPLETED'].includes(record.completionType)) throw Error('DELIVERY_EVENT_CONTRACT');
  return record;
}

export function packDatedEvent(sourceId,event) {
  return [sourceId,event.sourceStatus,event.completionType,event.individualCompletedAt,event.bulkProcessed,event.eventSource,event.verification];
}

export function unpackDatedEvent(row) {
  const [,sourceStatus,completionType,individualCompletedAt,bulkProcessed,eventSource,verification]=row;
  return {sourceStatus,completionType,individualCompletedAt,bulkProcessed,eventSource,verification};
}

export function validateDatedDispatch(day) {
  const {contract,sources,events} = day.dispatch || {};
  if (contract!==DATED_DELIVERY_CONTRACT || !Array.isArray(sources) || sources.length<1 || sources.length>4 ||
      !Array.isArray(events) || !Array.isArray(day.tasks) || events.length!==day.tasks.length ||
      sources.length!==day.completeSources?.length) throw Error('DELIVERY_DISPATCH_CONTRACT');
  const stats = new Map();
  const groups = new Map(Object.entries(SYNC_DELIVERY_SOURCES).map(([center,id])=>[id,center==='osanColdStorage'?'osan':center]));
  for (const source of sources) {
    if (!Array.isArray(source) || source.length!==4) throw Error('DELIVERY_DISPATCH_SOURCE');
    const [id,pages,rawRows,duplicateRows]=source;
    if (!groups.has(id) || !day.completeSources.includes(id) || !day.completeCenters.includes(groups.get(id)) || stats.has(id) || !Number.isInteger(pages) || pages<1 || pages>20 ||
        !Number.isInteger(rawRows) || rawRows<0 || rawRows>10000 || !Number.isInteger(duplicateRows) || duplicateRows<0 || duplicateRows>rawRows) {
      throw Error('DELIVERY_DISPATCH_SOURCE');
    }
    stats.set(id,rawRows-duplicateRows);
  }
  for (const [index,event] of events.entries()) {
    const task = day.tasks[index];
    if (!Array.isArray(event) || event.length!==7 || !stats.has(event[0]) || groups.get(event[0])!==task[3]) throw Error('DELIVERY_EVENT_CONTRACT');
    const evidence = validateDatedCompletion(unpackDatedEvent(event),day.date);
    if (deliveryTaskState({status:evidence.sourceStatus})!==task[5] ||
        evidence.individualCompletedAt && !task[2]) throw Error('DELIVERY_EVENT_CONTRACT');
    stats.set(event[0],stats.get(event[0])-1);
  }
  if ([...stats.values()].some(count=>count!==0) ||
      day.proofHash!==deliveryDigest([day.date,day.tasks,day.visits,day.dispatch])) throw Error('DELIVERY_DISPATCH_PROOF');
}

export function datedDispatchSource(rows,counts) {
  return {...counts,unassigned:rows.filter(row=>!row.vehicle&&row.state!=='CANCELLED').length,
    uniqueDeliveries:rows.length,sha256:deliveryDigest(rows)};
}

export function datedDispatchView({date,center,sourceId,vehicle=null,rows,source,at,generation=null,error=null,state,publishedAt=null,eventRead=null}) {
  const timeGroups=new Map();
  for (const row of rows) {
    if (row.verification!=='VERIFIED_INDIVIDUAL' || !row.vehicle || !vehicle) continue;
    const group=timeGroups.get(row.individualCompletedAt)||[];
    group.push(row.deliveryId);
    timeGroups.set(row.individualCompletedAt,group);
  }
  const byTime=[...timeGroups].sort(([a],[b])=>a.localeCompare(b));
  const scopeComplete = !vehicle || source.unassigned===0;
  const verifiedEmpty=scopeComplete&&rows.length===0;
  const activeCount=rows.filter(row=>row.state!=='CANCELLED').length;
  return {contract:DATED_DELIVERY_CONTRACT,date,center,sourceId,vehicle,generation,state,error,
    sourceComplete:true,currentReadComplete:state==='LIVE_VERIFIED',scopeComplete,lastSuccessAt:at,publishedAt,
    previousVerifiedRetained:state!=='LIVE_VERIFIED',
    source,eventRead,count:rows.length,activeCount,sha256:deliveryDigest(rows),confirmedEmpty:verifiedEmpty&&state==='LIVE_VERIFIED',
    lastVerifiedEmpty:verifiedEmpty,rows,chronology:byTime.flatMap(([,ids])=>ids.length===1?ids:[]),
    chronologyTies:byTime.flatMap(([at,ids])=>ids.length>1?[{at,deliveryIds:ids}]:[])};
}

export function archivedDatedDispatch(day,{center,vehicle,generation,publishedAt,lastSuccessAt,error}) {
  const sourceId=SYNC_DELIVERY_SOURCES[center];
  const saved=day?.dispatch?.sources.find(([id])=>id===sourceId);
  if (!saved) return null;
  const [,pages,rawRows,duplicateRows]=saved;
  const rows=day.tasks.flatMap(([deliveryId,customerCode,assigned,,,state],index)=>{
    const event=day.dispatch.events[index];
    return event[0]===sourceId?[{deliveryId,deliveryDate:day.date,customerCode,vehicle:assigned||null,state,...unpackDatedEvent(event)}]:[];
  });
  return datedDispatchView({date:day.date,center,sourceId,vehicle,rows:vehicle?rows.filter(row=>row.vehicle===vehicle):rows,
    source:datedDispatchSource(rows,{pages,rawRows,duplicateRows}),
    at:lastSuccessAt||null,generation,error,state:'PUBLISHED_VERIFIED',publishedAt});
}
