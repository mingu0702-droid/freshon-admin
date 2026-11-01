import {buildBaseTerritories,baseTerritoryAvailability} from './territory-policy.mjs';
const bridge=window.MapUiLocalBridge,$=s=>document.querySelector(s),button=$('#areaToggle');
const buttons=[button,$('#mobileAreaToggle')].filter(Boolean);
let enabled=false,busy=false,epoch=0,model=null,polygons=[],renderKey='',draws=0,requests=0,availability=null,lastReason=null;
let label=$('#territoryStatus');if(!label){label=document.createElement('p');label.id='territoryStatus';label.setAttribute('role','status');($('#periodFilterPanel')||button.parentElement).append(label);}
const diagnostics=document.createElement('output');diagnostics.id='territoryDiagnostics';diagnostics.hidden=true;label.after(diagnostics);
const reasons={MASTER_STALE:'기준호차가 이전 확인값입니다',MASTER_UNAVAILABLE:'현재 기준호차 자료가 없습니다',MASTER_UNVERIFIED:'현재 기준호차 검증자료가 없습니다',MASTER_VERSION_CHANGED:'기준호차 자료가 변경됐습니다',SOURCE_AUTH_REQUIRED:'기준호차 조회 권한을 확인해 주세요',SOURCE_UNAVAILABLE:'기준호차 자료를 조회하지 못했습니다',SDK_UNAVAILABLE:'지도 연결을 확인해 주세요'};
const unavailable=()=>`${reasons[lastReason||availability?.reason]||'선택 호차의 센터·좌표 근거가 부족합니다'}${availability?.checkedAt?' ('+availability.checkedAt+' 기준)':''} · 이전 배차를 현재 권역으로 표시하지 않습니다.`;
const clear=()=>{for(const p of polygons)p.setMap(null);polygons=[];renderKey='';};
function status(text){label.textContent=text;label.hidden=!enabled;for(const b of buttons){b.textContent=!enabled?'기준호차 권역선 OFF':busy?'기준호차 확인 중':polygons.length?`기준호차 권역선 ON (${polygons.length})`:'기준호차 권역 미확인';b.setAttribute('aria-pressed',String(enabled));b.disabled=busy;b.dataset.geometryCount=String(polygons.length);b.dataset.territoryReason=lastReason||availability?.reason||'';b.title=text;b.dataset.territoryStatus=(lastReason||availability?.reason)==='MASTER_STALE'?'TERRITORY_MASTER_STALE':model?'VERIFIED_MASTER':'TERRITORY_UNCONFIRMED';}diagnostics.textContent=JSON.stringify({enabled,busy,polygons:polygons.length,...availability,reason:lastReason||availability?.reason||null});}
function renderForSelection(){
 if(bridge.state.mode!=='BASE_60D'){clear();status('기준호차 권역선은 매장·권역 지도에서 조회합니다.');return;}
 if(!enabled)return;
 if(!model){status(unavailable());return;}
 if(!bridge.state.map||typeof kakao==='undefined'||typeof kakao.maps?.Polygon!=='function'){clear();lastReason='SDK_UNAVAILABLE';status(unavailable());return;}
 const master=bridge.fixedTerritoryMasterState?.();if(!master||master.stale!==false||master.version!==model.version){clear();lastReason=master?.stale!==false?'MASTER_STALE':'MASTER_VERSION_CHANGED';model=null;status(unavailable());return;}
 const selected=bridge.state.selectedVehicles,key=JSON.stringify([model.version,selected,bridge.state.centerFilter,bridge.state.mode]);if(key===renderKey)return;
 clear();renderKey=key;draws++;
 const groups=model.groups.filter(g=>(!selected.length||selected.includes(g.vehicle))&&(!bridge.state.centerFilter||g.center===bridge.state.centerFilter));
 for(const g of groups){if(g.state!=='ready'||!['osan','yeongnam','honam'].includes(g.center))continue;const color=window.Phase2bUi.vehicleColor(g.vehicle);const p=new kakao.maps.Polygon({path:g.boundary.map(p=>new kakao.maps.LatLng(p.lat,p.lng)),strokeWeight:2,strokeColor:color,strokeOpacity:.8,fillColor:color,fillOpacity:.09});p.setMap(bridge.state.map);polygons.push(p);}
 const list=$('#territoryVehicles');if(list){list.replaceChildren();for(const g of groups){const item=document.createElement('li');item.textContent=g.vehicle+'호차 · '+(g.reason==='CENTER_UNCONFIRMED'?'센터 미확인':g.state==='ready'?g.locatedCount+'개 기준 매장':'미확인 · 좌표 3곳 이상 필요');list.append(item);}}
 status(polygons.length?`고정배차 기준 · ${polygons.length}개 호차 표시${groups.some(g=>g.state!=='ready')?' · 일부 센터·좌표 미확인':''}`:unavailable());
}
async function load(){
 if(busy||bridge.state.mode!=='BASE_60D')return;
 busy=true;lastReason=null;const id=++epoch;status('기준호차 확인 중');
 try{
  if(typeof bridge.fixedTerritoryStores!=='function')throw Error('TERRITORY_BINDING_MISSING');
  const current=bridge.fixedTerritoryMasterState?.();
  if(!current?.version&&typeof bridge.loadBaseVehicleMasterForTerritory==='function'){requests++;await bridge.loadBaseVehicleMasterForTerritory();}
  if(id!==epoch||bridge.state.mode!=='BASE_60D')return;
  const stores=bridge.fixedTerritoryStores(),master=bridge.fixedTerritoryMasterState?.();model=master?.stale===false?buildBaseTerritories(stores):null;availability=baseTerritoryAvailability(stores,master,model);
  if(availability.reason){clear();model=null;status(unavailable());return;}renderForSelection();
 }catch(error){if(id===epoch){clear();model=null;lastReason=[401,403].includes(error?.status)?'SOURCE_AUTH_REQUIRED':'SOURCE_UNAVAILABLE';status(unavailable());}}
 finally{if(id===epoch){busy=false;status(polygons.length?`검증된 기준호차 ${polygons.length}개 권역 표시`:unavailable());}}
}
async function toggle(){if(bridge.state.mode!=='BASE_60D')return;enabled=!enabled;bridge.state.areaOn=false;if(!enabled){epoch++;busy=false;button.disabled=false;clear();status('고정배차 기준 권역');return;}await load();}
for(const b of buttons){b.onclick=toggle;b.disabled=false;}const refresh=$('#refreshTerritories');if(refresh)refresh.onclick=()=>{if(bridge.state.mode!=='BASE_60D')return;enabled=true;model=null;clear();void load();};
const logout=()=>{epoch++;enabled=false;busy=false;model=null;availability=null;lastReason=null;clear();$('#territoryVehicles')?.replaceChildren();status('고정배차 기준 권역');};
window.addEventListener('map-navigation-logout',logout);window.addEventListener('pagehide',e=>{if(e.persisted)return;logout();window.removeEventListener('map-navigation-logout',logout);});
window.MapTerritoryUi=Object.freeze({toggle,renderForSelection,refresh:load,state:()=>({enabled,busy,vehicles:availability?.vehicles||[],reason:lastReason||availability?.reason||null,source:'FIXED_DISPATCH_PRIMARY',checkedAt:availability?.checkedAt||null,version:availability?.version||null,polygons:polygons.length,draws,requests})});status('고정배차 기준 권역');
