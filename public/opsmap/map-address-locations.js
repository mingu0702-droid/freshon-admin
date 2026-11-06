(function(root){
 'use strict';
 // Page-memory projection only. Never mutate a source row or persist provider points.
 const SOURCE='KAKAO_ADDRESS_LIVE',normalize=v=>String(v||'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
 const valid=r=>typeof r?.lat==='number'&&typeof r?.lng==='number'&&Number.isFinite(r.lat)&&Number.isFinite(r.lng)&&r.lat>=33&&r.lat<=39.5&&r.lng>=124&&r.lng<=132;
 const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
 const addressMismatch=row=>{
  if(!row)return false;
  const current=[row.currentAddressHash,row.customerRegistryAddressHash,row.raw?.currentAddressHash,row.raw?.customerRegistryAddressHash].find(validHash);
  const manual=row.coordinateSource==='MANUAL_PIN'&&row.resolutionStatus==='MANUAL_CONFIRMED'?row.manualPinAddressHash:null;
  const evidence=[manual,row.coordinateAddressHash,row.raw?.coordinateAddressHash,row.originalAddressHash,row.raw?.originalAddressHash,row.addressHash,row.raw?.addressHash].find(validHash);
  return Boolean(current&&evidence&&current!==evidence);
 };
 const established=r=>valid(r)&&!addressMismatch(r)&&!['CONFLICT','MISSING','UNVERIFIED'].includes(r.coordinateStatus)&&r.resolutionStatus!=='ADDRESS_CHANGED_REVIEW_REQUIRED'&&r.coordinateSource!==SOURCE;
 const hashAddress=async value=>{if(!root.crypto?.subtle||!root.TextEncoder)return '';try{const data=new root.TextEncoder().encode(normalize(value));return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',data)),v=>v.toString(16).padStart(2,'0')).join('');}catch{return '';}};
 function create({lookup,readAddress,queryFor,enabled=()=>true,onChange=()=>{},now=Date.now,spacingMs=4000}={}){
  let epoch=0,running=false,controller=new AbortController(),syncToken='';
  const points=new Map(),pending=new Map(),outcomes=new Map(),queue=new Map(),bindings=new Map(),addresses=new Map(),searches=new Map(),searchChecks=new Map(),registryPolicies=new Map(),active=new Set(),attempts=new Map();
  const sourceHash=row=>row.currentAddressHash||row.raw?.currentAddressHash||row.originalAddressHash||row.addressHash||row.raw?.originalAddressHash||row.raw?.addressHash||'';
  const observedDate=row=>row.raw?.lastDeliveryDate||row.lastDeliveryDate||'';
  const conflicted=row=>row.searchAddressConflict===true||row.addressChanged===true||row.resolutionStatus==='ADDRESS_CHANGED_REVIEW_REQUIRED';
  const addressFor=row=>{
   const cached=addresses.get(row.customerCode),bound=cached?.sourceHash===sourceHash(row);
   const registryAddress=row.currentMasterStatus==='FOUND'&&validHash(row.customerRegistryAddressHash)&&row.currentAddressHash===row.customerRegistryAddressHash;
   const sameRegistryAddress=row.raw?.customerRegistryAddressHash===row.currentAddressHash&&normalize(row.raw?.address)===normalize(row.address);
   if(conflicted(row))return bound&&cached.conflict?cached.address:registryAddress&&(!row.searchAddressConflict||sameRegistryAddress)?row.address||'':'';
   return bound?cached.address:row.address||'';
  };
  const searchFor=row=>{const value=searches.get(row.customerCode);return !searchRevoked(row)&&value?.sourceHash===sourceHash(row)&&value.originalAddress===normalize(addressFor(row))?value:null;};
  const queryForRow=row=>searchFor(row)?.query||queryFor?.(addressFor(row));
  const projectionSearch=row=>row.coordinateSearch||row.raw?.coordinateSearch;
  const approvalKey=value=>value?JSON.stringify([value.customerCode,value.originalAddressHash,value.queryHash,value.accuracy,value.storeInteriorVerified,value.ruleVersion]):'';
  const registryVersion=row=>row.customerRegistryVersion||row.raw?.customerRegistryVersion||'';
  const searchRevoked=row=>registryPolicies.get(row.customerCode)?.revoked===true||!!registryVersion(row)&&!projectionSearch(row);
  const policyAllows=(row,value)=>!searchRevoked(row)&&(!registryPolicies.has(row.customerCode)||registryPolicies.get(row.customerCode).approval===approvalKey(value));
  function observeRegistry(row,canonical=false){
   const version=registryVersion(row);if(!version)return;
   const code=row.customerCode,previous=registryPolicies.get(code),revoked=!projectionSearch(row);
   // Only the canonical sync can reapprove a withdrawn rule; stale selected
   // copies and late private-detail responses cannot restore the old approval.
   if(!revoked&&previous&&!canonical)return;
   const hadSearch=searches.has(code)||searchChecks.has(code),changed=!previous||previous.version!==version||previous.revoked!==revoked;
   if((changed||revoked&&hadSearch)&&(hadSearch||previous?.revoked&&!revoked)){
    searches.delete(code);searchChecks.delete(code);bindings.delete(code);outcomes.delete(code);
    if(row.coordinateSource===SOURCE){row.lat=null;row.lng=null;row.coordinateSource='';row.coordinateStatus='MISSING';row.coordinateAccuracy='UNVERIFIED';row.resolutionStatus='COORDINATE_REVIEW_REQUIRED';delete row.addressLocationKey;}
   }
   registryPolicies.set(code,{version,revoked,approval:approvalKey(projectionSearch(row))});
  }
  const projectionCheckKey=row=>{const value=projectionSearch(row);return value?JSON.stringify([sourceHash(row),normalize(addressFor(row)),value.customerCode,value.originalAddressHash,value.query,value.queryHash,value.accuracy,value.storeInteriorVerified,value.ruleVersion]):'';};
  const uncheckedProjection=row=>!!projectionSearch(row)&&!searchRevoked(row)&&!searchFor(row)&&searchChecks.get(row.customerCode)?.key!==projectionCheckKey(row);
  async function acceptSearch(row,source,owner,sourceBinding){
   const value=source?.coordinateSearch;
   if(!policyAllows(row,value)||!value||value.customerCode!==row.customerCode||source.customerCode!==row.customerCode||value.ruleVersion!=='USER_CONFIRMED_SEARCH_ADDRESS_20261104'||value.storeInteriorVerified!==false||!['BUILDING','CAMPUS'].includes(value.accuracy)||
    !/^[a-f0-9]{64}$/.test(value.originalAddressHash||'')||!/^[a-f0-9]{64}$/.test(value.queryHash||'')||typeof value.query!=='string'||value.query.length>200||/[\r\n\x00-\x1f]/.test(value.query)||sourceBinding&&sourceBinding!==value.originalAddressHash)return false;
   const [originalHash,queryHash]=await Promise.all([hashAddress(source.address),hashAddress(value.query)]);
   if(owner!==epoch||!policyAllows(row,value)||sourceHash(row)!==sourceBinding||originalHash!==value.originalAddressHash||queryHash!==value.queryHash||normalize(addressFor(row))!==normalize(source.address))return false;
   searches.set(row.customerCode,Object.freeze({sourceHash:sourceBinding,originalAddress:normalize(source.address),query:value.query,accuracy:value.accuracy}));
   bindings.delete(row.customerCode);outcomes.delete(row.customerCode);return true;
  }
  const identity=row=>/^[A-Z]\d+$/.test(row?.customerCode||'')&&row.currentMasterStatus!=='UNAVAILABLE'?normalize(addressFor(row)):'';
  const matchingOutcome=row=>{
   const outcome=outcomes.get(row.customerCode);
   return outcome?.sourceHash===sourceHash(row)&&(outcome.address===undefined||outcome.address===identity(row))?outcome:null;
  };
  function status(row){
   if(!row)return null;
   if(established(row))return {state:'ESTABLISHED'};
   if(row.coordinateSource===SOURCE&&valid(row)&&row.addressLocationKey===identity(row))return {state:'LOCATED'};
   const code=row.customerCode,outcome=matchingOutcome(row);
   if(active.has(code))return {state:'LOOKING_UP'};
   if(outcome?.state==='REVIEW')return {state:'REVIEW',reason:outcome.reason};
   if(outcome?.state==='RETRY'&&outcome.retryAt>now())return {state:'DEFERRED',reason:outcome.reason,retryAt:outcome.retryAt};
   return {state:queue.has(code)?'QUEUED':'WAITING'};
  }
  function canSchedule(row){
   if(!/^[A-Z]\d+$/.test(row?.customerCode||'')||row.currentMasterStatus==='UNAVAILABLE'||row.customerRegistryStatus==='DELETED'||active.has(row.customerCode)||established(row))return false;
   if(uncheckedProjection(row))return true;
   const value=status(row);
   return value.state==='WAITING'||value.state==='QUEUED';
  }
  function apply(row){
   if(!row)return row;
   observeRegistry(row);
   const key=identity(row),prior=bindings.get(row.customerCode);
   if(prior&&prior!==key)outcomes.delete(row.customerCode);
   if(key)bindings.set(row.customerCode,key);
   if(established(row))return row;
   if(row.coordinateSource===SOURCE){row.lat=null;row.lng=null;row.coordinateSource='';row.coordinateStatus='MISSING';}
   else if(valid(row)&&(addressMismatch(row)||row.coordinateStatus==='CONFLICT'||row.resolutionStatus==='ADDRESS_CHANGED_REVIEW_REQUIRED')){
    row.coordinateEvidence ||= Object.freeze({lat:row.lat,lng:row.lng,coordinateSource:row.coordinateSource||'',coordinateAccuracy:row.coordinateAccuracy||''});
    Object.assign(row,{lat:null,lng:null,latitude:null,longitude:null,coordinateStatus:'CONFLICT',addressChanged:true,resolutionStatus:'ADDRESS_CHANGED_REVIEW_REQUIRED'});
   }
   const query=queryForRow(row),point=key&&points.get(normalize(query)),accuracy=searchFor(row)?.accuracy||'BUILDING';
   if(point&&valid(point))Object.assign(row,{lat:point.lat,lng:point.lng,coordinateSource:SOURCE,coordinateAccuracy:accuracy,coordinateStatus:accuracy==='CAMPUS'?'APPROXIMATE':'CONFIRMED',resolutionStatus:accuracy==='CAMPUS'?'CAMPUS_ADDRESS_LOCATED':'ADDRESS_LOCATED',addressLocationKey:key,storeInteriorVerified:false});
   return row;
  }
  async function ensure(row){
   observeRegistry(row);
   const projection=projectionSearch(row);
   if(projection&&!searchRevoked(row)&&!established(row)&&!searchFor(row)){
    const owner=epoch,sourceBinding=sourceHash(row),key=projectionCheckKey(row);let check=searchChecks.get(row.customerCode);
    if(check?.key!==key){check={key,promise:acceptSearch(row,{customerCode:row.customerCode,address:addressFor(row),coordinateSearch:projection},owner,sourceBinding)};searchChecks.set(row.customerCode,check);}
    await check.promise;if(owner!==epoch||sourceHash(row)!==sourceBinding)return row;
   }
   apply(row);if(established(row)||row.coordinateSource===SOURCE&&valid(row))return row;
   const code=row.customerCode,owner=epoch,sourceBinding=sourceHash(row);
   if(!/^[A-Z]\d+$/.test(code||'')||row.currentMasterStatus==='UNAVAILABLE'||!enabled())return row;
   const signal=controller.signal;
   if(!addressFor(row)&&readAddress){
    const prior=outcomes.get(code);if(prior?.sourceHash===sourceBinding&&prior.retryAt>now())return row;
    const attemptKey=code+'|'+sourceBinding;attempts.set(attemptKey,(attempts.get(attemptKey)||0)+1);
    try{const source=await readAddress(row,signal);if(owner!==epoch||signal.aborted||sourceHash(row)!==sourceBinding)return row;
     if(source?.customerCode!==code||!source.address)throw Object.assign(Error('CUSTOMER_ADDRESS_UNAVAILABLE'),{code:'CUSTOMER_ADDRESS_UNAVAILABLE'});
     addresses.set(code,{address:source.address,sourceHash:sourceBinding,observedDate:observedDate(row),conflict:conflicted(row)});
     await acceptSearch(row,source,owner,sourceBinding);if(owner!==epoch||signal.aborted||sourceHash(row)!==sourceBinding)return row;
    }catch(error){if(owner===epoch&&!signal.aborted){const notFound=error?.status===404;outcomes.set(code,{sourceHash:sourceBinding,state:!notFound&&attempts.get(attemptKey)<2?'RETRY':'REVIEW',reason:notFound?'CUSTOMER_NOT_FOUND':'CUSTOMER_ADDRESS_UNAVAILABLE',retryAt:now()+60000});}return row;}
   }
   const address=identity(row),query=queryForRow(row),key=normalize(query);
   if(!address||!key){outcomes.set(code,{address,sourceHash:sourceBinding,state:'REVIEW',reason:'CUSTOMER_ADDRESS_INVALID'});return row;}
   bindings.set(code,address);
   if(points.has(key)){apply(row);outcomes.set(code,{address,sourceHash:sourceBinding,state:'LOCATED',reason:'EXACT_ADDRESS'});onChange(code);return row;}
   const prior=matchingOutcome(row);
   if(prior&&(prior.state!=='RETRY'||prior.retryAt>now()))return row;
   const lookupAttempt='lookup:'+code+'|'+address;attempts.set(lookupAttempt,(attempts.get(lookupAttempt)||0)+1);
   try{
    if(!pending.has(key)){const lookupAddress=searchFor(row)?.query||addressFor(row),task=Promise.resolve().then(()=>lookup(lookupAddress,signal)).then(point=>{
     if(owner!==epoch||signal.aborted)return null;
     if(!point||point.candidates||!valid(point))return null;
     points.set(key,Object.freeze({lat:point.lat,lng:point.lng}));return point;
    }).finally(()=>{if(pending.get(key)===task)pending.delete(key);});pending.set(key,task);}
    const point=await pending.get(key);
    if(owner!==epoch||signal.aborted||sourceHash(row)!==sourceBinding||normalize(queryForRow(row))!==key||identity(row)!==address||bindings.get(code)!==address)return row;
    outcomes.set(code,{address,sourceHash:sourceBinding,state:point?'LOCATED':'REVIEW',reason:point?'EXACT_ADDRESS':'ADDRESS_NOT_EXACT'});
    if(point){apply(row);onChange(code);}return row;
   }catch(error){
    if(owner!==epoch||signal.aborted||normalize(queryForRow(row))!==key)return row;
    const reason=/^[A-Z_]+$/.test(error?.code||'')?error.code:'ADDRESS_LOOKUP_FAILED';
    const daily=reason==='GEOCODE_DAILY_LIMIT';
    const retry=daily||attempts.get(lookupAttempt)<2&&/TIMEOUT|NETWORK|UNAVAILABLE|COOLDOWN|GEOCODER_FAILED|LOOKUP_FAILED/.test(reason);
    const retryAt=daily?(Math.floor((now()+32400000)/86400000)+1)*86400000-32400000:now()+60000;
    outcomes.set(code,{address,sourceHash:sourceBinding,state:retry?'RETRY':'REVIEW',reason,retryAt});return row;
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
   for(const row of rows||[]){apply(row);if(canSchedule(row))additions.push([row.customerCode,row]);}
   if(priority){const rest=[...queue];queue.clear();for(const entry of additions)queue.set(...entry);for(const entry of rest)if(!queue.has(entry[0]))queue.set(...entry);}
   else{queue.clear();for(const entry of additions)queue.set(...entry);}
   void drain();
  }
  function onSourceSync(token,rows=[]){
   if(!token||token===syncToken)return;syncToken=token;
   for(const row of rows)observeRegistry(row,true);
   // Compare the canonical synced row, never a temporary filtered/date copy.
   for(const row of rows){const cached=addresses.get(row.customerCode),date=observedDate(row);if(cached?.observedDate&&date&&cached.observedDate!==date){addresses.delete(row.customerCode);searches.delete(row.customerCode);searchChecks.delete(row.customerCode);bindings.delete(row.customerCode);outcomes.delete(row.customerCode);}}
   for(const [code,outcome]of outcomes){
    if(!/^(?:CUSTOMER_NOT_FOUND|CUSTOMER_ADDRESS_UNAVAILABLE|KAKAO_TIMEOUT|KAKAO_NETWORK_FAILED|GEOCODE_RETRY_COOLDOWN|GEOCODER_TIMEOUT)$/.test(outcome.reason)||now()<(outcome.retryAt||0)+240000)continue;
    outcomes.delete(code);for(const key of attempts.keys())if(key.startsWith(code+'|')||key.startsWith('lookup:'+code+'|'))attempts.delete(key);
   }
  }
  function clear(){epoch++;controller.abort();controller=new AbortController();points.clear();pending.clear();queue.clear();bindings.clear();outcomes.clear();addresses.clear();searches.clear();searchChecks.clear();registryPolicies.clear();attempts.clear();syncToken='';}
  function acceptAddress(row,source){
   if(!row||established(row)||source?.customerCode!==row.customerCode||!source.address||source.locationState!=='SOURCE_ROW')return;
   const current=source.sourceBasis==='CURRENT_CUSTOMER_LOOKUP',dated=source.sourceBasis==='DATED_DELIVERY_LOOKUP'&&source.currentMasterState==='NOT_FOUND'&&source.detailDate===observedDate(row);
   if(!current&&!dated)return;
   if(normalize(addressFor(row))===normalize(source.address)){if(source.coordinateSearch)void acceptSearch(row,source,epoch,sourceHash(row)).then(accepted=>{if(accepted){apply(row);onChange(row.customerCode);}});return;}
   addresses.set(row.customerCode,{address:source.address,sourceHash:sourceHash(row),observedDate:observedDate(row),conflict:conflicted(row)});bindings.delete(row.customerCode);outcomes.delete(row.customerCode);apply(row);onChange(row.customerCode);
   searches.delete(row.customerCode);if(source.coordinateSearch)void acceptSearch(row,source,epoch,sourceHash(row)).then(accepted=>{if(accepted){apply(row);onChange(row.customerCode);}});
  }
  return Object.freeze({apply,ensure,schedule,clear,onSourceSync,acceptAddress,status,canSchedule,busy:()=>running,source:SOURCE,summary:()=>({located:[...outcomes.values()].filter(r=>r.state==='LOCATED').length,review:[...outcomes.values()].filter(r=>r.state==='REVIEW').length,retry:[...outcomes.values()].filter(r=>r.state==='RETRY').length,queued:queue.size,pending:pending.size,retention:'PAGE_MEMORY_ONLY'})});
 }
 root.MapAddressLocations=Object.freeze({create,source:SOURCE});
})(typeof window==='object'?window:globalThis);
