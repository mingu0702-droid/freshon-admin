/** Full shipped DOM/controllers with jsdom + synthetic SDK/API. No browser or layout assertion. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
const require=createRequire(path.resolve(process.env.OPSMAP_DOM_DEPS||'/tmp/opsmap4-dom-deps','package.json'));
const {JSDOM,requestInterceptor,VirtualConsole}=require('jsdom');
const esbuild=require('esbuild');
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PUBLIC=path.join(ROOT,'public'),OUT=path.join(ROOT,'reports/repair4');
const ORIGIN=process.env.OPSMAP_PREVIEW_ORIGIN||'http://127.0.0.1:4173';
const results=[],errors=[],resourceRequests=[],blockedExternal=[],moduleBundles=[];
let dom;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,label,timeout=12000){const start=Date.now();for(;;){if(predicate())return;if(Date.now()-start>timeout)throw Error(label+' timed out');await pause(30);}}
async function check(name,fn){try{const detail=await fn();results.push({name,passed:true,detail:detail??null});console.log('PASS '+name);}catch(error){results.push({name,passed:false,error:String(error.stack||error)});console.log('FAIL '+name+': '+error.message);}}
const localResources={interceptors:[requestInterceptor(async(request,{element})=>{
  const parsed=new URL(request.url);if(parsed.origin!==ORIGIN){blockedExternal.push(request.url);return new Response('',{status:403});}
  resourceRequests.push(parsed.pathname);
  if(element?.dataset.fixtureModule==='1'||parsed.pathname.endsWith('.mjs')){
    const entry=path.resolve(PUBLIC,parsed.pathname.slice(1));
    if(!entry.startsWith(PUBLIC+path.sep))return new Response('',{status:403});
    const bundled=await esbuild.build({entryPoints:[entry],bundle:true,format:'iife',platform:'browser',target:'es2022',write:false,logLevel:'silent'});
    moduleBundles.push(parsed.pathname);return new Response(bundled.outputFiles[0].text,{headers:{'Content-Type':'text/javascript'}});
  }
  const response=await fetch(request.url);
  if(parsed.pathname==='/__fixture/bootstrap.js'){
    const bootstrap=await response.text(),split=bootstrap.indexOf('\nwindow.MAP_ROLLING_DATE_INDEX_ENABLED=');
    assert.ok(split>=0,'Fixture bootstrap boundary');
    const latestSDK=await fs.readFile(path.join(ROOT,'tests/patch/kakao-test-double.js'),'utf8');
    return new Response(latestSDK+bootstrap.slice(split),{status:response.status,headers:response.headers});
  }
  return new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers});
})]};

function installPlatform(window){
  // DOM-only platform shims. These fixed dimensions drive the SDK double's math,
  // not a browser layout engine and never count as pixel/visual verification.
  Object.defineProperty(window,'innerWidth',{value:1440,configurable:true});Object.defineProperty(window,'innerHeight',{value:900,configurable:true});
  const rect=element=>{const isMap=element.id==='map'||element.classList?.contains('maparea'),isSide=element.classList?.contains('sidebar');const width=isMap?1120:isSide?310:300,height=isMap?828:isSide?828:40,left=isMap?310:0,top=isMap?72:0;return{x:left,y:top,left,top,width,height,right:left+width,bottom:top+height,toJSON(){return{left,top,width,height}}};};
  Object.defineProperty(window.HTMLElement.prototype,'clientWidth',{get(){return rect(this).width;},configurable:true});
  Object.defineProperty(window.HTMLElement.prototype,'clientHeight',{get(){return rect(this).height;},configurable:true});
  Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{get(){return rect(this).width;},configurable:true});
  Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{get(){return rect(this).height;},configurable:true});
  window.HTMLElement.prototype.getBoundingClientRect=function(){return rect(this);};window.HTMLElement.prototype.scrollIntoView=function(){};
  window.matchMedia=query=>({media:query,matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  window.ResizeObserver=class{constructor(callback){this.callback=callback;}observe(target){queueMicrotask(()=>this.callback([{target,contentRect:rect(target)}]));}unobserve(){}disconnect(){}};
  window.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
  window.BroadcastChannel=class{postMessage(){}close(){}addEventListener(){}removeEventListener(){}};
  for(const key of ['Headers','Request','Response','AbortController','AbortSignal','TextEncoder','TextDecoder','ReadableStream','TransformStream'])window[key]=globalThis[key];
  Object.defineProperty(window.crypto,'subtle',{value:webcrypto.subtle,configurable:true});
  window.fetch=(input,options)=>{const url=new URL(typeof input==='string'?input:input.url,ORIGIN);if(url.origin!==ORIGIN){blockedExternal.push(url.href);return Promise.reject(Error('EXTERNAL_IO_BLOCKED'));}return fetch(url,options);};
  window.CSS||={};window.CSS.escape||=(value)=>String(value).replace(/[^a-zA-Z0-9_-]/g,ch=>'\\'+ch);
  for(const method of ['show','showModal'])window.HTMLDialogElement.prototype[method]=function(){this.open=true;this.setAttribute('open','');};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;this.removeAttribute('open');this.dispatchEvent(new window.Event('close'));};
  // jsdom does not execute module scripts. Bundle only the actual module files
  // in the harness and execute as IIFEs; production module sources are untouched.
  const type=Object.getOwnPropertyDescriptor(window.HTMLScriptElement.prototype,'type');
  Object.defineProperty(window.HTMLScriptElement.prototype,'type',{configurable:true,get(){return type.get.call(this);},set(value){if(value==='module'){this.dataset.fixtureModule='1';type.set.call(this,'text/javascript');}else type.set.call(this,value);}});
  // CSSOM href is implemented in browsers but omitted by jsdom's CSSStyleSheet.
  const sheets=Object.getOwnPropertyDescriptor(window.Document.prototype,'styleSheets');
  Object.defineProperty(window.Document.prototype,'styleSheets',{configurable:true,get(){const list=sheets.get.call(this);for(const link of this.querySelectorAll('link[rel=stylesheet]'))if(link.sheet&&!link.sheet.href)Object.defineProperty(link.sheet,'href',{value:link.href,configurable:true});return list;}});
}
const vc=new VirtualConsole();vc.on('jsdomError',error=>errors.push(String(error.stack||error)));vc.on('error',(...args)=>errors.push(args.map(String).join(' ')));
await fs.mkdir(OUT,{recursive:true});
try{
  await fetch(ORIGIN+'/__fixture/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({routeMode:'synthetic',routeDelayMs:150})});
  const response=await fetch(ORIGIN+'/');assert.ok(response.ok,'fixture HTML available');const html=await response.text();
  dom=new JSDOM(html,{url:ORIGIN+'/',runScripts:'dangerously',resources:localResources,pretendToBeVisual:true,virtualConsole:vc,beforeParse:installPlatform});
  const w=dom.window,d=w.document,$=selector=>d.querySelector(selector),all=selector=>[...d.querySelectorAll(selector)];
  const click=selector=>{const element=$(selector);assert.ok(element,'Element exists '+selector);element.click();return element;};
  const input=(selector,value)=>{const element=$(selector);assert.ok(element,'Input exists '+selector);element.value=value;element.dispatchEvent(new w.Event('input',{bubbles:true}));return element;};
  async function choose(selector,code){const element=input(selector,code);element.focus();await until(()=>$('#navSearchResults button[data-code="'+code+'"]'),'suggestion '+code);click('#navSearchResults button[data-code="'+code+'"]');await pause(20);}
  const values=()=>Array.from(w.MapNavigationEditor.values());
  await check('full shipped page authenticates and initializes all controllers',async()=>{await until(()=>d.body.dataset.mapStaffState==='authenticated'&&w.MapUiLocalBridge?.isDataReady()&&w.MapNavigation&&w.MapManualPins&&w.MapTerritoryUi,'application boot');return {staffState:d.body.dataset.mapStaffState,controllerMode:w.MapUiLocalBridge.state.mode};});
  if(!w.MapUiLocalBridge?.isDataReady())throw Error('Application boot blocked. '+JSON.stringify({bodyState:d.body.dataset.mapStaffState,entry:$('#mapStaffEntry')?.textContent,errors,fixtureErrors:w.__fixtureErrors}));
  await check('final stylesheet remains enabled and customer code CSS precedes store name',()=>{const sheet=[...d.styleSheets].find(s=>s.href?.includes('/map-performance.css'));assert.ok(sheet);assert.notEqual(sheet.disabled,true);return {enabled:!sheet.disabled,sheet:sheet.href,layoutPixelsTested:false};});
  await check('general view contains all 2036 synthetic stores',()=>{assert.equal(w.MapUiLocalBridge.state.currentRows.length,2036);return{rows:2036,markers:d.querySelectorAll('#map .marker').length,hasMap:!!w.MapUiLocalBridge.state.map,level:w.MapUiLocalBridge.state.map?.getLevel(),center:w.MapUiLocalBridge.state.map?.getCenter(),fitRequested:w.MapUiLocalBridge.state.fitRequested,located:w.MapUiLocalBridge.state.currentRows.filter(r=>Number.isFinite(r.lat)&&Number.isFinite(r.lng)).length,sdk:{...w.__sdkCalls}};});
  await check('clicking a map group opens selectable members and selected pin',async()=>{await until(()=>$('#map .periodCluster'),'group marker '+JSON.stringify({map:!!w.MapUiLocalBridge.state.map,level:w.MapUiLocalBridge.state.map?.getLevel(),center:w.MapUiLocalBridge.state.map?.getCenter(),fit:w.MapUiLocalBridge.state.fitRequested,located:w.MapUiLocalBridge.state.currentRows.filter(r=>Number.isFinite(r.lat)&&Number.isFinite(r.lng)).length}),3000);click('#map .periodCluster');await until(()=>$('#mapClusterPanel [data-cluster-code]'),'cluster member list');const member=$('#mapClusterPanel [data-cluster-code]'),code=member.dataset.clusterCode;member.click();await until(()=>w.MapUiLocalBridge.state.selected?.customerCode===code,'selected group member');await until(()=>$('#map .marker.selected[data-customer-code="'+code+'"]'),'individual selected marker');assert.ok($('#detailSection').classList.contains('open'));return{selected:code};});
  async function searchStore(code){input('#query',code);click('#searchBtn');await until(()=>$('#results [data-search-code="'+code+'"]'),'store search '+code);click('#results [data-search-code="'+code+'"]');await until(()=>w.MapUiLocalBridge.state.selected?.customerCode===code,'selected store '+code);}
  await check('two stores in the same building remain independently selectable',async()=>{await searchStore('S9901000');assert.ok($('#map .marker.selected[data-customer-code="S9901000"]'));await searchStore('S9901001');assert.ok($('#map .marker.selected[data-customer-code="S9901001"]'));return{codes:['S9901000','S9901001'],selected:w.MapUiLocalBridge.state.selected.customerCode};});
  await check('customer code precedes name under the enabled final CSS rules',()=>{assert.equal(w.getComputedStyle($('#detail .code')).order,'0');assert.equal(w.getComputedStyle($('#detail .storeName')).order,'1');return{cssOrder:[0,1],pixelOrderNotTested:true};});
  await check('general-map detail shows the verified base-vehicle driver from the existing master read',async()=>{await until(()=>$('#detailDriver')?.dataset.source==='VEHICLE_DRIVER_MASTER','base-vehicle assigned driver');const selected=w.MapUiLocalBridge.state.selected;assert.equal(selected.baseVehicleState,'VERIFIED_MASTER');assert.equal($('#detailDriverLabel').textContent,'담당 기사');assert.ok($('#detailDriver').textContent.includes('합성 기사 '+selected.baseVehicle));assert.match($('#detailDriver').textContent,/기준/);return{vehicle:selected.baseVehicle,driver:$('#detailDriver').textContent,source:$('#detailDriver').dataset.source,syntheticOnly:true};});
  await check('daily tab uses the allowed review date and only its 96 rows',async()=>{click('#modeDaily');await until(()=>w.MapUiLocalBridge.state.mode==='DATE_ROUTE'&&w.MapUiLocalBridge.isDataReady(),'daily ready');assert.equal(w.MapUiLocalBridge.state.selectedDate,'2026-10-23');assert.equal(w.MapUiLocalBridge.state.currentRows.length,96);assert.equal(w.MapUiLocalBridge.navigationStores().some(row=>row.customerCode==='S9901100'),false);return{date:w.MapUiLocalBridge.state.selectedDate,rows:w.MapUiLocalBridge.state.currentRows.length};});
  await check('destination-first search keeps origin empty',async()=>{click('#clearPlanner');await choose('#plannerEnd','S9901003');assert.deepEqual(values(),['','S9901003']);assert.equal($('#map .navRoutePoint[data-role=origin]'),null);return values();});
  await check('origin and waypoint search assign explicit roles and pins before query',async()=>{await choose('#plannerStart','S9901000');click('#addWaypoint');await choose('#plannerWaypoint0','S9901002');assert.deepEqual(values(),['S9901000','S9901002','S9901003']);assert.equal(all('#map .navRoutePoint').length,3);return values();});
  await check('waypoint deletion and reverse act on visible roles without hidden reassignment',async()=>{click('#addWaypoint');await choose('#plannerWaypoint1','S9901001');click('#reversePlanner');assert.deepEqual(values(),['S9901003','S9901001','S9901002','S9901000']);click('#plannerStops .waypointInput button[aria-label="경유지 1 삭제"]');assert.deepEqual(values(),['S9901003','S9901002','S9901000']);return values();});
  await check('too-large visit list refuses atomically rather than truncating stops',()=>{const before=values();click('#queryRecordedRoute');assert.deepEqual(values(),before);assert.match($('#navPointStatus').textContent,/32|30|호차|위치/);return{notice:$('#navPointStatus').textContent};});
  await check('single-vehicle visit list applies all stops without querying provider',async()=>{click('#chooseRoutes');click('#clearVehicles');const box=$('#routeDialog input[type=checkbox][value="101"]');assert.ok(box);box.click();click('#queryRoutes');await until(()=>!$('#routeDialog').open&&w.MapUiLocalBridge.isDataReady(),'vehicle query');const visit=w.MapUiLocalBridge.navigationVisitRows();assert.equal(visit.length,6);const before=(await(await fetch(ORIGIN+'/__fixture/state')).json()).routeRequests;click('#queryRecordedRoute');assert.deepEqual(values(),Array.from(visit,row=>row.customerCode));const after=(await(await fetch(ORIGIN+'/__fixture/state')).json()).routeRequests;assert.equal(after,before);return{stops:visit.length,automaticRouteRequests:after-before};});
  await check('synthetic route result updates status and metrics without fixed disconnected text',async()=>{click('#planRoute');await until(()=>w.MapUiLocalBridge.manualRouteState()?.state==='success','synthetic route success');await pause(40);assert.equal($('#navigationSummary').dataset.state,'success');assert.doesNotMatch($('#navRouteStatus').textContent,/API 미연결|연결 대기/);assert.doesNotMatch($('#navDistance').textContent,/—/);assert.ok(w.__sdkCalls.lines>0);return{status:$('#navRouteStatus').textContent,distance:$('#navDistance').textContent,syntheticOnly:true};});
  await check('turning road lines off also hides lines from a newly completed result',async()=>{const toggle=$('#navRoadLines');toggle.checked=false;toggle.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(w.__sdkCalls.lines,0);click('#planRoute');await until(()=>w.MapUiLocalBridge.manualRouteState()?.state==='success','second synthetic route');await pause(80);assert.equal(w.__sdkCalls.lines,0);return{toggleChecked:toggle.checked,displayedLines:w.__sdkCalls.lines};});
  await check('editing a point clears stale route totals and removes old geometry',async()=>{input('#plannerEnd','S9901004');await pause(30);assert.equal(w.MapUiLocalBridge.manualRouteState()?.state,'idle');assert.match($('#navDistance').textContent,/—/);assert.equal(w.__sdkCalls.lines,0);await choose('#plannerEnd','S9901004');return{state:w.MapUiLocalBridge.manualRouteState()?.state};});
  await check('synthetic API failure remains a failure message with empty metrics',async()=>{await fetch(ORIGIN+'/__fixture/state',{method:'POST',headers:{'content-type':'application/json'},body:'{"routeMode":"error"}'});click('#planRoute');await until(()=>w.MapUiLocalBridge.manualRouteState()?.state==='error','route error');assert.equal($('#navigationSummary').dataset.state,'error');assert.doesNotMatch($('#navRouteStatus').textContent,/API 미연결|센터부터/);assert.match($('#navDistance').textContent,/—/);assert.equal(w.__sdkCalls.lines,0);return{error:w.MapUiLocalBridge.manualRouteState().error,message:$('#navRouteStatus').textContent};});
  await check('clear removes all role values and route pins',async()=>{click('#clearPlanner');await pause(30);assert.deepEqual(values(),['','']);assert.equal(all('#map .navRoutePoint').length,0);return{values:values(),rolePins:0};});
  await check('no unhandled application errors and no external network resource request',()=>{assert.deepEqual(Array.from(w.__fixtureErrors),[]);assert.deepEqual(errors,[]);assert.deepEqual(blockedExternal,[]);return{moduleBundles,externalRequests:blockedExternal.length};});
  await fs.writeFile(path.join(OUT,'dom-flow-page.html'),dom.serialize());
}catch(error){results.push({name:'integration harness completion',passed:false,error:String(error.stack||error)});console.log('FAIL integration harness completion: '+error.message);}
finally{
  const state=dom?.window.MapUiLocalBridge?.state;
  const report={type:'JSDOM_SHIPPED_APPLICATION_SYNTHETIC_FIXTURE',realBrowser:false,realKakaoSDK:false,realProvider:false,layoutPixelsTested:false,productionFilesModifiedByHarness:false,fixtureOrigin:ORIGIN,results,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,errors,fixtureErrors:dom?.window.__fixtureErrors||[],blockedExternal,moduleBundles,resourceRequests,finalState:state?{mode:state.mode,date:state.selectedDate,rows:state.currentRows.length}:null};
  await fs.writeFile(path.join(OUT,'dom-flow.json'),JSON.stringify(report,null,2));
  if(dom)dom.window.close();
  try{await fetch(ORIGIN+'/__fixture/state',{method:'POST',headers:{'content-type':'application/json'},body:'{"routeMode":"synthetic","routeDelayMs":150}'});}catch{}
  console.log(JSON.stringify({passed:report.passed,failed:report.failed,report:'reports/repair4/dom-flow.json'}));
  process.exitCode=report.failed?1:0;
}
