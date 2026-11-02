// Synthetic adapter control-flow checks only. No real SDK or source API requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const productionFile=new URL('../public/opsmap/kakao-maps-adapter.js',import.meta.url);
const stageFile=new URL('../public/kakao-maps-adapter.js',import.meta.url);
const adapterFile=process.env.OPSMAP_DRIVER_CAPABILITY_ADAPTER_SOURCE || fileURLToPath(fs.existsSync(productionFile)?productionFile:stageFile);
const source=fs.readFileSync(adapterFile,'utf8');
const syntheticKey='a'.repeat(32);

function fixture({cached=true,presetKey=false,reply=async()=>({ok:true,json:async()=>({javascriptKey:'b'.repeat(32),driverContactEnabled:true})}),lookupReply}={}) {
  const calls={config:0,scripts:0,loads:0,events:[],logs:0,configOptions:[],scriptUrls:[]};
  const root={location:{origin:'https://synthetic.invalid'},KAKAO_MAP_CONFIG:presetKey?{javascriptKey:syntheticKey}:{},
    dispatchEvent:event=>calls.events.push({type:event.type,enabled:root.OPSMAP_DRIVER_CONTACT_ENABLED})};
  const sdk=()=>({maps:{load:callback=>{calls.loads++;callback();}}});
  if(cached)root.kakao=sdk();
  const document={getElementById:()=>null,createElement:()=>({remove(){}}),head:{append:node=>{
    calls.scripts++;calls.scriptUrls.push(node.src);root.kakao=sdk();queueMicrotask(()=>node.onload());
  }}};
  const context={window:root,document,location:root.location,URL,CustomEvent:class{constructor(type){this.type=type;}},
    setTimeout,clearTimeout,queueMicrotask,
    console:Object.fromEntries(['log','info','warn','error','debug'].map(name=>[name,()=>{calls.logs++;}])),
    fetch:async(url,options)=>{if(url==='/api/map-phase2b/private/address-lookup'){assert(lookupReply,'proxy must be explicitly stubbed');return lookupReply(url,options);}assert.equal(url,'/api/map-phase2b/private/map-sdk-config');calls.config++;calls.configOptions.push(options);return reply();}};
  vm.runInNewContext(source,context,{filename:'synthetic-kakao-adapter.js'});
  return {root,calls};
}
function privateReadOnce(calls) {
  assert.equal(calls.config,1);assert.equal(calls.configOptions[0].credentials,'same-origin');assert.equal(calls.configOptions[0].cache,'no-store');
  assert.equal(calls.logs,0,'adapter must not print configuration or response values');
}

test('cached SDK still reads current private capability and accepts boolean true',async()=>{
  const {root,calls}=fixture();const original=root.kakao;
  assert.equal(await root.KakaoMapsAdapter.ready(),original);
  assert.equal(root.OPSMAP_DRIVER_CONTACT_ENABLED,true);privateReadOnce(calls);
  assert.equal(calls.scripts,0);assert.equal(calls.loads,1);
  assert.deepEqual(calls.events,[{type:'map-driver-capability',enabled:true}]);
});

test('production browser never enables an unreserved direct address lookup from preset flags',async()=>{
 const {root}=fixture();root.KAKAO_MAP_CONFIG.allowExternalAddressLookup=true;
 await root.KakaoMapsAdapter.ready();assert.equal(root.KAKAO_MAP_CONFIG.allowExternalAddressLookup,false);
});

test('authorized browser geocoder posts only to the staff REST proxy and closes on proxy error',async()=>{
 let requests=0;
 const {root}=fixture({reply:async()=>({ok:true,json:async()=>({allowExternalAddressLookup:true,addressLookupServerProxy:true})}),lookupReply:async(_url,options)=>{
  requests++;assert.equal(options.method,'POST');assert.equal(options.cache,'no-store');assert.equal(JSON.parse(options.body).query,'합성주소');
  return requests===1?{ok:true,json:async()=>({ok:true,data:{documents:[{x:'127',y:'37'}],status:'OK'}})}:{ok:false,json:async()=>({ok:false})};
 }});
 await root.KakaoMapsAdapter.ready();assert.equal(root.KAKAO_MAP_CONFIG.allowExternalAddressLookup,true);
 const geocoder=root.KakaoMapsAdapter.geocoder();assert.equal(geocoder.serverProxy,true);
 assert.equal((await new Promise(resolve=>geocoder.addressSearch('합성주소',(_rows,status)=>resolve(status)))),'OK');
 assert.equal((await new Promise(resolve=>geocoder.addressSearch('합성주소',(_rows,status)=>resolve(status)))),'ERROR');
 assert.equal(root.KAKAO_MAP_CONFIG.allowExternalAddressLookup,false);assert.equal(requests,2);
});

test('private configuration failure closes contacts while preserving an existing SDK',async()=>{
  for(const reply of [async()=>({ok:false}),async()=>{throw Error('SYNTHETIC_NETWORK_FAILURE');},async()=>({ok:true,json:async()=>{throw Error('SYNTHETIC_JSON_FAILURE');}})]){
    const {root,calls}=fixture({reply});const original=root.kakao;root.OPSMAP_DRIVER_CONTACT_ENABLED=true;
    assert.equal(await root.KakaoMapsAdapter.ready(),original);
    assert.equal(root.OPSMAP_DRIVER_CONTACT_ENABLED,false);privateReadOnce(calls);
    assert.equal(calls.scripts,0);assert.equal(calls.loads,1);
    assert.deepEqual(calls.events,[{type:'map-driver-capability',enabled:false}]);
  }
});

test('preconfigured JavaScript key does not skip capability; nonboolean capability remains OFF',async()=>{
  const {root,calls}=fixture({cached:false,presetKey:true,reply:async()=>({ok:true,json:async()=>({javascriptKey:'b'.repeat(32),driverContactEnabled:'true'})})});
  assert.equal(await root.KakaoMapsAdapter.ready(),root.kakao);
  assert.equal(root.OPSMAP_DRIVER_CONTACT_ENABLED,false);privateReadOnce(calls);
  assert.equal(calls.scripts,1);assert.equal(calls.loads,1);
  const url=new URL(calls.scriptUrls[0]);assert.equal(url.origin,'https://dapi.kakao.com');assert.equal(url.pathname,'/v2/maps/sdk.js');
  assert.equal(url.searchParams.get('appkey'),syntheticKey);assert.equal(url.searchParams.get('autoload'),'false');
});

test('concurrent ready calls share exactly one private configuration read and SDK initialization',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const {root,calls}=fixture({reply:async()=>{await gate;return {ok:true,json:async()=>({driverContactEnabled:true})};}});
  const a=root.KakaoMapsAdapter.ready(),b=root.KakaoMapsAdapter.ready(),c=root.KakaoMapsAdapter.ready();
  assert.equal(a,b);assert.equal(b,c);assert.equal(calls.config,1);release();
  const values=await Promise.all([a,b,c]);assert(values.every(value=>value===root.kakao));
  privateReadOnce(calls);assert.equal(calls.loads,1);assert.equal(calls.scripts,0);assert.equal(calls.events.length,1);
});
