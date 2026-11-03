import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {createRoadRouteService} from '../src/opsmap-abc/roadRouteService.js';
const {chromium}=await import(process.env.OPSMAP_TEST_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve('public/opsmap'),output=process.env.OPSMAP_R14_DIRECTIONS_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'opsmap-r14-directions-'));
fs.mkdirSync(output,{recursive:true});
const rows=Array.from({length:4},(_,i)=>({customerCode:'SYNTHETIC_'+i,customerName:'합성 매장 '+i,address:'합성주소 '+i,vehicle:'101',order:4-i,lat:37+i*.001,lng:127+i*.001,lastDeliveryDate:'2026-11-02'}));
const requests=[],external=[],errors=[],checks=[];let reservations=0,providerCalls=0;
const service=createRoadRouteService({env:{OPSMAP_ROAD_ROUTE_ENABLED:'1',KAKAO_REST_API_KEY:'synthetic-only'},requireDurableBudget:true,budget:{durable:true,status:async()=>({durable:true,scope:'CUMULATIVE_APPROVED_ACCOUNT',remaining:30000-reservations}),reserve:async()=>{reservations++;}},fetchImpl:async(url,options)=>{
 providerCalls++;const u=new URL(url),points=[u.searchParams.get('origin'),...(u.searchParams.get('waypoints')||'').split('|').filter(Boolean),u.searchParams.get('destination')].map(value=>value.split(',').map(Number));
 assert.equal(options.method,'GET');const sections=points.slice(0,-1).map((p,i)=>({distance:100,duration:60,roads:[{vertexes:[...p,p[0]+.0001,p[1]+.0002,...points[i+1]]}]}));
 return new Response(JSON.stringify({routes:[{result_code:0,summary:{distance:sections.length*100,duration:sections.length*60},sections}]}),{headers:{'content-type':'application/json'}});
}});
const scripts=['phase2b-ui-helpers.js','map-period-ui.js','map-view-policy.js','road-route-ui.js','new-area-requests.js','manual-waypoints.js','kakao-directions-adapter.js','manual-road-route-ui.js','map-dot-ui.js','map-phase2b-runtime.js','map-approved-shell-candidate.js','navigation-ui.js'];
const fixture=`window.VEHICLE_AREA_DATA={vehicles:[{vehicle:'101',group:'osan',customers:[]}]};window.KAKAO_MAP_CONFIG={allowExternalAddressLookup:false,centers:[{id:'osan',verified:true,sourceVersion:'SYNTHETIC',lat:37,lng:127}]};window.__routeLines=0;
window.MapStaffEntry={status(){},registerPurge(){}};window.MapTerritoryUi={renderForSelection(){},toggle(){}};
class Coord{constructor(lat,lng){this.lat=lat;this.lng=lng}getLat(){return this.lat}getLng(){return this.lng}}
class Bounds{extend(){}getSouthWest(){return new Coord(33,124)}getNorthEast(){return new Coord(39.5,132)}}
class FixtureMap{constructor(el,o){this.el=el;this.center=o.center;this.level=5}getCenter(){return this.center}setCenter(p){this.center=p}panTo(p){this.center=p}getLevel(){return this.level}setLevel(v){this.level=v}getBounds(){return new Bounds()}setBounds(){}relayout(){}getProjection(){return{containerPointFromCoords:p=>({x:350,y:300}),coordsFromContainerPoint:p=>new Coord(37,127)}}}
class Overlay{constructor(o){this.opts=o}setMap(m){this.opts.content?.remove();if(m&&this.opts.content)m.el.append(this.opts.content)}}
class RoadLine extends Overlay{setMap(m){if(m){window.__routeLines++;if(this.opts.path.length<3)throw Error('SYNTHETIC_GEOMETRY_MISSING')}}}
window.kakao={maps:{LatLng:Coord,LatLngBounds:Bounds,Map:FixtureMap,CustomOverlay:Overlay,Polygon:Overlay,Polyline:RoadLine,event:{addListener(){},removeListener(){}}}};window.KakaoMapsAdapter={ready:()=>Promise.resolve(),reset(){}};`;
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
  if(u.pathname.endsWith('/snapshot'))data={data:rows,meta:{complete:true,latestDate:'2026-11-02',startDate:'2026-09-04',endDate:'2026-11-02'}};
  if(u.pathname.endsWith('/base-vehicles'))data={ok:true,data:rows.map(r=>({customerCode:r.customerCode,baseVehicle:'101',baseVehicleState:'VERIFIED_MASTER',baseVehicleGroup:'osan',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:'e'.repeat(64),baseVehicleStale:false})),meta:{version:'e'.repeat(64),stale:false}};
  if(u.pathname.endsWith('/assignments'))data={data:rows.map(r=>({...r,deliveryDate:u.searchParams.get('date')})),meta:{complete:true,date:u.searchParams.get('date')}};
  if(u.pathname.endsWith('/route-plan'))data={data:{vehicle:'101',stops:rows,totalStops:4},meta:{complete:true}};
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
 await page.screenshot({path:path.join(output,'before-1366.png')});
 check('initial visit does not query Directions',requests.length===0&&providerCalls===0);
 await page.evaluate(()=>{MapNavigationEditor.setPoint('origin','CENTER_osan');MapNavigationEditor.setPoint('destination','SYNTHETIC_3');});
 check('verified Osan center is selectable',await page.locator('#plannerStart').inputValue()==='CENTER_osan');
 await page.evaluate(()=>MapNavigationEditor.replacePoints(['SYNTHETIC_0','SYNTHETIC_1','SYNTHETIC_2','SYNTHETIC_3']));
 await page.evaluate(()=>{window.__stableKakaoLink=document.querySelector('#navKakaoLinks a');for(let i=0;i<20;i++)window.dispatchEvent(new Event('map-coordinate-updated'));});await page.waitForTimeout(100);check('background coordinate updates preserve the same clickable external route link',await page.evaluate(()=>window.__stableKakaoLink===document.querySelector('#navKakaoLinks a')));
 await page.locator('#waypointPlanner').evaluate(n=>n.open=true);await page.locator('#planRoute').click();
 await page.waitForFunction(()=>MapNavigation.metrics().routeState==='success');
 check('explicit request renders provider geometry, distance and duration',requests.length===1&&providerCalls===1&&reservations===1&&await page.evaluate(()=>__routeLines>0)&&await page.locator('#navDistance').textContent()==='0.3 km'&&await page.locator('#navDuration').textContent()==='3분');
 await page.locator('[aria-label="경유지 2 위로"]').click();await page.waitForFunction(()=>MapNavigation.metrics().routeState==='success');
 await page.waitForFunction(()=>document.querySelector('#navLegs').textContent.includes('합성 매장 0 → 합성 매장 2'));
 check('waypoint reorder automatically recalculates exact new sequence once',requests.length===2&&requests[1].waypoints[0].lat===rows[2].lat&&requests[1].waypoints[1].lat===rows[1].lat&&providerCalls===2);
 await page.locator('#reversePlanner').click();await page.waitForFunction(()=>document.querySelector('#navLegs').textContent.includes('합성 매장 3 → 합성 매장 1'));
 check('swap reverses endpoints and intermediate visit order',requests.length===3&&requests[2].origin.lat===rows[3].lat&&requests[2].destination.lat===rows[0].lat&&requests[2].waypoints[0].lat===rows[1].lat);
 await page.locator('#plannerWaypoint0').fill('UNRESOLVED');await page.waitForTimeout(650);
 check('incomplete waypoint clears geometry and never queries',requests.length===3&&await page.locator('#navDistance').textContent()==='— km');
 await page.locator('#clearPlanner').click();await page.waitForTimeout(550);check('reset clears all points and metrics without a call',requests.length===3&&(await page.evaluate(()=>MapNavigationEditor.values())).every(v=>!v)&&await page.locator('#navDuration').textContent()==='— 분');
 for(const width of [1920,1366,768,390]){
  await page.setViewportSize({width,height:900});await page.locator('#waypointPlanner').scrollIntoViewIfNeeded();
  check(width+'px editor stays inside the viewport',await page.locator('#waypointPlanner').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1}));
  await page.screenshot({path:path.join(output,'after-'+width+'.png')});
 }
 await page.evaluate(()=>MapNavigationEditor.replacePoints(['SYNTHETIC_0','SYNTHETIC_3']));await page.locator('#planRoute').click();await page.waitForFunction(()=>MapNavigation.metrics().routeState==='success');
 check('mobile explicit route shows geometry and real response metrics',requests.length===4&&await page.locator('#navDistance').textContent()==='0.1 km');
 await page.locator('#addWaypoint').click();await page.evaluate(()=>MapNavigationEditor.setPoint('waypoint','SYNTHETIC_1',0));await page.waitForFunction(()=>document.querySelector('#navDistance').textContent==='0.2 km');
 check('mobile add waypoint recalculates',requests.length===5&&requests.at(-1).waypoints.length===1);
 await page.locator('[aria-label="경유지 1 삭제"]').click();await page.waitForFunction(()=>document.querySelector('#navDistance').textContent==='0.1 km');
 check('mobile delete waypoint reuses cached route',requests.length===6&&requests.at(-1).waypoints.length===0&&providerCalls===5);
 await page.locator('#clearPlanner').click();await page.locator('#modeDaily').click();
 await page.evaluate(()=>MapUiLocalBridge.submitDailyQuery('2026-11-02','2026-11-02'));
 await page.evaluate(()=>{const input=document.querySelector('#vehicleList input[value="101"]');input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));});
 await page.waitForFunction(()=>MapUiLocalBridge.navigationVisitRows().length===4);
 await page.evaluate(()=>{MapNavigationEditor.setPoint('origin','CENTER_osan');document.querySelector('#waypointPlanner').open=true;document.querySelector('#dotRoadOptions').open=true;});
 await page.locator('#queryRecordedRoute').click();
 check('mobile saved visits sort by order and retain center origin',JSON.stringify(await page.evaluate(()=>MapNavigationEditor.values()))===JSON.stringify(['CENTER_osan','SYNTHETIC_3','SYNTHETIC_2','SYNTHETIC_1','SYNTHETIC_0'])&&requests.length===6);
 await page.screenshot({path:path.join(output,'after-import-390.png')});
 check('no external calls or JavaScript errors',external.length===0&&errors.length===0);
 const result={pass:checks.length,fail:0,scope:'LOCAL_REAL_EDGE_SYNTHETIC_PROVIDER_NOT_LIVE_KAKAO',checks,routePosts:requests.length,providerCalls,reservations,externalCalls:external.length,errors,artifacts:output};fs.writeFileSync(path.join(output,'RESULT.safe.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
