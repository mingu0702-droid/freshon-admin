import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
const {chromium}=await import(process.env.OPSMAP_TEST_PLAYWRIGHT_MODULE||'playwright');
// Real existing shell/editor/navigation controllers, synthetic rows and SDK only.
const root=path.resolve('public/opsmap'),output=fs.mkdtempSync(path.join(os.tmpdir(),'opsmap-r11-shell-detail-'));
const rows=Array.from({length:32},(_,i)=>({customerCode:'S990'+String(i).padStart(3,'0'),customerName:'합성 매장 '+i,address:'합성주소 '+i,vehicle:i<20?'101':i<24?'2':i<26?'10':i<29?'501':'721',lat:37+i*.001,lng:127+i*.001,lastDeliveryDate:'2026-11-02'}));
// Two separate customers at one shop-in-shop coordinate remain two visits.
rows[1].lat=rows[0].lat;rows[1].lng=rows[0].lng;
const requests=[],external=[],errors=[],checks=[],version='e'.repeat(64);
const scripts=['phase2b-ui-helpers.js','map-period-ui.js','map-view-policy.js','road-route-ui.js','new-area-requests.js','manual-waypoints.js','kakao-directions-adapter.js','manual-road-route-ui.js','map-dot-ui.js','map-driver-contact.js','map-phase2b-runtime.js','map-approved-shell-candidate.js','navigation-ui.js'];
const fixture=`window.VEHICLE_AREA_DATA={vehicles:[{vehicle:'11',group:'osan',customers:[]},{vehicle:'101',group:'osan',customers:[]},{vehicle:'2',group:'osan',customers:[]}]};window.KAKAO_MAP_CONFIG={allowExternalAddressLookup:false};
document.body.dataset.mapStaffState='authenticated';window.OPSMAP_DRIVER_CONTACT_ENABLED=true;window.MapStaffEntry={status(){},registerPurge(){}};window.MapTerritoryUi={renderForSelection(){},toggle(){}};
class Coord{constructor(lat,lng){this.lat=lat;this.lng=lng}getLat(){return this.lat}getLng(){return this.lng}}
class Bounds{extend(){}getSouthWest(){return new Coord(33,124)}getNorthEast(){return new Coord(39.5,132)}}
class FixtureMap{constructor(el,o){this.el=el;this.center=o.center;this.level=5}getCenter(){return this.center}setCenter(p){this.center=p}panTo(p){this.center=p}getLevel(){return this.level}setLevel(v){this.level=v}getBounds(){return new Bounds()}setBounds(){}relayout(){}getProjection(){return{containerPointFromCoords:p=>({x:350,y:300}),coordsFromContainerPoint:p=>new Coord(37,127)}}}
class Overlay{constructor(o){this.opts=o}setMap(m){this.opts.content?.remove();if(m&&this.opts.content)m.el.append(this.opts.content)}}
window.kakao={maps:{LatLng:Coord,LatLngBounds:Bounds,Map:FixtureMap,CustomOverlay:Overlay,Polygon:Overlay,Polyline:Overlay,event:{addListener(){},removeListener(){}}}};window.KakaoMapsAdapter={ready:()=>Promise.resolve(),reset(){}};`;
let html=fs.readFileSync(path.join(root,'map-phase2b-preview.html'),'utf8').replace(/<script\b[\s\S]*?<\/script>/gi,'');
html=html.replace('</body>','<script>'+fixture+'</script><script type="module">import "/opsmap/fixed-delivery-weekdays.mjs"; for (const file of '+JSON.stringify(scripts)+') { await new Promise((resolve,reject)=>{const script=document.createElement("script");script.onload=resolve;script.onerror=reject;script.src=file;document.body.append(script);}); } MapDotUi.mount();</script></body>');
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname.startsWith('/api/')){
  requests.push({path:u.pathname,method:req.method});let data={data:[],meta:{}};
  if(u.pathname.endsWith('/snapshot'))data={data:rows,meta:{complete:true,latestDate:'2026-11-02',startDate:'2026-09-04',endDate:'2026-11-02'}};
  if(u.pathname.endsWith('/base-vehicles'))data={ok:true,data:rows.map((r,index)=>({customerCode:r.customerCode,baseVehicle:r.vehicle,baseVehicleState:'VERIFIED_MASTER',baseVehicleGroup:r.vehicle==='501'?'yeongnam':r.vehicle==='721'?'honam':'osan',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:version,baseVehicleCheckedAt:'2026-11-02T00:00:00.000Z',baseVehicleStale:false,...(index===0?{weekdays:{Mon:'101',Wed:'101',Sun:'101'}}:{})})),meta:{version,checkedAt:'2026-11-02T00:00:00.000Z',basis:'FIXED_DISPATCH_PRIMARY',stale:false}};
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
 check('legacy itinerary is folded after the approved shell mounts',await page.locator('#runListTool').getAttribute('open')===null);
 check('BASE route editor summary is visible and initially folded',await page.locator('#waypointPlanner>summary').isVisible()&&await page.locator('#waypointPlanner').getAttribute('open')===null&&!await page.locator('#plannerStart').isVisible());
 await page.locator('#waypointPlanner>summary').click();check('BASE route editor opens the same searchable route fields',await page.locator('#plannerStart').isVisible()&&await page.locator('#plannerEnd').isVisible()&&await page.locator('#waypointPlanner').count()===1);await page.evaluate(()=>MapNavigationEditor.replacePoints(['S990000','S990001']));check('BASE can configure endpoints and open the integrated Kakao link',await page.locator('#plannerStart').inputValue()==='S990000'&&await page.locator('#plannerEnd').inputValue()==='S990001'&&await page.locator('#waypointPlanner #navKakaoLinks a').isVisible());await page.evaluate(()=>MapNavigationEditor.clear());await page.locator('#waypointPlanner>summary').click();
 check('search, centers, picker button, two tabs and map stay available',await page.locator('#query').isVisible()&&await page.locator('#centers').isVisible()&&await page.locator('#baseVehiclePicker>summary').isVisible()&&await page.locator('#approvedSiteHeader .tab:visible').count()===2&&await page.locator('#map').isVisible());
 await page.locator('#togglePeriodList').click();check('store list opens only by explicit action',await page.locator('#periodStoreList').isVisible()&&await page.locator('#periodStoreList [data-period-store]:visible').count()===5);await page.locator('#togglePeriodList').click();
 await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length===32&&document.querySelector('#vehicleList input[value="721"]')?.closest('label').dataset.group==='honam');
 await page.locator('#baseVehiclePicker>summary').click();
 assert.deepEqual(await page.locator('#vehicleList input').evaluateAll(nodes=>nodes.map(n=>n.value)),['2','10','11','101','501','721']);checks.push('center groups retain numeric vehicle order including newly discovered vehicles');
 assert.deepEqual(await page.locator('.vehicleGroupHeading').allTextContents(),['오산','영남','호남']);checks.push('three dispatch centers have separate vehicle groups');
 await page.locator('[data-source-center="osan"]').click();await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length===26);
 await page.locator('#vehicleList input[value="2"]').check();await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length===4);
 await page.locator('#vehicleList input[value="10"]').check();await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length===6);
 check('initial and dynamically added checkboxes preserve selected center and display only both vehicles',await page.evaluate(()=>MapUiLocalBridge.state.centerFilter==='osan'&&MapUiLocalBridge.state.currentRows.every(r=>['2','10'].includes(r.baseVehicle))));
 await page.locator('#vehicleList input[value="10"]').uncheck();await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length===4);
 await page.locator('#vehicleList input[value="2"]').uncheck();await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length===26);
 check('unchecking the last vehicle restores the selected center map',await page.evaluate(()=>MapUiLocalBridge.state.centerFilter==='osan'&&MapUiLocalBridge.state.selectedVehicles.length===0));
 await page.locator('#vehicleQuery').fill('10');await page.locator('#vehicleQuery').press('Enter');await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length===2);
 check('vehicle search Enter preserves center and selects the numeric result',await page.evaluate(()=>MapUiLocalBridge.state.centerFilter==='osan'&&MapUiLocalBridge.state.selectedVehicles.join(',')==='10'));
 await page.locator('#query').fill('합성 검색 유지');await page.locator('#modePeriod').click();await page.waitForFunction(()=>MapUiLocalBridge.isDataReady()&&MapUiLocalBridge.state.currentRows.length===2);
 check('reopening the current map retains center, vehicle and search text',await page.evaluate(()=>MapUiLocalBridge.state.centerFilter==='osan'&&MapUiLocalBridge.state.selectedVehicles.join(',')==='10'&&document.querySelector('#query').value==='합성 검색 유지'));
 await page.locator('#clearVehicles').click();await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length===26);
 check('clear selection restores all center stores and removes every selected checkbox',await page.locator('#vehicleList input:checked').count()===0&&await page.evaluate(()=>MapUiLocalBridge.state.centerFilter==='osan'));
 await page.locator('#vehicleQuery').fill('2');await page.locator('#vehicleQuery').press('Enter');await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length===4);
 await page.locator('[data-remove-vehicle="2"]').evaluate(node=>node.click());await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length===26);
 check('last map chip restores the center map',await page.evaluate(()=>MapUiLocalBridge.state.selectedVehicles.length===0));
 await page.locator('#selectAllVehicles').click();await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length===4);
 check('select all checks the current search results without resetting the center',await page.evaluate(()=>MapUiLocalBridge.state.centerFilter==='osan'&&MapUiLocalBridge.state.selectedVehicles.join(',')==='2'));
 await page.locator('[data-source-center="all"]').click();await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length===32);
 await page.locator('#vehicleQuery').fill('');await page.locator('#query').fill('');await page.locator('#baseVehiclePicker>summary').click();
 await page.waitForFunction(()=>MapUiLocalBridge.navigationStores().some(r=>r.customerCode==='S990000'&&r.baseVehicleState==='VERIFIED_MASTER'));await page.evaluate(()=>MapUiLocalBridge.selectNavigationStore('S990000'));await page.waitForFunction(()=>document.querySelector('#detailAddressValue')?.textContent==='합성 상세주소 2층'&&document.querySelector('#detailDriver a')?.getAttribute('href')==='tel:01012345678');
 check('selected card keeps folded store list folded',!await page.locator('#periodStoreList').isVisible());
 await page.locator('#modePeriod').click();check('reclicking the active map tab preserves the selected customer card',await page.evaluate(()=>MapUiLocalBridge.state.selected?.customerCode==='S990000')&&await page.locator('#detailSection.open').count()===1);
 const labels=await page.locator('.dotDetailFacts dt:visible').allTextContents();assert.deepEqual(labels,['담당 센터','기준호차','배송요일','담당 기사','주소','상세주소']);checks.push('detail fact order is center, vehicle, actual weekdays, driver, address and detail address');
 check('only fixed Monday to Saturday assignments are displayed',await page.locator('#detailDeliveryDaysValue').textContent()==='월 · 수');
 check('code is above name and both remain readable',await page.locator('#detail .detailHead').evaluate(n=>{const a=n.querySelector('.code').getBoundingClientRect(),b=n.querySelector('.storeName').getBoundingClientRect();return a.bottom<=b.top&&b.width>30}));
 check('private metadata and authenticated tel action are retained',await page.locator('.dotDetailFacts').getAttribute('data-source-basis')==='CURRENT_CUSTOMER_LOOKUP'&&await page.locator('#detailDriver a').getAttribute('href')==='tel:01012345678');
 check('history and protected information follow address fields',await page.locator('#detail').evaluate(n=>Boolean(n.querySelector('.dotDetailFacts').compareDocumentPosition(n.querySelector('.staffActions'))&Node.DOCUMENT_POSITION_FOLLOWING))&&await page.locator('#staffHistory').isVisible()&&await page.locator('#staffNotes').isVisible());
 check('protected delivery information precedes driver history',await page.locator('#detail').evaluate(n=>Boolean(n.querySelector('#staffNotes').compareDocumentPosition(n.querySelector('#staffHistory'))&Node.DOCUMENT_POSITION_FOLLOWING)));
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
