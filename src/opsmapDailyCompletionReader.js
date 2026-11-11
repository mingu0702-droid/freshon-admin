import {deliveryStatusRecordEvent} from './opsmapDailyServer.js';
import {readBoundedPhotoLoginJson} from './opsmapDeliveryAdminTransport.js';
const error=(code,status)=>Object.assign(Error(code),{code,diagnostic:{status}});

export function dailyCompletionCandidates(tasks,resolveVehicle){
  const candidates=new Map();
  for(const task of tasks){
    const vehicle=resolveVehicle(task),customerCode=task.customer?.erpCode??task.customerErpCode;
    if(!vehicle||typeof customerCode!=='string'||!customerCode||task.status!=='COMPLETED'||!/^\d{1,20}$/.test(String(task.id)))continue;
    const list=candidates.get(vehicle)||[];
    list.push({id:task.id,status:task.status,completeType:task.completeType,completeDatedAt:task.completeDatedAt,customerCode,
      bulk:task.bulk===true||task.batch===true||task.isBulk===true||task.isBatch===true||task.isBulkCompleted===true||
      task.batchId!=null||task.appUsed===false,completionSource:task.completionSource});
    candidates.set(vehicle,list);
  }
  return candidates;
}

export function createDailyCompletionReader({authorize=()=>{},getSource,candidates,request}){
  const evidenceCache=new Map(),evidenceInflight=new Map();
  return async(date,vehicle,observedAt)=>{
    authorize(date);
    if(!/^(?:[용척]?\d{1,4})(?:-\d{1,3})?$/.test(vehicle))throw error('DELIVERY_SOURCE_VEHICLE_INVALID',400);
    const source=getSource(date);
    if(!source||source.generatedAt!==observedAt)throw error('DELIVERY_SOURCE_GENERATION_CHANGED',409);
    const key=date+'|'+vehicle+'|'+observedAt;
    const previous=evidenceCache.get(key);
    if(previous)return previous;
    if(evidenceInflight.has(key))return evidenceInflight.get(key);
    if(evidenceInflight.size>=2)throw error('DELIVERY_SOURCE_BUSY',429);
    const rows=candidates(source,vehicle);
    if(rows.length>80)throw error('DELIVERY_SOURCE_INCOMPLETE',502);
    const pending=(async()=>{
      const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),12000);
      const events=[], failed=[];
      try{
        let offset=0;
        await Promise.all(Array.from({length:Math.min(5,rows.length)},async()=>{
          while(offset<rows.length&&!controller.signal.aborted){
            const task=rows[offset++];
            try{
              const response=await request(task.id,controller.signal);
              if(response.status!==200){await response.body?.cancel().catch(()=>{});throw error('DELIVERY_STATUS_RECORD_HTTP',response.status);}
              const body=await readBoundedPhotoLoginJson(response,65536,controller.signal);
              const records=body?.data??body;
              if(!Array.isArray(records)||records.length>50)throw error('DELIVERY_SOURCE_INCOMPLETE',502);
              const verified=records.map(record=>deliveryStatusRecordEvent(task,record)).filter(Boolean).sort((a,b)=>a.at.localeCompare(b.at))[0];
              if(verified)events.push({customerCode:task.customerCode,event:verified});
            }catch(failure){failed.push(failure);if([401,403,429].includes(failure.diagnostic?.status))controller.abort();}
          }
        }));
        if(failed.length)throw failed.find(failure=>[401,403,429].includes(failure.diagnostic?.status))||
          (controller.signal.aborted?error('DELIVERY_SOURCE_TIMEOUT',504):failed[0]);
        if(controller.signal.aborted)throw error('DELIVERY_SOURCE_TIMEOUT',504);
        const result={date,vehicle,observedAt,complete:true,events};
        evidenceCache.set(key,result);
        while(evidenceCache.size>16)evidenceCache.delete(evidenceCache.keys().next().value);
        return result;
      }finally{clearTimeout(timer);}
    })().finally(()=>evidenceInflight.delete(key));
    evidenceInflight.set(key,pending);
    return pending;
  };
}
