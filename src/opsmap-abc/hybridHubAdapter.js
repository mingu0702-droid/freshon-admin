import {createHash} from 'node:crypto';
import {checkPublicManifest,checkPublicChunk,isDay,validActualVehicle,matchesVehicle} from '../../public/opsmap/hybrid-map-contract.mjs';
import {rollingWindow} from './hybridMapPlan.js';
import {checkRollingRef,shiftDay} from './hybridMapPlan.js';
const fail=code=>{throw Error(code);};
const pin=(m,q)=>{if(m.version!==q.version||m.sourceGeneration!==q.sourceGeneration)fail('HYBRID_GENERATION_CHANGED');};
const plain=(s,max)=>typeof s==='string'&&s.length<=max&&!/[\r\n\x00-\x1f]|비밀번호|출입번호|도어락|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/.test(s);
// LOCAL administrator review only. Not mounted to any public/Production route;
// its reader must close over the trusted fixed preparation ref, never user IDs.
export function createPreparedPublicReviewAdapter({readPreparedPublic,candidateHash,version,startDate,endDate,jsonTerminator='',dayPin}={}){
 if(!['','\n'].includes(jsonTerminator)||typeof readPreparedPublic!=='function'||!/^[a-f0-9]{64}$/.test(candidateHash||'')||!Number.isSafeInteger(version)||version<1||!isDay(startDate)||!isDay(endDate)||startDate>endDate||Date.parse(endDate)-Date.parse(startDate)>89*86400000)fail('PREPARED_REVIEW_BINDING');
 let manifest=null,active=false,reads=0;
 async function invoke(request){
  if(active||reads>=3)fail('PREPARED_REVIEW_READ_LIMIT');active=true;reads++;
  try{const r=await readPreparedPublic(request),m=r?.meta;
   if(!m||m.mode!=='UNPUBLISHED_STORED_CANDIDATE_REVIEW'||m.published!==false||m.productionEligible!==false||m.businessCoverageVerified!==false||m.currentness!=='UNCONFIRMED'||m.candidateHash!==candidateHash||m.version!==version||m.range?.startDate!==startDate||m.range?.endDate!==endDate)fail('PREPARED_REVIEW_BINDING');
   if(Buffer.byteLength(JSON.stringify(r))>1703936)fail('PREPARED_REVIEW_RESPONSE_LIMIT');return r;
  }finally{active=false;}
 }
 async function getManifest(){
  if(manifest)return structuredClone(manifest);
  const r=await invoke({}),m=r.data;
  if(!m||Object.keys(m).some(k=>!['schema','version','startDate','endDate','sourceObservedAt','coverage','chunks','customerCount','visitCount'].includes(k))||m.schema!=='map-public-package-v1'||m.version!==version||m.startDate!==startDate||m.endDate!==endDate||!Array.isArray(m.chunks)||!m.chunks.length||m.chunks.length>32)fail('PREPARED_REVIEW_MANIFEST');
  const c=m.coverage,dates=c&&Array.isArray(c.verifiedDates)&&Array.isArray(c.unconfirmedDates)?[...c.verifiedDates,...c.unconfirmedDates]:[];
  if(!c||dates.length!==(Date.parse(endDate)-Date.parse(startDate))/86400000+1||new Set(dates).size!==dates.length||dates.some(d=>!isDay(d)||d<startDate||d>endDate))fail('PREPARED_REVIEW_COVERAGE');
  const keys=new Set();let customers=0,visits=0;for(const e of m.chunks){if(!e||Object.keys(e).some(k=>!['key','hash','bytes','count','visits'].includes(k))||!/^public-\d{1,3}$/.test(e.key)||keys.has(e.key)||!/^[a-f0-9]{64}$/.test(e.hash)||!Number.isSafeInteger(e.bytes)||e.bytes<2||e.bytes>1572864||!Number.isSafeInteger(e.count)||e.count<0||!Number.isSafeInteger(e.visits)||e.visits<0)fail('PREPARED_REVIEW_MANIFEST');keys.add(e.key);customers+=e.count;visits+=e.visits;}
  if(customers!==m.customerCount||visits!==m.visitCount||customers>15000)fail('PREPARED_REVIEW_MANIFEST');manifest=structuredClone(r);return structuredClone(manifest);
 }
 async function getChunk(request={}){
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(k=>!['key','date'].includes(k))||!/^public-\d{1,3}$/.test(request.key||'')||request.date!==undefined&&(!isDay(request.date)||request.date<startDate||request.date>endDate))fail('PREPARED_REVIEW_REQUEST');
  const m=(await getManifest()).data,e=m.chunks.find(e=>e.key===request.key);if(!e)fail('HYBRID_CHUNK_NOT_FOUND');
  // Verify the complete stored chunk before any selected-date projection.
  const r=await invoke({key:request.key});if(r.meta.chunk!==e.key||r.meta.chunkHash!==e.hash||r.meta.chunkBytes!==e.bytes||r.meta.chunkRows!==e.count||r.meta.chunkVisits!==e.visits)fail('PREPARED_REVIEW_BINDING');
  const rows=checkPublicChunk(structuredClone(r.data),m,e),text=JSON.stringify(rows)+jsonTerminator;if(Buffer.byteLength(text)!==e.bytes||createHash('sha256').update(text).digest('hex')!==e.hash)fail('PREPARED_REVIEW_HASH');
  const offset=request.date===undefined?null:(Date.parse(request.date)-Date.parse(startDate))/86400000;
  const data=offset===null?structuredClone(rows):rows.flatMap(row=>{const v=row[9].filter(v=>v[0]===offset);return v.length?[[...row.slice(0,7),[...row[7]],row[8],v.map(v=>[...v])]]:[];});
  return {data,meta:{...r.meta,date:request.date||null,returnedRows:data.length,returnedVisits:data.reduce((n,row)=>n+row[9].reduce((s,v)=>s+v[2],0),0),dateResult:offset===null?'NOT_REQUESTED':data.length?'STORED_RECORDS':'NO_RECORDS_IN_THIS_CHUNK_UNCONFIRMED',persistAllowed:false,reviewOnly:true}};
 }
 async function getDay(date){
  if(!dayPin||!isDay(dayPin.date)||date!==dayPin.date||date<startDate||date>endDate||!/^[a-f0-9]{64}$/.test(dayPin.dataHash)||!Number.isSafeInteger(dayPin.rows)||dayPin.rows<0||dayPin.rows>15000||!Number.isSafeInteger(dayPin.visits)||dayPin.visits<0)fail('PREPARED_REVIEW_DAY_PIN');
  const r=await invoke({date}),data=structuredClone(r.data),offset=(Date.parse(date)-Date.parse(startDate))/86400000;
  if(r.meta.date!==date||r.meta.returnedRows!==dayPin.rows||r.meta.returnedVisits!==dayPin.visits||createHash('sha256').update(JSON.stringify(data)).digest('hex')!==dayPin.dataHash)fail('PREPARED_REVIEW_DAY_HASH');
  checkPublicChunk(data,{startDate,endDate},{count:dayPin.rows,visits:dayPin.visits});
  if(data.some(row=>row[9].some(v=>v[0]!==offset)))fail('PREPARED_REVIEW_DAY_OFFSET');
  return {data,meta:{...r.meta,persistAllowed:false,reviewOnly:true}};
 }
 return {getManifest,getChunk,getDay,stats:()=>({reads,active,persistAllowed:false,published:false})};
}
export function createHybridHubAdapter({callHub,today,readIndexedDay,readDateCatalog,readDatePage,maxConcurrent=2,now=Date.now}={}){
 if(typeof callHub!=='function'||typeof today!=='function'||!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>4)fail('HYBRID_ADAPTER_INVALID');
 const pending=new Map(),failures=new Map();let active=0;
 async function bounded(key,run){
  if(pending.has(key))return pending.get(key);
  for(const [failedKey,until] of failures)if(until<=now())failures.delete(failedKey);
  if(failures.has(key))fail('HYBRID_READ_BACKOFF');
  if(active>=maxConcurrent)fail('HYBRID_BUSY');
  active++;const work=Promise.resolve().then(run);pending.set(key,work);
  try{return await work;}catch(error){failures.delete(key);failures.set(key,now()+1000);while(failures.size>32)failures.delete(failures.keys().next().value);throw error;}
  finally{active--;if(pending.get(key)===work)pending.delete(key);}
 }
 async function invoke(action,params,maxResponseBytes,signal){
  if(!['mapPackageManifest','mapPackageChunk','datedAssignments'].includes(action))fail('HYBRID_ACTION_REJECTED');
  const response=await callHub(action,params,{useCache:false,privateRead:true,maxResponseBytes,deadline:now()+10000,signal});
  if(response?.ok!==true||!response.meta||response.meta.restoreRequired===true)fail('HYBRID_HUB_CONTRACT');return response;
 }
 async function manifest(signal){return checkPublicManifest((await invoke('mapPackageManifest',{},131072,signal)).data);}
 async function checkedManifest(q,signal){const m=await manifest(signal);pin(m,q);return m;}
 function getManifest({signal}={}){return bounded('manifest',()=>manifest(signal));}
 function getChunk(q){return bounded(JSON.stringify(['chunk',q.version,q.sourceGeneration,q.key]),async()=>{
  const m=await checkedManifest(q,q.signal),entry=m.chunks.find(e=>e.key===q.key);if(!entry)fail('HYBRID_CHUNK_NOT_FOUND');
  const response=await invoke('mapPackageChunk',{version:q.version,key:q.key},entry.bytes+65536,q.signal);
  if(response.meta.version!==q.version||response.meta.key!==q.key||response.meta.hash!==entry.hash||response.meta.count!==entry.count)fail('HYBRID_CHUNK_CHANGED');
  const data=checkPublicChunk(response.data,m,entry),text=JSON.stringify(data);
  if(Buffer.byteLength(text)!==entry.bytes||createHash('sha256').update(text).digest('hex')!==entry.hash)fail('HYBRID_CHUNK_CHANGED');
  await checkedManifest(q,q.signal);
  return {ok:true,data,meta:{version:m.version,sourceGeneration:m.sourceGeneration,key:q.key,hash:entry.hash,bytes:entry.bytes,count:entry.count,visits:entry.visits,restoreRequired:false}};
 });}
 function getDated(q){return bounded(JSON.stringify(['dated',q.version,q.sourceGeneration,q.date,q.vehicle,q.cursor,q.limit,q.sourceRevision]),async()=>{
  if(!isDay(q.date)||q.date>today()||q.date<rollingWindow(today()).startDate||!Number.isInteger(q.limit)||q.limit<1||q.limit>300
    ||typeof q.vehicle!=='string'||!validActualVehicle(q.vehicle)||q.cursor!==undefined&&(typeof q.cursor!=='string'||q.cursor.length>3000)
    ||q.sourceRevision!==undefined&&(typeof q.sourceRevision!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(q.sourceRevision)))fail('HYBRID_DATE_REQUEST_INVALID');
  await checkedManifest(q,q.signal);
  const params={date:q.date,limit:q.limit,...(q.cursor?{cursor:q.cursor}:{})};
  const response=readIndexedDay?await readIndexedDay({...params,vehicle:q.vehicle,signal:q.signal,maxResponseBytes:262144}):await invoke('datedAssignments',params,262144,q.signal);
  const meta=response?.meta,data=response?.data;
  if(response?.ok!==true||!meta||meta.contract!=='dated-assignments-v1'||meta.date!==q.date||!Array.isArray(data)||data.length>q.limit
   ||!Number.isSafeInteger(meta.totalCount)||meta.totalCount<0||meta.totalCount>20000||meta.sourceCount!==meta.totalCount||meta.count!==data.length||meta.pageSize!==q.limit
   ||!Number.isSafeInteger(meta.pageOffset)||meta.pageOffset<0||(!q.cursor&&meta.pageOffset!==0)||meta.pageOffset+data.length>meta.totalCount||typeof meta.hasMore!=='boolean'||meta.complete!==!meta.hasMore||meta.truncated!==false
   ||(meta.hasMore?typeof meta.nextCursor!=='string'||!meta.nextCursor||meta.nextCursor.length>3000:meta.nextCursor!==null)
   ||(!meta.hasMore&&meta.pageOffset+data.length!==meta.totalCount)||(meta.hasMore&&(!data.length||meta.pageOffset+data.length>=meta.totalCount)))fail('HYBRID_DATE_PAGE_INVALID');
  // Existing Hub datedAssignments has no revision/current-only proof. Never invent one from total count.
  if(typeof meta.sourceRevision!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(meta.sourceRevision)||meta.sourceScope!=='CURRENT_ONLY')fail('HYBRID_DATE_REVISION_UNAVAILABLE');
  if(q.sourceRevision&&q.sourceRevision!==meta.sourceRevision)fail('HYBRID_DATE_REVISION_CHANGED');
  if(q.cursor&&!q.sourceRevision)fail('HYBRID_DATE_REVISION_REQUIRED');
  const identities=new Set();
  const safe=data.map(row=>{
   if(!row||row.deliveryDate!==q.date||!/^[A-Z]\d+$/.test(row.customerCode||'')||!validActualVehicle(row.confirmedVehicle)
    ||!plain(row.customerName||'',200)||!plain(row.address||'',250))fail('HYBRID_DATE_ROW_INVALID');
   const key=[q.date,row.customerCode,row.confirmedVehicle].join('|');if(identities.has(key))fail('HYBRID_DATE_DUPLICATE');identities.add(key);
   const lat=row.lat??null,lng=row.lng??null;
   if(!(lat===null&&lng===null||Number.isFinite(lat)&&lat>=33&&lat<=39.5&&Number.isFinite(lng)&&lng>=124&&lng<=132))fail('HYBRID_DATE_ROW_INVALID');
   return {deliveryDate:q.date,customerCode:row.customerCode,confirmedVehicle:row.confirmedVehicle,customerName:row.customerName||'',address:row.address||'',lat,lng};
  }).filter(row=>matchesVehicle(row.confirmedVehicle,q.vehicle));
  await checkedManifest(q,q.signal);
  return {ok:true,data:safe,meta:{version:q.version,sourceGeneration:q.sourceGeneration,date:q.date,sourceRevision:meta.sourceRevision,sourceScope:'CURRENT_ONLY',
   sourceCount:meta.sourceCount,pageOffset:meta.pageOffset,sourcePageCount:data.length,count:safe.length,pageSize:q.limit,hasMore:meta.hasMore,nextCursor:meta.nextCursor,
   complete:meta.complete,coverageComplete:false,currentDay:q.date===today(),restoreRequired:false,source:'Customer.daily_routes assignments',vehicle:q.vehicle}};
 });}
 async function catalog(version,signal,selectionDate){
  if(typeof readDateCatalog!=='function')fail('HYBRID_DATE_CATALOG_UNAVAILABLE');
  if(selectionDate!==undefined&&!isDay(selectionDate))fail('HYBRID_RANGE_REQUEST_INVALID');
  const raw=await readDateCatalog({version,selectionDate,signal,maxResponseBytes:131072});
  if(!raw||!Array.isArray(raw.days)||raw.days.length>5000)fail('HYBRID_DATE_CATALOG_UNAVAILABLE');
  // Callback should read the existing date index; only the resident window and
  // the single selected historical date can leave this bounded relay.
  const c={...raw,days:raw.days.filter(r=>r&&((r.date>=raw.startDate&&r.date<=raw.endDate)||r.date===selectionDate))};
  if(!c||c.schema!=='hybrid-date-catalog-v1'||c.publication!=='PUBLISHED'||!Array.isArray(c.days)||c.days.length>5000
   ||!isDay(c.completedThrough)||!isDay(c.startDate)||!isDay(c.endDate)||c.endDate!==c.completedThrough||c.expectedThrough!==c.completedThrough||c.completionVerified!==true||!Array.isArray(c.gaps)||c.gaps.length
   ||!token(c.version)||!token(c.basis)||version&&c.version!==version||Buffer.byteLength(JSON.stringify(c))>131072
   ||Object.keys(c).some(k=>!['schema','version','basis','completedThrough','expectedThrough','completionVerified','gaps','startDate','endDate','days','publication'].includes(k)))fail('HYBRID_DATE_CATALOG_UNAVAILABLE');
  const dates=new Set();for(const ref of c.days){checkRollingRef(ref,c.basis);if(dates.has(ref.date))fail('HYBRID_DATE_CATALOG_UNAVAILABLE');dates.add(ref.date);}
  return c;
 }
 const token=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
 function publicCatalog(c){return {...c,days:c.days.map(({id,...ref})=>ref)};}
 function getDateCatalog(q={}){return bounded('catalog:'+String(q.catalogVersion||'')+':'+String(q.date||''),async()=>({ok:true,data:publicCatalog(await catalog(q.catalogVersion,q.signal,q.date)),meta:{restoreRequired:false}}));}
 function getRange(q){return bounded(JSON.stringify(['range',q.catalogVersion,q.startDate,q.endDate,q.cursor]),async()=>{
  if(!isDay(q.startDate)||!isDay(q.endDate)||q.startDate>q.endDate||q.endDate>today()||!token(q.catalogVersion))fail('HYBRID_RANGE_REQUEST_INVALID');
  let date=q.startDate,offset=0;
  if(q.cursor){let x;try{if(typeof q.cursor!=='string'||q.cursor.length>2000)throw Error();x=JSON.parse(Buffer.from(q.cursor,'base64url'));}catch{fail('HYBRID_RANGE_CURSOR');}
   if(x.version!==q.catalogVersion||x.startDate!==q.startDate||x.endDate!==q.endDate||!isDay(x.date)||x.date<date||x.date>q.endDate||!Number.isInteger(x.offset)||x.offset<0||x.offset>20000)fail('HYBRID_RANGE_CURSOR');date=x.date;offset=x.offset;}
  const c=await catalog(q.catalogVersion,q.signal,date);
  const ref=c.days.find(r=>r.date===date);let data=[],state=date>c.completedThrough?'PREPARING':'UNCONFIRMED',nextDate=shiftDay(date,1),nextOffset=0,verified=false,hash=null,revision=null,total=null;
  if(ref){
   if(typeof readDatePage!=='function')fail('HYBRID_DATE_READER_UNAVAILABLE');
   const p=await readDatePage({ref,basis:c.basis,catalogVersion:c.version,offset,limit:300,signal:q.signal,deadline:now()+10000,maxResponseBytes:262144});
   const m=p?.meta;data=p?.data;
   if(!m||!Array.isArray(data)||data.length>300||m.date!==date||m.basis!==c.basis||m.revision!==ref.revision||m.hash!==ref.hash
    ||m.verified!==true||m.total!==ref.count||m.offset!==offset||m.count!==data.length||m.complete!==(m.nextOffset===null)
    ||offset+data.length>ref.count||m.complete&&offset+data.length!==ref.count||!m.complete&&(!data.length||m.nextOffset!==offset+data.length)
    ||createHash('sha256').update(JSON.stringify(data)).digest('hex')!==m.pageHash||Buffer.byteLength(JSON.stringify(p))>262144)fail('HYBRID_DATE_PAGE_INVALID');
   const seen=new Set();for(const row of data){if(!row||Object.keys(row).sort().join(',')!=='confirmedVehicle,count,customerCode,deliveryDate'||row.deliveryDate!==date||!/^[A-Z]\d+$/.test(row.customerCode)||!validActualVehicle(row.confirmedVehicle)||!Number.isSafeInteger(row.count)||row.count<1)fail('HYBRID_DATE_ROW_INVALID');const key=[date,row.customerCode,row.confirmedVehicle].join('|');if(seen.has(key))fail('HYBRID_DATE_DUPLICATE');seen.add(key);}
   if(!m.complete){nextDate=date;nextOffset=m.nextOffset;}state=ref.count?'READY':'EMPTY';verified=true;hash=ref.hash;revision=ref.revision;total=ref.count;
  }else if(offset)fail('HYBRID_RANGE_CURSOR');
  const after=await catalog(c.version,q.signal,date);if(JSON.stringify(after)!==JSON.stringify(c))fail('HYBRID_GENERATION_CHANGED');
  const nextCursor=nextDate<=q.endDate?Buffer.from(JSON.stringify({version:c.version,startDate:q.startDate,endDate:q.endDate,date:nextDate,offset:nextOffset})).toString('base64url'):null;
  return {ok:true,data,meta:{catalogVersion:c.version,basis:c.basis,date,offset,total,hash,revision,status:state,verified,
   dayComplete:nextDate!==date,nextCursor,endOfRange:nextCursor===null,coverageComplete:verified,restoreRequired:false}};
 });}
 return {getManifest,getChunk,getDated,getDateCatalog,getRange,stats:()=>({active,inFlight:pending.size,backoffEntries:failures.size})};
}
