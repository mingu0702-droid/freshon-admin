import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync(new URL('../../public/kakao-maps-adapter.js',import.meta.url),'utf8');
function fixture(ok){
 let created='',fetches=0;const window={};
 const doc={getElementById:()=>({dataset:{sdkSrc:'https://dapi.kakao.com/v2/maps/sdk.js?autoload=false'}}),createElement:()=>({}),head:{append(script){created=script.src;window.kakao={maps:{load:fn=>fn()}};script.onload();}}};
 const context={window,document:doc,location:{origin:'https://example.invalid'},URL,setTimeout,clearTimeout,fetch:async()=>{fetches++;return {ok,json:async()=>({javascriptKey:'a'.repeat(32)})};}};
 vm.runInNewContext(code,context);return {window,fetches:()=>fetches,created:()=>created};
}
test('SDK configuration is loaded from authenticated endpoint before SDK initialization',async()=>{const f=fixture(true);await f.window.KakaoMapsAdapter.ready();assert.equal(f.fetches(),1);assert.match(f.created(),/dapi\.kakao\.com\/v2\/maps\/sdk\.js/);});
test('missing SDK configuration fails closed without loading SDK',async()=>{const f=fixture(false);await assert.rejects(f.window.KakaoMapsAdapter.ready(),/MAP_JAVASCRIPT_KEY_UNCONFIGURED/);assert.equal(f.created(),'');});
