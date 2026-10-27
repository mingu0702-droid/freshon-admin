import{addressRegion,dispatchCenter,manualPinTargetCodes}from'./map-location-contract.mjs?v=20261028-r4';
window.MapLocationContract={addressRegion,dispatchCenter};
const bridge=window.MapUiLocalBridge;if(!bridge)throw Error('EXISTING_MAP_BRIDGE_REQUIRED');
let targets=[];
const $=s=>document.querySelector(s),base='/api/map-phase2b/private/manual-pins';let records=new Map(),bases=new WeakMap(),generation=0,edit=null,marker=null,mapClick=null,pending=null,refreshing=null,refreshingOwner=-1,touchClose=null,ignoreClickUntil=0;
const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('map-manual-pins'):null;
const panel=document.createElement('section');panel.id='manualPinEditor';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label','배송지 핀 위치 수정');document.body.append(panel);
const list=document.createElement('details');list.id='manualPinTargets';list.innerHTML='<summary>좌표 직접 수정</summary><p>주소는 선택한 매장 1건씩 표시합니다. Customer 원본 주소는 바꾸지 않습니다.</p><div class="manualPinPending"></div><details><summary>위치가 확인된 수정 대상</summary><div class="manualPinResolved"></div></details>';
// The legacy mobile controller may still hold the store section in its hidden sheet.
// Keep the manual editor entry in the active Dot sidebar instead of that sheet.
const targetHome=$('.approvedShellCandidate .scrollside');if(targetHome)targetHome.append(list);else $('#periodStoreListSection').before(list);
function node(tag,text,parent){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;parent?.append(e);return e;}
const button=(text,parent,fn)=>{const b=node('button',text,parent);b.type='button';b.onclick=fn;return b;};
const stateText={MANUAL_PIN_STORE_NOT_CONFIGURED:'수동 위치 저장소가 연결되지 않았습니다.',MANUAL_PIN_WRITE_PERMISSION_REQUIRED:'수동 위치 수정 권한이 없습니다.',MANUAL_PIN_GEOCODER_BUDGET_EXHAUSTED:'주소 검색 예산이 소진됐습니다. 지도 클릭·핀 드래그는 사용할 수 있습니다.',MANUAL_PIN_REVISION_CONFLICT:'다른 수정이 먼저 저장됐습니다. 다시 열어 비교해 주세요.',MANUAL_PIN_ADDRESS_CHANGED:'원본 주소가 변경됐습니다. 다시 열어 비교해 주세요.',MANUAL_PIN_OPERATION_SUPERSEDED:'이미 후속 수정이 있습니다. 현재 저장본을 다시 확인해 주세요.',MANUAL_PIN_SESSION_EXPIRED:'직원 세션이 만료됐습니다.',MANUAL_PIN_CSRF_REJECTED:'수정 권한을 다시 확인해 주세요.'};
async function request(url,options={}){const response=await fetch(url,{cache:'no-store',credentials:'same-origin',...options});let value;try{value=await response.json();}catch{throw Error('저장 결과를 확인하지 못했습니다. 현재 저장본을 다시 조회해 주세요.');}if(!response.ok||value.ok!==true)throw Error(stateText[value.error]||'위치 조회·저장을 완료하지 못했습니다. 다시 열어 현재 저장본을 확인해 주세요.');return value;}
function apply(row){
 if(!bases.has(row))bases.set(row,{lat:row.lat,lng:row.lng,coordinateSource:row.coordinateSource,coordinateAccuracy:row.coordinateAccuracy,coordinateStatus:row.coordinateStatus});
 const r=records.get(row.customerCode),original=bases.get(row);Object.assign(row,original);delete row.resolutionStatus;
 if(r?.resolutionStatus==='MANUAL_CONFIRMED'){row.lat=r.latitude;row.lng=r.longitude;row.coordinateSource='MANUAL_PIN';row.coordinateAccuracy='MANUAL_PIN';row.coordinateStatus='CONFIRMED';row.resolutionStatus='MANUAL_CONFIRMED';}
 else if(r?.resolutionStatus==='ADDRESS_CHANGED_REVIEW_REQUIRED'){row.lat=null;row.lng=null;row.coordinateStatus='CONFLICT';row.resolutionStatus=r.resolutionStatus;}
 return row;
}
async function refresh(){
 if(refreshing)return refreshingOwner===generation?refreshing:refreshing.catch(()=>{}).then(refresh);const owner=generation;refreshingOwner=owner;
 refreshing=(async()=>{const value=await request(base+'/projection');if(owner!==generation)return;const next=new Map();
  if(!Array.isArray(value.data)||value.data.length>15000)throw Error('위치 응답 형식을 확인할 수 없습니다.');
  for(const r of value.data){if(!/^[A-Z]\d+$/.test(r.customerCode)||next.has(r.customerCode)||!['MANUAL_CONFIRMED','ADDRESS_CHANGED_REVIEW_REQUIRED'].includes(r.resolutionStatus)||r.resolutionStatus==='MANUAL_CONFIRMED'&&!(Number.isFinite(r.latitude)&&r.latitude>=33&&r.latitude<=39.5&&Number.isFinite(r.longitude)&&r.longitude>=124&&r.longitude<=132))throw Error('위치 응답 형식을 확인할 수 없습니다.');next.set(r.customerCode,r);}
  records=next;bridge.refreshManualCoordinates();renderTargets();
 })();try{await refreshing;}finally{refreshing=null;}
}
function close(){generation++;pending?.abort();pending=null;touchClose?.();touchClose=null;edit=null;panel.hidden=true;panel.replaceChildren();document.body.classList.remove('manualPinEditing');if(marker)marker.setMap(null);marker=null;if(mapClick&&bridge.state.map)kakao.maps.event.removeListener(bridge.state.map,'click',mapClick);mapClick=null;ignoreClickUntil=0;}
function bindTouchPin(map){
 const area=$('#map');let drag=null;
 const finish=()=>{if(drag){map.setDraggable(drag.mapDraggable);drag=null;ignoreClickUntil=Date.now()+350;}};
 const start=e=>{if(e.touches.length!==1||!edit?.point)return;const t=e.touches[0],r=area.getBoundingClientRect(),p=map.getProjection().containerPointFromCoords(new kakao.maps.LatLng(edit.point.latitude,edit.point.longitude));
  if(Math.abs(t.clientX-r.left-p.x)>24||t.clientY-r.top-p.y< -44||t.clientY-r.top-p.y>8)return;
  drag={id:t.identifier,x:t.clientX,y:t.clientY,p,initial:{...edit.point},mapDraggable:map.getDraggable()};map.setDraggable(false);e.preventDefault();e.stopImmediatePropagation();};
 const move=e=>{if(!drag)return;const t=[...e.touches].find(t=>t.identifier===drag.id);if(!t||e.touches.length!==1){finish();return;}const p=map.getProjection().coordsFromContainerPoint(new kakao.maps.Point(drag.p.x+t.clientX-drag.x,drag.p.y+t.clientY-drag.y));selectPoint(p.getLat(),p.getLng());e.preventDefault();e.stopImmediatePropagation();};
 const end=e=>{if(!drag)return;if(e.type==='touchcancel')selectPoint(drag.initial.latitude,drag.initial.longitude);finish();e.preventDefault();e.stopImmediatePropagation();};
 for(const [name,fn]of [['touchstart',start],['touchmove',move],['touchend',end],['touchcancel',end]])area.addEventListener(name,fn,{capture:true,passive:false});
 touchClose=()=>{finish();for(const [name,fn]of [['touchstart',start],['touchmove',move],['touchend',end],['touchcancel',end]])area.removeEventListener(name,fn,true);};
}
function selectPoint(lat,lng,{pan=false}={}){
 if(!edit||!Number.isFinite(lat)||!Number.isFinite(lng)||lat<33||lat>39.5||lng<124||lng>132)return;
 edit.point={latitude:lat,longitude:lng};edit.requestBody=null;
 const map=bridge.state.map,position=new kakao.maps.LatLng(lat,lng);if(!marker){marker=new kakao.maps.Marker({map,position,draggable:true,clickable:true,zIndex:99});kakao.maps.event.addListener(marker,'dragend',()=>{const p=marker.getPosition();selectPoint(p.getLat(),p.getLng());});}else marker.setPosition(position);
 if(pan){map.setLevel(Math.min(map.getLevel(),4));map.panTo(position);}$('#manualPinCoordinates').textContent=`선택 좌표: ${lat.toFixed(7)}, ${lng.toFixed(7)} · 공유계정 수정`;$('#manualPinSave').disabled=!edit.data.canWrite;
}
async function search(){
 if(!edit)return;const owner=generation,query=$('#manualPinSearchAddress').value.trim();if(!query)return;
 $('#manualPinMessage').textContent='주소 검색 중…';$('#manualPinSearch').disabled=true;
 try{
  let results=(await request(base+'/'+edit.code+'/search',{headers:{'x-map-search-address':encodeURIComponent(query)},signal:pending.signal})).data;
  if(owner!==generation)return;
  if(!results.length){
   await request(base+'/'+edit.code+'/reserve-search',{method:'POST',headers:{'content-type':'application/json','x-map-pin-csrf':edit.csrf},body:JSON.stringify({query}),signal:pending.signal});
   if(owner!==generation)return;
   const geocoder=window.kakaoGeocoder;if(!geocoder)throw Error('기존 Kakao 주소 검색이 준비되지 않았습니다.');
   results=await new Promise((resolve,reject)=>{let finished=false;const timer=setTimeout(()=>{finished=true;reject(Error('주소 검색 시간이 초과됐습니다. 자동 재시도하지 않습니다.'));},6000);
    geocoder.addressSearch(query,(docs,status)=>{if(finished)return;finished=true;clearTimeout(timer);if(status!=='OK'){resolve([]);return;}resolve((Array.isArray(docs)?docs:[]).filter(d=>Number.isFinite(Number(d.y))&&Number.isFinite(Number(d.x))).slice(0,5).map(d=>({latitude:Number(d.y),longitude:Number(d.x),label:d.road_address?.address_name||d.address_name})));},{page:1,size:5,analyze_type:kakao.maps.services.AnalyzeType.EXACT});});
  }
  if(owner!==generation)return;const area=$('#manualPinSearchResults');area.replaceChildren();
  for(const r of results)button(r.label||'주소 검색 위치',area,()=>{selectPoint(r.latitude,r.longitude,{pan:true});$('#manualPinMessage').textContent='지도를 클릭하거나 핀을 드래그한 뒤 저장해 주세요.';});
  if(results.length===1){selectPoint(results[0].latitude,results[0].longitude,{pan:true});$('#manualPinMessage').textContent='건물 위치를 선택했습니다. 지도 클릭·핀 드래그로 바꿀 수 있습니다.';}
  else $('#manualPinMessage').textContent=results.length?'주소 후보를 선택해 주세요.':'주소 검색 결과가 없습니다. 지도에서 직접 위치를 지정할 수 있습니다.';
 }catch(e){if(owner===generation)$('#manualPinMessage').textContent=e.message;}finally{if(owner===generation)$('#manualPinSearch').disabled=false;}
}
async function save(action='save',targetRevision){
 if(!edit||!edit.data.canWrite||action==='save'&&!edit.point)return;const owner=generation,code=edit.code;$('#manualPinSave').disabled=true;$('#manualPinMessage').textContent='저장·재조회 확인 중…';
 try{
  const query=$('#manualPinSearchAddress').value.trim();edit.requestBody??={originalAddressHash:edit.data.originalAddressHash,expectedRevision:edit.data.revision,requestId:crypto.randomUUID(),...(action==='save'?{...edit.point,correctedSearchAddress:query!==edit.data.originalAddress?query:''}:{targetRevision})};
  await request(base+'/'+code+'/'+action,{method:'POST',headers:{'content-type':'application/json','x-map-pin-csrf':edit.csrf},body:JSON.stringify(edit.requestBody),signal:pending.signal});
  if(owner!==generation)return;
  await refresh();if(owner!==generation)return;close();bridge.selectNavigationStore(code);channel?.postMessage('changed');
 }catch(e){if(owner===generation)$('#manualPinMessage').textContent=e.message;}finally{if(owner===generation)$('#manualPinSave').disabled=!edit?.point||!edit.data.canWrite;}
}
async function open(code,{searchNow=false}={}){
 close();const owner=generation;pending=new AbortController();panel.hidden=false;document.body.classList.add('manualPinEditing');node('h2','배송지 핀 위치 수정',panel);button('닫기',panel,close);const status=node('p','선택 매장 정보를 조회합니다…',panel);status.id='manualPinMessage';
 try{const value=await request(base+'/'+code,{signal:pending.signal});if(owner!==generation)return;const data=value.data;edit={code,data,csrf:value.csrfToken,point:null,requestBody:null};
  node('p',code+' · '+data.customerName,panel).id='manualPinIdentity';node('p','Customer 기본주소 (원문 보존)',panel);node('p',data.originalAddress,panel).id='manualPinOriginalAddress';
  if(data.addressChanged)node('p','원본 주소가 변경됐습니다. 이전 주소 해시와 비교해 다시 확인해 주세요.',panel);
  node('label','검색용 주소 (선택·원본 주소 변경 없음)',panel).htmlFor='manualPinSearchAddress';const input=node('input',undefined,panel);input.id='manualPinSearchAddress';input.autocomplete='off';input.value=data.originalAddress;input.oninput=()=>{if(edit)edit.requestBody=null;};
  const find=button('주소 검색',panel,search);find.id='manualPinSearch';node('div','',panel).id='manualPinSearchResults';node('p','지도 위를 클릭하거나 핀을 드래그해 위치를 지정해 주세요.',panel).id='manualPinCoordinates';
  const confirm=button('이 위치로 저장',panel,()=>save());confirm.id='manualPinSave';confirm.disabled=true;
  const history=node('details',undefined,panel);node('summary','수정 이력·이전 위치로 되돌리기',history);const h=node('div',undefined,history);h.id='manualPinHistory';
  if(data.revision&&data.canWrite){button('처음 위치로 되돌리기',h,()=>{edit.requestBody=null;void save('revert',0);}).id='manualPinRestoreOriginal';}
  for(const event of data.history){const entry=node('div',undefined,h);node('p',`#${event.revision} · ${event.updatedAt} · 공유계정 수정`,entry);if(event.after)node('p',event.after.latitude+', '+event.after.longitude,entry);if(data.canWrite&&event.revision<data.revision)button('이전 위치 #'+event.revision+'로 되돌리기',entry,()=>{edit.requestBody=null;void save('revert',event.revision);});}
  status.textContent=data.canWrite?'원본 Customer 주소는 수정하지 않습니다.':'저장 권한이 비활성화되어 있습니다. 관리자에게 전용 저장소·수정 권한 연결을 요청해 주세요.';
  await bridge.initMap();if(owner!==generation)return;
  mapClick=e=>{if(Date.now()>=ignoreClickUntil)selectPoint(e.latLng.getLat(),e.latLng.getLng());};kakao.maps.event.addListener(bridge.state.map,'click',mapClick);bindTouchPin(bridge.state.map);
  const initial=data.current&&!data.addressChanged?data.current:data.previousCoordinate;if(initial&&Number.isFinite(initial.latitude)&&Number.isFinite(initial.longitude))selectPoint(initial.latitude,initial.longitude,{pan:true});
  if(searchNow)void search();
 }catch(e){if(owner===generation)status.textContent=e.message;}
}
function renderTargets(){
 targets=manualPinTargetCodes(bridge.stores(),[...records.values()],targets);
 const stores=new Map(bridge.stores().map(r=>[r.customerCode,r])),unresolved=list.querySelector('.manualPinPending'),resolved=list.querySelector('.manualPinResolved');unresolved.replaceChildren();resolved.replaceChildren();let count=0;
 for(const code of targets){const row=stores.get(code);if(!row)continue;const manual=records.get(code)?.resolutionStatus==='MANUAL_CONFIRMED',located=Number.isFinite(row.lat)&&Number.isFinite(row.lng)&&row.coordinateStatus!=='CONFLICT';const parent=located?resolved:unresolved;if(!located)count++;
  const item=node('div',undefined,parent);item.className='manualPinTarget';item.dataset.manualTarget=code;node('b',code+' · '+row.customerName,item);node('p',manual?'수동 확정 완료':located?'건물·기존 좌표 확인됨 · 재수정 가능':'주소 검색 또는 지도 클릭으로 위치를 지정해 주세요.',item);
  button('주소 검색',item,()=>open(code,{searchNow:true}));button(manual||located?'핀 위치 수정':'지도에서 핀 지정',item,()=>open(code));
 }
 list.querySelector('summary').textContent='좌표 직접 수정 · 미확인 '+count+'개';
}
function attach(){const code=bridge.state.selected?.customerCode;if(!code||!$('#detail .detailBody')||$('#manualPinEdit'))return;const b=button('지도에서 위치 수정',$('#detail .detailBody'),()=>open(code));b.id='manualPinEdit';if(records.get(code)?.resolutionStatus==='MANUAL_CONFIRMED')b.textContent='핀 위치 수정';}
window.MapManualPins=Object.freeze({apply,open,refresh});
window.addEventListener('map-store-selected',e=>{if(edit&&e.detail?.customerCode&&edit.code!==e.detail.customerCode)close();queueMicrotask(attach);});
window.addEventListener('map-stores-replaced',()=>{renderTargets();if(!refreshing)void refresh().catch(()=>{});});
window.addEventListener('map-coordinate-updated',()=>{window.MapNavigation?.sync();renderTargets();});
window.addEventListener('map-staff-authenticated',()=>void refresh().catch(()=>{}));
window.addEventListener('map-staff-signed-out',()=>{close();records.clear();bases=new WeakMap();list.querySelector('.manualPinPending').replaceChildren();list.querySelector('.manualPinResolved').replaceChildren();});
channel?.addEventListener('message',e=>{if(e.data==='changed'&&document.body.dataset.mapStaffState==='authenticated')void refresh().catch(()=>{});});
window.addEventListener('pagehide',()=>{close();channel?.close();},{once:true});renderTargets();void refresh().catch(()=>{});
