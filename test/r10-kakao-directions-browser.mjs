import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
const {chromium}=await import(process.env.OPSMAP_TEST_PLAYWRIGHT_MODULE||'playwright');
// Real existing shell/editor/navigation controllers, synthetic rows and SDK only.
const root=path.resolve('public/opsmap'),output=fs.mkdtempSync(path.join(os.tmpdir(),'opsmap-r10-directions-'));
const rows=Array.from({length:32},(_,i)=>({customerCode:'SYNTHETIC_'+i,customerName:'합성 매장 '+i,address:'합성주소 '+i,vehicle:'101',lat:37+i*.001,lng:127+i*.001,lastDeliveryDate:'2026-11-02'}));
const requests=[],external=[],errors=[],checks=[],version='e'.repeat(64);
const scripts=['phase2b-ui-helpers.js','map-period-ui.js','map-view-policy.js','road-route-ui.js','new-area-requests.js','manual-waypoints.js','kakao-directions-adapter.js','manual-road-route-ui.js','map-dot-ui.js','map-phase2b-runtime.js','map-approved-shell-candidate.js','navigation-ui.js'];
const fixture=`window.VEHICLE_AREA_DATA={vehicles:[{vehicle:'101',group:'osan',customers:[]}]};window.KAKAO_MAP_CONFIG={allowExternalAddressLookup:false};
window.MapStaffEntry={status(){},registerPurge(){}};window.MapTerritoryUi={renderForSelection(){},toggle(){}};
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
  if(u.pathname.endsWith('/base-vehicles'))data={ok:true,data:rows.map(r=>({customerCode:r.customerCode,baseVehicle:'101',baseVehicleState:'VERIFIED_MASTER',baseVehicleGroup:'osan',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:version,baseVehicleStale:false})),meta:{version,stale:false}};
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
 const page=await browser.newPage({viewport:{width:1366,height:900}});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(route.request().url());return route.abort();}return route.continue();});
 await page.goto(origin+'/opsmap/');await page.waitForFunction(()=>window.MapNavigation&&MapUiLocalBridge.isDataReady());
 const check=(name,value)=>{assert(value,name);checks.push(name);};
 await page.evaluate(()=>{MapUiLocalBridge.selectNavigationStore('SYNTHETIC_1');});
 check('period selected store exposes an official destination link in existing detail',await page.locator('#detailSection #navSelectedKakao').isVisible()&&(await page.locator('#navSelectedKakao').getAttribute('href')).includes('/link/to/'));
 await page.locator('#modeDaily').click();
 await page.evaluate(()=>MapUiLocalBridge.submitDailyQuery('2026-11-02','2026-11-02'));await page.waitForFunction(()=>MapUiLocalBridge.navigationStores().length===32);
 await page.evaluate(()=>{MapUiLocalBridge.selectNavigationStore('SYNTHETIC_1');MapNavigation.sync();});
 check('daily selected store reuses the same button in existing planner',await page.locator('.navigationPicker #navSelectedKakao').count()===1);
 const apply=async count=>page.evaluate(n=>MapNavigationEditor.replacePoints(Array.from({length:n},(_,i)=>'SYNTHETIC_'+i)),count);
 await apply(2);check('two endpoints keep the combined link without a redundant fallback',await page.locator('#navKakaoLinks a').count()===1&&!await page.locator('#navKakaoLegFallback').isVisible()&&await page.locator('#navKakaoLegLinks a').count()===0);
 await apply(3);check('three points expose a short hint and initially collapsed adjacent fallback',await page.locator('#navKakaoLegHint').textContent()==='경유지가 표시되지 않으면 구간별로 열어 주세요.'&&await page.locator('#navKakaoLegFallback').isVisible()&&await page.locator('#navKakaoLegFallback').getAttribute('open')===null&&await page.locator('#navKakaoLegLinks a').count()===2&&!await page.locator('#navKakaoLegLinks a').first().isVisible());
 const adjacent=await page.locator('#navKakaoLegLinks a').evaluateAll(nodes=>nodes.map(n=>({href:n.href,text:n.textContent})));
 check('fallback first two links use exact official adjacent endpoints in input order',adjacent.every((link,i)=>link.href==='https://map.kakao.com/link/from/'+encodeURIComponent('합성 매장 '+i)+','+(37+i*.001)+','+(127+i*.001)+'/to/'+encodeURIComponent('합성 매장 '+(i+1))+','+(37+(i+1)*.001)+','+(127+(i+1)*.001))&&adjacent[0].text.startsWith('1 → 2')&&adjacent[1].text.startsWith('2 → 3'));
 await apply(7);check('five waypoint boundary opens one complete official car link',await page.locator('#navKakaoLinks a').count()===1&&(await page.locator('#navKakaoLinks a').getAttribute('href')).split('/car/')[1].split('/').length===7);
 check('selected store link forwards verified origin and destination without hidden via points',(await page.locator('#navSelectedKakao').getAttribute('href')).includes('/link/from/')&&(await page.locator('#navSelectedKakaoHint').textContent()).includes('경유지 없이'));
 await apply(8);check('six waypoint boundary explicitly splits into two continuous links',await page.locator('#navKakaoLinks a').count()===2&&(await page.locator('#navKakaoStatus').textContent()).includes('모든 지점을 보존'));
 await apply(32);check('internal thirty waypoint editor is preserved with six external segments',await page.locator('#plannerStops input').count()===30&&await page.locator('#navKakaoLinks a').count()===6);
 check('thirty waypoint fallback preserves all thirty-one adjacent links with no extra provider',await page.locator('#navKakaoLegLinks a').count()===31&&await page.locator('#navKakaoLegLinks a').last().textContent().then(t=>t.startsWith('31 → 32')));
 const links=await page.locator('#navKakaoLinks a').evaluateAll(nodes=>nodes.map(n=>({href:n.href,target:n.target,rel:n.rel})));
 check('all anchors are explicit isolated user navigation with no API key',links.every(x=>x.href.startsWith('https://map.kakao.com/link/by/car/')&&x.target==='_blank'&&x.rel.includes('noreferrer')&&!/appkey|apikey|token/i.test(x.href)));
 check('external links do not fabricate distance or duration',await page.locator('#navDistance').textContent()==='— km'&&await page.locator('#navDuration').textContent()==='— 분');
 for(const width of [1366,390]){
  await page.setViewportSize({width,height:900});await page.locator('#navKakaoDirections').scrollIntoViewIfNeeded();
  check(width+'px links remain within viewport',await page.locator('#navKakaoDirections').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1}));
  await page.screenshot({path:path.join(output,'directions-'+width+'.png')});
 }
 await page.locator('#navKakaoLegFallback summary').click();check('mobile user can expand adjacent links inside the existing panel',await page.locator('#navKakaoLegLinks a').first().isVisible()&&await page.locator('#navKakaoLegLinks a').evaluateAll(nodes=>nodes.every(n=>n.getBoundingClientRect().right<=innerWidth+1)));
 await page.locator('#navKakaoLegFallback').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,'directions-fallback-390.png')});
 await page.locator('#plannerWaypoint8').fill('UNKNOWN_SYNTHETIC');check('unresolved via point blocks all combined and fallback links',await page.locator('#navKakaoLinks a').count()===0&&await page.locator('#navKakaoLegLinks a').count()===0&&!await page.locator('#navKakaoLegFallback').isVisible()&&!await page.locator('#navKakaoLegHint').isVisible());
 await page.locator('#plannerStart').fill('UNKNOWN_ORIGIN');check('unresolved explicit origin also blocks selected-store link',!await page.locator('#navSelectedKakao').isVisible());
 await page.evaluate(()=>MapNavigationEditor.clear());check('clear removes all route links and restores destination-only selected link',await page.locator('#navKakaoLinks a').count()===0&&await page.locator('#navKakaoLegLinks a').count()===0&&(await page.locator('#navSelectedKakao').getAttribute('href')).includes('/link/to/'));
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('map-navigation-logout')));check('logout clears selected destination and route links',!await page.locator('#navSelectedKakao').isVisible()&&await page.locator('#navKakaoLinks a').count()===0);
 check('no provider requests, geocoding, route POSTs or JavaScript errors',external.length===0&&!requests.some(r=>r.path.includes('road-route'))&&errors.length===0);
 const result={pass:checks.length,fail:0,scope:'LOCAL_REAL_EDGE_SYNTHETIC_SHELL_EDITOR_NO_PROVIDER',checks,externalCalls:external.length,errors,artifacts:output};fs.writeFileSync(path.join(output,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
