(function(root){
 'use strict';let pending,script,localCenters,failed=false;
 const configPath='/api/map-phase2b/private/map-sdk-config';
 let addressPending=false,addressCheck=null,addressEpoch=0,dailyRetryAt=0,blockedReason=null;
 function lookupCapabilities(payload){
  const address=payload.allowExternalAddressLookup===true&&payload.addressLookupServerProxy===true;
  return {allowIndependentAddressLookup:payload.allowIndependentAddressLookup===true&&payload.addressLookupServerProxy===true,allowExternalAddressLookup:address,allowExternalPlaceLookup:address&&payload.allowExternalPlaceLookup===true,
   addressLookupReason:payload.addressLookupReason||null};
 }
 function refreshAddressLookup(){
  if(addressCheck)return addressCheck;
  if(!addressPending&&(!dailyRetryAt||Date.now()<dailyRetryAt))return Promise.resolve();
  const owner=addressEpoch;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  const task=fetch(configPath,{credentials:'same-origin',cache:'no-store',signal:controller.signal})
   .then(async response=>{
    if(!response.ok)return;
    const payload=await response.json();
    if(owner!==addressEpoch||controller.signal.aborted)return;
    addressPending=false;dailyRetryAt=0;blockedReason=null;
    const capability=lookupCapabilities(payload);
    root.KAKAO_MAP_CONFIG={...root.KAKAO_MAP_CONFIG,...capability};
    if(capability.allowExternalAddressLookup||capability.allowIndependentAddressLookup)root.dispatchEvent(new CustomEvent('map-address-capability'));
   }).catch(()=>{}).finally(()=>{clearTimeout(timer);if(addressCheck===task)addressCheck=null;});
  addressCheck=task;
  return task;
 }
 root.addEventListener?.('map-staff-signed-out',()=>{
  addressEpoch++;addressCheck=null;addressPending=true;dailyRetryAt=0;blockedReason=null;
  const {centers,shadowCoverageEnabled,shadowCoverageRestoring,...config}=root.KAKAO_MAP_CONFIG||{};
  root.KAKAO_MAP_CONFIG={...config,allowIndependentAddressLookup:false,allowExternalAddressLookup:false,allowExternalPlaceLookup:false};
  pending=null;failed=false;
 });
 function ready({timeoutMs=8000,configTimeoutMs=15000,retryFailed=false}={}){
  if(pending&&!(retryFailed&&failed))return pending;
  if(failed)reset();
  const task=new Promise(async(resolve,reject)=>{
   let finished=false,timer;const finish=(error)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(Error(error)):resolve(root.kakao);};
   timer=setTimeout(()=>finish('MAP_SDK_CONFIG_TIMEOUT'),configTimeoutMs);
   function loaded(){try{if(typeof root.kakao?.maps?.load!=='function')return finish('MAP_SDK_UNAVAILABLE');root.kakao.maps.load(()=>finish(owner===addressEpoch?undefined:'MAP_SDK_SESSION_CHANGED'));}catch{finish('MAP_SDK_INITIALIZATION_FAILED');}}
   let config=root.KAKAO_MAP_CONFIG||{};const tag=document.getElementById('kakaoMapsSdk');
   localCenters??=Array.isArray(config.centers)?config.centers:[];
   root.KAKAO_MAP_CONFIG={...config,allowIndependentAddressLookup:false,allowExternalAddressLookup:false,allowExternalPlaceLookup:false};
   root.OPSMAP_DRIVER_CONTACT_ENABLED=false;
   const owner=addressEpoch;
   try{
    const response=await fetch(configPath+'?sdkOnly=1',{credentials:'same-origin',cache:'no-store'});
    if(finished)return;
    const payload=response.ok||response.status===503?await response.json():null;
    if(finished)return;
    if(owner!==addressEpoch)return finish('MAP_SDK_SESSION_CHANGED');
    if(payload){
     const coverage={shadowCoverageEnabled:payload.shadowCoverageEnabled===true,shadowCoverageRestoring:payload.shadowCoverageRestoring===true};
     config={...config,...coverage};
     root.KAKAO_MAP_CONFIG={...root.KAKAO_MAP_CONFIG,...coverage};
     root.dispatchEvent(new Event('map-shadow-coverage-capability'));
    }
    if(response.ok){const serverCenters=Array.isArray(payload.centers)?payload.centers:[];
     const centers=[...localCenters.filter(row=>!serverCenters.some(server=>server?.id===row?.id)),...serverCenters];
     config={...config,javascriptKey:config.javascriptKey||payload.javascriptKey,...(centers.length?{centers}:{})};addressPending=payload.addressLookupPending===true;root.KAKAO_MAP_CONFIG={...config,...lookupCapabilities(addressPending?{}:payload),addressLookupServerProxy:true};root.OPSMAP_DRIVER_CONTACT_ENABLED=payload.driverContactEnabled===true;}else if(!config.javascriptKey&&!root.kakao?.maps?.load)return finish('MAP_JAVASCRIPT_KEY_UNCONFIGURED');}catch{if(finished)return;if(!config.javascriptKey&&!root.kakao?.maps?.load)return finish('MAP_SDK_CONFIG_UNAVAILABLE');}
   clearTimeout(timer);timer=setTimeout(()=>finish('MAP_SDK_TIMEOUT'),timeoutMs);
   root.dispatchEvent(new CustomEvent('map-driver-capability'));
   if(root.kakao?.maps?.load)return loaded();
   let url;try{url=new URL(tag?.dataset.sdkSrc||'https://dapi.kakao.com/v2/maps/sdk.js');if(config.javascriptKey)url.searchParams.set('appkey',config.javascriptKey);
    if(url.origin!=='https://dapi.kakao.com'||url.pathname!=='/v2/maps/sdk.js'||!/^[a-f0-9]{32}$/i.test(url.searchParams.get('appkey')||''))return finish('MAP_JAVASCRIPT_KEY_UNCONFIGURED');
    if(config.allowedOrigins&&(!Array.isArray(config.allowedOrigins)||!config.allowedOrigins.includes(location.origin)))return finish('MAP_DOMAIN_UNCONFIRMED');
    url.searchParams.set('autoload','false');url.searchParams.set('libraries','services');
   }catch{return finish('MAP_SDK_CONFIG_INVALID');}
   script=document.createElement('script');script.src=url.href;script.async=true;script.onload=loaded;script.onerror=()=>finish('MAP_SDK_LOAD_FAILED');document.head.append(script);
  });
  pending=task;
  void task.catch(()=>{if(pending===task)failed=true;});
  return task;
 }
 function reset(){script?.remove();script=null;pending=null;failed=false;}
 function geocoder(){
  const cache=new Map(),inflight=new Map();let epoch=0;
  const clear=()=>{epoch++;cache.clear();inflight.clear();};root.addEventListener?.('map-staff-signed-out',clear);root.addEventListener?.('pagehide',clear,{once:true});
  const proxy={serverProxy:true,get blockedReason(){return blockedReason;},addressSearch(query,callback,{signal,mode}={}){
   const key=(mode||'exact')+':'+String(query||'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim(),owner=epoch;
   if(!inflight.has(key)&&!cache.has(key)){
    const task=fetch('/api/map-phase2b/private/address-lookup',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(mode?{query,mode}:{query})})
     .then(async response=>{const payload=await response.json().catch(()=>null);if(!response.ok||payload?.ok!==true)throw Object.assign(Error('LOOKUP_FAILED'),{code:/^[A-Z_]+$/.test(payload?.error||'')?payload.error:response.status===401?'GEOCODE_SESSION_EXPIRED':'GEOCODER_FAILED',status:response.status,providerHttp:Number.isInteger(payload?.providerHttp)?payload.providerHttp:null});
      if(!mode&&owner===epoch&&payload.data.status==='OK'){while(cache.size>=512)cache.delete(cache.keys().next().value);cache.set(key,payload.data);}return payload.data;})
     .finally(()=>{if(inflight.get(key)===task)inflight.delete(key);});inflight.set(key,task);
   }
   Promise.resolve(cache.get(key)||inflight.get(key)).then(data=>{if(signal?.aborted||owner!==epoch)return;callback(data.documents,data.status,{status:200,httpStatus:200,providerHttp:data.providerHttp,resolution:data.resolution});})
    .catch(error=>{if(signal?.aborted||owner!==epoch)return;
     const code=error.code||'GEOCODER_FAILED';
     if(code==='OFFICIAL_ADDRESS_LOOKUP_DISABLED')root.KAKAO_MAP_CONFIG={...root.KAKAO_MAP_CONFIG,allowIndependentAddressLookup:false};
     if(/^(?:GEOCODE_(?:DAILY_LIMIT|SESSION_EXPIRED|ORIGIN_REJECTED|AUTOMATICALLY_BLOCKED|DURABLE_LEDGER_REQUIRED|LEDGER_INVALID)|GEOCODING_DISABLED|TARGET_APP_FREE_QUOTA_UNVERIFIED)$/.test(code)||error.providerHttp===401||error.providerHttp===403||error.providerHttp===429){
      blockedReason=code;
      if(code==='GEOCODE_DAILY_LIMIT')dailyRetryAt=(Math.floor((Date.now()+32400000)/86400000)+1)*86400000-32400000;
      root.KAKAO_MAP_CONFIG={...root.KAKAO_MAP_CONFIG,allowExternalAddressLookup:false,allowExternalPlaceLookup:false,addressLookupReason:code};
     }
     callback([],/^GEOCODE_(?:DAILY_LIMIT|SESSION_EXPIRED|ORIGIN_REJECTED|AUTOMATICALLY_BLOCKED)$/.test(code)?code:'ERROR',{code,status:error.status,httpStatus:error.status||null,providerHttp:Number.isInteger(error.providerHttp)?error.providerHttp:null});});
  }};return proxy;
 }
 root.KakaoMapsAdapter=Object.freeze({ready,reset,geocoder,refreshAddressLookup});
})(typeof window==='object'?window:globalThis);

