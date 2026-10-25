/* Minimal compatibility for the existing approved Dot shell. No new workbench. */
(() => {
  'use strict';
  const $=s=>document.querySelector(s);
  let mounted=false,observer,resizeObserver;
  function describeRoute(data){
    if(!data||data.state==='idle')return '배송지를 선택하고 경로를 조회해 주세요.';
    if(data.state==='loading')return '도로 경로 조회 중…';
    if(data.state==='success')return '자동차 경로 · 현재 교통 기준';
    if(data.state==='partial')return '일부 구간만 조회되었습니다.';
    if(data.state==='empty'||data.error==='NO_ROAD_ROUTE')return '이 지점을 잇는 자동차 경로가 없습니다.';
    const errors={STAFF_LOGIN_REQUIRED:'직원 로그인이 필요합니다.',AUTHENTICATION_FAILED:'직원 로그인이 필요합니다.',PERMISSION_DENIED:'경로 조회 권한이 없습니다.',QUOTA_EXCEEDED:'경로 조회 한도에 도달했습니다.',TIMEOUT:'경로 조회 시간이 초과되었습니다.',PROVIDER_UNAVAILABLE:'경로 서비스에 연결할 수 없습니다.',RECORDED_ORDER_REQUIRED:'호차와 저장된 방문 순서를 선택해 주세요.',INVALID_RESPONSE:'경로 응답을 확인할 수 없습니다.',ROAD_ROUTE_FAILED:'경로를 불러오지 못했습니다.'};
    if(errors[data.error])return errors[data.error];
    if(data.state==='disabled'||data.error==='CALL_POLICY_BLOCKED')return '도로 경로 연결 대기';
    return '경로를 조회하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  }
  function dockDetail(){
    const panel=$('#detailSection'),aux=$('#staffAuxContent');if(!panel)return;
    // Both public and protected content stay in one screen-space right panel.
    if(aux&&!panel.contains(aux))panel.append(aux);
    for(const name of ['position','left','right','top','bottom','width','max-height','--popup-left','--popup-top','--popup-tail'])panel.style.removeProperty(name);
    if(aux)for(const name of ['position','left','right','top','max-height'])aux.style.removeProperty(name);
  }
  function syncStatus(){
    const raw=$('#packageReadState'),fresh=$('#freshnessState'),status=$('#dotDataStatus');if(!status)return;
    const state=raw?.dataset.state;
    let text=({error:'연결 실패 · 저장 자료 표시 중',held:'저장 자료 표시 중',preparing:'자료 준비 중',legacy:'기본 자료 표시 중',unknown:'자료 상태 확인 중','logged-out':'로그아웃되었습니다.'})[state];
    if(state==='legacy'&&document.body.dataset.mapReferenceDataState==='unconfirmed')text='기준자료 미확인';
    const review=window.LOCAL_REVIEW_CONFIG;
    if(review?.currentStoredReview&&/^\d{4}-\d{2}-\d{2}$/.test(review.date)&&!['error','preparing','logged-out'].includes(state))text='확보 배송일 '+review.date+' · 미게시 · 완전성 미확인';
    const bridge=window.MapUiLocalBridge;
    if(!text){const value=fresh?.textContent||'';text=/실패|오류|취소|부분|없음|준비|대기/.test(value)?value:'기준일 '+((bridge?.state.mode==='DATE_ROUTE'?bridge.state.selectedDate:bridge?.state.rangeEnd)||'확인 중');}
    if(status.textContent!==text)status.textContent=text;
    status.dataset.state=state||'unknown';
  }
  function arrangeNavigation(){
    if(!mounted)return false;
    const daily=window.MapUiLocalBridge.state.mode==='DATE_ROUTE',planner=$('#waypointPlanner'),summary=$('#navigationSummary'),visits=$('#runListTool'),workspace=$('#navigationWorkspace'),context=$('#generalMapContext');
    if(daily){
      if(summary.parentNode!==$('#layoutDock'))$('#layoutDock').append(summary);
      if(visits.previousElementSibling!==$('.customerBlock'))$('.customerBlock').after(visits);
      if(workspace.previousElementSibling!==visits)visits.after(workspace);
      if(planner.parentNode!==workspace)workspace.prepend(planner);
      planner.hidden=false;visits.hidden=false;
    }else{
      if(summary.parentNode!==workspace)workspace.prepend(summary);
      if(planner.previousElementSibling!==$('.generalCenters'))$('.generalCenters').after(planner);
      if(context.previousElementSibling!==planner)planner.after(context);
      if($('#periodStoreListSection').previousElementSibling!==context)context.after($('#periodStoreListSection'));
      planner.hidden=true;visits.hidden=true;
    }
    const state=window.MapUiLocalBridge.state,vehicles=state.selectedVehicles;
    $('#dotRouteSelection').textContent=(vehicles.length===1?vehicles[0]+'호차':vehicles.length?vehicles.length+'개 호차':'전체 호차')+' · '+state.currentRows.length+'개 매장';
    const origin=$('#plannerStart').value,point=window.MapNavigation?.resolve(origin)||[];
    $('#dotRouteOrigin').textContent=point.length===1?'출발 · '+point[0].customerName:'출발지를 선택해 주세요.';
    return true;
  }
  function mount(){
    if(mounted)return;mounted=true;document.body.classList.add('dotRestored');
    const scroll=$('.scrollside'),context=$('#generalMapContext');
    // Keep the history/next-page controllers' original container and IDs.
    context.className='dotQueryActions';scroll.querySelector('.generalCenters').after(context);
    // The pre-shell mobile controller may have moved this into its hidden sheet.
    context.after($('#periodStoreListSection'));
    document.querySelectorAll('option[value="other"]').forEach(n=>n.remove());
    const planner=$('#waypointPlanner');planner.querySelector('.sectiontitle .muted').textContent='자동차';
    planner.querySelector('.plannerHelp').textContent='선택한 순서로 자동차 경로를 조회합니다.';
    const summary=$('#navigationSummary');summary.querySelector('h2').textContent='내비 도로경로';
    const selection=document.createElement('p');selection.id='dotRouteSelection';
    const origin=document.createElement('p');origin.id='dotRouteOrigin';
    summary.querySelector('.sectiontitle').after(selection,origin);
    for(const [id,label]of [['navDistance','주행거리'],['navDuration','예상 소요']]){const value=$('#'+id),wrap=document.createElement('span');wrap.append(label+' ',value);summary.querySelector('.navTotals').append(wrap);}
    summary.append($('#syncOperation'));
    const referenceNotice=$('#mapReferenceDataNotice');
    if(referenceNotice)$('#approvedSiteHeader').append(referenceNotice);
    const obsoleteRoutePanel=$('#roadRoutePanel');
    if(obsoleteRoutePanel){obsoleteRoutePanel.hidden=true;obsoleteRoutePanel.inert=true;obsoleteRoutePanel.dataset.modeHidden='true';}
    const options=document.createElement('details');options.id='dotRoadOptions';options.innerHTML='<summary>경로 표시·저장 순서</summary>';
    options.append(summary.querySelector('.navToggles'),$('#queryRecordedRoute'),$('#navLegs'));summary.append(options);
    const controls=document.createElement('details');controls.id='territoryControls';
    controls.innerHTML='<summary>호차별 권역</summary><p id="territoryStatus" role="status">최근 10일 배송지 기준</p><ul id="territoryVehicles"></ul><button id="refreshTerritories">권역 새로고침</button>';
    $('.generalCenters').append(controls);
    const status=document.createElement('p');status.id='dotDataStatus';status.setAttribute('role','status');$('.sidefoot').prepend(status);
    $('#mapSourceStatus').hidden=true;
    const listHeading=$('#periodStoreListSection .sectiontitle');for(const node of [...listHeading.childNodes])if(node.nodeType===Node.TEXT_NODE)node.remove();
    dockDetail();syncStatus();arrangeNavigation();
    window.addEventListener('map-manual-route',arrangeNavigation);
    observer=new MutationObserver(syncStatus);for(const node of [$('#packageReadState'),$('#freshnessState')])observer.observe(node,{attributes:true,childList:true,subtree:true,characterData:true});
    resizeObserver=new ResizeObserver(()=>{window.MapUiLocalBridge?.state.map?.relayout();dockDetail();});resizeObserver.observe($('.maparea'));
    window.addEventListener('pagehide',e=>{if(e.persisted)return;observer.disconnect();resizeObserver.disconnect();window.removeEventListener('map-manual-route',arrangeNavigation);},{once:true});
  }
  window.MapDotUi=Object.freeze({mount,dockDetail,describeRoute,arrangeNavigation});
})();

