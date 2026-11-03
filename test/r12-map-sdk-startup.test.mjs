import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/opsmap/kakao-maps-adapter.js',import.meta.url),'utf8');
function fixture(reply){let loads=0;const root={KAKAO_MAP_CONFIG:{},kakao:{maps:{load:callback=>{loads++;callback();}}},dispatchEvent(){}};
 vm.runInNewContext(source,{window:root,document:{getElementById:()=>null},fetch:reply,setTimeout,clearTimeout,CustomEvent:class{}});
 return{root,loads:()=>loads};}
test('authenticated configuration waiting does not consume the SDK initialization deadline',async()=>{
 const f=fixture(async()=>{await new Promise(r=>setTimeout(r,30));return{ok:true,json:async()=>({allowExternalAddressLookup:true,addressLookupServerProxy:true})};});
 await f.root.KakaoMapsAdapter.ready({timeoutMs:5,configTimeoutMs:500});assert.equal(f.loads(),1);assert.equal(f.root.KAKAO_MAP_CONFIG.allowExternalAddressLookup,true);
});
test('late configuration after its deadline cannot enable lookup or initialize a stale SDK',async()=>{
 let release;const gate=new Promise(r=>release=r),f=fixture(async()=>{await gate;return{ok:true,json:async()=>({allowExternalAddressLookup:true,addressLookupServerProxy:true})};});
 await assert.rejects(f.root.KakaoMapsAdapter.ready({timeoutMs:50,configTimeoutMs:5}),/MAP_SDK_CONFIG_TIMEOUT/);release();await new Promise(r=>setTimeout(r,5));assert.equal(f.loads(),0);assert.equal(f.root.KAKAO_MAP_CONFIG.allowExternalAddressLookup,false);
});
