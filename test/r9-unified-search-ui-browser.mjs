import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {chromium} from 'playwright';

// Local synthetic fixtures only: no authentication, source, geocoding or remote SDK.
const root=path.resolve('public/opsmap'),output=path.resolve('reports/r9-search-ui');fs.mkdirSync(output,{recursive:true});
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
 const file=path.join(root,u.pathname.includes('/assets/')?'assets/'+path.basename(u.pathname):path.basename(u.pathname));if(fs.existsSync(file)){res.setHeader('content-type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream');res.end(fs.readFileSync(file));}else{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.OPSMAP_TEST_CHROMIUM||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1366,height:900}});page.on('pageerror',error=>errors.push(error.stack));
 await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(route.request().url());return route.abort();}return route.continue();});
 await page.goto(origin+'/opsmap/');await page.waitForSelector('#clearQuery',{state:'attached'});await page.waitForFunction(()=>MapUiLocalBridge.isDataReady());await page.evaluate(()=>{window.clearEvents=0;window.addEventListener('map-unified-search-clear',()=>{window.clearEvents++;const q=document.querySelector('#query');q.value='';q.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#results').replaceChildren();document.querySelector('#results').hidden=true;document.querySelector('#searchState').textContent='';});});
 const check=(name,condition)=>{assert(condition,name);checks.push(name);};
 check('one unified input and one search action',await page.locator('#query:visible').count()===1&&await page.locator('.customerBlock #searchBtn:visible').count()===1);
 check('requested heading and exact input hint',await page.locator('.sourceSearchLabel>span').textContent()==='매장·주소 검색'&&await page.locator('#query').getAttribute('placeholder')==='고객코드 · 매장명 · 도로명·지번 주소');
 check('legacy address input and action are hidden and inert',!await page.locator('#addressQuery').isVisible()&&!await page.locator('#addressBtn').isVisible()&&await page.locator('.addressBlock').evaluate(e=>e.inert&&e.getAttribute('aria-hidden')==='true'));
 check('empty search does not expose a clear action or dropdown',!await page.locator('#clearQuery').isVisible()&&!await page.locator('#results').isVisible());
 await page.locator('#query').fill('합성 매장');check('typing exposes one clear action',await page.locator('#clearQuery').isVisible());await page.locator('#clearQuery').click();
 check('clear dispatches one controller event and retains focus',await page.evaluate(()=>window.clearEvents===1&&document.querySelector('#query')===document.activeElement)&&await page.locator('#query').inputValue()===''&&!await page.locator('#clearQuery').isVisible());
 await page.evaluate(()=>{const r=document.querySelector('#results');for(const [code,name] of [['S970001','합성 동일건물 가게 A'],['S970002','합성 동일건물 가게 B']]){const b=document.createElement('button');b.textContent=code+' · '+name;b.onclick=()=>{r.replaceChildren();r.hidden=true;};r.append(b);}});
 await page.waitForTimeout(30);check('controller retains dropdown visibility ownership',!await page.locator('#results').isVisible());
 await page.evaluate(()=>{document.querySelector('#results').hidden=false;document.querySelector('#searchNotice').hidden=false;document.querySelector('#searchNotice').classList.add('show');document.querySelector('#searchNotice').textContent='주소 조회 실패';document.querySelector('#addressJudgeResults').hidden=false;const b=document.createElement('button');b.className='externalAddressResult';b.textContent='외부 주소 위치 확인 · 지도 밖 주소 · 별도 조회';document.querySelector('#results').append(b);});
 check('legacy notice, judgement and external result stay invisible',!await page.locator('#searchNotice').isVisible()&&!await page.locator('#addressJudgeResults').isVisible()&&!await page.locator('.externalAddressResult').isVisible());
 for(const [width,height] of [[1920,1080],[1366,900],[760,900],[390,844]]){
  await page.setViewportSize({width,height});await page.locator('#query').scrollIntoViewIfNeeded();
  await page.evaluate(()=>document.querySelector('#searchState').textContent='신규 주소 위치 확인이 제한되었습니다. 지도에서 임시 위치를 선택해 주세요. '.repeat(12));
  const geometry=await page.evaluate(()=>{const parent=document.querySelector('.customerBlock').getBoundingClientRect(),input=document.querySelector('.unifiedSearchLine').getBoundingClientRect(),result=document.querySelector('#results').getBoundingClientRect(),state=document.querySelector('#searchState').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth+2,within:result.left>=parent.left-1&&result.right<=parent.right+1&&state.right<=parent.right+1,below:Math.abs(result.top-input.bottom-4)<=1,statusHeight:state.height,resultWidth:result.width,inputWidth:input.width,resultTop:result.top,inputBottom:input.bottom,resultStyle:getComputedStyle(document.querySelector('#results')).top,field:document.querySelector('.unifiedSearchField').getBoundingClientRect().height}});
  check(width+'px input/dropdown/status stay inside panel',!geometry.overflow&&geometry.within&&geometry.below&&geometry.statusHeight<=20&&Math.abs(geometry.resultWidth-geometry.inputWidth)<2);
  await page.screenshot({path:path.join(output,'unified-'+width+'.png')});
 }
 await page.locator('#results button:visible').first().click();check('candidate selection closes dropdown',!await page.locator('#results').isVisible());
 check('single short-line status stays visible without separate error panels',await page.locator('#searchState').isVisible()&&!await page.locator('#searchNotice').isVisible()&&await page.locator('#searchState').evaluate(e=>e.scrollWidth>e.clientWidth&&e.getBoundingClientRect().height<=20));
 await page.screenshot({path:path.join(output,'error-390.png')});
 check('no JavaScript errors or external calls',errors.length===0&&external.length===0);
 const result={scope:'LOCAL_REAL_EDGE_SYNTHETIC_UI_ONLY',pass:checks.length,fail:0,checks,errors,externalCalls:external.length};fs.writeFileSync(path.join(output,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
