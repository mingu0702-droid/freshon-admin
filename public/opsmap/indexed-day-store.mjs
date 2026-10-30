import {checkPublicDayRows} from './public-chunk-store.mjs';
import {checkSnapshot} from './hybrid-cache-contract.mjs';
import {isDay} from './hybrid-map-contract.mjs';
const bytes=s=>new TextEncoder().encode(s).length;
// Metadata-only enumeration; row bodies are fetched one selected date at a time.
export function createIndexedDayStore({indexedDB=globalThis.indexedDB,crypto=globalThis.crypto,now=Date.now,estimate=()=>globalThis.navigator?.storage?.estimate(),name='freshon-public-days-v2',cap=100*1048576,timeoutMs=10000}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw Error('IDB_TIMEOUT');
 if(!Number.isSafeInteger(cap)||cap<2048||cap>100*1048576)throw Error('IDB_CAP');
 let opening,connection,closed=false;
 function bounded(work,signal,onStop=()=>{}){return new Promise((resolve,reject)=>{let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);},abort=()=>{onStop();finish(signal?.reason||Error('IDB_ABORT'));},timer=setTimeout(()=>{onStop();finish(Error('IDB_DEADLINE'));},timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();Promise.resolve(work).then(v=>finish(null,v),e=>finish(e));});}
 const open=()=>closed?Promise.reject(Error('IDB_CLOSED')):opening??=new Promise((resolve,reject)=>{if(!indexedDB)return reject(Error('IDB_UNAVAILABLE'));let expired=false;const r=indexedDB.open(name,2),timer=setTimeout(()=>{expired=true;reject(Error('IDB_OPEN_DEADLINE'));},timeoutMs);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('state'))r.result.createObjectStore('state',{keyPath:'key'});if(!r.result.objectStoreNames.contains('meta'))r.result.createObjectStore('meta',{keyPath:'key'});if(!r.result.objectStoreNames.contains('rows'))r.result.createObjectStore('rows',{keyPath:'key'});};r.onsuccess=()=>{clearTimeout(timer);if(expired||closed){r.result.close();reject(Error('IDB_CLOSED'));return;}r.result.onversionchange=()=>{r.result.close();opening=null;};connection=r.result;resolve(r.result);};r.onerror=()=>{clearTimeout(timer);reject(r.error);};r.onblocked=()=>{expired=true;clearTimeout(timer);reject(Error('IDB_BLOCKED'));};});
 async function transaction(mode,run,signal){const db=await bounded(open(),signal);signal?.throwIfAborted();let tx;return bounded(new Promise((resolve,reject)=>{const t=tx=db.transaction(['meta','rows','state'],mode);let result;t.oncomplete=()=>resolve(result);t.onerror=t.onabort=()=>reject(t.error||Error('IDB_ABORT'));try{run(t,v=>{result=v;});}catch(e){t.abort();reject(e);}}),signal,()=>{try{tx?.abort();}catch{}});}
 const hash=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(v=>v.toString(16).padStart(2,'0')).join('');
 const validMeta=e=>e&&isDay(e.date)&&/^[a-f0-9]{64}$/.test(e.hash||'')&&e.key===e.date+':'+e.hash&&Number.isSafeInteger(e.cost)&&e.cost>=0&&Number.isFinite(e.at)&&Number.isFinite(e.until)&&['base','history'].includes(e.scope);
 function key(ref){if(!isDay(ref?.date)||!/^[a-f0-9]{64}$/.test(ref.hash||'')||!Number.isSafeInteger(ref.bytes)||ref.bytes<2||ref.bytes>1048576)throw Error('IDB_REF');return ref.date+':'+ref.hash;}
 async function get(ref,{signal}={}){try{const k=key(ref);const value=await transaction('readonly',(t,done)=>{const r=t.objectStore('meta').get(k);r.onsuccess=()=>{if(!validMeta(r.result)||r.result.at>now()||r.result.until<=now())return done(null);const row=t.objectStore('rows').get(k);row.onsuccess=()=>done(row.result?.text??null);};},signal);if(value===null||bytes(value)!==ref.bytes||await hash(value)!==ref.hash)return null;signal?.throwIfAborted();const rows=checkPublicDayRows(JSON.parse(value),ref.date);if(rows.length!==ref.count)return null;return rows;}catch{return null;}}
 async function put(ref,rows,scope,verifiedHash,{signal,fence:expectedFence}={}){
  try{const k=key(ref);checkPublicDayRows(rows,ref.date);const text=JSON.stringify(rows);if(!['base','history'].includes(scope)||rows.length!==ref.count||bytes(text)!==ref.bytes||verifiedHash!==ref.hash||await hash(text)!==ref.hash)return false;
   const quota=await bounded(Promise.resolve().then(estimate),signal);signal?.throwIfAborted();if(!Number.isFinite(quota?.quota)||!Number.isFinite(quota?.usage)||quota.usage<0||quota.quota<quota.usage)return false;
   // Account for metadata/serialization overhead; preserve old data on quota abort.
   const cost=bytes(text)*2+2048,free=Math.max(0,quota.quota-quota.usage),budget=Math.max(0,Math.min(cap,cap-quota.usage));if(cost>free/2||cost>budget)return false;
   await transaction('readwrite',(t)=>{const m=t.objectStore('meta'),r=t.objectStore('rows'),q=m.openCursor(),all=[];q.onsuccess=()=>{const cursor=q.result;if(cursor){if(validMeta(cursor.value))all.push(cursor.value);else{r.delete(cursor.key);cursor.delete();}cursor.continue();return;}const budgetRequest=t.objectStore('state').get('cost');budgetRequest.onsuccess=()=>{const stateCost=budgetRequest.result?.value||0;if(!Number.isSafeInteger(stateCost)||stateCost<0){t.abort();return;}const tick=now();let total=stateCost+all.reduce((n,e)=>n+e.cost,0)+cost;const remove=new Set(all.filter(e=>e.until<=tick||e.key===k).map(e=>e.key));total-=all.filter(e=>remove.has(e.key)).reduce((n,e)=>n+e.cost,0);
    // Retain at most one previous valid revision for this date; evict history first.
    const previous=all.filter(e=>e.date===ref.date&&!remove.has(e.key)).sort((a,b)=>b.at-a.at);for(const e of previous.slice(1)){remove.add(e.key);total-=e.cost;}
    const eligible=all.filter(e=>!remove.has(e.key)&&e.date!==ref.date).sort((a,b)=>(a.scope==='history'?0:1)-(b.scope==='history'?0:1)||a.at-b.at);
    for(const e of eligible){if(total<=budget)break;remove.add(e.key);total-=e.cost;}if(total>budget){t.abort();return;}
    for(const id of remove){m.delete(id);r.delete(id);}const f=t.objectStore('state').get('fence');f.onsuccess=()=>{try{if(expectedFence!==undefined&&expectedFence!==(f.result?.value||'')){t.abort();return;}r.put({key:k,text});m.put({key:k,date:ref.date,hash:ref.hash,cost,at:tick,until:tick+(scope==='history'?300000:7*86400000),scope});}catch{t.abort();}};};};},signal);return true;
  }catch{return false;}
 }
 async function prune(predicate,signal){try{await transaction('readwrite',t=>{const m=t.objectStore('meta'),r=t.objectStore('rows'),q=m.openCursor();q.onsuccess=()=>{const c=q.result;if(!c)return;if(!validMeta(c.value)||c.value.at>now()||c.value.until<=now()||predicate(c.value)){r.delete(c.key);c.delete();}c.continue();};},signal);}catch{}}

 async function token(kind){try{return await transaction('readonly',(t,done)=>{const s=t.objectStore('state'),a=s.get(kind),b=s.get('fence');let n=0;const finish=()=>{if(++n===2)done({hash:a.result?.current?.hash||'',fence:b.result?.value||''});};a.onsuccess=b.onsuccess=finish;});}catch{return {hash:'',fence:''};}}
 async function snapshot(kind,{signal}={}){try{
  const entry=await transaction('readonly',(t,done)=>{const q=t.objectStore('state').get(kind);q.onsuccess=()=>done(q.result);},signal);
  for(const part of [entry?.current,entry?.previous]){if(!part||!Number.isFinite(part.at)||!Number.isFinite(part.until)||part.until<=now()||part.at>now()||typeof part.text!=='string'||bytes(part.text)>6291456)continue;try{if(await hash(part.text)!==part.hash)continue;signal?.throwIfAborted();const value=checkSnapshot(kind,JSON.parse(part.text));return {value,at:part.at,until:part.until,hash:part.hash,recovered:part===entry.previous};}catch{signal?.throwIfAborted();}}
  return null;
 }catch{return null;}}
 async function saveSnapshot(kind,value,expected,{signal}={}){try{
  checkSnapshot(kind,value);const text=JSON.stringify(value),size=bytes(text);if(size>6291456||!expected)return false;
  const prior=await snapshot(kind,{signal}),digest=await hash(text),quota=await bounded(Promise.resolve().then(estimate),signal);signal?.throwIfAborted();
  const cost=size*2+2048;if(!Number.isFinite(quota?.quota)||!Number.isFinite(quota?.usage)||quota.usage<0||cost>(quota.quota-quota.usage)/2||cost>cap)return false;
  return await transaction('readwrite',(t,done)=>{const s=t.objectStore('state'),q=s.get(kind),f=s.get('fence');let n=0;const commit=()=>{if(++n!==2)return;const old=q.result;
   if((f.result?.value||'')!==expected.fence){done(false);return;}
   if(old?.current?.hash===digest&&old.current.text===text){old.current.at=now();old.current.until=now()+30*86400000;try{s.put(old);}catch{t.abort();return;}done(true);return;}
   if((old?.current?.hash||'')!==expected.hash){done(false);return;}
   if(kind==='general'&&prior){const m=prior.value.meta;if(value.meta.sourceGeneration<m.sourceGeneration||value.meta.version<m.version){done(false);return;}}
   const previous=prior?{text:JSON.stringify(prior.value),hash:prior.hash,cost:bytes(JSON.stringify(prior.value))*2+2048,at:prior.at,until:prior.until}:undefined,at=now(),current={text,hash:digest,cost,at,until:at+30*86400000};
   let total=cost+(previous?.cost||0),dayCost=0;const a=t.objectStore('meta').openCursor();a.onsuccess=()=>{const c=a.result;if(c){const size=validMeta(c.value)?c.value.cost:cap;total+=size;dayCost+=size;c.continue();return;}const b=s.openCursor();b.onsuccess=()=>{const c=b.result;if(c){if(c.key!==kind)total+=(c.value.current?.cost||0)+(c.value.previous?.cost||0);c.continue();return;}if(total>cap){done(false);return;}try{s.put({key:kind,current,previous});s.put({key:'cost',value:total-dayCost});}catch{t.abort();return;}done(true);};};
  };q.onsuccess=f.onsuccess=commit;},signal);
 }catch{return false;}}
 async function reconcile(c,{signal}={}){
  if(!c||!isDay(c.startDate)||!isDay(c.endDate)||!Array.isArray(c.days))throw Error('IDB_WINDOW');
  // Keep the previous revision until a verified replacement commits. A stale tab
  // may not prune a more recent catalog or the independently stored master.
  try{await transaction('readwrite',t=>{const s=t.objectStore('state'),q=s.get('catalog');q.onsuccess=()=>{
   if(q.result?.current){try{if(JSON.parse(q.result.current.text).version!==c.version)return;}catch{return;}}
   const m=t.objectStore('meta'),r=t.objectStore('rows'),a=m.openCursor();a.onsuccess=()=>{const x=a.result;if(!x)return;const e=x.value;
    if(e.until<=now()||e.scope==='base'&&(e.date<c.startDate||e.date>c.endDate)){r.delete(x.key);x.delete();}x.continue();};};},signal);}catch{}
 }
 async function stats(){try{return await transaction('readonly',(t,done)=>{let entries=0,dayBytes=0,snapshotBytes=0;const q=t.objectStore('meta').openCursor();q.onsuccess=()=>{const c=q.result;if(c){entries++;dayBytes+=c.value.cost||0;c.continue();return;}const a=t.objectStore('state').openCursor();a.onsuccess=()=>{const c=a.result;if(c){snapshotBytes+=(c.value.current?.cost||0)+(c.value.previous?.cost||0);c.continue();return;}done({entries,dayBytes,snapshotBytes,backend:'indexedDB'});};};});}catch{return {entries:0,dayBytes:0,snapshotBytes:0,backend:'network-only'};}}
 async function clear(){try{await transaction('readwrite',t=>{t.objectStore('meta').clear();t.objectStore('rows').clear();t.objectStore('state').clear();t.objectStore('state').put({key:'fence',value:globalThis.crypto.randomUUID()});});}catch{}}
 const close=()=>{closed=true;connection?.close();connection=null;opening=null;};
 return {get,put,reconcile,clearHistory:()=>prune(e=>e.scope==='history'),prune:()=>prune(()=>false),stats,token,snapshot,saveSnapshot,clear,close};
}
