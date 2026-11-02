import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {chromium} from 'playwright';

// Local synthetic fixtures only: no authentication, source, geocoding or remote SDK.
const root=path.resolve('public/opsmap'),output=path.resolve('reports/r9-vehicles');fs.mkdirSync(output,{recursive:true});
const vehicles=[['203','osan'],['102','osan'],['202-1','osan'],['101','osan'],['202','osan'],['용10','osan'],['용2','osan'],['310','yeongnam'],['301','yeongnam'],['410','honam'],['미확인','']].map(([vehicle,group])=>({vehicle,group,customers:[]}));
const rows=vehicles.filter(v=>/^\d/.test(v.vehicle)).map((v,i)=>({customerCode:'S9800'+String(i+1).padStart(2,'0'),customerName:'SYNTHETIC_ONLY_'+v.vehicle,address:'합성주소 '+i,vehicle:v.vehicle,baseVehicle:v.vehicle,lat:35+i*.15,lng:127+i*.04,lastDeliveryDate:'2026-10-20'}));
const version='f'.repeat(64),requests=[],external=[],errors=[],checks=[];
const scripts=['phase2b-ui-helpers.js','map-period-ui.js','map-view-policy.js','road-route-ui.js','new-area-requests.js','manual-waypoints.js','manual-road-route-ui.js','map-dot-ui.js','map-phase2b-runtime.js','map-approved-shell-candidate.js'];
const fixture=`window.VEHICLE_AREA_DATA=${JSON.stringify({vehicles})};window.KAKAO_MAP_CONFIG={allowExternalAddressLookup:false};
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
  else if(u.pathname.endsWith('/base-vehicles'))data={ok:true,data:rows.map(r=>({customerCode:r.customerCode,baseVehicle:r.vehicle,baseVehicleGroup:vehicles.find(v=>v.vehicle===r.vehicle).group,baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:version,baseVehicleStale:false})),meta:{version,stale:false}};
  else if(u.pathname.endsWith('/assignments')){const date=u.searchParams.get('date');data={data:[...rows,{customerCode:'S980099',customerName:'SYNTHETIC_NEW_103',vehicle:'103',lat:36,lng:127,deliveryDate:date}],meta:{complete:true,date,reviewOnly:true}};}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(data));return;
 }
 if(u.pathname==='/opsmap/'||u.pathname==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
 const file=path.join(root,path.basename(u.pathname));if(fs.existsSync(file)){res.setHeader('content-type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'application/octet-stream');res.end(fs.readFileSync(file));}else{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.OPSMAP_TEST_CHROMIUM||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(route.request().url());return route.abort();}return route.continue();});
 await page.goto(origin+'/opsmap/');await page.waitForFunction(()=>window.MapUiLocalBridge?.isDataReady());
 const check=(name,condition)=>{assert(condition,name);checks.push(name);};
 await page.waitForFunction(()=>document.querySelector('#vehicleList .vehicleItem')?.dataset.listGroup==='osan');
 const query=page.locator('#vehicleQuery');check('single visible search below vehicle heading',await query.count()===1&&await query.isVisible()&&await query.getAttribute('placeholder')==='호차번호 검색');
 const values=()=>page.locator('#vehicleList .vehicleItem:visible input').evaluateAll(inputs=>inputs.map(i=>i.value));
 assert.deepEqual(await values(),['101','102','202','202-1','203','용2','용10','301','310','410','미확인']);checks.push('center groups, numeric and hired numeric order');
 await page.locator('#baseVehiclePicker>summary').click({position:{x:10,y:10}});check('search remains visible when picker folded',await query.isVisible());
 await query.fill('202');check('typing does not toggle folded picker',await page.locator('#baseVehiclePicker').getAttribute('open')===null);
 await page.locator('#baseVehiclePicker>summary').click({position:{x:10,y:10}});assert.deepEqual(await values(),['202','202-1']);checks.push('partial query updates immediately');
 await page.locator('#vehicleList input[value="202"]').check();await query.fill('');check('clearing search preserves selection',await page.locator('#vehicleList input[value="202"]').isChecked());
 await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length===1&&MapUiLocalBridge.state.overlays.length===1);
 check('selection still drives map pins and territory rendering',await page.evaluate(()=>MapUiLocalBridge.state.currentRows[0].vehicle==='202'&&window.territoryRenders>0));
 await page.locator('#vehicleList input[value="101"]').check();check('multiple selections retained',await page.evaluate(()=>MapUiLocalBridge.state.selectedVehicles.length===2));
 await query.fill('999999');assert.deepEqual(await values(),[]);check('no-result query hides empty group headings without changing selection',await page.locator('#vehicleList .vehicleGroupHeading:visible').count()===0&&await page.evaluate(()=>MapUiLocalBridge.state.selectedVehicles.length===2));await query.fill('');
 await query.fill('101');await query.press('Enter');check('existing Enter single selection still updates map',await page.evaluate(()=>MapUiLocalBridge.state.selectedVehicles.join(',')==='101'&&MapUiLocalBridge.state.currentRows[0]?.vehicle==='101'));await query.fill('');
 await page.locator('#clearVehicles').click();check('clear existing selection',await page.evaluate(()=>MapUiLocalBridge.state.selectedVehicles.length===0&&MapUiLocalBridge.state.currentRows.length===0));
 await page.locator('#selectAllVehicles').click();await page.waitForFunction(()=>MapUiLocalBridge.state.currentRows.length>2);checks.push('existing all vehicles action');
 await page.locator('[data-source-center="yeongnam"]').click();await query.fill('30');assert.deepEqual(await values(),['301']);await query.fill('');assert.deepEqual(await values(),['301','310']);checks.push('search and center filter compose');
 await page.locator('[data-source-center="all"]').click();await page.evaluate(()=>{MapUiLocalBridge.state.mode='DATE_ROUTE';return MapUiLocalBridge.submitDailyQuery('2026-10-21','2026-10-21')});
 await page.locator('#chooseRoutes').click();check('same search visible above daily checks',await query.isVisible()&&await query.evaluate(i=>i.nextElementSibling.id==='vehicleList'));
 await query.fill('103');assert.deepEqual(await values(),['103']);await page.locator('#vehicleList input[value="103"]').check();await query.fill('');check('new date vehicle is searchable without repeated wording',await page.locator('#vehicleList .vehicleItem').filter({has:page.locator('input[value="103"]')}).innerText().then(v=>!v.includes('기준일 편성')));
 check('unknown date vehicle sorted in unknown group',await page.locator('#vehicleList input[value="103"]').evaluate(i=>i.parentElement.dataset.listGroup==='unknown'));
 await page.locator('#closeRoutes').click();await page.evaluate(()=>MapUiLocalBridge.submitDailyQuery('2026-10-22','2026-10-22'));await page.locator('#chooseRoutes').click();
 check('date changes preserve one checkbox per vehicle',await page.locator('#vehicleList input[value="103"]').count()===1);
 check('date reorder preserves checked selection',await page.locator('#vehicleList input[value="103"]').isChecked());
 await page.screenshot({path:path.join(output,'desktop.png')});await page.locator('#closeRoutes').click();await page.locator('#modePeriod').click();await page.waitForFunction(()=>MapUiLocalBridge.state.mode==='BASE_60D');
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(100);await query.fill('202');await query.scrollIntoViewIfNeeded();check('mobile search visible with one shared input',await query.isVisible()&&await query.count()===1);await page.screenshot({path:path.join(output,'mobile.png')});
 await page.setViewportSize({width:1440,height:1000});await query.fill('');await query.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'general-desktop.png')});
 check('no page errors',errors.length===0);check('remote/auth/geocoding/source calls remain zero',external.length===0&&requests.every(p=>!/auth|geocod|source|hub|private\//i.test(p)));
 const result={scope:'LOCAL_EDGE_SYNTHETIC_MAP_NOT_PRODUCTION',checks,errors,externalCalls:external.length,requests};fs.writeFileSync(path.join(output,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
