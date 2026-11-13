import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const {chromium}=await import(process.env.OPSMAP_TEST_PLAYWRIGHT_MODULE||'playwright');

// Use production click handlers and DOM with a synthetic Kakao projection.
const root=path.resolve('public/opsmap');
const runtime=fs.readFileSync(path.join(root,'map-phase2b-runtime.js'),'utf8');
const slice=(from,to)=>runtime.slice(runtime.indexOf(from),runtime.indexOf(to));
const cluster=slice('  function closeClusterPanel(){','  function markerElement(');
const clear=slice('  function clearMap() {','  function closeClusterPanel(){');
const marker=slice('  function markerElement(','  function representativeRows(');
const position=slice('  const markerPositions=','  function detailedMarkerRows(');
const update=slice('  function refreshMarkerSelection(','  function overviewPinObstacles(');
const css=fs.readFileSync(path.join(root,'map-performance.css'),'utf8');
const policy=fs.readFileSync(path.join(root,'map-view-policy.js'),'utf8');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'opsmap-r11-camera-'));
const fixture=`
const $=s=>document.querySelector(s),$$=s=>Array.from(document.querySelectorAll(s));
const baseVehicleStatus='READY',periodBasis='vehicle';
let clusterPanel=null,drilledBaseVehicle='',activeMapPinKey='',markerEntries=new Map(),indexedRows=null,pointIndex=null;
let cameraSelection=0,selectedDriverContact=null,temporaryDetailPoint=null,addressFocusRequest=null;
const selectedMapPins=new Set(),mapMarkerRows=new WeakMap(),requestControllers=new Map();
const state={mode:'BASE_60D',currentRows:[],selected:null,detailRequestId:0,fitRequested:false,suppressMapEventsUntil:0,overlays:[],lines:[]};
const invalidateUnifiedSearch=()=>{},closeUnifiedSearchResults=()=>{},cancelAddressLookup=()=>{},renderRunList=()=>{},renderPeriodStoreList=()=>{};
const moveMapOverlayButton=()=>{},clearSearchSelectedOverlay=()=>{},clearActualRoute=()=>{},scheduleNewAreaDispatchBadges=()=>{},scheduleDetailPosition=()=>{};
const runVisitId=row=>row?.deliveryId||row?.customerCode||'';
const vehicleLabel=v=>v?v+'호차':'',vehicleColor=()=>'#275dd8',esc=v=>String(v).replace(/[&<>"']/g,'');
const vehicleChecks=()=>$$('#vehicleList input');
function setSelectedVehicles(values,options){window.filterWrites.push({values,options});vehicleChecks().forEach(item=>item.checked=values.includes(item.value));}
function refreshVehicleUi(run){window.filterRefresh.push(run);$('#mobileBaseVehicle').value=vehicleChecks().find(item=>item.checked)?.value||'';}
function loadBaseMap(){window.loads++;}
function renderStops(){}
function selectStore(row,element,focus){
 closeClusterPanel();
 activeMapPinKey=element?markerPinKey(row):'';
 state.selected=row;window.selection={code:row.customerCode,id:row.deliveryId,focus};
 $('#detail').innerHTML='<button id="detailClose" aria-label="닫기">×</button><div class="detailBody">'+row.customerCode+'</div>';
 $('#detailClose').onclick=closeMapDetail;$('#detailSection').classList.add('open');
}
function selectVehicleStatus(){window.markerAction='dated';}function showNearbyReference(){window.markerAction='virtual';}
function focusMapPoint(row,{pinOffset}={}){window.lastPinFocus={key:markerPinKey(row),body:Boolean(pinOffset)};}
window.MapNavigationEditor={values:()=>['S00000']};
class Coord{constructor(lat,lng){this.lat=lat;this.lng=lng}getLat(){return this.lat}getLng(){return this.lng}}
class Point{constructor(x,y){this.x=x;this.y=y}}
class Bounds{constructor(){this.points=[]}extend(p){this.points.push(p)}}
const events={addListener(){},removeListener(){},preventMap(){}};
class FakeMap{
 constructor(){this.el=$('#map');this.center=new Coord(37.5,127);this.level=11;this.moves=[];}
 getLevel(){return this.level}getCenter(){return this.center}
 getProjection(){const r=this.el.getBoundingClientRect();return{
  containerPointFromCoords:p=>new Point(r.width/2+(p.lng-this.center.lng)*100,r.height/2-(p.lat-this.center.lat)*100),
  coordsFromContainerPoint:p=>new Coord(this.center.lat-(p.y-r.height/2)/100,this.center.lng+(p.x-r.width/2)/100)
 };}
 setCenter(p){this.center=p;this.draw();}relayout(){}
 jump(p,level,options){this.level=level;this.moves.push({type:'jump',level,point:p,options});this.setCenter(p);}
 setBounds(bounds,...padding){this.level=5;this.moves.push({type:'bounds',points:bounds.points,padding});this.setCenter(bounds.points[0]);}
 draw(){for(const o of state.overlays)if(o.map)o.draw();}
}
class Overlay{
 constructor(row,content,zIndex){
  this.position=new Coord(row.lat,row.lng);this.content=content;
  this.wrapper=document.createElement('div');this.wrapper.style.cssText='position:absolute;z-index:'+zIndex;this.wrapper.append(content);
 }
 setMap(map){this.map=map;this.wrapper.remove();if(map){map.el.append(this.wrapper);this.draw();}}
 getContent(){return this.content;}getZIndex(){return Number(this.wrapper.style.zIndex);}setZIndex(value){this.wrapper.style.zIndex=String(value);}
 draw(){const p=this.map.getProjection().containerPointFromCoords(this.position);this.wrapper.style.left=p.x-22+'px';this.wrapper.style.top=p.y-56+'px';}
}
window.kakao={maps:{LatLng:Coord,LatLngBounds:Bounds,Point,event:events}};
state.map=new FakeMap();
const mapCamera=MapViewPolicy.createCamera({map:state.map,element:$('#map')});
${cluster}${clear}${position}${marker}${update}
window.harness={
 seed(rows,kind,config={}){
  clearSelection();clearMap();window.selection=null;window.markerAction=null;window.lastPinFocus=null;
  window.filterWrites=[];window.filterRefresh=[];window.loads=0;drilledBaseVehicle='';
  state.mode=config.dated?'DATE_ROUTE':'BASE_60D';state.virtual=config.temporary?{searchTemporary:true}:null;
  state.currentRows=rows;state.map.moves=[];state.map.level=config.level??11;
  state.map.setCenter(new Coord(rows[0].lat,rows[0].lng));
  vehicleChecks().forEach(input=>input.checked=input.value===config.filter);
  let pins;
  if(kind==='route'||kind==='nearby'){
   const row={...rows[0],customerCode:'',clusterRows:rows,representative:kind==='route',nearbyVehicle:kind==='nearby',storeCount:rows.length};
   pins=[row];
  }else if(kind==='overview'){
   pins=[{lat:rows[0].lat,lng:rows[0].lng,clusterKey:'fixture-overview',overviewRoutes:rows}];
  }else if(kind==='region'){
   pins=[{lat:rows[0].lat,lng:rows[0].lng,clusterKey:'fixture-region',clusterCount:rows.length,
    clusterKind:'mixed',clusterRows:rows,clusterVehicles:['101','122']}];
  }else if(kind==='overlaid'){
   pins=[MapViewPolicy.exactLocations(rows)[0],rows[0]];
  }else if(kind==='adjacent'||kind==='location'){
   pins=MapViewPolicy.exactLocations(rows,state.mode);
  }else pins=rows;
  state.overlays=pins.map((row,i)=>{
   const type=row.virtual?'virtual':row.representative?'representative':row.nearbyVehicle?'nearbyVehicle':'store';
   const node=markerElement(row,config.dated?i+1:null,type);
   node.dataset.fixturePin=i;
   const overlay=new Overlay(row,node,kind==='overlaid'&&i===1?25:markerLayer(row,false,false));
   overlay.setMap(state.map);return overlay;
  });
 },
 stats(){return{selection:window.selection,center:state.map.center,level:state.map.level,moves:state.map.moves,
  temporary:state.virtual,nav:MapNavigationEditor.values(),filter:vehicleChecks().filter(input=>input.checked).map(input=>input.value),
  mobile:$('#mobileBaseVehicle').value,filterWrites:window.filterWrites,refresh:window.filterRefresh,loads:window.loads,
  source:state.currentRows,drilledBaseVehicle,lastPinFocus:window.lastPinFocus,markerAction:window.markerAction};},
 userGesture(){mapCamera.userGesture();window.lastPinFocus=null;},
 clearSelection,clearMap
};`;
const rows=[
 {customerCode:'S00000',customerName:'합성점',vehicle:'101',baseVehicle:'101',lat:37.5,lng:127},
 {customerCode:'S00001',customerName:'합성점',vehicle:'122',baseVehicle:'122',lat:37.5,lng:127},
 {customerCode:'S00002',customerName:'합성점',vehicle:'101',baseVehicle:'101',lat:37.5,lng:127.2},
];
const markup='<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;font:13px Arial}#map{position:fixed;inset:60px 0 0;background:#e8eee7}#mapTopControls{position:fixed;top:72px;right:0;width:170px;height:40px;background:white;z-index:75}#detailSection{display:none}#detailSection.open{display:block;position:fixed;right:12px;top:120px;width:min(300px,95%);padding:8px;background:#fff;z-index:80}.pin{display:grid;place-items:center;background:#275dd8}.marker{cursor:pointer}@media(max-width:760px){#detailSection.open{top:auto;bottom:12px}}'+css+'</style></head><body class="approvedShellCandidate"><div id="map"></div><div id="mapTopControls"><button id="mapReset">전체보기</button></div><div id="mobileWorkspace"></div><div id="detailSection"><div id="detail"></div><div id="staffAuxContent"></div></div><div id="vehicleList"><input type="checkbox" value="101"><input type="checkbox" value="122"></div><select id="mobileBaseVehicle"><option value=""></option><option>101</option><option>122</option></select></body></html>';
const browser=await chromium.launch({headless:true,executablePath:process.env.OPSMAP_TEST_CHROMIUM||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const checks=[];
try{
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:844}});
  const errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  await page.setContent(markup);
  await page.addScriptTag({content:policy});await page.addScriptTag({content:fixture});
  const seed=(data,kind,config)=>page.evaluate(({data,kind,config})=>harness.seed(data,kind,config),{data,kind,config});
  const stats=()=>page.evaluate(()=>harness.stats());
  const click=async(index=0)=>{
   const {x,y,width,height}=await page.locator('[data-fixture-pin="'+index+'"] .pin').boundingBox();
   await page.mouse.click(x+width/2,y+height/2);
  };
  const chooser=page.locator('#detailSection #mapStoreChoice');
  const clusterOptions=page.locator('#detailSection [data-cluster-code]');
  const assertCase=(name,condition)=>{assert(condition,width+' '+name);checks.push(width+' '+name);};
  const route=[rows[0],rows[2],{...rows[2],customerCode:'FAR',lat:35.15,lng:129.1},
   {...rows[2],customerCode:'UNLOCATED',lat:null,lng:null}];
  await seed(route,'route');
  assert.equal(await page.locator('[data-fixture-pin="0"] .pin').evaluate(node=>node.offsetWidth),40);
  await click();
  let result=await stats();
  assert.deepEqual(result.filter,['101']);assert.equal(result.mobile,'101');
  assert.deepEqual(result.filterWrites,[{values:['101'],options:{keepRoadRoute:true}}]);assert.deepEqual(result.refresh,[false]);
  assert.equal(result.loads,1);assert.equal(result.drilledBaseVehicle,'101');
  assert.deepEqual(result.moves[0].points,route.slice(0,3).map(({lat,lng})=>({lat,lng})));
  assertCase('standalone route fits every verified coordinate once and preserves unlocated input',
   result.moves.length===1&&result.moves[0].type==='bounds'&&result.level<11&&result.source.length===4&&await chooser.count()===0);
  await seed(rows.slice(0,1),'route');
  await click();
  result=await stats();
  assert.deepEqual(result.moves,[{type:'jump',level:5,point:{lat:37.5,lng:127},options:{animate:false}}]);
  assertCase('one-point route uses one unanimated zoom',true);
  await seed(rows,'overview',{level:13,filter:'122'});
  await click();
  result=await stats();
  assertCase('pixel bundle zooms past overview without changing the filter',
   result.level===9&&result.moves.length===1&&result.filter[0]==='122'&&result.filterWrites.length===0&&await chooser.count()===0);
  await seed([rows[0],rows[2]],'region',{level:7,filter:'122'});
  await click();
  result=await stats();
  assertCase('geographic group zooms without opening a side list',
   result.level===5&&result.moves.length===1&&result.filter[0]==='122'&&await chooser.count()===0);
  await seed(rows.slice(0,2),'location',{level:5});
  await click();
  assertCase('exact coordinates use the existing right card',await chooser.isVisible()&&await clusterOptions.count()===2&&(await stats()).moves.length===0);
  await chooser.selectOption('S00000');assert.equal((await stats()).selection.code,'S00000');
  await chooser.selectOption('S00001');assert.equal((await stats()).selection.code,'S00001');
  await page.getByRole('button',{name:'닫기',exact:true}).click();
  await click();await chooser.selectOption('S00000');
  assertCase('second store selection and reopening work at the same pin',await chooser.count()===1&&(await stats()).selection.code==='S00000');
  await page.evaluate(()=>harness.userGesture());
  await chooser.selectOption('S00001');
  assertCase('manual movement revokes deferred card recentering',(await stats()).lastPinFocus===null);
  await page.screenshot({path:path.join(out,width===390?'mobile.png':'desktop.png')});
  await seed(rows,'adjacent',{level:5});
  await click(1);
  assertCase('adjacent pin remains reachable under an overlapping group', (await stats()).selection.code==='S00002');
  await click(0);
  assertCase('adjacent pin cannot intercept the exact-location pin centre',await clusterOptions.count()===2);
  await seed(rows.slice(0,2),'overlaid',{level:5});
  await click(1);
  assertCase('navigation pin above a group exposes both customer codes',await clusterOptions.count()===2&&(await stats()).nav[0]==='S00000');
  await seed(route,'route',{temporary:true,filter:'122'});
  await click();
  result=await stats();
  assertCase('temporary inspection preserves its filter, pin and camera',result.filter[0]==='122'&&result.temporary.searchTemporary&&
   result.moves.length===0&&await chooser.isVisible());
  await seed(rows.slice(0,1),'nearby',{temporary:true,filter:'122'});
  await click();
  assertCase('nearby route inspection is independent of the filter',(await stats()).filter[0]==='122'&&(await stats()).moves.length===0);
  const dated=rows.slice(0,2).map((row,index)=>({...row,customerCode:rows[0].customerCode,deliveryId:'DELIVERY-'+index,order:index+1}));
  await seed(dated,'location',{dated:true,level:5});
  await click();
  await chooser.selectOption('DELIVERY-1');
  assertCase('same customer code on distinct dated visits keeps the delivery ID',(await stats()).selection.id==='DELIVERY-1');
  await seed([rows[0],{...rows[2],lng:127.7}],'individual',{level:5});
  await click(0);await click(1);
  assertCase('two selected pins retain their colors and last pin owns centering',
   await page.locator('[aria-pressed="true"].marker').count()===2&&(await stats()).lastPinFocus.key==='store:S00002');
  await click(1);
  assertCase('a repeat click clears only its own highlight',await page.locator('[aria-pressed="true"].marker').count()===1);
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  await page.close();
 }
 console.log(JSON.stringify({result:'PASS',scope:'Chrome/Chromium synthetic SDK; real Kakao map not exercised',checks:checks.length,details:checks,artifacts:out},null,2));
}finally{await browser.close();}
