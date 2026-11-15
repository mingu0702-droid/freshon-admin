import {createOperationalPhotoTaskReader} from './opsmapOperationalPhotoTaskReader.js';
import {assertDeliverySourceObservation, sourceTaskDate} from './snapshotRefreshEvidence.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from './stageScope.js';
import {SYNC_DELIVERY_SOURCES} from './opsmapSyncPolicy.js';
import {coordinateAddressHash} from './opsmap-abc/opsmapAutoCoordinates.js';
import {archiveAddressHash} from './stageArchivedDelivery.js';
import {validateOpsmapSyncDay} from './opsmapSyncGeneration.js';
import {createStageDeliveryAdminPhotoSession} from './opsmapStageDeliveryAdminSession.js';
import {createDeliveryAdminPhotoTransport, readBoundedPhotoLoginJson} from './opsmapDeliveryAdminTransport.js';
import {driverPhone, driverVehicle} from './privateDriverContact.js';
import {setTimeout as delay} from 'node:timers/promises';
import {validDeliveryPoint} from './opsmapDailyServer.js';
import {confirmedTaskVehicle, DATED_DELIVERY_CONTRACT, datedDispatchSource, datedDispatchView, deliveryCompletion,
  deliveryDigest, deliveryTaskId, deliveryTaskState, packDatedEvent} from './datedDeliveryContract.js';

const deliveryOrigin = 'https://delivery-bali.chabyulhwa.com';
const error = (code, status) => Object.assign(Error(code), {code, diagnostic:{status}});
const validDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
const field = (...values) => values.find(value => typeof value === 'string' && value.length<=512 && value.trim())?.trim() || '';
const cacheTtl = 60_000;
const staleLimit = 24 * 60 * 60_000;
const focusedVehicles=new Set(['101','105','122','202']);
const vehicleEventLimit=32;

function taskEvent(task,date,customerCode,vehicle) {
  return deliveryCompletion(vehicle?task:{status:task.status,taskStatus:task.taskStatus,statusText:task.statusText},
    {date,customerCode,vehicle:vehicle||null});
}

function eventCandidate(task, state, event, customerCode, vehicle) {
  if (!vehicle || state!=='COMPLETED' || ['VERIFIED_INDIVIDUAL','BULK_CONFIRMED','EVENT_CONFLICT'].includes(event.verification) ||
      !/^[A-Z_]{1,32}$/.test(task.completeType||'') || !Number.isFinite(Date.parse(task.completeDatedAt))) return null;
  const {id,status,completeType,completeDatedAt}=task;
  return {task:{id,status,completeType,completeDatedAt},customerCode,vehicle};
}

export function createStageDatedDeliveryReader({env = process.env, fetchImpl = fetch, syncCenters = {osan:'1'},recordSource,now=Date.now} = {}) {
  const enabled = env.RENDER_EXTERNAL_URL === STAGE_ORIGIN && env.RENDER_SERVICE_ID === STAGE_SERVICE &&
    env.OPSMAP_STAGE_DELIVERY_DATED_ENABLED === '1';
  const cookie = String(env.OPSMAP_STAGE_DELIVERY_DATED_COOKIE || '').trim();
  const dedicated = env.OPSMAP_STAGE_DELIVERY_PHOTO_AUTH_ENABLED === '1';
  const reuse = enabled && env.OPSMAP_STAGE_DELIVERY_DATED_REUSE_APPROVED === '1' &&
    (dedicated || env.OPSMAP_STAGE_DELIVERY_PHOTO_USE_EXISTING_ADMIN === '1');
  const id = dedicated ? env.OPSMAP_STAGE_DELIVERY_PHOTO_ID : env.DELIVERY_ADMIN_ID;
  const password = dedicated ? env.OPSMAP_STAGE_DELIVERY_PHOTO_PASSWORD : env.DELIVERY_ADMIN_PASSWORD;
  const valid = (value,max)=>typeof value==='string'&&value.length<=max&&value.trim()&&!/[\x00-\x1f\x7f]/.test(value);
  const account = reuse && valid(id,256) && valid(password,1024) ? createStageDeliveryAdminPhotoSession({id,password,fetchImpl}) : null;
  const hasSource = enabled && (!!account || /^[\x20-\x7e]{1,8192}$/.test(cookie));
  const request = (url,signal) => account ? account.read(url,{signal}) : fetchImpl(url,{method:'GET',signal,redirect:'error',
    cache:'no-store',headers:{Accept:'application/json',Cookie:cookie}});
  const eventTransport=hasSource&&env.OPSMAP_STAGE_DELIVERY_EVENT_READ_APPROVED==='1' ? createDeliveryAdminPhotoTransport({
    hasApprovedSession:()=>hasSource,timeoutMs:2500,approvedRequest:(path,{signal})=>{
      if(!/^\/api\/bali\/task\/\d{1,20}\/status-record$/.test(path)) throw error('DELIVERY_SOURCE_REQUEST_REJECTED',403);
      return request(new URL(path,deliveryOrigin),signal);
    }}) : null;
  let eventGroups=0;
  async function readEvents(candidates,date,limit,{retryTransient=false}={}) {
    const result={events:new Map(),requested:candidates.length,attempted:0,failed:0,truncated:false};
    if (!eventTransport || !candidates.length) return result;
    if (eventGroups>=2) return {...result,truncated:true};
    eventGroups++;
    try {
      const budget=AbortSignal.timeout(8_000);
      const bounded=candidates.slice(0,limit);
      const retry=[];
      const readOne=async({task,customerCode,vehicle},signal)=>{
        const response=await eventTransport.requestJson(`/api/bali/task/${task.id}/status-record`,{signal});
        const records=response?.data??response;
        if (response?.ok===false || !Array.isArray(records) || records.length>32 || records.some(record=>
          !record || String(record.taskId)!==String(task.id))) throw Error('DELIVERY_EVENT_BINDING');
        return [deliveryTaskId(task.id),deliveryCompletion({...task,taskStatusRecords:records},{date,customerCode,vehicle})];
      };
      for (let offset=0; offset<bounded.length && !budget.aborted; offset+=3) {
        const batch=bounded.slice(offset,offset+3);
        const values=await Promise.all(batch.map(async candidate=>{
          result.attempted++;
          try { return await readOne(candidate,budget); }
          catch (error) {
            if (retryTransient && ['PHOTO_TIMEOUT','PHOTO_UPSTREAM_UNAVAILABLE','PHOTO_LOOKUP_FAILED'].includes(error.code)) retry.push(candidate);
            result.failed++;
            return null;
          }
        }));
        for(const item of values)if(item)result.events.set(...item);
        if(values.every(item=>!item))break;
      }
      result.truncated=result.attempted<candidates.length;
      if (!result.truncated && retry.length) {
        const retryBudget=AbortSignal.timeout(3_000);
        const values=await Promise.allSettled(retry.slice(0,3).map(candidate=>readOne(candidate,retryBudget)));
        for(const item of values) if(item.status==='fulfilled') {
          result.events.set(...item.value);
          result.failed--;
        }
      }
      return result;
    } finally {eventGroups--;}
  }
  const scope = Object.entries(syncCenters || {});
  if (!scope.length || scope.some(([center,id]) => !Object.hasOwn(SYNC_DELIVERY_SOURCES,center) ||
      id!==SYNC_DELIVERY_SOURCES[center])) throw error('DELIVERY_SOURCE_CENTER_CONFIG', 503);
  const readerFor = id => createOperationalPhotoTaskReader({strictDated:true,async rawRequest(path, {method, signal}) {
    const url = new URL(path, deliveryOrigin);
    if (method !== 'GET' || url.origin !== deliveryOrigin || url.pathname !== '/api/bali/task' || url.hash || url.username || url.password) {
      throw error('DELIVERY_SOURCE_REQUEST_REJECTED', 403);
    }
    url.searchParams.set('logisticsCenterId',id);
    return request(url,signal);
  }});
  const read = readerFor('1');
  const readers = new Map(scope.map(([center,id]) => [center,{center,id,reader:id==='1'?read:readerFor(id)}]));
  if (!readers.has('osan')) readers.set('osan',{center:'osan',id:'1',reader:read});

  const inflight = new Map(), cached = new Map(), lastReads=new Map();
  // Share only pending exact-task reads; never attach contacts to a cached roster.
  let privateDriverReadCount = 0;
  const privateDriverReads = new Map();
  function authorize(date) {
    if (!enabled) throw error('DELIVERY_SOURCE_READ_ONLY', 503);
    if (!hasSource) throw error('DELIVERY_SOURCE_SESSION_REQUIRED', 401);
    if (!validDate(date)) throw error('DELIVERY_SOURCE_DATE_INVALID', 400);
  }
  async function readTasks(date, reader = read, expectedCenter = '1') {
    authorize(date);
    let tasks;
    try { tasks = await reader(date); }
    catch (failure) {
      const code = ({UPSTREAM_AUTH_REQUIRED:'DELIVERY_SOURCE_AUTH_REQUIRED', PHOTO_FORBIDDEN:'DELIVERY_SOURCE_FORBIDDEN',
        PHOTO_TIMEOUT:'DELIVERY_SOURCE_TIMEOUT', PHOTO_RATE_LIMITED:'DELIVERY_SOURCE_RATE_LIMITED',
        PHOTO_IDENTITY_UNVERIFIED:'DELIVERY_SOURCE_IDENTITY_UNVERIFIED', PHOTO_PAGE_INCOMPLETE:'DELIVERY_SOURCE_INCOMPLETE',
        PHOTO_PAGE_DUPLICATE:'DELIVERY_SOURCE_PAGE_DUPLICATE'})[failure?.code] || 'DELIVERY_SOURCE_READ_UNAVAILABLE';
      throw error(code, failure?.sourceHttpStatus ?? failure?.status ?? 502);
    }
    const vehicles = new Map();
    let unassignedRows=0;
    for (const task of tasks) {
      if ([task.logisticsCenter?.id,task.logisticsCenterId,task.carrier?.logisticsCenterId]
          .some(center=>center!=null && String(center)!==expectedCenter)) throw error('DELIVERY_SOURCE_SCOPE',503);
      const code = task.customer?.erpCode ?? task.customerErpCode;
      if (task.customer?.erpCode!=null && task.customerErpCode!=null && task.customer.erpCode!==task.customerErpCode ||
          !/^[A-Z]\d{1,20}$/.test(code)) throw error('DELIVERY_SOURCE_CUSTOMER_CONFLICT',503);
      const vehicle=confirmedTaskVehicle(task);
      if (!vehicle) unassignedRows++;
      vehicles.set(task,vehicle);
    }
    const observation = {...tasks.sourceObservation,unassignedRows};
    assertDeliverySourceObservation(observation,date);
    return {tasks,vehicles,observation};
  }

  async function readSyncTasks(date,reader,center,sourceId) {
    try {
      let result;
      try {result=await readTasks(date,reader,sourceId);}
      catch(error) {
        const retryable=error.code==='DELIVERY_SOURCE_TIMEOUT' ||
          error.code==='DELIVERY_SOURCE_READ_UNAVAILABLE' && [500,502,503,504].includes(error.diagnostic?.status);
        if(!retryable)throw error;
        await delay(250);
        result=await readTasks(date,reader,sourceId);
      }
      recordSource?.('delivery:'+sourceId,date,null,result.observation);
      const {pages,rawRows,duplicateRows,responseRows}=result.observation;
      const at=new Date(now()).toISOString();
      lastReads.set(center,{checkedDate:date,checkedAt:at,lastSuccessAt:at,lastSuccessDate:date,complete:true,
        pages,rawRows,duplicateRows,uniqueDeliveries:responseRows,error:null});
      return result;
    } catch(error) {
      recordSource?.('delivery:'+sourceId,date,error);
      lastReads.set(center,{...lastReads.get(center),checkedDate:date,checkedAt:new Date(now()).toISOString(),complete:false,
        error:/^DELIVERY_SOURCE_[A-Z_]+$/.test(error.code||'')?error.code:'DELIVERY_SOURCE_READ_UNAVAILABLE'});
      throw Object.assign(error,{date,center,sourceId});
    }
  }

  async function loadDate(date,{center,id,reader}) {
    const {tasks,vehicles,observation} = await readSyncTasks(date,reader,center,id);
    const groups = new Map();
    const rows = [], candidates=new Map();
    for (const task of tasks) {
      const customerCode=task.customer?.erpCode ?? task.customerErpCode;
      const confirmedVehicle=vehicles.get(task);
      const state=deliveryTaskState(task);
      const event=taskEvent(task,date,customerCode,confirmedVehicle);
      const candidate=eventTransport&&eventCandidate(task,state,event,customerCode,confirmedVehicle);
      if (candidate) {
        const list=candidates.get(confirmedVehicle)||[];
        list.push(candidate);
        candidates.set(confirmedVehicle,list);
      }
      rows.push({taskId:String(task.id),customerCode,vehicle:confirmedVehicle,state,event});
      if(state==='CANCELLED')continue;
      const vehicle = confirmedVehicle || '미확인';
      const customer = task.customer || {}, location = task.location || {};
      const point=validDeliveryPoint(location.gps)?{lat:Number(location.gps.latitude),lng:Number(location.gps.longitude)}:{};
      const stops = groups.get(vehicle) || [];
      stops.push({customerCode,
        customerName:field(task.customerName, customer.name),
        address:field(task.customerAddress, task.address, customer.address, location.address),
        sequence:stops.length + 1, deliveryStatus:event.sourceStatus, deliveryCompletedAt:event.individualCompletedAt,
        appRecorded:state==='COMPLETED',dispatchCenterCode:({osan:'011',osanColdStorage:'011',yeongnam:'012',honam:'013'})[center],...point});
      groups.set(vehicle, stops);
    }
    for(const list of candidates.values())list.sort((a,b)=>String(a.task.id).localeCompare(String(b.task.id)));
    return {rows,candidates,eventReads:new Map(),views:new Map(),legacy:{date,generatedAt:new Date(now()).toISOString(),
      sourceReadState:'LIVE_VERIFIED',sourceError:null,sourceObservation:observation,centerScope:center,
      vehicles:[...groups].map(([vehicle,stops])=>{
        const completedStops=stops.filter(stop=>stop.appRecorded).length;
        return {vehicle,stops,totalStops:stops.length,completedStops,remainingStops:stops.length-completedStops,
          status:completedStops===stops.length?'완료':completedStops?'배송중':'출차전'};
      })}};
  }

  function prepareContract(value) {
    const {date,sourceObservation:{pages,rawRows,duplicateRows}}=value.legacy;
    const rows=value.rows.map(({taskId,customerCode,vehicle,state,event})=>
      ({deliveryId:deliveryTaskId(taskId),deliveryDate:date,customerCode,vehicle,state,...event}));
    rows.sort((a,b)=>a.deliveryId.localeCompare(b.deliveryId));
    const byVehicle=new Map();
    for(const row of rows)if(row.vehicle) {
      const list=byVehicle.get(row.vehicle)||[];
      list.push(row);
      byVehicle.set(row.vehicle,list);
    }
    return {rows,byVehicle,source:datedDispatchSource(rows,{pages,rawRows,duplicateRows})};
  }

  async function loadCenter(date,center) {
    authorize(date);
    const config=readers.get(center);
    if (!config) throw error('DELIVERY_SOURCE_CENTER_UNVERIFIED',503);
    const key=JSON.stringify([date,center]);
    const saved=cached.get(key);
    const previousRead=lastReads.get(center);
    if (saved && saved.freshUntil > now()) return saved;
    if (inflight.has(key)) return inflight.get(key);
    const stale=code=>({value:saved.value,freshUntil:Math.min(now()+15_000,saved.retainUntil),retainUntil:saved.retainUntil,error:code});
    const fallback=failure=>{
      if(!saved || saved.retainUntil<=now())throw failure;
      const retained=stale(failure.code || 'DELIVERY_SOURCE_READ_UNAVAILABLE');
      if (failure.code==='DELIVERY_SOURCE_REGRESSION') lastReads.set(center,{...previousRead,checkedDate:date,
        checkedAt:new Date(now()).toISOString(),complete:false,error:failure.code});
      cached.set(key,retained);
      return retained;
    };
    if (inflight.size >= 2) return fallback(error('DELIVERY_SOURCE_BUSY',429));
    const pending = loadDate(date,config).then(value => {
      if (saved) {
        const rows=new Map(value.rows.map(row=>[row.taskId,row]));
        if (saved.value.rows.some(prior=>{
          const next=rows.get(prior.taskId);
          return !next || prior.customerCode!==next.customerCode ||
            prior.vehicle===next.vehicle && next.state==='COMPLETED' && prior.event.individualCompletedAt && !next.event.individualCompletedAt;
        })) throw error('DELIVERY_SOURCE_REGRESSION',503);
        for (const [vehicle,entry] of saved.value.eventReads) {
          const previous=saved.value.candidates.get(vehicle)||[];
          if (entry.reusable && deliveryDigest(previous)===deliveryDigest(value.candidates.get(vehicle)||[])) value.eventReads.set(vehicle,entry);
        }
      }
      cached.delete(key);
      while(cached.size>=6) cached.delete(cached.keys().next().value);
      const active={value,freshUntil:now()+cacheTtl,retainUntil:now()+staleLimit,error:null};
      cached.set(key,active);
      return active;
    }).catch(fallback).finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  }
  async function readDate(date) {
    const {value,error}=await loadCenter(date,'osan');
    return error?{...value.legacy,sourceReadState:'STALE_VERIFIED',sourceError:error}:value.legacy;
  }
  readDate.readContract=async(date,center,vehicle)=>{
    const {value,error}=await loadCenter(date,center);
    const prepared=value.prepared??=prepareContract(value);
    const candidates=center==='osan'&&focusedVehicles.has(vehicle)?value.candidates.get(vehicle):null;
    if (!error && candidates?.length && !value.eventReads.has(vehicle)) {
      const entry={reusable:false};
      entry.pending=readEvents(candidates,date,vehicleEventLimit,{retryTransient:true}).then(result=>{
        entry.reusable=!result.failed&&!result.truncated;
        return result;
      });
      value.eventReads.set(vehicle,entry);
    }
    const result=await value.eventReads.get(vehicle)?.pending;
    const rows=vehicle?prepared.byVehicle.get(vehicle)||[]:prepared.rows;
    let view=value.views.get(vehicle);
    if (view?.result!==result || !view) {
      const data=datedDispatchView({date,center,sourceId:readers.get(center).id,vehicle,
      rows:result?.events.size?rows.map(row=>({...row,...result.events.get(row.deliveryId)})):rows,
        source:prepared.source,at:value.legacy.generatedAt,state:'LIVE_VERIFIED',
        eventRead:result?{requested:result.requested,attempted:result.attempted,failed:result.failed,truncated:result.truncated}:null});
      view={result,data};
      if(value.views.size>=64) value.views.delete(value.views.keys().next().value);
      value.views.set(vehicle,view);
    }
    return error?{...view.data,state:'STALE_VERIFIED',error,currentReadComplete:false,confirmedEmpty:false,previousVerifiedRetained:true}:view.data;
  };
  readDate.readDriverAssignment = async ({date,center,vehicle,customerCode,deliveryId}) => {
    const fail = (code,status=503) => Object.assign(Error(code),{code,status});
    const slot = cached.get(JSON.stringify([date,center]));
    if (!slot || !readers.has(center) || slot.retainUntil <= now()) throw fail('DRIVER_ASSIGNMENT_SOURCE_UNAVAILABLE');
    const index = slot.value.prepared ??= prepareContract(slot.value);
    const observed = index.rows.find(item => item.deliveryId === deliveryId);
    const row = observed && slot.value.rows.find(item => item.customerCode === customerCode &&
      deliveryTaskId(item.taskId) === observed.deliveryId);
    if (!row || row.customerCode !== customerCode || driverVehicle(row.vehicle) !== vehicle || row.state === 'CANCELLED') {
      throw fail('DRIVER_ASSIGNMENT_UNCONFIRMED',409);
    }
    const lookup = JSON.stringify([date,center,deliveryId]);
    if (privateDriverReads.has(lookup)) return privateDriverReads.get(lookup);
    if (privateDriverReadCount >= 2) throw fail('DRIVER_ASSIGNMENT_SOURCE_BUSY');
    privateDriverReadCount++;
    const signal = AbortSignal.timeout(4500);
    const pending = (async () => {
      const url = new URL('/api/bali/task/'+row.taskId,deliveryOrigin);
      const response = await request(url,signal);
      if (response.status !== 200 || response.redirected) {
        void response.body?.cancel().catch(() => {});
        throw fail('DRIVER_ASSIGNMENT_SOURCE_HTTP_'+response.status);
      }
      const payload = await readBoundedPhotoLoginJson(response,65536,signal);
      if (payload?.ok === false || payload?.success === false || payload?.error) throw fail('DRIVER_ASSIGNMENT_SOURCE_UNAVAILABLE');
      const task = payload?.data ?? payload;
      const ids = [task?.logisticsCenter?.id,task?.logisticsCenterId,task?.carrier?.logisticsCenterId].filter(value => value != null);
      const codes = [task?.customer?.erpCode,task?.customerErpCode].filter(value => value != null);
      const dates = [task?.enteringDatedAt,task?.deliveryDate,task?.carrier?.enteringDatedAt].filter(value => value != null);
      if (String(task?.id) !== row.taskId || !codes.length || codes.some(code => code !== customerCode) ||
          !dates.length || dates.some(value => sourceTaskDate(value) !== date) ||
          ids.some(id => String(id) !== readers.get(center).id) ||
          driverVehicle(confirmedTaskVehicle(task)) !== vehicle || deliveryTaskState(task) === 'CANCELLED') {
        throw fail('DRIVER_ASSIGNMENT_UNCONFIRMED',409);
      }
      const cleanName = value => typeof value === 'string' && value.length <= 100 &&
        !/[\x00-\x1f\x7f]/.test(value) ? value.normalize('NFKC').trim() : '';
      const assignedDriver = task.driver || task.carrier?.driver;
      const names = new Set([task.driverName, task.carrier?.driverName, assignedDriver?.driverName, assignedDriver?.name]
        .map(cleanName).filter(name => name && !driverVehicle(name) && !/^(?:미확인|미등록|unknown|null|undefined)$/i.test(name)));
      const phones = [task.driverPhone, task.driverTel, task.carrier?.driverPhone, assignedDriver?.phone, assignedDriver?.phoneNumber]
        .map(driverPhone).filter(Boolean);
      if (names.size > 1 || new Set(phones.map(phone => phone.replace(/\D/g,''))).size > 1) {
        throw fail('DRIVER_ASSIGNMENT_CONFLICT',409);
      }
      const driverName = [...names][0] || '';
      return {vehicle,date,center,basis:'DATED_ASSIGNMENT',driverName,driverPhone:driverName ? phones[0] || null : null,
        checkedAt:new Date(now()).toISOString(),currentDeliveryVerified:!slot.error && slot.freshUntil>now(),stale:false};
    })().catch(error => {
      if (/^DRIVER_[A-Z_0-9]+$/.test(error.code || '')) throw error;
      if (error.code === 'DELIVERY_SOURCE_VEHICLE_CONFLICT') throw fail('DRIVER_ASSIGNMENT_CONFLICT',409);
      throw fail(signal.aborted ? 'DRIVER_ASSIGNMENT_SOURCE_TIMEOUT' : 'DRIVER_ASSIGNMENT_SOURCE_UNAVAILABLE');
    }).finally(() => { privateDriverReadCount--; privateDriverReads.delete(lookup); });
    privateDriverReads.set(lookup,pending);
    return pending;
  };
  readDate.readObservation = async date => {
    const projected = [], visits = [], sources = [];
    const seen = new Set();
    for (const [key,expected] of scope) {
      const {center,reader}=readers.get(key);
      const {tasks,vehicles,observation} = await readSyncTasks(date,reader,center,expected);
      sources.push([expected,observation.pages,observation.rawRows,observation.duplicateRows]);
      const pending=[];
      for (const task of tasks) {
        const code = task.customer?.erpCode ?? task.customerErpCode;
        const vehicle = vehicles.get(task) || '';
        const address = field(task.location?.address, task.customerAddress, task.address, task.customer?.address);
        const id = deliveryTaskId(task.id);
        if (seen.has(id)) throw Object.assign(error('DELIVERY_SOURCE_ID_SCOPE_CONFLICT',503),{date,center,sourceId:expected});
        seen.add(id);
        const status=deliveryTaskState(task), group=center==='osanColdStorage'?'osan':center;
        const event=taskEvent(task,date,code,vehicle);
        const target={task:[id,code,vehicle,group,coordinateAddressHash(address) || null,status],event:packDatedEvent(expected,event)};
        const candidate=eventTransport&&center==='osan'&&focusedVehicles.has(vehicle)&&eventCandidate(task,status,event,code,vehicle);
        if(candidate)pending.push(candidate);
        projected.push(target);
        if (status === 'COMPLETED' && event.bulkProcessed!==true) visits.push([id,code,vehicle,group,archiveAddressHash(address)]);
      }
      if(pending.length) {
        const {events}=await readEvents(pending,date,64);
        for (const row of projected) {
          const event=events.get(row.task[0]);
          if(event)row.event=packDatedEvent(expected,event);
        }
      }
    }
    const completeCenters = [...new Set(scope.map(([center])=>center==='osanColdStorage'?'osan':center))];
    const completeSources = sources.map(([id])=>id);
    projected.sort((a,b) => a.task[0].localeCompare(b.task[0]));
    visits.sort((a,b) => a[0].localeCompare(b[0]));
    const tasks=projected.map(row=>row.task);
    const dispatch={contract:DATED_DELIVERY_CONTRACT,sources,events:projected.map(row=>row.event)};
    const batchIds=new Set(projected.filter(row=>row.event[4]===true).map(row=>row.task[0]));
    const observedVisits=visits.filter(row=>!batchIds.has(row[0]));
    return validateOpsmapSyncDay({date,sourceRows:tasks.length,unidentified:0,proof:'VERIFIED_COMPLETE_DAY',
      proofHash:deliveryDigest([date,tasks,observedVisits,dispatch]),completeCenters,completeSources,visits:observedVisits,tasks,dispatch},date);
  };
  readDate.configured = hasSource;
  readDate.sourceStatus=()=>Object.fromEntries(Object.keys(SYNC_DELIVERY_SOURCES).map(center=>[center,lastReads.get(center)||{
    checkedDate:null,lastSuccessAt:null,complete:false,error:!hasSource?'DELIVERY_SOURCE_NOT_CONFIGURED':
      readers.has(center)?'DELIVERY_SOURCE_NOT_READ':'DELIVERY_SOURCE_CENTER_UNVERIFIED'
  }]));
  return readDate;
}
