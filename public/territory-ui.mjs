import {createHybridMapClient} from './hybrid-map-client.mjs';
import {recentTerritoryRange,buildTerritories} from './territory-policy.mjs';
const bridge=window.MapUiLocalBridge,$=s=>document.querySelector(s),button=$('#areaToggle');
let client,enabled=false,busy=false,epoch=0,model=null,polygons=[],renderKey='',draws=0,requests=0;
const clear=()=>{for(const p of polygons)p.setMap(null);polygons=[];renderKey='';};
function status(text){$('#territoryStatus').textContent=text;button.textContent=!enabled?'전체 권역선 OFF':model?`전체 권역선 ON (${polygons.length})`:'권역선 미확정';button.setAttribute('aria-pressed',String(enabled&&!!model));button.dataset.geometryCount=String(polygons.length);}
function renderForSelection(){
 if(!enabled||!model||!bridge.state.map)return;
 const selected=bridge.state.selectedVehicles,key=JSON.stringify([model.version,selected,bridge.state.centerFilter,bridge.state.mode]);if(key===renderKey)return;
 clear();renderKey=key;draws++;
 const visible=bridge.state.centerFilter?new Set(bridge.state.currentRows.map(p=>p.customerCode)):null;
 const groups=model.groups.filter(g=>(!selected.length||selected.includes(g.vehicle))&&(!visible||g.points.some(p=>visible.has(p.customerCode))));
 for(const g of groups){if(g.state!=='ready')continue;const color=window.Phase2bUi.vehicleColor(g.vehicle);const p=new kakao.maps.Polygon({path:g.boundary.map(p=>new kakao.maps.LatLng(p.lat,p.lng)),strokeWeight:2,strokeColor:color,strokeOpacity:.8,fillColor:color,fillOpacity:.09});p.setMap(bridge.state.map);polygons.push(p);}
 const list=$('#territoryVehicles');list.replaceChildren();for(const g of groups){const item=document.createElement('li');item.textContent=g.vehicle+'호차 · '+(g.state==='ready'?g.locatedCount+'개 배송지':'미확정 · 좌표 3곳 이상 필요');list.append(item);}
 status(groups.length?`최근 10일 · ${model.range.startDate} ~ ${model.range.endDate} · ${polygons.length}개 호차 표시${groups.some(g=>g.state!=='ready')?' · 일부 미확정':''}`:'선택 조건의 배송자료가 없습니다.');
}
async function load(){if(busy)return;
 if(window.MAP_TERRITORY_CONFIG?.approved!==true||window.MAP_TERRITORY_CONFIG?.rule!=='LATEST_CONFIRMED_VISITS_HULL_V1'||!window.MAP_TERRITORY_CONFIG?.sourceVersion){status('권역 미확정 · 기준 확인이 필요합니다.');return;}busy=true;button.disabled=true;const id=++epoch;status('최근 배송자료 불러오는 중');try{
 client?.dispose();client=createHybridMapClient();client.onCacheChange(e=>{if(e?.type==='publication'&&model){model=null;clear();status('게시자료 변경 · 권역을 새로고침해 주세요.');}});requests++;const c=await client.openDateCatalog();if(id!==epoch)return;const range=recentTerritoryRange(c.completedThrough),facts=[];let complete=false;for await(const page of client.readPeriod(range)){if(id!==epoch)return;if(page.meta.verified!==true||page.meta.status==='MISSING')throw Error('TERRITORY_INCOMPLETE');facts.push(...page.data);complete=page.meta.aggregateComplete===true;if(facts.length>200000)throw Error('TERRITORY_LIMIT');}
 if(!complete)throw Error('TERRITORY_INCOMPLETE');
 if(id!==epoch)return;model={version:c.version,range,groups:buildTerritories(facts,bridge.navigationStores(),range)};renderForSelection();
 }catch{if(id===epoch){clear();model=null;status('권역 미확정 · 배송자료를 다시 불러와 주세요.');}}finally{if(id===epoch){busy=false;button.disabled=false;}}}
async function toggle(){enabled=!enabled;bridge.state.areaOn=false;if(!enabled){epoch++;busy=false;client?.cancel();button.disabled=false;clear();status('최근 10일 배송지 기준');return;}if(model)renderForSelection();else await load();}
button.onclick=toggle;button.disabled=false;$('#refreshTerritories').onclick=()=>{if(!enabled){enabled=true;}model=null;clear();void load();};
const logout=()=>{epoch++;enabled=false;busy=false;model=null;clear();client?.dispose();button.disabled=false;$('#territoryVehicles').replaceChildren();status('최근 10일 배송지 기준');};
window.addEventListener('map-navigation-logout',logout);window.addEventListener('pagehide',e=>{if(e.persisted)return;logout();window.removeEventListener('map-navigation-logout',logout);});
window.MapTerritoryUi=Object.freeze({toggle,renderForSelection,refresh:load,state:()=>({enabled,busy,vehicles:model?.groups.map(g=>({vehicle:g.vehicle,state:g.state,locatedCount:g.locatedCount}))||[],range:model?.range,polygons:polygons.length,draws,requests})});status('최근 10일 배송지 기준');

