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
 function resolve(value){const key=String(value||'').trim();if(!key)return [];return [...new Map(all().filter(r=>[r.customerCode,r.customerName,r.address].some(v=>v===key)||r.customerCode===key.toUpperCase()).map(r=>[r.customerCode,r])).values()];}
 function status(text){$('#navPointStatus').textContent=text;}
 function updateSelected(){const r=bridge.state.selected;$('#navSelectedStore').textContent=r?`${r.customerCode||''} · ${r.customerName||r.address||''}${!Number.isFinite(r.lat)||!Number.isFinite(r.lng)?' · 좌표 미확인':''}`:'선택한 매장이 없습니다.';if(r?.customerCode)$('#navStopPicker').value=r.customerCode;}
 function selectPoint(role){const input=$('#navStopPicker').value||bridge.state.selected?.customerCode,found=resolve(input);$('#navAmbiguous').replaceChildren();
  if(found.length!==1){status(found.length?'여러 매장이 일치합니다. 고객코드를 선택해 주세요.':'저장된 매장 위치를 선택해 주세요.');for(const row of found.slice(0,20)){const b=document.createElement('button');b.textContent=row.customerCode+' · '+row.customerName;b.onclick=()=>{$('#navStopPicker').value=row.customerCode;status('고객코드를 선택했습니다. 지점 역할을 지정해 주세요.');};$('#navAmbiguous').append(b);}return;}
  const row=found[0];if(row.coordinateStatus==='CONFLICT'||!Number.isFinite(row.lat)||!Number.isFinite(row.lng)){status('주소·좌표가 미확인되었거나 서로 다릅니다. 경로 지점으로 추가하지 않습니다.');return;}
  try{editor.setPoint(role,row.customerCode);status((role==='origin'?'출발지':role==='destination'?'목적지':'경유지')+' 지정: '+row.customerName);if(!row.customerCode.startsWith('CENTER_'))bridge.selectNavigationStore(row.customerCode);}catch(e){status(e.message);}
 }
 picker.querySelectorAll('[data-nav-role]').forEach(b=>b.onclick=()=>selectPoint(b.dataset.navRole));
 let suggestTimer;$('#navStopPicker').oninput=()=>{clearTimeout(suggestTimer);suggestTimer=setTimeout(()=>{const key=$('#navStopPicker').value.trim(),list=$('#navSuggestions');list.replaceChildren();if(!key)return;for(const row of all().filter(r=>[r.customerCode,r.customerName,r.address].some(v=>String(v||'').includes(key))).slice(0,30)){const o=document.createElement('option');o.value=row.customerCode;o.label=row.customerName;list.append(o);}},120);};
 let roleSignature='';
 function roleRows(){
   const values=editor.values();return values.flatMap((value,index)=>{
     if(!String(value||'').trim())return [];const matches=resolve(value);
     if(matches.length!==1||!Number.isFinite(matches[0].lat)||!Number.isFinite(matches[0].lng))return [];
     return [{row:matches[0],index,role:index===0?'origin':index===values.length-1?'destination':'waypoint',label:index===0?'출발':index===values.length-1?'도착':'경유 '+index}];
   });
 }
 function renderRolePins(){
   const roles=roleRows();const signature=JSON.stringify([bridge.state.mode,roles.map(p=>[p.row.customerCode,p.row.lat,p.row.lng,p.role,p.index])]);
   if(!bridge.state.map)return;
   if(signature===roleSignature)return;roleSignature=signature;
   routePointOverlays.forEach(o=>o.setMap(null));routePointOverlays=[];
   const assigned=new Set(roles.map(p=>p.row.customerCode));
   document.querySelectorAll('.marker[data-customer-code]').forEach(n=>n.classList.toggle('navAssigned',bridge.state.mode==='DATE_ROUTE'&&assigned.has(n.dataset.customerCode)));
   if(bridge.state.mode!=='DATE_ROUTE')return;
   for(const p of roles){
     const label=document.createElement('button');label.className='navRoutePoint';label.dataset.role=p.role;label.dataset.customerCode=p.row.customerCode;label.textContent=p.label;
     const name=document.createElement('small');name.textContent=p.row.customerName||p.row.customerCode;label.append(name);
     label.setAttribute('aria-label',p.label+' · '+name.textContent);
     label.onclick=e=>{e.stopPropagation();if(!p.row.customerCode.startsWith('CENTER_'))bridge.selectNavigationStore(p.row.customerCode);};
     const overlay=new kakao.maps.CustomOverlay({position:new kakao.maps.LatLng(p.row.lat,p.row.lng),content:label,zIndex:20,yAnchor:1.3});overlay.setMap(bridge.state.map);routePointOverlays.push(overlay);
   }
 }
 function showResult(result){lastResult=result;renderRolePins();const metric=RoadRouteUi.metrics(result);$('#navDistance').textContent=metric.distance==='—'?'— km':metric.distance;$('#navDuration').textContent=metric.duration==='—'?'— 분':metric.duration;$('#navRouteStatus').textContent=MapDotUi.describeRoute(result);$('#navigationSummary').dataset.state=result?.state||'idle';
  const legs=$('#navLegs');legs.replaceChildren();if(!['success','partial'].includes(result?.state))return;
  const labels=editor.values(),allButton=document.createElement('button');allButton.textContent='전체 구간';allButton.onclick=()=>{if($('#navRoadLines').checked)bridge.highlightManualLeg();legs.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===allButton)));};allButton.setAttribute('aria-pressed','true');legs.append(allButton);
  if(bridge.state.map){const bounds=new kakao.maps.LatLngBounds();let any=false;for(const p of roleRows()){bounds.extend(new kakao.maps.LatLng(p.row.lat,p.row.lng));any=true;}if(any)bridge.fitNavigationBounds?.(bounds);}
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
  const vehicles=bridge.state.selectedVehicles,unlocatedRows=bridge.stores().filter(r=>(!vehicles.length||vehicles.includes(String(r.vehicle)))&&(!Number.isFinite(r.lat)||!Number.isFinite(r.lng)||r.coordinateStatus==='CONFLICT'));
  const rows=[...new Map(unlocatedRows.map((row,index)=>[row.customerCode?'code:'+String(row.customerCode):'row:'+index,row])).values()];
  missing.querySelector('summary').textContent='좌표 미확인 매장 '+rows.length+'개';const list=missing.querySelector('div');list.replaceChildren();
  function appendPage(start){for(const row of rows.slice(start,start+100)){const b=document.createElement('button');b.textContent=row.customerCode+' · '+row.customerName+' · 좌표 미확인';b.onclick=()=>bridge.selectNavigationStore(row.customerCode);list.append(b);}if(start+100<rows.length){const more=document.createElement('button');more.textContent='미확인 매장 더 보기 ('+Math.min(100,rows.length-start-100)+'개)';more.onclick=()=>{more.remove();appendPage(start+100);};list.append(more);}}
  appendPage(0);
  renderRolePins();bridge.relayoutPreservingView?.();
 }
 const onManual=e=>showResult(e.detail),onRecorded=e=>{const data=e.detail;$('#navRouteStatus').textContent=MapDotUi.describeRoute(data);const m=RoadRouteUi.metrics(data);$('#navDistance').textContent=m.distance;$('#navDuration').textContent=m.duration;},onSelected=()=>{updateSelected();},onReady=()=>{drawCenters();sync();},onLogout=()=>{editor.clear();showResult({state:'idle'});};
 window.addEventListener('map-manual-route',onManual);window.addEventListener('map-recorded-route',onRecorded);window.addEventListener('map-store-selected',onSelected);window.addEventListener('map-sdk-ready',onReady);window.addEventListener('map-navigation-logout',onLogout);
 const onDraft=()=>{roleSignature='';renderRolePins();};
 window.addEventListener('map-navigation-draft',onDraft);
 window.addEventListener('map-coordinate-updated',sync);
 const observer=new MutationObserver(sync);observer.observe($('#modeDaily'),{attributes:true,attributeFilter:['aria-pressed']});observer.observe($('#runList'),{childList:true});
 window.addEventListener('pagehide',e=>{if(e.persisted)return;disposed=true;window.removeEventListener('map-navigation-draft',onDraft);window.removeEventListener('map-coordinate-updated',sync);clearTimeout(suggestTimer);observer.disconnect();[...centerOverlays,...routePointOverlays].forEach(o=>o.setMap(null));centerOverlays=[];routePointOverlays=[];for(const [name,fn]of [['map-manual-route',onManual],['map-recorded-route',onRecorded],['map-store-selected',onSelected],['map-sdk-ready',onReady],['map-navigation-logout',onLogout]])window.removeEventListener(name,fn);},{once:true});
 window.MapNavigation=Object.freeze({resolve,sync,metrics:()=>({centerOverlays:centerOverlays.length,routePointOverlays:routePointOverlays.length,routeState:lastResult?.state||'idle'})});drawCenters();sync();
})();

