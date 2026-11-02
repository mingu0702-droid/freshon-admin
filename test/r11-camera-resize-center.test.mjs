import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
function fixture(){
 const listeners=new Set(),element={clientWidth:1920,clientHeight:864,dataset:{}};let sdkWidth=1920,sdkHeight=864,center={lat:36.3,lng:127.5};
 const emit=()=>{for(const listener of listeners)listener();};
 const map={getCenter:()=>({lat:center.lat+(element.clientHeight-sdkHeight)/200,lng:center.lng+(element.clientWidth-sdkWidth)/200}),setCenter:value=>{center={...value};emit();},relayout:()=>{center=map.getCenter();sdkWidth=element.clientWidth;sdkHeight=element.clientHeight;emit();}};
 const event={addListener:(target,name,fn)=>{assert.equal(target,map);assert.equal(name,'center_changed');listeners.add(fn);},removeListener:(target,name,fn)=>listeners.delete(fn)};
 const context=vm.createContext({kakao:{maps:{event}}});vm.runInContext(fs.readFileSync(new URL('../public/opsmap/map-view-policy.js',import.meta.url),'utf8'),context);
 const camera=context.MapViewPolicy.createCamera({map,element,layout:()=>({}),raf:()=>1,cancelRaf:()=>{}});
 return {camera,map,listeners,resize:(width,height)=>{element.clientWidth=width;element.clientHeight=height;emit();}};
}
test('DOM resize already drifts SDK getCenter; relayout restores the last valid geographic center repeatedly',()=>{
 const f=fixture(),before=f.map.getCenter();f.camera.relayout();
 for(const [width,height]of [[1366,768],[760,844],[390,844],[1920,864],[390,700]]){f.resize(width,height);assert.notDeepEqual(f.map.getCenter(),before);f.camera.relayout();assert.deepEqual(f.map.getCenter(),before);}
});
test('normal-layout pan/zoom center changes become the next resize center and dispose removes its listener',()=>{
 const f=fixture();f.camera.relayout();const userCenter={lat:35.9,lng:129.1};f.map.setCenter(userCenter);f.resize(390,844);f.camera.relayout();assert.deepEqual(f.map.getCenter(),userCenter);assert.equal(f.listeners.size,1);f.camera.dispose();assert.equal(f.listeners.size,0);
});
