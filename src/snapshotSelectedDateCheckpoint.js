// Date-specific private-storage evidence; never advances historical completeness.
import crypto from 'node:crypto';
import {assertDeliverySourceObservation} from './snapshotRefreshEvidence.js';
const fail=code=>{throw Object.assign(Error(code),{code});};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex');
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const isDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const isTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const vehicle=value=>String(value??'').trim().replace(/호(?:차)?$/,'');
const lexical=(a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0;
const keys='date|sourceObservedAt|checkedAt|sourceVisitCount|uniqueCustomerCount|uniqueCustomerVehicleCount|multiVehicleCustomerCount|membershipSha256|snapshotRevision|snapshotSha256|snapshotRowCount|snapshotDateCustomerCount|projectionPolicy|sourceReadComplete|sourceDateVerified|selectedDateStorageVerified|mapDisplayVerified|historicalCompletenessVerified|automaticSyncVerified|consecutiveObservations';
export function validateSelectedDateCheckpoint(value,{snapshot}={}){
 if(!value||Object.keys(value).join('|')!==keys||!isDay(value.date)||!isTime(value.sourceObservedAt)||!isTime(value.checkedAt)||Date.parse(value.sourceObservedAt)>Date.parse(value.checkedAt)||!isHash(value.membershipSha256)||!isHash(value.snapshotSha256))fail('SNAPSHOT_DATE_CHECKPOINT_CONTRACT');
 for(const key of ['sourceVisitCount','uniqueCustomerCount','uniqueCustomerVehicleCount','snapshotRevision','snapshotRowCount','consecutiveObservations'])if(!Number.isSafeInteger(value[key])||value[key]<1)fail('SNAPSHOT_DATE_CHECKPOINT_CONTRACT');
 for(const key of ['multiVehicleCustomerCount','snapshotDateCustomerCount'])if(!Number.isSafeInteger(value[key])||value[key]<0)fail('SNAPSHOT_DATE_CHECKPOINT_CONTRACT');
 if(value.uniqueCustomerCount>value.uniqueCustomerVehicleCount||value.uniqueCustomerVehicleCount>value.sourceVisitCount||value.multiVehicleCustomerCount>value.uniqueCustomerCount||value.snapshotDateCustomerCount<value.uniqueCustomerCount||value.snapshotDateCustomerCount>value.snapshotRowCount||value.projectionPolicy!=='LAST_LIVE_VEHICLE_GROUP_STOP_PER_CUSTOMER'||value.sourceReadComplete!==true||value.sourceDateVerified!==true||value.selectedDateStorageVerified!==true||value.mapDisplayVerified!==false||value.historicalCompletenessVerified!==false||value.automaticSyncVerified!==false)fail('SNAPSHOT_DATE_CHECKPOINT_CONTRACT');
 if(snapshot&&(snapshot.sha256!==value.snapshotSha256||snapshot.revision!==value.snapshotRevision||snapshot.rowCount!==value.snapshotRowCount))fail('SNAPSHOT_DATE_CHECKPOINT_SUPERSEDED');
 return value;
}
export function buildSelectedDateCheckpoint(live,snapshot,{checkedAt=new Date().toISOString(),previous=null}={}){
 const date=live?.date;assertDeliverySourceObservation(live?.sourceObservation,date);
 if(live.sourceObservation.dateVerified!==true||!isTime(live.generatedAt)||!isTime(checkedAt)||Date.parse(live.generatedAt)>Date.parse(checkedAt)||!Array.isArray(live.vehicles)||!Array.isArray(snapshot?.rows)||!isHash(snapshot.sha256))fail('SNAPSHOT_DATE_CHECKPOINT_SOURCE');
 if(previous)validateSelectedDateCheckpoint(previous);
 if(previous&&previous.date>date)fail('SNAPSHOT_DATE_CHECKPOINT_SOURCE_SUPERSEDED');
 const projected=new Map(),triples=new Map(),vehiclesByCustomer=new Map();let visits=0;
 for(const group of live.vehicles){
  const actualVehicle=vehicle(group?.vehicle);if(!actualVehicle||!Array.isArray(group?.stops))fail('SNAPSHOT_DATE_CHECKPOINT_SOURCE');
  for(const stop of group.stops){
   const code=String(stop?.customerCode||stop?.code||'').trim();if(!/^[A-Za-z0-9_-]{1,64}$/.test(code))fail('SNAPSHOT_DATE_CHECKPOINT_CUSTOMER');
   visits++;const triple=[date,code,actualVehicle];triples.set(JSON.stringify(triple),triple);projected.set(code,actualVehicle);
   const vehicles=vehiclesByCustomer.get(code)||new Set();vehicles.add(actualVehicle);vehiclesByCustomer.set(code,vehicles);
  }
 }
 if(visits!==live.sourceObservation.responseRows||!visits||visits>50000)fail('SNAPSHOT_DATE_CHECKPOINT_SOURCE_COUNT');
 const stored=new Map(snapshot.rows.map(row=>[row.customerCode,row]));
 for(const [code,actualVehicle] of projected){const row=stored.get(code);if(!row||(row.lastDeliveryDate||row.deliveryDate)!==date||vehicle(row.vehicle)!==actualVehicle)fail('SNAPSHOT_DATE_CHECKPOINT_PROJECTION');}
 const membershipSha256=hash([...triples.values()].sort(lexical));
 const sameDate=previous?.date===date;
 if(sameDate&&Date.parse(previous.sourceObservedAt)>Date.parse(live.generatedAt))fail('SNAPSHOT_DATE_CHECKPOINT_SOURCE_SUPERSEDED');
 if(sameDate&&previous.sourceObservedAt===live.generatedAt){
  if(previous.membershipSha256!==membershipSha256)fail('SNAPSHOT_DATE_CHECKPOINT_SOURCE_REPLAY');
  if(previous.snapshotSha256===snapshot.sha256)return previous;
 }
 const result={date,sourceObservedAt:live.generatedAt,checkedAt,sourceVisitCount:visits,uniqueCustomerCount:projected.size,uniqueCustomerVehicleCount:triples.size,multiVehicleCustomerCount:[...vehiclesByCustomer.values()].filter(set=>set.size>1).length,membershipSha256,snapshotRevision:snapshot.revision,snapshotSha256:snapshot.sha256,snapshotRowCount:snapshot.rowCount,snapshotDateCustomerCount:snapshot.rows.filter(row=>(row.lastDeliveryDate||row.deliveryDate)===date).length,projectionPolicy:'LAST_LIVE_VEHICLE_GROUP_STOP_PER_CUSTOMER',sourceReadComplete:true,sourceDateVerified:true,selectedDateStorageVerified:true,mapDisplayVerified:false,historicalCompletenessVerified:false,automaticSyncVerified:false,consecutiveObservations:sameDate?previous.consecutiveObservations+(previous.sourceObservedAt===live.generatedAt?0:1):1};
 return validateSelectedDateCheckpoint(result,{snapshot});
}
export function selectedDateCheckpointEnvelope(current,previous=null){
 validateSelectedDateCheckpoint(current);if(previous)validateSelectedDateCheckpoint(previous);
 const body={schema:1,scope:'PRIVATE_MAP_SNAPSHOT_SELECTED_DATE',current,previous};return {...body,sha256:hash(body)};
}
export function validateSelectedDateCheckpointEnvelope(value){
 if(value?.schema!==1||value.scope!=='PRIVATE_MAP_SNAPSHOT_SELECTED_DATE'||Object.keys(value).join('|')!=='schema|scope|current|previous|sha256')fail('SNAPSHOT_DATE_CHECKPOINT_FORMAT');
 const {sha256,...body}=value;if(!isHash(sha256)||hash(body)!==sha256)fail('SNAPSHOT_DATE_CHECKPOINT_INTEGRITY');
 validateSelectedDateCheckpoint(value.current);if(value.previous)validateSelectedDateCheckpoint(value.previous);return value;
}
