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
window.MapStaffEntry={status(){},registerPurge(){}};window.MapTerritoryUi={renderForSelection(){}};
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
   click(lat,lng){kakao.maps.event.trigger(state.map,'click',{latLng:new kakao.maps.LatLng(lat,lng)});},clear:clearSearchTemporaryPin,
   finish:(p,owner=state.searchRequestId)=>finishAddress(p,{owner}),geocode:geocodeAddress,
   stats:()=>({count:document.querySelectorAll('[data-search-temporary-pin]').length,pending:!!searchTemporaryClick,
    activeCircles:window.allCircles.filter(x=>x.map).length,stores:state.currentRows.length,markerCount:markerEntries.size,
    virtual:state.virtual?{address:state.virtual.address,lat:state.virtual.lat,lng:state.virtual.lng,customerMatchState:state.virtual.customerMatchState}:null,
    lookupCalls:window.lookupCalls,owner:state.searchRequestId,addressOwner:state.addressRequestId})};
  initVehicles();`);
const scripts=['phase2b-ui-helpers.js','map-period-ui.js','map-view-policy.js','road-route-ui.js','new-area-requests.js','manual-waypoints.js','manual-road-route-ui.js','map-dot-ui.js'];
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
 await page.goto(origin);await page.waitForFunction(()=>window.MapUiLocalBridge?.isDataReady()&&MapUiLocalBridge.state.map);
 const initial=await page.evaluate(()=>tempPinTest.stats()),check=(n,v)=>{assert(v,n);checks.push(n);};
 await page.evaluate(()=>tempPinTest.begin('서울 종로구 합성로 14'));
 let s=await page.evaluate(()=>tempPinTest.stats());check('unapproved address arms map click without a provider call',s.pending&&s.lookupCalls===0&&s.count===0);
 await page.evaluate(()=>tempPinTest.click(37.55,127));s=await page.evaluate(()=>tempPinTest.stats());check('map click creates exactly one temporary pin and 500m circle',s.count===1&&s.activeCircles===1&&!s.pending);
 check('temporary point stays out of customer rows and marker index',s.stores===initial.stores&&s.markerCount===initial.markerCount&&s.virtual.customerMatchState==='UNCONFIRMED');
 check('nearby UI uses 500m and 30km reference labels',await page.locator('#nearWrap').innerText().then(x=>x.includes('500m')&&x.includes('30km')&&x.includes('미확정')));
 await page.evaluate(()=>tempPinTest.begin('경기도 합성시 확인로 20'));
 s=await page.evaluate(()=>tempPinTest.stats());check('second search removes previous temporary pin before a new point',s.count===0&&s.activeCircles===0&&s.pending);
 await page.evaluate(()=>tempPinTest.click(37.56,127.01));s=await page.evaluate(()=>tempPinTest.stats());check('second search retains only its last point',s.count===1&&s.virtual.address==='경기도 합성시 확인로 20');
 await page.evaluate(()=>window.dispatchEvent(new Event('map-unified-search-clear')));s=await page.evaluate(()=>tempPinTest.stats());check('clear removes temporary pin and circle without removing stored markers',!s.virtual&&s.count===0&&s.activeCircles===0&&s.markerCount===initial.markerCount);
 for(const action of ['overview','mode','logout','pagehide']){
  await page.evaluate(()=>tempPinTest.begin('서울 합성구 검토로 30'));await page.evaluate(()=>tempPinTest.click(37.55,127));
  if(action==='overview')await page.locator('#mapReset').click();else await page.evaluate(name=>window.dispatchEvent(name==='pagehide'?new PageTransitionEvent('pagehide',{persisted:true}):new CustomEvent(name==='mode'?'map-navigation-context-changed':'map-navigation-logout')),action);
  s=await page.evaluate(()=>tempPinTest.stats());check(action+' removes only temporary state',s.count===0&&!s.virtual&&s.activeCircles===0&&s.stores===initial.stores);
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
 check('synthetic browser has no unhandled errors',errors.length===0);check('no remote calls or persistent writes',external.length===0&&requests.every(r=>r.method==='GET'||r.path.endsWith('/base-vehicles')));
 const result={scope:'LOCAL_EDGE_SYNTHETIC_NO_REAL_SOURCE_OR_GEOCODING',pass:checks.length,fail:0,checks,errors,externalRequests:external.length,artifacts:out};fs.writeFileSync(path.join(out,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error(JSON.stringify({errors,requests,external,state:page?await page.evaluate(()=>({bridge:!!window.MapUiLocalBridge,rows:window.MapUiLocalBridge?.state.currentRows.length,status:document.querySelector('#freshnessState')?.textContent})):null}));throw error;}finally{await browser?.close();await new Promise(r=>server.close(r));}
