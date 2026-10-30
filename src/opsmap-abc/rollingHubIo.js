// New local read actions; installed Hub must contain the matching handlers.
// No source fallback, source scan, write endpoint, or invented completion proof.
import {createPublishedDayPageReader} from './hybridDayIndex.js';
export function createRollingHubIo({callHub,now=Date.now}){
 if(typeof callHub!=='function')throw Error('ROLLING_IO_REQUIRED');
 async function read(action,params,{signal,maxResponseBytes,deadline=now()+10000}={}){signal?.throwIfAborted();if(now()>=deadline)throw Error('DAY_READ_DEADLINE');const r=await callHub(action,params,{privateRead:true,useCache:false,signal,deadline,maxResponseBytes});signal?.throwIfAborted();if(now()>=deadline||r?.ok!==true||r.meta?.restoreRequired!==false||Buffer.byteLength(JSON.stringify(r))>maxResponseBytes)throw Error('ROLLING_IO_CONTRACT');return r;}
 const readDateCatalog=async q=>(await read('rollingDateCatalog',{...(q.version?{version:q.version}:{}),...(q.selectionDate?{selectionDate:q.selectionDate}:{})},{...q,maxResponseBytes:131072})).data;
 let version,reader;
 const readDatePage=async q=>{if(!reader||version!==q.catalogVersion){const pinned=q.catalogVersion;version=pinned;reader=createPublishedDayPageReader({now,readVerifiedText:async(ref,options)=>{const r=await read('rollingDateText',{version:pinned,date:ref.date},{...options,maxResponseBytes:Math.min(2097152,ref.bytes*2+65536)});if(r.meta.version!==pinned||r.meta.date!==ref.date||r.meta.hash!==ref.hash||r.meta.bytes!==ref.bytes||r.meta.count!==ref.count)throw Error('DAY_HASH_CHANGED');return r.data.text;}});}return reader(q);};
 return {readDateCatalog,readDatePage};
}
