  // Approved Site design shell connected to preserved local controllers; no remote write.
(() => {
  const $=selector=>document.querySelector(selector),bridge=window.MapUiLocalBridge;
  const retainedStyles=['approved-site-source.css','map-approved-shell-candidate.css','map-staff.css','map-staff-entry.css','map-dot-ui.css','navigation-ui.css','opsmap-delivery-photos.css','manual-map-pins.css','map-performance.css'];
  for(const sheet of [...document.styleSheets])if(!retainedStyles.some(name=>sheet.href?.includes(name)))sheet.disabled=true;
  document.body.classList.add('approvedShellCandidate','layout-B');
  const header=document.createElement('header');header.id='approvedSiteHeader';
  const brand=document.createElement('div');brand.id='mapHeaderBrand';brand.className='brand';brand.innerHTML='<span>운영지도</span>';brand.prepend($('#officialBrand'));
  const tabs=document.createElement('nav');for(const id of ['modePeriod','modeDaily']){const button=$('#'+id);button.classList.add('tab');tabs.append(button);}
  const shortcuts=$('#approvedShortcuts');shortcuts.className='headerLinks';header.append(brand,tabs,shortcuts,$('#staffLogout'));
  document.body.prepend(header);
  const workspace=document.createElement('main');workspace.className='workspace';
  const sidebar=$('#leftPanel');sidebar.className='sidebar leftPanel';
  const oldHead=sidebar.querySelector('.head');oldHead.hidden=true;
  const sidehead=document.createElement('div');sidehead.className='sidehead';sidehead.innerHTML='<div><span class="eyebrow" id="modeEyebrow">매장 조회</span><h1 id="modeTitle">매장·권역 조회</h1></div><button class="count" id="totalBadge" aria-label="매장 목록">확인 중</button>';
  const scroll=document.createElement('div');scroll.className='scrollside';
  while(sidebar.firstChild)scroll.append(sidebar.firstChild);
  sidebar.append(sidehead,scroll);
  const dock=document.createElement('div');dock.id='layoutDock';
  const dailyQuery=document.createElement('div');dailyQuery.id='dailyQuerybar';dailyQuery.className='mapcontext';dailyQuery.innerHTML='<label for="selectedDate">운행일</label><button id="chooseRoutes">전체 호차 ▾</button>';
  dock.append(dailyQuery);scroll.prepend(dock);
  dailyQuery.insertBefore($('#selectedDate'),$('#chooseRoutes'));dailyQuery.insertBefore($('#todayBtn'),$('#chooseRoutes'));$('#todayBtn').textContent='최신일';
  const summary=document.createElement('div');summary.id='dailySummary';
  for(const [id,label] of [['opTotal','전체'],['opCompleted','완료'],['opRemaining','남은 방문'],['opEta','종료 예정']]){const cell=document.createElement('div');cell.innerHTML=`<span>${label}</span>`;const value=$('#'+id);if(id==='opCompleted')value.classList.add('green');cell.append(value);summary.append(cell);}
  const navigation=document.createElement('div');navigation.id='navigationPreview';
  const road=$('#roadRoutePanel');road.innerHTML='<div><span class="eyebrow">길찾기</span><h2>도로 경로 <span>자동차</span></h2><p id="navSelection"></p><p id="osanOrigin">출발지를 선택해 주세요.</p></div><div class="navMetrics"><span>주행거리 <b id="roadRouteDistance">— km</b></span><span>예상 소요 <b id="roadRouteDuration">— 분</b></span></div><p class="hint" id="roadRouteStatus">출발지와 목적지를 선택해 주세요.</p><p class="hint" id="roadRouteCoverage"></p>';
  const syncRow=document.createElement('div');syncRow.className='row';const syncButton=$('#syncOperation');syncRow.append(syncButton);syncButton.textContent='운행 새로고침';road.append(syncRow);navigation.append(road);
  dock.append(dailyQuery,summary,navigation);scroll.prepend(dock);
  const search=$('.customerBlock');search.className='customerBlock';search.querySelector('.label > span').textContent='매장 검색';search.querySelector('.label').className='sourceSearchLabel';search.querySelector('.searchLine').classList.add('row');$('#query').placeholder='고객코드 · 매장명 · 도로명·지번';$('#searchBtn').className='primary';
  const address=$('.addressBlock');address.querySelector('.label').hidden=false;address.querySelector('.label > span').textContent='도로명·지번 주소';address.querySelector('.searchLine').classList.add('row');$('#addressQuery').placeholder='예: 수원시청';$('#addressBtn').textContent='위치 찾기';address.querySelector('.hint').textContent='위치 기준 30km 주변 호차 · 참고용';
  search.append($('#searchNotice'),$('#addressJudgeResults'));
  const filters=$('#periodFilterPanel');filters.className='generalCenters';
  const filterTitle=filters.querySelector('.label');filterTitle.className='sectiontitle';filterTitle.innerHTML='<h2>담당 센터</h2><button id="sourceCenterReset" class="textbtn">전체 보기</button>';
  const centers=document.createElement('div');centers.className='centers';centers.id='centers';centers.innerHTML=[['all','전체'],['osan','오산'],['yeongnam','영남'],['honam','호남']].map(([key,label])=>`<button data-source-center="${key}" class="${key==='all'?'active':''}">${label}</button>`).join('');filters.append(centers);
  const basePicker=document.createElement('details');basePicker.id='baseVehiclePicker';basePicker.innerHTML='<summary>호차 선택 <span id="baseVehicleCount">전체</span></summary>';filters.append(basePicker);
  function setCenter(key){if(bridge.state.mode!=='BASE_60D')return;$('#periodCenter').value=key;$('#periodCenter').dispatchEvent(new Event('change'));centers.querySelectorAll('button').forEach(button=>button.classList.toggle('active',button.dataset.sourceCenter===key));}
  centers.querySelectorAll('button').forEach(button=>button.onclick=()=>setCenter(button.dataset.sourceCenter));$('#sourceCenterReset').onclick=()=>setCenter('all');
  const planner=document.createElement('details');planner.id='waypointPlanner';planner.open=true;
  planner.innerHTML=`<summary class="sectiontitle"><h2>경로 설정</h2><span class="muted">자동차</span></summary>
    <p class="hint plannerHelp">매장이나 주소를 검색해 각 지점을 지정하세요.</p>
    <div class="navEditorField" data-point-role="origin"><label for="plannerStart"><span class="pointRole origin">출발</span> 출발지</label><div class="pointInputRow"><input id="plannerStart" data-nav-role="origin" aria-label="출발지 검색" placeholder="고객코드·매장명·주소 검색" autocomplete="off"><button id="clearOrigin" type="button" class="pointClear" aria-label="출발지 지우기" title="출발지 지우기">×</button></div></div>
    <div id="plannerStops"></div><button id="addWaypoint" type="button" class="full addWaypoint">＋ 경유지 추가</button>
    <div class="navEditorField" data-point-role="destination"><label for="plannerEnd"><span class="pointRole destination">도착</span> 목적지</label><div class="pointInputRow"><input id="plannerEnd" data-nav-role="destination" aria-label="목적지 검색" placeholder="고객코드·매장명·주소 검색" autocomplete="off"><button id="clearDestination" type="button" class="pointClear" aria-label="목적지 지우기" title="목적지 지우기">×</button></div></div>
    <button id="reversePlanner" type="button" class="textbtn reversePlanner">⇅ 순서 뒤집기</button>
    <div class="plannerMetrics"><span>총거리 <b>— km</b></span><span>예상시간 <b>— 분</b></span></div>
    <div class="row plannerActions"><button id="planRoute" type="button" class="primary">경로 조회</button><button id="clearPlanner" type="button">전체 지우기</button></div>
    <div id="plannerStatus" class="plannerStatus" role="status" aria-live="polite" hidden></div>`;
  filters.after(planner);
  // Navigation editor: these values retain their explicit roles, including empty fields.
  const waypoints=[];
  function draftChanged({clearDraft=false}={}){
    $('#plannerStatus').hidden=true;
    if(clearDraft&&bridge.clearManual)bridge.clearManual();
    else if(bridge.navigationChanged)bridge.navigationChanged();else bridge.cancelManualRoute?.();
    window.dispatchEvent(new CustomEvent('map-navigation-draft'));
  }
  function readEditorInput(input){return input.dataset.pointCode||input.value;}
  function writeEditorInput(input,code){
    delete input.dataset.pointCode;
    if(/^POINT_\d+$/.test(String(code))){const found=window.MapNavigation?.resolve(code)||[];if(found.length===1){input.dataset.pointCode=code;input.value=found[0].customerName||found[0].address||'선택한 주소';return;}}
    input.value=code;
  }
  $('#plannerStart').oninput=$('#plannerEnd').oninput=function(){delete this.dataset.pointCode;draftChanged();};
  function renderWaypoints(){
    const container=$('#plannerStops');container.replaceChildren();
    waypoints.forEach((text,index)=>{
      const row=document.createElement('div');row.className='waypointRow navEditorField';row.dataset.pointRole='waypoint';
      const label=document.createElement('label');label.htmlFor='plannerWaypoint'+index;
      const role=document.createElement('span');role.className='pointRole waypoint';role.textContent=String(index+1);label.append(role,' 경유지 '+(index+1));
      const controls=document.createElement('div');controls.className='waypointInput pointInputRow';
      const input=document.createElement('input');input.id='plannerWaypoint'+index;writeEditorInput(input,text);input.autocomplete='off';input.placeholder='고객코드·매장명·주소 검색';input.dataset.navRole='waypoint';input.dataset.navIndex=String(index);input.setAttribute('aria-label','경유지 '+(index+1)+' 검색');
      input.oninput=()=>{delete input.dataset.pointCode;waypoints[index]=input.value;draftChanged();};controls.append(input);
      for(const [name,title,disabled,action] of [['↑','경유지 '+(index+1)+' 위로',index===0,()=>{[waypoints[index-1],waypoints[index]]=[waypoints[index],waypoints[index-1]];}],['↓','경유지 '+(index+1)+' 아래로',index===waypoints.length-1,()=>{[waypoints[index+1],waypoints[index]]=[waypoints[index],waypoints[index+1]];}],['×','경유지 '+(index+1)+' 삭제',false,()=>waypoints.splice(index,1)]]){
        const button=document.createElement('button');button.type='button';button.textContent=name;button.title=title;button.setAttribute('aria-label',title);button.disabled=disabled;button.onclick=()=>{action();renderWaypoints();draftChanged();};controls.append(button);
      }
      row.append(label,controls);container.append(row);
    });
  }
  function editorValues(){return [readEditorInput($('#plannerStart')),...waypoints,readEditorInput($('#plannerEnd'))];}
  function pointIdentity(value){const text=String(value||'').trim();const found=window.MapNavigation?.resolve(text)||bridge.lookupStore(text);return found?.length===1?String(found[0].customerCode||text):text;}
  function setEditorPoint(role,value,index){
    if(!['origin','destination','waypoint'].includes(role))throw Error('출발지, 경유지, 목적지 중에서 선택해 주세요.');
    const code=String(value||'').trim();if(!code)throw Error('지점을 선택해 주세요.');
    let target=index;
    if(role==='waypoint'){
      if(index!==undefined&&(!Number.isInteger(index)||index<0||index>=waypoints.length))throw Error('변경할 경유지를 다시 선택해 주세요.');
      if(index===undefined){target=waypoints.findIndex(v=>!String(v).trim());if(target<0)target=waypoints.length;}
      if(target>=30)throw Error('경유지는 최대 30개입니다.');
    }
    const current=role==='origin'?readEditorInput($('#plannerStart')):role==='destination'?readEditorInput($('#plannerEnd')):waypoints[target];
    const id=pointIdentity(code);if(current&&pointIdentity(current)===id)return false;
    const repeated=waypoints.some((v,i)=>String(v).trim()&&i!==(role==='waypoint'?target:-1)&&pointIdentity(v)===id);
    const endpointDuplicate=role==='waypoint'&&[readEditorInput($('#plannerStart')),readEditorInput($('#plannerEnd'))].some(v=>String(v).trim()&&pointIdentity(v)===id);
    if(repeated||endpointDuplicate)throw Error('이미 경로에 지정된 매장입니다. 기존 지점을 지우거나 다른 매장을 선택해 주세요.');
    if(role==='origin')writeEditorInput($('#plannerStart'),code);
    else if(role==='destination')writeEditorInput($('#plannerEnd'),code);
    else{waypoints[target]=code;renderWaypoints();}
    draftChanged();return true;
  }
  function removeEditorPoint(role,index){
    if(role==='origin')writeEditorInput($('#plannerStart'),'');
    else if(role==='destination')writeEditorInput($('#plannerEnd'),'');
    else if(role==='waypoint'&&Number.isInteger(index)&&index>=0&&index<waypoints.length){waypoints.splice(index,1);renderWaypoints();}
    else throw Error('지울 지점을 다시 선택해 주세요.');
    draftChanged();
  }
  function replaceEditorPoints(codes){
    if(!Array.isArray(codes)||codes.length<2||codes.length>32)throw Error('출발지와 목적지를 포함해 2~32개 지점을 선택해 주세요.');
    const next=codes.map((value,index)=>{
      const code=String(value||'').trim();if(!code)throw Error((index+1)+'번째 지점을 선택해 주세요.');
      const found=window.MapNavigation?.resolve(code)||bridge.lookupStore(code);
      if(found.length!==1||found[0].coordinateStatus==='CONFLICT'||!Number.isFinite(found[0].lat)||!Number.isFinite(found[0].lng)||found[0].lat<33||found[0].lat>39.5||found[0].lng<124||found[0].lng>132)throw Error((index+1)+'번째 매장의 위치를 확인할 수 없습니다.');
      return String(found[0].customerCode||code);
    });
    const seen=new Set();
    for(let index=0;index<next.length;index++){const code=next[index];if(seen.has(code)&&!(index===next.length-1&&code===next[0]))throw Error('목록에 같은 매장이 반복되어 있습니다. 중복 방문을 확인해 주세요.');seen.add(code);}
    // Validate the complete list before mutating any role; never truncate visits.
    writeEditorInput($('#plannerStart'),next[0]);writeEditorInput($('#plannerEnd'),next[next.length-1]);waypoints.splice(0,waypoints.length,...next.slice(1,-1));renderWaypoints();draftChanged();
  }
  function reverseEditor(){const start=readEditorInput($('#plannerStart')),end=readEditorInput($('#plannerEnd'));writeEditorInput($('#plannerStart'),end);writeEditorInput($('#plannerEnd'),start);waypoints.reverse();renderWaypoints();draftChanged();}
  $('#addWaypoint').onclick=()=>{if(waypoints.length>=30){$('#plannerStatus').hidden=false;$('#plannerStatus').textContent='경유지는 최대 30개입니다.';return;}waypoints.push('');renderWaypoints();draftChanged();$('#plannerWaypoint'+(waypoints.length-1)).focus();};
  $('#clearOrigin').onclick=()=>removeEditorPoint('origin');$('#clearDestination').onclick=()=>removeEditorPoint('destination');$('#reversePlanner').onclick=reverseEditor;
  $('#clearPlanner').onclick=()=>{waypoints.length=0;writeEditorInput($('#plannerStart'),'');writeEditorInput($('#plannerEnd'),'');renderWaypoints();draftChanged({clearDraft:true});};
  $('#planRoute').onclick=async()=>{
    if($('#planRoute').disabled)return;const status=$('#plannerStatus');
    try{
      const values=editorValues();
      const points=values.map((value,index)=>{
        const role=index===0?'출발지':index===values.length-1?'목적지':'경유지 '+index;
        if(!String(value).trim())throw Error(role+'를 선택해 주세요.');
        const found=window.MapNavigation?.resolve(value)||bridge.lookupStore(value);
        if(found.length!==1)throw Error(role+' 검색 결과에서 매장이나 주소를 선택해 주세요.');
        if(found[0].coordinateStatus==='CONFLICT'||!Number.isFinite(found[0].lat)||!Number.isFinite(found[0].lng))throw Error(role+'의 위치를 확인할 수 없습니다. 다른 지점을 선택해 주세요.');
        return {...found[0],label:found[0].customerName||value};
      });
      status.hidden=false;status.textContent='도로 경로를 조회하고 있습니다.';
      bridge.replaceManualStops(points);await bridge.queryManualRoute();
    }catch(error){status.hidden=false;status.textContent=error.message;}
  };
  window.MapNavigationEditor=Object.freeze({values:editorValues,setPoint:setEditorPoint,removePoint:removeEditorPoint,replacePoints:replaceEditorPoints,reverse:reverseEditor,clear:()=>$('#clearPlanner').click()});
  const stores=$('#periodStoreListSection');stores.className='storeSection';stores.querySelector('.label').className='sectiontitle';const title=document.createElement('h2');title.append('매장 목록 ',$('#periodStoreListCount'));stores.querySelector('.sectiontitle').prepend(title);$('#togglePeriodList').className='textbtn';
  const loadMore=document.createElement('button');loadMore.id='loadMore';loadMore.className='full';loadMore.textContent='매장 더 보기';loadMore.onclick=()=>stores.classList.add('showMoreStores');stores.append(loadMore);$('#periodStoreList').className='sourceStoreList';
  const route=$('#runListTool');route.className='sourceItinerary';route.open=true;
  const foot=document.createElement('footer');foot.className='sidefoot';foot.innerHTML='<button id="sourceBatch" class="full">＋ 신규권역 일괄조회</button><div class="row" id="sourceFooterLinks"></div>';
  sidebar.append(foot);const data=$('.dataHelp');data.remove();data.append(oldHead,$('#mapDataHealth'));oldHead.hidden=false;const advanced=document.createElement('details');advanced.innerHTML='<summary>추가 조회 조건</summary>';data.append(advanced);for(const node of [$('.periodBasis'),$('#allStoresControl'),$('#legacyVehicleState'),$('#periodDriver'),$('#periodCenter'),$('#manualRouteTool')])advanced.append(node);
  const picker=document.createElement('details');picker.id='sourceRoutePicker';picker.hidden=true;picker.innerHTML='<summary>호차 다중 선택</summary>';picker.append($('#operationVehicle'));dock.append(picker);$('#chooseRoutes').onclick=()=>{picker.hidden=!picker.hidden;picker.open=!picker.hidden;picker.append($('#legacyVehicleState'));};
  $('#sourceFooterLinks').append(data,$('#openOperations'));sidebar.append(foot);$('#sourceBatch').onclick=()=>{$('#newAreaBatchTool').hidden=false;$('#newAreaBatchTool').open=!$('#newAreaBatchTool').open;};$('#newAreaBatchTool').hidden=true;
  const maparea=document.createElement('div');maparea.className='maparea';maparea.append($('#map'));
  const mapTop=document.createElement('div');mapTop.className='maptop';const context=document.createElement('div');context.className='mapcontext';context.id='generalMapContext';context.innerHTML='';
  const controls=document.createElement('div');controls.className='row';controls.append($('#mapReset'),$('#areaToggle'));mapTop.append(context,controls);maparea.append(mapTop);
  const mapBottom=document.createElement('div');mapBottom.className='mapbottom';const legend=$('.legend');legend.classList.add('vehicleLegend');legend.replaceChildren();mapBottom.append(legend);maparea.append(mapBottom);
  bridge.setGeneralLegend(legend.innerHTML);
  workspace.append(sidebar,maparea);document.body.insertBefore(workspace,header.nextSibling);
  for(const selector of ['#mapModeBar','#operationBar','.mapStatus','.mobileMapControls','#mobileBack','#mobileRouteSheet','#mobileWorkspace']){const node=$(selector);if(node)node.classList.add('compatibilityHidden');}
  function sync(){const daily=$('#modeDaily').getAttribute('aria-pressed')==='true';document.body.classList.toggle('daily-mode',daily);$('#modePeriod').classList.toggle('active',!daily);$('#modeDaily').classList.toggle('active',daily);dock.hidden=!daily;address.hidden=true;filters.hidden=daily;context.hidden=true;route.hidden=!daily;syncModeControls(daily);if(!daily){picker.hidden=true;}$('#modeEyebrow').textContent=daily?'운행 조회':'매장 조회';$('#modeTitle').textContent=daily?'일자별 운행 조회':'매장·권역 조회';$('#totalBadge').textContent=$('#periodStoreListCount').textContent||'확인 중';const vehicles=bridge.state.selectedVehicles;$('#chooseRoutes').textContent=vehicles.length===1?`${vehicles[0]}호차 ▾`:vehicles.length?`${vehicles.length}개 호차 ▾`:'전체 호차 ▾';$('#navSelection').textContent=$('#chooseRoutes').textContent.replace(' ▾','');for(const card of $('#periodStoreList').querySelectorAll('button')){card.classList.add('storeitem');card.style.overflowWrap='anywhere';} }
  $('#totalBadge').onclick=()=>{$('#togglePeriodList').click();};
  // Match the source element roles; IDs and existing controller handlers stay intact.
  for(const id of ['opTotal','opCompleted','opRemaining','opEta']){const old=$('#'+id),strong=document.createElement('strong');strong.id=id;strong.className=old.className;strong.textContent=old.textContent;old.replaceWith(strong);}
  $('#totalBadge').classList.add('sourceCount');
  $('#openOperations').textContent='연결 상태';
  const runHead=route.querySelector('summary');runHead.className='sectiontitle';
  const runHeading=document.createElement('h2');$('#runListTitle').replaceWith(runHeading);runHeading.id='runListTitle';runHeading.textContent='방문 순서';
  $('#runListCount').className='muted';$('#runListPanel .runFilters').className='segment';
  $('#syncOperation').className='';
  $('#roadRoutePanel').style.display='contents';
  const manualShortcut=document.createElement('button');manualShortcut.id='sourceManualShortcut';manualShortcut.textContent='경유 내비';manualShortcut.onclick=()=>{planner.hidden=false;planner.scrollIntoView({block:'start'});};data.append(manualShortcut);
  const areaShortcut=document.createElement('button');areaShortcut.id='sourceAreaShortcut';areaShortcut.textContent='신규권역 일괄조회';areaShortcut.onclick=()=>$('#sourceBatch').click();data.append(areaShortcut);
  advanced.append($('#periodControls'),$('#operationsPanel'));$('#mapDateBar').classList.add('compatibilityHidden');
  const controllerCount=$('#periodStoreListCount'),displayCount=document.createElement('span');displayCount.id='sourceListCount';controllerCount.replaceWith(displayCount);advanced.append(controllerCount);
  const result=$('#results');result.className='results';result.hidden=!result.childNodes.length;new MutationObserver(()=>result.hidden=!result.childNodes.length).observe(result,{childList:true});
  maparea.append($('#detailSection'));$('#legacyVehicleState').hidden=false;
  for(const section of scroll.querySelectorAll(':scope>section'))if(!section.children.length)section.remove();
  const routeDialog=document.createElement('dialog');routeDialog.id='routeDialog';routeDialog.innerHTML='<div class="modalhead"><div><span class="eyebrow">운행 조회</span><h2>운행 조회 조건</h2></div><button id="closeRoutes" aria-label="운행 조건 닫기">✕</button></div>';
  document.body.append(routeDialog);const dailyForm=$('#dailyControls');dailyForm.replaceChildren();dailyForm.hidden=false;routeDialog.append(dailyForm);
  function formRow(...nodes){const row=document.createElement('div');row.className='row';row.append(...nodes);return row;}
  function formLabel(text){const label=document.createElement('label');label.textContent=text;return label;}
  dailyForm.append(formLabel('조회 기간'),formRow($('#rangeStart'),$('#rangeEnd')),formRow($('#applyPeriod'),$('#recent60')),formLabel('호차 · 기사 조회'));
  const basis=$('.periodBasis');basis.className='periodBasis row basis';dailyForm.append(basis,$('#periodDriver'));
  const routeChecks=$('#vehicleList');routeChecks.className='routechecks';dailyForm.append(routeChecks,formRow($('#selectAllVehicles'),$('#clearVehicles')));
  $('#selectAllVehicles').textContent='전체 호차';$('#clearVehicles').textContent='선택 해제';
  const queryRoutes=document.createElement('button');queryRoutes.id='queryRoutes';queryRoutes.className='primary full';queryRoutes.textContent='운행 조회';dailyForm.append(queryRoutes);
  const queryStatus=document.createElement('p');queryStatus.id='querySubmitStatus';queryStatus.className='hint';queryStatus.setAttribute('role','status');dailyForm.append(queryStatus);
  queryRoutes.onclick=async()=>{if(queryRoutes.disabled||bridge.state.mode!=='DATE_ROUTE')return;queryRoutes.disabled=true;queryStatus.textContent='운행 내역을 불러오고 있습니다.';try{const result=await bridge.submitDailyQuery($('#selectedDate').value,$('#selectedDate').value);if(result.ok){queryStatus.textContent='';routeDialog.close();}else queryStatus.textContent=result.message;}catch(error){queryStatus.textContent='조회 실패 · '+error.message;}finally{queryRoutes.disabled=false;}};
  const routeHelp=document.createElement('p');routeHelp.className='hint';routeHelp.textContent='선택 배송일의 확정호차와 방문 순서를 표시합니다.';dailyForm.append(routeHelp);
  const advancedRoutes=document.createElement('details');advancedRoutes.className='sourceAdvancedRoutes';advancedRoutes.innerHTML='<summary>호차 단일 선택·검색</summary>';advancedRoutes.append($('#operationVehicle'),$('#vehicleTrigger'),$('#vehicleQuery'));dailyForm.append(advancedRoutes);
  $('#sourceRoutePicker').hidden=true;document.body.append(routeDialog);$('#closeRoutes').onclick=()=>routeDialog.close();
  $('#chooseRoutes').onclick=()=>{if(bridge.state.mode!=='DATE_ROUTE')return;syncModeControls(true);routeDialog.showModal();};
  const periodButton=document.createElement('button');periodButton.id='openPeriodQuery';periodButton.textContent='기간별 조회';context.append(periodButton);
  periodButton.onclick=()=>{if(bridge.state.mode!=='BASE_60D')return;dailyForm.hidden=false;syncModeControls(false,true);routeDialog.showModal();};
  for(const id of ['applyPeriod','recent60']){const button=$('#'+id),run=button.onclick;button.onclick=event=>{routeDialog.close();return run?.(event);};}
  // Keep the existing controller's deferred-page action reachable after closing
  // the query dialog. The page itself remains bounded to seven complete dates.
  const placeNext=()=>{const button=$('#nextPeriodPage');if(button&&button.parentNode!==context)context.append(button);};
  new MutationObserver(placeNext).observe(dailyForm,{childList:true,subtree:true});
  const batchDialog=document.createElement('dialog');batchDialog.id='mapBatchDialog';batchDialog.innerHTML='<div class="modalhead"><div><span class="eyebrow">배송 가능 지역</span><h2>신규권역 일괄조회</h2></div><button id="closeBatch" aria-label="신규권역 조회 닫기">✕</button></div>';document.body.append(batchDialog);batchDialog.append($('#newAreaBatchTool'));
  $('#sourceBatch').onclick=()=>{if(bridge.state.mode!=='BASE_60D')return;$('#newAreaBatchTool').hidden=false;$('#newAreaBatchTool').open=true;batchDialog.showModal();};$('#closeBatch').onclick=()=>{if($('#judgeNewAreaBatch').disabled)$('#cancelNewAreaBatch').click();batchDialog.close();};batchDialog.addEventListener('cancel',()=>{if($('#judgeNewAreaBatch').disabled)$('#cancelNewAreaBatch').click();});
  batchDialog.addEventListener('close',()=>{if($('#judgeNewAreaBatch').disabled)$('#cancelNewAreaBatch').click();$('#newAreaBatchTool').open=false;});
  const dataDialog=document.createElement('dialog');dataDialog.id='mapDataInfoDialog';dataDialog.innerHTML='<div class="modalhead"><div><span class="eyebrow">조회 자료</span><h2>데이터 안내</h2></div><button id="closeDataInfo" aria-label="데이터 안내 닫기">✕</button></div>';document.body.append(dataDialog);
  const dataContent=document.createElement('div');dataContent.className='sourceDataContent dataHelp';for(const child of [...data.children])if(child.tagName!=='SUMMARY')dataContent.append(child);dataDialog.append(dataContent);dataContent.append(periodButton);
  function modeVisible(node,visible){if(!node)return;node.hidden=!visible;node.inert=!visible;node.dataset.modeHidden=String(!visible);}
  let controlsMode=null;
  function syncModeControls(daily,historyDialog=false){
    for(const node of [search,address,filters,stores,$('#sourceBatch'),$('#sourceAreaShortcut'),$('#sourceManualShortcut'),$('#areaToggle')])modeVisible(node,!daily&&node!==address&&node.id!=='sourceManualShortcut');
    modeVisible(planner,daily);modeVisible(periodButton,!daily);modeVisible(context,false);
    const host=daily?dailyForm:basePicker;for(const node of [routeChecks,$('#selectAllVehicles'),$('#clearVehicles')])if(node.parentNode!==host)host.append(node);
    modeVisible($('#legacyVehicleState'),!daily);if(!daily&&$('#legacyVehicleState').parentNode!==basePicker)basePicker.append($('#legacyVehicleState'));
    const rangeRow=$('#rangeStart').parentNode,applyRow=$('#applyPeriod').parentNode;modeVisible(rangeRow,!daily);modeVisible(applyRow,!daily);modeVisible(basis,false);modeVisible($('#periodDriver'),false);
    modeVisible(queryRoutes,daily);modeVisible(routeHelp,daily);modeVisible(advancedRoutes,daily);
    for(const label of dailyForm.querySelectorAll(':scope>label'))modeVisible(label,!daily);
    if(controlsMode!==daily&&routeDialog.open)routeDialog.close();if(daily&&batchDialog.open)batchDialog.close();controlsMode=daily;modeVisible($('#allStoresControl'),!daily);modeVisible($('#manualRouteTool'),false);
  }
  const openDiagnostics=$('#openOperations').onclick;
  $('#openOperations').onclick=event=>{advanced.open=true;$('#operationsPanel').hidden=true;if(!dataDialog.open)dataDialog.showModal();return openDiagnostics?.(event);};
  const visibleStatus=document.createElement('div');visibleStatus.id='mapSourceStatus';visibleStatus.className='mapSourceStatus';visibleStatus.setAttribute('aria-label','지도 데이터 확인 상태');visibleStatus.append($('#packageReadState'),$('#sourceCollectedAt'),$('#mapAppliedRange'),$('#freshnessState'));maparea.append(visibleStatus);
  data.querySelector('summary').onclick=event=>{event.preventDefault();dataDialog.showModal();};$('#closeDataInfo').onclick=()=>dataDialog.close();
  manualShortcut.onclick=()=>{if(bridge.state.mode!=='DATE_ROUTE')return;dataDialog.close();planner.hidden=false;planner.scrollIntoView({block:'start'});};
  function sourceCenterLabel(row){
    const names={osan:'오산',yeongnam:'영남',honam:'호남','011':'오산','012':'영남','013':'호남','오산':'오산','영남':'영남','호남':'호남','오산센터':'오산','영남센터':'영남','호남센터':'호남'};
    const verified=['VERIFIED_MASTER','UNASSIGNED'].includes(row.baseVehicleState)&&row.baseVehicleSource==='FIXED_DISPATCH_PRIMARY'&&/^[a-f0-9]{64}$/.test(row.baseVehicleVersion||'');
    if(verified&&names[row.baseVehicleGroup]){const name=names[row.baseVehicleGroup];if(row.baseVehicleStale===false)return name;const date=String(row.baseVehicleCheckedAt||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return name+(date?` · ${Number(date[2])}/${Number(date[3])} 기준`:' · 이전 자료');}
    // Only explicit dispatch-center fields may supply a center. The address is never a center source.
    for(const raw of [row.dispatchCenterCode,row.centerId,row.centerCode,row.centerName,typeof row.center==='string'?row.center:row.center?.id,typeof row.center==='object'?row.center?.name:null]){const name=names[String(raw||'').trim()];if(name)return name;}
    return '';
  }
  function sourceVehicleLabel(row,daily,vehicle){
    if(daily)return vehicle?`${vehicle}호차`:'호차 확인 필요';
    const label=vehicle?`${vehicle}호차`:({UNASSIGNED:'호차 미지정',NOT_IN_MASTER:'기준표 미등록',CONFLICT:'기준호차 충돌'}[row.baseVehicleState]||'호차 확인 필요');
    return label+(row.baseVehicleStale?' · 이전 확인값':'');
  }
  function sourceCard(button,row,daily){
    if(!row)return;const vehicle=String((daily?row.vehicle:Object.hasOwn(row,'baseVehicle')?row.baseVehicle:row.vehicle)||'').trim();const key=JSON.stringify([row.customerName,row.customerCode,vehicle,row.status,daily,row.address,row.customerAddress,row.baseVehicleState,row.baseVehicleSource,row.baseVehicleVersion,row.baseVehicleStale,row.baseVehicleGroup,row.baseVehicleCheckedAt,row.dispatchCenterCode,row.centerCode,row.centerId,row.center,row.centerName]);if(button.dataset.sourceCard===key)return;
    button.dataset.sourceCard=key;button.classList.add('storeitem');
    button.title=[row.customerCode,row.customerName,row.address||row.customerAddress].filter(Boolean).join(' · ');button.replaceChildren();
    const icon=document.createElement('span');icon.className='icon';icon.textContent=daily?String(row.order||'—'):'•';icon.setAttribute('aria-hidden','true');
    const text=document.createElement('span');text.className='itemtxt';const code=document.createElement('small');code.className='storeCode';code.textContent=row.customerCode||'고객코드 확인 필요';const name=document.createElement('b');name.textContent=row.customerName||row.customerCode||'이름 없는 매장';const meta=document.createElement('small');
    const center=sourceCenterLabel(row);
    meta.textContent=center;const badge=document.createElement('span');badge.className='vehicleColorBadge';badge.dataset.vehicle=vehicle;badge.style.setProperty('--vehicle-color',Phase2bUi.vehicleColor(vehicle));badge.textContent=sourceVehicleLabel(row,daily,vehicle);if(meta.textContent)meta.append(' · ');meta.append(badge);text.append(code,name,meta);
    const addressText=row.address||row.customerAddress;if(addressText){const address=document.createElement('small');address.className='storeAddress';address.textContent=addressText;text.append(address);}
    const status=document.createElement('span');status.className='status'+(row.status==='COMPLETED'?' done':'');status.textContent=daily?(row.status==='COMPLETED'?'완료':row.status==='PENDING'?'미완료':'—'):'›';button.append(icon,text,status);
  }
  let visibleStoreLimit=5;
  let vehicleLegendKey='';
  function syncVehicleLegend(){
    const keys=[...new Set(bridge.state.currentRows.map(row=>Phase2bUi.vehicleColorKey(row.vehicle)))].sort((a,b)=>a.localeCompare(b,'ko',{numeric:true}));
    const key=JSON.stringify([bridge.state.mode,keys]);if(key===vehicleLegendKey)return;vehicleLegendKey=key;legend.replaceChildren();
    const heading=document.createElement('strong');heading.textContent=bridge.state.mode==='DATE_ROUTE'?'실제 호차':'기준호차';legend.append(heading);
    for(const vehicle of keys){const item=document.createElement('span');item.dataset.vehicle=vehicle;const dot=document.createElement('i');dot.style.background=Phase2bUi.vehicleColor(vehicle);item.append(dot,vehicle?`${vehicle}호차`:'호차 미확인');legend.append(item);}
    const clusters=document.createElement('span');clusters.className='clusterLegend';clusters.textContent='숫자는 매장 수입니다';legend.append(clusters);bridge.setGeneralLegend(legend.innerHTML);
  }
  loadMore.onclick=()=>{if(bridge.isDataReady()&&bridge.state.currentRows.length&&!$('#periodStoreList').querySelector('[data-period-store]')){visibleStoreLimit=5;$('#togglePeriodList').click();sourceSync();return;}visibleStoreLimit+=5;if($('#periodStoreList').querySelectorAll('[data-period-store]').length<visibleStoreLimit&&!$('#periodListMore').hidden)$('#periodListMore').click();sourceSync();};
  function sourceSync(){
    syncVehicleLegend();
    $('#periodDriver').disabled=$('input[name="periodBasis"][value="vehicle"]').checked;
    for(const name of routeChecks.querySelectorAll('.vehicleNo'))if(name.textContent.endsWith('호'))name.textContent+='차';
    const daily=document.body.classList.contains('daily-mode');planner.hidden=!daily;stores.hidden=daily;$('#sourceBatch').hidden=daily;
    const centerValue=$('#periodCenter').value||'all';for(const button of centers.querySelectorAll('button')){const active=button.dataset.sourceCenter===centerValue;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));}
    const selected=bridge.state.selectedVehicles;const selectedText=selected.length===1?selected[0]+'호차':selected.length?selected.length+'개 선택':'전체';if($('#baseVehicleCount').textContent!==selectedText)$('#baseVehicleCount').textContent=selectedText;
    // Reconcile only presentation of disabled state; operational partial/error messages remain.
    if(daily){const count=new Set(bridge.state.currentRows.map(row=>row.customerCode)).size;const badge=count?`${count} 매장`:bridge.isDataReady()?'0 매장':'불러오는 중';if($('#totalBadge').textContent!==badge)$('#totalBadge').textContent=badge;
      if($('#runListTitle').textContent!=='방문 순서')$('#runListTitle').textContent='방문 순서';
      const navLabel=$('#chooseRoutes').textContent.replace(' ▾','').replace(' ?','')+(count?` · ${count}착`:'');if($('#navSelection').textContent!==navLabel)$('#navSelection').textContent=navLabel;
      const heading='자동차 경로';if($('#navigationPreview h2 span').textContent!==heading)$('#navigationPreview h2 span').textContent=heading;
      if($('#opEta').textContent.includes('과거')){$('#opEta').title=$('#opEta').textContent;$('#opEta').textContent='—';}
      // Route controllers own status, coverage and metrics; the shell must not replace them.
    }else{const match=$('#periodStoreListCount').textContent.match(/^([\d,]+)/);if(match){const text=match[1]+' 매장';if($('#totalBadge').textContent!==text)$('#totalBadge').textContent=text;}}
    if($('#syncOperation').textContent!=='운행 새로고침')$('#syncOperation').textContent='운행 새로고침';
    const countMatch=controllerCount.textContent.match(/^([\d,]+)/),countText=countMatch?countMatch[1]:controllerCount.textContent;if(displayCount.textContent!==countText)displayCount.textContent=countText;
    const toggle=$('#togglePeriodList'),toggleText=toggle.getAttribute('aria-expanded')==='true'?'접기 −':'펼치기 ＋';if(toggle.textContent!==toggleText)toggle.textContent=toggleText;
    for(const [index,button] of [...$('#periodStoreList').querySelectorAll('[data-period-store]')].entries()){sourceCard(button,bridge.lookupStore(button.dataset.periodStore)[0],false);button.hidden=index>=visibleStoreLimit;}
    loadMore.hidden=!countMatch||Number(countMatch[1].replaceAll(',',''))<=visibleStoreLimit;
    for(const button of $('#runList').querySelectorAll('[data-run-code]'))sourceCard(button,bridge.state.routeRows.find(row=>row.customerCode===button.dataset.runCode),true);
  }
  for(const node of [$('#runList'),$('#dailySummary'),$('#roadRoutePanel'),$('#periodStoreList')])new MutationObserver(sourceSync).observe(node,{childList:true,subtree:true,attributes:true,attributeFilter:['data-state']});
  new MutationObserver(sourceSync).observe($('#modeDaily'),{attributes:true,attributeFilter:['aria-pressed']});sourceSync();
  new MutationObserver(sync).observe($('#modeDaily'),{attributes:true,attributeFilter:['aria-pressed']});new MutationObserver(sync).observe($('#periodStoreListCount'),{childList:true,subtree:true,characterData:true});sync();
  if($('#togglePeriodList').getAttribute('aria-expanded')==='false')$('#togglePeriodList').click();
  window.MapStaffEntry?.status();
})();

