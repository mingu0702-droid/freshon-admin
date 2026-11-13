import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const {chromium}=await import(process.env.OPSMAP_TEST_PLAYWRIGHT_MODULE||'playwright');

// Only the real popup implementation is loaded into a synthetic pixel-map.
// No app bootstrap, HTTP server, credentials, customer API or live SDK is used.
const root=path.resolve('public/opsmap');
const runtime=fs.readFileSync(path.join(root,'map-phase2b-runtime.js'),'utf8');
const popup=runtime.slice(runtime.indexOf('  function closeClusterPanel(){'),runtime.indexOf('  function markerElement('));
assert(popup.includes('function anchorClusterPanel('));
const clearMap=runtime.slice(runtime.indexOf('  function clearMap() {'),runtime.indexOf('  function clearSelection('));
const clearSelection=runtime.slice(runtime.indexOf('  function clearSelection('),runtime.indexOf('  function closeClusterPanel(){'));
const marker=runtime.slice(runtime.indexOf('  function markerElement('),runtime.indexOf('  function representativeRows('));
const markerUpdate=runtime.slice(runtime.indexOf('  function refreshMarkerSelection('),runtime.indexOf('  function renderStops('));
const css=fs.readFileSync(path.join(root,'map-performance.css'),'utf8');
const policy=fs.readFileSync(path.join(root,'map-view-policy.js'),'utf8');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'opsmap-r11-popup-'));
const fixture=`
const $=s=>document.querySelector(s),$$=s=>Array.from(document.querySelectorAll(s));
let clusterPanel=null,clusterPopupCleanup=null,periodBasis='vehicle',periodVehicleScope='all';
const baseVehicleStatus='READY';
let markerEntries=new Map(),indexedRows=null,pointIndex=null,boundaryKey='',mapMoving=false;
const selectedMapPins=new Set(),mapMarkerRows=new WeakMap();let activeMapPinKey='';
const state={mode:'BASE_60D',currentRows:[],selected:null,detailRequestId:0,fitRequested:true,suppressMapEventsUntil:0,overlays:[],representativeOverlays:[],lines:[],polygons:[]};
let cameraSelection=0,selectedDriverContact=null,temporaryDetailPoint=null,addressFocusRequest=null;const requestControllers=new Map();
const invalidateUnifiedSearch=()=>{},closeUnifiedSearchResults=()=>{},cancelAddressLookup=()=>{},renderRunList=()=>{},renderPeriodStoreList=()=>{};
const clearSearchSelectedOverlay=()=>{},clearActualRoute=()=>{},scheduleNewAreaDispatchBadges=()=>{},runVisitId=row=>row?.deliveryId||row?.customerCode;
let mapCamera={releaseFocus(){}};
const vehicleLabel=v=>v?v+'호차':'';
const vehicleColor=()=>'#275dd8',esc=v=>String(v).replace(/[&<>"']/g,'');
const syncPeriodBasis=()=>{},setSelectedVehicles=()=>{},refreshVehicleUi=()=>{};
function selectStore(row,element,focus){
 activeMapPinKey=element&&selectedMapPins.has(markerPinKey(row))?markerPinKey(row):'';
 state.selected=row;window.selection={code:row.customerCode,name:row.customerName,focus};
 if(focus)state.map.panTo(new Coord(row.lat,row.lng));
 if(window.simulateDetail){
  const close=document.createElement('button');close.textContent='상세 닫기';close.onclick=closeMapDetail;
  $('#detail').replaceChildren(close);$('#detailSection').classList.add('open');
 }
}
function selectVehicleStatus(){window.markerAction='vehicle';}function showNearbyReference(){window.markerAction='virtual';}
function focusMapPoint(row,{pinOffset}={}){window.lastPinFocus={key:markerPinKey(row),body:Boolean(pinOffset)};}
window.MapNavigationEditor={values:()=>['S00000']};
class Coord{constructor(lat,lng){this.lat=lat;this.lng=lng}getLat(){return this.lat}getLng(){return this.lng}}
class Point{constructor(x,y){this.x=x;this.y=y}}
class Bounds{constructor(){this.points=[]}extend(p){this.points.push(p)}}
window.overlays=[];
const events={addListener(t,n,f){(t.listeners[n]||=[]).push(f)},removeListener(t,n,f){t.listeners[n]=(t.listeners[n]||[]).filter(v=>v!==f)},preventMap(){window.prevented=(window.prevented||0)+1;}};
class FakeMap{
 constructor(){this.el=$('#map');this.center=new Coord(37.5,127);this.level=4;this.listeners={};this.boundsCalls=0;this.centerWrites=0;}
 getLevel(){return this.level}setLevel(n){this.level=n;this.emit('zoom_changed');}
 getProjection(){if(window.resizeRace?.pending)window.resizeRace.earlyProjections++;const r=this.el.getBoundingClientRect();return{containerPointFromCoords:p=>new Point(r.width/2+(p.lng-this.center.lng)*100,r.height/2-(p.lat-this.center.lat)*100),coordsFromContainerPoint:p=>new Coord(this.center.lat-(p.y-r.height/2)/100,this.center.lng+(p.x-r.width/2)/100)}}
 setCenter(p){if(window.resizeRace?.pending)window.resizeRace.earlyWrites++;this.centerWrites++;this.center=p;this.draw();this.emit('center_changed');}panTo(p){this.setCenter(p)}
 setBounds(){this.boundsCalls++;}emit(n){for(const f of [...this.listeners[n]||[]])f();}
 draw(){for(const o of window.overlays)if(o.map)o.draw();const p=this.getProjection().containerPointFromCoords(window.pinCoord||new Coord(37.5,127));$('#syntheticPin').style.left=p.x+'px';$('#syntheticPin').style.top=p.y+'px';}
}
class Overlay{
 constructor(o){this.opts=o;this.position=o.position;this.wrapper=document.createElement('div');this.wrapper.style.position='absolute';this.wrapper.style.zIndex=String(o.zIndex||0);this.wrapper.append(o.content);window.overlays.push(this);}
 // Match Kakao: setPosition does not remeasure initial anchor dimensions.
 setMap(m){this.map=m;this.wrapper.remove();if(m){m.el.append(this.wrapper);this.cachedSize={width:this.opts.content.offsetWidth,height:this.opts.content.offsetHeight};this.draw();}}
 setPosition(p){this.position=p;if(this.map)this.draw();}
 getContent(){return this.opts.content;}getZIndex(){return Number(this.wrapper.style.zIndex);}setZIndex(value){this.wrapper.style.zIndex=String(value);}
 draw(){const p=this.map.getProjection().containerPointFromCoords(this.position);this.wrapper.style.left=(p.x-this.cachedSize.width*this.opts.xAnchor)+'px';this.wrapper.style.top=(p.y-this.cachedSize.height*this.opts.yAnchor)+'px';}
}
window.kakao={maps:{CustomOverlay:Overlay,LatLng:Coord,LatLngBounds:Bounds,Point,event:events}};
state.map=new FakeMap();
${popup}
${clearMap}
${clearSelection}
${marker}
${markerUpdate}
window.harness={
 show(rows,extra={}){window.pinCoord=new Coord(rows[0].lat,rows[0].lng);showCluster({lat:rows[0].lat,lng:rows[0].lng,clusterRows:rows,clusterLabel:'같은 위치',clusterVehicles:['101'],...extra});state.map.draw();},
 close:closeClusterPanel,clearMap,clearSelection,
 seedColocated(rows){
  clearMap();state.mode='BASE_60D';state.currentRows=rows;state.selected=null;window.selection=null;window.simulateDetail=true;
  const [group]=MapViewPolicy.exactLocations(rows);
  window.pinCoord=new Coord(group.lat,group.lng);state.map.setCenter(new Coord(group.lat+.05,group.lng+1.35));
  const content=markerElement(group,null,'store');content.dataset.fixtureRole='exact-location';
  const overlay=new Overlay({position:window.pinCoord,content,xAnchor:.5,yAnchor:1,zIndex:3});
  overlay.setMap(state.map);state.overlays=[overlay];
 },
 seedOverlap(rows){
  clearMap();state.mode='BASE_60D';state.currentRows=Object.freeze(rows.map(r=>Object.freeze(r)));state.selected=state.currentRows[0];window.selection=null;window.simulateDetail=false;
  const first=state.currentRows[0],group={lat:first.lat,lng:first.lng,clusterCount:rows.length-1,clusterRows:state.currentRows.slice(1),clusterLabel:'같은 위치',clusterVehicles:['204']};
  window.pinCoord=new Coord(first.lat,first.lng);state.map.setCenter(window.pinCoord);
  const add=(row,z,role)=>{const content=markerElement(row,null,'store');content.dataset.fixtureRole=role;const o=new Overlay({position:window.pinCoord,content,xAnchor:.5,yAnchor:1,zIndex:z});o.setMap(state.map);return o;};
  state.overlays=[add(group,3,'underlying-cluster'),add(first,40,'selected-store')];state.map.draw();
 },
 seedAdjacentToLocation(rows){
  clearSelection();clearMap();state.mode='BASE_60D';state.currentRows=rows;window.simulateDetail=true;
  const pins=MapViewPolicy.exactLocations(rows);
  window.pinCoord=new Coord(rows[0].lat,rows[0].lng);state.map.setLevel(MapViewPolicy.storePinLevel);state.map.setCenter(window.pinCoord);
  state.overlays=pins.map(row=>{
   const content=markerElement(row,null,'store');content.dataset.fixtureRole=row.clusterKind==='location'?'location-group':'neighbor';
   const overlay=new Overlay({position:new Coord(row.lat,row.lng),content,xAnchor:.5,yAnchor:1,zIndex:markerLayer(row,false,false)});
   overlay.setMap(state.map);return overlay;
  });
 },
 seedDistinct(rows){
  clearSelection();clearMap();state.mode='BASE_60D';state.currentRows=rows;window.simulateDetail=true;
  window.pinCoord=new Coord(rows[0].lat,rows[0].lng);state.map.setCenter(window.pinCoord);
  state.overlays=rows.map((row,index)=>{const content=markerElement(row,null,'store');content.dataset.fixtureRole='distinct-'+index;
   const overlay=new Overlay({position:new Coord(row.lat,row.lng),content,xAnchor:.5,yAnchor:1,zIndex:5});overlay.setMap(state.map);return overlay;});
 },
 clickCase(rows,mode='BASE_60D',extra={}){clearSelection();clearMap();state.mode=mode;state.currentRows=rows;window.selection=null;window.markerAction=null;const row={...rows[0],...extra};const marker=markerElement(row,mode==='DATE_ROUTE'?1:null,row.virtual?'virtual':row.representative?'representative':row.nearbyVehicle?'nearbyVehicle':'store');marker.click();return{selected:window.selection,action:window.markerAction,navAssigned:marker.classList.contains('navAssigned')};},
 directSearch(row){closeClusterPanel();window.selection=null;selectStore(row,null,true);},
 beginResizeRace(){
  const map=state.map,savedCenter=map.center,oldSize={width:map.el.clientWidth,height:map.el.clientHeight};
  const race=window.resizeRace={pending:true,released:false,relayoutCalls:0,earlyProjections:0,earlyWrites:0,restored:false};
  // Model camera center restoration happening after SDK/DOM dimensions diverge.
  mapCamera={releaseFocus(){},dimensions:()=>race.pending?oldSize:{width:map.el.clientWidth,height:map.el.clientHeight},relayout(){
   race.relayoutCalls++;if(!race.pending||!race.released)return;
   race.pending=false;map.setCenter(savedCenter);race.restored=true;
  }};
 },
 releaseResizeRace(){window.resizeRace.released=true;},
 finishResizeRace(){mapCamera={releaseFocus(){}};window.resizeRace=null;},
 source:()=>JSON.stringify(state.currentRows),
 pan(x,y){const r=$('#map').getBoundingClientRect(),c=window.pinCoord;state.map.setCenter(new Coord(c.lat+(y-r.height/2)/100,c.lng-(x-r.width/2)/100));},
 stats(){return{active:window.overlays.filter(o=>o.map).length,listeners:Object.values(state.map.listeners).reduce((n,v)=>n+v.length,0),boundsCalls:state.map.boundsCalls,level:state.map.level,selected:window.selection,camera:{lat:state.map.center.lat,lng:state.map.center.lng,level:state.map.level,writes:state.map.centerWrites}};}
};state.map.draw();`;
const base=`*{box-sizing:border-box}body{margin:0;font:13px Arial}#approvedSiteHeader{position:fixed;left:0;top:0;width:100%;height:52px}#map{position:absolute;left:20px;top:60px;width:calc(100% - 40px);height:calc(100% - 80px);background:#e8eee7;overflow:hidden}#syntheticPin{position:absolute;transform:translate(-50%,-100%);width:44px;height:48px;background:#275dd8;border-radius:50% 50% 50% 0}button{cursor:pointer}#mobileWorkspace{display:none}@media(max-width:760px){#map{left:0;top:56px;width:100%;height:calc(100% - 56px)}#mobileWorkspace{display:block;position:fixed;left:0;right:0;bottom:0;height:160px;background:#fff}}`;
const rows=Array.from({length:85},(_,i)=>({customerCode:'S'+String(i).padStart(5,'0'),customerName:i<2?'동일한 매장명':'합성 매장 '+i,vehicle:i%2?'122':'101',address:'합성 주소 '+i,lat:37.5,lng:127}));
const checks=[],errors=[],requests=[];
const check=(name,value,details)=>{assert(value,details?name+' '+JSON.stringify(details):name);checks.push(name);};
const browser=await chromium.launch({headless:true,executablePath:process.env.OPSMAP_TEST_CHROMIUM||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
try{
 const page=await browser.newPage({viewport:{width:1180,height:800}});
 page.setDefaultTimeout(5000);
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',r=>{requests.push(r.request().url());return r.abort();});
 await page.setContent('<!doctype html><html><head><style>section{margin:0 20px}#detailSection{display:none}#detailSection.open{display:block;position:fixed;right:12px;top:64px;padding:8px;background:#fff;z-index:80}'+base+css+'</style></head><body class="approvedShellCandidate"><header id="approvedSiteHeader"></header><div id="map"><div id="syntheticPin"></div></div><div id="mobileWorkspace" class="collapsed"></div><div id="detailSection"><div id="detail"></div><div id="staffAuxContent"></div></div></body></html>');
 await page.addScriptTag({content:policy});await page.addScriptTag({content:fixture});
 const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
 const show=async(data=rows,extra={})=>{await page.evaluate(({data,extra})=>harness.show(data,extra),{data,extra});await settle();};
 const geometry=()=>page.evaluate(()=>{const p=document.querySelector('.mapClusterPopup').getBoundingClientRect(),m=document.querySelector('#map').getBoundingClientRect(),pin=document.querySelector('#syntheticPin').getBoundingClientRect();return{left:p.left,right:p.right,top:p.top,bottom:p.bottom,width:p.width,height:p.height,mapLeft:m.left,mapRight:m.right,mapTop:m.top,mapBottom:m.bottom,pinX:(pin.left+pin.right)/2,pinY:pin.bottom,below:document.querySelector('.mapClusterAnchor').classList.contains('clusterBelow')};});
 await show();
 check('same-coordinate group uses one CustomOverlay without changing zoom',(await page.evaluate(()=>harness.stats())).active===1&&(await page.evaluate(()=>harness.stats())).level===4);
 check('SDK caches a zero-size anchor while popup resets inherited section margins',await page.evaluate(()=>{
  const o=window.overlays.find(o=>o.map&&o.opts.content.classList.contains('mapClusterAnchor')),a=o.opts.content,p=a.querySelector('.mapClusterPopup'),style=getComputedStyle(p);
  return o.cachedSize.width===0&&o.cachedSize.height===0&&a.offsetWidth===0&&a.offsetHeight===0&&o.opts.xAnchor===0&&o.opts.yAnchor===0&&style.marginLeft==='0px'&&style.marginRight==='0px';
 }));
 check('initial batch contains 40 actual customer codes',await page.locator('[data-cluster-code]').count()===40);
 check('code, duplicate name and hocha remain visible',(await page.locator('[data-cluster-code="S00000"]').innerText()).includes('101호차')&&(await page.locator('[data-cluster-code="S00001"]').innerText()).includes('동일한 매장명'));
 let g=await geometry();check('popup starts above the selected pin inside the map',g.bottom<=g.pinY-51&&g.top>=g.mapTop+7&&g.left>=g.mapLeft+7&&g.right<=g.mapRight-7,g);
 await page.screenshot({path:path.join(out,'desktop.png')});
 await page.getByRole('button',{name:'더 보기 (40/85)',exact:true}).click();check('second batch expands to 80 codes',await page.locator('[data-cluster-code]').count()===80);
 await page.getByRole('button',{name:'더 보기 (80/85)',exact:true}).click();check('third batch reaches all 85 codes',await page.locator('[data-cluster-code]').count()===85);
 await page.getByRole('searchbox').fill('S00084');check('search reaches a code outside the first batch',await page.locator('[data-cluster-code]').count()===1&&await page.locator('[data-cluster-code="S00084"]').count()===1);
 await page.waitForTimeout(60);g=await geometry();check('search-result height changes retain the pin anchor',Math.abs(g.pinY-g.bottom-52)<2);
 await page.getByRole('searchbox').fill('동일한 매장명');check('equal shop names retain distinct customer-code entries',await page.locator('[data-cluster-code]').count()===2);
 const cameraBefore=await page.evaluate(()=>harness.stats().camera);
 await page.locator('[data-cluster-code="S00001"]').click();let s=await page.evaluate(()=>harness.stats());
 assert.deepEqual(s.camera,cameraBefore);
 check('selection opens the original code without moving the map',s.selected.code==='S00001'&&s.selected.focus===false&&s.active===0&&s.listeners===0);
 await show();g=await geometry();const before=g.left;
 await page.evaluate(()=>{const r=document.querySelector('#map').getBoundingClientRect();harness.pan(r.width/2-80,450)});await page.waitForTimeout(60);g=await geometry();
 check('map movement carries the overlay with its coordinate',Math.abs(g.left-(before-80))<2);
 await page.evaluate(()=>{const r=document.querySelector('#map').getBoundingClientRect();harness.pan(r.width-12,450)});await page.waitForTimeout(60);g=await geometry();check('right-edge clamp keeps the popup inside the map',g.right<=g.mapRight-7&&g.left>=g.mapLeft+7);
 await page.evaluate(()=>harness.pan(12,20));await page.waitForTimeout(60);g=await geometry();check('top-left edge retains the pin tether using below placement',g.below&&g.left>=g.mapLeft+7&&g.top>g.pinY);
 await page.evaluate(()=>harness.pan(-60,300));await settle();check('off-map pin hides its popup',await page.locator('.mapClusterAnchor').evaluate(e=>getComputedStyle(e).visibility==='hidden'));
 await page.evaluate(()=>harness.pan(570,360));
 await show();await page.mouse.click(5,5);await page.keyboard.press('Escape');s=await page.evaluate(()=>harness.stats());check('global Escape closes unfocused popup and removes SDK listeners',s.active===0&&s.listeners===0);
 await show();await show(rows.slice(0,2).map(r=>({...r,lat:37.6,lng:127.1})));s=await page.evaluate(()=>harness.stats());check('another group replaces the previous overlay',s.active===1&&s.listeners===4);
 await page.getByRole('button',{name:'묶음 목록 닫기'}).click();s=await page.evaluate(()=>harness.stats());check('close button removes popup and listeners',s.active===0&&s.listeners===0);
 for(const type of ['map-navigation-context-changed','map-navigation-logout','pagehide']){
  await show();await page.evaluate(type=>window.dispatchEvent(new Event(type)),type);s=await page.evaluate(()=>harness.stats());check(type+' disposes overlay and listeners',s.active===0&&s.listeners===0);
 }
 await show();await page.evaluate(()=>harness.clearMap());s=await page.evaluate(()=>harness.stats());check('map reset disposes popup',s.active===0&&s.listeners===0);
 const regional=[{...rows[0],lat:37.4,lng:126.9},rows[1],rows[2],{...rows[3],lat:37.8,lng:127.3}];
 await show(regional,{clusterLabel:'수도권',clusterBounds:{south:37.4,north:37.8,west:126.9,east:127.3}});s=await page.evaluate(()=>harness.stats());
 check('regional cluster preserves bounds expansion and prioritizes location groups',s.boundsCalls===1&&s.active===0&&await page.locator('.clusterLocationGroups button').count()===1);
 await page.locator('.clusterLocationGroups button').click();await page.waitForTimeout(100);check('regional location subgroup opens original co-located members',await page.locator('.mapClusterPopup [data-cluster-code]').count()===2&&(await page.evaluate(()=>harness.stats())).active===1);
 await page.setViewportSize({width:390,height:780});await page.waitForTimeout(120);await show();g=await geometry();
 const sheetTop=await page.locator('#mobileWorkspace').evaluate(e=>e.getBoundingClientRect().top);
 check('mobile popup avoids the bottom workspace and leaves most map visible',g.left>=7&&g.right<=383&&g.top>=63&&g.bottom<=sheetTop-7&&g.height<=(sheetTop-g.mapTop)*.48+1);
 await page.screenshot({path:path.join(out,'mobile.png')});
 await page.getByRole('searchbox').fill('S00084');await page.locator('[data-cluster-code="S00084"]').click();check('mobile lazy-result selection preserves the original customer code',(await page.evaluate(()=>harness.stats())).selected.code==='S00084');
 await page.evaluate(data=>harness.seedColocated(data),rows.slice(0,2));
 const mobileCamera=await page.evaluate(()=>harness.stats().camera);
 const locationPin=page.locator('[data-fixture-role="exact-location"]');
 await locationPin.click();await page.locator('[data-cluster-code="S00000"]').click();
 assert.equal((await page.evaluate(()=>harness.stats())).selected.code,'S00000');
 await page.getByRole('button',{name:'상세 닫기'}).click();
 await locationPin.click();await page.locator('[data-cluster-code="S00001"]').click();
 s=await page.evaluate(()=>harness.stats());
 assert.deepEqual(s.camera,mobileCamera);
 check('mobile reopens the same pin after closing the first detail and selects the second code',s.selected.code==='S00001'&&s.selected.focus===false&&s.active===1&&s.listeners===0);
 const shortMap=await page.addStyleTag({content:'#map{top:192px;height:460px}#mobileWorkspace{display:none}'});
 await page.evaluate(data=>harness.seedColocated(data),rows.slice(0,2).map(row=>({...row,address:'긴 합성 주소 '.repeat(6)})));
 await locationPin.click();
 await page.locator('[data-cluster-code="S00001"]').click();
 check('a short mobile map keeps long co-located rows reachable',(await page.evaluate(()=>harness.stats())).selected.code==='S00001');
 await shortMap.evaluate(el=>el.remove());
 await page.getByRole('button',{name:'상세 닫기'}).click();
 await page.setViewportSize({width:1180,height:800});
 const colocated=rows.slice(0,6).map(r=>({...r,vehicle:'204'}));
 await page.evaluate(data=>{harness.seedOverlap(data);harness.clearSelection();},colocated);await page.waitForTimeout(60);
 const hit=await page.locator('[data-fixture-role="selected-store"]').evaluate(e=>{const r=e.getBoundingClientRect(),top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return{role:top.closest('[data-fixture-role]')?.dataset.fixtureRole,z:e.parentElement.style.zIndex,selected:e.classList.contains('selected')};});
 check('clearing the selection restores navigation layering above the group',hit.role==='selected-store'&&hit.z==='25'&&!hit.selected);
 const originalSource=await page.evaluate(()=>harness.source());
 await page.locator('[data-fixture-role="selected-store"]').click();await page.waitForTimeout(100);
 check('normal click on the overlapping real pin opens all six customer codes',await page.locator('.mapClusterPopup [data-cluster-code]').count()===6);
 check('overlapping popup includes the previously selected code',await page.locator('.mapClusterPopup [data-cluster-code="S00000"]').count()===1);
 g=await geometry();check('six-code popup remains above pin and within viewport with cached SDK offsets',g.top>=g.mapTop+7&&g.bottom<=g.mapBottom-7&&Math.abs(g.pinY-g.bottom-52)<2);
 await page.screenshot({path:path.join(out,'selected-pin-overlap.png')});
 await page.locator('[data-cluster-code="S00005"]').click();check('a formerly hidden code reaches existing detail selection',(await page.evaluate(()=>harness.stats())).selected.code==='S00005');
 check('pin click does not mutate rows or coordinates',await page.evaluate(()=>harness.source())===originalSource);
 const clickPinCenter=async role=>{
  const {x,y,width,height}=await page.locator('[data-fixture-role="'+role+'"] .pin').boundingBox();
  await page.mouse.click(x+width/2,y+height/2);
 };
 await page.evaluate(data=>harness.seedAdjacentToLocation(data),[rows[0],rows[1],{...rows[2],lng:127.2}]);
 await clickPinCenter('location-group');
 check('an adjacent pin does not intercept the co-located group centre',await page.locator('.mapClusterPopup [data-cluster-code]').count()===2);
 await page.getByRole('button',{name:'묶음 목록 닫기'}).click();
 await clickPinCenter('neighbor');
 check('the adjacent store centre remains selectable under the group wrapper',(await page.evaluate(()=>harness.stats())).selected?.code==='S00002');
 await clickPinCenter('location-group');
 check('the co-located group centre remains reachable beside a selected store',await page.locator('.mapClusterPopup [data-cluster-code]').count()===2);
 await page.evaluate(row=>harness.directSearch(row),colocated[0]);check('direct customer search still selects detail without a group popup',(await page.evaluate(()=>harness.stats())).selected.code==='S00000'&&await page.locator('.mapClusterPopup').count()===0);
 await page.evaluate(data=>harness.clickCase([...data,data[0],{...data[1],virtual:true},{...data[2],representative:true},{...data[3],nearbyVehicle:true}]),colocated);await page.waitForTimeout(60);
 check('same-location marker grouping keeps distinct codes and ignores synthetic markers',await page.locator('.mapClusterPopup [data-cluster-code]').count()===6);
 let action=await page.evaluate(row=>harness.clickCase([row,{...row}], 'BASE_60D'),colocated[0]);check('duplicate copies of one customer code select its detail',action.selected?.code==='S00000'&&await page.locator('.mapClusterPopup').count()===0);
 action=await page.evaluate(data=>harness.clickCase(data,'DATE_ROUTE'),[colocated[0],{...colocated[0],order:2},colocated[1]]);check('dated visits keep their existing detail path and nav protection',action.selected?.code==='S00000'&&action.navAssigned&&await page.locator('.mapClusterPopup').count()===0);
 for(const [extra,expected]of [[{representative:true},'vehicle'],[{nearbyVehicle:true},'vehicle'],[{virtual:true},'virtual']]){action=await page.evaluate(({data,extra})=>harness.clickCase(data,'BASE_60D',extra),{data:colocated,extra});check(Object.keys(extra)[0]+' marker keeps its existing action',action.action===expected&&await page.locator('.mapClusterPopup').count()===0);}
 action=await page.evaluate(data=>harness.clickCase(data.map(r=>({...r,lat:91})),'BASE_60D'),colocated);check('invalid coordinates do not create a group popup',action.selected?.code==='S00000'&&await page.locator('.mapClusterPopup').count()===0);
 await page.evaluate(data=>harness.seedDistinct(data),[rows[0],{...rows[1],lng:128.15}]);
 const one=page.locator('[data-fixture-role="distinct-0"]'),two=page.locator('[data-fixture-role="distinct-1"]');
 await one.click();await two.click();
 check('two physical pins stay selected and the last click requests body centering',await one.getAttribute('aria-pressed')==='true'&&await two.getAttribute('aria-pressed')==='true'&&await page.evaluate(()=>lastPinFocus.key==='store:S00001'&&lastPinFocus.body));
 await two.click();
 check('a repeat click restores only that pin',await one.getAttribute('aria-pressed')==='true'&&await two.getAttribute('aria-pressed')==='false');
 await two.click();await page.getByRole('button',{name:'상세 닫기'}).click();
 check('detail close preserves the other selected pin',await one.getAttribute('aria-pressed')==='true'&&await two.getAttribute('aria-pressed')==='false');
 await page.evaluate(()=>harness.clearSelection());
 check('clearing map selection restores every original pin color',await one.getAttribute('aria-pressed')==='false'&&await two.getAttribute('aria-pressed')==='false');
 await show(colocated);await page.evaluate(()=>harness.beginResizeRace());
 await page.setViewportSize({width:390,height:780});await settle();
 const race=await page.evaluate(()=>window.resizeRace);
 check('popup waits without projection or camera writes while resized camera dimensions are unsettled',race.relayoutCalls>0&&race.pending&&race.earlyProjections===0&&race.earlyWrites===0);
 await page.evaluate(()=>harness.releaseResizeRace());await settle();g=await geometry();
 const restored=await page.evaluate(()=>window.resizeRace);
 check('popup readjusts after saved camera center restoration without clipping',restored.restored&&!restored.pending&&g.top>=g.mapTop+7&&g.left>=g.mapLeft+7&&g.right<=g.mapRight-7&&Math.abs(g.pinY-g.bottom-52)<2);
 await page.evaluate(()=>harness.finishResizeRace());
 await page.evaluate(()=>harness.clearMap());
 check('no runtime errors',errors.length===0);check('no HTTP, external SDK or API requests',requests.length===0);
 console.log(JSON.stringify({result:'PASS',scope:'synthetic browser + pixel-map only; real Kakao map not tested',checks:checks.length,details:checks,artifacts:out},null,2));
}finally{await browser.close();}
