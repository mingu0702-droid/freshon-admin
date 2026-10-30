import {checkDateCatalog,publicMasterSnapshot} from './hybrid-cache-contract.mjs';
import {checkPublicManifest,checkPublicChunk,isDay,validActualVehicle} from './hybrid-map-contract.mjs';
// Explicit consumer only: this module is not imported by the current production UI.
// Cached public snapshots are explicitly stale until online revalidation succeeds.
import {createPublicChunkStore,browserPublicStorage,createPublicDayStore,checkPublicDayRows} from './public-chunk-store.mjs';
import {createIndexedDayStore} from './indexed-day-store.mjs';
export function createHybridMapClient({fetcher=globalThis.fetch,cryptoProvider=globalThis.crypto,storage,dayStore,now=Date.now,readTimeoutMs=10000,channelName='freshon-public-map-v2',cacheAllowance=async()=>{try{const e=await globalThis.navigator?.storage?.estimate();return Number.isFinite(e?.quota)&&Number.isFinite(e?.usage)?Math.max(0,Math.min(100*1048576,Math.floor((e.quota-e.usage)/2))):0;}catch{return 0;}}}={}){
 if(!Number.isInteger(readTimeoutMs)||readTimeoutMs<1||readTimeoutMs>10000)throw Error('HYBRID_READ_TIMEOUT_INVALID');
 let epoch=0,controller;const store=createPublicChunkStore({storage,now});
 function begin(){controller?.abort();controller=new AbortController();const c=controller;return {id:++epoch,signal:c.signal,abort:()=>c.abort()};}
 function current(task){task.signal.throwIfAborted();if(task.id!==(task.range?rangeEpoch:epoch))throw Object.assign(Error('QUERY_CANCELLED'),{name:'AbortError'});}
 async function json(path,params,task,maxBytes){
  const timer=setTimeout(()=>task.abort(),readTimeoutMs);
  try{
  const query=new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)]));
  const response=await fetcher(`/api/map-phase2b/hybrid/${path}${query.size?'?'+query:''}`,{credentials:'same-origin',cache:'no-store',signal:task.signal});current(task);
  if(!response.body?.getReader)throw Error('HYBRID_BROWSER_STREAM_REQUIRED');
  const reader=response.body.getReader(),decoder=new TextDecoder(),parts=[];let bytes=0;
  try{for(;;){const {done,value}=await reader.read();current(task);if(done)break;bytes+=value.byteLength;if(bytes>maxBytes)throw Error('HYBRID_BROWSER_RESPONSE_TOO_LARGE');parts.push(decoder.decode(value,{stream:true}));}parts.push(decoder.decode());}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  let payload;try{payload=JSON.parse(parts.join(''));}catch{throw Error('HYBRID_BROWSER_JSON_INVALID');}
  if(!response.ok||payload?.ok!==true){const code=typeof payload?.error==='string'&&/^HYBRID_[A-Z_]+$/.test(payload.error)?payload.error:'HYBRID_BROWSER_READ_FAILED';throw Object.assign(Error(code),{status:response.status});}
  return payload;
  }finally{clearTimeout(timer);}
 }
 async function getManifest(task){const payload=await json('manifest',{},task,131072);if(payload.meta?.restoreRequired!==false)throw Error('HYBRID_BROWSER_CONTRACT');return checkPublicManifest(payload.data);}
 const pinned=(m,p)=>{if(p.meta?.version!==m.version||p.meta?.sourceGeneration!==m.sourceGeneration||p.meta?.restoreRequired!==false)throw Error('HYBRID_GENERATION_CHANGED');};
 async function openPackage(){const task=begin();return getManifest(task);}
 async function readChunk(manifest,key){
  checkPublicManifest(manifest);const entry=manifest.chunks.find(e=>e.key===key);if(!entry)throw Error('HYBRID_CHUNK_NOT_FOUND');
  const task=begin();
  async function verify(data){checkPublicChunk(data,manifest,entry);const bytes=new TextEncoder().encode(JSON.stringify(data));const digest=await cryptoProvider.subtle.digest('SHA-256',bytes);current(task);const hash=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');if(hash!==entry.hash||bytes.length!==entry.bytes)throw Error('HYBRID_CHUNK_CHANGED');return hash;}
  const cached=store.get(manifest,entry);
  if(cached){const latest=await getManifest(task);current(task);if(JSON.stringify(latest)!==JSON.stringify(manifest))throw Error('HYBRID_GENERATION_CHANGED');try{const hash=await verify(cached);current(task);return {data:cached,meta:{version:manifest.version,sourceGeneration:manifest.sourceGeneration,restoreRequired:false,hash,cache:'VALIDATED_PUBLIC'}};}catch(error){if(error.name==='AbortError')throw error;store.drop(manifest,entry);}}
  const payload=await json('chunk',{version:manifest.version,sourceGeneration:manifest.sourceGeneration,key},task,entry.bytes+65536);pinned(manifest,payload);
  checkPublicChunk(payload.data,manifest,entry);const bytes=new TextEncoder().encode(JSON.stringify(payload.data));
  const digest=await cryptoProvider.subtle.digest('SHA-256',bytes);current(task);
  const hash=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
  if(hash!==entry.hash||bytes.length!==entry.bytes||payload.meta.hash!==hash)throw Error('HYBRID_CHUNK_CHANGED');
  current(task);store.put(manifest,entry,payload.data);
  return {data:payload.data,meta:payload.meta};
 }
 async function readSelectedDate(date,vehicle=''){
  if(!isDay(date)||!validActualVehicle(vehicle))throw Error('HYBRID_DATE_REQUEST_INVALID');
  const task=begin(),manifest=await getManifest(task),data=[],keys=new Set(),cursors=new Set();let cursor,revision,total,scanned=0;
  for(let page=0;page<67;page++){
   const payload=await json('assignments',{version:manifest.version,sourceGeneration:manifest.sourceGeneration,date,vehicle,limit:300,...(cursor?{cursor,sourceRevision:revision}:{})},task,262144);pinned(manifest,payload);
   const m=payload.meta;
   if(m.date!==date||m.sourceScope!=='CURRENT_ONLY'||m.coverageComplete!==false||!Array.isArray(payload.data)||payload.data.length>300
    ||!Number.isSafeInteger(m.sourceCount)||m.sourceCount<0||m.sourceCount>20000||m.pageOffset!==scanned||!Number.isInteger(m.sourcePageCount)||m.sourcePageCount<0||m.sourcePageCount>300
    ||m.count!==payload.data.length||typeof m.hasMore!=='boolean'||m.complete!==!m.hasMore||typeof m.sourceRevision!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(m.sourceRevision)
    ||revision!==undefined&&(revision!==m.sourceRevision||total!==m.sourceCount))throw Error('HYBRID_BROWSER_PAGE_INVALID');
   revision=m.sourceRevision;total=m.sourceCount;scanned+=m.sourcePageCount;
   for(const row of payload.data){
    if(!row||Object.keys(row).some(k=>!['deliveryDate','customerCode','confirmedVehicle','customerName','address','lat','lng'].includes(k))||row.deliveryDate!==date||!/^[A-Z]\d+$/.test(row.customerCode||'')||!validActualVehicle(row.confirmedVehicle))throw Error('HYBRID_BROWSER_ROW_INVALID');
    const key=[date,row.customerCode,row.confirmedVehicle].join('|');if(keys.has(key))throw Error('HYBRID_DATE_DUPLICATE');keys.add(key);data.push(row);
   }
   if(scanned>total||(!m.hasMore&&scanned!==total)||(m.hasMore&&(!m.sourcePageCount||scanned>=total)))throw Error('HYBRID_BROWSER_PAGE_INVALID');
   if(!m.hasMore){current(task);return {ok:true,data,meta:{...m,rowCount:data.length,readComplete:true,coverageComplete:false}};}
   if(typeof m.nextCursor!=='string'||!m.nextCursor||m.nextCursor===cursor||cursors.has(m.nextCursor))throw Error('HYBRID_BROWSER_PAGE_INVALID');
   cursor=m.nextCursor;cursors.add(cursor);
  }
  throw Error('HYBRID_BROWSER_PAGE_LIMIT');
 }
 let rangeEpoch=0,rangeController,activeDayBuffer=null,allowance=0;
 const days=dayStore||(storage?createPublicDayStore({storage,now,availableBytes:()=>allowance}):createIndexedDayStore({now,crypto:cryptoProvider}));
 async function digest(rows){return [...new Uint8Array(await cryptoProvider.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(rows))))].map(n=>n.toString(16).padStart(2,'0')).join('');}
 async function catalog(task,version,date){const expected=!version&&!date?await days.token?.('catalog'):null;current(task);const p=await json('catalog',{...(version?{catalogVersion:version}:{}),...(date?{date}:{})},task,131072),c=p.data;
  checkDateCatalog(c);
  if(expected){current(task);const saved=await days.saveSnapshot('catalog',c,expected,{signal:task.signal});current(task);
   if(!saved){const head=await days.token('catalog');current(task);if(head.hash&&head.hash!==expected.hash)throw Error('HYBRID_GENERATION_CHANGED');}
   await days.reconcile(c,{signal:task.signal});current(task);
   if(saved&&expected.hash!==await digest(c))channel?.postMessage({type:'publication',version:c.version});
  }return c;
 }
 function rangeTask(){rangeController?.abort();activeDayBuffer=null;rangeController=new AbortController();const c=rangeController,id=++rangeEpoch;return{id,signal:c.signal,range:true,abort:()=>c.abort()};}
 const encode=v=>btoa(JSON.stringify(v)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
 async function* readPeriod({startDate,endDate,catalogSnapshot,includeNextDaySize=false}={}){
  if(!isDay(startDate)||!isDay(endDate)||startDate>endDate)throw Error('HYBRID_RANGE_REQUEST_INVALID');
  const task=rangeTask();let c,cursor=null,unknown=0,rowsRead=0,pageCount=0,selectedRefDate=null,selectedRef=null,dayBuffer=null;
  try{
   // Range lane does not cancel a background latest-manifest refresh.
   task.fence=(await days.token?.('catalog'))?.fence;current(task);c=await catalog(task,catalogSnapshot?.version);if(catalogSnapshot&&JSON.stringify(c)!==JSON.stringify(catalogSnapshot))throw Error('HYBRID_GENERATION_CHANGED');allowance=await new Promise(resolve=>{let settled=false;const finish=v=>{if(settled)return;settled=true;clearTimeout(timer);task.signal.removeEventListener('abort',abort);resolve(Number.isSafeInteger(v)&&v>0?v:0);},abort=()=>finish(0),timer=setTimeout(abort,Math.min(readTimeoutMs,1000));task.signal.addEventListener('abort',abort,{once:true});if(task.signal.aborted)abort();Promise.resolve().then(cacheAllowance).then(finish,abort);});current(task);
   do{
    current(task);
    let date=startDate,offset=0;if(cursor){const x=JSON.parse(atob(cursor.replace(/-/g,'+').replace(/_/g,'/')));date=x.date;offset=x.offset;}
    let ref=c.days.find(r=>r.date===date);
    if(!ref&&date<c.startDate){if(selectedRefDate===date)ref=selectedRef;else{const scoped=await catalog(task,c.version,date),{days:before,...root}=c,{days:after,...pinnedRoot}=scoped;
      if(JSON.stringify(root)!==JSON.stringify(pinnedRoot))throw Error('HYBRID_GENERATION_CHANGED');ref=scoped.days.find(r=>r.date===date);selectedRefDate=date;selectedRef=ref;}}
    let p,cached=ref?await days.get(ref,{signal:task.signal}):null;
    if(cached&&await digest(cached)!==ref.hash)cached=null;current(task);
    if(cached){
     const data=cached.slice(offset,offset+300),nextOffset=offset+data.length,nextDate=nextOffset<cached.length?date:new Date(Date.parse(date)+86400000).toISOString().slice(0,10);
     p={data,meta:{catalogVersion:c.version,basis:c.basis,date,offset,total:ref.count,hash:ref.hash,revision:ref.revision,status:ref.count?'READY':'EMPTY',verified:true,dayComplete:nextDate!==date,
      nextCursor:nextDate<=endDate?encode({version:c.version,startDate,endDate,date:nextDate,offset:nextDate===date?nextOffset:0}):null,restoreRequired:false}};
    }else p=await json('range',{catalogVersion:c.version,startDate,endDate,...(cursor?{cursor}:{})},task,262144);
    const m=p.meta;checkPublicDayRows(p.data,date);
    if(!m||m.catalogVersion!==c.version||m.basis!==c.basis||m.date!==date||m.offset!==offset||p.data.length>300||!['READY','EMPTY','PREPARING','UNCONFIRMED','MISSING'].includes(m.status)
     ||m.nextCursor!==null&&(typeof m.nextCursor!=='string'||m.nextCursor.length>2000)||typeof m.dayComplete!=='boolean'
     ||ref&&(m.verified!==true||m.hash!==ref.hash||m.revision!==ref.revision||m.total!==ref.count||offset+p.data.length>ref.count||m.dayComplete&&offset+p.data.length!==ref.count||m.status!==(ref.count?'READY':'EMPTY'))
     ||!ref&&(m.verified===true||p.data.length||!m.dayComplete))throw Error('HYBRID_RANGE_PAGE_INVALID');
    if(m.nextCursor){let n;try{n=JSON.parse(atob(m.nextCursor.replace(/-/g,'+').replace(/_/g,'/')));}catch{throw Error('HYBRID_RANGE_CURSOR');}
     const expectedDate=m.dayComplete?new Date(Date.parse(date)+86400000).toISOString().slice(0,10):date;
     if(n.version!==c.version||n.startDate!==startDate||n.endDate!==endDate||n.date!==expectedDate||n.date>endDate||n.offset!==(m.dayComplete?0:offset+p.data.length)||!m.dayComplete&&!p.data.length)throw Error('HYBRID_RANGE_CURSOR');
    }else if(date!==endDate||!m.dayComplete)throw Error('HYBRID_RANGE_INCOMPLETE');
    if(!ref)unknown++;
    if(ref&&!cached){
     if(offset===0){dayBuffer={date,rows:[],bytes:2};activeDayBuffer=dayBuffer;}
     if(!dayBuffer||dayBuffer.date!==date||dayBuffer.rows.length!==offset)throw Error('HYBRID_RANGE_INCOMPLETE');
     for(const r of p.data){dayBuffer.bytes+=new TextEncoder().encode(JSON.stringify(r)).length+1;if(dayBuffer.bytes>ref.bytes+1||dayBuffer.rows.length>=ref.count)throw Error('HYBRID_RANGE_MEMORY_LIMIT');dayBuffer.rows.push(r);}
     if(m.dayComplete){if(dayBuffer.rows.length!==ref.count||await digest(dayBuffer.rows)!==ref.hash)throw Error('HYBRID_DAY_HASH_CHANGED');current(task);await days.put(ref,dayBuffer.rows,date<c.startDate?'history':'base',ref.hash,{signal:task.signal,fence:task.fence});current(task);if(activeDayBuffer===dayBuffer)activeDayBuffer=null;dayBuffer=null;}
    }
    rowsRead+=p.data.length;pageCount++;cursor=m.nextCursor;current(task);
    if(cursor===null&&unknown===0)await days.reconcile(c,{signal:task.signal});
    let nextDayBytes;
    if(includeNextDaySize&&m.dayComplete&&cursor){const nextDate=JSON.parse(atob(cursor.replace(/-/g,'+').replace(/_/g,'/'))).date;let nextRef=c.days.find(r=>r.date===nextDate);
     if(!nextRef&&nextDate<c.startDate){const scoped=await catalog(task,c.version,nextDate),{days:before,...root}=c,{days:after,...pinnedRoot}=scoped;if(JSON.stringify(root)!==JSON.stringify(pinnedRoot))throw Error('HYBRID_GENERATION_CHANGED');nextRef=scoped.days.find(r=>r.date===nextDate);selectedRefDate=nextDate;selectedRef=nextRef;}
     nextDayBytes=nextRef?.bytes??4194304;current(task);
    }
    yield {ok:true,data:p.data,meta:{...m,...(nextDayBytes===undefined?{}:{nextDayBytes}),selectedPeriod:{startDate,endDate},readComplete:cursor===null,coverageComplete:cursor===null&&unknown===0,aggregateComplete:cursor===null&&unknown===0,rowsRead,pageCount,unknownDates:unknown,provisional:!m.dayComplete}};
   }while(cursor);
  }finally{if(activeDayBuffer===dayBuffer)activeDayBuffer=null;dayBuffer=null;}
 }

 const listeners=new Set();
 const makeChannel=name=>{try{return name&&typeof globalThis.BroadcastChannel==='function'?new BroadcastChannel(name):null;}catch{return null;}};
 const channel=makeChannel(channelName),sessionChannel=makeChannel('map-staff-session');
 channel?.unref?.();sessionChannel?.unref?.();
 async function recheckSessionLogout(){
  try{const response=await fetcher('/api/map-phase2b/auth/session',{credentials:'same-origin',cache:'no-store'});
   if(!response.ok||(await response.json()).authenticated!==false)return;
   await logout({broadcast:false});for(const fn of listeners)fn({type:'logout'});
  }catch{/* A signal never proves authentication state. */}
 }
 if(sessionChannel)sessionChannel.onmessage=event=>{if(event.data==='logout'||event.data==='session-changed')void recheckSessionLogout();};
 if(channel)channel.onmessage=event=>{if(event.data?.type==='logout'){void recheckSessionLogout();return;}for(const fn of listeners)fn(event.data);};
 async function cacheGeneral(value,expected,options){const safe=publicMasterSnapshot(value);return days.saveSnapshot?.('general',safe,expected,options)||false;}
 async function readCachedGeneral(){const saved=await days.snapshot?.('general');return saved?{...saved.value,meta:{...saved.value.meta,cache:'LAST_GOOD_PUBLIC',stale:true,cachedAt:saved.at,recovered:saved.recovered}}:null;}
 async function logout({broadcast=true}={}){epoch++;controller?.abort();cancelRange();store.clear();if(broadcast)channel?.postMessage({type:'logout'});await days.clear?.();}
 function dispose(){epoch++;controller?.abort();cancelRange();channel?.close();sessionChannel?.close();listeners.clear();days.close?.();}
 function cancelRange(){rangeEpoch++;rangeController?.abort();activeDayBuffer=null;}
 return {cacheToken:()=>days.token?.('general'),cacheGeneral,readCachedGeneral,logout,dispose,onCacheChange:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},openPackage,readChunk,readSelectedDate,readPeriod,openDateCatalog:async()=>{const task=rangeTask();return catalog(task);},refreshDateCatalog:async({catalogVersion}={})=>catalog(begin(),catalogVersion),
  closePeriod:()=>{cancelRange();return days.clearHistory();},cacheStats:()=>({...(storage?days.stats():{backend:'indexedDB',persistentStats:'ASYNC_REQUIRED'}),inMemoryDayRows:activeDayBuffer?.rows.length||0}),cacheStatsAsync:async()=>({...await days.stats(),inMemoryDayRows:activeDayBuffer?.rows.length||0}),
  cancel:()=>{epoch++;controller?.abort();cancelRange();}};
}
