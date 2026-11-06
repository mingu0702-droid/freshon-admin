import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';

// Local synthetic fixtures only: no authentication, source, geocoding or remote SDK.
const root=path.resolve('public/opsmap'),output=fs.mkdtempSync(path.join(os.tmpdir(),'opsmap-vehicle-picker-'));
const vehicles=[['203','osan'],['122','osan'],['202-1','osan'],['101','osan'],['202','osan'],['용10','osan'],['용2','osan'],['310','yeongnam'],['301','yeongnam'],['410','honam'],['미확인','']].map(([vehicle,group])=>({vehicle,group,customers:[]}));
const stores=[
 ['101','서울특별시 강남구 합성로 1'],['101','서울 서초구 합성길 2'],['101','서울 송파구 합성길 3'],
 ['101','서울 노원구 합성길 4'],['101','경기 용인시 합성길 5'],['101','경기 오산시 합성길 6'],
 ['101','전남광주통합특별시 순천시 합성길 21'],['101','전남광주통합특별시 광주광역시 광산구 합성길 22'],
 ['101','인천광역시 제물포구 합성길 23'],['101','경기 고양시 합성길 24'],
 ['101','서울 강남구역빌딩 합성로 7'],['122','서울 동작구 합성길 8'],['202','경기 광명시 합성로 9'],
 ['301','대구 수성구 합성로 10'],['310','부산 동구 합성로 11'],['410','전북특별자치도 전주시 합성로 12'],
 ['203','서울 중구 합성로 13']
];
const rows=stores.map(([vehicle,address],i)=>({customerCode:'S9800'+String(i+1).padStart(2,'0'),customerName:'SYNTHETIC_ONLY_'+i,address,vehicle,baseVehicle:vehicle,lat:35+i*.15,lng:127+i*.04,lastDeliveryDate:'2026-10-20'}));
const version='f'.repeat(64),requests=[],external=[],errors=[],checks=[];
const checkedAt='2026-10-20T00:00:00.000Z',basis='FIXED_DISPATCH_PRIMARY';
const scripts=['phase2b-ui-helpers.js','map-period-ui.js','map-view-policy.js','road-route-ui.js','new-area-requests.js','manual-waypoints.js','manual-road-route-ui.js','map-dot-ui.js','vehicle-picker-regions.js','map-phase2b-runtime.js','map-approved-shell-candidate.js'];
const fixture=`window.VEHICLE_AREA_DATA=${JSON.stringify({vehicles})};window.KAKAO_MAP_CONFIG={allowExternalAddressLookup:false};
document.body.dataset.mapStaffState='authenticated';
window.MapStaffEntry={status(){},registerPurge(){}};window.MapTerritoryUi={renderForSelection(){window.territoryRenders=(window.territoryRenders||0)+1},toggle(){}};
class Coord{constructor(lat,lng){this.lat=lat;this.lng=lng}getLat(){return this.lat}getLng(){return this.lng}}
class Bounds{extend(){}getSouthWest(){return new Coord(33,124)}getNorthEast(){return new Coord(39.5,132)}}
class FixtureMap{constructor(el,opts){this.el=el;this.center=opts.center;this.level=5}getCenter(){return this.center}setCenter(p){this.center=p}panTo(p){this.center=p}getLevel(){return this.level}setLevel(v){this.level=v}getBounds(){return new Bounds()}setBounds(){}relayout(){}getProjection(){return {containerPointFromCoords:p=>({x:300+(p.lng-127)*100,y:300+(p.lat-36)*30}),coordsFromContainerPoint:p=>new Coord(36,127)}}}
class Overlay{constructor(opts){this.opts=opts}setMap(map){if(this.opts.content){this.opts.content.remove();if(map)map.el.append(this.opts.content)}}}
window.kakao={maps:{LatLng:Coord,LatLngBounds:Bounds,Map:FixtureMap,CustomOverlay:Overlay,Polygon:Overlay,Polyline:Overlay,event:{addListener(){},removeListener(){}}}};window.KakaoMapsAdapter={ready:()=>Promise.resolve(),reset(){}};`;
let html=fs.readFileSync(path.join(root,'map-phase2b-preview.html'),'utf8').replace(/<script\b[\s\S]*?<\/script>/gi,'');
html=html.replace('</body>','<script>'+fixture+'</script>'+scripts.map(file=>'<script src="'+file+'"></script>').join('')+'</body>');
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname.startsWith('/api/')){
  requests.push(u.pathname);let data={data:[],meta:{}};
  if(u.pathname.endsWith('/snapshot'))data={data:rows,meta:{complete:true,latestDate:'2026-10-20',startDate:'2026-08-01',endDate:'2026-10-20'}};
  else if(u.pathname.endsWith('/base-vehicles'))data={ok:true,data:rows.map(r=>({customerCode:r.customerCode,baseVehicle:r.vehicle,baseVehicleGroup:vehicles.find(v=>v.vehicle===r.vehicle).group,baseVehicleState:r.vehicle==='203'?'CONFLICT':'VERIFIED_MASTER',baseVehicleSource:basis,baseVehicleVersion:version,baseVehicleCheckedAt:checkedAt,baseVehicleStale:false})),meta:{version,basis,checkedAt,stale:false}};
  else if(u.pathname.endsWith('/assignments')){const date=u.searchParams.get('date');data={data:[...rows.map(r=>({...r,deliveryDate:date})),{customerCode:'S980099',customerName:'SYNTHETIC_NEW_103',address:'인천 영종구 합성로 12',vehicle:'103',lat:36,lng:127,deliveryDate:date}],meta:{complete:true,date,reviewOnly:true}};}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(data));return;
 }
 if(u.pathname==='/opsmap/'||u.pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
 const file=path.join(root,path.basename(u.pathname));if(fs.existsSync(file)){res.setHeader('content-type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'application/octet-stream');res.end(fs.readFileSync(file));}else{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.OPSMAP_TEST_CHROMIUM||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1920,height:1080}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(route.request().url());return route.abort();}return route.continue();});
 await page.goto(origin+'/opsmap/');await page.waitForFunction(()=>window.MapUiLocalBridge?.isDataReady());
 const check=(name,condition)=>{assert(condition,name);checks.push(name);};
 await page.waitForFunction(()=>document.querySelector('#vehicleList .vehicleItem')?.dataset.listGroup==='osan');
 const query=page.locator('#vehicleQuery');check('single search is initially inside folded picker',await query.count()===1&&!await query.isVisible()&&await page.locator('#baseVehiclePicker').getAttribute('open')===null);
 const summary=page.locator('#baseVehiclePicker>summary');
 await summary.click({position:{x:10,y:10}});check('single visible search below vehicle heading',await query.isVisible()&&await query.getAttribute('placeholder')==='호차번호 · 담당 지역 검색');
 const values=()=>page.locator('#vehicleList .vehicleItem:visible input').evaluateAll(inputs=>inputs.map(i=>i.value));
 const input=vehicle=>page.locator(`#vehicleList input[value="${vehicle}"]`);
 const area=vehicle=>input(vehicle).locator('..').locator('.vehicleArea');
 const selected=()=>page.evaluate(()=>MapUiLocalBridge.state.selectedVehicles);
 const chips=page.locator('#vehicleQuickFilter');
 await page.waitForFunction(()=>document.querySelector('#vehicleList input[value="101"]').parentElement.textContent.includes('강남구'));
 assert.deepEqual(await values(),['101','122','202','202-1','203','용2','용10','301','310','410','미확인']);checks.push('center groups, numeric and hired numeric order');
 check('verified list regions and invalid road/building prefixes',await area('101').innerText().then(t=>t.includes('강남구')&&t.includes('서초구')&&!t.includes('빌딩'))&&await area('203').innerText()==='담당 지역 미확인');
 await query.fill('용인시');assert.deepEqual(await values(),['101']);await query.fill('202');assert.deepEqual(await values(),['202','202-1']);checks.push('number and region query update immediately');
 await input('202').click();await query.fill('');check('clearing search preserves selection',await input('202').isChecked());
 await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length===1&&MapUiLocalBridge.state.overlays.length===1);
 check('selection still drives map pins and territory rendering',await page.evaluate(()=>MapUiLocalBridge.state.currentRows[0].vehicle==='202'&&window.territoryRenders>0));
 await input('202').click();check('same vehicle deselects and returns to full map',!(await selected()).length&&!await chips.isVisible()&&await page.evaluate(()=>MapUiLocalBridge.state.currentRows.length>2));
 await input('101').click();await input('122').click();assert.deepEqual(await selected(),['101','122']);checks.push('101 and 122 multiple selection');
 await summary.click({position:{x:10,y:10}});check('collapsed picker keeps map controls accessible',!await query.isVisible()&&await chips.isVisible());
 await page.locator('#vehicleQuickChips [data-remove-vehicle="101"]').click();assert.deepEqual(await selected(),['122']);
 await page.locator('#vehicleQuickChips [data-remove-vehicle="122"]').click();check('last chip restores all-map policy',!(await selected()).length&&!await chips.isVisible());
 await summary.click({position:{x:10,y:10}});await input('101').click();await input('122').click();
 await query.fill('999999');assert.deepEqual(await values(),[]);check('no-result query hides empty group headings without changing selection',await page.locator('#vehicleList .vehicleGroupHeading:visible').count()===0&&await page.evaluate(()=>MapUiLocalBridge.state.selectedVehicles.length===2));await query.fill('');
 await query.fill('202');await page.locator('#selectAllVehicles').click();assert.deepEqual(await selected(),['202','202-1']);checks.push('select all applies current search list');
 await page.locator('#clearVehicles').click();check('clear removes the vehicle filter',!(await selected()).length&&await page.evaluate(()=>MapUiLocalBridge.state.currentRows.length>2));
 await query.fill('101');await query.press('Enter');check('Enter applies visible result',await selected().then(v=>v.join(',')==='101'));
 await page.evaluate(()=>{
  const state=MapUiLocalBridge.state;
  state.userMovedMap=true;state.map.setLevel(4);
  state.selected=state.currentRows[0];document.querySelector('#query').value='검색어 유지';
 });
 await page.locator('#clearMapVehicleFilter').click();
 check('map-wide clear retains zoom, search and a visible selection',!(await selected()).length&&await page.evaluate(()=>{
  const state=MapUiLocalBridge.state;
  return state.map.getLevel()===4&&state.selected?.customerCode==='S980001'&&document.querySelector('#query').value==='검색어 유지';
 }));
 await query.fill('');
 await page.locator('[data-source-center="yeongnam"]').click();await query.fill('30');assert.deepEqual(await values(),['301']);await query.fill('');assert.deepEqual(await values(),['301','310']);checks.push('search and center filter compose');
 await page.locator('[data-source-center="all"]').click();await page.evaluate(()=>{MapUiLocalBridge.state.mode='DATE_ROUTE';return MapUiLocalBridge.submitDailyQuery('2026-10-21','2026-10-21')});
 await page.locator('#chooseRoutes').click();check('same search visible above daily checks',await query.isVisible()&&await query.evaluate(i=>i.nextElementSibling.id==='vehicleList'));
 await query.fill('영종구');assert.deepEqual(await values(),['103']);await input('103').check();await query.fill('');check('daily vehicle shows region from dated deliveries',await area('103').innerText()==='영종구');
 check('unknown date vehicle sorted in unknown group',await page.locator('#vehicleList input[value="103"]').evaluate(i=>i.parentElement.dataset.listGroup==='unknown'));
 await page.locator('#closeRoutes').click();await page.evaluate(()=>MapUiLocalBridge.submitDailyQuery('2026-10-22','2026-10-22'));await page.locator('#chooseRoutes').click();
 check('date changes preserve one checkbox per vehicle',await page.locator('#vehicleList input[value="103"]').count()===1);
 check('date reorder preserves checked selection',await page.locator('#vehicleList input[value="103"]').isChecked());
 await page.locator('#closeRoutes').click();await page.locator('#modePeriod').click();await page.waitForFunction(()=>MapUiLocalBridge.state.mode==='BASE_60D');
 await page.waitForFunction(()=>document.querySelector('#vehicleList input[value="101"]').parentElement.textContent.includes('강남구'));
 for(const width of [1920,1366,390]){
  await page.setViewportSize({width,height:844});
  await query.fill('101');await query.scrollIntoViewIfNeeded();
  if(!await input('101').isChecked())await input('101').click();
  const layout=await area('101').evaluate(el=>({overflow:el.scrollWidth>el.clientWidth,ellipsis:getComputedStyle(el).textOverflow,height:el.offsetHeight,lineHeight:parseFloat(getComputedStyle(el).lineHeight)}));
  check(`row text wraps without clipping at ${width}`,!layout.overflow&&layout.ellipsis!=='ellipsis'&&layout.height>layout.lineHeight);
  check(`map chip available at ${width}`,await chips.isVisible()&&await chips.locator('button[data-remove-vehicle="101"]').isEnabled());
  await page.screenshot({path:path.join(output,`after-fixture-${width}.png`),fullPage:true});
 }
 check('no page errors',errors.length===0);check('remote/auth/geocoding/source calls remain zero',external.length===0&&requests.every(p=>!/auth|geocod|source|hub|private\//i.test(p)));
 const result={scope:'LOCAL_EDGE_SYNTHETIC_MAP_NOT_PRODUCTION',output,checks,errors,externalCalls:external.length,requests};fs.writeFileSync(path.join(output,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
