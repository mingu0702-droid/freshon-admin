import {buildBaseTerritories,baseTerritoryAvailability} from './territory-policy.mjs';
const bridge=window.MapUiLocalBridge,$=s=>document.querySelector(s),button=$('#areaToggle');
const buttons=[button,$('#mobileAreaToggle')].filter(Boolean);
let enabled=false,busy=false,epoch=0,model=null,polygons=[],renderKey='',draws=0,requests=0,availability=null,lastReason=null,boundaryData=null;
let lookupData=null,lookupKey='',queryKey='',listeningMap=null;
const pointKey=p=>p.lat+','+p.lng;
function queryPlan(){
 const stores=bridge.fixedTerritoryStores(),base=buildBaseTerritories(stores),all=[...new Map(base.groups.flatMap(g=>g.points).map(p=>[pointKey(p),{lat:p.lat,lng:p.lng}])).values()];
 const selected=bridge.state.selectedVehicles||[],center=bridge.state.centerFilter,bounds=bridge.state.map?.getBounds?.(),sw=bounds?.getSouthWest?.(),ne=bounds?.getNorthEast?.();
 const box=sw&&ne?[sw.getLng(),sw.getLat(),ne.getLng(),ne.getLat()]:null;
 const points=[...new Map(base.groups.filter(g=>(!selected.length||selected.includes(g.vehicle))&&(!center||g.center===center)).flatMap(g=>g.points).filter(p=>!box||p.lng>=box[0]&&p.lat>=box[1]&&p.lng<=box[2]&&p.lat<=box[3]).map(p=>[pointKey(p),{lat:p.lat,lng:p.lng}])).values()];
 return {stores,base,all,points,lookupKey:JSON.stringify(all),key:JSON.stringify([base.version,selected,center,box,points])};
}
function completeAvailability(plan){
 if(!availability||!lookupData)return;
 const joins=new Map(lookupData.matches.map(j=>[pointKey(plan.all[j.index]),j.adminCodes]));
 const selected=bridge.state.selectedVehicles||[],center=bridge.state.centerFilter;
 for(const v of availability.vehicles){const group=plan.base.groups.find(g=>g.vehicle===v.vehicle);if(!group){if(!availability.reason)v.reason='MASTER_ASSIGNMENT_UNVERIFIED';continue;}const codes=new Set();v.matchedCount=0;for(const p of group.points){const matches=joins.get(pointKey(p))||[];if(matches.length)v.matchedCount++;for(const c of matches)codes.add(c);}v.adminCount=codes.size;v.displayedAdminCount=model?.groups.find(g=>g.vehicle===v.vehicle)?.features.length||0;
  if(!availability.reason&&group.center&&v.matchedCount){if(selected.length&&!selected.includes(v.vehicle)){v.state='unconfirmed';v.reason='VEHICLE_NOT_SELECTED';}else if(center&&group.center!==center){v.state='unconfirmed';v.reason='CENTER_FILTERED';}else if(!v.displayedAdminCount){v.state='unconfirmed';v.reason='OUTSIDE_VIEWPORT';}}
 }
 availability.totalVehicleCount=availability.vehicles.length;
 availability.displayedVehicleCount=availability.vehicles.filter(v=>v.state==='ready'&&!v.reason).length;
 availability.unshownReasons=Object.fromEntries([...new Set(availability.vehicles.filter(v=>v.state!=='ready').map(v=>v.reason||'UNCONFIRMED'))].map(reason=>[reason,availability.vehicles.filter(v=>(v.reason||'UNCONFIRMED')===reason).length]));
}
let label=$('#territoryStatus');if(!label){label=document.createElement('p');label.id='territoryStatus';label.setAttribute('role','status');($('#periodFilterPanel')||button.parentElement).append(label);}
const diagnostics=document.createElement('output');diagnostics.id='territoryDiagnostics';diagnostics.hidden=true;label.after(diagnostics);
const reasons={ADMIN_BOUNDARIES_QUERY_TOO_WIDE:'조회 지역이 넓습니다. 지도를 확대하거나 호차를 선택해 주세요',ADMIN_BOUNDARIES_UNAVAILABLE:'공식 읍면동 경계 자료가 없습니다',ADMIN_BOUNDARIES_INVALID:'공식 읍면동 경계 검증에 실패했습니다',ADMIN_BOUNDARY_NO_MATCH:'선택 호차의 검증 좌표에 해당하는 공식 경계가 없습니다',OUTSIDE_VIEWPORT:'현재 지도 범위에 해당 호차의 검증 매장이 없습니다',MASTER_STALE:'기준호차가 이전 확인값입니다',MASTER_UNAVAILABLE:'현재 기준호차 자료가 없습니다',MASTER_UNVERIFIED:'현재 기준호차 검증자료가 없습니다',MASTER_VERSION_CHANGED:'기준호차 자료가 변경됐습니다',SOURCE_AUTH_REQUIRED:'기준호차 조회 권한을 확인해 주세요',SOURCE_UNAVAILABLE:'기준호차 자료를 조회하지 못했습니다',SDK_UNAVAILABLE:'지도 연결을 확인해 주세요'};
const unavailable=()=>`${reasons[lastReason||availability?.reason]||'선택 호차의 센터·좌표 근거가 부족합니다'}${availability?.checkedAt?' ('+availability.checkedAt+' 기준)':''} · 실제 경계를 확인한 지역만 표시합니다.`;
const clear=()=>{for(const p of polygons)p.setMap(null);polygons=[];renderKey='';};
function status(text){label.textContent=text;label.hidden=!enabled;for(const b of buttons){b.textContent=!enabled?'기준호차 권역선 OFF':busy?'기준호차 확인 중':polygons.length?`기준호차 권역선 ON (${polygons.length})`:'기준호차 권역 미확인';b.setAttribute('aria-pressed',String(enabled));b.disabled=busy;b.dataset.geometryCount=String(polygons.length);b.dataset.territoryReason=lastReason||availability?.reason||'';b.title=text;b.dataset.territoryStatus=(lastReason||availability?.reason)==='MASTER_STALE'?'TERRITORY_MASTER_STALE':polygons.length?'VERIFIED_ADMIN_BOUNDARY':'TERRITORY_UNCONFIRMED';}diagnostics.textContent=JSON.stringify({enabled,busy,polygons:polygons.length,...availability,reason:lastReason||availability?.reason||null});}
function renderForSelection(){
 if(bridge.state.mode!=='BASE_60D'){clear();status('기준호차 권역선은 매장·권역 지도에서 조회합니다.');return;}
 if(!enabled)return;
 const plan=queryPlan();if(queryKey!==plan.key){if(busy){clear();return;}return load();}
 const current=bridge.fixedTerritoryMasterState?.();
 if((!model||model.version!==current?.version)&&current?.stale===false){
  try{const stores=bridge.fixedTerritoryStores(),candidate=buildBaseTerritories(stores,boundaryData);availability=baseTerritoryAvailability(stores,current,candidate);
   if(!availability.reason){clear();model=candidate;lastReason=null;}
  }catch{clear();model=null;lastReason='MASTER_VERSION_CHANGED';status(unavailable());return;}
 }
 if(!model){status(unavailable());return;}
 availability=baseTerritoryAvailability(plan.stores,current,model);completeAvailability(plan);
 if(!bridge.state.map||typeof kakao==='undefined'||typeof kakao.maps?.Polygon!=='function'){clear();lastReason='SDK_UNAVAILABLE';status(unavailable());return;}
 const master=bridge.fixedTerritoryMasterState?.();if(!master||master.stale!==false||master.version!==model.version){clear();lastReason=master?.stale!==false?'MASTER_STALE':'MASTER_VERSION_CHANGED';model=null;status(unavailable());return;}
 const selected=bridge.state.selectedVehicles,key=JSON.stringify([model.version,selected,bridge.state.centerFilter,bridge.state.mode,queryKey]);if(key===renderKey)return;
 clear();renderKey=key;draws++;
 lastReason=null;const groups=model.groups.filter(g=>(!selected.length||selected.includes(g.vehicle))&&(!bridge.state.centerFilter||g.center===bridge.state.centerFilter));
 if(!groups.some(g=>g.state==='ready'))lastReason=availability?.vehicles.find(v=>groups.some(g=>g.vehicle===v.vehicle))?.reason||groups[0]?.reason||'ADMIN_BOUNDARY_NO_MATCH';
 for(const g of groups){if(g.state!=='ready'||!['osan','yeongnam','honam'].includes(g.center))continue;const color=window.Phase2bUi.vehicleColor(g.vehicle);for(const feature of g.features){const geometry=feature.geometry,parts=geometry.type==='MultiPolygon'?geometry.coordinates:[geometry.coordinates];for(const rings of parts){const p=new kakao.maps.Polygon({path:rings.map(ring=>ring.map(([lng,lat])=>new kakao.maps.LatLng(lat,lng))),strokeWeight:2,strokeColor:color,strokeOpacity:.8,fillColor:color,fillOpacity:.09});p.setMap(bridge.state.map);polygons.push(p);}}}
 const list=$('#territoryVehicles');if(list){list.replaceChildren();for(const g of groups){const item=document.createElement('li');item.textContent=g.vehicle+'호차 · '+(g.reason==='CENTER_UNCONFIRMED'?'센터 미확인':g.state==='ready'?g.features.length+'개 행정 읍면동 · '+g.matchedCount+'개 기준 매장'+(g.sharedAdminCodes.length?' · 공동 담당 '+g.sharedAdminCodes.length+'곳':'')+(g.matchedCount<g.storeCount?' · 일부 좌표·경계 미확인':''):'미확인 · 공식 경계·검증 좌표 필요');list.append(item);}}
 status(polygons.length?`전체 ${availability.totalVehicleCount}개 호차 · 현재 지도 ${availability.displayedVehicleCount}개 호차 표시 · 공식 행정 읍면동 경계 (2025-06-30)${groups.some(g=>g.state!=='ready'||g.matchedCount<g.storeCount)?' · 일부 센터·좌표·경계 미확인':''}`:unavailable());
}
async function load(){
 if(busy||bridge.state.mode!=='BASE_60D')return;
 busy=true;lastReason=null;const id=++epoch;status('기준호차 확인 중');
 try{
  if(typeof bridge.fixedTerritoryStores!=='function')throw Error('TERRITORY_BINDING_MISSING');
  const current=bridge.fixedTerritoryMasterState?.();
  if(!current?.version&&typeof bridge.loadBaseVehicleMasterForTerritory==='function'){requests++;await bridge.loadBaseVehicleMasterForTerritory();}
  if(id!==epoch||bridge.state.mode!=='BASE_60D')return;
  const plan=queryPlan(),master=bridge.fixedTerritoryMasterState?.();
  if(listeningMap!==bridge.state.map&&bridge.state.map&&typeof kakao!=='undefined'&&kakao.maps?.event?.addListener){listeningMap=bridge.state.map;kakao.maps.event.addListener(listeningMap,'idle',()=>{if(enabled&&bridge.state.mode==='BASE_60D')renderForSelection();});}
  async function query(points,geometry){requests++;const response=await fetch('/api/map-phase2b/private/admin-boundaries/query',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({points,geometry})});if(!response.ok)throw Object.assign(Error(response.status===413?'ADMIN_BOUNDARIES_QUERY_TOO_WIDE':'ADMIN_BOUNDARIES_UNAVAILABLE'),{status:response.status});return (await response.json()).data;}
  if(lookupKey!==plan.lookupKey){const result=await query(plan.all,false);if(id!==epoch||bridge.state.mode!=='BASE_60D')return;lookupData=result;lookupKey=plan.lookupKey;}
  if(!boundaryData||queryKey!==plan.key){clear();model=null;availability=baseTerritoryAvailability(plan.stores,master,buildBaseTerritories(plan.stores,lookupData));completeAvailability(plan);const result=await query(plan.points,true);if(id!==epoch||bridge.state.mode!=='BASE_60D')return;boundaryData=result;queryKey=plan.key;}
  if(queryPlan().key!==plan.key){queryKey='';return;}
  model=master?.stale===false?buildBaseTerritories(plan.stores,boundaryData):null;availability=baseTerritoryAvailability(plan.stores,master,model);completeAvailability(plan);
  if(availability.reason){clear();model=null;status(unavailable());return;}renderForSelection();
 }catch(error){if(id===epoch){clear();model=null;lastReason=[401,403].includes(error?.status)?'SOURCE_AUTH_REQUIRED':['ADMIN_BOUNDARIES_QUERY_TOO_WIDE','ADMIN_BOUNDARIES_UNAVAILABLE'].includes(error?.message)?error.message:'SOURCE_UNAVAILABLE';if(availability){for(const v of availability.vehicles){if(v.reason==='OUTSIDE_VIEWPORT'){v.reason=lastReason;v.state='unconfirmed';}}availability.displayedVehicleCount=0;availability.unshownReasons=Object.fromEntries([...new Set(availability.vehicles.map(v=>v.reason||lastReason))].map(reason=>[reason,availability.vehicles.filter(v=>(v.reason||lastReason)===reason).length]));}status(unavailable());}}
 finally{if(id===epoch){busy=false;status(polygons.length?label.textContent:unavailable());if(!lastReason&&enabled&&queryKey!==queryPlan().key)void load();}}
}
async function toggle(){if(bridge.state.mode!=='BASE_60D')return;enabled=!enabled;bridge.state.areaOn=false;if(!enabled){epoch++;busy=false;button.disabled=false;clear();status('고정배차 기준 권역');return;}await load();}
for(const b of buttons){b.onclick=toggle;b.disabled=false;}const refresh=$('#refreshTerritories');if(refresh)refresh.onclick=()=>{if(bridge.state.mode!=='BASE_60D')return;enabled=true;model=null;clear();void load();};
const logout=()=>{epoch++;enabled=false;busy=false;model=null;availability=null;lastReason=null;boundaryData=null;lookupData=null;lookupKey='';queryKey='';clear();$('#territoryVehicles')?.replaceChildren();status('고정배차 기준 권역');};
const coordinatesChanged=()=>{if(!enabled)return;model=null;clear();return renderForSelection();};
window.addEventListener('map-coordinate-updated',coordinatesChanged);
window.addEventListener('map-navigation-logout',logout);window.addEventListener('pagehide',e=>{if(e.persisted)return;logout();window.removeEventListener('map-navigation-logout',logout);window.removeEventListener('map-coordinate-updated',coordinatesChanged);});
window.MapTerritoryUi=Object.freeze({toggle,renderForSelection,refresh:load,state:()=>({enabled,busy,vehicles:availability?.vehicles||[],totalVehicleCount:availability?.totalVehicleCount||availability?.vehicles.length||0,displayedVehicleCount:availability?.displayedVehicleCount||0,unshownReasons:availability?.unshownReasons||{},reason:lastReason||availability?.reason||null,source:'FIXED_DISPATCH_PRIMARY',boundarySource:boundaryData?.metadata||lookupData?.metadata||null,partialCoverage:(boundaryData?.metadata||lookupData?.metadata)?.partialCoverage!==false,checkedAt:availability?.checkedAt||null,version:availability?.version||null,polygons:polygons.length,draws,requests})});status('고정배차 기준 권역');
