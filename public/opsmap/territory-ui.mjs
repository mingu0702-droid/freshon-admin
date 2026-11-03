import {buildBaseTerritories,baseTerritoryAvailability} from './territory-policy.mjs';
const bridge=window.MapUiLocalBridge,$=s=>document.querySelector(s),button=$('#areaToggle');
const buttons=[button,$('#mobileAreaToggle')].filter(Boolean);
let enabled=false,busy=false,epoch=0,model=null,polygons=[],renderKey='',draws=0,requests=0,availability=null,lastReason=null,boundaryData=null;
let lookupData=null,lookupKey='',queryKey='',listeningMap=null,lastMasterCheck=-Infinity,referenceExpiry=null,referenceExpiryKey='';
let activeKey='',activeLoad=null,controller=null,idleTimer=null,refreshState='IDLE';
const polygonEntries=new Map(),geometryCache=new Map(),metadataCache=new Map();
const counters={created:0,reused:0,removed:0,cacheHits:0,cacheMisses:0,aborted:0,idleEvents:0,renderMs:0,totalRenderMs:0};
const now=()=>typeof performance!=='undefined'?performance.now():Date.now();
const pointKey=p=>p.lat+','+p.lng;
const referenceState='VERIFIED_SNAPSHOT_REFRESHING';
function territoryModel(stores,boundaries=null,master=bridge.fixedTerritoryMasterState?.()){return buildBaseTerritories(stores,boundaries,{now:Date.now(),referenceMaster:master?.stale===true?{version:master.version,checkedAt:master.checkedAt,source:'FIXED_DISPATCH_PRIMARY'}:null});}
const available=(stores,master,model)=>baseTerritoryAvailability(stores,master,model,{now:Date.now()});
function syncReferenceExpiry(){
 const reference=enabled&&availability?.currentness===referenceState?model?.referenceMaster:null,key=reference?reference.version+':'+reference.checkedAt:'';
 if(key===referenceExpiryKey)return;
 if(referenceExpiry!==null&&typeof clearTimeout==='function')clearTimeout(referenceExpiry);referenceExpiry=null;referenceExpiryKey=key;
 if(key&&typeof setTimeout==='function')referenceExpiry=setTimeout(()=>{referenceExpiry=null;referenceExpiryKey='';if(enabled){clear();model=null;void load();}},Math.max(1,Date.parse(reference.checkedAt)+86400001-Date.now()));
}
function queryPlan(){
 const stores=bridge.fixedTerritoryStores(),base=territoryModel(stores),all=[...new Map(base.groups.flatMap(g=>g.points).map(p=>[pointKey(p),{lat:p.lat,lng:p.lng}])).values()];
 const selected=bridge.state.selectedVehicles||[],center=bridge.state.centerFilter,bounds=bridge.state.map?.getBounds?.(),sw=bounds?.getSouthWest?.(),ne=bounds?.getNorthEast?.();
 const box=sw&&ne?[sw.getLng(),sw.getLat(),ne.getLng(),ne.getLat()]:null;
 const points=[...new Map(base.groups.filter(g=>(!selected.length||selected.includes(g.vehicle))&&(!center||g.center===center)).flatMap(g=>g.points).filter(p=>!box||p.lng>=box[0]&&p.lat>=box[1]&&p.lng<=box[2]&&p.lat<=box[3]).map(p=>[pointKey(p),{lat:p.lat,lng:p.lng}])).values()];
 const detail=(bridge.state.map?.getLevel?.()||0)>=9?'overview':'detail';
 return {stores,base,all,points,detail,lookupKey:JSON.stringify([base.version,all]),key:JSON.stringify([base.version,base.currentness,[...selected].sort(),center,points,detail])};
}
function completeAvailability(plan){
 // Match indices belong to the exact queried coordinate set, not a later mode's rows.
 if(!availability||!lookupData||lookupKey!==plan.lookupKey)return;
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
const clear=()=>{for(const p of polygons){p.setMap(null);counters.removed++;}polygons=[];polygonEntries.clear();renderKey='';};
function cancelLoad(){epoch++;controller?.abort();controller=null;busy=false;activeKey='';activeLoad=null;if(idleTimer!==null)clearTimeout(idleTimer);idleTimer=null;}
function stopListening(){if(listeningMap&&typeof kakao!=='undefined')kakao.maps?.event?.removeListener?.(listeningMap,'idle',onIdle);listeningMap=null;}
function onIdle(){counters.idleEvents++;if(idleTimer!==null)clearTimeout(idleTimer);if(enabled&&bridge.state.mode==='BASE_60D')idleTimer=setTimeout(()=>{idleTimer=null;if(enabled)void renderForSelection();},180);}
function listen(){if(listeningMap===bridge.state.map)return;stopListening();if(bridge.state.map&&typeof kakao!=='undefined'&&kakao.maps?.event?.addListener){listeningMap=bridge.state.map;kakao.maps.event.addListener(listeningMap,'idle',onIdle);}}
function status(text){label.textContent=text;label.hidden=!enabled;for(const b of buttons){b.textContent=!enabled?'기준호차 권역선 OFF':busy?'기준호차 확인 중':polygons.length?`${refreshState==='FAILED'?'검증 경계':availability?.currentness===referenceState?'확인본':'기준호차'} 권역선 ON (${polygons.length})`:availability?.currentness===referenceState?'확인본 권역 미표시':'기준호차 권역 미확인';b.setAttribute('aria-pressed',String(enabled));b.disabled=false;b.dataset.geometryCount=String(polygons.length);b.dataset.territoryReason=lastReason||availability?.reason||'';b.title=text;b.dataset.territoryStatus=(lastReason||availability?.reason)==='MASTER_STALE'?'TERRITORY_MASTER_STALE':polygons.length?refreshState==='FAILED'?'VERIFIED_GEOMETRY_REFRESH_FAILED':availability?.currentness===referenceState?referenceState:'VERIFIED_ADMIN_BOUNDARY':'TERRITORY_UNCONFIRMED';}diagnostics.textContent=JSON.stringify({enabled,busy,polygons:polygons.length,refreshState,...availability,reason:lastReason||availability?.reason||null});}
function renderModel(plan){
 const started=now(),selected=bridge.state.selectedVehicles||[],groups=model.groups.filter(g=>(!selected.length||selected.includes(g.vehicle))&&(!bridge.state.centerFilter||g.center===bridge.state.centerFilter));
 const desired=new Map(),detail=boundaryData?.metadata.displayDetail||plan.detail;
 if(!groups.some(g=>g.state==='ready'))lastReason=availability?.vehicles.find(v=>groups.some(g=>g.vehicle===v.vehicle))?.reason||groups[0]?.reason||'ADMIN_BOUNDARY_NO_MATCH';
 for(const g of groups){if(g.state!=='ready'||!['osan','yeongnam','honam'].includes(g.center))continue;for(const feature of g.features){const code=feature.properties.adm_cd;if(!desired.has(code))desired.set(code,{feature,owners:[]});desired.get(code).owners.push(g.vehicle);}}
 const keep=new Set();let changed=false;
 for(const [code,{feature,owners}] of desired){const color=window.Phase2bUi.vehicleColor(owners[0]),geometry=feature.geometry,parts=geometry.type==='MultiPolygon'?geometry.coordinates:[geometry.coordinates];
  for(let part=0;part<parts.length;part++){const key=JSON.stringify([model.version,detail,code,part]),previous=polygonEntries.get(key);keep.add(key);
   if(previous&&previous.geometry===geometry&&previous.map===bridge.state.map&&previous.color===color){previous.owners=owners;counters.reused++;continue;}
   if(previous){previous.polygon.setMap(null);counters.removed++;}
   const p=new kakao.maps.Polygon({path:parts[part].map(ring=>ring.map(([lng,lat])=>new kakao.maps.LatLng(lat,lng))),strokeWeight:2,strokeColor:color,strokeOpacity:.8,fillColor:color,fillOpacity:.09});p.setMap(bridge.state.map);polygonEntries.set(key,{polygon:p,geometry,color,owners,map:bridge.state.map});counters.created++;changed=true;
  }
 }
 for(const [key,entry] of polygonEntries)if(!keep.has(key)){entry.polygon.setMap(null);polygonEntries.delete(key);counters.removed++;changed=true;}
 polygons=[...polygonEntries.values()].map(entry=>entry.polygon);if(changed)draws++;
 const list=$('#territoryVehicles');if(list){list.replaceChildren();for(const g of groups){const item=document.createElement('li');item.textContent=g.vehicle+'호차 · '+(g.reason==='CENTER_UNCONFIRMED'?'센터 미확인':g.state==='ready'?g.features.length+'개 행정 읍면동 · '+g.matchedCount+'개 기준 매장'+(g.sharedAdminCodes.length?' · 공동 담당 '+g.sharedAdminCodes.length+'곳':'')+(g.matchedCount<g.storeCount?' · 일부 좌표·경계 미확인':''):'미확인 · 공식 경계·검증 좌표 필요');list.append(item);}}
 counters.renderMs=Math.max(0,now()-started);counters.totalRenderMs+=counters.renderMs;
}
function displayStatus(){
 const retained=polygons.length&&refreshState!=='IDLE';
 status(polygons.length?`${retained?refreshState==='FAILED'?'마지막 검증 경계 유지 · 경계 재조회 실패 · ':'마지막 검증 경계 유지 · 경계 갱신 중 · ':''}${availability.currentness===referenceState?'마지막 검증본 기준 · 최신 원천 확인 중 · ':''}전체 ${availability.totalVehicleCount}개 호차 · 현재 지도 ${availability.displayedVehicleCount}개 호차 표시 · 공식 행정 읍면동 경계 (2025-06-30)${boundaryData?.metadata.displayDetail==='overview'?' · 전국 보기':''}${lastReason?' · '+(reasons[lastReason]||'미확인'):''}`:unavailable());
}
function usable(plan){
 if(!model)return false;
 const master=bridge.fixedTerritoryMasterState?.(),check=available(plan.stores,master,model);
 if(check.reason){clear();model=null;availability=check;lastReason=check.reason;syncReferenceExpiry();return false;}
 availability=check;completeAvailability(plan);syncReferenceExpiry();return true;
}
function renderForSelection(){
 if(bridge.state.mode!=='BASE_60D'){cancelLoad();stopListening();clear();status('기준호차 권역선은 매장·권역 지도에서 조회합니다.');return;}
 if(!enabled)return;
 let plan;try{plan=queryPlan();}catch{cancelLoad();clear();model=null;lastReason='MASTER_VERSION_CHANGED';status(unavailable());return;}
 if(busy&&activeKey!==plan.key){counters.aborted++;cancelLoad();refreshState='IDLE';lastReason=null;}
 listen();
 if(!bridge.state.map||typeof kakao==='undefined'||typeof kakao.maps?.Polygon!=='function'){clear();lastReason='SDK_UNAVAILABLE';status(unavailable());return;}
 if(usable(plan)){
  const master=bridge.fixedTerritoryMasterState?.();
  if(model.currentness!==plan.base.currentness){const candidate=territoryModel(plan.stores,boundaryData,master);if(!available(plan.stores,master,candidate).reason){model=candidate;availability=available(plan.stores,master,model);completeAvailability(plan);syncReferenceExpiry();}}
  const key=JSON.stringify([model.version,model.currentness,plan.key]);if(key!==renderKey){renderModel(plan);renderKey=key;}displayStatus();
 }
 if(queryKey!==plan.key||!model)return load();
}
function lookupCodes(plan,points){const joins=new Map(lookupData.matches.map(join=>[pointKey(plan.all[join.index]),join.adminCodes]));return [...new Set(points.flatMap(point=>joins.get(pointKey(point))||[]))].sort();}
function cachedBoundary(plan,version,codes){
 const metadata=metadataCache.get(version+':'+plan.detail)||{...lookupData.metadata,displayDetail:plan.detail,...(plan.detail==='overview'?{geometryRole:'DISPLAY_ONLY',pointJoinGeometry:'FULL_RESOLUTION'}:{})};
 const features=codes.map(code=>geometryCache.get(version+':'+plan.detail+':'+code));
 const data={type:'FeatureCollection',metadata,features};
 if(plan.detail==='overview'){const joins=new Map(lookupData.matches.map(join=>[pointKey(plan.all[join.index]),join.adminCodes]));data.queryPoints=plan.points;data.matches=plan.points.map((point,index)=>({index,adminCodes:joins.get(pointKey(point))||[]}));}
 return data;
}
function validateLookup(data,count){
 validateBoundary(data);const seen=new Set();
 if(!Array.isArray(data.matches)||data.matches.length!==count)throw Error('ADMIN_BOUNDARIES_INVALID');
 for(const join of data.matches){if(!Number.isInteger(join?.index)||join.index<0||join.index>=count||seen.has(join.index)||!Array.isArray(join.adminCodes)||join.adminCodes.some(code=>typeof code!=='string'||!/^\d{8}$/.test(code)))throw Error('ADMIN_BOUNDARIES_INVALID');seen.add(join.index);}
}
function validateBoundary(data){if(territoryModel([],data,null).boundaryReason)throw Error('ADMIN_BOUNDARIES_INVALID');}
function load(){
 if(!enabled||bridge.state.mode!=='BASE_60D')return;
 let initial;try{initial=queryPlan();}catch{return renderForSelection();}
 if(busy&&activeKey===initial.key)return activeLoad;
 if(busy){counters.aborted++;cancelLoad();}
 const id=++epoch;controller=typeof AbortController==='function'?new AbortController():null;const signal=controller?.signal;
 activeKey=initial.key;busy=true;lastReason=null;refreshState='REFRESHING';listen();if(usable(initial))displayStatus();else status('기준호차 확인 중');
 const valid=()=>id===epoch&&enabled&&bridge.state.mode==='BASE_60D';
 activeLoad=(async()=>{try{
  if(typeof bridge.fixedTerritoryStores!=='function')throw Error('TERRITORY_BINDING_MISSING');
  const current=bridge.fixedTerritoryMasterState?.();
  if((!current?.version||current.stale===true)&&Date.now()-lastMasterCheck>=60000&&typeof bridge.loadBaseVehicleMasterForTerritory==='function'){lastMasterCheck=Date.now();requests++;await bridge.loadBaseVehicleMasterForTerritory();}
  if(!valid())return;
  const plan=queryPlan(),master=bridge.fixedTerritoryMasterState?.();activeKey=plan.key;
  async function query(points,geometry){requests++;const response=await fetch('/api/map-phase2b/private/admin-boundaries/query',{method:'POST',credentials:'same-origin',cache:'no-store',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({points,geometry,detail:geometry?plan.detail:'detail'})});if(!response.ok)throw Object.assign(Error(response.status===413?'ADMIN_BOUNDARIES_QUERY_TOO_WIDE':'ADMIN_BOUNDARIES_UNAVAILABLE'),{status:response.status});return (await response.json()).data;}
  if(lookupKey!==plan.lookupKey){const result=await query(plan.all,false);if(!valid())return;validateLookup(result,plan.all.length);lookupData=result;lookupKey=plan.lookupKey;}
  const codes=lookupCodes(plan,plan.points),prefix=master?.version+':'+plan.detail+':',missing=codes.filter(code=>!geometryCache.has(prefix+code));counters.cacheHits+=codes.length-missing.length;counters.cacheMisses+=missing.length;
  if(missing.length){const needed=new Set(missing),joins=new Map(lookupData.matches.map(join=>[pointKey(plan.all[join.index]),join.adminCodes])),points=plan.points.filter(point=>(joins.get(pointKey(point))||[]).some(code=>needed.has(code))),result=await query(points,true);if(!valid())return;validateBoundary(result);
   if(missing.some(code=>!result.features.some(feature=>feature.properties.adm_cd===code)))throw Error('ADMIN_BOUNDARIES_INVALID');
   metadataCache.set(master?.version+':'+plan.detail,result.metadata);
   for(const feature of result.features){const key=prefix+feature.properties.adm_cd;if(!geometryCache.has(key))geometryCache.set(key,feature);}
   while(geometryCache.size>8000)geometryCache.delete(geometryCache.keys().next().value);
   while(metadataCache.size>8)metadataCache.delete(metadataCache.keys().next().value);
  }
  if(!valid())return;
  if(queryPlan().key!==plan.key){activeKey='';return;}
  const data=cachedBoundary(plan,master?.version,codes),candidate=territoryModel(plan.stores,data,master),check=available(plan.stores,master,candidate);
  if(check.reason){availability=check;lastReason=check.reason;clear();model=null;syncReferenceExpiry();status(unavailable());return;}
  boundaryData=data;model=candidate;availability=check;queryKey=plan.key;completeAvailability(plan);syncReferenceExpiry();lastReason=null;refreshState='IDLE';renderKey='';renderForSelection();
 }catch(error){if(valid()&&error?.name!=='AbortError'){
  lastReason=[401,403].includes(error?.status)?'SOURCE_AUTH_REQUIRED':['ADMIN_BOUNDARIES_QUERY_TOO_WIDE','ADMIN_BOUNDARIES_UNAVAILABLE','ADMIN_BOUNDARIES_INVALID'].includes(error?.message)?error.message:'SOURCE_UNAVAILABLE';refreshState='FAILED';
  if([401,403].includes(error?.status)){clear();model=null;geometryCache.clear();metadataCache.clear();}
  let plan;try{plan=queryPlan();}catch{clear();model=null;lastReason='MASTER_VERSION_CHANGED';status(unavailable());return;}
  if(usable(plan))displayStatus();else{availability=available(plan.stores,bridge.fixedTerritoryMasterState?.(),territoryModel(plan.stores,lookupData));completeAvailability(plan);if(availability)for(const v of availability.vehicles){if(!v.reason||v.reason==='OUTSIDE_VIEWPORT'||v.reason==='ADMIN_BOUNDARY_NO_MATCH'){v.reason=lastReason;v.state='unconfirmed';}}if(availability){availability.displayedVehicleCount=0;availability.unshownReasons=Object.fromEntries([...new Set(availability.vehicles.map(v=>v.reason||lastReason))].map(reason=>[reason,availability.vehicles.filter(v=>(v.reason||lastReason)===reason).length]));}status(unavailable());}
 }}finally{if(valid()){busy=false;controller=null;activeLoad=null;activeKey='';if(polygons.length)displayStatus();else status(unavailable());if(refreshState!=='FAILED'&&enabled&&!lastReason){let next;try{next=queryPlan();}catch{clear();model=null;lastReason='MASTER_VERSION_CHANGED';status(unavailable());}if(next&&queryKey!==next.key)void load();}}}})();
 return activeLoad;
}
async function toggle(){if(bridge.state.mode!=='BASE_60D')return;enabled=!enabled;bridge.state.areaOn=false;if(!enabled){cancelLoad();stopListening();clear();refreshState='IDLE';syncReferenceExpiry();status('고정배차 기준 권역');return;}await load();}
for(const b of buttons){b.onclick=toggle;b.disabled=false;}const refresh=$('#refreshTerritories');if(refresh)refresh.onclick=()=>{if(bridge.state.mode!=='BASE_60D')return;enabled=true;void load();};
const logout=()=>{cancelLoad();stopListening();enabled=false;model=null;availability=null;lastReason=null;boundaryData=null;lookupData=null;lookupKey='';queryKey='';lastMasterCheck=-Infinity;refreshState='IDLE';geometryCache.clear();metadataCache.clear();syncReferenceExpiry();clear();$('#territoryVehicles')?.replaceChildren();status('고정배차 기준 권역');};
const coordinatesChanged=()=>{if(enabled)return renderForSelection();};
window.addEventListener('map-coordinate-updated',coordinatesChanged);
window.addEventListener('map-navigation-logout',logout);window.addEventListener('pagehide',e=>{if(e.persisted)return;logout();window.removeEventListener('map-navigation-logout',logout);window.removeEventListener('map-coordinate-updated',coordinatesChanged);});
window.MapTerritoryUi=Object.freeze({toggle,renderForSelection,refresh:load,state:()=>({enabled,busy,vehicles:availability?.vehicles||[],totalVehicleCount:availability?.totalVehicleCount||availability?.vehicles.length||0,displayedVehicleCount:availability?.displayedVehicleCount||0,unshownReasons:availability?.unshownReasons||{},reason:lastReason||availability?.reason||null,currentness:refreshState==='FAILED'&&polygons.length?'VERIFIED_GEOMETRY_REFRESH_FAILED':availability?.currentness||'UNCONFIRMED',sourceCurrentness:availability?.currentness||'UNCONFIRMED',refreshState,stale:availability?.stale,referenceMaster:availability?.referenceMaster||null,source:'FIXED_DISPATCH_PRIMARY',boundarySource:boundaryData?.metadata||lookupData?.metadata||null,partialCoverage:(boundaryData?.metadata||lookupData?.metadata)?.partialCoverage!==false,checkedAt:availability?.checkedAt||null,version:availability?.version||null,polygons:polygons.length,draws,requests,counters:{...counters,requests,cacheSize:geometryCache.size},sharedTerritories:[...polygonEntries.values()].filter(entry=>entry.owners.length>1).map(entry=>({vehicles:[...entry.owners]}))})});status('고정배차 기준 권역');
