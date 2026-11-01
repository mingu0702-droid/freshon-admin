// Reuses the existing private Github Contents SHA CAS. No Customer/Delivery writes.
import crypto from 'node:crypto';
import {createPrivateGithubJsonStore} from './fixedVehicleStore.js';
const fail=code=>{throw Object.assign(Error(code),{code});};
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const day=value=>{const s=typeof value==='string'?value.slice(0,10):'';return /^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s?s:null;};
const coordinateValue=value=>typeof value==='number'||typeof value==='string'&&value.trim()!=='';
const textFields=['customerName','vehicle','baseVehicle','confirmedVehicle','primaryVehicle90d','baseVehicleGroup','baseVehicleState','baseVehicleSource','baseVehicleVersion','baseVehicleCheckedAt','centerCode','centerGroup','areaLabel','region','coordinateSource','coordinateAccuracy','coordinateStatus','resolutionStatus','addressHash','originalAddressHash','deliveryStatus','status','appUsageGroup','routeOrder','sequence'];
export function snapshotStopCoordinates(stop,known={}){
 const point=row=>{
  const lat=row?.lat,lng=row?.lng;
  return coordinateValue(lat)&&coordinateValue(lng)&&Number.isFinite(Number(lat))&&Number.isFinite(Number(lng))&&Math.abs(Number(lat))<=90&&Math.abs(Number(lng))<=180?{lat:Number(lat),lng:Number(lng)}:null;
 };
 const oldHash=known.originalAddressHash||known.addressHash,newHash=stop.originalAddressHash||stop.addressHash;
 const changed=!!oldHash&&!!newHash&&oldHash!==newHash,old=point(known),fresh=point(stop);
 if(!changed&&old&&(known.coordinateSource==='MANUAL_PIN'||known.coordinateSource==='RAW_GPS'))return {...old,coordinateSource:known.coordinateSource,coordinateAccuracy:known.coordinateAccuracy};
 if(fresh)return {...fresh,coordinateSource:stop.coordinateSource||'DELIVERY_RECORDED',coordinateAccuracy:stop.coordinateAccuracy||'UNVERIFIED'};
 if(!changed&&old)return {...old,coordinateSource:known.coordinateSource,coordinateAccuracy:known.coordinateAccuracy};
 return {lat:null,lng:null,coordinateSource:'UNRESOLVED',coordinateAccuracy:'UNVERIFIED'};
}
const numberFields=['visitCount','deliveryCount90d','amount','dailyAmount','monthlyAmount','orderCount','weight','cbm'];
function projectRow(input){
 const customerCode=String(input?.customerCode||input?.code||'').trim();
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(customerCode))fail('SNAPSHOT_CUSTOMER_CODE');
 const row={customerCode};
 for(const key of textFields)if(typeof input[key]==='string'&&input[key].length<=256&&!/[\u0000-\u001f]/.test(input[key]))row[key]=input[key];
 for(const key of numberFields)if(typeof input[key]==='number'&&Number.isFinite(input[key]))row[key]=input[key];
 for(const key of ['appRecorded','isActualDateStop','baseVehicleStale'])if(typeof input[key]==='boolean')row[key]=input[key];
 for(const key of ['lastDeliveryDate','deliveryDate']){const d=day(input[key]);if(d)row[key]=d;}
 const lat=input.lat??input.latitude,lng=input.lng??input.longitude;
 if(coordinateValue(lat)&&coordinateValue(lng)&&Number.isFinite(Number(lat))&&Number.isFinite(Number(lng))&&Math.abs(Number(lat))<=90&&Math.abs(Number(lng))<=180){row.lat=Number(lat);row.lng=Number(lng);}else {row.lat=null;row.lng=null;}
 return row;
}
function rowsOf(input){
 if(!Array.isArray(input)||input.length>50000)fail('SNAPSHOT_ROWS');
 const seen=new Set(),rows=input.map(projectRow).sort((a,b)=>a.customerCode<b.customerCode?-1:a.customerCode>b.customerCode?1:0);
 for(const row of rows){if(seen.has(row.customerCode))fail('SNAPSHOT_DUPLICATE_CUSTOMER');seen.add(row.customerCode);}
 return rows;
}
function sourceEvidence(value){
 const e=value?.sourceFreshness||{},complete=e.sourceReadComplete===true&&e.sourceDateVerified===true&&e.automaticSyncVerified===true;
 return {targetDate:day(e.targetDate),checkedThrough:day(e.checkedThrough),sourceVersion:/^(?:\d{1,30}|[a-f0-9]{64})$/.test(e.sourceVersion||'')?e.sourceVersion:null,sourceReadComplete:e.sourceReadComplete===true,sourceDateVerified:e.sourceDateVerified===true,collectionVerified:e.collectionVerified===true,publicationVerified:e.publicationVerified===true,automaticSyncVerified:complete,phase:/^[A-Z_]{1,64}$/.test(e.phase||'')?e.phase:'UNVERIFIED'};
}
export function snapshotProjection(input,{revision=1,now=Date.now}={}){
 if(!input||input.version!=='phase2b-map-snapshot-v1'||!Number.isSafeInteger(revision)||revision<1)fail('SNAPSHOT_CONTRACT');
 const rows=rowsOf(input.rows);if(!rows.length||input.rowCount!==undefined&&input.rowCount!==rows.length)fail('SNAPSHOT_COUNT');
 const latestDate=rows.map(r=>r.lastDeliveryDate||r.deliveryDate).filter(Boolean).sort().pop()||day(input.latestDate);
 if(!latestDate)fail('SNAPSHOT_DATE');
 const body={schema:1,scope:'PRODUCTION_OBSERVED_CUSTOMERS',revision,observedAt:new Date(now()).toISOString(),latestDate,startDate:day(input.startDate),checkpointDate:day(input.sourceFreshness?.checkedThrough),sourceEvidence:sourceEvidence(input),rowCount:rows.length,rows};
 return {...body,sha256:hash(body)};
}
export function validateSnapshotProjection(value){
 if(value?.schema!==1||value.scope!=='PRODUCTION_OBSERVED_CUSTOMERS'||!Number.isSafeInteger(value.revision)||value.revision<1||!Number.isFinite(Date.parse(value.observedAt)))fail('SNAPSHOT_ENVELOPE');
 if(Object.keys(value).join('|')!=='schema|scope|revision|observedAt|latestDate|startDate|checkpointDate|sourceEvidence|rowCount|rows|sha256'||JSON.stringify(value.sourceEvidence)!==JSON.stringify(sourceEvidence({sourceFreshness:value.sourceEvidence})))fail('SNAPSHOT_ENVELOPE_FIELDS');
 const {sha256,...body}=value;if(!/^[a-f0-9]{64}$/.test(sha256||'')||sha256!==hash(body))fail('SNAPSHOT_INTEGRITY');
 const rows=rowsOf(value.rows);if(!rows.length||value.rowCount!==rows.length||JSON.stringify(rows)!==JSON.stringify(value.rows)||!day(value.latestDate))fail('SNAPSHOT_COUNT');
 return value;
}
// Partial/cold refresh must not advance a 60-day eviction window across unread dates.
// Missing rows, empty dates and failures are not deletion evidence.
export function mergePreservedSnapshot(previous,incoming,{now=Date.now}={}){
 if(previous)validateSnapshotProjection(previous);
 const fresh=snapshotProjection(incoming,{revision:(previous?.revision||0)+1,now});
 if(!previous)return fresh;
 const merged=new Map(previous.rows.map(r=>[r.customerCode,r]));
 for(const row of fresh.rows){
  const old=merged.get(row.customerCode);if(!old){merged.set(row.customerCode,row);continue;}
  if((row.lastDeliveryDate||row.deliveryDate||'')<(old.lastDeliveryDate||old.deliveryDate||''))continue;
  const oldHash=old.originalAddressHash||old.addressHash,newHash=row.originalAddressHash||row.addressHash,changed=!!oldHash&&!!newHash&&oldHash!==newHash;
  const next={...old,...row};
  if(!changed&&Number.isFinite(old.lat)&&Number.isFinite(old.lng)&&(row.lat===null||row.lng===null||old.coordinateSource==='MANUAL_PIN'||old.coordinateSource==='RAW_GPS'&&row.coordinateSource!=='RAW_GPS'))Object.assign(next,{lat:old.lat,lng:old.lng,coordinateSource:old.coordinateSource,coordinateAccuracy:old.coordinateAccuracy});
  merged.set(row.customerCode,next);
 }
 const rows=rowsOf([...merged.values()]);
 const latestDate=rows.map(r=>r.lastDeliveryDate||r.deliveryDate).filter(Boolean).sort().pop()||previous.latestDate;
 // A stale writer may contain new rows but an older completed-read cursor.
 // Preserve the validated frontier independently from selected-date observations.
 const checkpointDate=[previous.checkpointDate,fresh.checkpointDate].filter(Boolean).sort().pop()||null;
 const evidence=previous.sourceEvidence.targetDate&&(!fresh.sourceEvidence.targetDate||previous.sourceEvidence.targetDate>fresh.sourceEvidence.targetDate)?previous.sourceEvidence:fresh.sourceEvidence;
 const body={...fresh,latestDate,startDate:[previous.startDate,fresh.startDate].filter(Boolean).sort()[0]||null,checkpointDate,sourceEvidence:{...evidence,checkedThrough:checkpointDate},rowCount:rows.length,rows};delete body.sha256;
 return {...body,sha256:hash(body)};
}
export function materializeSnapshot(value){
 validateSnapshotProjection(value);
 return {version:'phase2b-map-snapshot-v1',generatedAt:value.observedAt,latestDate:value.latestDate,startDate:value.startDate,rowCount:value.rowCount,rows:structuredClone(value.rows),refreshedThrough:value.checkpointDate,refreshComplete:false,sourceFreshness:{...value.sourceEvidence,checkedThrough:value.checkpointDate,automaticSyncVerified:false,preservationOnly:true},preservation:{version:value.sha256,revision:value.revision,source:'PRIVATE_GITHUB_CAS',scope:value.scope}};
}
export function createProductionSnapshotStore({env=process.env,token=env.OPSMAP_SNAPSHOT_STORE_TOKEN,fetchImpl=fetch,now=Date.now}={}){
 if(env.OPSMAP_SNAPSHOT_STORE_ENABLED!=='1')return undefined;
 const repo=env.OPSMAP_SNAPSHOT_STORE_REPO,branch=env.OPSMAP_SNAPSHOT_STORE_BRANCH;
 if(repo!=='mingu0702-droid/freshon-cache'||!['production/opsmap-snapshots','stage/opsmap-snapshots'].includes(branch)||!token)fail('SNAPSHOT_STORE_CONFIG');
 const production=env.OPSMAP_PRODUCTION_CANDIDATE_ENABLED==='1';
 if(branch!==(production?'production/opsmap-snapshots':'stage/opsmap-snapshots'))fail('SNAPSHOT_STORE_ENVIRONMENT');
 const prefix=production?'opsmap-production':'opsmap-stage';
 const adapter=createPrivateGithubJsonStore({env:{GITHUB_CACHE_REPO:repo,GITHUB_TOKEN:token,GITHUB_CACHE_BRANCH:branch,GITHUB_CACHE_DIR:prefix},fetchImpl,now}),file='map-snapshot-v1.json';
 let saving=Promise.resolve();
 async function read({allowPrevious=false}={}){const result=await adapter.read(file);if(result.value===null)return {...result,state:{schema:1,current:null,previous:null}};const state=result.value;if(state.schema!==1||Object.keys(state).join('|')!=='schema|current|previous')fail('SNAPSHOT_STORE_FORMAT');if(state.previous)validateSnapshotProjection(state.previous);if(state.current){try{validateSnapshotProjection(state.current);}catch(error){if(!allowPrevious||!state.previous)throw error;return {...result,state:{...state,current:state.previous},recoveredPrevious:true};}}return {...result,state};}
 return {kind:'PRIVATE_GITHUB_CAS',async load(){const {state}=await read({allowPrevious:true});return state.current;},async save(input){
  const work=saving.catch(()=>{}).then(async()=>{const old=await read(),current=mergePreservedSnapshot(old.state.current,input,{now});
   const state={schema:1,current,previous:old.state.current};
   // One SHA CAS updates current+previous atomically; the Git commit is another backup.
   await adapter.write(file,state,old.sha);
   const saved=await read();if(saved.state.current?.sha256!==current.sha256)fail('SNAPSHOT_STORE_READBACK_UNKNOWN');return current;
  });saving=work;return work;
 }};
}
