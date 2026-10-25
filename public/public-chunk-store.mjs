// Public immutable chunks only. Never stores auth, private details, assignments or routes.
import {checkPublicManifest,checkPublicChunk,isDay,validActualVehicle} from './hybrid-map-contract.mjs';
const PREFIX='freshon-public-chunks-v1',MAX=6*1024*1024,ENTRY_MAX=1700000,TTL=15*60*1000,LIMIT=8;
const size=s=>new TextEncoder().encode(s).byteLength;
export function createPublicChunkStore({storage,now=Date.now}={}){
 const remove=()=>{try{storage?.removeItem(PREFIX);}catch{}};
 function load(){
  try{
   const text=storage?.getItem(PREFIX);if(!text)return [];
   if(typeof text!=='string'||text.length>MAX||size(text)>MAX){remove();return [];}
   const data=JSON.parse(text),t=now();
   if(!data||data.schema!==1||Object.keys(data).sort().join(',')!=='entries,schema'||!Array.isArray(data.entries)||data.entries.length>LIMIT)throw Error('CACHE_SHAPE');
   return data.entries.filter(e=>e&&Object.keys(e).sort().join(',')==='at,data,key'&&typeof e.key==='string'&&e.key.length<250&&Number.isSafeInteger(e.at)&&e.at<=t&&t-e.at<TTL&&Array.isArray(e.data)&&size(JSON.stringify(e.data))<=ENTRY_MAX);
  }catch{remove();return [];}
 }
 function save(entries){try{const day=indexBytes(storage);while(entries.length){const text=JSON.stringify({schema:1,entries});if(size(text)+day<=MAX){storage?.setItem(PREFIX,text);return;}entries.shift();}remove();}catch{/* Quota failure must preserve the last committed value. */}}
 const key=(m,e)=>[m.version,m.sourceGeneration,e.key,e.hash,e.bytes].join(':');
 return {
  get:(m,e)=>{const k=key(m,e);return load().find(v=>v.key===k)?.data??null;},
  put:(m,e,data)=>{checkPublicManifest(m);checkPublicChunk(data,m,e);const text=JSON.stringify(data);if(size(text)>ENTRY_MAX)return;const k=key(m,e),scope=m.version+':'+m.sourceGeneration+':';const entries=load().filter(v=>v.key!==k);if(entries.some(v=>!v.key.startsWith(scope))&&(entries.length>=LIMIT||size(JSON.stringify({schema:1,entries}))+size(text)+indexBytes(storage)>MAX))return;entries.push({key:k,at:now(),data});save(entries.slice(-LIMIT));},
  drop:(m,e)=>save(load().filter(v=>v.key!==key(m,e))),
  clear:remove
 };
}
export function browserPublicStorage(){try{return globalThis.localStorage;}catch{return undefined;}}

const DAY_INDEX=PREFIX+':days',DAY_TTL=5*60*1000,BASE_TTL=60*60*1000;
function dayIndex(storage){try{const text=storage?.getItem(DAY_INDEX);if(!text||text.length>16000)return [];const entries=JSON.parse(text);if(!Array.isArray(entries)||entries.length>32)return [];return entries.filter(e=>e&&typeof e.key==='string'&&e.key.startsWith(PREFIX+':day:')&&Number.isSafeInteger(e.bytes)&&e.bytes>1&&e.bytes<=1048576&&Number.isSafeInteger(e.at)&&Number.isSafeInteger(e.until)&&['base','history'].includes(e.scope));}catch{return [];}}
function indexBytes(storage){try{return dayIndex(storage).reduce((n,e)=>n+e.bytes,0)+size(storage?.getItem(DAY_INDEX)||'');}catch{return MAX;}}
export function checkPublicDayRows(rows,date){
 if(!isDay(date)||!Array.isArray(rows)||rows.length>20000)throw Error('PUBLIC_DAY_INVALID');const keys=new Set();
 for(const r of rows){if(!r||Object.keys(r).sort().join(',')!=='confirmedVehicle,count,customerCode,deliveryDate'||r.deliveryDate!==date||!/^[A-Z]\d+$/.test(r.customerCode)||!validActualVehicle(r.confirmedVehicle)||!Number.isSafeInteger(r.count)||r.count<1)throw Error('PUBLIC_DAY_PROTECTED_OR_INVALID');const k=[date,r.customerCode,r.confirmedVehicle].join('|');if(keys.has(k))throw Error('PUBLIC_DAY_DUPLICATE');keys.add(k);}return rows;
}
export function createPublicDayStore({storage,now=Date.now,availableBytes=()=>0}={}){
 const key=ref=>{if(!isDay(ref.date)||!/^[a-f0-9]{64}$/.test(ref.hash||'')||!Number.isSafeInteger(ref.bytes)||ref.bytes<2||ref.bytes>4194304)throw Error('PUBLIC_DAY_REF');return PREFIX+':day:'+ref.date+':'+ref.hash;};
 function prune(){const t=now(),all=dayIndex(storage),keep=all.filter(e=>e.until>t&&e.at<=t);try{storage?.setItem(DAY_INDEX,JSON.stringify(keep));for(const e of all)if(!keep.includes(e))storage?.removeItem(e.key);}catch{}return keep;}
 return {
  get(ref){try{const k=key(ref),entries=prune(),e=entries.find(e=>e.key===k);if(!e)return null;const text=storage?.getItem(k);if(typeof text!=='string'||size(text)!==ref.bytes||size(text)>1048576)return null;const rows=checkPublicDayRows(JSON.parse(text),ref.date);e.at=now();storage?.setItem(DAY_INDEX,JSON.stringify(entries));return rows;}catch{return null;}},
  put(ref,rows,scope,verifiedHash){
   checkPublicDayRows(rows,ref.date);const k=key(ref),text=JSON.stringify(rows),bytes=size(text);if(verifiedHash!==ref.hash||bytes!==ref.bytes||!['base','history'].includes(scope))throw Error('PUBLIC_DAY_HASH_REQUIRED');
   const allowance=availableBytes();if(!Number.isSafeInteger(allowance)||allowance<bytes||bytes>1048576)return false;
   let legacy;try{legacy=size(storage?.getItem(PREFIX)||'');}catch{return false;}
   const all=prune(),replaced=all.filter(e=>e.date===ref.date&&e.key!==k),keep=all.filter(e=>e.key!==k&&e.date!==ref.date),t=now();
   const next={key:k,date:ref.date,hash:ref.hash,bytes,at:t,until:t+(scope==='history'?DAY_TTL:BASE_TTL),scope};
   const evicted=[...replaced];while(keep.length>=32||legacy+keep.reduce((n,e)=>n+e.bytes,0)+bytes+16000>Math.min(MAX,allowance)){
    const eligible=[...keep].sort((a,b)=>(a.scope==='history'?0:1)-(b.scope==='history'?0:1)||a.at-b.at)[0];if(!eligible)return false;keep.splice(keep.indexOf(eligible),1);evicted.push(eligible);
   }
   const existed=all.some(e=>e.key===k);try{storage?.setItem(k,text);storage?.setItem(DAY_INDEX,JSON.stringify([...keep,next]));for(const e of evicted)storage?.removeItem(e.key);return !!storage;}catch{if(!existed)try{storage?.removeItem(k);}catch{}return false;}
  },
  reconcile(window){if(!isDay(window?.startDate)||!isDay(window?.endDate)||window.startDate>window.endDate)throw Error('PUBLIC_DAY_WINDOW');
   const refs=new Map((window.days||[]).map(r=>[r.date,r]));
   const all=prune(),keep=all.filter(e=>e.scope==='history'||e.date>=window.startDate&&e.date<=window.endDate&&(!refs.has(e.date)||refs.get(e.date).hash===e.hash));try{storage?.setItem(DAY_INDEX,JSON.stringify(keep));for(const e of all)if(!keep.includes(e))storage?.removeItem(e.key);}catch{}},
  clearHistory(){const all=dayIndex(storage),keep=all.filter(e=>e.scope!=='history');try{storage?.setItem(DAY_INDEX,JSON.stringify(keep));for(const e of all)if(e.scope==='history')storage?.removeItem(e.key);}catch{}},
  stats(){const all=prune();return{entries:all.length,dayBytes:all.reduce((n,e)=>n+e.bytes,0),sharedBytes:indexBytes(storage)+size(storage?.getItem(PREFIX)||'')};}
 };
}

