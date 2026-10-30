import {buildBaseTerritories} from './territory-policy.mjs';
const bridge=window.MapUiLocalBridge,$=s=>document.querySelector(s),button=$('#areaToggle');
let enabled=false,busy=false,epoch=0,model=null,polygons=[],renderKey='',draws=0,requests=0;
const clear=()=>{for(const p of polygons)p.setMap(null);polygons=[];renderKey='';};
function status(text){const label=$('#territoryStatus');if(label)label.textContent=text;button.title=text;button.textContent=!enabled?'기준호차 권역선 OFF':model?.version?`기준호차 권역선 ON (${polygons.length})`:'기준호차 권역 미확인';button.setAttribute('aria-pressed',String(enabled&&!!model?.version));button.dataset.geometryCount=String(polygons.length);}
function renderForSelection(){
 if(bridge.state.mode!=='BASE_60D'){clear();status('기준호차 권역선은 매장·권역 지도에서 조회합니다.');return;}
 if(!enabled||!model||!bridge.state.map)return;
 const master=bridge.fixedTerritoryMasterState?.();if(master&&(master.stale||master.version!==model.version)){clear();model=null;status('기준호차 자료 변경·만료 · 권역을 다시 확인해 주세요.');return;}
 const selected=bridge.state.selectedVehicles,key=JSON.stringify([model.version,selected,bridge.state.centerFilter,bridge.state.mode]);if(key===renderKey)return;
 clear();renderKey=key;draws++;
 const groups=model.groups.filter(g=>(!selected.length||selected.includes(g.vehicle))&&(!bridge.state.centerFilter||g.center===bridge.state.centerFilter));
 for(const g of groups){if(g.state!=='ready'||!['osan','yeongnam','honam'].includes(g.center))continue;const color=window.Phase2bUi.vehicleColor(g.vehicle);const p=new kakao.maps.Polygon({path:g.boundary.map(p=>new kakao.maps.LatLng(p.lat,p.lng)),strokeWeight:2,strokeColor:color,strokeOpacity:.8,fillColor:color,fillOpacity:.09});p.setMap(bridge.state.map);polygons.push(p);}
 const list=$('#territoryVehicles');if(list){list.replaceChildren();for(const g of groups){const item=document.createElement('li');item.textContent=g.vehicle+'호차 · '+(g.reason==='CENTER_UNCONFIRMED'?'센터 미확인':g.state==='ready'?g.locatedCount+'개 기준 매장':'미확인 · 좌표 3곳 이상 필요');list.append(item);}}
 status(groups.length?`고정배차 기준 · ${polygons.length}개 호차 표시${groups.some(g=>g.state!=='ready')?' · 일부 좌표 미확인':''}`:'확인된 기준호차 자료가 없습니다.');
}
async function load(){
 if(busy||bridge.state.mode!=='BASE_60D')return;
 busy=true;button.disabled=true;const id=++epoch;status('기준호차 확인 중');
 try{
  if(typeof bridge.fixedTerritoryStores!=='function')throw Error('TERRITORY_BINDING_MISSING');
  const master=bridge.fixedTerritoryMasterState?.();if(master?.version&&master.stale)throw Error('TERRITORY_MASTER_STALE');
  if(typeof bridge.loadBaseVehicleMasterForTerritory==='function'){requests++;await bridge.loadBaseVehicleMasterForTerritory();}
  if(id!==epoch||bridge.state.mode!=='BASE_60D')return;
  model=buildBaseTerritories(bridge.fixedTerritoryStores());if(!model.version)throw Error('TERRITORY_MASTER_UNVERIFIED');button.dataset.territoryStatus='VERIFIED_MASTER';renderForSelection();
 }catch(error){if(id===epoch){clear();model=null;button.dataset.territoryStatus=error?.message==='TERRITORY_MASTER_STALE'?'TERRITORY_MASTER_STALE':'TERRITORY_UNCONFIRMED';status(error?.message==='TERRITORY_MASTER_STALE'?'기준호차 이전 확인값 · 최신 권역선 미확인':'기준호차·좌표 검증자료 미확인 · 실제 배차를 권역으로 사용하지 않습니다.');}}
 finally{if(id===epoch){busy=false;button.disabled=false;}}
}
async function toggle(){if(bridge.state.mode!=='BASE_60D')return;enabled=!enabled;bridge.state.areaOn=false;if(!enabled){epoch++;busy=false;button.disabled=false;clear();status('고정배차 기준 권역');return;}await load();}
button.onclick=toggle;button.disabled=false;const refresh=$('#refreshTerritories');if(refresh)refresh.onclick=()=>{if(bridge.state.mode!=='BASE_60D')return;enabled=true;model=null;clear();void load();};
const logout=()=>{epoch++;enabled=false;busy=false;model=null;clear();button.disabled=false;$('#territoryVehicles')?.replaceChildren();status('고정배차 기준 권역');};
window.addEventListener('map-navigation-logout',logout);window.addEventListener('pagehide',e=>{if(e.persisted)return;logout();window.removeEventListener('map-navigation-logout',logout);});
window.MapTerritoryUi=Object.freeze({toggle,renderForSelection,refresh:load,state:()=>({enabled,busy,vehicles:model?.groups.map(g=>({vehicle:g.vehicle,state:g.state,locatedCount:g.locatedCount}))||[],source:'FIXED_DISPATCH_PRIMARY',version:model?.version||null,polygons:polygons.length,draws,requests})});status('고정배차 기준 권역');
