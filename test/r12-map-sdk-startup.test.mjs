import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/opsmap/kakao-maps-adapter.js',import.meta.url),'utf8');
function fixture(reply,config={}){
 let loads=0;const root=Object.assign(new EventTarget(),{KAKAO_MAP_CONFIG:config,kakao:{maps:{load:callback=>{loads++;callback();}}}});

 vm.runInNewContext(source,{window:root,document:{getElementById:()=>null},fetch:reply,setTimeout,clearTimeout,AbortController,CustomEvent});
 return{root,loads:()=>loads};}
test('registered center is carried by the existing SDK-only request',async()=>{
 const centers=[{id:'osan',verified:true,sourceVersion:'SYNTHETIC',lat:37.001234567,lng:127.001234567}];
 const calls=[],f=fixture(async url=>{calls.push(url);return {ok:true,json:async()=>({centers})};});
 await f.root.KakaoMapsAdapter.ready();
 assert.deepEqual(Array.from(f.root.KAKAO_MAP_CONFIG.centers),centers);
 assert.deepEqual(calls,['/api/map-phase2b/private/map-sdk-config?sdkOnly=1']);
});
test('staff logout purges center config and reauthentication reuses the SDK-only request',async()=>{
 const local={id:'yeongnam',verified:true,sourceVersion:'SYNTHETIC',lat:35,lng:128};
 const osan={id:'osan',verified:true,sourceVersion:'SYNTHETIC',lat:37,lng:127};
 let calls=0;const f=fixture(async()=>{calls++;return {ok:true,json:async()=>({centers:[osan]})};},{centers:[local]});
 await f.root.KakaoMapsAdapter.ready();
 assert.deepEqual(Array.from(f.root.KAKAO_MAP_CONFIG.centers),[local,osan]);
 f.root.dispatchEvent(new Event('map-staff-signed-out'));
 assert.equal(f.root.KAKAO_MAP_CONFIG.centers,undefined);
 await f.root.KakaoMapsAdapter.ready();
 assert.deepEqual(Array.from(f.root.KAKAO_MAP_CONFIG.centers),[local,osan]);
 assert.equal(calls,2);
});
test('authenticated configuration waiting does not consume the SDK initialization deadline',async()=>{
 const f=fixture(async()=>{await new Promise(r=>setTimeout(r,30));return{ok:true,json:async()=>({allowExternalAddressLookup:true,addressLookupServerProxy:true})};});
 await f.root.KakaoMapsAdapter.ready({timeoutMs:5,configTimeoutMs:500});assert.equal(f.loads(),1);assert.equal(f.root.KAKAO_MAP_CONFIG.allowExternalAddressLookup,true);
});
test('late configuration after its deadline cannot enable lookup or initialize a stale SDK',async()=>{
 let release;const gate=new Promise(r=>release=r),f=fixture(async()=>{await gate;return{ok:true,json:async()=>({allowExternalAddressLookup:true,addressLookupServerProxy:true})};});
 await assert.rejects(f.root.KakaoMapsAdapter.ready({timeoutMs:50,configTimeoutMs:5}),/MAP_SDK_CONFIG_TIMEOUT/);release();await new Promise(r=>setTimeout(r,5));assert.equal(f.loads(),0);assert.equal(f.root.KAKAO_MAP_CONFIG.allowExternalAddressLookup,false);
});
test('the map SDK is available before the durable address capability responds',async()=>{
 let release,calls=0;const gate=new Promise(resolve=>release=resolve);
 const f=fixture(async url=>{
  if(url.endsWith('?sdkOnly=1'))return {ok:true,json:async()=>({addressLookupPending:true})};
  calls++;await gate;
  return {ok:true,json:async()=>({allowExternalAddressLookup:true,addressLookupServerProxy:true})};
 });
 await f.root.KakaoMapsAdapter.ready();assert.equal(f.loads(),1);assert.equal(calls,0);
 const check=f.root.KakaoMapsAdapter.refreshAddressLookup();assert.equal(check,f.root.KakaoMapsAdapter.refreshAddressLookup());
 assert.equal(f.root.KAKAO_MAP_CONFIG.allowExternalAddressLookup,false);release();await check;
 assert.equal(f.root.KAKAO_MAP_CONFIG.allowExternalAddressLookup,true);assert.equal(calls,1);
});
