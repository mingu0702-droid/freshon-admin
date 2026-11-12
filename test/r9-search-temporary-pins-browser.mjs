import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
const {chromium}=await import(process.env.OPSMAP_TEST_PLAYWRIGHT_MODULE||'playwright');

// Isolated synthetic browser/SDK fixture. No credentials, source reads, geocoding or writes.
const root=path.resolve('public/opsmap'),out=fs.mkdtempSync(path.join(os.tmpdir(),'opsmap-r9-temp-pins-'));
const rows=[{customerCode:'S990001',customerName:'SYNTHETIC_ONE',address:'서울특별시 합성구 기존로 1',vehicle:'101',lat:37.55,lng:127,lastDeliveryDate:'2026-11-02'},
 {customerCode:'S990002',customerName:'SYNTHETIC_TWO',address:'서울특별시 합성구 기존로 2',vehicle:'122',lat:37.551,lng:127.001,lastDeliveryDate:'2026-11-02'}];
const version='e'.repeat(64),checkedAt='2026-11-02T00:00:00Z',requests=[],external=[],errors=[],checks=[];
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
class FixtureMap{constructor(el,o){this.el=el;this.center=o.center;this.level=5;this.listeners={}}getCenter(){return this.center}setCenter(p){this.center=p}panTo(p){this.center=p}getLevel(){return this.level}setLevel(v){this.level=v}getBounds(){return new Bounds()}setBounds(){}relayout(){}getProjection(){return{containerPointFromCoords:p=>({x:350+(p.lng-127)*50,y:300+(p.lat-37)*50}),coordsFromContainerPoint:p=>new Coord(37.55,127)}}}
class Overlay{constructor(o){this.opts=o;window.allOverlays.push(this)}setMap(m){this.map=m;this.opts.content?.remove();if(m&&this.opts.content)m.el.append(this.opts.content)}}
class Circle{constructor(o){this.opts=o;window.allCircles.push(this)}setMap(m){this.map=m}}
window.kakao={maps:{LatLng:Coord,LatLngBounds:Bounds,Map:FixtureMap,CustomOverlay:Overlay,Polygon:Overlay,Polyline:Overlay,Circle,event:{addListener(t,n,f){(t.listeners[n]||=[]).push(f)},removeListener(t,n,f){t.listeners[n]=t.listeners[n].filter(x=>x!==f)},trigger(t,n,e){for(const f of t.listeners[n]||[])f(e)}}}};
window.KakaoMapsAdapter={ready:()=>Promise.resolve(),reset(){}};`;
const runtime=fs.readFileSync(path.join(root,'map-phase2b-runtime.js'),'utf8').replace('\n  initVehicles();',`
  function selectUnifiedSearchStore(row){window.selectedSyntheticCustomer=row.customerCode;}
  window.tempPinTest={begin(text,options={}){++state.searchRequestId;return searchExternalAddress(text,{owner:state.searchRequestId,...options});},
   click(lat,lng){kakao.maps.event.trigger(state.map,'click',{latLng:new kakao.maps.LatLng(lat,lng)});},clear:clearTemporaryPins,
   finish:(p,owner=state.searchRequestId)=>finishAddress(p,{owner}),geocode:geocodeAddress,
   stats:()=>({count:document.querySelectorAll('[data-search-temporary-pin]').length,pending:!!searchTemporaryClick,
    activeCircles:window.allCircles.filter(x=>x.map).length,stores:state.currentRows.length,markerCount:markerEntries.size,
    virtual:state.virtual?{address:state.virtual.address,lat:state.virtual.lat,lng:state.virtual.lng,customerMatchState:state.virtual.customerMatchState}:null,
    lookupCalls:window.lookupCalls,owner:state.searchRequestId,addressOwner:state.addressRequestId})};
  initVehicles();`);
const scripts=['phase2b-ui-helpers.js','map-period-ui.js','map-view-policy.js','road-route-ui.js','new-area-requests.js','manual-waypoints.js','manual-road-route-ui.js','map-dot-ui.js','opsmap-daily.js'];
let html=fs.readFileSync(path.join(root,'map-phase2b-preview.html'),'utf8').replace(/<script\b[\s\S]*?<\/script>/gi,'');
html=html.replace('</body>','<script>'+fixture+'</script>'+scripts.map(f=>'<script src="'+f+'"></script>').join('')+'<script src="temp-runtime.js"></script></body>');
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname.startsWith('/api/')){
  requests.push({path:u.pathname,method:req.method});let data={data:[],meta:{}};
  if(u.pathname.endsWith('/snapshot'))data={data:rows,meta:{complete:true,latestDate:'2026-11-02',startDate:'2026-09-04',endDate:'2026-11-02'}};
  if(u.pathname.endsWith('/base-vehicles'))data={ok:true,data:rows.map(r=>({customerCode:r.customerCode,baseVehicle:r.vehicle,baseVehicleState:'VERIFIED_MASTER',baseVehicleGroup:'osan',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:version,baseVehicleStale:false,baseVehicleCheckedAt:checkedAt})),meta:{basis:'FIXED_DISPATCH_PRIMARY',version,checkedAt,stale:false,refresh:'IDLE'}};
  res.setHeader('content-type','application/json');res.end(JSON.stringify(data));return;
 }
 if(u.pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
 if(path.basename(u.pathname)==='temp-runtime.js'){res.setHeader('content-type','application/javascript');res.end(runtime);return;}
 const f=path.join(root,path.basename(u.pathname));if(fs.existsSync(f)&&fs.statSync(f).isFile()){res.setHeader('content-type',f.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(f));}else{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
let browser,page;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.OPSMAP_TEST_CHROMIUM||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 page=await browser.newPage({viewport:{width:1366,height:900}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(new URL(route.request().url()).hostname);return route.abort();}return route.continue();});
 await page.goto(origin);await page.waitForFunction(()=>window.MapUiLocalBridge?.isDataReady()&&MapUiLocalBridge.state.map&&
  MapUiLocalBridge.state.currentRows.length===2&&MapUiLocalBridge.fixedTerritoryMasterState());
 const initial=await page.evaluate(()=>tempPinTest.stats()),check=(n,v)=>{assert(v,n);checks.push(n);};
 await page.evaluate(()=>tempPinTest.begin('서울 종로구 합성로 14'));
 let s=await page.evaluate(()=>tempPinTest.stats());check('unapproved address arms map click without a provider call',s.pending&&s.lookupCalls===0&&s.count===0);
 await page.evaluate(()=>tempPinTest.click(37.55,127));s=await page.evaluate(()=>tempPinTest.stats());check('map click creates exactly one temporary pin and 500m circle',s.count===1&&s.activeCircles===1&&!s.pending);
 check('temporary point stays out of customer rows and marker index',s.stores===initial.stores&&s.markerCount===initial.markerCount&&s.virtual.customerMatchState==='UNCONFIRMED');
 await page.locator('#nearWrap [data-area-nearest]').waitFor();
 check('a hand-picked location shows the closest store and leaves delivery under review',await page.locator('#nearWrap').innerText().then(x=>x.includes('직선거리')&&x.includes('30km')&&x.includes('검토 필요')));
 await page.locator('#nearWrap [data-area-dispatch-vehicle]').first().waitFor();
 const vehicleCount=await page.locator('[data-area-dispatch-pin]').count();
 await page.locator('[data-area-dispatch-pin]').last().evaluate(button=>button.click());
 check('inspecting a nearby vehicle preserves all vehicle markers and updates the measured distance',
  vehicleCount===2&&await page.locator('[data-area-dispatch-pin]').count()===vehicleCount&&await page.locator('[data-temp-distance-label]').count()===1);
 await page.locator('[data-temp-distance-clear]').evaluate(button=>button.click());
 check('clearing distance leaves the temporary pin',await page.locator('[data-temp-distance-label]').count()===0&&(await page.evaluate(()=>tempPinTest.stats())).count===1);
 await page.evaluate(()=>tempPinTest.begin('경기도 합성시 확인로 20'));
 s=await page.evaluate(()=>tempPinTest.stats());check('a pending search preserves the previous temporary pin',s.count===1&&s.activeCircles===1&&s.pending);
 await page.evaluate(()=>tempPinTest.click(37.56,127.01));s=await page.evaluate(()=>tempPinTest.stats());check('new searches keep previous temporary pins and update the current anchor',s.count===2&&s.virtual.address==='경기도 합성시 확인로 20');
 const markersBeforeClose=s.markerCount;
 await page.locator('#detailClose').evaluate(button=>button.click());
 await page.evaluate(()=>window.dispatchEvent(new Event('map-unified-search-clear')));s=await page.evaluate(()=>tempPinTest.stats());check('detail close and search clear preserve temporary pins and stored markers',s.count===2&&s.activeCircles===1&&s.markerCount===markersBeforeClose);
 await page.locator('[data-search-temporary-pin]').last().evaluate(button=>button.click());
 await page.locator('#removeTemporaryPin').evaluate(button=>button.click());
 s=await page.evaluate(()=>tempPinTest.stats());check('explicit deletion removes only the selected temporary pin',s.count===1&&!s.virtual&&!s.activeCircles);
 await page.evaluate(()=>tempPinTest.clear());
 for(const action of ['overview','mode','pagehide','logout']){
  await page.evaluate(()=>tempPinTest.begin('서울 합성구 검토로 30'));await page.evaluate(()=>tempPinTest.click(37.55,127));
  if(action==='overview')await page.locator('#mapReset').click();else await page.evaluate(name=>window.dispatchEvent(name==='pagehide'?new PageTransitionEvent('pagehide',{persisted:true}):new CustomEvent(name==='mode'?'map-navigation-context-changed':'map-navigation-logout')),action);
  s=await page.evaluate(()=>tempPinTest.stats());const retained=action!=='logout';
  check(action+' observes the temporary pin lifetime',s.count===Number(retained)&&Boolean(s.virtual)===retained&&s.activeCircles===Number(retained)&&s.stores===initial.stores);
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
 check('synthetic browser has no unhandled errors',errors.length===0);check('no remote calls or persistent writes',external.length===0&&requests.every(r=>r.method==='GET'||r.path.endsWith('/base-vehicles')));
 const result={scope:'LOCAL_EDGE_SYNTHETIC_NO_REAL_SOURCE_OR_GEOCODING',pass:checks.length,fail:0,checks,errors,externalRequests:external.length,artifacts:out};fs.writeFileSync(path.join(out,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error(JSON.stringify({errors,requests,external,state:page?await page.evaluate(()=>({bridge:!!window.MapUiLocalBridge,rows:window.MapUiLocalBridge?.state.currentRows.length,status:document.querySelector('#freshnessState')?.textContent})):null}));throw error;}finally{await browser?.close();await new Promise(r=>server.close(r));}
