(()=>{
 'use strict';const $=s=>document.querySelector(s),bridge=window.MapUiLocalBridge,editor=window.MapNavigationEditor;
 if(!bridge||!editor)return;
 const planner=$('#waypointPlanner'),routeList=$('#runListTool'),plannerAnchor=document.createComment('navigation-planner-home'),routeAnchor=document.createComment('navigation-list-home');
 planner.before(plannerAnchor);routeList.before(routeAnchor);
 const workspace=document.createElement('section');workspace.id='navigationWorkspace';workspace.className='navigationWorkspace';workspace.hidden=true;
 workspace.innerHTML='<section id="navigationSummary" aria-label="도로 경로 요약"><div class="sectiontitle"><h2>도로 경로</h2><span id="navigationMeaning">자동차</span></div><div class="navTotals"><b id="navDistance">— km</b><b id="navDuration">— 분</b></div><p id="navRouteStatus" role="status">확인된 배송지를 선택한 뒤 경로 조회를 눌러 주세요.</p><div class="navToggles"><label><input id="navRoadLines" type="checkbox" checked>도로 경로 표시</label><input id="navConnections" type="checkbox" hidden disabled></div><button id="queryRecordedRoute">저장 착순 경로 조회</button><div id="navLegs" aria-label="경유지별 도로 구간"></div></section>';
 const maparea=$('.maparea');$('.scrollside').append(workspace);
 $('#navigationSummary').append($('#syncOperation'));
 const picker=document.createElement('section');picker.className='navigationPicker';picker.innerHTML='<label for="navStopPicker">배송지 선택 · 고객코드/점포명/저장 주소</label><input id="navStopPicker" autocomplete="off" list="navSuggestions" placeholder="고객코드 또는 점포명"><datalist id="navSuggestions"></datalist><div id="navAmbiguous" role="status"></div><p id="navSelectedStore" role="status">선택한 매장이 없습니다.</p><div class="navPickActions"><button data-nav-role="origin">출발지 지정</button><button data-nav-role="waypoint">경유지 추가</button><button data-nav-role="destination">목적지 지정</button></div><p id="navPointStatus" role="status"></p>';
 planner.querySelector('.plannerHelp').after(picker);
 const missing=document.createElement('details');missing.id='navMissingStores';missing.innerHTML='<summary>좌표 미확인 매장</summary><div></div>';workspace.append(missing);
 const centerPanel=document.createElement('div');centerPanel.id='mapCenters';centerPanel.className='mapCenters';centerPanel.setAttribute('aria-label','센터 위치');// Center markers remain; the duplicate map-corner center filter is detached.
 const centerNames={osan:'오산센터',yeongnam:'영남센터',honam:'호남센터'};let centers=[],centerOverlays=[],routePointOverlays=[],lastResult=null,disposed=false;
 function centerRows(){return (window.KAKAO_MAP_CONFIG?.centers||[]).filter(c=>centerNames[c.id]&&c.verified===true&&typeof c.sourceVersion==='string'&&c.sourceVersion&&Number.isFinite(c.lat)&&Number.isFinite(c.lng)&&c.lat>=33&&c.lat<=39.5&&c.lng>=124&&c.lng<=132).map(c=>({...c,customerCode:'CENTER_'+c.id,customerName:centerNames[c.id],address:c.address||'',coordinateStatus:'VERIFIED'}));}
 function all(){return [...bridge.navigationStores(),...centers];}
 function resolve(value){const key=String(value||'').trim();return all().filter(r=>[r.customerCode,r.customerName,r.address].some(v=>v===key)||r.customerCode===key.toUpperCase());}
 function status(text){$('#navPointStatus').textContent=text;}
 function updateSelected(){const r=bridge.state.selected;$('#navSelectedStore').textContent=r?`${r.customerCode||''} · ${r.customerName||r.address||''}${!Number.isFinite(r.lat)||!Number.isFinite(r.lng)?' · 좌표 미확인':''}`:'선택한 매장이 없습니다.';if(r?.customerCode)$('#navStopPicker').value=r.customerCode;}
 function selectPoint(role){const input=$('#navStopPicker').value||bridge.state.selected?.customerCode,found=resolve(input);$('#navAmbiguous').replaceChildren();
  if(found.length!==1){status(found.length?'여러 매장이 일치합니다. 고객코드를 선택해 주세요.':'저장된 매장 위치를 선택해 주세요.');for(const row of found.slice(0,20)){const b=document.createElement('button');b.textContent=row.customerCode+' · '+row.customerName;b.onclick=()=>{$('#navStopPicker').value=row.customerCode;status('고객코드를 선택했습니다. 지점 역할을 지정해 주세요.');};$('#navAmbiguous').append(b);}return;}
  const row=found[0];if(row.coordinateStatus==='CONFLICT'||!Number.isFinite(row.lat)||!Number.isFinite(row.lng)){status('주소·좌표가 미확인되었거나 서로 다릅니다. 경로 지점으로 추가하지 않습니다.');return;}
  try{editor.setPoint(role,row.customerCode);status((role==='origin'?'출발지':role==='destination'?'목적지':'경유지')+' 지정: '+row.customerName);if(!row.customerCode.startsWith('CENTER_'))bridge.selectNavigationStore(row.customerCode);}catch(e){status(e.message);}
 }
 picker.querySelectorAll('[data-nav-role]').forEach(b=>b.onclick=()=>selectPoint(b.dataset.navRole));
 let suggestTimer;$('#navStopPicker').oninput=()=>{clearTimeout(suggestTimer);suggestTimer=setTimeout(()=>{const key=$('#navStopPicker').value.trim(),list=$('#navSuggestions');list.replaceChildren();if(!key)return;for(const row of all().filter(r=>[r.customerCode,r.customerName,r.address].some(v=>String(v||'').includes(key))).slice(0,30)){const o=document.createElement('option');o.value=row.customerCode;o.label=row.customerName;list.append(o);}},120);};
 function showResult(result){lastResult=result;routePointOverlays.forEach(o=>o.setMap(null));routePointOverlays=[];const metric=RoadRouteUi.metrics(result);$('#navDistance').textContent=metric.distance==='—'?'— km':metric.distance;$('#navDuration').textContent=metric.duration==='—'?'— 분':metric.duration;$('#navRouteStatus').textContent=MapDotUi.describeRoute(result);$('#navigationSummary').dataset.state=result?.state||'idle';
  const legs=$('#navLegs');legs.replaceChildren();if(!['success','partial'].includes(result?.state))return;
  const labels=editor.values(),allButton=document.createElement('button');allButton.textContent='전체 구간';allButton.onclick=()=>{if($('#navRoadLines').checked)bridge.highlightManualLeg();legs.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===allButton)));};allButton.setAttribute('aria-pressed','true');legs.append(allButton);
  if(bridge.state.map){const bounds=new kakao.maps.LatLngBounds();let any=false;
   labels.forEach((value,index)=>{const rows=resolve(value);if(rows.length!==1||!Number.isFinite(rows[0].lat)||!Number.isFinite(rows[0].lng))return;const row=rows[0],label=document.createElement('button');label.className='navRoutePoint';label.dataset.navRoutePoint=index;label.textContent=index===0?'출발':index===labels.length-1?'도착':'경유 '+index;label.setAttribute('aria-label',label.textContent+' · '+row.customerName);label.onclick=()=>{if(!row.customerCode.startsWith('CENTER_'))bridge.selectNavigationStore(row.customerCode);};const position=new kakao.maps.LatLng(row.lat,row.lng);bounds.extend(position);any=true;const overlay=new kakao.maps.CustomOverlay({position,content:label,zIndex:6,yAnchor:1.5});overlay.setMap(bridge.state.map);routePointOverlays.push(overlay);});
   if(any&&$('#map').getBoundingClientRect().width>0){bridge.state.map.relayout();bridge.state.fitRequested=false;bridge.state.suppressMapEventsUntil=Date.now()+700;bridge.state.map.setBounds(bounds);}
  }
  for(let i=0;i<result.totalLegs;i++){const value=result.legs?.find(l=>l.index===i),button=document.createElement('button');button.dataset.navLeg=i;button.textContent=`${i+1}구간 ${labels[i]||'출발'} → ${labels[i+1]||'도착'} · ${value?(value.distanceMeters/1000).toFixed(1)+' km · '+Math.ceil(value.durationSeconds/60)+'분':'구간별 거리·시간 미제공'}`;button.setAttribute('aria-pressed','false');button.onclick=()=>{if($('#navRoadLines').checked)bridge.highlightManualLeg(i);legs.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));};legs.append(button);}
  if(!$('#navRoadLines').checked)bridge.toggleRoadLines(false);
 }
 $('#navRoadLines').onchange=e=>bridge.toggleRoadLines(e.target.checked);$('#navConnections').onchange=e=>{const r=bridge.toggleConnections(e.target.checked);if(e.target.checked&&!r.shown)status('검증'+'된 배송 순서가 없어 직선 연결선을 표시하지 않습니다.');};$('#queryRecordedRoute').onclick=()=>bridge.queryRecordedRoute();
 function drawCenters(){centerOverlays.forEach(o=>o.setMap(null));centerOverlays=[];centers=centerRows();centerPanel.replaceChildren();
  for(const [id,name]of Object.entries(centerNames)){const c=centers.find(r=>r.id===id),button=document.createElement('button');button.textContent=name+(c?'':' · 좌표 확인 대기');button.disabled=!c;button.onclick=()=>{if(bridge.state.map){bridge.state.map.panTo(new kakao.maps.LatLng(c.lat,c.lng));bridge.state.map.setLevel(6);}$('#navStopPicker').value=c.customerCode;status(name+' 선택 · 지점 역할을 지정해 주세요.');};centerPanel.append(button);
   if(c&&bridge.state.map){const label=document.createElement('button');label.className='centerMarker';label.textContent=name;label.onclick=button.onclick;const overlay=new kakao.maps.CustomOverlay({position:new kakao.maps.LatLng(c.lat,c.lng),content:label,zIndex:2});overlay.setMap(bridge.state.map);centerOverlays.push(overlay);}
  }
 }
 function sync(){if(disposed)return;const daily=bridge.state.mode==='DATE_ROUTE';workspace.hidden=!daily;
  if(!window.MapDotUi?.arrangeNavigation?.()){
   if(daily){if(planner.parentNode!==workspace)workspace.insertBefore(planner,missing);if(routeList.parentNode!==workspace)workspace.prepend(routeList);planner.hidden=false;routeList.hidden=false;}
   else{if(planner.parentNode!==plannerAnchor.parentNode)plannerAnchor.after(planner);if(routeList.parentNode!==routeAnchor.parentNode)routeAnchor.after(routeList);planner.hidden=true;}
  }
  const vehicles=bridge.state.selectedVehicles,rows=bridge.stores().filter(r=>(!vehicles.length||vehicles.includes(String(r.vehicle)))&&(!Number.isFinite(r.lat)||!Number.isFinite(r.lng)||r.coordinateStatus==='CONFLICT'));
  missing.querySelector('summary').textContent='좌표 미확인 매장 '+rows.length+'개';const list=missing.querySelector('div');list.replaceChildren();for(const row of rows.slice(0,100)){const b=document.createElement('button');b.textContent=row.customerCode+' · '+row.customerName+' · 좌표 미확인';b.onclick=()=>bridge.selectNavigationStore(row.customerCode);list.append(b);}
  if(bridge.state.map)requestAnimationFrame(()=>bridge.state.map?.relayout());
 }
 const onManual=e=>showResult(e.detail),onRecorded=e=>{const data=e.detail;$('#navRouteStatus').textContent=MapDotUi.describeRoute(data);const m=RoadRouteUi.metrics(data);$('#navDistance').textContent=m.distance;$('#navDuration').textContent=m.duration;},onSelected=()=>{updateSelected();},onReady=()=>{drawCenters();sync();},onLogout=()=>{editor.clear();showResult({state:'idle'});};
 window.addEventListener('map-manual-route',onManual);window.addEventListener('map-recorded-route',onRecorded);window.addEventListener('map-store-selected',onSelected);window.addEventListener('map-sdk-ready',onReady);window.addEventListener('map-navigation-logout',onLogout);
 const observer=new MutationObserver(sync);observer.observe($('#modeDaily'),{attributes:true,attributeFilter:['aria-pressed']});observer.observe($('#runList'),{childList:true});
 window.addEventListener('pagehide',e=>{if(e.persisted)return;disposed=true;clearTimeout(suggestTimer);observer.disconnect();[...centerOverlays,...routePointOverlays].forEach(o=>o.setMap(null));centerOverlays=[];routePointOverlays=[];for(const [name,fn]of [['map-manual-route',onManual],['map-recorded-route',onRecorded],['map-store-selected',onSelected],['map-sdk-ready',onReady],['map-navigation-logout',onLogout]])window.removeEventListener(name,fn);},{once:true});
 window.MapNavigation=Object.freeze({resolve,sync,metrics:()=>({centerOverlays:centerOverlays.length,routePointOverlays:routePointOverlays.length,routeState:lastResult?.state||'idle'})});drawCenters();sync();
})();

