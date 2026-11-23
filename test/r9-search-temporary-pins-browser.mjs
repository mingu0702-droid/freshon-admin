import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
const {chromium}=await import(process.env.OPSMAP_TEST_PLAYWRIGHT_MODULE||'playwright');

// Isolated synthetic browser/SDK fixture. No credentials, source reads, geocoding or writes.
const root=path.resolve('public/opsmap'),out=fs.mkdtempSync(path.join(os.tmpdir(),'opsmap-r9-temp-pins-'));
const rows=[{customerCode:'S990001',customerName:'SYNTHETIC_ONE',address:'서울특별시 합성구 기존로 1',vehicle:'101',lat:37.55,lng:127,coordinateSource:'MANUAL_PIN',lastDeliveryDate:'2026-11-02'},
 {customerCode:'S990002',customerName:'SYNTHETIC_TWO',address:'서울특별시 합성구 기존로 2',vehicle:'122',lat:37.551,lng:127.001,lastDeliveryDate:'2026-11-02'}];
const version='e'.repeat(64),checkedAt='2026-11-02T00:00:00Z',requests=[],external=[],errors=[],checks=[],routeRequests=[];
const navigationContext=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(root,'navigation-ui.js'),'utf8'),navigationContext);
const places=navigationContext.MapNavigationLookup.createTemporaryPlaces();
const assigned=places.add({lat:37.5,lng:127,address:'SYNTHETIC_ASSIGNED',searchTemporary:true});
places.add({lat:37.6,lng:127,address:'SYNTHETIC_PREVIEW',searchTemporary:true});
const manual=places.add({lat:37.7,lng:127,address:'SYNTHETIC_MANUAL'});
places.retainSearchPoints([assigned.customerCode]);
assert.equal(places.values().length,2);assert(places.values().some(r=>r.customerCode===assigned.customerCode));assert(places.values().some(r=>r.customerCode===manual.customerCode));checks.push('navigation retains assigned search points and manual points but removes unassigned previews');
places.retainSearchPoints([]);assert.equal(places.values().length,1);checks.push('navigation clear removes only unassigned search temporary points');
const fixture=`window.VEHICLE_AREA_DATA={vehicles:[]};window.KAKAO_MAP_CONFIG={allowExternalAddressLookup:false};
document.body.dataset.mapStaffState='authenticated';window.MapStaffEntry={status(){},registerPurge(){}};window.MapTerritoryUi={renderForSelection(){}};
window.pendingLookups=[];window.lookupCalls=0;window.kakaoGeocoder={addressSearch(q,cb){window.lookupCalls++;window.pendingLookups.push({q,cb})}};
window.allOverlays=[];window.allCircles=[];
class Coord{constructor(lat,lng){this.lat=lat;this.lng=lng}getLat(){return this.lat}getLng(){return this.lng}}
class Bounds{extend(){}getSouthWest(){return new Coord(33,124)}getNorthEast(){return new Coord(39.5,132)}}
class FixtureMap{
 constructor(el,o){this.el=el;this.center=o.center;this.level=5;this.listeners={}}
 getCenter(){return this.center}
 setCenter(p){this.center=p;this.relayout()}
 panTo(p){this.setCenter(p)}
 getLevel(){return this.level}
 setLevel(v){this.level=v;this.relayout()}
 getBounds(){return new Bounds()}
 setBounds(){}
 relayout(){for(const o of window.allOverlays)if(o.map===this)o.positionPin()}
 getProjection(){
  const x=this.el.clientWidth/2,y=this.el.clientHeight/2;
  return {containerPointFromCoords:p=>({x:x+(p.lng-this.center.lng)*1000,y:y+(this.center.lat-p.lat)*1000}),
    coordsFromContainerPoint:p=>new Coord(this.center.lat-(p.y-y)/1000,this.center.lng+(p.x-x)/1000)};
 }
}
class Overlay{
 constructor(o){this.opts=o;window.allOverlays.push(this)}
 setPosition(position){this.opts.position=position;this.positionPin()}
 setMap(m){
  this.map=m;this.opts.content?.remove();this.anchor?.remove();
  if(!m||!this.opts.content)return;
  if(this.opts.content.matches('.searchTemporaryMarker')){
   this.anchor=document.createElement('div');
   Object.assign(this.anchor.style,{position:'absolute',transform:'translate(-50%, -100%)',zIndex:this.opts.zIndex});
   this.anchor.append(this.opts.content);m.el.append(this.anchor);this.positionPin();
  }else m.el.append(this.opts.content);
 }
 positionPin(){
  if(!this.anchor||!this.map)return;
  const pixel=this.map.getProjection().containerPointFromCoords(this.opts.position);
  this.anchor.style.left=pixel.x+'px';this.anchor.style.top=pixel.y+'px';
 }
}
class Circle{constructor(o){this.opts=o;window.allCircles.push(this)}setMap(m){this.map=m}}
window.kakao={maps:{LatLng:Coord,LatLngBounds:Bounds,Point:class{constructor(x,y){this.x=x;this.y=y}},Map:FixtureMap,CustomOverlay:Overlay,Polygon:Overlay,Polyline:Overlay,Circle,event:{addListener(t,n,f){(t.listeners[n]||=[]).push(f)},removeListener(t,n,f){t.listeners[n]=t.listeners[n].filter(x=>x!==f)},trigger(t,n,e){for(const f of t.listeners[n]||[])f(e)}}}};
window.KakaoMapsAdapter={ready:()=>Promise.resolve(),reset(){}};`;
const runtime=fs.readFileSync(path.join(root,'map-phase2b-runtime.js'),'utf8').replace('\n  initVehicles();',`
  function selectUnifiedSearchStore(row){window.selectedSyntheticCustomer=row.customerCode;}
  window.tempPinTest={begin(text,options={}){++state.searchRequestId;return searchExternalAddress(text,{owner:state.searchRequestId,...options});},
   click(lat,lng){kakao.maps.event.trigger(state.map,'click',{latLng:new kakao.maps.LatLng(lat,lng)});},clear:clearTemporaryPins,
   finish:(p,owner=state.searchRequestId)=>finishAddress(p,{owner}),geocode:geocodeAddress,
   move(lat=37.53,lng=127.03){const {map}=state;map.setLevel(6);map.setCenter(new kakao.maps.LatLng(lat,lng));for(const name of ['zoom_changed','dragstart','center_changed','dragend','idle'])kakao.maps.event.trigger(map,name);},
   zoom(level){const {map}=state;map.setLevel(level);for(const name of ['zoom_changed','idle'])kakao.maps.event.trigger(map,name);},
   setFilters(center,scope){state.centerFilter=center;periodVehicleScope=scope;periodSelectionCache=null;},
   releaseFocus:()=>mapCamera.releaseFocus(),positionButtons:positionTemporaryRemoveButtons,
   stats:()=>({count:document.querySelectorAll('[data-search-temporary-pin]').length,tracked:temporaryPins.size,pending:!!searchTemporaryClick,
    activeCircles:window.allCircles.filter(x=>x.map).length,stores:state.currentRows.length,markerCount:markerEntries.size,
    viewport:JSON.parse(document.querySelector('#map').dataset.areaViewport||'null'),centerFilter:state.centerFilter,vehicleScope:periodVehicleScope,
    storePoints:state.currentRows.map(r=>[r.customerCode,r.lat,r.lng,r.coordinateSource]),
    virtual:state.virtual?{address:state.virtual.address,lat:state.virtual.lat,lng:state.virtual.lng,customerMatchState:state.virtual.customerMatchState}:null,
    lookupCalls:window.lookupCalls,owner:state.searchRequestId,addressOwner:state.addressRequestId})};
  initVehicles();`);
const scripts=['phase2b-ui-helpers.js','map-period-ui.js','map-view-policy.js','road-route-ui.js','new-area-requests.js','new-area-detail-panel.js','new-area-viewport.js','manual-waypoints.js','kakao-directions-adapter.js','manual-road-route-ui.js','map-dot-ui.js','opsmap-daily.js'];
let html=fs.readFileSync(path.join(root,'map-phase2b-preview.html'),'utf8').replace(/<script\b[\s\S]*?<\/script>/gi,'');
html=html.replace('</body>','<script>'+fixture+'</script>'+scripts.map(f=>'<script src="'+f+'"></script>').join('')+'<script src="temp-runtime.js"></script><script src="map-approved-shell-candidate.js"></script><script src="navigation-ui.js"></script></body>');
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname.startsWith('/api/')){
  requests.push({path:u.pathname,method:req.method});let data={data:[],meta:{}};
  if(u.pathname.endsWith('/snapshot'))data={data:rows,meta:{complete:true,latestDate:'2026-11-02',startDate:'2026-09-04',endDate:'2026-11-02'}};
  if(u.pathname.endsWith('/base-vehicles'))data={ok:true,data:rows.map(r=>({customerCode:r.customerCode,baseVehicle:r.vehicle,baseVehicleState:'VERIFIED_MASTER',baseVehicleGroup:'osan',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:version,baseVehicleStale:false,baseVehicleCheckedAt:checkedAt})),meta:{basis:'FIXED_DISPATCH_PRIMARY',version,checkedAt,stale:false,refresh:'IDLE'}};
  if(u.pathname.endsWith('/manual-road-route')){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const body=JSON.parse(Buffer.concat(chunks));routeRequests.push(body);
   const points=[body.origin,...body.waypoints,body.destination],totalLegs=points.length-1;
   const geometry=points.slice(0,-1).map((p,legOffset)=>({legOffset,latLngs:[[p.lat,p.lng],[points[legOffset+1].lat,points[legOffset+1].lng]]}));
   data={ok:true,data:{mode:body.mode,requestId:body.requestId,state:'success',source:'kakao-directions',isGpsActual:false,complete:true,
    totalLegs,coveredLegs:totalLegs,stationaryLegs:[],distanceMeters:2400,durationSeconds:360,
    chunks:[{state:'success',startLeg:0,endLeg:totalLegs-1,geometry}]}};
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify(data));return;
 }
 if(u.pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
 if(path.basename(u.pathname)==='temp-runtime.js'){res.setHeader('content-type','application/javascript');res.end(runtime);return;}
 const f=path.join(root,path.basename(u.pathname));if(fs.existsSync(f)&&fs.statSync(f).isFile()){res.setHeader('content-type',f.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(f));}else{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
let browser,page;
async function openPage(options){
 const next=await browser.newPage(options);next.setDefaultTimeout(8000);next.on('pageerror',e=>errors.push(e.message));
 await next.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(new URL(route.request().url()).hostname);return route.abort();}return route.continue();});
 await next.goto(origin);await next.waitForFunction(()=>window.MapUiLocalBridge?.isDataReady()&&MapUiLocalBridge.state.map&&
  MapUiLocalBridge.state.currentRows.length===2&&MapUiLocalBridge.fixedTerritoryMasterState()&&window.MapNavigation);
 return next;
}
async function submit(query){
 await page.locator('#query').fill(query);
 await page.locator('#searchBtn').click();
 await page.waitForFunction(()=>tempPinTest.stats().pending);
}
async function removeFromMap({touch=false}={}){
 const pin=page.locator('[data-search-temporary-pin]');
 const remove=page.getByRole('button',{name:'지도에서 임시 핀 삭제'});
 const marker=await pin.boundingBox(),button=await remove.boundingBox();
 assert(marker&&button&&button.width>=32);
 const handle=await remove.elementHandle();
 if(touch)await remove.tap();else await remove.click();
 assert(await handle.evaluate(node=>!node.isConnected&&node.onclick===null));
 await handle.dispose();
}
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.OPSMAP_TEST_CHROMIUM||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 page=await openPage({viewport:{width:1366,height:900}});
 const initial=await page.evaluate(()=>tempPinTest.stats()),check=(n,v)=>{assert(v,n);checks.push(n);};
 await page.evaluate(()=>tempPinTest.begin('서울 종로구 합성로 14'));
 let s=await page.evaluate(()=>tempPinTest.stats());check('unapproved address arms map click without a provider call',s.pending&&s.lookupCalls===0&&s.count===0);
 await page.evaluate(()=>tempPinTest.click(37.55,127));s=await page.evaluate(()=>tempPinTest.stats());check('map click creates exactly one temporary pin without a radius circle',s.count===1&&s.activeCircles===0&&!s.pending);
 check('temporary point stays out of customer rows and marker index',s.stores===initial.stores&&s.markerCount===initial.markerCount&&s.virtual.customerMatchState==='UNCONFIRMED');
 await page.locator('#nearWrap [data-area-nearest]').waitFor();
 check('a hand-picked location offers closest store and direct distance without a radius list',await page.locator('#nearWrap').innerText().then(x=>x.includes('직선거리')&&!x.includes('30km')));
 check('all fixture stores appear independently of reference overlays',s.viewport?.visible===2&&s.viewport?.located===2&&await page.locator('[data-area-dispatch-pin]').count()===0);
 await page.evaluate(()=>tempPinTest.zoom(6));
 await page.waitForFunction(()=>tempPinTest.stats().viewport?.mode==='dots');
 check('zoom-out preserves the two stores at the dots threshold',(await page.evaluate(()=>tempPinTest.stats())).viewport.visible===2);
 await page.evaluate(()=>tempPinTest.click(37.55,127));
 const choices=page.locator('#mapStoreChoice');
 check('nearby dots offer a choice for both customer codes',await choices.locator('option[data-cluster-code]').count()===2);
 await choices.focus();await page.keyboard.press('End');await choices.dispatchEvent('change');
 check('choosing an overlapping dot exposes the selected customer',await page.evaluate(()=>MapUiLocalBridge.state.selected?.customerCode==='S990002'));
 await page.locator('[data-search-temporary-pin]').evaluate(button=>button.click());
 await page.evaluate(()=>tempPinTest.zoom(5));
 await page.waitForFunction(()=>tempPinTest.stats().viewport?.mode==='pins');
 check('zoom-in restores full pins and retains both stores',(await page.evaluate(()=>tempPinTest.stats())).viewport.visible===2);
 await page.locator('#nearWrap [data-area-nearby-code]').last().focus();await page.keyboard.press('Enter');
 check('selecting a store with the keyboard keeps the viewport and measures distance',
  (await page.evaluate(()=>tempPinTest.stats())).viewport?.visible===2&&await page.locator('[data-temp-distance-label]').count()===1);
 await page.locator('[data-temp-distance-clear]').evaluate(button=>button.click());
 check('clearing distance leaves the temporary pin',await page.locator('[data-temp-distance-label]').count()===0&&(await page.evaluate(()=>tempPinTest.stats())).count===1);
 await submit('경기도 합성시 확인로 20');
 s=await page.evaluate(()=>tempPinTest.stats());check('a new search detaches the old preview and restores the previous filter',s.count===0&&s.tracked===0&&s.activeCircles===0&&s.pending&&!s.viewport&&s.centerFilter===initial.centerFilter&&s.vehicleScope===initial.vehicleScope);
 await page.evaluate(()=>tempPinTest.click(37.56,127.01));s=await page.evaluate(()=>tempPinTest.stats());check('a second search shows only its own pin',s.count===1&&s.virtual.address==='경기도 합성시 확인로 20');
 const marker=await page.locator('[data-search-temporary-pin]').elementHandle();
 await removeFromMap();
 check('map X detaches the overlay and removes the old marker handler',await marker.evaluate(node=>!node.isConnected&&node.onclick===null));
 await marker.dispose();
 await page.evaluate(()=>tempPinTest.move());await page.evaluate(()=>new Promise(requestAnimationFrame));
 s=await page.evaluate(()=>tempPinTest.stats());
 assert.deepEqual([s.count,s.tracked,s.virtual,s.activeCircles,s.stores],[0,0,null,0,initial.stores]);
 assert.deepEqual(s.storePoints,initial.storePoints);
 checks.push('zoom and pan do not restore a deleted preview or change saved and manual store points');
 await submit('경기도 합성시 확인로 20');check('repeat search does not restore the deleted hand-picked coordinates',await page.locator('[data-search-temporary-pin]').count()===0);
 await page.evaluate(()=>tempPinTest.click(37.56,127.01));
 await page.locator('#detailClose').evaluate(button=>button.click());
 check('closing the detail leaves the map X usable',await page.locator('.searchTemporaryRemove').isVisible());
 await page.locator('[data-search-temporary-pin]').evaluate(button=>button.click());
 await page.locator('#removeTemporaryPin').evaluate(button=>button.click());
 s=await page.evaluate(()=>tempPinTest.stats());check('detail deletion shares the same cleanup',s.count===0&&s.tracked===0&&!s.virtual&&!s.activeCircles);
 for(const [i,role] of ['origin','waypoint','destination'].entries()){
  await submit('서울 합성구 경로길 '+(101+i));
  await page.evaluate(i=>tempPinTest.click(37.55+i*.015,127+i*.015),i);
  await page.locator('#detail [data-nav-pick="'+role+'"]').click();
 }
 check('all three route roles survive the intervening searches',await page.evaluate(()=>MapNavigation.metrics().routePointCount===3));
 await page.locator('#planRoute').evaluate(button=>button.click());
 await page.waitForFunction(()=>MapNavigation.metrics().routeState==='success');
 check('the route endpoint receives the three correct points',routeRequests.length===1&&routeRequests[0].waypoints.length===1&&routeRequests[0].origin.lat===37.55&&routeRequests[0].destination.lng===127.03);
 await removeFromMap();
 await submit('서울 합성구 경로밖길 120');await page.evaluate(()=>tempPinTest.click(37.58,127.04));
 assert.equal(await page.locator('[data-search-temporary-pin]').count(),1);
 await page.locator('#clearQuery').click();
 check('search reset clears the input and preview while keeping the road route',await page.evaluate(()=>
  !document.querySelector('#query').value&&tempPinTest.stats().count===0&&MapNavigation.metrics().routePointCount===3&&MapNavigation.metrics().temporaryPointCount===3&&
  MapUiLocalBridge.manualRouteState().distanceMeters===2400&&MapUiLocalBridge.manualRouteState().durationSeconds===360&&
  window.allOverlays.filter(o=>o.map&&o.opts.path&&o.opts.strokeStyle!=='shortdash').length===2));
 await page.locator('.navRoutePoint[data-role="waypoint"]').evaluate(button=>button.click());
 check('inspecting a route point does not recreate a deleted search marker',await page.locator('#detailSection').isVisible()&&await page.locator('[data-search-temporary-pin],#removeTemporaryPin').count()===0);
 await page.evaluate(()=>{MapNavigationEditor.clear();tempPinTest.clear();});
 for(const action of ['overview','mode','pagehide','logout']){
  await page.evaluate(()=>tempPinTest.begin('서울 합성구 검토로 30'));await page.evaluate(()=>tempPinTest.click(37.55,127));
  if(action==='overview')await page.locator('#mapReset').click();else await page.evaluate(name=>window.dispatchEvent(name==='pagehide'?new PageTransitionEvent('pagehide',{persisted:true}):new CustomEvent(name==='mode'?'map-navigation-context-changed':'map-navigation-logout')),action);
  s=await page.evaluate(()=>tempPinTest.stats());const retained=action!=='logout';
  check(action+' observes the temporary pin lifetime',s.count===Number(retained)&&Boolean(s.virtual)===retained&&s.activeCircles===0&&s.stores===initial.stores);
  await page.evaluate(()=>tempPinTest.clear());
 }
 await page.evaluate(()=>{KAKAO_MAP_CONFIG.allowExternalAddressLookup=true;return tempPinTest.begin('서울 합성구 차단로 40',{lookupAllowed:false});});
 s=await page.evaluate(()=>tempPinTest.stats());check('master lookup failure suppresses geocoder even when feature permission is true',s.lookupCalls===0&&s.pending);
 await page.evaluate(()=>tempPinTest.clear());
 await page.evaluate(()=>{window.firstSearch=tempPinTest.begin('서울 합성구 이전로 50');});
 await page.waitForFunction(()=>window.pendingLookups.length===1);
 await page.evaluate(()=>{window.secondSearch=tempPinTest.begin('서울 합성구 마지막로 60');});
 await page.waitForFunction(()=>window.pendingLookups.length===2);
 await page.evaluate(()=>pendingLookups[0].cb([{x:'127.03',y:'37.57',road_address:{address_name:'서울 합성구 이전로 50'}}],'OK'));
 check('superseded geocoder reply cannot render a stale point',(await page.evaluate(()=>tempPinTest.stats())).count===0);
 await page.evaluate(()=>pendingLookups[1].cb([{x:'127.04',y:'37.58',road_address:{address_name:'서울 합성구 마지막로 60'}}],'OK'));
 await page.evaluate(()=>window.secondSearch);s=await page.evaluate(()=>tempPinTest.stats());check('last authorized provider reply produces exactly its point',s.count===1&&s.virtual.address==='서울 합성구 마지막로 60');
 await page.evaluate(()=>tempPinTest.clear());
 await page.evaluate(()=>tempPinTest.finish({customerCode:'S990001',customerName:'SYNTHETIC_ONE',address:'서울특별시 합성구 기존로 1',lat:37.55,lng:127}));
 check('stored customer result never becomes a temporary pin',await page.evaluate(()=>window.selectedSyntheticCustomer==='S990001'&&tempPinTest.stats().count===0));
 await page.evaluate(()=>{const owner=tempPinTest.stats().owner;window.expiredOwner=owner;return tempPinTest.begin('서울 합성구 대기로 70',{lookupAllowed:false});});
 await page.evaluate(()=>tempPinTest.finish({address:'서울 합성구 이전로 50',lat:37.55,lng:127},expiredOwner));
 check('stale owner cannot finish a point',(await page.evaluate(()=>tempPinTest.stats())).count===0);
 await page.evaluate(()=>tempPinTest.clear());
 await page.evaluate(()=>{
  document.querySelector('#results').hidden=true;
  KAKAO_MAP_CONFIG.allowExternalPlaceLookup=true;
  window.kakaoGeocoder={serverProxy:true,addressSearch(_query,callback,{mode}){
   if(mode!=='place')throw Error('PLACE_MODE_REQUIRED');
   callback([
    {x:'127.04',y:'37.58',address_name:'서울 합성구 상호길 1',place_name:'합성 상호 첫 지점'},
    {x:'127.05',y:'37.59',address_name:'서울 합성구 상호길 2',place_name:'합성 상호 둘째 지점'}
   ],'OK',{resolution:{kind:'KEYWORD'}});
  }};
  return tempPinTest.begin('합성 상호');
 });
 check('provider candidate menu is visibly expanded',await page.locator('[data-address-candidate]').count()===2&&await page.locator('#results').isVisible()&&await page.locator('#query').getAttribute('aria-expanded')==='true');
 check('place candidates have names and addresses and no pin before selection',await page.locator('[data-address-candidate="1"]').innerText().then(text=>text.includes('합성 상호 둘째 지점')&&text.includes('상호길 2'))&&(await page.evaluate(()=>tempPinTest.stats())).count===0);
 await page.locator('[data-address-candidate="1"]').click();
 check('selection shows the chosen place on the map',await page.evaluate(()=>tempPinTest.stats().virtual.address==='서울 합성구 상호길 2'));
 await page.locator('#searchPointToBatch').click();
 check('selected temporary place can be passed to the batch input',await page.locator('#newAreaBatchInput').inputValue().then(value=>value.includes('서울 합성구 상호길 2')));
 await page.evaluate(()=>tempPinTest.clear());
 await page.close();page=await openPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await submit('서울 합성구 모바일길 35');await page.evaluate(()=>tempPinTest.click(37.55,127));
 await removeFromMap({touch:true});
 check('390px touch removes the map pin and viewport layer',await page.evaluate(()=>{const s=tempPinTest.stats();return s.count===0&&s.tracked===0&&!s.virtual&&!s.viewport&&s.activeCircles===0;}));
 await submit('서울 합성구 모바일길 36');await page.evaluate(()=>tempPinTest.click(37.55,127));
 const occlusion=await page.evaluate(()=>{
  tempPinTest.releaseFocus();
  const button=document.querySelector('.searchTemporaryRemove');
  const anchor=document.querySelector('[data-search-temporary-pin]').getBoundingClientRect();
  const drawer=document.createElement('div');drawer.className='mobileMapControls';
  const left=anchor.right+3, top=anchor.top;
  Object.assign(drawer.style,{position:'fixed',left:(left-5)+'px',top:(top-5)+'px',right:'auto',bottom:'auto',
    zIndex:'9999',display:'block',width:'48px',height:'48px'});
  document.body.append(drawer);
  const originalBlocked=document.elementFromPoint(left+19,top+19)===drawer;
  tempPinTest.positionButtons();
  const rect=button.getBoundingClientRect();
  return {originalBlocked,buttonClickable:button.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2))};
 });
 assert.deepEqual(occlusion,{originalBlocked:true,buttonClickable:true});
 await removeFromMap({touch:true});
 check('390px touch can delete a pin when the drawer covers the original button position',await page.evaluate(()=>tempPinTest.stats().count===0));
 await submit('서울 합성구 상세카드길 37');
 const firstTouch=await page.evaluate(()=>{
  const map=MapUiLocalBridge.state.map, node=document.querySelector('#map');
  const bounds=node.getBoundingClientRect();
  const point=map.getCenter(), x=bounds.left+bounds.width/2,y=bounds.top+bounds.height/2;
  const drawer=document.querySelector('#detailSection');
  for(const [key,value] of Object.entries({position:'fixed',left:x+12+'px',top:y-68+'px',right:'auto',
    bottom:'auto',width:'140px',height:'125px',margin:'0'}))drawer.style.setProperty(key,value,'important');
  tempPinTest.click(point.getLat(),point.getLng());
  const originalHit=drawer.contains(document.elementFromPoint(x+36,y-24));
  const button=document.querySelector('.searchTemporaryRemove'), rect=button.getBoundingClientRect();
  const touchX=rect.left+rect.width/2,touchY=rect.top+rect.height/2;
  return {originalHit,actionable:button.contains(document.elementFromPoint(touchX,touchY))};
 });
 check('the initial drawer covers the nominal delete location',firstTouch.originalHit);
 check('390px map delete is touchable as soon as the drawer opens',firstTouch.actionable);
 await removeFromMap({touch:true});
 check('the first physical tap deletes the temporary pin only',await page.evaluate(()=>{
  const s=tempPinTest.stats();return s.count===0&&s.tracked===0&&s.stores===2&&s.activeCircles===0;
 }));
 await page.locator('#detailSection').evaluate(drawer=>drawer.removeAttribute('style'));
 await submit('서울 합성구 회전길 38');
 const mobilePoint=await page.evaluate(()=>{
  const point=MapUiLocalBridge.state.map.getCenter();
  tempPinTest.click(point.getLat(),point.getLng());
  return {lat:point.getLat(),lng:point.getLng()};
 });
 await page.setViewportSize({width:844,height:390});
 await page.waitForFunction(()=>{
  const button=document.querySelector('.searchTemporaryRemove');
  return button.parentElement.matches('.searchTemporaryMarker')&&!button.hasAttribute('data-floating-delete')&&!button.hidden;
 });
 await page.setViewportSize({width:390,height:844});
 await page.waitForFunction(()=>document.querySelector('.searchTemporaryRemove').hasAttribute('data-floating-delete'));
 check('viewport rotation keeps a single delete control and the saved stores',await page.evaluate(()=>{
  const s=tempPinTest.stats();return document.querySelectorAll('.searchTemporaryRemove').length===1&&s.count===1&&s.stores===2;
 }));
 await page.evaluate(({lat,lng})=>tempPinTest.move(lat,lng+1),mobilePoint);
 await page.waitForFunction(()=>document.querySelector('.searchTemporaryRemove').hidden);
 await page.evaluate(({lat,lng})=>tempPinTest.move(lat,lng),mobilePoint);
 await removeFromMap({touch:true});
 check('zoom and drag hide and restore the control without removing stores',await page.evaluate(()=>{
  const s=tempPinTest.stats();return s.count===0&&s.stores===2&&s.activeCircles===0;
 }));
 await page.evaluate(()=>tempPinTest.setFilters('osan','selected'));
 await submit('서울 합성구 필터길 50');
 await page.evaluate(()=>tempPinTest.click(37.55,127));
 await page.locator('#detailClose').evaluate(button=>button.click());
 check('closing search restores a non-default center and vehicle scope',await page.evaluate(()=>{
   const s=tempPinTest.stats();return !s.viewport&&s.centerFilter==='osan'&&s.vehicleScope==='selected';
 }));
 check('synthetic browser has no unhandled errors',errors.length===0);check('no remote calls or persistent writes',external.length===0&&requests.every(r=>r.method==='GET'||r.path.endsWith('/base-vehicles')||r.path.endsWith('/manual-road-route')));
 const result={scope:'LOCAL_CHROMIUM_FIXTURE',pass:checks.length,fail:0,checks,errors,externalRequests:external.length,artifacts:out};fs.writeFileSync(path.join(out,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error(JSON.stringify({errors,requests,external,state:page?await page.evaluate(()=>({bridge:!!window.MapUiLocalBridge,rows:window.MapUiLocalBridge?.state.currentRows.length,status:document.querySelector('#freshnessState')?.textContent})):null}));throw error;}finally{await browser?.close();await new Promise(r=>server.close(r));}
