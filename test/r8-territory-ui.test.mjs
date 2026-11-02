import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {buildBaseTerritories,baseTerritoryAvailability} from '../public/opsmap/territory-policy.mjs';
import {boundaries} from './fixtures/admin-boundaries.mjs';
import {prepareAdminBoundaries,matchingAdminFeatures} from '../public/opsmap/admin-boundaries.mjs';
const version='a'.repeat(64),rows=(vehicle='101',center='osan')=>[[37.1,127.1],[37.2,127.1],[37.1,127.2]].map(([lat,lng],i)=>({customerCode:'S'+vehicle+i,baseVehicle:vehicle,baseVehicleGroup:center,baseVehicleState:'VERIFIED_MASTER',baseVehicleSource:'FIXED_DISPATCH_PRIMARY',baseVehicleVersion:version,baseVehicleStale:false,lat,lng}));
function fixture({stores=rows(),stale=false,fail=null,boundaryFailure=null,geometryFailure=null,boundaryPayload=boundaries,box=null,refreshMaster=null,level=8,checkedAt='2026-09-24T00:00:00Z',now=Date.now()}={}){
 const nodes=new Map(),polys=[],events=new Map(),queries=[],timers=new Map();let reads=0,clock=now,timerId=0;class ClockDate extends Date{static now(){return clock;}}
 class Element{constructor(){this.children=[];this.attrs={};this.dataset={};this.hidden=false;this.parentElement=this;this.textContent='';}set id(v){this._id=v;nodes.set('#'+v,this);}get id(){return this._id;}append(e){this.children.push(e);}after(e){this.parentElement.append(e);}replaceChildren(){this.children=[];}setAttribute(k,v){this.attrs[k]=v;}}
 for(const id of ['areaToggle','mobileAreaToggle','periodFilterPanel','territoryVehicles']){const e=new Element();e.id=id;}
 const master={version,stale,checkedAt},state={mode:'BASE_60D',selectedVehicles:[],centerFilter:'',map:{getLevel:()=>level,getBounds:()=>box?{getSouthWest:()=>({getLng:()=>box[0],getLat:()=>box[1]}),getNorthEast:()=>({getLng:()=>box[2],getLat:()=>box[3]})}:null},areaOn:false};
 const bridge={state,fixedTerritoryStores:()=>stores,fixedTerritoryMasterState:()=>master,loadBaseVehicleMasterForTerritory:async()=>{reads++;if(fail)throw Object.assign(Error(),{status:fail});await refreshMaster?.(master,stores);}};
 const window={MapUiLocalBridge:bridge,Phase2bUi:{vehicleColor:v=>'color-'+v},addEventListener:(n,fn)=>events.set(n,fn),removeEventListener(){}};
 const kakao={maps:{LatLng:function(lat,lng){this.lat=lat;this.lng=lng;},Polygon:class{constructor(options){this.options=options;polys.push(this);}setMap(map){this.map=map;}}}};
 const document={querySelector:s=>nodes.get(s)||null,createElement:()=>new Element()};
 vm.runInNewContext(fs.readFileSync(new URL('../public/opsmap/territory-ui.mjs',import.meta.url),'utf8').replace(/^import[^\n]+\n/,''),{window,document,kakao,Date:ClockDate,setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,at:clock+ms});return id;},clearTimeout:id=>timers.delete(id),buildBaseTerritories,baseTerritoryAvailability,fetch:async(url,options)=>{assert.equal(url,'/api/map-phase2b/private/admin-boundaries/query');assert.equal(options.method,'POST');const body=JSON.parse(options.body);queries.push(body);const prepared=prepareAdminBoundaries(boundaryPayload),features=new Map(),matches=body.points.map((p,index)=>{const found=matchingAdminFeatures(p,prepared);for(const f of found)features.set(f.properties.adm_cd,f);return {index,adminCodes:found.map(f=>f.properties.adm_cd)};});const failure=boundaryFailure||(body.geometry?geometryFailure:null);return {ok:!failure,status:failure||200,json:async()=>({data:{...boundaryPayload,metadata:{...boundaryPayload.metadata,coverage:'QUERY',displayDetail:body.geometry?body.detail:null,...(body.geometry&&body.detail==='overview'?{geometryRole:'DISPLAY_ONLY',pointJoinGeometry:'FULL_RESOLUTION'}:{})},...(body.geometry&&body.detail==='overview'?{queryPoints:body.points}:{}),features:body.geometry?[...features.values()]:[],matches}})};}});
 return {nodes,polys,state,master,events,stores,queries,setBox:value=>{box=value;},setLevel:value=>{level=value;},advanceTime:ms=>{clock+=ms;for(const [id,timer] of [...timers])if(timer.at<=clock){timers.delete(id);timer.fn();}},flush:async()=>{for(let i=0;i<20&&window.MapTerritoryUi.state().busy;i++)await new Promise(resolve=>setImmediate(resolve));},timers,ui:window.MapTerritoryUi,reads:()=>reads};
}
test('stale master cannot draw current polygons and the missing HTML status is visibly created',async()=>{
 const f=fixture({stale:true});await f.ui.toggle();assert.equal(f.ui.state().polygons,0);assert.equal(f.ui.state().reason,'MASTER_STALE');assert.equal(f.reads(),1);assert.equal(f.nodes.get('#territoryStatus').hidden,false);assert.match(f.nodes.get('#territoryStatus').textContent,/2026-09-24/);assert.match(f.nodes.get('#territoryStatus').textContent,/이전 확인값/);assert.equal(f.ui.state().vehicles[0].reason,'MASTER_STALE');
});

test('an existing stale version reuses the master loader once and draws only after it confirms freshness',async()=>{
 const f=fixture({stale:true,refreshMaster:master=>{assert.equal(master.version,version);master.stale=false;master.checkedAt='2026-11-03T00:00:00Z';}});
 await f.ui.toggle();assert.equal(f.reads(),1);assert.equal(f.ui.state().polygons,1);assert.equal(f.ui.state().reason,null);assert.equal(f.ui.state().checkedAt,'2026-11-03T00:00:00Z');await f.ui.renderForSelection();assert.equal(f.reads(),1);
});

test('manual refresh retries an existing stale version once without automatic repeated master reads',async()=>{
 let attempt=0;const f=fixture({stale:true,refreshMaster:master=>{if(++attempt===2)master.stale=false;}});
 await f.ui.toggle();assert.equal(f.reads(),1);assert.equal(f.ui.state().reason,'MASTER_STALE');await f.ui.renderForSelection();assert.equal(f.reads(),1);
 f.advanceTime(60000);await f.ui.refresh();assert.equal(f.reads(),2);assert.equal(f.ui.state().reason,null);assert.equal(f.ui.state().polygons,1);await f.ui.renderForSelection();assert.equal(f.reads(),2);
});

test('overlapping stale refreshes share the active UI load and remain unconfirmed if the cache is still stale',async()=>{
 let finish;const f=fixture({stale:true,refreshMaster:()=>new Promise(resolve=>{finish=resolve;})});const pending=f.ui.toggle();
 await f.ui.refresh();assert.equal(f.reads(),1);assert.equal(f.ui.state().polygons,0);finish();await pending;assert.equal(f.reads(),1);assert.equal(f.ui.state().reason,'MASTER_STALE');assert.equal(f.ui.state().vehicles[0].reason,'MASTER_STALE');await f.ui.renderForSelection();assert.equal(f.reads(),1);
});

test('a missing master version still uses the existing loader once',async()=>{
 const f=fixture({refreshMaster:master=>{master.version=version;}});f.master.version=null;await f.ui.toggle();assert.equal(f.reads(),1);assert.equal(f.ui.state().polygons,1);
});
test('fresh verified master creates exact vehicle polygons; OFF removes only those polygons',async()=>{
 const f=fixture();await f.ui.toggle();assert.equal(f.ui.state().polygons,1);assert.equal(f.reads(),0);assert.equal(f.polys[0].options.strokeColor,'color-101');const map=f.state.map;await f.ui.toggle();assert.equal(f.ui.state().polygons,0);assert.equal(f.polys[0].map,null);assert.equal(f.state.map,map);
});
test('single/multiple vehicle and center selection filter boundaries without moving or clearing pins',async()=>{
 const f=fixture({stores:[...rows(),...rows('122','yeongnam')]});await f.ui.toggle();assert.equal(f.ui.state().polygons,2);f.state.selectedVehicles=['122'];await f.ui.renderForSelection();assert.equal(f.ui.state().polygons,1);assert.equal(f.polys.at(-1).options.strokeColor,'color-122');f.state.centerFilter='osan';await f.ui.renderForSelection();assert.equal(f.ui.state().polygons,0);
});
test('mobile and desktop controls share one toggle owner and checked state',async()=>{
 const f=fixture();await f.nodes.get('#mobileAreaToggle').onclick();assert.equal(f.ui.state().polygons,1);assert.equal(f.nodes.get('#areaToggle').attrs['aria-pressed'],'true');assert.equal(f.nodes.get('#mobileAreaToggle').attrs['aria-pressed'],'true');await f.nodes.get('#areaToggle').onclick();assert.equal(f.ui.state().polygons,0);assert.equal(f.nodes.get('#mobileAreaToggle').attrs['aria-pressed'],'false');
});
test('version or staleness change invalidates existing polygons immediately',async()=>{
 const f=fixture();await f.ui.toggle();f.master.version='b'.repeat(64);await f.ui.renderForSelection();assert.equal(f.ui.state().polygons,0);assert.equal(f.ui.state().reason,'MASTER_VERSION_CHANGED');
});
test('source auth denial remains distinct from insufficient locations and cannot draw',async()=>{
 const f=fixture({stale:true,fail:403});await f.ui.toggle();assert.equal(f.ui.state().polygons,0);assert.equal(f.ui.state().reason,'SOURCE_AUTH_REQUIRED');assert.equal(f.reads(),1);assert.match(f.nodes.get('#territoryStatus').textContent,/권한/);
});
test('same selection render reuses polygons and mode switch removes polygons only',async()=>{
 const f=fixture();await f.ui.toggle();const n=f.polys.length;await f.ui.renderForSelection();assert.equal(f.polys.length,n);f.state.mode='DATE_ROUTE';await f.ui.renderForSelection();assert.equal(f.ui.state().polygons,0);assert.equal(f.state.map!==null,true);
});
test('missing centers and conflicting GPS remain unconfirmed',()=>{
 for(const stores of [rows('101','unknown'),rows().map(r=>({...r,coordinateStatus:'CONFLICT'}))]){const model=buildBaseTerritories(stores,boundaries),a=baseTerritoryAvailability(stores,{version,stale:false},model);assert.equal(a.vehicles[0].state,'unconfirmed');assert.ok(a.vehicles[0].reason);}
});

// Resume-only boundaries: new source availability must not require another remote read.
test('fresh source arriving after stale rejection builds boundaries on the next render without refetch',async()=>{
 const f=fixture({stale:true});await f.ui.toggle();assert.equal(f.ui.state().polygons,0);f.master.stale=false;await f.ui.renderForSelection();assert.equal(f.ui.state().polygons,1);assert.equal(f.ui.state().reason,null);assert.equal(f.reads(),1);
});
test('manual coordinate event rebuilds only territory geometry while preserving the map and pin owner',async()=>{
 const f=fixture();await f.ui.toggle();const previous=f.polys[0],map=f.state.map;f.stores[0].lat=37.05;await f.events.get('map-coordinate-updated')();assert.equal(previous.map,null);assert.equal(f.ui.state().polygons,1);assert.equal(f.state.map,map);assert.equal(f.polys.at(-1).options.path[0][0].lat,37);assert.equal(f.polys.at(-1).options.path[0][0].lng,127);assert.equal(f.reads(),0);
});
test('four selected verified vehicles draw independently and center changes remove only excluded boundaries',async()=>{
 const stores=[...rows('101'),...rows('122'),...rows('172'),...rows('202','yeongnam')],f=fixture({stores});f.state.selectedVehicles=['101','122','172','202'];await f.ui.toggle();assert.equal(f.ui.state().polygons,4);f.state.centerFilter='osan';await f.ui.renderForSelection();assert.equal(f.ui.state().polygons,3);assert.equal(f.state.selectedVehicles.length,4);
});
test('source refresh error is safe metadata and does not upgrade historical source evidence',()=>{
 const a=baseTerritoryAvailability(rows(),{version,stale:true,lastError:'FIXED_MASTER_FORBIDDEN',refresh:'ERROR'});assert.equal(a.reason,'MASTER_STALE');assert.equal(a.sourceError,'FIXED_MASTER_FORBIDDEN');assert.equal(a.refresh,'ERROR');assert(a.vehicles.every(g=>g.state==='unconfirmed'));
 const b=baseTerritoryAvailability(rows(),{version,stale:true,lastError:'unsafe source response'});assert.equal(b.sourceError,null);
});


test('missing official geometry never turns three customer points into a territory',async()=>{
 const f=fixture({boundaryFailure:503});await f.ui.toggle();assert.equal(f.ui.state().polygons,0);assert.equal(f.ui.state().reason,'ADMIN_BOUNDARIES_UNAVAILABLE');assert.match(f.nodes.get('#territoryStatus').textContent,/공식 읍면동 경계/);
});
test('one verified GPS is sufficient for a real administrative polygon and shared responsibility stays visible',async()=>{
 const f=fixture({stores:[rows('101')[0],rows('122')[0]]});await f.ui.toggle();assert.equal(f.ui.state().polygons,2);assert.deepEqual(f.polys.map(p=>p.options.strokeColor),['color-101','color-122']);assert.match(f.nodes.get('#territoryVehicles').children[0].textContent,/공동 담당/);
});
test('GPS outside bundled subset stays unconfirmed with explicit coverage reason',async()=>{
 const f=fixture({stores:rows().map(r=>({...r,lat:35,lng:128}))});await f.ui.toggle();assert.equal(f.ui.state().polygons,0);assert.equal(f.ui.state().reason,'ADMIN_BOUNDARY_NO_MATCH');assert.equal(f.ui.state().partialCoverage,true);
});

test('Kakao receives separate islands and complete nested outer/hole paths',async()=>{
 const data=structuredClone(boundaries),outer=[[127,37],[127.5,37],[127.5,37.5],[127,37.5],[127,37]],hole=[[127.3,37.3],[127.4,37.3],[127.4,37.4],[127.3,37.4],[127.3,37.3]],island=[[128,37],[128.1,37],[128.1,37.1],[128,37.1],[128,37]];
 data.features[0].geometry={type:'MultiPolygon',coordinates:[[outer,hole],[island]]};
 const f=fixture({boundaryPayload:data});await f.ui.toggle();assert.equal(f.ui.state().polygons,2);assert.equal(f.polys[0].options.path.length,2);assert.equal(f.polys[0].options.path[1].length,hole.length);assert.equal(f.polys[1].options.path[0][0].lng,128);
});

test('viewport geometry stays regional while all-vehicle counts and offscreen reasons remain complete',async()=>{
 const data=structuredClone(boundaries);const east=structuredClone(data.features[0]);east.properties.adm_cd='11010540';east.geometry.coordinates[0]=east.geometry.coordinates[0].map(([x,y])=>[x+1,y]);data.features.push(east);
 const f=fixture({boundaryPayload:data,stores:[rows('101')[0],{...rows('122')[0],lng:128.1}],box:[127,37,127.5,37.5]});await f.ui.toggle();
 assert.equal(f.queries[0].geometry,false);assert.equal(f.queries[0].points.length,2);assert.equal(f.queries[1].geometry,true);assert.equal(f.queries[1].points.length,1);assert.equal(f.ui.state().totalVehicleCount,2);assert.equal(f.ui.state().displayedVehicleCount,1);assert.equal(f.ui.state().vehicles.find(v=>v.vehicle==='122').reason,'OUTSIDE_VIEWPORT');
 const n=f.queries.length;await f.ui.renderForSelection();assert.equal(f.queries.length,n);
 f.setBox([128,37,128.5,37.5]);await f.ui.renderForSelection();assert.equal(f.queries.length,n+1);assert.equal(f.queries.at(-1).points[0].lng,128.1);assert.equal(f.ui.state().vehicles.find(v=>v.vehicle==='101').reason,'OUTSIDE_VIEWPORT');assert.equal(f.ui.state().displayedVehicleCount,1);
});

test('wide geometry rejection keeps all vehicles counted and asks for a smaller map region',async()=>{
 const f=fixture({stores:[rows('101')[0],rows('122')[0]],geometryFailure:413});await f.ui.toggle();assert.equal(f.ui.state().polygons,0);assert.equal(f.ui.state().totalVehicleCount,2);assert.equal(f.ui.state().reason,'ADMIN_BOUNDARIES_QUERY_TOO_WIDE');assert.equal(f.ui.state().unshownReasons.ADMIN_BOUNDARIES_QUERY_TOO_WIDE,2);assert.match(f.nodes.get('#territoryStatus').textContent,/확대/);
});

test('national zoom draws all selected vehicles with overview and switches to exact geometry on zoom in',async()=>{
 const f=fixture({stores:[rows('101')[0],rows('122')[0]],level:12});await f.ui.toggle();assert.equal(f.queries[0].geometry,false);assert.equal(f.queries[1].detail,'overview');assert.equal(f.ui.state().totalVehicleCount,2);assert.equal(f.ui.state().displayedVehicleCount,2);assert.equal(f.ui.state().polygons,2);assert.equal(f.ui.state().boundarySource.geometryRole,'DISPLAY_ONLY');assert.match(f.nodes.get('#territoryStatus').textContent,/전국 보기/);
 const n=f.queries.length;f.setLevel(8);await f.ui.renderForSelection();assert.equal(f.queries.length,n+1);assert.equal(f.queries.at(-1).detail,'detail');assert.equal(f.ui.state().displayedVehicleCount,2);assert.equal(f.ui.state().polygons,2);assert.equal(f.ui.state().boundarySource.geometryRole,undefined);
});

test('a recent verified reference remains visible while preserving stale and checkedAt source evidence',async()=>{
 const checkedAt='2026-11-02T18:28:48.039Z',stores=rows().map(r=>({...r,baseVehicleStale:true,baseVehicleCheckedAt:checkedAt})),f=fixture({stores,stale:true,checkedAt,now:Date.parse(checkedAt)+3600000});const before=structuredClone(stores);
 await f.ui.toggle();assert.equal(f.ui.state().polygons,1);assert.equal(f.ui.state().currentness,'VERIFIED_SNAPSHOT_REFRESHING');assert.equal(f.ui.state().stale,true);assert.equal(f.ui.state().checkedAt,checkedAt);assert.equal(f.ui.state().reason,null);assert.equal(f.nodes.get('#areaToggle').dataset.territoryStatus,'VERIFIED_SNAPSHOT_REFRESHING');assert.match(f.nodes.get('#areaToggle').textContent,/^확인본 권역선 ON/);assert.match(f.nodes.get('#mobileAreaToggle').textContent,/^확인본 권역선 ON/);assert.match(f.nodes.get('#territoryStatus').textContent,/마지막 검증본 기준 · 최신 원천 확인 중/);assert.deepEqual(stores,before);assert.equal(f.reads(),1);assert.equal(f.timers.size,1);
 f.state.selectedVehicles=['101'];await f.ui.renderForSelection();f.setBox([127,37,127.4,37.4]);await f.ui.renderForSelection();await f.ui.refresh();assert.equal(f.reads(),1);assert.equal(f.ui.state().polygons,1);
 f.advanceTime(60000);await f.ui.refresh();assert.equal(f.reads(),2);assert.equal(f.ui.state().currentness,'VERIFIED_SNAPSHOT_REFRESHING');
});

test('reference visibility expires after 24h and source-version changes stay blocked',async()=>{
 const checkedAt='2026-11-02T18:28:48.039Z',stores=rows().map(r=>({...r,baseVehicleStale:true,baseVehicleCheckedAt:checkedAt})),f=fixture({stores,stale:true,checkedAt,now:Date.parse(checkedAt)+86400000-10});
 await f.ui.toggle();assert.equal(f.ui.state().polygons,1);f.advanceTime(11);await f.flush();await f.ui.renderForSelection();await f.flush();assert.equal(f.ui.state().polygons,0);assert.equal(f.ui.state().reason,'MASTER_STALE');assert.equal(f.ui.state().currentness,'UNCONFIRMED');
 const g=fixture({stores,stale:true,checkedAt,now:Date.parse(checkedAt)+3600000});await g.ui.toggle();assert.equal(g.ui.state().polygons,1);g.master.version='b'.repeat(64);await g.ui.renderForSelection();assert.equal(g.ui.state().polygons,0);assert.equal(g.ui.state().reason,'MASTER_STALE');
});

test('a newly current source removes the reference label without changing source rows',async()=>{
 const checkedAt='2026-11-02T18:28:48.039Z',stores=rows().map(r=>({...r,baseVehicleStale:true,baseVehicleCheckedAt:checkedAt})),f=fixture({stores,stale:true,checkedAt,now:Date.parse(checkedAt)+3600000});await f.ui.toggle();assert.equal(f.ui.state().currentness,'VERIFIED_SNAPSHOT_REFRESHING');
 f.master.stale=false;for(const r of stores)r.baseVehicleStale=false;await f.ui.renderForSelection();assert.equal(f.ui.state().polygons,1);assert.equal(f.ui.state().currentness,'CURRENT_VERIFIED_MASTER');assert.equal(f.ui.state().stale,false);assert.doesNotMatch(f.nodes.get('#territoryStatus').textContent,/마지막 검증본/);assert.equal(f.timers.size,0);assert.match(f.nodes.get('#areaToggle').textContent,/^기준호차 권역선 ON/);
});
