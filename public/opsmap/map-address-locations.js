(function(root){
 'use strict';
 // Page-memory projection only. Never mutate a source row or persist provider points.
 const SOURCE='KAKAO_ADDRESS_LIVE',normalize=v=>String(v||'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
 const valid=r=>typeof r?.lat==='number'&&typeof r?.lng==='number'&&Number.isFinite(r.lat)&&Number.isFinite(r.lng)&&r.lat>=33&&r.lat<=39.5&&r.lng>=124&&r.lng<=132;
 const established=r=>valid(r)&&!['CONFLICT','MISSING','UNVERIFIED'].includes(r.coordinateStatus)&&r.resolutionStatus!=='ADDRESS_CHANGED_REVIEW_REQUIRED'&&r.coordinateSource!==SOURCE;
 function create({lookup,readAddress,queryFor,enabled=()=>true,onChange=()=>{},now=Date.now,spacingMs=4000}={}){
  let epoch=0,running=false,controller=new AbortController();
  const points=new Map(),pending=new Map(),outcomes=new Map(),queue=new Map(),bindings=new Map(),addresses=new Map(),active=new Set(),attempts=new Map();
  const sourceHash=row=>row.originalAddressHash||row.addressHash||row.raw?.originalAddressHash||row.raw?.addressHash||'';
  const conflicted=row=>row.searchAddressConflict===true||row.addressChanged===true||row.resolutionStatus==='ADDRESS_CHANGED_REVIEW_REQUIRED';
  const addressFor=row=>{const cached=addresses.get(row.customerCode),bound=cached?.sourceHash===sourceHash(row);return conflicted(row)?bound&&cached.conflict?cached.address:'':row.address||(bound?cached.address:'');};
  const identity=row=>/^[A-Z]\d+$/.test(row?.customerCode||'')&&row.currentMasterStatus!=='UNAVAILABLE'?normalize(addressFor(row)):'';
  function apply(row){
   if(!row)return row;
   const key=identity(row),prior=bindings.get(row.customerCode);
   if(prior&&prior!==key)outcomes.delete(row.customerCode);
   if(key)bindings.set(row.customerCode,key);
   if(established(row))return row;
   if(row.coordinateSource===SOURCE){row.lat=null;row.lng=null;row.coordinateSource='';row.coordinateStatus='MISSING';}
   const query=queryFor?.(addressFor(row)),point=key&&points.get(normalize(query));
   if(point&&valid(point))Object.assign(row,{lat:point.lat,lng:point.lng,coordinateSource:SOURCE,coordinateAccuracy:'BUILDING',coordinateStatus:'CONFIRMED',resolutionStatus:'ADDRESS_LOCATED',addressLocationKey:key});
   return row;
  }
  async function ensure(row){
   apply(row);if(established(row)||row.coordinateSource===SOURCE&&valid(row))return row;
   const code=row.customerCode,owner=epoch,sourceBinding=sourceHash(row);
   if(!/^[A-Z]\d+$/.test(code||'')||row.currentMasterStatus==='UNAVAILABLE'||!enabled())return row;
   const signal=controller.signal;
   if(!addressFor(row)&&readAddress){
    const prior=outcomes.get(code);if(prior?.sourceHash===sourceBinding&&prior.retryAt>now())return row;
    const attemptKey=code+'|'+sourceBinding;attempts.set(attemptKey,(attempts.get(attemptKey)||0)+1);
    try{const source=await readAddress(row,signal);if(owner!==epoch||signal.aborted||sourceHash(row)!==sourceBinding)return row;
     if(source?.customerCode!==code||!source.address)throw Object.assign(Error('CUSTOMER_ADDRESS_UNAVAILABLE'),{code:'CUSTOMER_ADDRESS_UNAVAILABLE'});
     addresses.set(code,{address:source.address,sourceHash:sourceBinding,conflict:conflicted(row)});
    }catch(error){if(owner===epoch&&!signal.aborted){const notFound=error?.status===404;outcomes.set(code,{sourceHash:sourceBinding,state:!notFound&&attempts.get(attemptKey)<2?'RETRY':'REVIEW',reason:notFound?'CUSTOMER_NOT_FOUND':'CUSTOMER_ADDRESS_UNAVAILABLE',retryAt:now()+60000});onChange(code);}return row;}
   }
   const address=identity(row),query=queryFor?.(addressFor(row)),key=normalize(query);
   if(!address||!key){outcomes.set(code,{address,sourceHash:sourceBinding,state:'REVIEW',reason:'CUSTOMER_ADDRESS_INVALID'});return row;}
   bindings.set(code,address);
   if(points.has(key)){apply(row);outcomes.set(code,{address,state:'LOCATED',reason:'EXACT_ADDRESS'});onChange(code);return row;}
   const prior=outcomes.get(code);
   if(prior?.address===address&&(prior.state!=='RETRY'||prior.retryAt>now()))return row;
   const lookupAttempt='lookup:'+code+'|'+address;attempts.set(lookupAttempt,(attempts.get(lookupAttempt)||0)+1);
   try{
    if(!pending.has(key)){const task=Promise.resolve().then(()=>lookup(addressFor(row),signal)).then(point=>{
     if(owner!==epoch||signal.aborted)return null;
     if(!point||point.candidates||!valid(point))return null;
     points.set(key,Object.freeze({lat:point.lat,lng:point.lng}));return point;
    }).finally(()=>{if(pending.get(key)===task)pending.delete(key);});pending.set(key,task);}
    const point=await pending.get(key);
    if(owner!==epoch||signal.aborted||identity(row)!==address||bindings.get(code)!==address)return row;
    outcomes.set(code,{address,state:point?'LOCATED':'REVIEW',reason:point?'EXACT_ADDRESS':'ADDRESS_NOT_EXACT'});
    apply(row);onChange(code);return row;
   }catch(error){
    if(owner!==epoch||signal.aborted)return row;
    const reason=/^[A-Z_]+$/.test(error?.code||'')?error.code:'ADDRESS_LOOKUP_FAILED';
    const retry=attempts.get(lookupAttempt)<2&&/TIMEOUT|NETWORK|UNAVAILABLE|COOLDOWN|GEOCODER_FAILED|LOOKUP_FAILED/.test(reason);
    outcomes.set(code,{address,state:retry?'RETRY':'REVIEW',reason,retryAt:now()+60000});onChange(code);return row;
   }
  }
  async function drain(){
   if(running)return;running=true;const owner=epoch;
   const worker=async()=>{while(queue.size&&enabled()&&owner===epoch){const [key,row]=queue.entries().next().value;queue.delete(key);active.add(key);try{await ensure(row);}finally{active.delete(key);}if(queue.size&&owner===epoch)await new Promise(resolve=>setTimeout(resolve,spacingMs));}};
   // The shared server queue paces Customer reads; two workers overlap only
   // source waiting with the separate durable Kakao-budget transaction.
   try{await Promise.all([worker(),worker()]);}
   finally{running=false;if(queue.size&&owner!==epoch)void drain();}
  }
  function schedule(rows,{priority=false}={}){
   if(!enabled())return;
   const additions=[];
   for(const row of rows||[]){apply(row);if(active.has(row?.customerCode)||established(row)||valid(row)&&row.coordinateSource===SOURCE||!/^[A-Z]\d+$/.test(row?.customerCode||'')||row.currentMasterStatus==='UNAVAILABLE')continue;
    const previous=outcomes.get(row.customerCode);if(previous&&(previous.address===identity(row)||previous.sourceHash===sourceHash(row))&&(previous.state!=='RETRY'||previous.retryAt>now()))continue;
    additions.push([row.customerCode,row]);}
   if(priority){const rest=[...queue];queue.clear();for(const entry of additions)queue.set(...entry);for(const entry of rest)if(!queue.has(entry[0]))queue.set(...entry);}
   else{queue.clear();for(const entry of additions)queue.set(...entry);}
   void drain();
  }
  function clear(){epoch++;controller.abort();controller=new AbortController();points.clear();pending.clear();queue.clear();bindings.clear();outcomes.clear();addresses.clear();attempts.clear();}
  return Object.freeze({apply,ensure,schedule,clear,source:SOURCE,summary:()=>({located:[...outcomes.values()].filter(r=>r.state==='LOCATED').length,review:[...outcomes.values()].filter(r=>r.state==='REVIEW').length,retry:[...outcomes.values()].filter(r=>r.state==='RETRY').length,queued:queue.size,pending:pending.size,retention:'PAGE_MEMORY_ONLY'})});
 }
 root.MapAddressLocations=Object.freeze({create,source:SOURCE});
})(typeof window==='object'?window:globalThis);
