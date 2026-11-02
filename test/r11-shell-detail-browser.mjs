import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
const {chromium}=await import(process.env.OPSMAP_TEST_PLAYWRIGHT_MODULE||'playwright');
// Real existing shell/editor/navigation controllers, synthetic rows and SDK only.
const root=path.resolve('public/opsmap'),output=fs.mkdtempSync(path.join(os.tmpdir(),'opsmap-r11-shell-detail-'));
const rows=Array.from({length:32},(_,i)=>({customerCode:'S990'+String(i).padStart(3,'0'),customerName:'합성 매장 '+i,address:'합성주소 '+i,vehicle:'101',lat:37+i*.001,lng:127+i*.001,lastDeliveryDate:'2026-11-02'}));
// Two separate customers at one shop-in-shop coordinate remain two visits.
rows[1].lat=rows[0].lat;rows[1].lng=rows[0].lng;
const requests=[],external=[],errors=[],checks=[],version='e'.repeat(64);
const scripts=['phase2b-ui-helpers.js','map-period-ui.js','map-view-policy.js','road-route-ui.js','new-area-requests.js','manual-waypoints.js','kakao-directions-adapter.js','manual-road-route-ui.js','map-dot-ui.js','map-driver-contact.js','map-phase2b-runtime.js','map-approved-shell-candidate.js','navigation-ui.js'];
const fixture=`window.VEHICLE_AREA_DATA={vehicles:[{vehicle:'101',group:'osan',customers:[]}]};window.KAKAO_MAP_CONFIG={allowExternalAddressLookup:false};
document.body.dataset.mapStaffState='authenticated';window.OPSMAP_DRIVER_CONTACT_ENABLED=true;window.MapStaffEntry={status(){},registerPurge(){}};window.MapTerritoryUi={renderForSelection(){},toggle(){}};
class Coord{constructor(lat,lng){this.lat=lat;this.lng=lng}getLat(){return this.lat}getLng(){return this.lng}}
class Bounds{extend(){}getSouthWest(){return new Coord(33,124)}getNorthEast(){return new Coord(39.5,132)}}
class FixtureMap{constructor(el,o){this.el=el;this.center=o.center;this.level=5}getCenter(){return this.center}setCenter(p){this.center=p}panTo(p){this.center=p}getLevel(){return this.level}setLevel(v){this.level=v}getBounds(){return new Bounds()}setBounds(){}relayout(){}getProjection(){return{containerPointFromCoords:p=>({x:350,y:300}),coordsFromContainerPoint:p=>new Coord(37,127)}}}
class Overlay{constructor(o){this.opts=o}setMap(m){this.opts.content?.remove();if(m&&this.opts.content)m.el.append(this.opts.content)}}
window.kakao={maps:{LatLng:Coord,LatLngBounds:Bounds,Map:FixtureMap,CustomOverlay:Overlay,Polygon:Overlay,Polyline:Overlay,event:{addListener(){},removeListener(){}}}};window.KakaoMapsAdapter={ready:()=>Promise.resolve(),reset(){}};`;
let html=fs.readFileSync(path.join(root,'map-phase2b-preview.html'),'utf8').replace(/<script\b[\s\S]*?<\/script>/gi,'');
html=html.replace('</body>','<script>'+fixture+'</script>'+scripts.map(f=>'<script src="'+f+'"></script>').join('')+'<script>MapDotUi.mount()</script></body>');
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname.startsWith('/api/')){
  requests.push({path:u.pathname,method:req.method});let data={data:[],meta:{}};
  if(u.pathname.endsWith('/snapshot'))data={data:rows,meta:{complete:true,latestDate:'2026-11-02',startDate:'2026-09-04',endDate:'2026-11-02'}};
  if(u.pathname.endsWith('/base-vehicles'))data={ok:true,data:rows.map(r=>({customerCode:r.customerCode,baseVehicle:'101',baseVehicleState:'VERIFIED_MASTER',baseVehicleGroup:'osan',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:version,baseVehicleCheckedAt:'2026-11-02T00:00:00.000Z',baseVehicleStale:false})),meta:{version,checkedAt:'2026-11-02T00:00:00.000Z',basis:'FIXED_DISPATCH_PRIMARY',stale:false}};
  if(u.pathname.endsWith('/private/customer-detail')){const code=u.searchParams.get('customerCode');const index=rows.findIndex(r=>r.customerCode===code);data={ok:true,data:{customerCode:code,customerName:'합성 매장 '+index,address:'합성주소 '+index,detailDate:index===3?u.searchParams.get('date'):null,sourceDate:index===3?u.searchParams.get('date'):undefined,detailAddress:index===0?'합성 상세주소 2층':null,detailAddressState:index===0?'PRESENT':'EMPTY',sourceBasis:index===3?'STORED_DAY':'CURRENT_CUSTOMER_LOOKUP',locationState:index===4?'UNCONFIRMED':'SOURCE_ROW',deliveryPattern:index===0?'월수금':index===2?'미확인':index===3||index===4?'월화':'',businessCoverageVerified:false}};}
  if(u.pathname.endsWith('/private/driver-contact'))data={ok:true,data:{driverName:'합성 기사',phone:'010-1234-5678'},meta:{...Object.fromEntries(u.searchParams),state:'REGISTERED',source:'SYNTHETIC_ONLY'}};
  if(u.pathname.endsWith('/assignments'))data={data:rows.map(r=>({...r,deliveryDate:u.searchParams.get('date')})),meta:{complete:true,date:u.searchParams.get('date')}};
  res.setHeader('content-type','application/json');res.end(JSON.stringify(data));return;
 }
 if(u.pathname==='/opsmap/'){res.setHeader('content-type','text/html');res.end(html);return;}
 const f=path.join(root,u.pathname.includes('/assets/')?'assets/'+path.basename(u.pathname):path.basename(u.pathname));
 if(fs.existsSync(f)&&fs.statSync(f).isFile()){res.setHeader('content-type',f.endsWith('.css')?'text/css':f.endsWith('.svg')?'image/svg+xml':'application/javascript');res.end(fs.readFileSync(f));}else{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.OPSMAP_TEST_CHROMIUM||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1920,height:1080}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(route.request().url());return route.abort();}return route.continue();});
 await page.goto(origin+'/opsmap/');await page.waitForFunction(()=>window.MapNavigation&&MapUiLocalBridge.isDataReady());
 const check=(name,value)=>{assert(value,name);checks.push(name);};
 check('initial base picker, stores, territory and data dialog are folded',await page.locator('#baseVehiclePicker').getAttribute('open')===null&&!await page.locator('#vehicleQuery').isVisible()&&await page.locator('#togglePeriodList').getAttribute('aria-expanded')==='false'&&!await page.locator('#periodStoreList').isVisible()&&await page.locator('#territoryControls').getAttribute('open')===null&&!await page.locator('#mapDataInfoDialog').isVisible());
 check('BASE route editor summary is visible and initially folded',await page.locator('#waypointPlanner>summary').isVisible()&&await page.locator('#waypointPlanner').getAttribute('open')===null&&!await page.locator('#plannerStart').isVisible());
 await page.locator('#waypointPlanner>summary').click();check('BASE route editor opens the same searchable route fields',await page.locator('#plannerStart').isVisible()&&await page.locator('#plannerEnd').isVisible()&&await page.locator('#waypointPlanner').count()===1);await page.evaluate(()=>MapNavigationEditor.replacePoints(['S990000','S990001']));check('BASE can configure endpoints and open the integrated Kakao link',await page.locator('#plannerStart').inputValue()==='S990000'&&await page.locator('#plannerEnd').inputValue()==='S990001'&&await page.locator('#waypointPlanner #navKakaoLinks a').isVisible());await page.evaluate(()=>MapNavigationEditor.clear());await page.locator('#waypointPlanner>summary').click();
 check('search, centers, picker button, two tabs and map stay available',await page.locator('#query').isVisible()&&await page.locator('#centers').isVisible()&&await page.locator('#baseVehiclePicker>summary').isVisible()&&await page.locator('#approvedSiteHeader .tab:visible').count()===2&&await page.locator('#map').isVisible());
 await page.locator('#togglePeriodList').click();check('store list opens only by explicit action',await page.locator('#periodStoreList').isVisible()&&await page.locator('#periodStoreList [data-period-store]:visible').count()===5);await page.locator('#togglePeriodList').click();
 await page.waitForFunction(()=>MapUiLocalBridge.navigationStores().some(r=>r.customerCode==='S990000'&&r.baseVehicleState==='VERIFIED_MASTER'));await page.evaluate(()=>MapUiLocalBridge.selectNavigationStore('S990000'));await page.waitForFunction(()=>document.querySelector('#detailAddressValue')?.textContent==='합성 상세주소 2층'&&document.querySelector('#detailDriver a')?.getAttribute('href')==='tel:01012345678');
 check('selected card keeps folded store list folded',!await page.locator('#periodStoreList').isVisible());
 const labels=await page.locator('.dotDetailFacts dt:visible').allTextContents();assert.deepEqual(labels,['담당 센터','기준호차','배송요일','담당 기사','주소','상세주소']);checks.push('detail fact order is center, vehicle, actual weekdays, driver, address and detail address');
 check('only allowlisted Customer delivery pattern is displayed',await page.locator('#detailDeliveryDaysValue').textContent()==='월수금');
 check('code is above name and both remain readable',await page.locator('#detail .detailHead').evaluate(n=>{const a=n.querySelector('.code').getBoundingClientRect(),b=n.querySelector('.storeName').getBoundingClientRect();return a.bottom<=b.top&&b.width>30}));
 check('private metadata and authenticated tel action are retained',await page.locator('.dotDetailFacts').getAttribute('data-source-basis')==='CURRENT_CUSTOMER_LOOKUP'&&await page.locator('#detailDriver a').getAttribute('href')==='tel:01012345678');
 check('history and protected information follow address fields',await page.locator('#detail').evaluate(n=>Boolean(n.querySelector('.dotDetailFacts').compareDocumentPosition(n.querySelector('.staffActions'))&Node.DOCUMENT_POSITION_FOLLOWING))&&await page.locator('#staffHistory').isVisible()&&await page.locator('#staffNotes').isVisible());
 check('verified coordinate success text is omitted from selected card',await page.locator('#detail .coordinateEvidence').count()===0);
 for(const width of [1920,1366,768,390]){
  await page.setViewportSize({width,height:900});
  check(width+'px detail stays inside map without horizontal overlap',await page.locator('#detailSection').evaluate(n=>{const p=n.getBoundingClientRect(),m=document.querySelector('.maparea').getBoundingClientRect();return p.left>=m.left&&p.right<=m.right+1&&p.top>=m.top&&p.bottom<=m.bottom+1&&document.documentElement.scrollWidth<=innerWidth+1}));
  await page.screenshot({path:path.join(output,'detail-'+width+'.png')});
 }
 await page.setViewportSize({width:1366,height:900});
 for(const [code,reason] of [['S990001','empty Customer pattern'],['S990002','unconfirmed text'],['S990003','non-allowlisted source'],['S990004','unconfirmed source location']]){
  await page.evaluate(code=>MapUiLocalBridge.selectNavigationStore(code),code);
  await page.waitForFunction(()=>document.querySelector('#detailDriver a')?.getAttribute('href')==='tel:01012345678');
  await page.waitForFunction(expected=>document.querySelector('.dotDetailFacts')?.dataset.sourceBasis===expected,code==='S990003'?'STORED_DAY':'CURRENT_CUSTOMER_LOOKUP');
  check('empty detail address is hidden for '+code,!await page.locator('#detailAddressLabel').isVisible()&&!await page.locator('#detailAddressValue').isVisible());
  check(reason+' hides delivery weekdays without a placeholder',!await page.locator('#detailDeliveryDaysLabel').isVisible()&&!await page.locator('#detailDeliveryDaysValue').isVisible());
 }
 await page.locator('#modeDaily').click();await page.waitForFunction(()=>MapUiLocalBridge.state.mode==='DATE_ROUTE');check('DATE_ROUTE reuses the same folded editor',await page.locator('#waypointPlanner').count()===1&&await page.locator('#waypointPlanner>summary').isVisible()&&await page.locator('#waypointPlanner').getAttribute('open')===null);await page.locator('#waypointPlanner>summary').click();check('DATE_ROUTE route fields open and share Kakao and result controls',await page.locator('#plannerStart').isVisible()&&await page.locator('#waypointPlanner #navKakaoDirections').count()===1&&await page.locator('#waypointPlanner #navigationSummary').count()===1);
 await page.locator('#modePeriod').click();await page.waitForFunction(()=>MapUiLocalBridge.state.mode==='BASE_60D');check('returning to BASE keeps the same editor reachable',await page.locator('#waypointPlanner').count()===1&&await page.locator('#waypointPlanner>summary').isVisible());
 await page.evaluate(()=>window.dispatchEvent(new Event('map-staff-signed-out')));check('signout purges selected driver contact',await page.locator('#detailDriver a').count()===0);
 check('only isolated local requests and no page errors',external.length===0&&errors.length===0);
 const result={pass:checks.length,fail:0,scope:'LOCAL_EDGE_SYNTHETIC_SHELL_DETAIL_NOT_PRODUCTION',checks,externalCalls:external.length,errors,artifacts:output};fs.writeFileSync(path.join(output,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
