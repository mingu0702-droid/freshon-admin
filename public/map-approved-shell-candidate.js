  // Approved Site design shell connected to preserved local controllers; no remote write.
(() => {
  const $=selector=>document.querySelector(selector),bridge=window.MapUiLocalBridge;
  const retainedStyles=['approved-site-source.css','map-approved-shell-candidate.css','map-staff.css','map-staff-entry.css','map-dot-ui.css','navigation-ui.css','opsmap-delivery-photos.css','manual-map-pins.css'];
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
  const sidehead=document.createElement('div');sidehead.className='sidehead';sidehead.innerHTML='<div><span class="eyebrow" id="modeEyebrow">STORE NETWORK</span><h1 id="modeTitle">매장·권역 조회</h1></div><button class="count" id="totalBadge" aria-label="매장 목록">확인 중</button>';
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
  const road=$('#roadRoutePanel');road.innerHTML='<div><span class="eyebrow">NAVIGATION ROUTE</span><h2>내비 도로경로 <span>연결 대기</span></h2><p id="navSelection"></p><p id="osanOrigin">출발지를 선택해 주세요.</p></div><div class="navMetrics"><span>주행거리 <b id="roadRouteDistance">— km</b></span><span>예상 소요 <b id="roadRouteDuration">— 분</b></span></div><p class="hint" id="roadRouteStatus">도로경로 API 미연결 · 센터부터 착순 경로 연결 대기</p><p class="hint" id="roadRouteCoverage"></p>';
  const syncRow=document.createElement('div');syncRow.className='row';const syncButton=$('#syncOperation');syncRow.append(syncButton);syncButton.textContent='현재 상태 동기화';road.append(syncRow);navigation.append(road);
  dock.append(dailyQuery,summary,navigation);scroll.prepend(dock);
  const search=$('.customerBlock');search.className='customerBlock';search.querySelector('.label > span').textContent='고객·매장·주소 통합 검색';search.querySelector('.label').className='sourceSearchLabel';search.querySelector('.searchLine').classList.add('row');$('#query').placeholder='고객코드 · 매장명 · 도로명·지번';$('#searchBtn').className='primary';
  const address=$('.addressBlock');address.querySelector('.label').hidden=false;address.querySelector('.label > span').textContent='도로명·지번 주소';address.querySelector('.searchLine').classList.add('row');$('#addressQuery').placeholder='예: 수원시청';$('#addressBtn').textContent='위치 찾기';address.querySelector('.hint').textContent='위치 기준 30km 주변 호차 · 참고용';
  search.append($('#searchNotice'),$('#addressJudgeResults'));
  const filters=$('#periodFilterPanel');filters.className='generalCenters';
  const filterTitle=filters.querySelector('.label');filterTitle.className='sectiontitle';filterTitle.innerHTML='<h2>센터·권역</h2><button id="sourceCenterReset" class="textbtn">초기화</button>';
  const centers=document.createElement('div');centers.className='centers';centers.id='centers';centers.innerHTML=[['osan','오산센터'],['yeongnam','영남센터'],['honam','호남센터']].map(([key,label])=>`<button data-source-center="${key}" class="${key==='all'?'active':''}">${label}</button>`).join('');filters.append(centers);
  const basePicker=document.createElement('details');basePicker.id='baseVehiclePicker';basePicker.innerHTML='<summary>기준호차 선택</summary>';filters.append(basePicker);
  function setCenter(key){if(bridge.state.mode!=='BASE_60D')return;$('#periodCenter').value=key;$('#periodCenter').dispatchEvent(new Event('change'));centers.querySelectorAll('button').forEach(button=>button.classList.toggle('active',button.dataset.sourceCenter===key));}
  centers.querySelectorAll('button').forEach(button=>button.onclick=()=>setCenter(button.dataset.sourceCenter));$('#sourceCenterReset').onclick=()=>setCenter('all');
  const planner=document.createElement('details');planner.id='waypointPlanner';planner.innerHTML='<summary class="sectiontitle"><h2>경유 내비</h2><span class="muted">API 미연결</span></summary><p class="hint plannerHelp">입력한 순서대로 출발·경유·도착지를 연결합니다</p><label for="plannerStart">출발지</label><input id="plannerStart" placeholder="출발 주소 또는 점포명" autocomplete="off"><div id="plannerStops"></div><button id="addWaypoint" class="full">＋ 경유지 추가</button><label for="plannerEnd">도착지</label><input id="plannerEnd" placeholder="도착 주소 또는 점포명" autocomplete="off"><div class="plannerMetrics"><span>총거리 <b>— km</b></span><span>예상시간 <b>— 분</b></span></div><div class="row plannerActions"><button id="planRoute" class="primary">경로 조회</button><button id="clearPlanner">비우기</button></div><div id="plannerStatus" class="plannerStatus" role="status" hidden></div>';
  filters.after(planner);
  const waypoints=[];
  const draftChanged=()=>{bridge.navigationChanged?.();window.dispatchEvent(new CustomEvent('map-navigation-draft'));};
  $('#plannerStart').oninput=$('#plannerEnd').oninput=draftChanged;
  function renderWaypoints(){const container=$('#plannerStops');container.replaceChildren();waypoints.forEach((text,i)=>{const row=document.createElement('div');row.className='waypointRow';const label=document.createElement('label');label.textContent=`경유지 ${i+1}`;const controls=document.createElement('div');controls.className='waypointInput';const input=document.createElement('input');input.value=text;input.placeholder='경유 주소 또는 점포명';input.oninput=()=>{waypoints[i]=input.value;draftChanged();};controls.append(input);for(const [name,title,disabled,action] of [['↑','위로',i===0,()=>{[waypoints[i-1],waypoints[i]]=[waypoints[i],waypoints[i-1]];}],['↓','아래로',i===waypoints.length-1,()=>{[waypoints[i+1],waypoints[i]]=[waypoints[i],waypoints[i+1]];}],['×','삭제',false,()=>waypoints.splice(i,1)]]){const button=document.createElement('button');button.textContent=name;button.title=title;button.disabled=disabled;button.onclick=()=>{bridge.cancelManualRoute();action();renderWaypoints();};controls.append(button);}row.append(label,controls);container.append(row);});draftChanged();}
  $('#addWaypoint').onclick=()=>{bridge.cancelManualRoute();if(waypoints.length>=30){$('#plannerStatus').hidden=false;$('#plannerStatus').textContent='경유지는 최대 30개입니다.';return;}waypoints.push('');renderWaypoints();};
  $('#clearPlanner').onclick=()=>{waypoints.length=0;$('#plannerStart').value='';$('#plannerEnd').value='';$('#plannerStatus').hidden=true;renderWaypoints();bridge.clearManual();};
  $('#planRoute').onclick=async()=>{if($('#planRoute').disabled)return;const status=$('#plannerStatus');status.hidden=false;try{const values=[$('#plannerStart').value,...waypoints,$('#plannerEnd').value];const points=values.map(value=>{const found=window.MapNavigation?.resolve(value)||bridge.lookupStore(value);if(found.length!==1||found[0].coordinateStatus==='CONFLICT'||!Number.isFinite(found[0].lat)||!Number.isFinite(found[0].lng))throw Error('점포 코드 또는 주소의 확인된 위치를 선택해 주세요. 자동 주소 변환은 연결되지 않았습니다.');return {...found[0],label:found[0].customerName||value};});bridge.replaceManualStops(points);await bridge.queryManualRoute();}catch(error){status.hidden=false;status.textContent=error.message;}};
  window.MapNavigationEditor={values:()=>[$('#plannerStart').value,...waypoints,$('#plannerEnd').value],setPoint:(role,value)=>{bridge.cancelManualRoute();if(role==='origin')$('#plannerStart').value=value;else if(role==='destination')$('#plannerEnd').value=value;else{if(waypoints.length>=30)throw Error('경유지는 최대 30개입니다.');waypoints.push(value);renderWaypoints();}draftChanged();},clear:()=>$('#clearPlanner').click()};
  const stores=$('#periodStoreListSection');stores.className='storeSection';stores.querySelector('.label').className='sectiontitle';const title=document.createElement('h2');title.append('매장 목록 ',$('#periodStoreListCount'));stores.querySelector('.sectiontitle').prepend(title);$('#togglePeriodList').className='textbtn';
  const loadMore=document.createElement('button');loadMore.id='loadMore';loadMore.className='full';loadMore.textContent='매장 더 보기';loadMore.onclick=()=>stores.classList.add('showMoreStores');stores.append(loadMore);$('#periodStoreList').className='sourceStoreList';
  const route=$('#runListTool');route.className='sourceItinerary';route.open=true;
  const foot=document.createElement('footer');foot.className='sidefoot';foot.innerHTML='<button id="sourceBatch" class="full">＋ 신규권역 일괄조회</button><div class="row" id="sourceFooterLinks"></div>';
  sidebar.append(foot);const data=$('.dataHelp');data.remove();data.append(oldHead,$('#mapDataHealth'));oldHead.hidden=false;const advanced=document.createElement('details');advanced.innerHTML='<summary>기존 호차·기사·좌표 입력 기능</summary>';data.append(advanced);for(const node of [$('.periodBasis'),$('#allStoresControl'),$('#legacyVehicleState'),$('#periodDriver'),$('#periodCenter'),$('#manualRouteTool')])advanced.append(node);
  const picker=document.createElement('details');picker.id='sourceRoutePicker';picker.hidden=true;picker.innerHTML='<summary>호차 다중 선택</summary>';picker.append($('#operationVehicle'));dock.append(picker);$('#chooseRoutes').onclick=()=>{picker.hidden=!picker.hidden;picker.open=!picker.hidden;picker.append($('#legacyVehicleState'));};
  $('#sourceFooterLinks').append(data,$('#openOperations'));sidebar.append(foot);$('#sourceBatch').onclick=()=>{$('#newAreaBatchTool').hidden=false;$('#newAreaBatchTool').open=!$('#newAreaBatchTool').open;};$('#newAreaBatchTool').hidden=true;
  const maparea=document.createElement('div');maparea.className='maparea';maparea.append($('#map'));
  const mapTop=document.createElement('div');mapTop.className='maptop';const context=document.createElement('div');context.className='mapcontext';context.id='generalMapContext';context.innerHTML='';
  const controls=document.createElement('div');controls.className='row';controls.append($('#mapReset'),$('#areaToggle'));mapTop.append(context,controls);maparea.append(mapTop);
  const mapBottom=document.createElement('div');mapBottom.className='mapbottom';const legend=$('.legend');legend.classList.add('vehicleLegend');legend.replaceChildren();mapBottom.append(legend);maparea.append(mapBottom);
  bridge.setGeneralLegend(legend.innerHTML);
  workspace.append(sidebar,maparea);document.body.insertBefore(workspace,header.nextSibling);
  for(const selector of ['#mapModeBar','#operationBar','.mapStatus','.mobileMapControls','#mobileBack','#mobileRouteSheet','#mobileWorkspace']){const node=$(selector);if(node)node.classList.add('compatibilityHidden');}
  function sync(){const daily=$('#modeDaily').getAttribute('aria-pressed')==='true';document.body.classList.toggle('daily-mode',daily);$('#modePeriod').classList.toggle('active',!daily);$('#modeDaily').classList.toggle('active',daily);dock.hidden=!daily;address.hidden=true;filters.hidden=daily;context.hidden=true;route.hidden=!daily;syncModeControls(daily);if(!daily){picker.hidden=true;}$('#modeEyebrow').textContent=daily?'DAILY OPERATIONS':'STORE NETWORK';$('#modeTitle').textContent=daily?'일자별 운행 조회':'매장·권역 조회';$('#totalBadge').textContent=$('#periodStoreListCount').textContent||'확인 중';const vehicles=bridge.state.selectedVehicles;$('#chooseRoutes').textContent=vehicles.length===1?`${vehicles[0]}호차 ▾`:vehicles.length?`${vehicles.length}개 호차 ▾`:'전체 호차 ▾';$('#navSelection').textContent=$('#chooseRoutes').textContent.replace(' ▾','');for(const card of $('#periodStoreList').querySelectorAll('button')){card.classList.add('storeitem');card.style.overflowWrap='anywhere';} }
  $('#totalBadge').onclick=()=>{$('#togglePeriodList').click();};
  // Match the source element roles; IDs and existing controller handlers stay intact.
  for(const id of ['opTotal','opCompleted','opRemaining','opEta']){const old=$('#'+id),strong=document.createElement('strong');strong.id=id;strong.className=old.className;strong.textContent=old.textContent;old.replaceWith(strong);}
  const oldBadge=sidehead.querySelector('#totalBadge'),badgeSpan=document.createElement('span');badgeSpan.id='totalBadge';badgeSpan.className='count sourceCount';badgeSpan.textContent=oldBadge.textContent;badgeSpan.onclick=oldBadge.onclick;oldBadge.replaceWith(badgeSpan);
  $('#openOperations').textContent='진단 / 상태';
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
  const routeDialog=document.createElement('dialog');routeDialog.id='routeDialog';routeDialog.innerHTML='<div class="modalhead"><div><span class="eyebrow">DAILY QUERY</span><h2>운행 조회 조건</h2></div><button id="closeRoutes" aria-label="운행 조건 닫기">✕</button></div>';
  document.body.append(routeDialog);const dailyForm=$('#dailyControls');dailyForm.replaceChildren();dailyForm.hidden=false;routeDialog.append(dailyForm);
  function formRow(...nodes){const row=document.createElement('div');row.className='row';row.append(...nodes);return row;}
  function formLabel(text){const label=document.createElement('label');label.textContent=text;return label;}
  dailyForm.append(formLabel('조회 기간'),formRow($('#rangeStart'),$('#rangeEnd')),formRow($('#applyPeriod'),$('#recent60')),formLabel('호차 · 기사 조회'));
  const basis=$('.periodBasis');basis.className='periodBasis row basis';dailyForm.append(basis,$('#periodDriver'));
  const routeChecks=$('#vehicleList');routeChecks.className='routechecks';dailyForm.append(routeChecks,formRow($('#selectAllVehicles'),$('#clearVehicles')));
  $('#selectAllVehicles').textContent='전체 호차';$('#clearVehicles').textContent='선택 해제';
  const queryRoutes=document.createElement('button');queryRoutes.id='queryRoutes';queryRoutes.className='primary full';queryRoutes.textContent='운행 조회';dailyForm.append(queryRoutes);
  const queryStatus=document.createElement('p');queryStatus.id='querySubmitStatus';queryStatus.className='hint';queryStatus.setAttribute('role','status');dailyForm.append(queryStatus);
  queryRoutes.onclick=async()=>{if(queryRoutes.disabled||bridge.state.mode!=='DATE_ROUTE')return;queryRoutes.disabled=true;queryStatus.textContent='선택 배송일의 확정호차를 조회 중입니다.';try{const result=await bridge.submitDailyQuery($('#selectedDate').value,$('#selectedDate').value);if(result.ok){queryStatus.textContent='';routeDialog.close();}else queryStatus.textContent=result.message;}catch(error){queryStatus.textContent='조회 실패 · '+error.message;}finally{queryRoutes.disabled=false;}};
  const routeHelp=document.createElement('p');routeHelp.className='hint';routeHelp.textContent='선택 배송일의 확정호차와 방문 순서를 표시합니다.';dailyForm.append(routeHelp);
  const advancedRoutes=document.createElement('details');advancedRoutes.className='sourceAdvancedRoutes';advancedRoutes.innerHTML='<summary>호차 단일 선택·검색</summary>';advancedRoutes.append($('#operationVehicle'),$('#vehicleTrigger'),$('#vehicleQuery'));dailyForm.append(advancedRoutes);
  $('#sourceRoutePicker').hidden=true;document.body.append(routeDialog);$('#closeRoutes').onclick=()=>routeDialog.close();
  $('#chooseRoutes').onclick=()=>{if(bridge.state.mode!=='DATE_ROUTE')return;syncModeControls(true);routeDialog.showModal();};
  const periodButton=document.createElement('button');periodButton.id='openPeriodQuery';periodButton.textContent='과거 기간 이력';context.append(periodButton);
  periodButton.onclick=()=>{if(bridge.state.mode!=='BASE_60D')return;dailyForm.hidden=false;syncModeControls(false,true);routeDialog.showModal();};
  for(const id of ['applyPeriod','recent60']){const button=$('#'+id),run=button.onclick;button.onclick=event=>{routeDialog.close();return run?.(event);};}
  // Keep the existing controller's deferred-page action reachable after closing
  // the query dialog. The page itself remains bounded to seven complete dates.
  const placeNext=()=>{const button=$('#nextPeriodPage');if(button&&button.parentNode!==context)context.append(button);};
  new MutationObserver(placeNext).observe(dailyForm,{childList:true,subtree:true});
  const batchDialog=document.createElement('dialog');batchDialog.id='mapBatchDialog';batchDialog.innerHTML='<div class="modalhead"><div><span class="eyebrow">AREA CHECK</span><h2>신규권역 일괄조회</h2></div><button id="closeBatch" aria-label="신규권역 조회 닫기">✕</button></div>';document.body.append(batchDialog);batchDialog.append($('#newAreaBatchTool'));
  $('#sourceBatch').onclick=()=>{if(bridge.state.mode!=='BASE_60D')return;$('#newAreaBatchTool').hidden=false;$('#newAreaBatchTool').open=true;batchDialog.showModal();};$('#closeBatch').onclick=()=>{if($('#judgeNewAreaBatch').disabled)$('#cancelNewAreaBatch').click();batchDialog.close();};batchDialog.addEventListener('cancel',()=>{if($('#judgeNewAreaBatch').disabled)$('#cancelNewAreaBatch').click();});
  batchDialog.addEventListener('close',()=>{if($('#judgeNewAreaBatch').disabled)$('#cancelNewAreaBatch').click();$('#newAreaBatchTool').open=false;});
  const dataDialog=document.createElement('dialog');dataDialog.id='mapDataInfoDialog';dataDialog.innerHTML='<div class="modalhead"><div><span class="eyebrow">DATA STATUS</span><h2>데이터 안내</h2></div><button id="closeDataInfo" aria-label="데이터 안내 닫기">✕</button></div>';document.body.append(dataDialog);
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
  function sourceCard(button,row,daily){
    if(!row)return;const vehicle=daily?row.vehicle:Object.hasOwn(row,'baseVehicle')?row.baseVehicle:row.vehicle;const key=JSON.stringify([row.customerName,row.customerCode,vehicle,row.status,daily,row.baseVehicleVersion,row.baseVehicleStale,row.baseVehicleGroup]);if(button.dataset.sourceCard===key)return;
    button.dataset.sourceCard=key;button.classList.add('storeitem');
    const original=button.textContent;button.title=original;button.replaceChildren();
    const icon=document.createElement('span');icon.className='icon';icon.textContent=daily?String(row.order||'—'):'▦';
    const text=document.createElement('span');text.className='itemtxt';const name=document.createElement('b');name.textContent=row.customerName||'매장명 미확인';const meta=document.createElement('small');
    const center=({osan:'오산센터',yeongnam:'영남센터',honam:'호남센터',other:'센터 미지정'})[!daily&&row.baseVehicleState==='VERIFIED_MASTER'&&row.baseVehicleSource==='FIXED_DISPATCH_PRIMARY'&&/^[a-f0-9]{64}$/.test(row.baseVehicleVersion||'')&&row.baseVehicleStale===false?row.baseVehicleGroup:'']||'센터 미확인';
    meta.textContent=[row.customerCode,center].join(' · ');const badge=document.createElement('span');badge.className='vehicleColorBadge';badge.dataset.vehicle=vehicle||'';badge.style.setProperty('--vehicle-color',Phase2bUi.vehicleColor(vehicle));badge.textContent=vehicle?`${vehicle}호차`:'호차 미확인';meta.append(' · ',badge);text.append(name,meta);
    const status=document.createElement('span');status.className='status'+(row.status==='COMPLETED'?' done':'');status.textContent=daily?(row.status==='COMPLETED'?'완료':row.status==='PENDING'?'미완료':'상태 미확인'):'›';button.append(icon,text,status);
  }
  let visibleStoreLimit=5;
  let vehicleLegendKey='';
  function syncVehicleLegend(){
    const keys=[...new Set(bridge.state.currentRows.map(row=>Phase2bUi.vehicleColorKey(row.vehicle)))].sort((a,b)=>a.localeCompare(b,'ko',{numeric:true}));
    const key=JSON.stringify([bridge.state.mode,keys]);if(key===vehicleLegendKey)return;vehicleLegendKey=key;legend.replaceChildren();
    const heading=document.createElement('strong');heading.textContent=bridge.state.mode==='DATE_ROUTE'?'실제 호차':'기준호차';legend.append(heading);
    for(const vehicle of keys){const item=document.createElement('span');item.dataset.vehicle=vehicle;const dot=document.createElement('i');dot.style.background=Phase2bUi.vehicleColor(vehicle);item.append(dot,vehicle?`${vehicle}호차`:'호차 미확인');legend.append(item);}
    const clusters=document.createElement('span');clusters.className='clusterLegend';clusters.textContent='회색 숫자 원: 묶음 매장 수';legend.append(clusters);bridge.setGeneralLegend(legend.innerHTML);
  }
  loadMore.onclick=()=>{if(bridge.isDataReady()&&bridge.state.currentRows.length&&!$('#periodStoreList').querySelector('[data-period-store]')){visibleStoreLimit=5;$('#togglePeriodList').click();sourceSync();return;}visibleStoreLimit+=5;if($('#periodStoreList').querySelectorAll('[data-period-store]').length<visibleStoreLimit&&!$('#periodListMore').hidden)$('#periodListMore').click();sourceSync();};
  function sourceSync(){
    syncVehicleLegend();
    $('#periodDriver').disabled=$('input[name="periodBasis"][value="vehicle"]').checked;
    for(const name of routeChecks.querySelectorAll('.vehicleNo'))if(name.textContent.endsWith('호'))name.textContent+='차';
    const daily=document.body.classList.contains('daily-mode');planner.hidden=!daily;stores.hidden=daily;$('#sourceBatch').hidden=daily;
    // Reconcile only presentation of disabled state; operational partial/error messages remain.
    if(daily){const count=new Set(bridge.state.currentRows.map(row=>row.customerCode)).size;const badge=count?`${count} 매장`:bridge.isDataReady()?'0 매장':'매장 수 미확인';if($('#totalBadge').textContent!==badge)$('#totalBadge').textContent=badge;
      if($('#runListTitle').textContent!=='방문 순서')$('#runListTitle').textContent='방문 순서';
      const navLabel=$('#chooseRoutes').textContent.replace(' ▾','').replace(' ?','')+(count?` · ${count}착`:'');if($('#navSelection').textContent!==navLabel)$('#navSelection').textContent=navLabel;
      const heading='자동차 경로';if($('#navigationPreview h2 span').textContent!==heading)$('#navigationPreview h2 span').textContent=heading;
      if($('#opEta').textContent.includes('과거')){$('#opEta').title=$('#opEta').textContent;$('#opEta').textContent='—';}
      if($('#roadRoutePanel').dataset.state==='disabled'){
        const status=$('#roadRouteStatus'),text='도로경로 API 미연결 · 센터부터 착순 경로 연결 대기';if(status.textContent!==text){status.title=status.textContent;status.textContent=text;}
        $('#roadRouteCoverage').hidden=true;
        for(const [id,unit] of [['roadRouteDistance','km'],['roadRouteDuration','분']]){const value=$('#'+id);if(value.textContent!==`— ${unit}`)value.textContent=`— ${unit}`;}
      }else $('#roadRouteCoverage').hidden=false;
    }else{const match=$('#periodStoreListCount').textContent.match(/^([\d,]+)/);if(match){const text=match[1]+' 매장';if($('#totalBadge').textContent!==text)$('#totalBadge').textContent=text;}}
    if($('#syncOperation').textContent!=='현재 상태 동기화')$('#syncOperation').textContent='현재 상태 동기화';
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

