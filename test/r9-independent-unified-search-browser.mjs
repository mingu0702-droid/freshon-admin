import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const {chromium}=await import(process.env.OPSMAP_TEST_PLAYWRIGHT_MODULE||'playwright');

// Independent candidate UI/runtime check. Every source, identity and SDK is synthetic.
// This cannot certify Kakao or Production; no remote request or real pin write is allowed.
const root=path.resolve(process.env.OPSMAP_QA_PUBLIC_ROOT||'public/opsmap');
const output=path.resolve('reports/r9-search-independent');fs.mkdirSync(output,{recursive:true});
const day='2026-11-02',version='f'.repeat(64),checks=[],external=[],errors=[],requests=[];
const rows=[
 {customerCode:'S990001',customerName:'합성 와플 매장',lat:37.5,lng:127,vehicle:'101'},
 {customerCode:'S990002',customerName:'합성 공동매장',lat:37.52,lng:127.02,vehicle:'122'},
 {customerCode:'S990003',customerName:'합성 공동매장',lat:37.52,lng:127.02,vehicle:'122'},
 {customerCode:'B990004',customerName:'합성 미확인 매장',lat:null,lng:null,vehicle:'202'},
 {customerCode:'S990005',customerName:'합성 주소변경 매장',lat:37.54,lng:127.04,vehicle:'172'}
].map(row=>({...row,address:'',lastDeliveryDate:day,coordinateSource:'SYNTHETIC_GPS'}));
const scripts=['phase2b-ui-helpers.js','map-period-ui.js','map-view-policy.js','road-route-ui.js','new-area-requests.js','manual-waypoints.js','manual-road-route-ui.js','map-dot-ui.js','map-phase2b-runtime.js','map-approved-shell-candidate.js','navigation-ui.js'];
const fixture=`
window.VEHICLE_AREA_DATA={vehicles:${JSON.stringify(['101','122','172','202'].map(vehicle=>({vehicle,group:'osan',customers:[]})))}};
window.KAKAO_MAP_CONFIG={allowExternalAddressLookup:false};window.fixturePurges=[];window.fixtureOverlays=[];window.fixtureGeocodes=0;
document.body.dataset.mapStaffState='authenticated';window.MapStaffEntry={status(){},registerPurge(fn){window.fixturePurges.push(fn)}};
window.MapManualPins={apply(row){if(row.customerCode==='S990001')Object.assign(row,{lat:37.511,lng:127.011,coordinateSource:'MANUAL_PIN',resolutionStatus:'MANUAL_CONFIRMED',manualPinRevision:7});if(row.customerCode==='S990005')Object.assign(row,{lat:37.541,lng:127.041,coordinateSource:'MANUAL_PIN',resolutionStatus:'MANUAL_CONFIRMED',manualPinRevision:4});return row;},open(){}};
window.MapTerritoryUi={renderForSelection(){},toggle(){}};
class Coord{constructor(lat,lng){this.lat=lat;this.lng=lng}getLat(){return this.lat}getLng(){return this.lng}}
class Bounds{extend(){}getSouthWest(){return new Coord(33,124)}getNorthEast(){return new Coord(39.5,132)}}
class FixtureMap{constructor(el,opts){this.el=el;this.center=opts.center;this.level=5;this.listeners={};el.addEventListener('click',()=>{window.fixtureMapClicks=(window.fixtureMapClicks||0)+1;for(const fn of this.listeners.click||[])fn({latLng:new Coord(37.571,126.981)})})}getCenter(){return this.center}setCenter(p){this.center=p}panTo(p){this.center=p}getLevel(){return this.level}setLevel(n){this.level=n}getBounds(){return new Bounds()}setBounds(){}relayout(){}getProjection(){return {containerPointFromCoords:p=>({x:400+(p.lng-127)*100,y:300+(p.lat-37.5)*100}),coordsFromContainerPoint:p=>new Coord(37.5+(p.y-300)/100,127+(p.x-400)/100)}}}
class Overlay{constructor(opts){this.opts=opts;this.position=opts.position;window.fixtureOverlays.push(this)}setMap(map){this.map=map;if(this.opts.content instanceof Node){this.opts.content.remove();if(map)map.el.append(this.opts.content)}}setPosition(p){this.position=p}getPosition(){return this.position}setZIndex(){}setOptions(o){Object.assign(this.opts,o)}}
class Geocoder{addressSearch(text,callback){window.fixtureGeocodes++;setTimeout(()=>callback([{x:text.includes('702')?'127.12':'127.11',y:text.includes('702')?'37.62':'37.61',address_name:text}], 'OK'),40)}}
window.kakao={maps:{LatLng:Coord,LatLngBounds:Bounds,Point:class{constructor(x,y){this.x=x;this.y=y}},Map:FixtureMap,CustomOverlay:Overlay,Circle:Overlay,Polygon:Overlay,Polyline:Overlay,services:{Geocoder,Places:class{},Status:{OK:'OK',ZERO_RESULT:'ZERO_RESULT'}},event:{addListener(o,n,f){(o.listeners||={})[n]??=[];o.listeners[n].push(f)},removeListener(){}}}};
window.KakaoMapsAdapter={ready:()=>Promise.resolve(),reset(){}};`;
let html=fs.readFileSync(path.join(root,'map-phase2b-preview.html'),'utf8').replace(/<script\b[\s\S]*?<\/script>/gi,'');
html=html.replace('</body>','<script>'+fixture+'</script>'+scripts.map(f=>'<script src="'+f+'"></script>').join('')+'</body>');
let searchCalls=0;
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1');
 if(u.pathname.startsWith('/api/')){
  requests.push({method:req.method,path:u.pathname});let data={data:[],meta:{}};
  if(u.pathname.endsWith('/snapshot'))data={ok:true,data:rows,meta:{complete:true,latestDate:day,startDate:'2026-09-04',endDate:day}};
  else if(u.pathname.endsWith('/base-vehicles'))data={ok:true,data:rows.map(r=>({customerCode:r.customerCode,baseVehicle:r.vehicle,baseVehicleGroup:'osan',baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:version,baseVehicleStale:false,baseVehicleCheckedAt:'2026-11-02T00:00:00Z'})),meta:{version,stale:false,basis:'FIXED_DISPATCH_PRIMARY',checkedAt:'2026-11-02T00:00:00Z'}};
  else if(u.pathname.endsWith('/customer-search')){
   searchCalls++;const q=decodeURIComponent(req.headers['x-map-customer-query']||'').normalize('NFKC').trim();
   if(q.includes('원천조회실패')){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:'CUSTOMER_LOOKUP_UNAVAILABLE'}));return;}
   const compact=q.replace(/서울특별시|서울시/g,'서울').replace(/경기도/g,'경기').replace(/\s/g,'');
   const delayed=q==='늦은 검색 결과';
   let found=/^[SB]\d+$/.test(q)?rows.filter(r=>r.customerCode===q):rows.filter(r=>r.customerName.includes(q));
   if(compact==='서울강남구합성대로101')found=rows.filter(r=>['S990002','S990003'].includes(r.customerCode));
   if(compact==='서울강남구수동대로7')found=[rows[0]];
   if(compact==='서울강남구변경된길900')found=[rows[4]];
   if(delayed)found=[rows[1]];
   data={ok:true,data:found.map(r=>r.customerCode==='S990005'?{...r,lat:null,lng:null,addressChanged:true,resolutionStatus:'ADDRESS_CHANGED_REVIEW_REQUIRED'}:r),meta:{source:'SYNTHETIC_CURRENT_CUSTOMER',customerMatchVerified:true,matchedBy:compact.includes('합성대로')?'ADDRESS':'NAME'}};
   if(delayed){setTimeout(()=>{if(!res.destroyed){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));}},450);return;}
  }else if(u.pathname.endsWith('/assignments')){const date=u.searchParams.get('date')==='latest'?day:u.searchParams.get('date');data={ok:true,data:rows.map(r=>({...r,deliveryDate:date})),meta:{complete:true,date,reviewOnly:true}};}
  else if(u.pathname.endsWith('/customer-detail')||u.pathname.endsWith('/current-customer')){const code=u.searchParams.get('customerCode');const row=rows.find(r=>r.customerCode===code)||{};data={ok:true,data:{...row,address:code==='S990001'?'서울특별시 강남구 수동대로 7':'서울특별시 강남구 합성대로 101',detailAddress:code==='S990002'?'합성 2층':'합성 3층'},meta:{}};}
  else if(u.pathname.endsWith('/driver-contact'))data={ok:true,data:{driverName:null,phone:null},meta:{state:'UNREGISTERED'}};
  else if(u.pathname.endsWith('/session'))data={authenticated:true};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));return;
 }
 if(u.pathname==='/'||u.pathname==='/opsmap/'){res.writeHead(200,{'content-type':'text/html'});res.end(html);return;}
 const file=path.join(root,path.basename(u.pathname));
 if(fs.existsSync(file)&&fs.statSync(file).isFile()){res.writeHead(200,{'content-type':file.endsWith('.css')?'text/css':/\.m?js$/.test(file)?'application/javascript':'application/octet-stream'});res.end(fs.readFileSync(file));}
 else{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
let browser,page;
const check=(name,condition)=>{assert(condition,name);checks.push(name);};
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.OPSMAP_TEST_CHROMIUM||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 page=await browser.newPage({viewport:{width:1366,height:900}});page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(new URL(route.request().url()).hostname);return route.abort();}return route.continue();});
 await page.goto(origin+'/opsmap/');await page.waitForFunction(()=>window.MapUiLocalBridge?.isDataReady()&&MapUiLocalBridge.state.map,null,{timeout:15000});
 const search=async value=>{await page.locator('#query').fill(value);await page.locator('#searchBtn').click();};
 const selected=code=>page.waitForFunction(c=>MapUiLocalBridge.state.selected?.customerCode===c,code);
 const virtual=()=>page.evaluate(()=>MapUiLocalBridge.state.virtual?.searchTemporary===true);
 const initial=await page.evaluate(()=>({count:MapUiLocalBridge.navigationStores().length,coordinates:MapUiLocalBridge.navigationStores().map(r=>[r.customerCode,r.lat,r.lng])}));
 await search('S990001');await selected('S990001');
 check('code selects existing manual coordinate before historical GPS',await page.evaluate(()=>MapUiLocalBridge.state.selected.lat===37.511&&MapUiLocalBridge.state.selected.lng===127.011&&MapUiLocalBridge.state.selected.coordinateSource==='MANUAL_PIN'));
 check('single match closes dropdown and never creates a temporary pin',await page.locator('#results').isHidden()&&!await virtual());
 await search('합성 와플');await selected('S990001');checks.push('partial existing name selects same customer');
 await search('서울 강남구 수동대로 7');await selected('S990001');check('existing address selects the same customer and its manual coordinate',await page.evaluate(()=>MapUiLocalBridge.state.selected.lat===37.511&&MapUiLocalBridge.state.selected.customerCode==='S990001'&&!MapUiLocalBridge.state.virtual));
 await search('서울특별시 강남구 합성대로 101');await page.waitForFunction(()=>document.querySelectorAll('#results [data-search-code]').length===2);
 const shared=await page.locator('#results [data-search-code]').evaluateAll(e=>e.map(x=>x.dataset.searchCode));assert.deepEqual(shared,['S990002','S990003']);checks.push('one address preserves separate customer candidates');
 await page.locator('#results [data-search-code="S990003"]').click();await selected('S990003');check('candidate selection closes dropdown',await page.locator('#results').isHidden());
 await search('서울 강남구 합성대로101');await page.waitForFunction(()=>document.querySelectorAll('#results [data-search-code]').length===2);checks.push('normalized address server results are not discarded for omitted address fields');
 await search('B990004');await selected('B990004');check('unlocated customer is selected without a fake position',await page.evaluate(()=>MapUiLocalBridge.state.selected.lat==null&&MapUiLocalBridge.state.selected.lng==null&&!MapUiLocalBridge.state.virtual));
 await search('서울 강남구 변경된길 900');await selected('S990005');check('current address change never reuses old coordinate automatically',await page.evaluate(()=>MapUiLocalBridge.state.selected.lat==null&&MapUiLocalBridge.state.selected.lng==null));
 await page.evaluate(()=>MapUiLocalBridge.refreshManualCoordinates());check('manual projection refresh cannot erase the selected source address conflict',await page.evaluate(()=>MapUiLocalBridge.state.selected.lat==null&&MapUiLocalBridge.state.selected.lng==null));
 await search('늦은 검색 결과');await page.waitForTimeout(50);await search('S990001');await selected('S990001');await page.waitForTimeout(550);check('late preceding result cannot overwrite current selection',await page.evaluate(()=>MapUiLocalBridge.state.selected?.customerCode==='S990001'));
 await search('원천조회실패');await page.waitForTimeout(100);check('source failure is not reported as master absence',await page.locator('#searchState').innerText().then(t=>!/고객\s*마스터에\s*없|미등록\s*확정/.test(t)));
 await page.evaluate(()=>KAKAO_MAP_CONFIG.allowExternalAddressLookup=true);await search('서울 중구 원천조회실패길 703');await page.waitForFunction(()=>document.querySelector('#map')?.dataset.searchPositionPending==='true');await page.locator('#map').click({position:{x:200,y:180}});await page.waitForFunction(()=>MapUiLocalBridge.state.virtual?.searchTemporary===true);
 check('failed Customer source permits only unconfirmed manual point and never calls geocoder',await page.evaluate(()=>MapUiLocalBridge.state.virtual.customerMatchState==='UNCONFIRMED'&&window.fixtureGeocodes===0));await page.locator('#clearQuery').click();await page.evaluate(()=>KAKAO_MAP_CONFIG.allowExternalAddressLookup=false);
 await search('원동380-38');await page.locator('[data-search-address-guide]').waitFor({state:'visible'});
 check('incomplete address stays in the operating map',await page.locator('[data-search-address-link]').count()===0&&browser.contexts()[0].pages().length===1);
 check('incomplete address asks for city or district instead of inventing regional candidates',await page.locator('[data-search-address-guide]').innerText().then(t=>t.includes('시·군·구를 입력')&&t.includes('임시 위치'))&&!await virtual()&&await page.evaluate(()=>window.fixtureGeocodes)===0);
 await page.locator('#map').click({position:{x:200,y:180}});await page.waitForFunction(()=>MapUiLocalBridge.state.virtual?.searchTemporary===true);
 check('incomplete address map click produces only one unsaved point and closes the search guidance',await page.locator('[data-search-temporary-pin]').count()===1&&await page.locator('[data-search-address-guide]').count()===0&&await page.evaluate(()=>MapUiLocalBridge.state.virtual.coordinateSource==='MAP_CLICK_TEMPORARY'&&MapUiLocalBridge.navigationStores().length===5));
 await page.locator('#clearQuery').click();
 await search('서울 중구 합성로 701');await page.waitForTimeout(100);check('OFF geocoding does not create an unverified automatic pin',!await virtual());
 check('qualified address fallback preserves its region',await page.locator('[data-search-address-guide]').innerText().then(t=>t.includes('시·군·구를 확인')));
 await page.locator('#map').click({position:{x:200,y:180}});await page.waitForFunction(()=>MapUiLocalBridge.state.virtual?.searchTemporary===true);
 check('manual map position creates exactly one temporary pin',await page.locator('[data-search-temporary-pin]').count()===1);
 check('temporary map point has the same three route actions',await page.locator('#detail [data-nav-pick]').allTextContents().then(labels=>JSON.stringify(labels)==='["출발","경유","도착"]'));
 const markerCount=await page.evaluate(()=>MapUiLocalBridge.state.overlays.filter(x=>x.map).length);
 await search('서울 중구 합성로 702');check('next search removes old temporary pin before lookup',await page.locator('[data-search-temporary-pin]').count()===0);
 await page.locator('#map').click({position:{x:210,y:190}});await page.waitForFunction(()=>MapUiLocalBridge.state.virtual?.searchTemporary===true);check('second new address has only its own one temporary pin',await page.locator('[data-search-temporary-pin]').count()===1);
 check('temporary pin does not replace all existing markers or data rows',await page.evaluate(n=>MapUiLocalBridge.state.overlays.filter(x=>x.map).length>=n&&MapUiLocalBridge.navigationStores().length===5,markerCount));
 await page.locator('#clearQuery').click();check('clear button removes temporary state and query',!await virtual()&&await page.locator('#query').inputValue()===''&&await page.locator('[data-search-temporary-pin]').count()===0);
 check('clear removes uncommitted navigation temporary preview',await page.evaluate(()=>MapNavigation.metrics().temporaryPointCount===0));
 for(const cleanup of ['mapReset','modeDaily']){
  await search('서울 중구 합성로 701');await page.locator('#map').click({position:{x:220,y:200}});await page.waitForFunction(()=>MapUiLocalBridge.state.virtual?.searchTemporary===true);
  await page.locator('#'+cleanup).click();check(cleanup+' clears the temporary position',!await virtual()&&await page.locator('[data-search-temporary-pin]').count()===0);
  if(cleanup==='modeDaily'){await page.locator('#modePeriod').click();await page.waitForFunction(()=>MapUiLocalBridge.state.mode==='BASE_60D');}
 }
 for(const width of [1920,1366,760,390]){
  await page.setViewportSize({width,height:width<800?900:1000});await page.locator('#query').scrollIntoViewIfNeeded();await search('원동380-38');await page.locator('[data-search-address-guide]').waitFor({state:'visible'});
  const fallback=await page.locator('#results').evaluate(e=>{const box=e.getBoundingClientRect(),guide=e.querySelector('[data-search-address-guide]');return {bounded:box.left>=0&&box.right<=innerWidth+1&&e.scrollWidth<=e.clientWidth+1,wrapped:getComputedStyle(guide).whiteSpace==='normal',guideVisible:guide.getBoundingClientRect().height>=18};});
  check('address fallback '+width+' fits unified search with visible wrapping guidance',fallback.bounded&&fallback.wrapped&&fallback.guideVisible);
  await page.screenshot({path:path.join(output,'address-fallback-'+width+'.png')});await page.locator('#clearQuery').click();
  await page.setViewportSize({width,height:width<800?900:1000});await page.locator('#query').scrollIntoViewIfNeeded();await search('합성 공동');await page.waitForFunction(()=>document.querySelectorAll('#results [data-search-code]').length===2);
  const bounds=await page.evaluate(()=>{const a=document.querySelector('#query').getBoundingClientRect(),b=document.querySelector('#results').getBoundingClientRect();return {left:b.left,right:b.right,viewport:innerWidth,queryLeft:a.left,hasDuplicate:!!document.querySelector('.addressBlock:not([hidden]):not([inert])')&&getComputedStyle(document.querySelector('.addressBlock')).display!=='none',overflow:document.documentElement.scrollWidth>innerWidth+2};});
  check('viewport '+width+' has one bounded input/dropdown and no duplicate address UI',bounds.left>=-1&&bounds.right<=bounds.viewport+1&&!bounds.hasDuplicate&&!bounds.overflow);
  await page.screenshot({path:path.join(output,'search-'+width+'.png')});await page.locator('#results [data-search-code="S990002"]').click();
 }
 await page.locator('#clearQuery').click();const final=await page.evaluate(()=>({count:MapUiLocalBridge.navigationStores().length,coordinates:MapUiLocalBridge.navigationStores().map(r=>[r.customerCode,r.lat,r.lng])}));
 assert.deepEqual(final,initial);checks.push('all original rows and coordinates remain unchanged');
 await search('서울 중구 합성로 701');await page.locator('#map').click({position:{x:200,y:180}});await page.waitForFunction(()=>MapUiLocalBridge.state.virtual?.searchTemporary===true);
 await page.evaluate(()=>window.dispatchEvent(new Event('map-navigation-logout')));check('logout clears temporary position',!await virtual()&&await page.locator('[data-search-temporary-pin]').count()===0);
 await page.reload();await page.waitForFunction(()=>window.MapUiLocalBridge?.isDataReady());check('page reload never restores temporary coordinate',!await virtual()&&await page.locator('[data-search-temporary-pin]').count()===0);
 check('no remote geocoding or writes',external.length===0&&await page.evaluate(()=>window.fixtureGeocodes)===0&&requests.every(r=>r.method!=='PUT'&&r.method!=='DELETE'&&!/manual-pins/.test(r.path)));
 check('no JavaScript errors',errors.length===0);
 const result={scope:'LOCAL_EDGE_SYNTHETIC_SDK_AND_CUSTOMERS_NOT_PRODUCTION',pass:checks.length,fail:0,checks,externalRequests:external.length,sourceWrites:0,geocodeCalls:0,searchCalls,errors};fs.writeFileSync(path.join(output,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){await page?.screenshot({path:path.join(output,'failure.png')});const state=await page?.evaluate(()=>({status:document.querySelector('#searchState')?.textContent,pending:document.querySelector('#map')?.getAttribute('data-search-position-pending'),clicks:window.fixtureMapClicks,clickListeners:window.MapUiLocalBridge?.state.map?.listeners?.click?.length,virtual:window.MapUiLocalBridge?.state.virtual,searchOwner:window.MapUiLocalBridge?.state.searchRequestId,addressOwner:window.MapUiLocalBridge?.state.addressRequestId}));console.error(JSON.stringify({completed:checks,errors,external,state}));throw error;}
finally{await browser?.close();await new Promise(r=>server.close(r));}
