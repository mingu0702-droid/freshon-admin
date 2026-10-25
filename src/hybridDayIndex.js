import {createHash} from 'node:crypto';
import {isDay,validActualVehicle,matchesVehicle} from '../public/hybrid-map-contract.mjs';
import {checkRollingRef,shiftDay} from './hybridMapPlan.js';
const fail=code=>{throw Error(code);};
const revision=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const sealedIndices=new WeakSet();
// Offline candidate builder for ONE affected Current date. Never installed or auto-run.
// Source revision must be a monotonic/immutable source token, not a row count or timestamp guess.
export async function buildDirtyDayIndex({date,readSourcePage,readSourceRevision,maxRows=20000,maxBytes=4*1048576}){
 if(!isDay(date)||typeof readSourcePage!=='function'||typeof readSourceRevision!=='function'||!Number.isInteger(maxRows)||maxRows<1||maxRows>20000
  ||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4*1048576)fail('DAY_INDEX_INPUT_INVALID');
 const before=await readSourceRevision({date,sourceScope:'CURRENT_ONLY'});if(!revision(before))fail('DAY_INDEX_REVISION_REQUIRED');
 const rows=[],seen=new Set(),cursors=new Set();let cursor,total,bytes=2;
 for(let page=0;page<67;page++){
  const response=await readSourcePage({date,limit:300,...(cursor?{cursor}:{}),sourceScope:'CURRENT_ONLY',maxResponseBytes:262144});
  const m=response?.meta,data=response?.data;
  if(response?.ok!==true||!m||m.contract!=='dated-assignments-v1'||m.date!==date||!Array.isArray(data)||data.length>300
   ||m.sourceCount!==m.totalCount||!Number.isSafeInteger(m.totalCount)||m.totalCount<0||m.totalCount>maxRows||total!==undefined&&total!==m.totalCount
   ||m.pageOffset!==rows.length||m.count!==data.length||m.pageSize!==300||typeof m.hasMore!=='boolean'||m.complete!==!m.hasMore||m.truncated!==false
   ||m.sourceScope!=='CURRENT_ONLY'||m.sourceRevision!==before)fail('DAY_INDEX_PAGE_INVALID');
  total=m.totalCount;
  for(const r of data){
   if(!r||r.deliveryDate!==date||!/^[A-Z]\d+$/.test(r.customerCode||'')||!validActualVehicle(r.confirmedVehicle)
    ||r.sourceKey!==[date,r.customerCode,r.confirmedVehicle].join('|')||seen.has(r.sourceKey))fail('DAY_INDEX_IDENTITY_INVALID');
   seen.add(r.sourceKey);
   const clean={deliveryDate:date,customerCode:r.customerCode,confirmedVehicle:r.confirmedVehicle,customerName:r.customerName||'',address:r.address||'',lat:r.lat??null,lng:r.lng??null};
   if(typeof clean.customerName!=='string'||clean.customerName.length>200||typeof clean.address!=='string'||clean.address.length>250
    ||/[\r\n\x00-\x1f]|비밀번호|출입번호|도어락|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/.test(clean.customerName+' '+clean.address)
    ||!(clean.lat===null&&clean.lng===null||Number.isFinite(clean.lat)&&clean.lat>=33&&clean.lat<=39.5&&Number.isFinite(clean.lng)&&clean.lng>=124&&clean.lng<=132))fail('DAY_INDEX_ROW_INVALID');
   bytes+=Buffer.byteLength(JSON.stringify(clean))+1;if(bytes>maxBytes)fail('DAY_INDEX_BYTE_LIMIT');rows.push(Object.freeze(clean));
  }
  if(rows.length>total||(!m.hasMore&&rows.length!==total)||(m.hasMore&&(!data.length||rows.length>=total)))fail('DAY_INDEX_PAGE_INVALID');
  if(!m.hasMore){
   if(m.nextCursor!==null)fail('DAY_INDEX_PAGE_INVALID');
   const after=await readSourceRevision({date,sourceScope:'CURRENT_ONLY'});if(after!==before)fail('DAY_INDEX_SOURCE_MOVED');
   const hash=createHash('sha256').update(JSON.stringify(rows)).digest('hex'),vehicles=Object.create(null);
   rows.forEach((r,i)=>{const key=r.confirmedVehicle.replace(/호(?:차)?$/,'');(vehicles[key]||(vehicles[key]=[])).push(i);});
   for(const key of Object.keys(vehicles))Object.freeze(vehicles[key]);
   const index=Object.freeze({schema:'hybrid-dated-index-v1',date,revision:hash,sourceRevision:before,sourceScope:'CURRENT_ONLY',hash,
    count:rows.length,rows:Object.freeze(rows),vehicles:Object.freeze(vehicles)});sealedIndices.add(index);return index;
  }
  if(typeof m.nextCursor!=='string'||!m.nextCursor||m.nextCursor===cursor||cursors.has(m.nextCursor))fail('DAY_INDEX_PAGE_INVALID');
  cursor=m.nextCursor;cursors.add(cursor);
 }
 fail('DAY_INDEX_PAGE_LIMIT');
}
export function readIndexedDayPage(index,{date,vehicle='',cursor,limit=300}){
 if(!index||!sealedIndices.has(index)||index.schema!=='hybrid-dated-index-v1'||index.date!==date||index.sourceScope!=='CURRENT_ONLY'||!revision(index.revision)
  ||!Array.isArray(index.rows)||!Number.isInteger(limit)||limit<1||limit>300||!validActualVehicle(vehicle))fail('DAY_INDEX_UNAVAILABLE');
 let offset=0;
 if(cursor){
  let envelope;try{if(typeof cursor!=='string'||cursor.length>3000||!/^[A-Za-z0-9_-]+$/.test(cursor))fail('DAY_INDEX_CURSOR_INVALID');envelope=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{fail('DAY_INDEX_CURSOR_INVALID');}
  if(envelope.revision!==index.revision||envelope.date!==date||envelope.vehicle!==vehicle||envelope.limit!==limit||!Number.isInteger(envelope.offset)||envelope.offset<1)fail('DAY_INDEX_CURSOR_INVALID');offset=envelope.offset;
 }
 const positions=vehicle?index.vehicles[vehicle.replace(/호(?:차)?$/,'')]||[]:null,total=positions?positions.length:index.rows.length;
 if(offset>total)fail('DAY_INDEX_CURSOR_INVALID');
 const end=Math.min(offset+limit,total),data=positions?positions.slice(offset,end).map(i=>index.rows[i]):index.rows.slice(offset,end);
 if(data.some(r=>!matchesVehicle(r.confirmedVehicle,vehicle)))fail('DAY_INDEX_UNAVAILABLE');
 const hasMore=end<total,nextCursor=hasMore?Buffer.from(JSON.stringify({revision:index.revision,date,vehicle,limit,offset:end})).toString('base64url'):null;
 return {ok:true,data,meta:{contract:'dated-assignments-v1',date,sourceCount:total,totalCount:total,pageOffset:offset,count:data.length,pageSize:limit,
  hasMore,complete:!hasMore,nextCursor,truncated:false,sourceRevision:index.revision,sourceScope:'CURRENT_ONLY'}};
}
// Search gets a customer-keyed index first, then only explicit historical references.
// The returned plan performs no Archive scan and has no fallback to raw data.
export function planIndexedCustomerHistory(index,{customerCode,startDate,endDate,offset=0,limit=20}){
 if(!/^[A-Z]\d+$/.test(customerCode||'')||!isDay(startDate)||!isDay(endDate)||startDate>endDate||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>20)fail('HISTORY_INDEX_REQUEST_INVALID');
 if(!index||index.schema!=='customer-history-index-v1'||index.customerCode!==customerCode||index.verified!==true||!revision(index.version)||!Array.isArray(index.refs)||index.refs.length>5000
  ||index.lastCompletedDeliveryDate!==undefined&&index.lastCompletedDeliveryDate!==null&&!isDay(index.lastCompletedDeliveryDate))fail('HISTORY_INDEX_UNAVAILABLE');
 const seen=new Set();
 const refs=index.refs.filter(ref=>{
  if(!ref||Object.keys(ref).some(k=>!['customerCode','date','id','revision','verified'].includes(k))||ref.customerCode!==customerCode||!isDay(ref.date)||!revision(ref.id)||!revision(ref.revision)||ref.verified!==true||seen.has(ref.date))fail('HISTORY_INDEX_INVALID');seen.add(ref.date);
  return ref.date>=startDate&&ref.date<=endDate;
 }).sort((a,b)=>b.date.localeCompare(a.date));
 return {customerCode,version:index.version,lastCompletedDeliveryDate:index.lastCompletedDeliveryDate||null,refs:refs.slice(offset,offset+limit),
  nextOffset:offset+limit<refs.length?offset+limit:null,archiveScanAllowed:false,complete:index.coverageComplete===true};
}

// Reuses saved date metadata only. Does not scan Archive or read chunk bodies.
export function buildPublishedDateCatalog({publication,previousCatalog=null,historicalRefs=[]}){
 if(!publication||publication.schema!=='hybrid-rolling-publication-v1'||!['HELD','PUBLISHED'].includes(publication.publication)
  ||!Array.isArray(historicalRefs)||historicalRefs.length>5000)fail('DATE_CATALOG_UNAVAILABLE');
 if(publication.expectedVersion!==null&&(!previousCatalog||previousCatalog.version!==publication.expectedVersion||previousCatalog.basis!==publication.basis||previousCatalog.publication!=='PUBLISHED'||!Array.isArray(previousCatalog.days)))fail('DATE_CATALOG_BASE_UNAVAILABLE');
 const refs=new Map();for(const ref of previousCatalog?.days||[]){checkRollingRef(ref,publication.basis);if(refs.has(ref.date))fail('DATE_CATALOG_CONFLICT');refs.set(ref.date,ref);}
 const inputDates=new Set();for(const ref of historicalRefs){checkRollingRef(ref,publication.basis);if(inputDates.has(ref.date)||refs.has(ref.date)&&refs.get(ref.date).hash!==ref.hash)fail('DATE_CATALOG_CONFLICT');inputDates.add(ref.date);refs.set(ref.date,ref);}
 for(const ref of [...(publication.retiredRefs||[]),...(publication.historicalUpdates||[])]){checkRollingRef(ref,publication.basis);refs.set(ref.date,ref);}
 for(const ref of publication.days){checkRollingRef(ref,publication.basis);refs.set(ref.date,ref);}
 const days=[...refs.values()].sort((a,b)=>a.date.localeCompare(b.date));if(days.length>5000)fail('DATE_CATALOG_PARTITION_REQUIRED');
 return Object.freeze({schema:'hybrid-date-catalog-v1',version:publication.version,basis:publication.basis,completedThrough:publication.completedThrough,expectedThrough:publication.expectedThrough,completionVerified:publication.completionVerified,gaps:publication.gaps,
  startDate:publication.startDate,endDate:publication.endDate,days:Object.freeze(days.map(x=>Object.freeze({...x}))),publication:publication.publication});
}
export function planIndexedPeriodPage(catalog,{startDate,endDate,cursor=null,limit=7}){
 if(!catalog||catalog.schema!=='hybrid-date-catalog-v1'||catalog.publication!=='PUBLISHED'||!revision(catalog.version)||!revision(catalog.basis)
  ||!Array.isArray(catalog.days)||catalog.days.length>5000||!isDay(startDate)||!isDay(endDate)||startDate>endDate
  ||!Number.isInteger(limit)||limit<1||limit>7)fail('HISTORY_INDEX_REQUEST_INVALID');
 let date=startDate;
 if(cursor){let c;try{c=JSON.parse(Buffer.from(cursor,'base64url'));}catch{fail('HISTORY_CURSOR');}
  if(c.version!==catalog.version||c.startDate!==startDate||c.endDate!==endDate||!isDay(c.nextDate)||c.nextDate<=startDate||c.nextDate>endDate)fail('HISTORY_CURSOR');date=c.nextDate;}
 const index=new Map();for(const ref of catalog.days){checkRollingRef(ref,catalog.basis);if(index.has(ref.date))fail('DATE_CATALOG_CONFLICT');index.set(ref.date,ref);}
 const steps=[];for(;date<=endDate&&steps.length<limit;date=shiftDay(date,1)){
  const ref=index.get(date);steps.push(Object.freeze({date,status:ref?(ref.count?'READY':'EMPTY'):date>catalog.completedThrough?'PREPARING':'UNCONFIRMED',ref:ref||null}));
 }
 return Object.freeze({version:catalog.version,basis:catalog.basis,startDate,endDate,steps:Object.freeze(steps),
  nextCursor:date<=endDate?Buffer.from(JSON.stringify({version:catalog.version,startDate,endDate,nextDate:date})).toString('base64url'):null,
  archiveScanAllowed:false,coverageComplete:steps.every(s=>s.ref!==null),complete:date>endDate});
}
// One bounded saved day at a time; adapter verifies owner/private/parent and
// streaming byte cap. No raw Current/Archive fallback exists here.
function assertDayReadActive({signal,deadline}={}){
 signal?.throwIfAborted();
 if(deadline!==undefined&&(!Number.isFinite(deadline)||Date.now()>=deadline))fail('DAY_READ_DEADLINE');
}
async function loadPublishedDay(ref,basis,readVerifiedText,options={}){
 checkRollingRef(ref,basis);if(typeof readVerifiedText!=='function')fail('DAY_PAGE_REQUEST');
 assertDayReadActive(options);
 const text=await readVerifiedText(ref,{maxBytes:ref.bytes,signal:options.signal,deadline:options.deadline});
 assertDayReadActive(options);
 if(typeof text!=='string'||Buffer.byteLength(text)!==ref.bytes||createHash('sha256').update(text).digest('hex')!==ref.hash)fail('DAY_HASH_CHANGED');
 let rows;try{rows=JSON.parse(text);}catch{fail('DAY_JSON');}if(!Array.isArray(rows)||rows.length!==ref.count)fail('DAY_COUNT_CHANGED');
 const keys=new Set();for(const r of rows){
  if(!r||Object.keys(r).sort().join(',')!=='confirmedVehicle,count,customerCode,deliveryDate'||r.deliveryDate!==ref.date
   ||!/^[A-Z]\d+$/.test(r.customerCode||'')||!validActualVehicle(r.confirmedVehicle)||!Number.isSafeInteger(r.count)||r.count<1)fail('DAY_PUBLIC_ROW');
  const key=[r.deliveryDate,r.customerCode,r.confirmedVehicle].join('|');if(keys.has(key))fail('DAY_DUPLICATE');keys.add(key);
 }
 return Object.freeze(rows.map(r=>Object.freeze(r)));
}
function publishedDayPage(rows,ref,basis,offset=0,limit=300){
 checkRollingRef(ref,basis);if(!Number.isInteger(offset)||offset<0||offset>ref.count||!Number.isInteger(limit)||limit<1||limit>300)fail('DAY_PAGE_REQUEST');
 const data=rows.slice(offset,offset+limit),next=offset+data.length,done=next===rows.length;
 return {data,meta:{date:ref.date,revision:ref.revision,hash:ref.hash,total:ref.count,offset,count:data.length,nextOffset:done?null:next,
  complete:done,verified:true,basis,pageHash:createHash('sha256').update(JSON.stringify(data)).digest('hex')}};
}
export async function readPublishedDayPage({ref,basis,offset=0,limit=300,readVerifiedText,signal,deadline}){
 checkRollingRef(ref,basis);if(!Number.isInteger(offset)||offset<0||offset>ref.count||!Number.isInteger(limit)||limit<1||limit>300)fail('DAY_PAGE_REQUEST');
 return publishedDayPage(await loadPublishedDay(ref,basis,readVerifiedText,{signal,deadline}),ref,basis,offset,limit);
}
// Bounded read relay, not a restored model: one verified public day (<=4MiB
// serialized) for 60s, one in-flight file, no permanent Render storage.
export function createPublishedDayPageReader({readVerifiedText,now=Date.now}){
 if(typeof readVerifiedText!=='function')fail('DAY_READER_IO_REQUIRED');let cached=null,pending=null;
 return async q=>{
  checkRollingRef(q.ref,q.basis);assertDayReadActive(q);
  if(!Number.isInteger(q.offset??0)||(q.offset??0)<0||(q.offset??0)>q.ref.count||!Number.isInteger(q.limit??300)||(q.limit??300)<1||(q.limit??300)>300)fail('DAY_PAGE_REQUEST');
  const key=JSON.stringify([q.ref.id,q.ref.date,q.ref.revision,q.ref.hash,q.ref.bytes,q.ref.count,q.basis]);
  if(cached?.key===key&&cached.until>now())return publishedDayPage(cached.rows,q.ref,q.basis,q.offset,q.limit);
  if(pending)fail('DAY_READ_BUSY');cached=null;
  const work=loadPublishedDay(q.ref,q.basis,readVerifiedText,q);pending=work;
  try{const rows=await work;assertDayReadActive(q);cached={key,until:now()+60000,rows};return publishedDayPage(rows,q.ref,q.basis,q.offset,q.limit);}
  finally{if(pending===work)pending=null;}
 };
}

// Projection of the existing normalized sealed day, not a source reader or new
// storage engine. Coverage/PRIVATE writer/readback use existing-engine IO seams.
export async function prepareIndexedPublicDay({date,basis,revision:dayRevision,sources,coverage,io}){
 if(!isDay(date)||!revision(basis)||!revision(dayRevision)||!Array.isArray(sources)||sources.length!==2||!io
  ||typeof io.verifyCoverage!=='function'||typeof io.writeImmutable!=='function'||typeof io.verifyStoredRef!=='function')fail('PUBLIC_DAY_INPUT_UNAVAILABLE');
 if(await io.verifyCoverage(coverage,{date,basis,sources})!==true)fail('PUBLIC_DAY_COVERAGE_UNCONFIRMED');
 const scopes=new Set(),logical=new Map(),summary=new Map();
 for(const source of sources){
  if(!source||!['Current','Archive'].includes(source.scope)||scopes.has(source.scope)||source.date!==date||source.basis!==basis||source.complete!==true
   ||!Array.isArray(source.rows)||source.rows.length>20000||source.count!==source.rows.length||Buffer.byteLength(JSON.stringify(source.rows))>4194304
   ||createHash('sha256').update(JSON.stringify(source.rows)).digest('hex')!==source.hash)fail('PUBLIC_DAY_SOURCE_UNVERIFIED');scopes.add(source.scope);
  for(const r of source.rows){
   if(!r||Object.keys(r).some(k=>!['deliveryDate','customerCode','confirmedVehicle','count','driverKey'].includes(k))||r.deliveryDate!==date
    ||!/^[A-Z]\d+$/.test(r.customerCode||'')||!validActualVehicle(r.confirmedVehicle)||!Number.isSafeInteger(r.count)||r.count<1
    ||r.driverKey!==undefined&&!revision(r.driverKey))fail('PUBLIC_DAY_NORMALIZED_ROW');
   const key=[date,r.customerCode,r.confirmedVehicle,r.driverKey||''].join('|'),fingerprint=JSON.stringify([r.deliveryDate,r.customerCode,r.confirmedVehicle,r.count,r.driverKey||'']);
   if(logical.has(key)){if(logical.get(key)!==fingerprint)fail('PUBLIC_DAY_SOURCE_CONFLICT');continue;}logical.set(key,fingerprint);
   const group=[r.customerCode,r.confirmedVehicle].join('|'),prior=summary.get(group)||{deliveryDate:date,customerCode:r.customerCode,confirmedVehicle:r.confirmedVehicle,count:0};
   prior.count+=r.count;if(!Number.isSafeInteger(prior.count))fail('PUBLIC_DAY_COUNT_LIMIT');summary.set(group,prior);
  }
 }
 const rows=[...summary.values()].sort((a,b)=>a.customerCode.localeCompare(b.customerCode)||a.confirmedVehicle.localeCompare(b.confirmedVehicle)),text=JSON.stringify(rows);
 if(rows.length>20000||Buffer.byteLength(text)>4194304)fail('PUBLIC_DAY_SIZE_LIMIT');
 const expected={date,basis,revision:dayRevision,kind:'period',source:'Freshon',complete:true,verified:true,hash:createHash('sha256').update(text).digest('hex'),count:rows.length,bytes:Buffer.byteLength(text)};
 const saved=await io.writeImmutable(text,{...expected});
 const ref={...expected,id:saved?.id};checkRollingRef(ref,basis);
 if(await io.verifyStoredRef(ref)!==true)fail('PUBLIC_DAY_STORE_UNVERIFIED');return Object.freeze(ref);
}
