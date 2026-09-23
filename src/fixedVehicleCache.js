import crypto from 'node:crypto';
import {fixedEnvelope,validateFixedEnvelope} from './fixedVehicleStore.js';

export function createFixedVehicleCache({reader,store,now=Date.now,ttl=1800000}) {
  let current=null,index=new Map(),loadPending=null,loaded=false,pending=null,error=null,retryAt=0,refreshStartedAt=null,refreshMs=null;
  function install(envelope){const checked=validateFixedEnvelope(envelope);current=checked.envelope;index=new Map(checked.data.map(r=>[r.customerCode,r]));}
  async function initialize(){
    if(loaded||now()<retryAt&&(current||error))return;if(loadPending)return loadPending;
    loadPending=(async()=>{if(store){const saved=await store.load();if(saved)install(saved);}loaded=true;})().finally(()=>{loadPending=null;});
    return loadPending;
  }
  function refresh(){
    if(pending||now()<retryAt)return pending;
    pending=Promise.resolve().then(async()=>{
      const owner=crypto.randomUUID(),controller=new AbortController();let acquired=false,timer,leaseError=null,renewPending=null;
      try{
        if(store){acquired=await store.acquire(owner);if(!acquired){retryAt=now()+60000;loaded=false;return;}}
        refreshStartedAt=new Date(now()).toISOString();
        if(store){timer=setInterval(()=>{if(!renewPending)renewPending=store.renew(owner).catch(()=>{leaseError='FIXED_STORE_LEASE_LOST';controller.abort();}).finally(()=>{renewPending=null;});},240000);timer.unref?.();}
        const result=await reader({signal:controller.signal});
        if(renewPending)await renewPending;if(leaseError)throw Object.assign(Error(leaseError),{code:leaseError});
        const envelope=fixedEnvelope(result.data,new Date(now()).toISOString());
        if(store){await store.renew(owner);await store.save(envelope);}
        install(envelope);error=null;retryAt=0;refreshMs=now()-Date.parse(refreshStartedAt);
      }catch(e){error=/^FIXED_(STORE|MASTER)_[A-Z_]+$/.test(e.code||'')?e.code:'FIXED_MASTER_UNAVAILABLE';retryAt=now()+300000;}
      finally{clearInterval(timer);if(renewPending)await renewPending;if(acquired)await store.release(owner).catch(()=>{});}
    }).finally(()=>{pending=null;});return pending;
  }
  async function get(codes){
    try{await initialize();}catch(e){error=/^FIXED_STORE_[A-Z_]+$/.test(e.code||'')?e.code:'FIXED_STORE_UNAVAILABLE';retryAt=now()+300000;}
    const stale=!current||now()-Date.parse(current.checkedAt)>=ttl;
    if(stale&&(!store||loaded))void refresh();
    const meta={basis:'FIXED_DISPATCH_PRIMARY',checkedAt:current?.checkedAt||null,version:current?.version||null,total:current?.count||0,stale,
      refresh:pending?'RUNNING':error?'ERROR':retryAt>now()?'WAITING':'IDLE',lastError:error,refreshStartedAt,refreshMs,persistent:!!store};
    if(!current)return {ok:false,phase:pending?'LOADING':error?'ERROR':'LOADING',meta};
    const rows=codes===null?[...index.values()]:(codes||[]).map(customerCode=>index.get(customerCode)||{customerCode,baseVehicle:'',baseVehicleGroup:'',baseVehicleState:'NOT_IN_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY'});
    return {ok:true,data:rows.map(r=>({...r,baseVehicleCheckedAt:meta.checkedAt,baseVehicleVersion:meta.version,baseVehicleStale:stale})),meta};
  }
  return {get,settled:()=>pending,refresh};
}
