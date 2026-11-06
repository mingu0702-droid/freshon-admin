import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {createRoadRouteService} from '../src/opsmap-abc/roadRouteService.js';
const {chromium}=await import(process.env.OPSMAP_TEST_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve('public/opsmap'),output=process.env.OPSMAP_R14_DIRECTIONS_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'opsmap-r14-directions-'));
fs.mkdirSync(output,{recursive:true});
const rows=Array.from({length:8},(_,i)=>({customerCode:'SYNTHETIC_'+i,customerName:'합성 매장 '+i,address:'합성주소 '+i,vehicle:'101',order:8-i,lat:37+i*.001,lng:127+i*.001,lastDeliveryDate:'2026-11-02'}));
const dailyRows=rows.slice(0,4);
const requests=[],providerRequests=[],reservations=[],external=[],errors=[],checks=[];
let budgetDepleted=false;
const budget={
 durable:true,
 status:async()=>({durable:true,scope:'CUMULATIVE_APPROVED_ACCOUNT',remaining:budgetDepleted?0:30000-reservations.length}),
 async reserve({api}){
  if(budgetDepleted)throw Object.assign(Error('QUOTA_EXCEEDED'),{code:'QUOTA_EXCEEDED'});
  reservations.push(api);
 }
};
const service=createRoadRouteService({env:{OPSMAP_ROAD_ROUTE_ENABLED:'1',KAKAO_REST_API_KEY:'synthetic-only'},requireDurableBudget:true,budget,fetchImpl:async(url,options)=>{
 const request=new URL(url);
 assert.equal(request.origin,'https://apis-navi.kakaomobility.com');
 let points;
 if(options.method==='GET'){
  assert.equal(request.pathname,'/v1/directions');
  points=[request.searchParams.get('origin'),...(request.searchParams.get('waypoints')||'').split('|').filter(Boolean),request.searchParams.get('destination')].map(value=>value.split(',').map(Number));
 }else{
  assert.equal(options.method,'POST');
  assert.equal(request.pathname,'/v1/waypoints/directions');
  const body=JSON.parse(options.body);
  points=[body.origin,...body.waypoints,body.destination].map(p=>[p.x,p.y]);
 }
 providerRequests.push({method:options.method,points});
 const sections=points.slice(0,-1).map((p,i)=>({distance:100,duration:60,roads:[{vertexes:[...p,p[0]+.0001,p[1]+.0002,...points[i+1]]}]}));
 return new Response(JSON.stringify({routes:[{result_code:0,summary:{distance:sections.length*100,duration:sections.length*60},sections}]}),{headers:{'content-type':'application/json'}});
}});
const scripts=['phase2b-ui-helpers.js','map-period-ui.js','map-view-policy.js','road-route-ui.js','new-area-requests.js','manual-waypoints.js','kakao-directions-adapter.js','manual-road-route-ui.js','map-dot-ui.js','map-phase2b-runtime.js','map-approved-shell-candidate.js','navigation-ui.js'];
const fixture=`window.VEHICLE_AREA_DATA={vehicles:[{vehicle:'101',group:'osan',customers:[]}]};window.KAKAO_MAP_CONFIG={allowExternalAddressLookup:false,centers:[{id:'osan',verified:true,sourceVersion:'SYNTHETIC',lat:37,lng:127,address:'합성 오산센터 주소'},{id:'osan',verified:true,sourceVersion:'SYNTHETIC',lat:37,lng:127,address:'합성 오산센터 주소'},{id:'yeongnam',verified:true,sourceVersion:'SYNTHETIC',lat:35,lng:128}]};window.__routeLines=new Set();
document.body.dataset.mapStaffState='authenticated';window.MapStaffEntry={status(){},registerPurge(){}};window.MapTerritoryUi={renderForSelection(){},toggle(){}};
class Coord{constructor(lat,lng){this.lat=lat;this.lng=lng}getLat(){return this.lat}getLng(){return this.lng}}
class Bounds{constructor(){this.points=[]}extend(p){this.points.push([p.lat,p.lng])}getSouthWest(){return new Coord(33,124)}getNorthEast(){return new Coord(39.5,132)}}
const listeners=new WeakMap();
const event={
 addListener(target,name,fn){if(!listeners.has(target))listeners.set(target,new Map());const map=listeners.get(target);if(!map.has(name))map.set(name,new Set());map.get(name).add(fn);},
 removeListener(target,name,fn){listeners.get(target)?.get(name)?.delete(fn);},
 trigger(target,name){for(const fn of listeners.get(target)?.get(name)||[])fn();}
};
class FixtureMap{constructor(el,o){this.el=el;this.center=o.center;this.level=5;this.overlays=new Set()}getCenter(){return this.center}setCenter(p){this.center=p;event.trigger(this,'center_changed');event.trigger(this,'idle')}panTo(p){this.setCenter(p)}getLevel(){return this.level}setLevel(v){this.level=v;event.trigger(this,'zoom_changed');event.trigger(this,'idle')}getBounds(){return new Bounds()}setBounds(bounds){window.__lastFit=bounds.points}relayout(){this.overlays.forEach(overlay=>overlay.move())}getProjection(){return{containerPointFromCoords:p=>({x:this.el.clientWidth/2+(p.lng-127)*24000,y:210-(p.lat-37)*24000}),coordsFromContainerPoint:p=>new Coord(37,127)}}}
class Overlay{constructor(o){this.opts=o;this.wrapper=document.createElement('div')}setMap(m){
 this.wrapper.remove();this.map?.overlays.delete(this);if(!m||!this.opts.content)return;
 this.map=m;m.overlays.add(this);
 const {position,content,xAnchor=.5,yAnchor=.5,zIndex=0}=this.opts;
 this.wrapper.style.cssText='position:absolute;z-index:'+zIndex+';transform:translate('+(-100*xAnchor)+'%,'+(-100*yAnchor)+'%)';
 this.wrapper.dataset.fixtureCoords=position.lat+','+position.lng;
 this.move=()=>{const point=m.getProjection().containerPointFromCoords(position);this.wrapper.style.left=point.x+'px';this.wrapper.style.top=point.y+'px';};
 this.wrapper.append(content);m.el.append(this.wrapper);this.move();
 }}
class RoadLine extends Overlay{setMap(m){if(m){if(this.opts.path.length<3)throw Error('SYNTHETIC_GEOMETRY_MISSING');window.__routeLines.add(this);}else window.__routeLines.delete(this);}}
window.kakao={maps:{LatLng:Coord,LatLngBounds:Bounds,Map:FixtureMap,CustomOverlay:Overlay,Polygon:Overlay,Polyline:RoadLine,event}};window.KakaoMapsAdapter={ready:()=>Promise.resolve(),reset(){}};`;
let html=fs.readFileSync(path.join(root,'map-phase2b-preview.html'),'utf8').replace(/<script\b[\s\S]*?<\/script>/gi,'');
html=html.replace('</body>','<script>'+fixture+'</script>'+scripts.map(f=>'<script src="'+f+'"></script>').join('')+'<script>MapDotUi.mount()</script></body>');
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname.startsWith('/api/')){
  let data={data:[],meta:{}};
  if(u.pathname.endsWith('/manual-road-route')){
   let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
   try{data=await service.route(body);}catch(e){res.statusCode=e.status||500;data={ok:false,error:e.code};}
  }
  if(u.pathname.endsWith('/customer-search'))data={data:[{...rows[0],customerCode:'S100000'}]};
  if(u.pathname.endsWith('/snapshot'))data={data:rows,meta:{complete:true,latestDate:'2026-11-02',startDate:'2026-09-04',endDate:'2026-11-02'}};
  if(u.pathname.endsWith('/base-vehicles'))data={ok:true,data:rows.map(r=>({customerCode:r.customerCode,baseVehicle:'101',baseVehicleState:'VERIFIED_MASTER',baseVehicleGroup:'osan',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:'e'.repeat(64),baseVehicleStale:false})),meta:{version:'e'.repeat(64),stale:false}};
  if(u.pathname.endsWith('/assignments'))data={data:dailyRows.map(r=>({...r,deliveryDate:u.searchParams.get('date')})),meta:{complete:true,date:u.searchParams.get('date')}};
  if(u.pathname.endsWith('/route-plan'))data={data:{vehicle:'101',stops:dailyRows,totalStops:4},meta:{complete:true}};
  res.setHeader('content-type','application/json');res.end(JSON.stringify(data));return;
 }
 if(u.pathname==='/opsmap/'){res.setHeader('content-type','text/html');res.end(html);return;}
 const f=path.join(root,u.pathname.includes('/assets/')?'assets/'+path.basename(u.pathname):path.basename(u.pathname));
 if(fs.existsSync(f)&&fs.statSync(f).isFile()){res.setHeader('content-type',f.endsWith('.css')?'text/css':f.endsWith('.svg')?'image/svg+xml':'application/javascript');res.end(fs.readFileSync(f));}else{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.OPSMAP_TEST_CHROMIUM||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1366,height:900}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(route.request().url());return route.abort();}return route.continue();});
 await page.goto(origin+'/opsmap/');await page.waitForFunction(()=>window.MapNavigation&&MapUiLocalBridge.isDataReady());
 const check=(name,value)=>{assert(value,name);checks.push(name);};
 const totals=page.locator('#mapRouteTotals');
 const marker=page.locator('#map .osanCenterMarker'),card=page.locator('#osanCenterCard');
 await marker.waitFor();
 await page.evaluate(()=>{window.__stableOsanMarker=document.querySelector('.osanCenterMarker');});
 const stableMarker=()=>page.evaluate(()=>MapNavigation.metrics().osanCenterOverlays===1&&MapNavigation.metrics().centerOverlays===2&&
   document.querySelectorAll('.centerMarker:not(.osanCenterMarker)').length===1&&__stableOsanMarker===document.querySelector('.osanCenterMarker'));
 check('exactly one warehouse marker uses the registered Osan coordinate',await marker.evaluate(node=>{
  const anchor=node.closest('.osanCenterAnchor');
  return anchor.parentElement.dataset.fixtureCoords==='37,127'&&node.querySelector('svg').getBoundingClientRect().width===28;
 })&&await stableMarker());
 await page.locator('#periodCenter').evaluate(node=>{node.value='all';node.dispatchEvent(new Event('change'));});
 await page.evaluate(()=>{
  const input=document.querySelector('#vehicleList input[value="101"]');
  input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));
 });
 await marker.click();
 check('warehouse card opens and marker survives all-center and truck filters',await stableMarker()&&await card.isVisible()&&
   (await card.textContent()).includes('합성 오산센터 주소')&&await page.evaluate(()=>!MapUiLocalBridge.state.selected));
 await card.locator('[data-center-origin]').click();
 check('warehouse card sets the existing origin without a provider call',await page.locator('#plannerStart').inputValue()==='CENTER_osan'&&requests.length===0);
 await page.screenshot({path:path.join(output,'osan-center-1366.png')});
 await card.locator('[data-center-close]').click();
 await page.evaluate(()=>{kakao.maps.event.trigger(MapUiLocalBridge.state.map,'click');MapNavigationEditor.clear();});
 await page.setViewportSize({width:390,height:900});
 await page.waitForFunction(()=>{
  const map=document.querySelector('#map').getBoundingClientRect(),marker=document.querySelector('.osanCenterMarker').getBoundingClientRect();
  return Math.abs((map.left+map.right-marker.left-marker.right)/2)<2;
 });
 await marker.click();
 check('mobile warehouse marker and card remain visible after resize',await card.evaluate(node=>{
  const r=node.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;
 })&&await stableMarker());
 await page.screenshot({path:path.join(output,'osan-center-390.png')});
 await card.locator('[data-center-close]').click();
 await page.setViewportSize({width:1366,height:900});
 await page.locator('#query').fill('합성 매장 0');
 await page.locator('#searchBtn').click();
 await page.waitForFunction(()=>MapUiLocalBridge.state.selected?.customerCode==='S100000');
 check('store search preserves the warehouse overlay while selecting a store',await stableMarker());
 await page.evaluate(()=>kakao.maps.event.trigger(MapUiLocalBridge.state.map,'click'));
 await page.screenshot({path:path.join(output,'before-1366.png')});
 check('initial visit does not query Directions or show route totals',requests.length===0&&providerRequests.length===0&&!await totals.isVisible());
 await page.locator('#waypointPlanner').evaluate(n=>n.open=true);
 await page.locator('.navCenterChoices').getByRole('button',{name:'오산센터',exact:true}).click();
 await page.evaluate(()=>MapNavigationEditor.setPoint('destination','SYNTHETIC_3'));
 check('verified Osan center is selectable',await page.locator('#plannerStart').inputValue()==='CENTER_osan');
 await page.locator('#planRoute').click();
 await page.waitForFunction(()=>MapNavigation.metrics().routeState==='success');
 assert.deepEqual(providerRequests[0],{method:'GET',points:[[127,37],[rows[3].lng,rows[3].lat]]});
 check('Osan center to one store displays synthetic road geometry, distance and duration',requests.length===1&&await page.evaluate(()=>__routeLines.size===1)&&await page.locator('#navDistance').textContent()==='0.1 km'&&await page.locator('#navDuration').textContent()==='1분');
 check('desktop totals are visible on the map and absent from route settings',await page.locator('.maparea > #mapRouteTotals').isVisible()&&await page.locator('#waypointPlanner #navDistance, #waypointPlanner #navDuration, #waypointPlanner .plannerMetrics').count()===0);
 await totals.screenshot({path:path.join(output,'map-route-totals-1366.png')});
 await page.locator('#clearPlanner').click();
 await page.evaluate(()=>MapNavigationEditor.replacePoints(['SYNTHETIC_0','SYNTHETIC_1','SYNTHETIC_2','SYNTHETIC_3']));
 await page.evaluate(()=>{window.__stableKakaoLink=document.querySelector('#navKakaoLinks a');for(let i=0;i<20;i++)window.dispatchEvent(new Event('map-coordinate-updated'));});await page.waitForTimeout(100);check('background coordinate updates preserve the same clickable external route link',await page.evaluate(()=>window.__stableKakaoLink===document.querySelector('#navKakaoLinks a')));
 await page.locator('#waypointPlanner').evaluate(n=>n.open=true);await page.locator('#planRoute').click();
 await page.waitForFunction(()=>MapNavigation.metrics().routeState==='success');
 assert.deepEqual(providerRequests[1],{method:'GET',points:rows.slice(0,4).map(r=>[r.lng,r.lat])});
 check('two-waypoint GET renders all synthetic legs, distance and duration',requests.length===2&&providerRequests.length===2&&reservations.length===2&&await page.evaluate(()=>__routeLines.size===3)&&await page.locator('#navDistance').textContent()==='0.3 km'&&await page.locator('#navDuration').textContent()==='3분');
 const geometry=await page.evaluate(()=>Array.from(__routeLines,l=>l.opts.path.map(p=>[p.getLat(),p.getLng()])));
 assert.deepEqual(geometry[0][1],[rows[0].lat+.0002,rows[0].lng+.0001]);
 await page.evaluate(()=>{const map=MapUiLocalBridge.state.map;map.panTo(new kakao.maps.LatLng(37.02,127.02));map.setLevel(6);});
 await page.waitForFunction(()=>MapUiLocalBridge.state.map.getLevel()===6&&MapUiLocalBridge.state.map.getCenter().getLat()===37.02);
 assert.deepEqual(await page.evaluate(()=>Array.from(__routeLines,l=>l.opts.path.map(p=>[p.getLat(),p.getLng()]))),geometry);
 check('pan and zoom keep the synthetic path, map totals and warehouse marker without a new call',requests.length===2&&await totals.isVisible()&&await stableMarker());
 await page.locator('[aria-label="경유지 2 위로"]').click();await page.waitForFunction(()=>MapNavigation.metrics().routeState==='success');
 await page.waitForFunction(()=>document.querySelector('#navLegs').textContent.includes('합성 매장 0 → 합성 매장 2'));
 check('waypoint reorder automatically recalculates exact new sequence once',requests.length===3&&requests[2].waypoints[0].lat===rows[2].lat&&requests[2].waypoints[1].lat===rows[1].lat&&providerRequests.length===3);
 await page.locator('#reversePlanner').click();await page.waitForFunction(()=>document.querySelector('#navLegs').textContent.includes('합성 매장 3 → 합성 매장 1'));
 check('swap reverses endpoints and intermediate visit order',requests.length===4&&requests[3].origin.lat===rows[3].lat&&requests[3].destination.lat===rows[0].lat&&requests[3].waypoints[0].lat===rows[1].lat);
 await page.locator('#plannerWaypoint0').fill('UNRESOLVED');await page.waitForTimeout(650);
 check('incomplete waypoint clears geometry and never queries',requests.length===4&&await page.locator('#navDistance').textContent()==='— km');
 await page.locator('#clearPlanner').click();await page.waitForTimeout(550);check('reset clears all points and metrics without a call',requests.length===4&&(await page.evaluate(()=>MapNavigationEditor.values())).every(v=>!v)&&await page.locator('#navDuration').textContent()==='— 분'&&!await totals.isVisible());
 for(const width of [1920,1366,768,390]){
  await page.setViewportSize({width,height:900});await page.locator('#waypointPlanner').scrollIntoViewIfNeeded();
  check(width+'px editor stays inside the viewport',await page.locator('#waypointPlanner').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1}));
  await page.screenshot({path:path.join(output,'after-'+width+'.png')});
 }
 await page.evaluate(()=>MapNavigationEditor.replacePoints(['SYNTHETIC_0','SYNTHETIC_3']));await page.locator('#planRoute').click();await page.waitForFunction(()=>MapNavigation.metrics().routeState==='success');
 check('mobile explicit route shows synthetic geometry and response metrics',requests.length===5&&await page.locator('#navDistance').textContent()==='0.1 km');
 check('mobile totals fit inside the map',await totals.evaluate(node=>{const badge=node.getBoundingClientRect(),map=node.parentElement.getBoundingClientRect();return badge.width>0&&badge.left>=map.left&&badge.right<=map.right&&badge.bottom<=map.bottom;}));
 await totals.screenshot({path:path.join(output,'map-route-totals-390.png')});
 await page.locator('#addWaypoint').click();await page.evaluate(()=>MapNavigationEditor.setPoint('waypoint','SYNTHETIC_1',0));await page.waitForFunction(()=>document.querySelector('#navDistance').textContent==='0.2 km');
 check('mobile add waypoint recalculates',requests.length===6&&requests.at(-1).waypoints.length===1);
 const beforeRemove=providerRequests.length;
 await page.locator('[aria-label="경유지 1 삭제"]').click();await page.waitForFunction(()=>document.querySelector('#navDistance').textContent==='0.1 km');
 check('mobile delete waypoint reuses cached route',requests.length===7&&requests.at(-1).waypoints.length===0&&providerRequests.length===beforeRemove);
 await page.locator('#clearPlanner').click();
 await page.evaluate(codes=>MapNavigationEditor.replacePoints(codes),rows.map(r=>r.customerCode));
 await page.locator('#planRoute').click();
 await page.waitForFunction(()=>MapNavigation.metrics().routeState==='success');
 assert.deepEqual(providerRequests.at(-1),{method:'POST',points:rows.map(r=>[r.lng,r.lat])});
 check('six waypoints use one synthetic POST with all seven legs',requests.length===8&&requests.at(-1).waypoints.length===6&&reservations.at(-1)==='waypoints'&&await page.evaluate(()=>__routeLines.size===7)&&await page.locator('#navDuration').textContent()==='7분');
 await page.locator('#clearPlanner').click();await page.locator('#modeDaily').click();
 await page.evaluate(()=>MapUiLocalBridge.submitDailyQuery('2026-11-02','2026-11-02'));
 await page.evaluate(()=>{const input=document.querySelector('#vehicleList input[value="101"]');input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));});
 await page.waitForFunction(()=>MapUiLocalBridge.navigationVisitRows().length===4);
 check('date and vehicle selection preserve the same warehouse marker',await stableMarker());
 const overlappingStore=page.locator('#map .marker[data-customer-code="SYNTHETIC_0"]');
 await marker.click();
 check('warehouse can be selected beside a coincident store',await card.isVisible()&&await page.evaluate(()=>!MapUiLocalBridge.state.selected));
 await card.locator('[data-center-close]').click();
 await overlappingStore.click();
 check('coincident store remains directly selectable',await page.evaluate(()=>MapUiLocalBridge.state.selected?.customerCode==='SYNTHETIC_0')&&await stableMarker());
 await page.evaluate(()=>{MapNavigationEditor.setPoint('origin','CENTER_osan');document.querySelector('#waypointPlanner').open=true;document.querySelector('#dotRoadOptions').open=true;});
 await page.locator('#queryRecordedRoute').click();
 check('mobile saved visits sort by order and retain center origin',JSON.stringify(await page.evaluate(()=>MapNavigationEditor.values()))===JSON.stringify(['CENTER_osan','SYNTHETIC_3','SYNTHETIC_2','SYNTHETIC_1','SYNTHETIC_0'])&&requests.length===8);
 await page.screenshot({path:path.join(output,'after-import-390.png')});
 const requestCount=requests.length;
 const providerCount=providerRequests.length;
 await page.reload();
 await page.waitForFunction(()=>window.MapNavigation&&MapUiLocalBridge.isDataReady());
 check('reconnect restores staff map without dispatch or old route',requests.length===requestCount&&await page.evaluate(()=>document.body.dataset.mapStaffState==='authenticated'&&MapNavigation.metrics().routeState==='idle'&&__routeLines.size===0));
 budgetDepleted=true;
 await page.locator('#waypointPlanner').evaluate(n=>n.open=true);
 await page.evaluate(()=>MapNavigationEditor.replacePoints(['CENTER_osan','SYNTHETIC_6']));
 const blocked=page.waitForResponse(r=>r.url().endsWith('/manual-road-route'));
 await page.locator('#planRoute').click();
 const response=await blocked;
 const payload=await response.json();
 await page.waitForFunction(()=>MapNavigation.metrics().routeState==='error');
 check('exhausted free budget returns local 429 and dispatches no provider request',response.status()===429&&payload.error==='QUOTA_EXCEEDED'&&requests.length===requestCount+1&&providerRequests.length===providerCount&&reservations.length===providerCount&&await page.evaluate(()=>__routeLines.size===0)&&await page.locator('#navDistance').textContent()==='— km'&&!await totals.isVisible());
 await page.evaluate(()=>window.dispatchEvent(new Event('map-navigation-logout')));
 check('logout purges center overlays, card and route choices',await page.evaluate(()=>MapNavigation.metrics().centerOverlays===0&&
   !document.querySelector('.centerMarker,#osanCenterCard,.navCenterChoices button')&&!MapNavigation.resolve('CENTER_osan').length));
 check('no external calls or JavaScript errors',external.length===0&&errors.length===0);
 const result={pass:checks.length,fail:0,scope:'LOCAL_PLAYWRIGHT_SYNTHETIC_PROVIDER',checks,routePosts:requests.length,providerCalls:providerRequests.length,reservations:reservations.length,externalCalls:external.length,errors,artifacts:output};fs.writeFileSync(path.join(output,'RESULT.safe.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){if(errors.length)console.error(JSON.stringify(errors));throw error;}finally{await browser?.close();await new Promise(r=>server.close(r));}
