(function(root){
 'use strict';let pending,script;
 function ready({timeoutMs=8000}={}){
  if(pending)return pending;
  pending=new Promise(async(resolve,reject)=>{
   let finished=false;const finish=(error)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(Error(error)):resolve(root.kakao);},timer=setTimeout(()=>finish('MAP_SDK_TIMEOUT'),timeoutMs);
   function loaded(){try{if(typeof root.kakao?.maps?.load!=='function')return finish('MAP_SDK_UNAVAILABLE');root.kakao.maps.load(()=>finish());}catch{finish('MAP_SDK_INITIALIZATION_FAILED');}}
   let config=root.KAKAO_MAP_CONFIG||{};const tag=document.getElementById('kakaoMapsSdk');
   root.KAKAO_MAP_CONFIG={...config,allowExternalAddressLookup:false};
   root.OPSMAP_DRIVER_CONTACT_ENABLED=false;
   try{const response=await fetch('/api/map-phase2b/private/map-sdk-config',{credentials:'same-origin',cache:'no-store'});if(response.ok){const payload=await response.json();config={...config,javascriptKey:config.javascriptKey||payload.javascriptKey};root.KAKAO_MAP_CONFIG={...config,allowExternalAddressLookup:payload.allowExternalAddressLookup===true&&payload.addressLookupServerProxy===true,addressLookupServerProxy:true};root.OPSMAP_DRIVER_CONTACT_ENABLED=payload.driverContactEnabled===true;}else if(!config.javascriptKey&&!root.kakao?.maps?.load)return finish('MAP_JAVASCRIPT_KEY_UNCONFIGURED');}catch{if(!config.javascriptKey&&!root.kakao?.maps?.load)return finish('MAP_SDK_CONFIG_UNAVAILABLE');}
   root.dispatchEvent(new CustomEvent('map-driver-capability'));
   if(root.kakao?.maps?.load)return loaded();
   let url;try{url=new URL(tag?.dataset.sdkSrc||'https://dapi.kakao.com/v2/maps/sdk.js');if(config.javascriptKey)url.searchParams.set('appkey',config.javascriptKey);
    if(url.origin!=='https://dapi.kakao.com'||url.pathname!=='/v2/maps/sdk.js'||!/^[a-f0-9]{32}$/i.test(url.searchParams.get('appkey')||''))return finish('MAP_JAVASCRIPT_KEY_UNCONFIGURED');
    if(config.allowedOrigins&&(!Array.isArray(config.allowedOrigins)||!config.allowedOrigins.includes(location.origin)))return finish('MAP_DOMAIN_UNCONFIRMED');
    url.searchParams.set('autoload','false');url.searchParams.set('libraries','services');
   }catch{return finish('MAP_SDK_CONFIG_INVALID');}
   script=document.createElement('script');script.src=url.href;script.async=true;script.onload=loaded;script.onerror=()=>finish('MAP_SDK_LOAD_FAILED');document.head.append(script);
  });return pending;
 }
 function reset(){script?.remove();script=null;pending=null;}
 function geocoder(){return {serverProxy:true,addressSearch(query,callback){
  fetch('/api/map-phase2b/private/address-lookup',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({query})})
   .then(async response=>{const payload=await response.json();if(!response.ok||payload.ok!==true)throw Error('LOOKUP_FAILED');callback(payload.data.documents,payload.data.status);})
   .catch(()=>{root.KAKAO_MAP_CONFIG={...root.KAKAO_MAP_CONFIG,allowExternalAddressLookup:false};callback([],'ERROR');});
 }};}
 root.KakaoMapsAdapter=Object.freeze({ready,reset,geocoder});
})(typeof window==='object'?window:globalThis);

