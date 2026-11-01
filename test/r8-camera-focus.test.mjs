import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const context=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../public/opsmap/map-view-policy.js',import.meta.url),'utf8'),context);const {createCamera,cameraFocusViewport}=context.MapViewPolicy;
const rect=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height,width,height});
for(const width of [1920,1366])test(`desktop ${width}: anchor belongs to browser viewport below header, not canvas center`,()=>{
 const target=cameraFocusViewport({mapRect:rect(309,72,width-309,792),viewportRect:rect(0,0,width,864),headerRect:rect(0,0,width,72),occluders:[rect(width-360,156,340,650)]});
 assert.equal(target.x,width/2);assert.equal(target.y,468);assert.equal(target.basis,'VIEWPORT_BELOW_HEADER');
});
for(const width of [760,390])test(`mobile ${width}: open bottom panel is excluded from visible map`,()=>{
 const target=cameraFocusViewport({mapRect:rect(0,144,width,700),viewportRect:rect(0,0,width,844),headerRect:rect(0,0,width,144),occluders:[rect(0,544,width,300)],mobile:true});
 assert.equal(target.x,width/2);assert.equal(target.y,344);assert.equal(target.basis,'UNOBSCURED_MAP');
});
function cameraFixture(width=1920,height=864){
 let clock=1000,seq=0,center={lat:36,lng:127},layout={mapRect:rect(309,72,width-309,height-72),viewportRect:rect(0,0,width,height),headerRect:rect(0,0,width,72),occluders:[],mobile:width<=760};
 const frames=new Map(),element={clientWidth:layout.mapRect.width,clientHeight:layout.mapRect.height,dataset:{}},counts={moves:0,relayout:0};
 const projection={containerPointFromCoords:p=>({x:element.clientWidth/2+(p.lng-center.lng)*100,y:element.clientHeight/2-(p.lat-center.lat)*100}),coordsFromContainerPoint:p=>({lng:center.lng+(p.x-element.clientWidth/2)/100,lat:center.lat-(p.y-element.clientHeight/2)/100})};
 const map={getCenter:()=>center,setCenter:p=>{center=p;counts.moves++;},getProjection:()=>projection,relayout:()=>counts.relayout++};
 const camera=createCamera({map,element,layout:()=>layout,clock:()=>clock,raf:fn=>{frames.set(++seq,fn);return seq;},cancelRaf:id=>frames.delete(id)});
 const flush=()=>{for(let n=0;frames.size&&n<20;n++){const items=[...frames];frames.clear();for(const [,fn]of items)fn();}assert.equal(frames.size,0,'corrections must be bounded');};
 return {camera,element,counts,flush,setLayout:next=>{layout=next;element.clientWidth=next.mapRect.width;element.clientHeight=next.mapRect.height;},advance:ms=>clock+=ms};
}
for(const width of [1920,1366,760,390])test(`projection correction ${width}: synthetic coordinate reaches expected anchor within 30 CSS px`,()=>{
 const f=cameraFixture(width);assert.equal(f.camera.focus({lat:37.5,lng:127.1},{key:'SYNTHETIC_ONLY'}),true);f.flush();assert.equal(f.camera.focusState().state,'centered');assert(f.camera.focusState().errorPx<=30);assert.equal(f.counts.relayout,1);assert(f.counts.moves<=3);
});
test('resize and panel changes recenter only while the selection still owns the camera',()=>{
 const f=cameraFixture();f.camera.focus({lat:37.5,lng:127.1});f.flush();
 f.setLayout({mapRect:rect(0,144,390,700),viewportRect:rect(0,0,390,844),headerRect:rect(0,0,390,144),occluders:[rect(0,544,390,300)],mobile:true});f.camera.scheduleRelayout();f.flush();assert.equal(f.camera.focusState().expectedX,195);assert.equal(f.camera.focusState().expectedY,344);assert(f.camera.focusState().errorPx<=30);
 const moves=f.counts.moves;f.camera.userGesture();f.advance(301);f.setLayout({mapRect:rect(0,100,760,400),viewportRect:rect(0,0,760,500),headerRect:rect(0,0,760,100),occluders:[],mobile:true});f.camera.scheduleRelayout();f.flush();assert.equal(f.counts.moves,moves+1,'relayout preserves user center, not old selection');
});
test('new selection cancels pending old focus; invalid coordinates never move the map',()=>{
 const f=cameraFixture();f.camera.focus({lat:37,lng:127});f.camera.focus({lat:35,lng:129},{key:'LATEST_SYNTHETIC'});f.flush();assert(f.camera.focusState().errorPx<=30);const moves=f.counts.moves;assert.equal(f.camera.focus({lat:null,lng:null}),false);assert.equal(f.camera.focus({lat:NaN,lng:127}),false);f.flush();assert.equal(f.counts.moves,moves);
});
test('CSS scaling and visual viewport offsets use actual DOM rectangles rather than fixed sidebar offsets',()=>{
 const f=cameraFixture();f.setLayout({mapRect:rect(200,100,1720,800),viewportRect:rect(0,20,1920,880),headerRect:rect(0,20,1920,80),occluders:[rect(1500,180,380,700)],mobile:false});f.element.clientWidth=860;f.element.clientHeight=400;f.camera.focus({lat:37.2,lng:127.2});f.flush();assert.equal(f.camera.focusState().expectedX,960);assert.equal(f.camera.focusState().expectedY,500);assert(f.camera.focusState().errorPx<=30);
});

test('mobile measured pin height keeps its body below the header and away from map controls',()=>{
 const target=cameraFocusViewport({mapRect:rect(0,151,375,443),viewportRect:rect(0,0,390,855),headerRect:rect(0,0,375,151),occluders:[rect(16,210,332,372),rect(160,162,68,36),rect(228,162,120,36)],mobile:true,anchorHeight:48,anchorWidth:44});
 assert(target.x<160);assert(target.y-48>=151);assert(target.y<210);
});
