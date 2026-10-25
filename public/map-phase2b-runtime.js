(function () {
  "use strict";

  const vehicleLabel = value => Phase2bUi.normalizeVehicleLabel(value);
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  let SOURCE = window.VEHICLE_AREA_DATA || { vehicles: [] };
  const ADMIN = new Map((window.ADMIN_FEATURES || []).map((feature) => [String(feature.properties?.code || ""), feature]));
  const state = { mode: "BASE_60D", connectionLines:false, rangeStart: "", rangeEnd: "", routeDate: "", selectedVehicles: [], driverKey: "", areaOn: false, centerFilter: "", selectedDate: "", latestDate: "", map: null, overlays: [], representativeOverlays: [], lines: [], polygons: [], selected: null, virtual: null, currentRows: [], routeRows: [], newAreaResults: [], fitRequested: true, userMovedMap: false, suppressMapEventsUntil: 0, baseRequestId: 0, routeRequestId: 0, searchRequestId: 0, addressRequestId: 0, detailRequestId: 0, todayRequestId: 0 };
  let mapInitializing=null,mapObserver=null,mapHandlers=[];
  let operationStops = [], runFilter = "ALL";
  let approvedMarkerOrder = new Map();
  const modeViews = { BASE_60D: { vehicles: [], scope: "all", areaOn: false, centerFilter: "" }, DATE_ROUTE: { vehicles: [], scope: "all", areaOn: false, centerFilter: "" } };
  let periodBasis = "vehicle", periodVehicleScope = "all", periodListLimit = 0;
  let generalAllStores = true;
  let generalMap = true;
  let selectedDriverKeys=[];
  let hybridUi;
  const hybridUiReady = (window.HybridMapUiReady || Promise.resolve(null)).then(module => {
    if(!module)return null;
    const {createHybridMapUiAdapter}=module;
    hybridUi = createHybridMapUiAdapter({onState: value => {
      if(value.external)queueMicrotask(()=>void window.MapDataSync?.onPublished?.({}).catch(()=>{}));
      if(value.state==='logged-out')purgeStaffData();
      const panel = $('#packageReadState');
      if (panel) { panel.dataset.state=value.state;panel.textContent=({cached:'저장된 정상 지도 · 최신 게시본 확인 중', 'logged-out':'로그아웃 · 브라우저 저장본 정리됨', held:'새 패키지 검증·공개 보류 — 기존 지도 사용',error:'패키지 조회 실패 · 이전 정상본 유지',loading:'패키지 확인 중',legacy:'기존 지도 데이터 사용 · 새 패키지 미연결',ready:'새 패키지 읽기 검증 완료 · 전체 매장 원천 완전성은 별도 확인',empty:'검증된 선택 범위 0건',checking:'페이지 확인 중 · 전체 집계 미완료',unconfirmed:'기간 완전성 미확인',missing:'저장자료 없음 · 원천 손실 판정 아님',preparing:'수집·자료 준비 중', 'latest-available':'새 게시본 있음 · 선택 기간 유지',cancelled:'조회 취소 · 이전 지도 상태 유지'})[value.state]||'패키지 상태 미확인'; }
    }});
    return hybridUi;
  });
  function purgeStaffData(){
    cancelManualRoadRoute();manualDraft?.clear();window.dispatchEvent(new CustomEvent('map-navigation-logout'));
    ++initialRequestId;++periodRequestId;++dateRequestId;
    for(const key of ['baseRequestId','routeRequestId','searchRequestId','addressRequestId','detailRequestId','todayRequestId'])++state[key];
    clearTimeout(initialTimer);clearTimeout(periodTimer);clearTimeout(baseVehicleTimer);
    hybridUi?.cancel();requestControllers.forEach(v=>v.controller.abort());requestControllers.clear();memoryResponses.clear();apiDiagnostics.clear();
    latestSnapshotRows=[];periodRows=[];allStores=[];operationStops=[];coordinateByCode.clear();baseVehicles.clear();baseVehicleExtraCodes.clear();baseVehicleRequest=null;periodSelectionCache=null;dateReady=false;
    storeByVehicleAndCode.clear();storesByCode.clear();driverByVehicle.clear();geocodeCache.clear();approvedMarkerOrder.clear();
    indexedRows=null;pointIndex=null;baseVehicleMeta=null;snapshotMeta=null;periodMeta=null;modelStatus=null;
    SOURCE={vehicles:[]};ADMIN.clear();state.currentRows=[];state.routeRows=[];state.newAreaResults=[];state.selectedVehicles=[];state.virtual=null;
    clearSelection();clearMap();renderPeriodStoreList([]);resetRoadRoute();clearNewAreaBatch();renderManualDraft();
    for(const selector of ['#results','#runList','#addressJudgeResults','#periodDriver','#vehicleList','#navSuggestions','#operationsPanel'])$(selector)?.replaceChildren();
    $('#freshnessState').textContent='직원 로그인 필요';$('#periodStoreListCount').textContent='';
  }
  const manualDraft = window.ManualWaypoints?.createDraft();
  let modeViewInitialized = false, markerFrame = null;
  let markerEntries = new Map(), indexedRows = null, pointIndex = null, boundaryKey = "", detailFrame = null, resizeFrame = null;
  let periodSelectionCache = null;
  let baseVehicles = new Map(), baseVehicleRequest = null, baseVehicleTimer = null, baseVehicleTries = 0;
  let recentPeriodMode = true;
  let baseVehicleStatus='LOADING';
  let baseVehicleMeta=null;
  const baseVehicleExtraCodes=new Set();
  const renderMetrics = { renders: 0, created: 0, removed: 0, reused: 0, lastMs: 0 };
  let roadResult = null, roadLayer = null;
  let manualRoadResult=null,manualRoadLayer=null;
  const manualRoadController=window.ManualRoadRouteUi?.createController({onChange:result=>{
    manualRoadResult=result;renderManualRoadState();window.dispatchEvent(new CustomEvent('map-manual-route',{detail:result}));
    if(state.map){manualRoadLayer ||= window.RoadRouteUi.createLayer({map:state.map});manualRoadLayer.render(result);}
  }});
  function renderManualRoadState(){
    if(!window.ManualRoadRouteUi)return;
    const result=manualRoadResult,metrics=window.RoadRouteUi.metrics(result);
    const count=manualDraft?.stops().length||0;
    const text=window.MapDotUi.describeRoute(result);
    $('#manualStatus').textContent=text;
    const status=$('#plannerStatus');if(status){status.hidden=!result||result.state==='idle';status.textContent=text;status.dataset.state=result?.state||'idle';}
    const button=$('#planRoute');if(button)button.disabled=result?.state==='loading';
    const advanced=$('#manualValidate');if(advanced)advanced.disabled=result?.state==='loading';
    const values=$$('.plannerMetrics b');if(values.length===2){values[0].textContent=metrics.distance==='—'?'— km':metrics.distance;values[1].textContent=metrics.duration==='—'?'— 분':metrics.duration;}
    const badge=$('#waypointPlanner .sectiontitle .muted');if(badge)badge.textContent=['success','partial'].includes(result?.state)?'자동차 경로':result?.state==='loading'?'조회 중':result?.state==='error'?'조회 실패':result?.state==='empty'?'경로 없음':result?.state==='disabled'?'연결 대기':'자동차';
  }
  function cancelManualRoadRoute(){manualRoadController?.cancel();manualRoadLayer?.clear();}
  async function queryManualRoadRoute(){
    if(manualRoadController?.isLoading())return;
    const draft=manualDraft.validate();
    if(!manualRoadController)throw Error('도로경로 API 모듈 미연결');
    ++state.routeRequestId;++state.todayRequestId;
    requestControllers.get('route-plan')?.controller.abort('superseded');
    requestControllers.get('operation-status')?.controller.abort('superseded');
    $('#syncOperation').disabled=false;
    resetRoadRoute();return manualRoadController.load(draft);
  }
  let originalRouteLegend = $('.legend')?.innerHTML || '';
  const roadController = window.RoadRouteUi?.createController({ onChange: result => {
    roadResult = result;window.dispatchEvent(new CustomEvent('map-recorded-route',{detail:result}));
    syncRoadRoutePanel();
    if (state.map) {
      roadLayer ||= RoadRouteUi.createLayer({ map: state.map });
      roadLayer.render(result);
    }
  } });
  function osanRoadVehicle(vehicle = primarySelectedVehicle()) {
    return state.mode === 'DATE_ROUTE' && selectedVehicles().length === 1 && SOURCE.vehicles.find(item => String(item.vehicle) === vehicle)?.group && ['osan','yeongnam','honam'].includes(SOURCE.vehicles.find(item=>String(item.vehicle)===vehicle)?.group);
  }
  function syncRoadRoutePanel() {
    const panel = $('#roadRoutePanel'); if (!panel || !window.RoadRouteUi) return;
    panel.hidden = !osanRoadVehicle();
    const legend = $('.legend');
    if (legend) legend.innerHTML = panel.hidden ? originalRouteLegend : `<div class="legendRow"><span class="pinSample" style="background:${vehicleColor(primarySelectedVehicle())}"></span> ${esc(vehicleLabel(primarySelectedVehicle()))} · 해당일 편성</div><div class="legendRow"><span class="line estimated" style="border-color:${vehicleColor(primarySelectedVehicle())}"></span> 도로경로 예상 · GPS 실주행 아님</div>`;
    panel.dataset.state = roadResult?.state || 'idle';
    $('#roadRouteStatus').textContent = RoadRouteUi.describe(roadResult);
    const metrics = RoadRouteUi.metrics(roadResult);
    $('#roadRouteDistance').textContent = metrics.distance; $('#roadRouteDuration').textContent = metrics.duration;
    $('#roadRouteCoverage').textContent = roadResult?.state === 'partial' ? '성공 구간 합계 · 미조회 구간 포함 안 됨' : '예상 도로거리 · 예상 주행시간';
  }
  function resetRoadRoute() { roadController?.cancel(); roadLayer?.clear(); }
  function loadRoadRoute(vehicle,{explicit=false}={}) {
    if(!explicit)return;
    cancelManualRoadRoute();
    if(hasDatedDriverFilter()){resetRoadRoute();return;}
    if (!osanRoadVehicle(vehicle)) { resetRoadRoute(); return; }
    void roadController?.load({ date: state.selectedDate, vehicle });
  }
  if (window.PerformanceObserver) {
    try { new window.PerformanceObserver(list => {
      const map = $("#map"); if (!map) return;
      const previous = JSON.parse(map.getAttribute('data-long-tasks') || '{"count":0,"totalMs":0,"maxMs":0}');
      for (const entry of list.getEntries()) { previous.count++; previous.totalMs+=Math.round(entry.duration); previous.maxMs=Math.max(previous.maxMs,Math.round(entry.duration)); }
      map.setAttribute('data-long-tasks',JSON.stringify(previous));
    }).observe({type:'longtask',buffered:false}); } catch (_) { /* Unsupported metric remains unavailable. */ }
  }
  function switchMode(next, {preservePeriod=false}={}) {
    if(state.mode!==next){cancelManualRoadRoute();clearSelection();cancelAddressLookup();++state.searchRequestId;++state.addressRequestId;state.virtual=null;$('#query').value='';$('#addressQuery').value='';$('#results').replaceChildren();$('#addressJudgeResults').replaceChildren();clearMap();}
    if(!preservePeriod){hybridUi?.cancel();if(state.mode!==next)hybridUi?.closePeriod();}
    if (state.mode !== next) cancelNewAreaWork();
    if (state.mode !== next) {resetRoadRoute();cancelManualRoadRoute();}
    if (modeViewInitialized && state.mode !== next) {
      modeViews[state.mode] = { vehicles: selectedVehicles().slice(), scope: periodVehicleScope, areaOn: state.areaOn, centerFilter: state.centerFilter, basis:periodBasis, driverKeys:selectedDriverKeys.slice(), driverKey:state.driverKey,
        center: state.map?.getCenter(), level: state.map?.getLevel() };
    }
    if (!modeViewInitialized || state.mode !== next) {
      const view = modeViews[next]; state.mode = next;
      setSelectedVehicles(view.vehicles); state.areaOn = next==='DATE_ROUTE'?false:view.areaOn; state.centerFilter = next==='DATE_ROUTE'?'':view.centerFilter;
      periodBasis=next==='DATE_ROUTE'?'vehicle':view.basis||'vehicle';selectedDriverKeys=next==='DATE_ROUTE'?[]:(view.driverKeys||[]).slice();state.driverKey=next==='DATE_ROUTE'?'':view.driverKey||'';
      periodVehicleScope = view.scope;
      if (view.center && state.map) { state.map.setLevel(view.level); state.map.setCenter(view.center); state.fitRequested = false; }
      else requestMapFit();
      modeViewInitialized = true;
      refreshVehicleUi(false); syncBoundaryButtons();
      if ($("#newAreaTools")) activateSheet(next === "BASE_60D" ? "stores" : "runs");
    }
  }
  const apiDiagnostics = new Map();
  let geocodeDiagnostic = "미조회", lastRefreshedAt = "", sheetTab = "detail";
  const panelHomes = new Map();
  let allStores = [];
  const storeByVehicleAndCode = new Map();
  const storesByCode = new Map();
  let snapshotMeta = null;
  let snapshotReadState = 'unknown';
  const driverByVehicle = new Map();
  const requestControllers = new Map();
  const memoryResponses = new Map();
  let latestSnapshotRows = [];
  const coordinateByCode = new Map();
  let dateRequestId = 0;
  let dateReady = false;
  let dateChosenByUser = false;
  const geocodeCache = new Map();

  SOURCE.vehicles.forEach((vehicle, vehicleIndex) => {
    (vehicle.customers || []).forEach((customer) => {
      const row = normalizeStore(customer, vehicle, vehicleIndex);
      allStores.push(row);
      storeByVehicleAndCode.set(`${vehicle.vehicle}|${row.customerCode}`, row);
      if (!storesByCode.has(row.customerCode)) storesByCode.set(row.customerCode, row);
    });
  });

  function replaceStoreSnapshot(rows, meta) {
    if (state.mode === 'BASE_60D') {
      const merged = new Map(latestSnapshotRows.map(row => [String(row.customerCode || row.code), { ...row, relations: [], history: [] }]));
      for (const row of rows || []) merged.set(String(row.customerCode || row.code), row);
      rows = [...merged.values()];
    }
    const vehicleMeta = new Map(SOURCE.vehicles.map((vehicle, index) => [String(vehicle.vehicle), { vehicle, index }]));
    const previousByCode = new Map([...latestSnapshotRows, ...allStores].map((row) => [String(row.customerCode || row.code), row]));
    const next = [];
    storeByVehicleAndCode.clear();
    storesByCode.clear();
    (rows || []).forEach((item) => {
      const vehicle = normalizeVehicle(item.vehicle || item.primaryVehicle90d || item.latestVehicle);
      const found = vehicleMeta.get(vehicle) || { vehicle: { vehicle }, index: 0 };
      const previous = item.currentMasterStatus==='UNAVAILABLE'?{}:previousByCode.get(String(item.customerCode || item.code || "")) || {};
      const sameAddress=!item.address||!previous.address||item.address.replace(/\s/g,'')===previous.address.replace(/\s/g,'');
      const row = normalizeStore({ ...item, id: item.customerCode || item.code, name: item.customerName || item.name,
        address: item.address || item.customerAddress || item.latestAddress || previous.address,
        delivery_pattern: item.deliveryPattern || item.deliveryPatternText || previous.deliveryPattern,
        lat: item.lat === null ? null : item.lat ?? item.latitude ?? (sameAddress?previous.lat:null), lng: item.lng === null ? null : item.lng ?? item.longitude ?? (sameAddress?previous.lng:null) }, found.vehicle, found.index);
      if(!sameAddress&&(item.lat==null||item.lng==null))row.coordinateStatus='CONFLICT';
      row.customerName ||= previous.customerName || "";
      row.areaLabel ||= previous.areaLabel || "";
      row.region ||= previous.region || "";
      row.lastDeliveryDate = item.lastDeliveryDate || item.deliveryDate || "";
      row.history = item.relations || item.history || [];
      if(item.residentSummary)row.residentSummary=item.residentSummary;
      if(item.periodAggregate?.verified===true)row.periodAggregate=item.periodAggregate;
      if(item.historyCoverage)row.historyCoverage=item.historyCoverage;
      if(item.currentMasterStatus)row.currentMasterStatus=item.currentMasterStatus;
      row.driverKey = item.driverKey || "";
      row.driverIdentity = item.driverIdentity || '';
      row.driverName = item.driverName || "";
      Object.assign(row, baseVehicles.get(String(row.customerCode)) || {baseVehicle:normalizeVehicle(item.baseVehicle||''),baseVehicleState:item.baseVehicle?'PUBLISHED_ONLY':'UNKNOWN'});
      row.deliveryCount90d = item.deliveryCount90d ?? item.deliveryCount ?? null;
      next.push(row);
      storeByVehicleAndCode.set(`${row.vehicle}|${row.customerCode}`, row);
      if (!storesByCode.has(row.customerCode)) storesByCode.set(row.customerCode, row);
    });
    allStores = next;
    snapshotMeta = meta || snapshotMeta;
  }

  let periodRows = [], periodMeta = null, periodRequestId = 0, periodTimer = null;
  let modelStatus = null, initialRequestId = 0, initialTimer = null;
  function syncDateHeading() {
    const period = state.mode === "BASE_60D";
    const start = $("#rangeStart").value, end = $("#rangeEnd").value;
    if ($("#dateHeading")) $("#dateHeading").textContent = period ? "조회기간" : "기준일";
    $("#latestDate").textContent = period ? (start && end ? `${start} ~ ${end}` : "데이터 확인 중") : (state.selectedDate || "데이터 확인 중");
    $("#rangeText").textContent = period && modelStatus?.periodLatest ? `기간 데이터 최신 ${modelStatus.periodLatest}` : "";
  }
  function syncModeUi() {
    document.body.classList.toggle('dailyWorkspace', state.mode === 'DATE_ROUTE');
    document.body.classList.toggle("periodMode", state.mode === "BASE_60D");
    $("#periodControls").hidden = generalMap;
    if ($("#dailyControls")) $("#dailyControls").hidden = state.mode !== "DATE_ROUTE";
    $("#modePeriod").setAttribute("aria-pressed", String(state.mode === "BASE_60D"));
    $("#modeDaily").setAttribute("aria-pressed", String(state.mode === "DATE_ROUTE"));
    $("#periodFilterPanel")?.toggleAttribute("hidden", state.mode !== "BASE_60D");
    $("#periodStoreListSection").hidden = false;
    document.body.classList.toggle("historicalMode", state.selectedDate !== localDate());
    syncDateHeading();
    if(generalMap){$('#dateHeading').textContent='일반지도';$('#latestDate').textContent='전체 저장 매장';}
    syncSourceFreshness();
  }
  function syncSourceFreshness() {
    const meta=snapshotMeta||{};
    $('#sourceCollectedAt').textContent=`최신 원천 수집일: ${meta.sourceObservedAt||meta.sourceCollectedAt||'미확인'}`;
    $('#mapAppliedRange').textContent=`현재 지도 반영기간: ${!generalMap?state.mode==='DATE_ROUTE'?state.selectedDate||'미확인':state.rangeStart&&state.rangeEnd?`${state.rangeStart} ~ ${state.rangeEnd}`:'미확인':meta.startDate&&meta.endDate?`${meta.startDate} ~ ${meta.endDate}`:'기간 미확인'}`;
  }
  function syncPeriodBasis() {
    const driver = periodBasis === "driver";
    $("#periodDriver").disabled = !driver; $("#periodDriver").hidden = !driver;
    $("#legacyVehicleState").hidden = driver;
    $("#periodCenter").disabled = driver;
    $$('input[name="periodBasis"]').forEach(input => { input.checked = input.value === periodBasis; });
  }
  function filteredPeriodStores() {
    if (!dateReady || state.mode !== "BASE_60D") return [];
    if (periodBasis === "vehicle" && periodVehicleScope === "selected" && !selectedVehicles().length) return [];
    const key = [generalMap,generalAllStores,periodBasis,periodVehicleScope,selectedVehicles().join(','),selectedDriverKeys.join(','),state.driverKey,state.centerFilter].join('|');
    if (periodSelectionCache?.source === allStores && periodSelectionCache.key === key) return periodSelectionCache.rows;
    const driverKeys=selectedDriverKeys.length?selectedDriverKeys:[state.driverKey];
    const candidates=periodBasis==='driver'&&driverKeys.length>1?[...new Map(driverKeys.flatMap(key=>MapPeriodUi.select(allStores,[],key,{vehicleBasis:'actual'})).map(row=>[row.customerCode,row])).values()]:MapPeriodUi.select(allStores, periodBasis === "vehicle" ? selectedVehicles() : [], periodBasis === "driver" ? state.driverKey : "", {vehicleBasis:periodBasis === "vehicle" ? "base" : "actual", includeUnvisited:generalAllStores && periodBasis === 'vehicle',useResidentSummary:generalMap&&window.MAP_ROLLING_DATE_INDEX_ENABLED===true&&periodBasis==='vehicle',periodComplete:generalMap||periodMeta?.segmented!==true||periodMeta.aggregateComplete===true});
    const rows = candidates
      .filter(row => !state.centerFilter || periodBasis === "driver" || row.baseVehicleGroup === state.centerFilter);
    periodSelectionCache = {source:allStores,key,rows}; return rows;
  }
  async function refreshStoreSnapshot() {
    const id=initialRequestId;
    try {
      const adapter=await hybridUiReady;
      const payload = await adapter?.readGeneral({masterOnly:true}) || await fetchJson("/api/map-phase2b/preview/snapshot", { channel: "map-snapshot", ttl: 0, timeout: 10000 });
      if(id!==initialRequestId)throw Object.assign(Error('QUERY_CANCELLED'),{name:'AbortError'});
      if(payload.meta?.phase==='ERROR')throw Error('SNAPSHOT_READ_FAILED');
      if(payload.pending===true||payload.meta?.complete===false){snapshotReadState='pending';return;}
      if (!Array.isArray(payload.data)) throw new Error("스냅샷 확인 실패");
      latestSnapshotRows = payload.data; coordinateByCode.clear();
      snapshotReadState = 'ready';
      latestSnapshotRows.forEach(row => coordinateByCode.set(String(row.customerCode || row.code), row));
      snapshotMeta = payload.meta || {};
      syncSourceFreshness();
      state.latestDate = snapshotMeta.latestDate || latestDateFromRows(latestSnapshotRows);
      $("#selectedDate").max = localDate();
      // Coordinates and Snapshot freshness never select the Period or Daily date.
    } catch (error) { if(isSilentRequestError(error))throw error; snapshotReadState = 'error'; }
  }
  async function initializeGeneral() {
    recentPeriodMode=true;
    const id=++initialRequestId;
    ++periodRequestId;++dateRequestId;++state.routeRequestId;++state.todayRequestId;
    clearTimeout(initialTimer);clearTimeout(periodTimer);hybridUi?.closePeriod();hybridUi?.cancel();resetRoadRoute();
    cancelNewAreaWork();clearSelection();selectedDriverKeys=[];
    generalMap=true;generalAllStores=true;periodBasis='vehicle';state.driverKey='';state.centerFilter='';periodVehicleScope='all';
    switchMode('BASE_60D');refreshVehicleUi(false);syncModeUi();syncPeriodBasis();
    $('#includeUnvisitedStores').checked=true;dateReady=false;setPeriodViewState('loading');
    try {
      const adapter=await hybridUiReady,cached=await adapter?.readCachedGeneral();
      if(id!==initialRequestId||!generalMap)return;
      if(cached){if(recentPeriodMode){state.rangeStart=cached.meta.startDate;state.rangeEnd=cached.meta.endDate;$('#rangeStart').value=state.rangeStart;$('#rangeEnd').value=state.rangeEnd;}latestSnapshotRows=cached.data;snapshotMeta=cached.meta;coordinateByCode.clear();cached.data.forEach(row=>coordinateByCode.set(row.customerCode,row));periodRows=[];replaceStoreSnapshot([],snapshotMeta);ensureDateVehicles();dateReady=true;setPeriodViewState(allStores.length?'ready':'empty');await loadBaseMap();}
      await refreshStoreSnapshot();
      if(id!==initialRequestId||!generalMap)return;
      if(snapshotReadState==='error'&&cached){dateReady=true;setPeriodViewState(allStores.length?'ready':'empty');$('#freshnessState').textContent='저장된 정상 지도 유지 · 네트워크 최신성 미확인';return;}
      if(snapshotReadState==='pending'){setPeriodViewState('not-ready');renderPeriodStoreList([]);$('#freshnessState').textContent='매장 집계 중 — 조회 0건으로 확정하지 않음';return;}
      if(snapshotReadState!=='ready')throw Error('SNAPSHOT_READ_FAILED');
      if(recentPeriodMode){const latest=await adapter?.refreshLatest().catch(()=>null),range=MapPeriodUi.recentRange(latest);if(id!==initialRequestId||!generalMap)return;if(range){state.rangeStart=range.start;state.rangeEnd=range.end;$('#rangeStart').value=range.start;$('#rangeEnd').value=range.end;}}
      periodRows=[];replaceStoreSnapshot([],snapshotMeta);ensureDateVehicles();dateReady=true;
      void loadBaseVehicles(latestSnapshotRows.map(row=>row.customerCode));
      setPeriodViewState(allStores.length?'ready':'empty');await loadBaseMap();
      if(id!==initialRequestId||!generalMap)return;
      $('#freshnessState').textContent='전체 저장 매장 반영됨 — 운영 전체 매장 완전성 미검증';syncSourceFreshness();
    }catch(error){if(id!==initialRequestId||isSilentRequestError(error))return;setPeriodViewState('error');renderPeriodStoreList([]);$('#freshnessState').textContent='일반지도 조회 실패 — 매장 수 미확인';}
  }
  async function initializePeriod() {
    generalMap=false;
    recentPeriodMode = true;
    const id = ++initialRequestId; clearTimeout(initialTimer);
    ++periodRequestId; ++dateRequestId; clearTimeout(periodTimer); dateReady = false;
    switchMode("BASE_60D"); syncModeUi();
    setPeriodViewState("loading"); renderPeriodStoreList([]);
    $("#periodIdentity").textContent = "데이터 확인 중";
    try {
      const adapter=await hybridUiReady,newStatus=await adapter?.readPeriodStatus();
      const response = window.MAP_ROLLING_DATE_INDEX_ENABLED===true?newStatus:await fetchJson("/api/map-phase2b/preview/period-status", { channel: "period-status", ttl: 0, timeout: 15000 });
      if(!response)throw Error('PERIOD_ADAPTER_UNAVAILABLE');
      if (id !== initialRequestId || state.mode !== "BASE_60D") return;
      modelStatus = response.data || response;
      if (!modelStatus.ready) {
        if (modelStatus.phase === "ERROR") throw new Error("기간 모델 확인 실패");
        setPeriodViewState("not-ready"); renderPeriodStoreList([]);
        $("#periodIdentity").textContent = $("#freshnessState").textContent = "기간 데이터를 준비 중입니다";
        initialTimer = setTimeout(() => { if (id === initialRequestId) initializePeriod(); }, 15000);
        return;
      }
      const range = MapPeriodUi.recentRange(modelStatus);
      if (!range) throw new Error("기간 모델 날짜 확인 실패");
      await refreshStoreSnapshot();
      if (id !== initialRequestId || state.mode !== "BASE_60D") return;
      await changePeriod(range.start, range.end);
    } catch (error) {
      if (id !== initialRequestId || isSilentRequestError(error)) return;
      setPeriodViewState("error"); renderPeriodStoreList([]);
      $("#periodIdentity").textContent = $("#freshnessState").textContent = "기간 조회에 실패했습니다 · 최근 90일 버튼으로 재시도";
    }
  }
  async function selectLatestRoute() {
    generalMap=false;
    ++initialRequestId; clearTimeout(initialTimer); clearTimeout(periodTimer); ++periodRequestId;
    switchMode("DATE_ROUTE"); syncModeUi();
    const id = ++dateRequestId;
    $("#freshnessState").textContent = "운행 가능일 확인 중";
    try {
      const adapter=await hybridUiReady;
      const stored=window.MAP_ROLLING_DATE_INDEX_ENABLED===true;
      const status=stored?await adapter?.readPeriodStatus():null;
      if(stored&&status?.ready!==true)throw Error('PUBLISHED_DATE_UNAVAILABLE');
      const response = stored?{meta:{complete:true,date:status.completedThrough}}:await fetchJson("/api/map-phase2b/preview/assignments?date=latest", { channel: "latest-route-date", ttl: 0, timeout: 120000 });
      if (id !== dateRequestId || state.mode !== "DATE_ROUTE") return;
      const date = response.meta?.date;
      if (response.meta?.complete !== true || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("운행일 확인 실패");
      await changeSelectedDate(date);
    } catch (error) { if (id === dateRequestId && !isSilentRequestError(error)) $("#freshnessState").textContent = "운행 가능일 조회 실패 · 이전 지도 유지"; }
  }
  async function changePeriod(start, end, retry = false, nextPage = false) {
    const rollingEnabled=window.MAP_ROLLING_DATE_INDEX_ENABLED===true&&periodBasis!=='driver';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end || end > localDate() || !rollingEnabled&&(Date.parse(end)-Date.parse(start))/86400000 > 89) {
      $("#freshnessState").textContent = rollingEnabled?"시작일과 종료일을 확인하세요.":"기존 경로는 최대 90일입니다 · 과거 색인 미연결"; return;
    }
    generalMap=false;
    ++initialRequestId; clearTimeout(initialTimer);
    ++dateRequestId; ++state.todayRequestId; ++state.routeRequestId;
    switchMode("BASE_60D", {preservePeriod:rollingEnabled&&nextPage}); state.rangeStart = start; state.rangeEnd = end;
    $("#rangeStart").value = start; $("#rangeEnd").value = end;
    syncModeUi(); clearSelection(); clearTimeout(periodTimer);
    ++state.searchRequestId; ++state.addressRequestId; $("#results").innerHTML = "";
    clearNewAreaBatch();
    operationStops = []; renderRunList(); updateOperationMetrics(null);
    const id = ++periodRequestId;
    if (!rollingEnabled && periodMeta?.complete && periodMeta.startDate === start && periodMeta.endDate === end) {
      replaceStoreSnapshot(periodRows, snapshotMeta); dateReady = true; await loadBaseMap(); return;
    }
    dateReady = false; periodListLimit = 0;
    setPeriodViewState("loading"); renderPeriodStoreList([]);
    $("#periodIdentity").textContent = "기간 이력 조회 중 · 이전 지도 유지 (선택 기간 결과 아님)";
    let retryRequested = retry;
    async function read() {
      if (id !== periodRequestId || state.mode !== "BASE_60D") return;
      try {
        const retryQuery = retryRequested ? '&retry=1' : ''; retryRequested = false;
        const adapter=rollingEnabled?await hybridUiReady:null;
        if(rollingEnabled&&!adapter)throw Error('PERIOD_ADAPTER_UNAVAILABLE');
        const payload = rollingEnabled?await adapter.readPeriodWindow(start,end,latestSnapshotRows,nextPage):await fetchJson(`/api/map-phase2b/preview/period?startDate=${start}&endDate=${end}${retryQuery}`, { channel: "period", ttl: 0, timeout: 15000 });
        if(!payload)throw Error('PERIOD_PUBLICATION_HELD');
        if (id !== periodRequestId || state.mode !== "BASE_60D") return;
        if (payload.meta?.phase === "ERROR") throw new Error("기간 원천 확인 실패");
        if (payload.meta?.complete !== true && payload.meta?.displayComplete!==true) {
          if (payload.pendingReason === "READ_MODEL_RANGE_NOT_READY") {
            setPeriodViewState("out-of-range"); renderPeriodStoreList([]);
            $("#periodIdentity").textContent = $("#freshnessState").textContent = "조회 가능한 기간 범위 밖입니다";
            return;
          }
          setPeriodViewState("not-ready"); renderPeriodStoreList([]);
          $("#freshnessState").textContent = "기간 데이터를 준비 중입니다";
          $("#periodIdentity").textContent = $("#freshnessState").textContent;
          periodTimer = setTimeout(read, 5000); return;
        }
        if (payload.meta.startDate !== start || payload.meta.endDate !== end || !Array.isArray(payload.data)) throw new Error("기간 계약 불일치");
        periodRows = payload.data; periodMeta = payload.meta;
        let nextButton=$('#nextPeriodPage');
        if(!nextButton){nextButton=document.createElement('button');nextButton.id='nextPeriodPage';nextButton.textContent='다음 기간 페이지';$('#applyPeriod').after(nextButton);}
        nextButton.hidden=payload.meta.more!==true;nextButton.onclick=()=>{nextButton.disabled=true;void changePeriod(start,end,false,true).finally(()=>{nextButton.disabled=false;});};
        replaceStoreSnapshot(periodRows, snapshotMeta); ensureDateVehicles(); dateReady = true;
        void loadBaseVehicles();
        const drivers = new Map();
        periodRows.forEach(row => (row.relations || row.history || []).forEach(item => { if (item.driverKey) drivers.set(item.driverKey, (item.driverName || "미등록") + (item.driverIdentity === "UNVERIFIED" ? " · 동일인 확인 필요" : "")); }));
        $("#periodDriver").replaceChildren(new Option("전체 기사", ""));
        [...drivers].sort((a,b) => a[1].localeCompare(b[1], "ko")).forEach(([key,name]) => $("#periodDriver").add(new Option(name,key)));
        const retainedDrivers=selectedDriverKeys.length?selectedDriverKeys:state.driverKey?[state.driverKey]:[];
        for(const key of retainedDrivers)if(!drivers.has(key))$('#periodDriver').add(new Option(key+' · 기간 내 기사 근거 미확인',key));
        [...$('#periodDriver').options].forEach(option=>option.selected=retainedDrivers.length?retainedDrivers.includes(option.value):option.value==='');
        await loadBaseMap();
        if(payload.meta.segmented)$('#periodIdentity').textContent=`선택 ${start} ~ ${end} · 이력 표시 ${payload.meta.displayStartDate} ~ ${payload.meta.displayEndDate} · ${payload.meta.aggregateComplete?'선택 기간 집계 완료 · 상세 이력은 페이지별':'페이지 집계만 완료 · 전체 기간 집계 미완료'}${payload.meta.currentMasterMissingCount?' · 현재 매장정보 미확인 '+payload.meta.currentMasterMissingCount+'건 (좌표 임의 생성 없음)':''}`;
      } catch (error) {
        if (id === periodRequestId && !isSilentRequestError(error)) {
          setPeriodViewState("error");
          $("#freshnessState").textContent = "기간 조회 실패 · 신규권역 판단 보류";
          $("#periodIdentity").textContent = "기간 원천 조회 실패 · 매장 수 미확인";
          $("#periodIdentity").textContent += " · 이전 지도 유지";
          $("#periodStoreListCount").textContent = "미확인";
          $("#periodStoreList").innerHTML = '<p class="notice show">기간 데이터를 불러오지 못했습니다. 조회 실패를 매장 0개로 판단하지 마세요.</p>';
          const retryButton=document.createElement('button');retryButton.textContent='재시도';retryButton.onclick=()=>void changePeriod(start,end);$("#periodStoreList").append(retryButton);
        }
      }
    }
    await read();
  }

  async function loadBaseVehicles(extraCodes=[]){
    extraCodes=extraCodes.filter(code=>/^[A-Z]\d+$/.test(code));
    extraCodes.forEach(code=>{if(/^[A-Z]\d+$/.test(code))baseVehicleExtraCodes.add(code);});
    if(!baseVehicleExtraCodes.size&&!periodRows.some(r=>/^[A-Z]\d+$/.test(r.customerCode))&&!/^[A-Z]\d+$/.test(state.selected?.customerCode))return;
    if(baseVehicleRequest){await baseVehicleRequest;if(baseVehicleStatus==='READY'&&[...periodRows.map(r=>r.customerCode),...extraCodes].some(code=>/^[A-Z]\d+$/.test(code)&&!baseVehicles.has(code)))return loadBaseVehicles(extraCodes);return;}
    baseVehicleRequest=(async()=>{
      const baseStarted=performance.now();
      try{
        const customerCodes=[...new Set([...periodRows.map(r=>r.customerCode),...baseVehicleExtraCodes,state.selected?.customerCode].filter(code=>/^[A-Z]\d+$/.test(code)))];
        const stageReadOnly=location.origin==='https://freshon-admin-stage-preview-template.onrender.com';
        const batchSize=stageReadOnly?500:10000;
        const batches=[];for(let i=0;i<customerCodes.length;i+=batchSize)batches.push(customerCodes.slice(i,i+batchSize));
        let payload,rows=[],version;
        for(const batch of batches){
          payload=stageReadOnly
            ?await fetchJson('/api/map-phase2b/preview/base-vehicles?customerCodes='+encodeURIComponent(batch.join(',')),{channel:'base-vehicles',ttl:0,timeout:30000})
            :await fetchJson('/api/map-phase2b/preview/base-vehicles',{channel:'base-vehicles',ttl:0,timeout:30000,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customerCodes:batch})});
          if(!Array.isArray(payload.data))break;
          if(version&&version!==payload.meta?.version)throw new Error('BASE_VERSION_CHANGED');
          version=payload.meta?.version;rows.push(...payload.data);
        }
        const previousMeta=baseVehicleMeta;
        if(!MapPeriodUi.acceptsBaseVersion(previousMeta,payload.meta)){
          clearTimeout(baseVehicleTimer);baseVehicleTimer=setTimeout(()=>void loadBaseVehicles(),60000);return;
        }
        baseVehicleMeta=payload.meta||null;
        clearTimeout(baseVehicleTimer);
        // Last verified rows remain usable throughout a long background refresh.
        // This is status checking, not extending a blocking UI timeout.
        if(payload.meta?.refresh||payload.phase==='LOADING')baseVehicleTimer=setTimeout(()=>void loadBaseVehicles(),payload.meta?.refresh==='RUNNING'||payload.phase==='LOADING'?60000:300000);
        if(!Array.isArray(payload.data)){
          baseVehicleStatus=baseVehicles.size?'READY':payload.phase==='ERROR'?'ERROR':'LOADING';
          return;
        }
        const previous=baseVehicles;
        if(baseVehicleMeta?.version&&[...baseVehicles.values()].some(r=>r.baseVehicleVersion&&r.baseVehicleVersion!==baseVehicleMeta.version))baseVehicles=new Map();
        baseVehicles=MapPeriodUi.mergeBaseVehicles(baseVehicles,rows);baseVehicleStatus='READY';
        const changed=JSON.stringify(previousMeta)!==JSON.stringify(baseVehicleMeta)||rows.some(r=>JSON.stringify(previous.get(r.customerCode))!==JSON.stringify(r));
        if(!changed)return;
        if(state.mode==='BASE_60D'&&dateReady){
          replaceStoreSnapshot(periodRows,snapshotMeta);ensureDateVehicles();periodSelectionCache=null;
          if(state.selected){const selected=baseVehicles.get(state.selected.customerCode);if(selected){Object.assign(state.selected,selected);if(periodBasis==='vehicle')state.selected.vehicle=selected.baseVehicle;const label=$('#detailBaseVehicle');if(label)label.textContent=MapPeriodUi.baseVehicleLabel(selected);}}
          state.fitRequested=false;await loadBaseMap();
          if(state.selected&&periodBasis==='vehicle'&&!filteredPeriodStores().some(row=>row.customerCode===state.selected.customerCode)){
            $('#mapStatusSub').textContent+=' · 선택 고객의 기준호차/센터가 갱신되어 현재 필터에서 제외됐습니다. 선택 정보는 유지합니다.';
          }
          $('#map').setAttribute('data-base-vehicle-metrics',JSON.stringify({apiMs:apiDiagnostics.get('base-vehicles')?.ms??null,appliedMs:Math.round(performance.now()-baseStarted),rows:rows.length,stale:!!baseVehicleMeta?.stale,refresh:baseVehicleMeta?.refresh||null}));
        }
      }catch(error){
        if(isSilentRequestError(error))return;
        baseVehicleStatus=baseVehicles.size?'READY':'ERROR';baseVehicleMeta={...baseVehicleMeta,stale:true,refresh:'ERROR'};
        baseVehicles=new Map([...baseVehicles].map(([code,row])=>[code,{...row,baseVehicleStale:true}]));
        if(state.mode==='BASE_60D'&&dateReady){
          replaceStoreSnapshot(periodRows,snapshotMeta);periodSelectionCache=null;
          if(state.selected){state.selected.baseVehicleStale=true;const label=$('#detailBaseVehicle');if(label)label.textContent=MapPeriodUi.baseVehicleLabel(state.selected);}
          state.fitRequested=false;await loadBaseMap();
        }
        clearTimeout(baseVehicleTimer);baseVehicleTimer=setTimeout(()=>void loadBaseVehicles(),300000);
      }
      finally{baseVehicleRequest=null;}
    })();return baseVehicleRequest;
  }

  async function changeSelectedDate(date,queryConditions=null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > localDate()) return;
    generalMap=false;resetRoadRoute();cancelManualRoadRoute();
    ++initialRequestId; clearTimeout(initialTimer);
    clearTimeout(periodTimer); ++periodRequestId;
    switchMode("DATE_ROUTE"); state.routeDate = date; syncModeUi();
    if(queryConditions){setSelectedVehicles(queryConditions.vehicles);state.centerFilter=queryConditions.centerFilter;periodVehicleScope=queryConditions.scope;refreshVehicleUi(false);}
    const sameDate = date === state.selectedDate;
    state.selectedDate = date;
    syncModeUi(); $("#runListTool").open = true;
    updateDateRange(date);
    $("#freshnessState").title = "";
    cancelManualRoadRoute();
    dateReady = false;
    const token = ++dateRequestId;
    ++state.searchRequestId;
    ++state.detailRequestId;
    ++state.todayRequestId;
    ++state.routeRequestId;
    state.routeRows = [];
    operationStops = []; renderRunList();
    state.mode = "DATE_ROUTE";
    clearSelection();
    $("#mapStatusSub").textContent = "새 기준일 조회 중 · 이전 지도 유지";
    if (!sameDate) {
      clearNewAreaBatch();
      $("#addressJudgeResults").innerHTML = "";
      $("#results").innerHTML = "";
    }
    ["#selectedDate", "#date", "#mobileDate"].forEach((id) => { $(id).value = date; $(id).max = localDate(); });
    $("#syncOperation").textContent = date === localDate() ? "↻ 현재상태 동기화" : "↻ 데이터 새로고침";
    $("#freshnessState").textContent = `${date} 편성 조회 중`;
    updateOperationMetrics(null);
    try {
      const adapter=typeof hybridUiReady==='undefined'?null:await hybridUiReady;
      if(token!==dateRequestId)return;
      const response = await adapter?.readDate(date) || await fetchJson(`/api/map-phase2b/preview/assignments?date=${date}`, { channel: "selected-date", ttl: 60000, timeout: 120000 });
      if (response.meta?.complete !== true || response.meta.date !== date) throw new Error("날짜별 편성 검증 실패");
      let rows = response.data || [];
      if (date === localDate() && response.meta.reviewOnly!==true && window.MAP_ROLLING_DATE_INDEX_ENABLED!==true) {
        try {
          const live = await fetchJson(`/api/map-phase2b/preview/today-status?date=${date}`, { channel: "selected-date-live", ttl: 30000, timeout: 45000 });
          const byCode = new Map(rows.map((row) => [String(row.customerCode || row.code), row]));
          (live.data?.vehicles || []).forEach((vehicle) => (vehicle.stops || []).forEach((stop) => {
            const code = String(stop.customerCode || stop.code || "");
            if (code) byCode.set(code, { ...byCode.get(code), ...stop, vehicle: vehicle.vehicle, lastDeliveryDate: date });
          }));
          rows = [...byCode.values()];
        } catch (error) {
          if (isSilentRequestError(error) || token !== dateRequestId) return;
          // Dated assignments remain usable when the optional live status fails.
        }
      }
      if (token !== dateRequestId) return;
      replaceStoreSnapshot(rows, snapshotMeta);
      ensureDateVehicles();
      dateReady = true;
      await loadBaseMap();
      // Historical driver identity comes from assignment history, not today's master.
      await loadOperationStatus(primarySelectedVehicle(), selectedVehicles().length === 1);
    } catch (error) {
      if (token !== dateRequestId || isSilentRequestError(error)) return;
      $("#freshnessState").textContent = `기준일 조회 실패 · ${error.message}`;
    }
  }

  function ensureDateVehicles() {
    const known = new Set(vehicleChecks().map((input) => input.value));
    [...new Set(allStores.flatMap((row) => [row.baseVehicle, row.vehicle, ...(row.history || []).map(item => item.vehicle)]).filter(Boolean))].forEach((vehicle) => {
      if (known.has(vehicle)) return;
      const label = document.createElement("label");
      label.className = "vehicleItem";
      label.dataset.group=allStores.find(row=>row.baseVehicle===vehicle&&row.baseVehicleGroup)?.baseVehicleGroup||'';
      label.innerHTML = `<input type="checkbox" value="${esc(vehicle)}"><span class="vehicleNo">${esc(vehicleLabel(vehicle))}</span><span class="vehicleArea">기준일 편성</span>`;
      label.querySelector("input").onchange = () => { periodVehicleScope = "selected"; refreshVehicleUi(true); };
      $("#vehicleList").append(label);
      ["#vehicle", "#mobileVehicle", "#operationVehicle", "#mobileBaseVehicle"].forEach((id) => $(id).add(new Option(`${vehicleLabel(vehicle)}`, vehicle)));
    });
    $$('.vehicleItem').forEach(label=>{const group=allStores.find(row=>row.baseVehicle===label.querySelector('input')?.value&&row.baseVehicleGroup)?.baseVehicleGroup;if(group)label.dataset.group=group;});
  }

  function normalizeStore(customer, vehicle, vehicleIndex) {
    return {
      customerCode: String(customer.id || customer.code || customer.customerCode || "").trim(),
      customerName: customer.name || customer.customerName || "",
      address: customer.address || "",
      vehicle: String(vehicle.vehicle || "").replace(/호(?:차)?$/, ""),
      vehicleGroup: vehicle.group || "",
      areaLabel: vehicle.area_label || "",
      lat: numberOrNull(customer.lat),
      lng: numberOrNull(customer.lng),
      deliveryPattern: customer.delivery_pattern || "",
      region: customer.region || "",
      ton: customer.ton || vehicle.primary_ton || "",
      dailyAmount: customer.avg_order_amount ?? null,
      color: vehicleColor(vehicle.vehicle),
      adminCode: String(customer.admin_code || ""),
      raw: customer,
      vehicleRaw: vehicle,
      status: customer.status === "COMPLETED" || customer.appRecorded === true ? "COMPLETED" : customer.status === "PENDING" || customer.appRecorded === false ? "PENDING" : "",
      actualCompletedAt: customer.actualCompletedAt || customer.deliveryCompletedAt || null,
      order: Number(customer.order || customer.sequence || customer.stopOrder) || null
    };
  }

  function numberOrNull(value) {
    if (value == null || String(value).trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function vehicleColor(vehicle) {
    return Phase2bUi.vehicleColor(vehicle);
  }

  function selectedVehicles() {
    state.selectedVehicles = vehicleChecks().filter((item) => item.checked).map((item) => item.value);
    return state.selectedVehicles;
  }

  function setSelectedVehicles(values) {
    resetRoadRoute();
    const wanted = new Set((values || []).map(String));
    vehicleChecks().forEach((item) => { item.checked = wanted.has(item.value); });
  }

  function primarySelectedVehicle() {
    return normalizeVehicle($("#operationVehicle")?.value || selectedVehicles()[0] || "");
  }

  function requestMapFit() {
    state.fitRequested = true;
    state.userMovedMap = false;
  }

  function vehicleChecks() {
    return $$("#vehicleList input[type=checkbox]");
  }

  function initVehicles() {
    const vehicles = SOURCE.vehicles.map((item) => String(item.vehicle)).sort(naturalCompare);
    $("#vehicleList").innerHTML = SOURCE.vehicles.slice().sort((a, b) => naturalCompare(a.vehicle, b.vehicle)).map((vehicle) => `
      <label class="vehicleItem" data-group="${esc(vehicle.group || "")}">
        <input type="checkbox" value="${esc(vehicle.vehicle)}">
        <span class="vehicleNo">${esc(vehicleLabel(vehicle.vehicle))}</span>
        <span class="vehicleArea">${esc(vehicle.area_label || vehicle.primary_area || vehicle.group || "권역")}</span>
      </label>`).join("");
    vehicleChecks().forEach((input) => { input.onchange = () => { state.centerFilter = ""; periodVehicleScope = "selected"; refreshVehicleUi(true); }; });
    [$("#vehicle"), $("#mobileVehicle"), $("#operationVehicle")].forEach((select) => {
      select.innerHTML = '<option value="">전체 호차</option>' + vehicles.map((vehicle) => `<option value="${esc(vehicle)}">${esc(vehicleLabel(vehicle))}</option>`).join("");
      select.value = "";
    });
    $("#mobileBaseVehicle").innerHTML = `<option value="">전체 호차</option>${vehicles.map((vehicle) => `<option value="${esc(vehicle)}">${esc(vehicleLabel(vehicle))}</option>`).join("")}`;
    $("#operationVehicle").value = "";
    refreshDriverMaster();
  }

  async function refreshDriverMaster() {
    try {
      if (!state.selectedDate) return;
      const payload = await fetchJson(`/api/vehicle-driver-master?date=${encodeURIComponent(state.selectedDate)}`, { channel: "driver-master", ttl: 300000, timeout: 15000 });
      const rows = payload.vehicles || payload.results || [];
      const drivers = new Map(rows.map((row) => [normalizeVehicle(row.vehicle || row.vehicleNumber), row.driverName || row.name || ""]));
      rows.forEach((row) => driverByVehicle.set(normalizeVehicle(row.vehicle || row.vehicleNumber), row));
      [$("#vehicle"), $("#mobileVehicle"), $("#operationVehicle")].forEach((select) => [...select.options].forEach((option) => {
        const driver = drivers.get(option.value);
        if (driver) option.textContent = `${option.value}호 · ${driver}`;
      }));
    } catch (_) { /* vehicle-data remains the verified operational source */ }
  }

  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), "ko", { numeric: true });
  }

  function initMap() {
    if(state.map){state.map.relayout();return Promise.resolve(state.map);}
    if(mapInitializing)return mapInitializing;
    $('#map').dataset.sdkState='loading';
    mapInitializing=window.KakaoMapsAdapter.ready().then(()=>{
      $('#map').replaceChildren();state.map=new kakao.maps.Map($('#map'),{center:new kakao.maps.LatLng(36.7,127.7),level:13});
      $('#map').dataset.sdkState='ready';
      if(kakao.maps.services){window.kakaoGeocoder=new kakao.maps.services.Geocoder();window.kakaoPlaces=new kakao.maps.services.Places();}
      const listen=(name,fn)=>{kakao.maps.event.addListener(state.map,name,fn);mapHandlers.push([name,fn]);};
      listen('dragstart',()=>{if(Date.now()>=state.suppressMapEventsUntil)state.userMovedMap=true;});
      listen('zoom_start',()=>{if(Date.now()>=state.suppressMapEventsUntil)state.userMovedMap=true;});
      listen('zoom_changed',()=>$('#map').classList.toggle('mapZoomFar',state.map.getLevel()>=9));
      listen('center_changed',scheduleDetailPosition);listen('zoom_changed',scheduleDetailPosition);
      listen('idle',()=>{if(dateReady&&!markerFrame)markerFrame=requestAnimationFrame(()=>{markerFrame=null;renderStops(state.currentRows,{viewportOnly:true,numbered:state.mode==='DATE_ROUTE'});});});
      listen('click',clearSelection);
      if(window.ResizeObserver){mapObserver=new ResizeObserver(()=>{if(resizeFrame)return;resizeFrame=requestAnimationFrame(()=>{resizeFrame=null;state.map?.relayout();scheduleDetailPosition();});});mapObserver.observe($('#map'));}
      loadBaseMap();window.dispatchEvent(new CustomEvent('map-sdk-ready'));return state.map;
    }).catch(()=>{state.map=null;$('#map').dataset.sdkState='error';setMapMessage('카카오 지도 연결을 확인해 주세요. 매장 검색·목록은 계속 사용할 수 있습니다.');const retry=document.createElement('button');retry.id='retryMapSdk';retry.textContent='지도 다시 연결';retry.onclick=()=>{window.KakaoMapsAdapter.reset();void initMap();};$('#map').append(retry);loadBaseMap();return null;}).finally(()=>{mapInitializing=null;});
    return mapInitializing;
  }

  function setMapMessage(message) {
    $("#map").innerHTML = `<div style="display:grid;place-items:center;height:100%;color:#667085;background:#f8fafc">${esc(message)}</div>`;
  }

  function clearMap() {
    [...state.overlays, ...state.representativeOverlays, ...state.lines, ...state.polygons].forEach((item) => item.setMap?.(null));
    state.overlays = [];
    state.representativeOverlays = [];
    state.lines = [];
    state.polygons = [];
    markerEntries.clear(); indexedRows = null; pointIndex = null; boundaryKey = "";
  }

  function clearBoundaries() {
    state.polygons.forEach((item) => item.setMap?.(null));
    state.polygons = [];
    boundaryKey = "";
    $("#areaToggle").setAttribute("data-geometry-count", "0");
  }

  function clearSelection() {
    cancelAddressLookup();
    const temporarySelection = Boolean(state.selected?.outsideReason);
    window.MapStaff?.clear();
    if($("#detail").contains($("#staffAuxContent")))$("#detailSection").append($("#staffAuxContent"));
    ++state.detailRequestId;
    requestControllers.get("store-detail")?.controller.abort("superseded");
    $$(".marker.selected").forEach((item) => item.classList.remove("selected"));
    state.selected = null;window.dispatchEvent(new CustomEvent("map-store-selected",{detail:{customerCode:null}}));
    $$("[data-search-code]").forEach(button => { button.classList.remove("selected"); button.setAttribute("aria-pressed", "false"); });
    $$("[data-period-store]").forEach(button => { button.classList.remove("selected"); button.setAttribute("aria-pressed", "false"); });
    renderRunList();
    $("#detailSection").classList.remove("open");
    $("#detail").className = "idle";
    $("#detail").textContent = "검색하거나 핀을 선택하면 점포정보가 표시됩니다.";
    if (state.mode === "BASE_60D") renderPeriodStoreList();
    if (temporarySelection && state.mode === "BASE_60D") { state.fitRequested = false; renderStops(state.currentRows); }
  }

  function markerElement(row, index, kind) {
    const button = document.createElement("button");
    const completed = state.mode === "DATE_ROUTE" && row.status === "COMPLETED";
    const pending = state.mode === "DATE_ROUTE" && row.status && !completed;
    const compact = kind === "store" && !index;
    button.className = `marker${completed ? " done" : pending ? " pending" : ""}${kind === "virtual" ? " virtual" : ""}${kind === "nearbyVehicle" ? " nearbyVehicle" : ""}${compact ? " storeDot" : ""}`;
    button.dataset.customerCode = row.customerCode || "";
    button.dataset.vehicle = row.vehicle || "";
    button.title = `${row.vehicle ? vehicleLabel(row.vehicle) + " · " : ""}${row.customerName || row.address || ""}`;
    button.setAttribute("aria-label", state.mode === "BASE_60D" ? button.title : `${button.title} · ${completed ? "완료" : pending ? "미완료" : "상태 미확인"}`);
    if (row.customerCode && row.customerCode === state.selected?.customerCode) button.classList.add("selected");
    button.style.setProperty("--pin-color", vehicleColor(row.clusterCount ? '' : row.vehicle));
    const label = kind === "virtual" ? "신규" : index || (["representative", "nearbyVehicle"].includes(kind) ? row.vehicle : "");
    if (kind === "store" && state.mode === "BASE_60D") button.classList.add("store");
    button.innerHTML = `<svg class="pinShape" viewBox="0 0 28 34" aria-hidden="true"><path d="M14 1C6.8 1 1 6.8 1 14C1 23 14 34 14 34S27 23 27 14C27 6.8 21.2 1 14 1Z"/></svg><span class="pinNumber">${esc(kind === "store" && state.mode === "BASE_60D" ? row.vehicle || '?' : label)}</span><span class="markerLabel">${esc(button.title)}</span>`;
    button.onclick = () => row.virtual ? showNearbyReference(row) : row.representative || row.nearbyVehicle ? selectVehicleStatus(row, button) : selectStore(row, button, false);
    if (row.clusterCount) {
      button.classList.add("periodCluster");
      button.querySelector(".pinNumber").textContent = String(row.clusterCount);
      button.setAttribute("aria-label", row.clusterCount + "개 매장 · 확대");
      button.onclick = () => { state.map.setLevel(Math.max(5, state.map.getLevel() - 2)); state.map.panTo(new kakao.maps.LatLng(row.lat, row.lng)); };
    }
    if(document.body.classList.contains('approvedShellCandidate')){
      const pin=document.createElement('div');pin.className=row.clusterCount?'clusterpin':'pin';
      pin.style.setProperty('--pin',vehicleColor(row.clusterCount ? '' : row.vehicle));
      const number=document.createElement(row.clusterCount?'b':'span');number.textContent=String(row.clusterCount||row.vehicle||'?');pin.append(number);
      if(!row.clusterCount&&index)pin.title=`${vehicleLabel(row.vehicle)||'호차 미확인'} · 착순 ${index}`;
      if(row.clusterCount){const small=document.createElement('small');small.textContent='매장';pin.append(small);}
      button.classList.add('approvedMarker');button.replaceChildren(pin);
    }
    return button;
  }

  function representativeRows(rows) {
    const grouped = new Map();
    rows.forEach((row) => {
      if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng) || !row.vehicle) return;
      if (!grouped.has(row.vehicle)) grouped.set(row.vehicle, []);
      grouped.get(row.vehicle).push(row);
    });
    return [...grouped].map(([vehicle, stores]) => ({
      vehicle,
      customerName: `${vehicleLabel(vehicle)}`,
      address: stores[0]?.areaLabel || stores[0]?.vehicleGroup || "",
      lat: stores.reduce((sum, row) => sum + row.lat, 0) / stores.length,
      lng: stores.reduce((sum, row) => sum + row.lng, 0) / stores.length,
      storeCount: stores.length,
      vehicleGroup: stores[0]?.vehicleGroup || "",
      representative: true
    }));
  }

  function renderStops(rows, options = {}) {
    const started = performance.now();
    const dataChanged = indexedRows !== rows;
    state.currentRows = rows;
    if(dataChanged&&document.body.classList.contains('approvedShellCandidate'))approvedMarkerOrder=new Map(rows.map((row,index)=>[row.customerCode,index+1]));
    if (!state.map) return;
    if (dataChanged || !pointIndex) { indexedRows = rows; pointIndex = MapPeriodUi.spatialIndex(rows); }
    if (!options.viewportOnly) { state.lines.forEach(line => line.setMap(null)); state.lines = []; }
    const mapBounds = state.map.getBounds?.();
    const sw = mapBounds?.getSouthWest(), ne = mapBounds?.getNorthEast();
    const marginLat = sw && (ne.getLat()-sw.getLat())*.15, marginLng = sw && (ne.getLng()-sw.getLng())*.15;
    const valid = (state.mode === "BASE_60D" && !state.fitRequested && sw ? pointIndex.query({south:sw.getLat()-marginLat,north:ne.getLat()+marginLat,west:sw.getLng()-marginLng,east:ne.getLng()+marginLng}) : pointIndex.valid).slice();
    // A searched store outside the filters is a temporary selection pin, not a
    // new period membership. Keep state.currentRows and list counts unchanged.
    if (state.mode === "BASE_60D" && state.selected && Number.isFinite(state.selected.lat) && Number.isFinite(state.selected.lng)
      && !valid.some(row => row.customerCode === state.selected.customerCode)) valid.push(state.selected);
    const bounds = new kakao.maps.LatLngBounds();
    const pins = state.mode === "BASE_60D" && !options.numbered ? MapPeriodUi.cluster(valid, row => state.map.getProjection().containerPointFromCoords(new kakao.maps.LatLng(row.lat,row.lng)), state.map.getLevel(), state.selected?.customerCode, { width: $("#map").clientWidth, height: $("#map").clientHeight }) : valid;
    if (state.fitRequested) pointIndex.valid.forEach(row => bounds.extend(new kakao.maps.LatLng(row.lat,row.lng)));
    const entries = pins.map((row,index) => ({row,index,key:[row.virtual?'virtual':row.clusterCount?'cluster':'store',row.customerCode || row.vehicle || '',row.lat,row.lng].join('|'),
      fingerprint:JSON.stringify([row.vehicle,row.customerName,row.address,row.status,row.order,row.clusterCount,row.lastDeliveryDate,row.visitCount,row.driverKey,Boolean(options.numbered),Boolean(row.virtual),Boolean(row.representative),Boolean(row.nearbyVehicle),state.mode,state.rangeStart,state.rangeEnd])}));
    const reconciled = MapPeriodUi.reconcile(markerEntries, entries, ({row,index}) => {
      const position = new kakao.maps.LatLng(Number(row.lat), Number(row.lng));
      bounds.extend(position);
      const overlay = new kakao.maps.CustomOverlay({
        position,
        content: markerElement(row, options.numbered ? Number(row.order) || '—' : null, row.virtual ? "virtual" : row.nearbyVehicle ? "nearbyVehicle" : row.representative ? "representative" : "store"),
        xAnchor: .5,
        yAnchor: 1,
        zIndex: row.virtual ? 7 : 3
      });
      overlay.setMap(state.map);
      return overlay;
    }, overlay => overlay.setMap(null));
    markerEntries = reconciled.next;
    state.overlays = [...markerEntries.values()].map(entry=>entry.value);
    const nextBoundaryKey = [state.mode,state.rangeStart,state.rangeEnd,state.selectedDate,state.centerFilter,periodBasis,periodVehicleScope,state.driverKey,selectedVehicles().join(',')].join('|');
    if (!options.viewportOnly && (dataChanged || boundaryKey !== nextBoundaryKey)) {
      clearBoundaries(); state.representativeOverlays.forEach(overlay=>overlay.setMap(null)); state.representativeOverlays=[];
    }
    if (state.areaOn && boundaryKey !== nextBoundaryKey) { if (!state.polygons.length) drawSelectedBoundaries([]); boundaryKey=nextBoundaryKey; }
    if (state.areaOn && !state.representativeOverlays.length) addComparisonPins();
    if (!state.areaOn) state.representativeOverlays.forEach((overlay) => overlay.setMap(null));
    const mobileRoute = innerWidth <= 760 && options.numbered;
    if (pointIndex.valid.length && state.fitRequested && !state.userMovedMap) {
      state.suppressMapEventsUntil = Date.now() + 700;
      state.map.relayout?.();
      state.map.setBounds(bounds, mobileRoute ? 130 : 55, 40, mobileRoute ? 260 : 55, 40);
      state.fitRequested = false;
    }
    window.MapTerritoryUi?.renderForSelection();
    renderMetrics.renders++; renderMetrics.created+=reconciled.created; renderMetrics.removed+=reconciled.removed; renderMetrics.reused+=reconciled.reused;
    renderMetrics.lastMs=+(performance.now()-started).toFixed(2);
    $("#map").setAttribute('data-render-metrics',JSON.stringify({...renderMetrics,sourceRows:rows.length,active:markerEntries.size,polygons:state.polygons.length}));
  }

  function drawSelectedBoundaries(selected) {
    if (!state.map) return;
    selected = selected.length ? selected : selectedVehicles();
    if (state.mode === "BASE_60D" && periodBasis === "vehicle" && periodVehicleScope === "selected" && !selected.length) return;
    if (state.mode === "BASE_60D" && periodBasis === "driver" && state.driverKey) {
      selected = [...new Set(filteredPeriodStores().map(row => row.vehicle))];
      if (!selected.length) return;
    }
    const seen = new Set();
    SOURCE.vehicles.filter(vehicle => (!selected.length || selected.includes(String(vehicle.vehicle))) && (!state.centerFilter || vehicle.group === state.centerFilter)).forEach(vehicle => {
      const codes = vehicle.overview_admin_codes || vehicle.detail_admin_codes || [];
      codes.forEach(code => {
        const feature = ADMIN.get(String(code));
        if (!feature?.geometry || seen.has(String(code))) return;
        seen.add(String(code));
        const geometries = feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates.map(coordinates => ({ type: "Polygon", coordinates })) : [feature.geometry];
        geometries.forEach(geometry => {
          const path = geometryPaths(geometry); if (!path.length) return;
          const color = vehicleColor(vehicle.vehicle);
          const polygon = new kakao.maps.Polygon({ path, strokeWeight: 2, strokeColor: color, strokeOpacity: .76, fillColor: color, fillOpacity: .035 });
          polygon.setMap(state.map); state.polygons.push(polygon);
        });
      });
    });
    // Keep the verified delivery hull only for vehicles without administrative geometry.
    const groups = new Map();
    const boundaryStores = state.mode === "BASE_60D" ? filteredPeriodStores() : state.routeRows;
    boundaryStores.forEach((row) => {
      if (!row.vehicle || (selected.length && !selected.includes(row.vehicle))) return;
      if (!groups.has(row.vehicle)) groups.set(row.vehicle, []);
      groups.get(row.vehicle).push(row);
    });
    groups.forEach((stores, vehicle) => {
      if ((SOURCE.vehicles.find(item => String(item.vehicle) === String(vehicle))?.overview_admin_codes || []).some(code => ADMIN.has(String(code)))) return;
      const hull = Phase2bUi.deliveryBoundary(stores);
      if (hull.length < 3) return;
      const path = hull.map((row) => new kakao.maps.LatLng(row.lat, row.lng));
      const color = vehicleColor(vehicle);
      const polygon = new kakao.maps.Polygon({ path, strokeWeight: selected.length ? 3 : 2, strokeColor: color, strokeOpacity: .76, fillColor: color, fillOpacity: selected.length ? .05 : .015 });
      polygon.setMap(state.map);
      state.polygons.push(polygon);
    });
    $("#areaToggle").setAttribute("data-geometry-count", String(state.polygons.length));
    $("#areaToggle").title = `표시 권역 geometry ${state.polygons.length}개`;
  }

  function geometryPaths(geometry) {
    if (!geometry) return [];
    const ring = (coordinates) => coordinates.map(([lng, lat]) => new kakao.maps.LatLng(lat, lng));
    if (geometry.type === "Polygon") return geometry.coordinates.map(ring);
    if (geometry.type === "MultiPolygon") return geometry.coordinates.flatMap((polygon) => polygon.map(ring));
    return [];
  }

  function drawRoute() {
    // Only provider road geometry is drawn by RoadRouteUi; never join stop coordinates.
  }

  function scheduleDetailPosition() {
    if (!detailFrame) detailFrame=requestAnimationFrame(()=>{detailFrame=null;positionDetailPopup();});
  }
  function positionDetailPopup() {
    // Screen-space right panel: map projection and zoom never set panel geometry.
    window.MapDotUi?.dockDetail();
  }

  function selectStore(row, element, focus, skipEnrich = false) {
    ++state.detailRequestId;requestControllers.get("store-detail")?.controller.abort("superseded");
    window.MapStaff?.clear();
    const routeStop = state.mode === "DATE_ROUTE" && operationStops.find((stop) => stop.customerCode === row.customerCode && stop.vehicle === row.vehicle);
    if (routeStop) row = { ...row, ...routeStop, ...Object.fromEntries(["accessInfo", "accessMemo", "password", "detailAddress", "specialRemark"].filter((key) => row[key]).map((key) => [key, row[key]])) };
    const expanded = state.selected?.customerCode === row.customerCode && $(".detailMore")?.open;
    $$(".marker.selected").forEach((item) => item.classList.remove("selected"));
    element?.classList.add("selected");
    state.selected = row;window.dispatchEvent(new CustomEvent('map-store-selected',{detail:{customerCode:row.customerCode}}));
    $$("[data-search-code]").forEach(button => {
      const active = button.dataset.searchCode === row.customerCode;
      button.classList.toggle("selected", active); button.setAttribute("aria-pressed", String(active));
    });
    $$(".marker").forEach((pin) => pin.classList.toggle("selected", Boolean(row.customerCode) && pin.dataset.customerCode === row.customerCode && pin.dataset.vehicle === row.vehicle));
    renderRunList();
    if (state.mode === "BASE_60D") {
      renderPeriodStoreList();
      $$("[data-period-store]").forEach(button => { const active = button.dataset.periodStore === row.customerCode; button.classList.toggle("selected", active); button.setAttribute("aria-pressed", String(active)); });
      if (element?.classList.contains("marker")) scrollSelectedInside('#periodStoreList','.periodStore.selected');
    }
    if (element?.classList.contains("marker")) scrollSelectedInside('#runList','.runStop.selected');
    const unlocated = numberOrNull(row.lat) === null || numberOrNull(row.lng) === null;
    if (unlocated) $("#mapStatusSub").textContent = "좌표 미확인 · 지도 위치를 변경하지 않습니다.";
    if (focus && state.map && numberOrNull(row.lat) !== null && numberOrNull(row.lng) !== null) {
      state.suppressMapEventsUntil = Date.now() + 500;
      if (state.map.getLevel() > 5) state.map.setLevel(5);
      state.map.panTo(new kakao.maps.LatLng(Number(row.lat), Number(row.lng)));
      if (state.mode === "BASE_60D") { state.fitRequested = false; renderStops(state.currentRows); }
    }
    const routeMode = state.mode === "DATE_ROUTE";
    const vehicle = normalizeVehicle(row.vehicle);
    const detailCenter=({osan:'오산센터',yeongnam:'영남센터',honam:'호남센터'})[!routeMode&&row.baseVehicleState==='VERIFIED_MASTER'&&row.baseVehicleSource==='FIXED_DISPATCH_PRIMARY'&&/^[a-f0-9]{64}$/.test(row.baseVehicleVersion||'')&&row.baseVehicleStale===false?row.baseVehicleGroup:'']||'센터 미확인';
    const orderCard = routeMode && row.order ? `<div class="stat"><strong>${esc(row.order)}</strong><span>착순</span></div>` : "";
    const statusCard = row.status ? `<div class="stat"><strong>${row.status === "COMPLETED" ? "완료" : "잔여"}</strong><span>상태</span></div>` : "";
    $("#detailSection").classList.add("open");
    $("#detail").className = "detailCard";
    if($("#detail").contains($("#staffAuxContent")))$("#detailSection").append($("#staffAuxContent"));
    $("#detail").innerHTML = `<div class="detailHead"><button id="detailClose" class="detailClose" aria-label="닫기">×</button><div class="code">${esc(row.customerCode || "신규 주소")}</div><div class="storeName">${esc(row.customerName || "선택 위치")}</div></div>
      <div class="detailBody">
        <dl class="dotDetailFacts"><dt>센터</dt><dd>${esc(detailCenter)}</dd><dt>${routeMode?"확정호차":"기준호차"}</dt><dd${routeMode?'':' id="detailBaseVehicle"'}>${esc(routeMode?vehicleLabel(vehicle)||'선택일 편성 없음':MapPeriodUi.baseVehicleLabel(row))}</dd><dt>담당 기사</dt><dd>최근 배송기사에서 확인</dd><dt>주소</dt><dd>${esc(row.address||'주소 미확인')}</dd><dt>운행 상태</dt><dd>${routeMode?(row.status==='COMPLETED'?'완료':row.status==='PENDING'?'미완료':'상태 미확인'):'일자별 운행에서 조회'}</dd></dl>

        ${!routeMode && row.history?.length ? `<div class="periodRecent">최근배송 ${esc(row.lastDeliveryDate)} · ${row.visitCount===null?'전체 기간 횟수 미확인':(row.visitCount??row.history.length)+'회 이력'}</div>` : ""}
        <div class="staffActions"><button id="staffHistory" ${routeMode?'':'hidden inert'} aria-expanded="false" aria-controls="staffAuxContent">최근 배송기사이력 ▸</button><button id="staffNotes" aria-expanded="false" aria-controls="staffAuxContent">출입배송정보 ▸</button></div>
        ${unlocated ? '<div class="coordinateWarning">좌표 미확인</div>' : ""}
        <div class="mobileActions"><button id="mobileMapView" class="primary">매장 위치 중심으로 보기</button><button id="mobileRouteView" class="ghost">${esc(vehicleLabel(vehicle) || "선택 호차")} 운행동선</button></div>
        <div id="nearWrap"></div>
      </div>`;
    requestAnimationFrame(positionDetailPopup);
    $(".detailMore")?.addEventListener("toggle", positionDetailPopup);
    const openStaff = kind => {const trigger=kind==='history'?$("#staffHistory"):$("#staffNotes");trigger.after($("#staffAuxContent"));window.MapStaff?.open({ kind, customerCode: row.customerCode, date: routeMode ? state.selectedDate : row.lastDeliveryDate || state.selectedDate,
      rangeStart: routeMode ? daysBefore(state.selectedDate, 59) : state.rangeStart, rangeEnd: routeMode ? state.selectedDate : state.rangeEnd }, $("#staffAuxContent"), trigger);positionDetailPopup();};
    $("#staffHistory")?.addEventListener("click", () => openStaff("history"));
    $("#staffNotes")?.addEventListener("click", () => openStaff("notes"));
    if (innerWidth <= 760) { showMobileMap(); $("#mobileWorkspace").classList.add("collapsed"); }
    $("#detailClose")?.addEventListener("click", clearSelection);
    if ((routeMode || row.virtual) && numberOrNull(row.lat) !== null && numberOrNull(row.lng) !== null) renderNearest(row);
    $("#mobileMapView")?.addEventListener("click", () => {showMobileMap();if(!unlocated&&state.map){state.suppressMapEventsUntil=Date.now()+500;state.map.panTo(new kakao.maps.LatLng(Number(row.lat),Number(row.lng)));}});
    $("#mobileRouteView")?.addEventListener("click", () => {
      if (vehicle && [...$("#mobileVehicle").options].some((option) => option.value === vehicle)) $("#mobileVehicle").value = vehicle;
      setSelectedVehicles(vehicle ? [vehicle] : []); refreshVehicleUi(true);
      showMobileMap(); activateSheet("runs");
    });
    if (routeMode && !skipEnrich && row.customerCode) enrichStoreDetail(row, element);
  }

  async function enrichStoreDetail(row, element) {
    const requestId = ++state.detailRequestId, detailMode=state.mode, detailVehicle=row.vehicle;
    try {
      const detailDate = state.selectedDate;
      const payload = await fetchJson(`/api/map-phase2b/preview/detail?customerCode=${encodeURIComponent(row.customerCode)}&date=${detailDate}`, { channel: "store-detail", ttl: 300000, timeout: 60000 });
      if (requestId !== state.detailRequestId || state.mode!==detailMode || state.mode!=="DATE_ROUTE" || state.selected?.customerCode !== row.customerCode || state.selected?.vehicle!==detailVehicle) return;
      const exact = payload.data ? normalizeApiStore(payload.data) : null;
      if (exact && exact.customerCode===row.customerCode && detailDate === state.selectedDate) selectStore({ ...row, ...exact, lat: row.lat, lng: row.lng, vehicle: row.vehicle, order: row.order, status: row.status, actualCompletedAt: row.actualCompletedAt, deliveryCompletedAt: row.deliveryCompletedAt, lastDeliveryDate: row.lastDeliveryDate }, element, false, true);
    } catch (error) { if (!isSilentRequestError(error)) void error; }
  }

  function scrollSelectedInside(containerSelector,rowSelector){
    requestAnimationFrame(()=>{const container=$(containerSelector),row=$(rowSelector);if(!container||!row)return;
      const a=container.getBoundingClientRect(),b=row.getBoundingClientRect();
      if(b.top<a.top)container.scrollTop+=b.top-a.top;else if(b.bottom>a.bottom)container.scrollTop+=b.bottom-a.bottom;
    });
  }

  async function selectVehicleStatus(row, element) {
    $$(".marker.selected").forEach((item) => item.classList.remove("selected"));
    element?.classList.add("selected");
    const vehicle = normalizeVehicle(row.vehicle);
    if (selectedVehicles().length !== 1 || selectedVehicles()[0] !== vehicle) {
      if (state.mode === "BASE_60D") { periodBasis = "vehicle"; syncPeriodBasis(); }
      setSelectedVehicles([vehicle]);
      if ([...$("#mobileBaseVehicle").options].some((option) => option.value === vehicle)) $("#mobileBaseVehicle").value = vehicle;
      refreshVehicleUi(false);
      requestMapFit();
      await loadBaseMap();
    }
    $("#operationVehicle").value = vehicle;
    await loadOperationStatus(vehicle, true, row);
  }

  function renderTodayVehicleRoute(vehicle, status) {
    const stops = (status?.stops || []).map((stop) => normalizeRouteStop({
      ...stop,
      status: stop.appRecorded ? "COMPLETED" : "PENDING"
    }, vehicle)).filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
    if (!stops.length) return;
    requestMapFit();
    renderStops(stops, { numbered: true, vehicles: [vehicle] });
    drawRoute(stops);
    $("#mapStatusTitle").textContent = `${vehicleLabel(vehicle)} ${state.selectedDate === localDate() ? "당일" : "과거"} 진행현황`;
    $("#mapStatusSub").textContent = `${status.date} · ${status.completedStops}/${status.totalStops} 완료`;
  }

  function renderVehiclePanel(vehicle, status, row, error = "") {
    window.MapStaff?.clear();
    if($("#detail").contains($("#staffAuxContent")))$("#detailSection").append($("#staffAuxContent"));
    const driver = {}; // Never substitute the current vehicle master for history.
    const lastTime = formatTime(status?.lastCompletedAt);
    const end = formatTime(status?.estimatedEndAt);
    const estimate = end ? `${end}${status.estimateConfidence === "낮음" ? " 전후 · 신뢰도 낮음" : " 예상"}` : "예상시간 산출 중";
    const remainingText = status?.remainingMinutes == null ? "예상시간 산출 중" : status.remainingMinutes < 60 ? `약 ${status.remainingMinutes}분` : `약 ${Math.floor(status.remainingMinutes / 60)}시간 ${status.remainingMinutes % 60}분`;
    const lastStore = status?.lastCompletedStore?.customerName || status?.lastCompletedStore?.customerCode || "";
    const nextStore = status?.nextStop?.customerName || status?.nextStop?.customerCode || "";
    $("#detailSection").classList.add("open");
    $("#detail").className = "detailCard";
    $("#detail").innerHTML = `<div class="detailHead"><button id="detailClose" class="detailClose">×</button><div class="code">${esc(vehicleLabel(vehicle))} · ${esc(status?.driverName || driver.driverName || driver.name || "기사 미확인")}</div><div class="storeName">${esc(status?.status || (error ? "조회 실패" : "데이터없음"))}</div></div><div class="detailBody">
      ${error ? `<div class="notice show">${esc(error)}</div>` : ""}
      <div class="stats"><div class="stat"><strong>${status?.totalStops ?? row.storeCount ?? "-"}</strong><span>총 착지</span></div><div class="stat"><strong>${status?.completedStops ?? "-"}</strong><span>완료</span></div><div class="stat"><strong>${status?.remainingStops ?? "-"}</strong><span>잔여</span></div></div>
      <div class="progressTrack"><span style="width:${Math.max(0, Math.min(100, status?.progressPercent || 0))}%"></span></div>
      <div class="detailLine"><b>진행률</b><span>${status ? `${status.progressPercent}%` : "-"}</span></div><div class="detailLine"><b>최근 완료</b><span>${status?.lastCompletedOrder ? `${status.lastCompletedOrder}착${lastStore ? ` · ${esc(lastStore)}` : ""} / ${lastTime || "-"}` : "-"}</span></div><div class="detailLine"><b>다음 예정</b><span>${status?.nextOrder ? `${status.nextOrder}착${nextStore ? ` · ${esc(nextStore)}` : ""}` : "-"}</span></div><div class="detailLine"><b>처리 속도</b><span>${status?.avgMinutesPerStop ? `평균 약 ${status.avgMinutesPerStop}분/착` : "산출 중"}</span></div><div class="detailLine"><b>예상 종료</b><span>${esc(estimate)}</span></div><div class="detailLine"><b>잔여 시간</b><span>${esc(remainingText)}</span></div><div class="detailLine"><b>연락처</b><span>매장 선택 → 최근 배송기사 (직원 로그인)</span></div><div class="detailLine"><b>운수사</b><span>${esc(status?.carrierName || driver.carrierName || driver.companyName || "-")}</span></div>
      <button id="vehicleTodayRoute" class="primary" style="width:100%;height:35px;margin-top:7px">실제 운행동선 보기</button></div>`;
    $("#detailClose")?.addEventListener("click", clearSelection);
    $("#vehicleTodayRoute")?.addEventListener("click", () => { $("#date").value = status?.date || localDate(); $("#vehicle").value = vehicle; loadRoute("pc"); });
  }

  async function renderNearest(point) {
    if (!point.virtual) return;
    if (!dateReady) { $("#nearWrap").textContent = "기준일 편성 확인 전 주변호차 판단 보류"; return; }
    const rows = Phase2bUi.nearbyVehicles(point, comparisonStores(), 30);
    $("#nearWrap").innerHTML = rows.length
      ? `<details class="detailMore"><summary>30km 주변 호차 ${rows.length}대 · 참고용</summary>${rows.map((row) => `<div class="judgeCard"><b>${esc(vehicleLabel(row.vehicle))}</b> · ${formatDistance(row.distance)}<br>최근접 배송점 ${esc(row.customerName)}</div>`).join("")}</details>`
      : `<div class="hint">30km 내 주변 호차가 없습니다.</div>`;
  }

  function addComparisonPins() {
    if (!state.map || !dateReady) return;
    representativeRows(state.mode === "BASE_60D" ? filteredPeriodStores() : state.currentRows).forEach((row) => {
      const overlay = new kakao.maps.CustomOverlay({ position: new kakao.maps.LatLng(row.lat, row.lng), content: markerElement(row, null, "representative"), xAnchor: .5, yAnchor: 1, zIndex: 2 });
      overlay.setMap(state.areaOn ? state.map : null);
      state.overlays.push(overlay); state.representativeOverlays.push(overlay);
    });
  }

  function renderRunList() {
    const selectedVehicle = primarySelectedVehicle();
    if ($("#runListTitle")) $("#runListTitle").textContent = selectedVehicle ? `${selectedVehicle}호 운행 목록` : "운행 목록";
    if ($("#selectedVehicleBadge")) $("#selectedVehicleBadge").textContent = selectedVehicle ? `선택 호차: ${selectedVehicle}호` : "호차 선택";
    if ($("#runListTool")) $("#runListTool").hidden = !selectedVehicle;
    const shown = operationStops.filter((row) => runFilter === "ALL" || row.status === runFilter);
    $("#runListCount").textContent = operationStops.length ? `${shown.length}/${operationStops.length}착` : "호차 선택 대기";
    $("#runList").innerHTML = shown.length ? shown.map((row) => {
      const next = operationStops[operationStops.indexOf(row) + 1];
      const distance = next ? distanceKm(row, next) : Infinity;
      const selected = state.selected?.customerCode === row.customerCode && state.selected?.vehicle === row.vehicle;
      return `<button class="runStop${selected ? " selected" : ""}" data-run-code="${esc(row.customerCode)}" aria-pressed="${selected}"><span class="runOrder">${esc(row.order || "-")}</span><span class="runInfo"><span class="runCode">${esc(row.customerCode)}</span><div class="runName">${esc(row.customerName || "점포명 미확인")}</div><span class="runMeta"><span class="statusChip ${row.status === "COMPLETED" ? "done" : ""}">${row.status === "COMPLETED" ? "완료" : row.status === "PENDING" ? "미완료" : "상태 미확인"}</span><span>${esc(formatTime(row.actualCompletedAt || row.deliveryCompletedAt) || "-")}</span><span class="runDistance">${row.lat == null || row.lng == null ? "좌표 미확인" : Number.isFinite(distance) ? "다음 직선 " + formatDistance(distance) : "-"}</span></span></span></button>`;
    }).join("") : "선택한 상태의 착지가 없습니다.";
    // Historical Hub route totals exclude unlocated rows. Keep those source
    // assignments in a clearly separate list without inventing route order/status.
    const extraStops = dateReady ? filteredDateStores(allStores).filter(row => row.vehicle === selectedVehicle && (row.lat == null || row.lng == null) && !operationStops.some(stop => stop.customerCode === row.customerCode)) : [];
    if (extraStops.length) {
      $("#runListCount").textContent += ` · 좌표 미확인 ${extraStops.length}`;
      $("#runList").innerHTML += `<div class="unlocatedHeading">좌표 미확인 착지 ${extraStops.length} · 운행집계 제외</div>` + extraStops.map(row => `<button class="unlocatedStop${state.selected?.customerCode === row.customerCode ? " selected" : ""}" data-run-code="${esc(row.customerCode)}"><span class="runOrder">—</span><span class="runInfo"><span class="runCode">${esc(row.customerCode)}</span><div class="runName">${esc(row.customerName)}</div><span class="coordinateWarning">좌표 미확인 · 상태 미확인</span></span></button>`).join("");
    }
    $$('[data-run-code]').forEach((button) => button.onclick = () => {
      const row = [...operationStops, ...extraStops].find((stop) => stop.customerCode === button.dataset.runCode);
      if (!row) return;
      state.fitRequested = false;
      renderStops(state.routeRows, { numbered: true }); drawRoute(state.routeRows);
      selectStore(row, null, true);
    });
    $$('[data-run-filter]').forEach((button) => { button.classList.toggle("active", button.dataset.runFilter === runFilter); button.setAttribute("aria-pressed", String(button.dataset.runFilter === runFilter)); });
  }

  function activateSheet(tab = sheetTab) {
    if (sheetTab === 'new' && tab !== 'new') cancelNewAreaWork();
    sheetTab = tab;
    if($('#approvedSiteHeader'))return;
    if (tab === "detail") tab = state.mode === "BASE_60D" ? "stores" : "runs";
    sheetTab = tab;
    const panels = { filters: $("#periodFilterPanel"), stores: $("#periodStoreListSection"), runs: $("#runListPanel"), new: $("#newAreaTools"), manual: $('#manualRouteTool') };
    const mobile = innerWidth <= 760;
    const brand = $('#officialBrand');
    if (brand) (mobile ? $('#periodFilterPanel') : $('#mapHeaderBrand')||$('#leftPanel .head')).prepend(brand);
    const shortcuts = $('#approvedShortcuts');
    if (shortcuts) {
      if (mobile) $('#periodFilterPanel').append(shortcuts);
      else if($('#approvedSiteHeader'))$('#approvedSiteHeader').insertBefore(shortcuts,$('#staffLogout'));
      else $('#mapModeBar').insertBefore(shortcuts, $('#periodIdentity'));
    }
    const dates=$('#mapDateBar');
    if(dates)(mobile?$('#mobileDateHome'):$('#leftPanel .head')).append(dates);
    for (const [key, panel] of Object.entries(panels)) {
      if (!panelHomes.has(key)) { const anchor = document.createComment(`panel-${key}`); panel.parentNode.insertBefore(anchor, panel); panelHomes.set(key, anchor); }
      if (mobile && key === tab && key !== "detail") $("#mobileSheetContent").append(panel);
      else { const anchor = panelHomes.get(key); anchor.parentNode.insertBefore(panel, anchor.nextSibling); }
    }
    $$('[data-sheet-tab]').forEach((button) => { button.classList.toggle("active", button.dataset.sheetTab === tab); button.setAttribute("aria-selected", String(button.dataset.sheetTab === tab)); });
    if (mobile) $("#mobileWorkspace").classList.remove("collapsed");
  }

  async function showDiagnostics() {
    const panel = $("#operationsPanel"); panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    panel.textContent = "상태 확인 중…";
    const [status, periodStatus] = await Promise.all([
      fetchJson("/api/map-phase2b/preview/status", { channel: "diagnostics", ttl: 15000, timeout: 10000 }).catch(() => ({})),
      fetchJson("/api/map-phase2b/preview/period-status", { channel: "period-diagnostics", ttl: 15000, timeout: 10000 }).catch(() => ({}))
    ]);
    if (panel.hidden) return;
    const snap = status.snapshot || {};
    const rows = [ ["조회 범위", state.mode === "BASE_60D" ? `${state.rangeStart} ~ ${state.rangeEnd}` : state.selectedDate],
      ["선택 호차", primarySelectedVehicle() || "없음"], ["Hub 인증", status.hubAuth || "확인 중"],
      ["Snapshot 상태", snap.phase || "확인 중"], ["Snapshot 목표일", snap.targetLatest || "확인 중"],
      ["Snapshot 최신일", snap.latest || "확인 중"], ["Snapshot stale", snap.stale === true ? "true · 최신 상태 아님" : snap.stale === false ? "false · 최신 상태" : "확인 중"],
      ["Snapshot 이어받기", snap.continuation || "확인 중"],
      ["기간 모델 상태", periodStatus.ready === true || periodStatus.complete === true ? "준비 완료" : periodStatus.phase === "ERROR" ? "조회 오류" : periodStatus.phase ? "준비 중 · " + periodStatus.phase : "확인 중"],
      ["기간 모델 범위", periodStatus.startDate && periodStatus.endDate ? `${periodStatus.startDate} ~ ${periodStatus.endDate}` : "확인 중"],
      ["현재 목록", periodViewState], ["최근 운행 조회", lastRefreshedAt || "확인 중"],
      ["주소 좌표 조회", geocodeDiagnostic], ...[...apiDiagnostics].map(([key, value]) => [key, `${value.ms}ms · ${value.cache} · HTTP ${value.status}`]) ];
    panel.innerHTML = `<table class="diagnosticTable"><tbody>${rows.map(([label, value]) => `<tr><th>${esc(label)}</th><td>${esc(value || "미제공")}</td></tr>`).join("")}</tbody></table>`;
  }

  function showNearbyReference(point) {
    if (!dateReady) { selectStore(point, null, false); return; }
    const retained = state.currentRows.filter((row) => !row.nearbyVehicle && !row.virtual);
    const routes = state.routeRows.slice();
    const nearby = Phase2bUi.nearbyVehicles(point, comparisonStores(), 30).map((row) => ({ ...row, nearbyVehicle: true }));
    state.fitRequested = false;
    renderStops([...retained, ...nearby, point], { virtual: true, vehicles: selectedVehicles() });
    if (routes.length) drawRoute(routes);
    selectStore(point, null, false);
    $("#nearWrap details")?.setAttribute("open", "");
  }

  function normalizeSearchText(value) {
    return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("ko-KR").replace(/[\s\-_()[\]{}.,/\\]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function searchTokens(value) { return normalizeSearchText(value).split(" ").filter(Boolean); }

  function rankSearchRow(row, query) {
    const q = normalizeSearchText(query);
    const tokens = searchTokens(query);
    const compact = (value) => normalizeSearchText(value).replace(/\s/g, "");
    const code = compact(row.customerCode);
    const name = compact(row.customerName);
    const address = compact(row.address);
    const target = compact(q);
    if (code === target) return 0;
    if (name === target) return 1;
    if (name.startsWith(target) || name.includes(target)) return 2;
    if (code.includes(target)) return 3;
    if (tokens.length && tokens.every((token) => name.includes(compact(token)))) return 4;
    if (tokens.length && tokens.every((token) => address.includes(compact(token)))) return 5;
    return 99;
  }

  function rankSearchRows(rows, query) {
    const seen = new Set();
    return rows.map((row) => normalizeApiStore(row)).map((row) => ({ row, rank: rankSearchRow(row, query) }))
      .filter(({ row, rank }) => { const key = row.customerCode || `${normalizeSearchText(row.customerName)}|${normalizeSearchText(row.address)}`; return rank < 99 && !seen.has(key) && seen.add(key); })
      .sort((a, b) => a.rank - b.rank || naturalCompare(a.row.customerName, b.row.customerName))
      .map(({ row }) => row);
  }

  async function fixedDispatchSearch(text) {
    const tokens = searchTokens(text);
    const queries = tokens.length > 1 ? tokens : [text];
    const lists = await Promise.all(queries.map(async (query) => {
      const payload = await fetchJson(`/api/fixed-dispatch/customer-search?q=${encodeURIComponent(query)}&date=${encodeURIComponent($("#date").value || "")}`, { channel: `fixed-search-${query}`, ttl: 60000, timeout: 20000 });
      return payload.results || payload.data || [];
    }));
    if (lists.length === 1) return lists[0];
    const commonCodes = lists.slice(1).map((rows) => new Set(rows.map((row) => String(row.customerCode || row.code || "").trim()).filter(Boolean)));
    return lists[0].filter((row) => {
      const code = String(row.customerCode || row.code || "").trim();
      return code && commonCodes.every((codes) => codes.has(code));
    });
  }

  function normalizeApiStore(row) {
    const code = String(row.customerCode || row.code || row.id || "").trim();
    const vehicle = normalizeVehicle(row.vehicle || row.confirmedVehicle || row.primaryVehicle90d);
    const local = { ...coordinateByCode.get(code), ...(storeByVehicleAndCode.get(`${vehicle}|${code}`) || storesByCode.get(code) || {}) };
    return {
      ...local,
      ...row,
      customerCode: code || local.customerCode || "",
      customerName: row.customerName || row.name || local.customerName || "",
      address: row.address || row.customerAddress || local.address || "",
      detailAddress: row.detailAddress || row.addressDetail || local.detailAddress || "",
      vehicle: state.mode==='BASE_60D'&&periodBasis!=='driver' ? baseVehicles.get(code)?.baseVehicle||'' : vehicle || local.vehicle || "",
      ...(state.mode==='BASE_60D'?baseVehicles.get(code)||{baseVehicle:'',baseVehicleState:'UNKNOWN'}:{}),
      lat: numberOrNull(row.lat ?? row.latitude) ?? local.lat ?? null,
      lng: numberOrNull(row.lng ?? row.longitude) ?? local.lng ?? null,
      accessInfo: row.accessInfo || local.accessInfo || "",
      password: row.password || row.doorPassword || local.password || "",
      lastDeliveryDate: row.lastDeliveryDate || row.deliveryDate || local.lastDeliveryDate || ""
    };
  }

  async function search() {
    const text = $("#query").value.trim();
    if (!text) return;
    if (state.mode === "BASE_60D") return searchPeriod(text);
    return; // Daily view intentionally has no general customer/address search.
    setSearchState("검색 중", true);
    $("#results").innerHTML = "";
    const requestId = ++state.searchRequestId;
    // Snapshot is a customer-name/coordinate index only. Dated rows win dedupe;
    // snapshot vehicle relationships must never masquerade as dated dispatch.
    const localRows = rankSearchRows(hasDatedDriverFilter()?(dateReady?filteredDateStores(allStores):[]):[...(dateReady ? allStores : []), ...latestSnapshotRows], text).slice(0, 40)
      .map((row) => ({ ...row, vehicle: dateReady ? storesByCode.get(row.customerCode)?.vehicle || "" : "", deliveryDate: state.selectedDate }));
    if (localRows.length) {
      setSearchState(`${localRows.length}건 · ${state.selectedDate} 편성`);
      requestMapFit(); renderResults(localRows); renderStops(localRows, { boundaries: false }); selectStore(localRows[0], null, true);
      return;
    }
    const errors = [];
    if(hasDatedDriverFilter()){setSearchState('검색 결과 0건 · 선택 기사와 해당일 근거 범위 · 현재 지도 유지');return;}
    if (/^[A-Z]\d{3,}$/i.test(text)) {
      try {
        const detail = await fetchJson(`/api/map-phase2b/preview/detail?customerCode=${encodeURIComponent(text.toUpperCase())}`, { channel: "exact-code-search", ttl: 300000, timeout: 45000 });
        if (requestId !== state.searchRequestId) return;
        if (detail.data?.customerCode) {
          const row = normalizeApiStore(detail.data);
          row.vehicle = dateReady ? storesByCode.get(row.customerCode)?.vehicle || "" : "";
          setSearchState("1건 · 고객코드 일치");
          requestMapFit(); renderResults([row]); renderStops([row], { boundaries: false }); selectStore(row, null, true, true);
          return;
        }
      } catch (error) { if (isSilentRequestError(error)) return; errors.push(error); }
    }
    const candidates = [];
    try {
      candidates.push(...await fixedDispatchSearch(text));
    } catch (error) { if (!isSilentRequestError(error)) errors.push(error); }
    try {
      const hub = await fetchJson(`/api/map-phase2b/preview/search?q=${encodeURIComponent(text)}`, { channel: "hub-search", ttl: 60000, timeout: 30000 });
      candidates.push(...(hub.data || []));
    } catch (error) { if (!isSilentRequestError(error)) errors.push(error); }
    if (requestId !== state.searchRequestId) return;
    // Master search preserves customer lookup, but cannot invent a dated vehicle.
    const rows = rankSearchRows(candidates, text).slice(0, 20).map((row) => ({ ...row, vehicle: dateReady ? storesByCode.get(row.customerCode)?.vehicle || "" : "", deliveryDate: state.selectedDate }));
    if (!rows.length) {
      setSearchState(errors.length ? searchFailureMessage(errors) : "검색 결과 0건 · 현재 지도 유지");
      return;
    }
    setSearchState(`${rows.length}건${errors.length ? " · 일부 API 오류" : ""}`);
    requestMapFit();
    renderResults(rows);
    renderStops(rows, { boundaries: false });
    selectStore(rows[0], null, true);
  }

  function renderResults(rows) {
    $("#results").innerHTML = rows.map((row, index) => `<button class="resultItem" data-result="${index}" data-search-code="${esc(row.customerCode)}" aria-pressed="false"><div class="resultName">${esc(row.customerCode)} · ${esc(row.customerName || "-")}</div><div class="resultMeta"><span class="chip">${esc(vehicleLabel(row.vehicle || "-"))}</span>${esc(row.address || "-")}</div></button>`).join("");
    $$("[data-result]").forEach((element) => {
      element.onclick = () => {
        const row = rows[Number(element.dataset.result)];
        requestMapFit();
        renderStops([row], { boundaries: false });
        selectStore(row, null, true);
      };
    });
  }

  async function searchExternalAddress(text) {
    if(state.mode!=='BASE_60D')return;
    cancelAddressLookup();
    if (!validNewAreaInput(text)) {
      setSearchState("주소 또는 고객정보를 정확히 입력하세요.");
      $("#searchNotice").textContent = "주소 또는 고객정보를 정확히 입력하세요.";
      $("#searchNotice").classList.add("show");
      return;
    }
    const requestId = ++state.addressRequestId;
    setSearchState("주소 확인 중", true);
    addressController = new AbortController();
    let point;
    try { point = await geocodeAddress(text, addressController.signal); }
    catch (error) {
      if (requestId === state.addressRequestId && !isSilentRequestError(error)) {
        setSearchState(NewAreaRequests.message(error) + ' · 결과 미확인');
        $('#addressJudgeResults').textContent = NewAreaRequests.message(error) + ' · 다시 시도해 주세요.';
      }
      return;
    } finally { if (requestId === state.addressRequestId) addressController = null; }
    if (requestId !== state.addressRequestId) return;
    if (!point) {
      setSearchState("주소 검색 결과 0건 · 도로명과 건물번호를 확인하세요.");
      $('#addressJudgeResults').textContent = '주소 검색 결과 0건';
      return;
    }
    if (point.candidates) {
      $("#addressJudgeResults").innerHTML = `<div class="hint">주소 후보를 선택해주세요.</div>${point.candidates.map((candidate, index) => `<button class="resultItem" data-address-candidate="${index}">${esc(candidate.address)}</button>`).join("")}`;
      $$('[data-address-candidate]').forEach((button) => button.onclick = () => { if (requestId === state.addressRequestId) finishAddress(point.candidates[Number(button.dataset.addressCandidate)]); });
      setSearchState("주소 후보 확인 필요"); return;
    }
    finishAddress(point);
  }

  function offerExternalAddressResult(text){
    const button=document.createElement('button'),owner=state.searchRequestId;button.type='button';button.className='resultItem externalAddressResult';button.dataset.resultType='external-address';button.textContent='외부 주소 위치 확인 · 지도 밖 주소 · 별도 조회';
    button.onclick=()=>{if(owner===state.searchRequestId&&state.mode==='BASE_60D')void searchExternalAddress(text);};$('#results').append(button);
  }
  async function searchPeriod(text) {
    if (state.mode!=='BASE_60D')return;
    if (!dateReady || (!generalMap && (!periodMeta?.complete || periodMeta.startDate !== state.rangeStart || periodMeta.endDate !== state.rangeEnd))) {
      setSearchState("매장 자료 준비 중 · 원천 조회 결과 미확인");$("#results").replaceChildren();offerExternalAddressResult(text);return;
    }
    const token = ++state.searchRequestId;
    setSearchState("검색 중", true);
    $("#results").innerHTML = "";
    const known = rankSearchRows([...periodRows, ...latestSnapshotRows], text);
    let matches = known;
    if (!matches.length) {
      try {
        const response = await fetchJson(`/api/map-phase2b/preview/search?q=${encodeURIComponent(text)}`, { channel: "period-search", ttl: 60000, timeout: 30000 });
        matches = rankSearchRows(response.data || [], text);
      } catch (error) { if (token === state.searchRequestId && !isSilentRequestError(error)) setSearchState(searchFailureMessage([error])); return; }
    }
    if (token !== state.searchRequestId || state.mode !== "BASE_60D") return;
    await loadBaseVehicles(matches.slice(0,40).map(r=>r.customerCode));
    if (token !== state.searchRequestId || state.mode !== "BASE_60D") return;
    const matching = new Map(filteredPeriodStores().map(row => [row.customerCode, row]));
    const period = new Map(MapPeriodUi.select(periodRows).map(row => [row.customerCode, row]));
    const rows = matches.slice(0, 40).map(item => matching.get(item.customerCode) || { ...item,
      vehicle: baseVehicles.get(item.customerCode)?.baseVehicle||"", ...(baseVehicles.get(item.customerCode)||{}), driverName: "", history: [], lastDeliveryDate: "",
      outsideReason: period.has(item.customerCode) ? "현재 호차/기사 조건의 이력 없음" : "선택 기간 이력 없음" });
    setSearchState(rows.length ? `${rows.length}건 · 기간/조회 조건 유지` : "검색 결과 0건 · 현재 지도 유지");
    $("#results").innerHTML = rows.map((row, index) => `<button class="resultItem" data-period-result="${index}" data-search-code="${esc(row.customerCode)}" aria-pressed="false"><div class="resultName">${esc(row.customerCode)} · ${esc(row.customerName)}</div><div class="resultMeta">${esc((rankSearchRow(row,text)===0?'고객코드 정확 일치':rankSearchRow(row,text)<=4?'매장명':'주소')+' · '+(row.outsideReason || vehicleLabel(row.vehicle) + ' · ' + row.lastDeliveryDate))}</div></button>`).join("");
    if(!rows.length)offerExternalAddressResult(text);
    $$("[data-period-result]").forEach(button => button.onclick = () => {
      const row = rows[Number(button.dataset.periodResult)];
      selectStore(row, null, true, true);
      if (row.outsideReason) $("#mapStatusSub").textContent = row.outsideReason;
      if (innerWidth <= 760) $("#results").innerHTML = "";
    });
  }

  function finishAddress(point) {
    const virtual = { customerCode: "", customerName: point.placeName || "신규 주소", address: point.address, lat: point.lat, lng: point.lng, virtual: true };
    showVirtual(virtual);
    $("#addressJudgeResults").textContent = "위치 확인 · 신규권역 판단은 일괄조회에서 실행하세요.";
    $("#searchNotice").textContent = `주소 좌표 확인 ${point.geocodeMs ?? "-"}ms · 저장하지 않는 임시핀`;
    if (dateReady) showNearbyReference(virtual);
    if (innerWidth <= 760) activateSheet("new");
  }

  async function geocodeAddress(address, signal) {
    const stored=[...new Map([...latestSnapshotRows,...allStores].filter(r=>[r.customerCode,r.customerName,r.address].includes(address)).map(r=>[r.customerCode,r])).values()].filter(r=>Number.isFinite(r.lat)&&Number.isFinite(r.lng));
    if(stored.length===1)return {lat:stored[0].lat,lng:stored[0].lng,address:stored[0].address};
    if(stored.length>1)return {candidates:stored.map(r=>({lat:r.lat,lng:r.lng,address:r.address,customerCode:r.customerCode}))};
    if(window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup!==true)throw Error('저장된 고객코드·점포명·주소를 선택해 주세요. 외부 주소 조회는 승인되지 않았습니다.');
    const started = performance.now();
    const attempts = [];
    if (geocodeCache.has(address)) return geocodeCache.get(address);
    for (const query of Phase2bUi.addressVariants(address)) {
      const attemptStarted = performance.now();
      const result = await NewAreaRequests.lookup(window.kakaoGeocoder, query, { signal });
      const exact = result.filter((row) => Phase2bUi.addressMatches(query, row.road_address?.address_name || row.address_name) || Phase2bUi.addressMatches(query, row.address?.address_name || ""));
      attempts.push({ query, ms: Math.round(performance.now() - attemptStarted), candidates: result.length, exact: exact.length });
      if (exact.length > 1) {
        geocodeDiagnostic = `후보 선택 · ${Math.round(performance.now() - started)}ms`;
        return { candidates: exact.map((row) => ({ lat: Number(row.y), lng: Number(row.x), address: row.road_address?.address_name || row.address_name, geocodeMs: Math.round(performance.now() - started) })) };
      }
      if (exact.length !== 1) continue;
      const row = exact[0];
      const point = { lat: Number(row.y), lng: Number(row.x), address: row.road_address?.address_name || row.address_name, geocodeMs: Math.round(performance.now() - started), attempts, query };
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
      while(geocodeCache.size>=128)geocodeCache.delete(geocodeCache.keys().next().value);geocodeCache.set(address, point);
      geocodeDiagnostic = `성공 · ${point.geocodeMs}ms · ${attempts.length}회 조회`;

      return point;
    }

    geocodeDiagnostic = `확인 필요 · ${Math.round(performance.now() - started)}ms`;
    return null;
  }

  function showVirtual(row) {
    setSearchState("미등록 주소");
    $("#searchNotice").textContent = "Customer에 저장하지 않는 세션 임시핀입니다.";
    $("#searchNotice").classList.add("show");
    $("#results").innerHTML = `<button class="resultItem selected"><div class="resultName">📍 ${esc(row.address)}</div><div class="resultMeta">임시핀 · 주변 배송처/근접호차 표시</div></button>`;
    row.virtual = true;
    const selected = new Set(selectedVehicles());
    const retained = state.mode === "DATE_ROUTE" ? state.routeRows : state.currentRows.filter(store => !store.virtual);
    state.fitRequested = false;
    renderStops([...retained, row], { virtual: true, boundaries: state.areaOn });
    if (state.routeRows.length) drawRoute(state.routeRows);
    selectStore(row, null, true);
    state.virtual = row;
  }

  function renderAddressJudge(row) {
    $("#addressJudgeResults").innerHTML = `<div class="judgeCard"><div class="judgeTop"><span class="judgeBadge ${row.decision === "O" ? "ok" : row.decision === "검토" ? "review" : "no"}">${esc(row.decision)}</span><b>${esc(row.customer || "신규 주소")}</b></div><div>권역판정: <b>${row.decision === "O" ? "가능" : esc(row.reason)}</b></div><div>배송요일: <b>${esc(row.deliveryDays || "")}</b></div><div>근접호차: <b>${esc(vehicleLabel(row.vehicle || "-"))}</b>${row.nearestDistance == null ? "" : ` · ${formatDistance(row.nearestDistance)}`}</div>${row.facility ? `<span class="facility">차량 진입 확인 필요</span>` : ""}</div>`;
  }

  function refreshVehicleUi(run) {
    if (run) resetRoadRoute();
    syncRoadRoutePanel();
    const selected = selectedVehicles();
    if (run) {
      ++state.todayRequestId; ++state.routeRequestId;
      requestControllers.get("operation-status")?.controller.abort("superseded");
      clearSelection(); updateOperationMetrics(null);
    }
    if (state.mode === "BASE_60D" && selected.length) periodVehicleScope = "selected";
    $("#selectedVehicleCount").textContent = selected.length ? `${selected.length}대` : "선택 없음";
    $("#vehicleModeLabel").textContent = selected.length === 1 ? "해당 호차 집중모드" : selected.length > 1 ? "선택 호차 권역 비교" : "기준일 전체 권역";
    $("#mapStatusTitle").textContent = selected.length === 1 ? `${selected[0]}호 ${state.selectedDate} 권역` : selected.length > 1 ? `${selected.length}대 호차 권역 비교` : "기준일 전체 권역";
    $("#vehicleChips").className = selected.length ? "" : "vehiclePlaceholder";
    $("#vehicleChips").innerHTML = selected.length ? (selected.length > 3 ? `${selected.length}개 호차 선택` : selected.map((vehicle) => `<span class="vehicleChip" role="button" tabindex="0" data-remove-vehicle="${esc(vehicle)}" aria-label="${esc(vehicleLabel(vehicle))} 선택 해제">${esc(vehicleLabel(vehicle))} ×</span>`).join("")) : periodVehicleScope === "all" ? "전체 호차" : "호차를 선택하세요";
    $$('[data-remove-vehicle]').forEach((chip) => {
      const remove = (event) => { event.stopPropagation(); setSelectedVehicles(selectedVehicles().filter((vehicle) => vehicle !== chip.dataset.removeVehicle)); refreshVehicleUi(false); state.fitRequested = false; loadBaseMap(); };
      chip.onclick = remove;
      chip.onkeydown = (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); remove(event); } };
    });
    $("#operationVehicle").value = selected.length === 1 ? selected[0] : "";
    if (!selected.length) {
      operationStops = []; renderRunList();
      ++state.todayRequestId; updateOperationMetrics(null); $("#syncOperation").disabled = false;
      if (state.mode === "DATE_ROUTE") { state.routeRows = []; clearMap(); }
    }
    if (run) { operationStops = []; state.routeRows = []; renderRunList(); requestMapFit(); loadBaseMap(); if (state.mode === "DATE_ROUTE") loadOperationStatus(primarySelectedVehicle(), selected.length === 1); }
  }

  let datedDriverEvidence;
  function hasDatedDriverFilter(){return state.mode==='DATE_ROUTE'&&periodBasis==='driver'&&Boolean(selectedDriverKeys.length||state.driverKey);}
  function queryFilterIdentity(){return JSON.stringify([periodBasis,selectedDriverKeys.slice().sort(),state.driverKey,selectedVehicles().slice().sort(),periodVehicleScope,state.centerFilter,state.searchRequestId]);}
  function matchesDatedDriver(row) {
    if(periodBasis!=='driver')return true;
    const keys=selectedDriverKeys.length?selectedDriverKeys:state.driverKey?[state.driverKey]:[];
    if(!keys.length)return true;
    if(row.driverIdentity==='UNVERIFIED'||row.raw?.driverIdentity==='UNVERIFIED')return false;
    const date=state.selectedDate,vehicle=String(row.vehicle||''),code=String(row.customerCode||'');
    if(row.driverIdentity==='VERIFIED'&&keys.includes(row.driverKey)&&(row.deliveryDate||row.lastDeliveryDate||row.raw?.deliveryDate)===date)return true;
    if(datedDriverEvidence?.source!==periodRows){const byCode=new Map();for(const item of periodRows){const key=String(item.customerCode||item.code||'');const records=byCode.get(key)||[];records.push(...(item.relations||item.history||[]));byCode.set(key,records);}datedDriverEvidence={source:periodRows,byCode};}
    const records=[...(row.history||[]),...(datedDriverEvidence.byCode.get(code)||[])];
    return records.some(item=>item.deliveryDate===date&&String(item.vehicle||'')===vehicle&&keys.includes(item.driverKey)&&item.driverIdentity==='VERIFIED');
  }
  function filteredDateStores(rows) {
    const selected=selectedVehicles();
    if(periodBasis==='vehicle'&&periodVehicleScope==='selected'&&!selected.length)return [];
    return rows.filter(row=>(periodBasis==='driver'||!selected.length||selected.includes(row.vehicle))&&(periodBasis==='driver'||!state.centerFilter||row.vehicleGroup===state.centerFilter)&&matchesDatedDriver(row));
  }
  async function loadBaseMap() {
    if (!dateReady) return;
    const selected = selectedVehicles();
    let stores = state.mode === "BASE_60D" ? filteredPeriodStores()
      : filteredDateStores(allStores);
    if (state.mode === "BASE_60D") stores = stores.map(row => ({ ...row, color: vehicleColor(row.vehicle) }));
    renderStops(stores, { numbered: state.mode === "DATE_ROUTE", vehicles: selected });
    if(hasDatedDriverFilter()){resetRoadRoute();operationStops=stores;state.routeRows=stores.filter(row=>Number.isFinite(row.lat)&&Number.isFinite(row.lng));renderRunList();updateOperationMetrics(null);$('#opTotal').textContent=stores.length;for(const id of ['#routeSummary','#mobileRouteSummary'])$(id).textContent='선택 기사 해당일 근거 '+stores.length+'착지 · 차량 전체 운행집계와 도로 경로 미조회';}
    const period = state.mode === "BASE_60D";
    if (period) {
      setPeriodViewState(generalAllStores && snapshotReadState === 'error' ? 'error' : stores.length ? "ready" : "empty");
      const subject = periodBasis === "driver" ? ($("#periodDriver").selectedOptions[0]?.textContent || "전체 기사") : periodVehicleScope === "all" ? "전체 호차" : selected.length === 1 ? selected[0] + "호" : selected.length ? selected.length + "개 호차" : "호차 선택 없음";
      const range = state.rangeStart === daysBefore(state.rangeEnd, 89) ? "최근 90일" : state.rangeStart.slice(5) + " ~ " + state.rangeEnd.slice(5);
      $("#periodIdentity").textContent = `${subject} · ${generalAllStores && periodBasis === 'vehicle' ? '저장된 전체 매장' : range} · ${stores.length}개 매장`;
      if (generalAllStores && snapshotReadState === 'error') $('#periodIdentity').textContent = '전체 매장 원천 조회 실패 · 전체 매장 수 미확인';
    }
    $("#mapStatusTitle").textContent = period ? "매장·권역 지도" : "일자별 운행";
    $("#mapStatusSub").textContent = period ? `${state.rangeStart} ~ ${state.rangeEnd} · ${stores.length}개 매장 · ${periodBasis === 'driver' ? '선택 기사 실제 배차' : '현재 기준호차 · 미확인 ?'}`
      : `${state.selectedDate} · ${stores.length}개 매장 · 해당일 편성`;
    $("#freshnessState").textContent = period ? `지도 반영일 ${modelStatus?.periodLatest || periodMeta?.periodLatest || state.rangeEnd}` : `${state.selectedDate} 편성 조회 완료`;
    if(period&&periodBasis==='vehicle'&&baseVehicleStatus!=='READY')$('#mapStatusSub').textContent=baseVehicleStatus==='ERROR'?'기준호차 조회 실패 · 확인 필요 · 기존 지도 유지':'기준호차 확인 중 · 미지정으로 판단하지 마세요.';
    if(period&&periodBasis==='vehicle'&&baseVehicleStatus==='READY'&&baseVehicleMeta?.stale)$('#mapStatusSub').textContent+=` · 기준호차 이전 확인값 (${baseVehicleMeta.checkedAt||'시각 미확인'}) · ${baseVehicleMeta.refresh==='RUNNING'?'별도 갱신 중':baseVehicleMeta.refresh==='ERROR'?'갱신 실패 · 기존값 유지':'갱신 대기'} · 기간 최신화와 별개`;
    syncDateHeading();
    $("#vehicleModeLabel").textContent = period ? "기간별 매장" : "날짜별 편성";
    if (selected.length === 1) $("#operationVehicle").value = selected[0];
    renderPeriodStoreList(stores);
  }


  function previewBounds() {
    let south = 33, west = 124, north = 39, east = 132;
    if (state.map) {
      const bounds = state.map.getBounds();
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      south = sw.getLat(); west = sw.getLng(); north = ne.getLat(); east = ne.getLng();
    }
    const clamp = (min, max, limit, absoluteMin, absoluteMax) => {
      const span = Math.min(Math.max(0, max - min), limit, absoluteMax - absoluteMin);
      const center = (min + max) / 2;
      const low = Math.max(absoluteMin, Math.min(center - span / 2, absoluteMax - span));
      return [low, low + span];
    };
    const lat = clamp(south, north, 4.99, 33, 39);
    const lng = clamp(west, east, 4.99, 124, 132);
    return { south: String(lat[0]), west: String(lng[0]), north: String(lat[1]), east: String(lng[1]) };
  }

  function inferLatestDate() {
    return state.latestDate;
  }

  function latestDateFromRows(rows) {
    return rows.map((row) => String(row.lastDeliveryDate || row.deliveryDate || "").slice(0, 10))
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort().pop() || "";
  }

  function updateDateRange(latest) {
    syncDateHeading();
    $("#date").max = localDate();
    $("#mobileDate").max = localDate();
  }

  async function loadRoute(source) {
    if (!dateReady) return;
    cancelManualRoadRoute();
    if(hasDatedDriverFilter()){await loadBaseMap();await loadOperationStatus('',false);return;}
    const date = state.selectedDate;
    const vehicle = source === "mobile" ? $("#mobileVehicle").value : $("#vehicle").value;
    setSelectedVehicles([vehicle]);
    $("#operationVehicle").value = vehicle;
    refreshVehicleUi(false);
    requestMapFit();
    if (date === localDate()) {
      await loadOperationStatus(vehicle, true);
      return;
    }
    setRouteLoading(source, "운행동선 조회 중...");
    const requestId = ++state.routeRequestId;
    const filterIdentity=queryFilterIdentity();
    let payload = null;
    try {
      const response = await fetchJson(`/api/map-phase2b/preview/route-plan?date=${encodeURIComponent(date)}&vehicle=${encodeURIComponent(vehicle)}`, { channel: "route-plan", ttl: 30000, timeout: 45000 });
      if (requestId !== state.routeRequestId || date!==state.selectedDate || filterIdentity!==queryFilterIdentity()) return;
      payload = response.data || null;
    } catch (error) {
      if (isSilentRequestError(error)||requestId!==state.routeRequestId||date!==state.selectedDate||filterIdentity!==queryFilterIdentity()) return;
      setRouteLoading(source, `조회 실패: ${error.message}`);
      return;
    }
    if (!payload?.stops?.length) {
      setRouteLoading(source, "조회 결과 없음");
      return;
    }
    const stops = filteredDateStores(dedupeRouteStops((payload.stops || []).map((stop) => normalizeRouteStop(stop, vehicle)))).filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
    if (!stops.length) {
      setRouteLoading(source, "조회 결과 없음");
      return;
    }
    // Display server totals even when a stop has no map coordinates.
    state.mode = "DATE_ROUTE";
    state.routeRows = stops;
    renderStops(stops, { numbered: true, boundaries: false });
    drawRoute(stops);
    renderRouteSummary(payload, source);
    loadRoadRoute(vehicle);
    updateOperationMetrics(payload);
    $("#mapStatusTitle").textContent = `${vehicleLabel(vehicle)} 특정일 운행`;
    $("#mapStatusSub").textContent = `${date} · 착순 연결선 · 도로 경로 아님`;
    setRouteLoading(source, "");
    if (source === "mobile") showMobileMap();
  }

  function resolveRouteStop(stop, vehicle) {
    const code = String(stop.customerCode || stop.code || "").trim();
    const local = storeByVehicleAndCode.get(`${normalizeVehicle(vehicle)}|${code}`) || storesByCode.get(code) || {};
    return { ...local, ...stop, customerCode: code, customerName: stop.customerName || stop.name || local.customerName || "", address: stop.address || local.address || "", lat: numberOrNull(stop.lat) ?? local.lat ?? null, lng: numberOrNull(stop.lng) ?? local.lng ?? null, order: Number(stop.order || stop.sequence || stop.stopOrder || stop.savedOrder) || null, vehicle: normalizeVehicle(vehicle) };
  }

  function normalizeRouteStop(stop, vehicle) {
    const row = resolveRouteStop(stop, vehicle);
    const status = String(stop.status || "").trim().toUpperCase();
    const completed = status === "COMPLETED" || status === "DELIVERED" || stop.completed === true;
    return { ...row, status: completed ? "COMPLETED" : "PENDING", actualCompletedAt: completed ? (stop.actualCompletedAt || stop.completedAt || null) : null, isEstimated: !completed };
  }

  function dedupeRouteStops(rows) {
    const unique = new Map();
    rows.forEach((row, index) => {
      const key = row.customerCode ? `C:${row.customerCode}` : Number.isFinite(row.lat) && Number.isFinite(row.lng) ? `P:${row.lat.toFixed(6)},${row.lng.toFixed(6)}` : `R:${index}`;
      const old = unique.get(key);
      if (!old || (old.status !== "COMPLETED" && row.status === "COMPLETED")) unique.set(key, row);
    });
    return [...unique.values()].sort((a, b) => (Number(a.order) || 999999) - (Number(b.order) || 999999));
  }

  function renderRouteSummary(payload, source) {
    const connectionLabel = osanRoadVehicle() ? '저장된 착순 도로경로 예상 · 배송 작업시간·GPS 실주행과 별개' : '완료/잔여 착지 연결선 · 실제 도로 경로 아님';
    const html = `<div class="routeMode"><span class="routeDot"></span>${esc(state.selectedDate)} 운행 상세</div><div class="routeSummary"><div class="routeMetric"><strong>${payload.totalStops || 0}</strong><small>총 착지</small></div><div class="routeMetric"><strong>${payload.completedStops || 0}</strong><small>완료</small></div><div class="routeMetric"><strong>${payload.remainingStops || 0}</strong><small>잔여</small></div></div><div class="resultMeta">${connectionLabel}</div><details><summary>착순·완료시각 ${payload.stops?.length || 0}건</summary>${(payload.stops || []).map((stop) => `<div class="judgeCard">${esc(stop.order || stop.sequence || "-")}착 · ${esc(stop.customerName || stop.name || stop.customerCode)}<br>${stop.status === "COMPLETED" || stop.appRecorded ? `완료 ${esc(formatTime(stop.actualCompletedAt || stop.deliveryCompletedAt || stop.completedAt) || "시각 미기록")}` : "미완료"}</div>`).join("")}</details>`;
    (source === "mobile" ? $("#mobileRouteSummary") : $("#routeSummary")).innerHTML = html;
  }

  function setRouteLoading(source, message) {
    if (source === "mobile") {
      if (message) $("#mobileRouteSummary").textContent = message;
      return;
    }
    $("#loadingNotice").textContent = message;
    $("#loadingNotice").classList.toggle("show", Boolean(message));
  }

  function endRoute() {
    changePeriod(state.rangeStart, state.rangeEnd);
  }

  function syncBoundaryButtons() {
    if(window.MapTerritoryUi)return;
    [$("#areaToggle"), $("#mobileAreaToggle")].forEach((button) => {
      if (!button) return;
      button.classList.toggle("on", state.areaOn);
      button.textContent = state.areaOn ? "권역선 ON" : "권역선 OFF";
      button.setAttribute("aria-pressed", String(state.areaOn));
    });
  }

  function rerenderCurrentMap() {
    renderStops(state.currentRows, { numbered: state.mode === "DATE_ROUTE", boundaries: state.areaOn, vehicles: selectedVehicles() });
    if (state.mode === "DATE_ROUTE") drawRoute(state.routeRows);
  }

  function toggleBoundaries() {
    void window.MapTerritoryUi?.toggle();
  }

  function resetMapOverview() {
    cancelManualRoadRoute();
    setSelectedVehicles([]);
    periodVehicleScope = 'all'; periodSelectionCache = null; periodListLimit = 0;
    state.centerFilter = ''; state.driverKey = ''; selectedDriverKeys = [];
    $('#periodCenter').value = 'all';
    [...$('#periodDriver').options].forEach(option => { option.selected = option.value === ''; });
    $$('.vehicleItem').forEach(item => { item.style.display = 'flex'; });
    $$('[data-source-center]').forEach(button => button.classList.remove('active'));
    $("#mobileBaseVehicle").value = "";
    $("#mobileCenter").value = "all";
    state.routeRows = [];
    document.body.classList.remove("routeSheetOpen");
    clearSelection();
    refreshVehicleUi(false);
    requestMapFit();
    loadBaseMap();
  }

  function selectCenter(group) {
    ++state.searchRequestId; ++state.addressRequestId; ++state.detailRequestId;
    $('#results').replaceChildren();$('#addressJudgeResults').replaceChildren();
    setSelectedVehicles([]);state.driverKey='';$('#periodDriver').value='';periodVehicleScope='all';periodListLimit=0;periodSelectionCache=null;
    clearSelection();
    state.centerFilter = group === "all" ? "" : group;
    $('#periodCenter').value=group;$('#mobileCenter').value=group;
    $$(".vehicleItem").forEach((item) => { item.style.display = group === "all" || item.dataset.group === group ? "flex" : "none"; });
    $("#mobileBaseVehicle").value = "";
    refreshVehicleUi(true);
  }

  function comparisonStores() {
    if (!periodMeta?.complete || periodMeta.startDate !== state.rangeStart || periodMeta.endDate !== state.rangeEnd) return [];
    return periodRows.map(row => ({...row,
      lat:numberOrNull(row.lat)??coordinateByCode.get(row.customerCode)?.lat,
      lng:numberOrNull(row.lng)??coordinateByCode.get(row.customerCode)?.lng,
      vehicle:baseVehicles.get(row.customerCode)?.baseVehicle||''}));
  }
  function nearestStores(point, limit = 8) {
    return comparisonStores().map((row) => ({ ...row, distance: distanceKm(point, row) })).filter((row) => Number.isFinite(row.distance)).sort((a, b) => a.distance - b.distance).slice(0, limit);
  }

  function withinRadius(point, radiusKm) {
    return comparisonStores().map((row) => ({ ...row, distance: distanceKm(point, row) })).filter((row) => Number.isFinite(row.distance) && row.distance <= radiusKm).sort((a, b) => a.distance - b.distance);
  }

  function normalizePattern(pattern) {
    const text = String(pattern || "").replace(/\s+/g, "");
    return ["월", "화", "수", "목", "금", "토", "일"].filter((day) => text.includes(day)).join("");
  }

  function combineNearbyPatterns(rows) {
    const patterns = rows.map((row) => normalizePattern(row.deliveryPattern)).filter(Boolean);
    if (patterns.includes("월화수목금토")) return "";
    return ["월", "화", "수", "목", "금", "토", "일"].filter((day) => patterns.some((pattern) => pattern.includes(day))).join("");
  }

  function facilityReview(text) { return /(백화점|대형마트|쇼핑몰|복합몰|아울렛|몰\b|지하\s*(주차장|하역장|하역)|차량\s*(높이|진입)|탑차)/i.test(String(text || "")); }

  function apartmentUnitReason(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return "";
    const commercial = /(상가|상가동|근린생활|근생|몰|타워|빌딩|프라자|센터|법조|테크노|지식산업|백화점|시장|마트|아울렛|스퀘어|플라자|지하)/i;
    const apartment = /(아파트|APT|맨션|주공|e편한세상|이편한세상|자이|래미안|힐스테이트|푸르지오|더샵|롯데캐슬|아이파크|우미린|두산위브|반도유보라|센트럴파크|오피스텔)/i;
    const explicitDongHo = /(^|[^\dA-Za-z가-힣])(?:[A-Za-z]|\d{1,4})\s*동\s*\d{1,4}\s*호(?=$|[^\d가-힣])/;
    const attachedDongHo = /(^|[^\dA-Za-z가-힣])(?:[A-Za-z]|\d{1,4})\s*동\s*\d{2,4}(?=$|[^\d가-힣])/;
    const hyphenDongHo = /(^|[^\d])\d{1,4}\s*[-\/]\s*\d{2,4}(?=$|[^\d가-힣])/;
    if ((hyphenDongHo.test(value) || explicitDongHo.test(value) || attachedDongHo.test(value)) && apartment.test(value)) return "아파트";
    if (commercial.test(value)) return "";
    return (explicitDongHo.test(value) || attachedDongHo.test(value)) ? "아파트" : "";
  }

  function legacyException(text) {
    const value = String(text || "");
    if (MapPeriodUi.regionForAddress(value)==='제주도') return "제주도";
    if (apartmentUnitReason(value)) return "아파트";
    if (/동선외|배송동선\s*맞지/.test(value)) return "배송동선 맞지않음";
    return "";
  }

  function parseNewArea(inputId) {
    return MapPeriodUi.parseAreaInput($(inputId).value);
  }

  function validNewAreaInput(value) {
    const text = String(value || "").trim();
    if (/^[SB]\d{3,}$/i.test(text)) return true;
    if (text.length < 5) return false;
    return /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|충북|충남|전라|전북|전남|경상|경북|경남|제주|(?:로|길|동|읍|면)\s*\d|\d{1,4}[-번길로동읍면가])/i.test(text);
  }

  async function judgeNewAreaRow(row, signal) {
    if (row.inputAmbiguous) return {...row,decision:'검토',reason:'입력 열 확인 필요',evidence:'주소/고객명 열 또는 따옴표를 확인해 주세요.',nearby:[]};
    if (/^[SB]\d{3,}$/i.test(row.address.trim())) {
      const code=row.address.trim().toUpperCase(),store=storesByCode.get(code)||latestSnapshotRows.find(item=>(item.customerCode||item.code)===code);
      if (!store) return {...row,decision:'검토',reason:'고객코드 확인 필요',evidence:'기존 고객 조회에서 코드 미확인 · 코드 문자열 지오코딩 안 함',nearby:[]};
      row={...row,customerCode:code,address:store.address||row.address,customer:row.customer||store.customerName};
      if (numberOrNull(store.lat)!==null&&numberOrNull(store.lng)!==null) return judgeNewAreaPoint(row,{lat:Number(store.lat),lng:Number(store.lng)});
      if (!store.address) return {...row,decision:'검토',reason:'고객 주소·좌표 미확인',nearby:[]};
    }
    if (!validNewAreaInput(row.address) && !validNewAreaInput(row.customer)) return { ...row, decision: "검토", reason: "주소 확인 필요", deliveryDays: "", facility: false, nearby: [] };
    const point = await geocodeAddress(row.address, signal);
    return judgeNewAreaPoint(row, point);
  }

  function judgeNewAreaPoint(row, point) {
    const base = { ...row, ...point, rangeStart: state.rangeStart, rangeEnd: state.rangeEnd, decision: "검토", nearby: [], vehicle: "-", nearestDistance: null, facility: facilityReview(`${row.address} ${row.customer}`) };
    if (!point || point.candidates) return { ...base, reason: point?.candidates ? "주소 복수 후보" : "주소 확인 필요", evidence: point?.candidates ? "주소 후보를 먼저 확정해 주세요." : "지오코딩 결과 없음" };
    if (!periodMeta?.complete || periodMeta.startDate !== state.rangeStart || periodMeta.endDate !== state.rangeEnd) return { ...base, reason: "판단 보류", evidence: "기간 비교 데이터 미완료" };
    const nearby = withinRadius(point, .5);
    const references = Phase2bUi.nearbyVehicles(point, comparisonStores(), 30);
    const exception = legacyException(`${row.address} ${row.customer}`);
    const limits=[periodMeta.missingCoordinate>0?'비교 원천 좌표 누락':null,periodMeta.coverageComplete!==true?'전체 원천 완전성 미검증':null].filter(Boolean);
    const nearest=nearestStores(point,1)[0];
    const facts={...base,nearby,evidenceCount:nearby.length,dataLimits:limits.join(' · '),deliveryDays:combineNearbyPatterns(nearby),vehicle:nearby[0]?.vehicle||'-',nearestStore:nearest?.customerName||'',nearestDistance:nearest?.distance??null};
    if(exception)return {...facts,decision:'X',reason:exception,evidence:'기존 지역/시설 업무 제외 규칙'};
    if(base.facility)return {...facts,reason:'차량 진입 확인 필요',evidence:nearby.length?'500m 내 기존 배송점 확인 · 시설 진입 별도 확인':'시설 진입 확인 전 확정 불가'};
    if(nearby.length)return {...facts,decision:'O',reason:'',evidence:'500m 내 기존 배송점 확인 · 직선/공간거리 기준'};
    if(limits.length)return {...facts,reason:!references.length?'해당 센터 비교자료 부족':'검토필요',evidence:limits.join(' · ')+' · 인근 배송점 부재 확정 불가'};
    return {...facts,decision:'X',reason:'배송동선 맞지 않음',evidence:references.length?'검증된 비교 범위의 500m 내 배송점 없음':'검증된 비교 범위의 30km 내 배송점 없음 · 도로 진입 판정 아님'};
  }

  let newAreaRequestId = 0;
  let newAreaBusy = false, batchController = null, addressController = null;
  function cancelAddressLookup() {
    ++state.addressRequestId;
    if (addressController) setSearchState('주소 조회 취소');
    addressController?.abort(); addressController = null;
    $('#addressJudgeResults').textContent = '';
    $('#searchNotice').classList.remove('show');
  }
  function setNewAreaBusy(value) {
    newAreaBusy = value;
    $('#judgeNewAreaBatch').disabled = value;
    $('#newAreaBatchResults').setAttribute('aria-busy', String(value));
  }
  function cancelNewAreaWork() {
    cancelAddressLookup();
    if (newAreaBusy) { clearNewAreaBatch(false); $('#newAreaBatchStatus').textContent = '조회 취소 · 입력 유지'; }
  }
  function clearNewAreaBatch(clearInput = true) {
    ++newAreaRequestId;
    batchController?.abort(); batchController = null;
    setNewAreaBusy(false);
    cancelAddressLookup();
    if (state.virtual) { state.virtual = null; clearSelection(); renderStops(state.currentRows); }
    state.newAreaResults = [];
    if (clearInput) $("#newAreaBatchInput").value = "";
    $("#newAreaBatchResults").innerHTML = "";
    $("#newAreaBatchStatus").textContent = "입력 0 · 완료 0";
    $("#exportNewAreaCsv").disabled = true;
    $("#exportNewAreaExcel").disabled = true;
    $('#copyAreaDecision')?.setAttribute('disabled','');$('#copyAreaMatching')?.setAttribute('disabled','');
  }

  async function runNewArea(inputId, statusId, resultId) {
    if (newAreaBusy) return;
    clearNewAreaBatch(false);
    const requestId = newAreaRequestId;
    if (!dateReady || !periodMeta?.complete || periodMeta.startDate !== state.rangeStart || periodMeta.endDate !== state.rangeEnd || state.mode !== "BASE_60D") { $(statusId).textContent = "기간 비교 데이터 미완료 · 판단 보류"; return; }
    const periodKey = state.rangeStart + "|" + state.rangeEnd;
    const rows = parseNewArea(inputId);
    if (!rows.length) { $(statusId).textContent = "주소를 입력해주세요."; return; }
    batchController = new AbortController();
    const signal = batchController.signal;
    setNewAreaBusy(true);
    $(statusId).textContent = `${rows.length}건 판단 중...`;
    const judged = [];
    for (const row of rows) {
      try { judged.push(await judgeNewAreaRow(row, signal)); }
      catch (error) {
        if (requestId !== newAreaRequestId || isSilentRequestError(error)) return;
        judged.push({...row,decision:'검토',reason:'조회 실패 · 검토필요',evidence:NewAreaRequests.message(error)+' · 원문 보존',lookupError:true,nearby:[]});
      }
      if (requestId !== newAreaRequestId || periodKey !== state.rangeStart + "|" + state.rangeEnd || state.mode !== "BASE_60D") return;
      $(statusId).textContent = `입력 ${rows.length} · 완료 ${judged.length}`;
    }
    state.newAreaResults = judged;
    setNewAreaBusy(false); batchController = null;
    $("#exportNewAreaCsv").disabled = !judged.length;
    $("#exportNewAreaExcel").disabled = !judged.length;
    if(judged.length){$('#copyAreaDecision')?.removeAttribute('disabled');$('#copyAreaMatching')?.removeAttribute('disabled');}
    $(statusId).textContent = `입력 ${rows.length} · 완료 ${judged.length} · 권역 내 ${judged.filter((r) => r.decision === "O").length} · 동선 없음 ${judged.filter((r) => r.reason === "배송동선 맞지 않음").length} · 확인 필요 ${judged.filter((r) => r.decision !== "O" && r.reason !== "배송동선 맞지 않음").length}`;
    $(resultId).innerHTML = judged.map((row, index) => `<button class="judgeCard batchResult" data-judged="${index}"><div class="judgeTop"><span class="judgeBadge ${row.decision === "O" ? "ok" : "no"}">${row.decision === "O" ? "권역 가능" : esc(row.reason || "판단 보류")}</span><b>${esc(row.customer || row.address)}</b></div><div>사용 주소: ${esc(row.address)}</div><div>${esc(row.evidence || "")} · ${esc(vehicleLabel(row.vehicle))} ${row.nearestDistance == null ? "" : formatDistance(row.nearestDistance)}</div><div>${esc(row.rangeStart || state.rangeStart)} ~ ${esc(row.rangeEnd || state.rangeEnd)}${Number.isFinite(row.evidenceCount) ? ` · 500m 근거 ${row.evidenceCount}개` : ''}</div><div>${esc(row.dataLimits || '')}</div><div>${esc(row.deliveryDays || "")}${row.facility ? " · 차량 진입 확인 필요" : ""}</div></button>`).join("");
    $$('[data-judged]').forEach((button) => button.onclick = () => {
      const row = judged[Number(button.dataset.judged)];
      if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) return;
      showVirtual({ ...row, customerName: row.customer || "신규 주소", customerCode: "", virtual: true });
      showNearbyReference(state.virtual);
      if (state.map) state.map.panTo(new kakao.maps.LatLng(row.lat, row.lng));
    });
  }

  function distanceKm(a, b) {
    if ([a.lat, a.lng, b.lat, b.lng].some((value) => value == null || value === "")) return Infinity;
    const lat1 = Number(a.lat), lng1 = Number(a.lng), lat2 = Number(b.lat), lng2 = Number(b.lng);
    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return NaN;
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLng = (lng2 - lng1) * rad;
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
  }

  function formatDistance(value) { return Number.isFinite(Number(value)) ? `${Number(value).toFixed(Number(value) < 1 ? 2 : 1)}km` : "-"; }
  function normalizeVehicle(value) { return String(value || "").trim().replace(/호(?:차)?$/, ""); }
  function localDate() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date()); }
  function formatTime(value) { if (!value) return ""; const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(date); }
  function formatShort(value) { const date = new Date(`${value}T00:00:00`); return `${String(date.getMonth() + 1).padStart(2, "0")}월 ${String(date.getDate()).padStart(2, "0")}일`; }
  function daysBefore(value, count) { const date = new Date(`${value}T00:00:00`); date.setDate(date.getDate() - count); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
  function esc(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
  function setSearchState(text, spin) { $("#searchState").innerHTML = spin ? `<span class="loading"><span class="spinner"></span>${esc(text)}</span>` : esc(text); }
  function searchFailureMessage(errors) {
    return errors.some(error => Number(error.status) >= 500)
      ? "검색 서버 오류 · 잠시 후 다시 시도해주세요. 현재 지도 유지"
      : "검색 요청 실패 · 연결 상태를 확인하고 다시 시도해주세요. 현재 지도 유지";
  }
  function isSilentRequestError(error) { return Boolean(error?.silent || error?.name === "AbortError"); }
  async function fetchJson(url, options = {}) {
    const { channel = new URL(url, location.href).pathname, timeout = 30000, ttl = 0 } = options;
    const previous = requestControllers.get(channel);
    if (previous) previous.controller.abort("superseded");
    const cached = memoryResponses.get(url);
    if (ttl && cached?.expiresAt > Date.now()) { requestControllers.delete(channel); return cached.value; }
    const controller = new AbortController();
    const token = Symbol(channel);
    requestControllers.set(channel, { controller, token });
    const timer = setTimeout(() => controller.abort("timeout"), timeout);
    const started = performance.now();
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers: options.headers, method:options.method,body:options.body });
      const json = await response.json();
      apiDiagnostics.set(new URL(url, location.href).pathname.split("/").pop(), { ms: Math.round(performance.now() - started), status: response.status, cache: response.headers.get("X-Phase2B-Cache") || "미제공" });
      if (requestControllers.get(channel)?.token !== token) { const stale = new Error("STALE_RESPONSE"); stale.silent = true; throw stale; }
      if (!response.ok || json.error) throw Object.assign(new Error(json.error || `HTTP_${response.status}`), { status: response.status });
      if (ttl) {
        for(const [key,value] of memoryResponses)if(value.expiresAt<=Date.now())memoryResponses.delete(key);
        memoryResponses.delete(url);while(memoryResponses.size>=32)memoryResponses.delete(memoryResponses.keys().next().value);
        memoryResponses.set(url, { value: json, expiresAt: Date.now() + ttl });
      }
      return json;
    } catch (error) {
      throw Phase2bUi.requestError(error, { stale: requestControllers.get(channel)?.token !== token,
        aborted: controller.signal.aborted, reason: controller.signal.reason });
    } finally {
      clearTimeout(timer);
      if (requestControllers.get(channel)?.token === token) requestControllers.delete(channel);
    }
  }
  function showMobileMap() {
    if (innerWidth > 760) return;
    const wasOpen = document.body.classList.contains("mobileMap");
    document.body.classList.add("mobileMap");
    if (wasOpen) return;
    setTimeout(() => {
      state.map?.relayout?.();
      positionDetailPopup();
    }, 60);
  }
  function hideMobileMap() { document.body.classList.remove("mobileMap", "routeSheetOpen"); }

  async function loadTodayStatus() {
    return loadOperationStatus(primarySelectedVehicle());
  }

  function updateOperationMetrics(row) {
    $("#opTotal").textContent = row?.totalStops ?? "-";
    $("#opCompleted").textContent = row?.completedStops ?? "-";
    $("#opRemaining").textContent = row?.remainingStops ?? "-";
    $("#opEta").textContent = state.selectedDate === localDate() ? formatTime(row?.estimatedEndAt) || "산출 대기" : "과거 —";
  }

  async function loadOperationStatus(vehicle, showRoute = false, representative = {}, refresh = false) {
    if (state.mode !== "DATE_ROUTE") return;
    if(hasDatedDriverFilter()){updateOperationMetrics(null);$('#opTotal').textContent=operationStops.length;$('#mapStatusSub').textContent=state.selectedDate+' · 선택 기사 해당일 근거 '+operationStops.length+'착지 · 기사 미확인 제외 · 도로 경로 미조회';return;}
    if (!/^\d{4}-\d{2}-\d{2}$/.test(state.selectedDate) || !vehicle) return;
    cancelManualRoadRoute();
    const date = state.selectedDate;
    const filterIdentity=queryFilterIdentity();
    const requestId = ++state.todayRequestId;
    const current = date === localDate();
    const url = current ? `/api/map-phase2b/preview/today-status?date=${date}` : `/api/map-phase2b/preview/route-plan?date=${date}&vehicle=${encodeURIComponent(vehicle)}`;
    if (refresh) memoryResponses.delete(url);
    $("#syncOperation").disabled = true;
    try {
      const payload = await fetchJson(url, { channel: "operation-status", ttl: 30000, timeout: 45000 });
      if (requestId !== state.todayRequestId || date !== state.selectedDate || state.mode !== "DATE_ROUTE" || filterIdentity!==queryFilterIdentity()) return;
      const status = current ? payload.data?.vehicles?.find((row) => normalizeVehicle(row.vehicle) === vehicle) : payload.data;
      if (current && refresh && snapshotMeta?.reviewOnly!==true && window.MAP_ROLLING_DATE_INDEX_ENABLED!==true) {
        const byCode = new Map(allStores.map((row) => [row.customerCode, row]));
        (payload.data?.vehicles || []).forEach((item) => (item.stops || []).forEach((stop) => {
          const code = String(stop.customerCode || stop.code || "");
          if (!code) return;
          const known = byCode.get(code) || {};
          byCode.set(code, { ...known, ...stop, customerCode: code, vehicle: item.vehicle, lat: stop.lat ?? known.lat, lng: stop.lng ?? known.lng, lastDeliveryDate: date });
        }));
        replaceStoreSnapshot([...byCode.values()], snapshotMeta);
        if (!showRoute) { state.fitRequested = false; await loadBaseMap(); }
      }
      updateOperationMetrics(status);
      lastRefreshedAt = current ? payload.data?.fetchedAt || '' : new Date().toISOString();
      if (showRoute && status) {
        const stops = filteredDateStores(dedupeRouteStops((status.stops || []).map((stop) => normalizeRouteStop(current ? { ...stop, status: stop.appRecorded ? "COMPLETED" : "PENDING", actualCompletedAt: stop.deliveryCompletedAt } : stop, vehicle))));
        operationStops = stops; renderRunList();
        state.mode = "DATE_ROUTE";
        state.routeRows = stops.filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
        renderStops(state.routeRows, { numbered: true, vehicles: [vehicle] });
        drawRoute(state.routeRows);
        renderRouteSummary(status, innerWidth <= 760 ? "mobile" : "pc");
        loadRoadRoute(vehicle);
        $("#mapStatusTitle").textContent = `${vehicleLabel(vehicle)} 운행현황`;
        $("#mapStatusSub").textContent = `${date} · ${current ? "Delivery 현재상태" : "Hub 과거 완료기록"}`;
      } else if (showRoute && !status) {
        operationStops = []; state.routeRows = []; renderRunList();
        loadRoadRoute(vehicle);
      }
    } catch (error) {
      if (isSilentRequestError(error) || requestId !== state.todayRequestId || date !== state.selectedDate || state.mode !== "DATE_ROUTE" || filterIdentity!==queryFilterIdentity()) return;
      updateOperationMetrics(null);
      operationStops = []; renderRunList();
      $("#runList").textContent = "운행 목록을 불러오지 못했습니다. 상단 동기화로 재시도해주세요.";
      resetRoadRoute();
      $("#mapStatusSub").textContent = `운행현황 조회 실패 · ${error.message}${lastRefreshedAt ? ' · 마지막 확인 시각 ' + lastRefreshedAt : ''}`;
    } finally {
      if (requestId === state.todayRequestId) $("#syncOperation").disabled = false;
    }
  }

  async function refreshSelectedDate() {
    if (state.mode === "BASE_60D") { periodMeta = null; return changePeriod(state.rangeStart, state.rangeEnd); }
    if (!state.selectedDate) { await refreshStoreSnapshot(); return; }
    const date = state.selectedDate;
    const selected = primarySelectedVehicle();
    const routeOpen = state.mode === "DATE_ROUTE";
    const detail = state.selected;
    memoryResponses.delete(`/api/map-phase2b/preview/assignments?date=${date}`);
    memoryResponses.delete(`/api/map-phase2b/preview/today-status?date=${date}`);
    state.fitRequested = false;
    await changeSelectedDate(date);
    if (date !== state.selectedDate || !dateReady) return;
    await loadOperationStatus(selected, routeOpen, {}, true);
    if (detail) selectStore(storesByCode.get(detail.customerCode) || { ...detail, vehicle: "" }, null, false);
  }

  function exportNewArea(format) {
    if (!state.newAreaResults.length) { $("#newAreaBatchStatus").textContent = "먼저 일괄 판단을 실행해주세요."; return; }
    if(!$('#newAreaApplyDate').value){$('#newAreaBatchStatus').textContent='적용일을 선택해 주세요.';return;}
    if(format==='xlsx'&&!window.XLSX){$('#newAreaBatchStatus').textContent='Excel 내보내기 모듈이 연결되지 않았습니다. CSV 내보내기를 이용해 주세요.';return;}
    const headings=['주소(X)','고객정보(Y)','판단(BV)','사유(BW)','적용일자(BX)','센터/권역(BY)','추천호차','가까운 배송처','거리km'];
    const rows=MapPeriodUi.areaExportRows(state.newAreaResults,$('#newAreaApplyDate').value).map(values=>Object.fromEntries(headings.map((key,i)=>[key,values[i]])));
    if (format === "xlsx" && window.XLSX) {
      const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), "신규권역판정"); XLSX.writeFile(book, "신규권역판정.xlsx"); return;
    }
    const columns = Object.keys(rows[0]);
    const csv = [columns, ...rows.map((row) => columns.map((column) => row[column]))].map((line) => line.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" })); link.download = "신규권역판정.csv"; link.click(); URL.revokeObjectURL(link.href);
  }

  let periodViewState = "loading";
  function setPeriodViewState(value) {
    periodViewState = value;
    $("#periodStoreList").setAttribute("data-state", value);
    $("#periodStoreList").setAttribute("aria-busy", String(value === "loading"));
    $("#periodIdentity").setAttribute("role", "status");
    if (["loading", "not-ready", "error"].includes(value)) $("#mapStatusSub").textContent = "조회 완료 전 · 이전 지도 유지 (선택 기간 결과 아님)";
  }
  function renderPeriodStoreList(rows = state.currentRows) {
    const panel = $("#periodStoreList"); if (!panel) return;
    if (state.mode === "BASE_60D" && !dateReady) {
      if (periodViewState === "out-of-range") {
        $("#periodStoreListCount").textContent = "범위 밖";
        panel.innerHTML = '<p class="notice show">조회 가능한 기간 범위 밖입니다. 조회 기간을 변경해 주세요.</p>';
        $("#periodListMore").hidden = true; return;
      }
      $("#periodStoreListCount").textContent = periodViewState === "loading" ? "조회 중" : periodViewState === "error" ? "미확인" : "준비 중";
      panel.innerHTML = `<p class="hint" role="status">${periodViewState === "loading" ? "기간 이력 조회 중입니다." : periodViewState === "error" ? "기간 조회 실패 · 매장 수 미확인" : "기간 이력이 아직 준비되지 않았습니다. 빈 결과가 아닙니다."} 이전 지도는 유지되며 선택 기간의 결과가 아닙니다.</p>`;
      $("#periodListMore").hidden = true; return;
    }
    const stores = rows.filter(row => !row.virtual);
    if (generalAllStores && snapshotReadState === 'error') {
      $('#periodStoreListCount').textContent = '전체 수 미확인';
      panel.textContent = '전체 매장 원천 조회 실패 · 기존 지도 유지. 최근 90일 버튼으로 다시 조회해 주세요.';
      $('#periodListMore').hidden = true; return;
    }
    if(!stores.length&&state.centerFilter&&baseVehicleStatus!=='READY'){
      $('#periodStoreListCount').textContent='미확인';panel.textContent=baseVehicleStatus==='ERROR'?'기준호차 조회 실패 · 센터 매장 수 확인 필요':'기준호차 확인 중 · 센터 매장 수 미확인';$('#periodListMore').hidden=true;return;
    }
    const visibleStores = periodListLimit ? stores.slice(Math.max(0,periodListLimit-100),periodListLimit) : state.selected && !state.selected.virtual ? [state.selected] : [];
    $("#periodStoreListCount").textContent = stores.length + "개 매장";
    panel.innerHTML = visibleStores.map(row => `<button class="resultItem periodStore${state.selected?.customerCode === row.customerCode ? " selected" : ""}" aria-pressed="${state.selected?.customerCode === row.customerCode}" data-period-store="${esc(row.customerCode)}"><span class="periodCode">${esc(row.customerCode)}</span><b>${esc(row.customerName || row.customerCode)}</b><span>${esc(row.lastDeliveryDate || "")} · ${esc(vehicleLabel(row.vehicle))}</span><span>${esc(row.driverName || "기사 미등록")} · ${row.visitCount===null?'방문횟수 미확인':(row.visitCount??row.history?.length??0)+'회'}</span></button>`).join("") || `<p class="hint">${stores.length ? '검색하거나 지도 핀을 선택하세요. 전체 목록은 요청할 때만 표시합니다.' : '조회 조건에 맞는 매장이 없습니다.'}</p>`;
    $("#periodListMore").hidden = !periodListLimit || stores.length <= periodListLimit;
    const toggle=$('#togglePeriodList');if(toggle){toggle.textContent=periodListLimit?'접기':'펼치기';toggle.setAttribute('aria-expanded',String(!!periodListLimit));}
    $("#periodListMore").textContent = periodListLimit ? '다음 100개 매장' : '목록 보기 (100개씩)';
    $$("[data-period-store]").forEach(button => button.onclick = () => { const row = stores.find(item => item.customerCode === button.dataset.periodStore); if (row) selectStore(row, null, true); });
  }

  function bindEvents() {
    $("#modePeriod").onclick = () => initializeGeneral();
    $("#modeDaily").onclick = () => { dateChosenByUser = true; state.routeDate ? changeSelectedDate(state.routeDate) : selectLatestRoute(); };
    $("#applyPeriod").onclick = () => { if(state.mode!=="BASE_60D")return;recentPeriodMode=false; return changePeriod($("#rangeStart").value, $("#rangeEnd").value); };
    $("#recent60").onclick = () => {if(state.mode==="BASE_60D")return initializePeriod();};
    ["#rangeStart", "#rangeEnd"].forEach(id => { $(id).oninput = syncDateHeading; });
    $("#periodDriver").onchange = event => { if(state.mode!=="BASE_60D")return;selectedDriverKeys=[...event.target.selectedOptions].map(option=>option.value).filter(Boolean);state.driverKey=selectedDriverKeys[0]||'';clearSelection();periodListLimit=0;requestMapFit();loadBaseMap(); };
    $$('input[name="periodBasis"]').forEach(input => input.onchange = () => { if(state.mode!=='BASE_60D')return;periodBasis = input.value; syncPeriodBasis(); clearSelection(); periodListLimit = 0; requestMapFit(); loadBaseMap(); });
    $("#periodListMore").onclick = () => { periodListLimit += 100; renderPeriodStoreList(); };
    $('#togglePeriodList').onclick=()=>{periodListLimit=periodListLimit?0:100;renderPeriodStoreList();};
    $("#staffLogout").onclick = () => window.MapStaffEntry?.logout();
    $("#toggleRunList").onclick = () => { $("#runListTool").open = !$("#runListTool").open; if (innerWidth <= 760) activateSheet("runs"); };
    $("#vehicleTrigger").onclick = () => $("#vehicleSelect").classList.toggle("open");
    document.addEventListener("click", (event) => { if (!$("#vehicleSelect").contains(event.target)) $("#vehicleSelect").classList.remove("open"); });
    $("#vehicleQuery").oninput = (event) => { $$(".vehicleItem").forEach((item) => { item.style.display = Phase2bUi.vehicleMatches(event.target.value,item.querySelector("input").value) ? "flex" : "none"; }); };
    $("#vehicleQuery").onkeydown = (event) => {
      if (event.key !== "Enter") return;
      const first = $$(".vehicleItem").find((item) => item.style.display !== "none");
      if (!first) return;
      setSelectedVehicles([first.querySelector("input").value]); periodVehicleScope = "selected"; state.centerFilter = ""; $("#vehicleSelect").classList.remove("open"); refreshVehicleUi(true);
    };
    $("#selectAllVehicles").onclick = () => { state.centerFilter = ""; $("#periodCenter").value = "all"; setSelectedVehicles([]); periodVehicleScope = "all"; refreshVehicleUi(true); };
    $("#clearVehicles").onclick = () => { setSelectedVehicles([]); periodVehicleScope = "selected"; $("#mobileBaseVehicle").value = ""; $("#vehicleSelect").classList.remove("open"); clearSelection(); refreshVehicleUi(false); state.fitRequested = false; loadBaseMap(); };
    $$("[data-center]").forEach((button) => { button.onclick = () => { selectCenter(button.dataset.center); $("#vehicleSelect").classList.remove("open"); }; });
    let composing = false;
    $("#query").oncompositionstart = () => { composing = true; };
    $("#query").oncompositionend = () => { composing = false; };
    $("#query").onkeydown = (event) => { if (event.key === "Enter" && !composing && !event.isComposing) search(); };
    $("#searchBtn").onclick = search;
    let addressComposing = false;
    $("#addressQuery").oncompositionstart = () => { addressComposing = true; };
    $("#addressQuery").oncompositionend = () => { addressComposing = false; };
    const runAddress = () => { const text = $("#addressQuery").value.trim(); if (text) searchExternalAddress(text); };
    $("#addressBtn").onclick = runAddress;
    $("#addressQuery").onkeydown = (event) => { if (event.key === "Enter" && !addressComposing && !event.isComposing) runAddress(); };
    $("#todayBtn").onclick = selectLatestRoute;
    ["#date", "#mobileDate", "#selectedDate"].forEach((id) => { $(id).onchange = (event) => { dateChosenByUser = true; changeSelectedDate(event.target.value); }; });
    $("#operationVehicle").onchange = (event) => { const vehicle = event.target.value; setSelectedVehicles([vehicle]); $("#vehicle").value = vehicle; $("#mobileVehicle").value = vehicle; refreshVehicleUi(true); };
    $("#syncOperation").onclick = () => {if(state.mode==="DATE_ROUTE")return refreshSelectedDate();};
    $("#routePlan").onclick = () => loadRoute("pc");
    $("#endRoute").onclick = endRoute;
    $("#areaToggle").onclick = () => {if(state.mode==="BASE_60D")return toggleBoundaries();};
    $("#mapReset").onclick = resetMapOverview;
    $("#mobileAreaToggle").onclick = toggleBoundaries;
    $("#mobileMapReset").onclick = resetMapOverview;
    $("#mobileCenter").onchange = (event) => selectCenter(event.target.value);
    $("#mobileBaseVehicle").onchange = (event) => { state.centerFilter = ""; periodVehicleScope = event.target.value ? "selected" : "all"; setSelectedVehicles(event.target.value ? [event.target.value] : []); $("#mobileCenter").value = "all"; refreshVehicleUi(true); };
    $("#judgeNewAreaBatch").onclick = () => runNewArea("#newAreaBatchInput", "#newAreaBatchStatus", "#newAreaBatchResults");
    $("#clearNewAreaBatch").onclick = () => clearNewAreaBatch();
    $('#cancelNewAreaBatch').onclick = () => { clearNewAreaBatch(false); $('#newAreaBatchStatus').textContent = '조회 취소 · 입력 유지'; };
    $('#newAreaBatchTool').addEventListener('toggle', event => { if (!event.target.open) cancelNewAreaWork(); });
    $('#newAreaBatchTool > summary').addEventListener('click', () => { if ($('#newAreaBatchTool').open) cancelNewAreaWork(); });
    $('#newAreaBatchInput').oninput = () => { if (newAreaBusy || state.newAreaResults.length) clearNewAreaBatch(false); };
    $("#exportNewAreaCsv").onclick = () => exportNewArea("csv");
    $("#exportNewAreaExcel").onclick = () => exportNewArea("xlsx");
    for(const [id,kind] of [['#copyAreaDecision','decision'],['#copyAreaMatching','matching']])$(id).onclick=async()=>{
      if(!state.newAreaResults.length)return;
      if(!$('#newAreaApplyDate').value){$('#newAreaBatchStatus').textContent='적용일을 선택해 주세요.';return;}
      try{await navigator.clipboard.writeText(MapPeriodUi.areaTsv(state.newAreaResults,$('#newAreaApplyDate').value,kind));$('#newAreaBatchStatus').textContent=`${state.newAreaResults.length}행 · ${kind==='decision'?'BV:BY 4열':'BJ:BK 2열'} 복사 완료`;}
      catch{$('#newAreaBatchStatus').textContent='클립보드 권한을 확인해 주세요. 결과 Excel 내보내기도 사용할 수 있습니다.';}
    };
    $("#todayStatusTool")?.addEventListener("toggle", (event) => { if (event.target.open) loadTodayStatus(); });
    $("#mobileBack").onclick = hideMobileMap;
    $("#closeMobileRoute").onclick = () => document.body.classList.remove("routeSheetOpen");
    $("#mobileToday").onclick = selectLatestRoute;
    $("#mobileRoutePlan").onclick = () => loadRoute("mobile");
    $("#openOperations").onclick = showDiagnostics;
    $$('[data-run-filter]').forEach((button) => button.onclick = () => { runFilter = button.dataset.runFilter; renderRunList(); });
    $$('[data-sheet-tab]').forEach((button) => button.onclick = () => activateSheet(button.dataset.sheetTab));
    $("#sheetExpand").onclick = () => { if ($("#mobileWorkspace").classList.contains("collapsed")) $("#mobileWorkspace").classList.remove("collapsed"); else $("#mobileWorkspace").classList.toggle("expanded"); };
    window.addEventListener("resize", () => { if (innerWidth <= 760) showMobileMap(); else hideMobileMap(); activateSheet(); requestAnimationFrame(positionDetailPopup); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") {cancelManualRoadRoute(); cancelNewAreaWork(); clearSelection(); } });
  }

  function renderManualDraft(message = '도로거리·시간은 API 연결 전 미확인입니다.') {
    const stops = manualDraft.stops();
    $('#manualStops').innerHTML = stops.map((stop, i) => `<li><b>${i === 0 ? '출발' : i === stops.length - 1 ? '도착' : '경유 ' + i}</b> · ${esc(stop.label)}<div class="manualStopControls"><button data-manual-up="${stop.id}" ${i === 0 ? 'disabled' : ''} aria-label="${esc(stop.label)} 위로">↑</button><button data-manual-down="${stop.id}" ${i === stops.length - 1 ? 'disabled' : ''} aria-label="${esc(stop.label)} 아래로">↓</button><button data-manual-remove="${stop.id}">삭제</button></div></li>`).join('');
    $('#manualStatus').textContent = message;
    $$('[data-manual-up]').forEach(button => button.onclick = () => {cancelManualRoadRoute(); manualDraft.move(button.dataset.manualUp, -1); renderManualDraft(); });
    $$('[data-manual-down]').forEach(button => button.onclick = () => {cancelManualRoadRoute(); manualDraft.move(button.dataset.manualDown, 1); renderManualDraft(); });
    $$('[data-manual-remove]').forEach(button => button.onclick = () => {cancelManualRoadRoute(); manualDraft.remove(button.dataset.manualRemove); renderManualDraft(); });
  }
  function addManualPoint(point) {
    try {cancelManualRoadRoute(); manualDraft.add(point || {}); renderManualDraft(); }
    catch (error) { $('#manualStatus').textContent = error.message; }
  }
  initVehicles();
  const freshnessFields=document.createElement('div');
  freshnessFields.innerHTML='<div id="sourceCollectedAt" role="status">최신 원천 수집일: 미확인</div><div id="mapAppliedRange">현재 지도 반영기간: 미확인</div><div id="packageReadState" role="status"></div>';
  $('#leftPanel .fresh').append(freshnessFields);
  $('#recent60').textContent='최근 90일';
  $('#newAreaApplyDate').value=localDate();
  $('#leftPanel .head').append($('#mapDateBar'));
  for(const card of [$('#detailSection'),$('#staffAuxContent')])for(const type of ['click','dblclick','pointerdown','wheel','touchstart'])card.addEventListener(type,event=>event.stopPropagation(),{passive:true});
  if(window.MapDataSync)window.MapDataSync.onPublished=async status=>{
    if(window.MAP_ROLLING_DATE_INDEX_ENABLED===true&&!generalMap){
      const latest=await hybridUi?.refreshLatest();
      // Keep a manually chosen historical range pinned. Only the default recent
      // view follows a newly verified rolling publication, including corrections.
      if(state.mode==='BASE_60D'&&recentPeriodMode){const range=MapPeriodUi.recentRange(latest);if(range)await changePeriod(range.start,range.end);}
      return;
    }
    modelStatus=status;periodMeta=null;baseVehicleTries=0;
    if(generalMap){await initializeGeneral();return;}
    if(state.mode!=='BASE_60D')return;
    if(recentPeriodMode){const range=MapPeriodUi.recentRange(status);if(range)await changePeriod(range.start,range.end);}
    else await changePeriod(state.rangeStart,state.rangeEnd);
  };
  clearNewAreaBatch();
  syncModeUi();
  $("#runListTool").open = false;
  $("#mapModeBar").insertBefore($("#areaToggle"), $("#staffLogout"));
  ["Total", "Completed", "Remaining", "Eta"].forEach((name) => { $("#op" + name).parentNode.id = name.toLowerCase() + "Metric"; });
  $("#newAreaBatchTool > summary").textContent = "④ 신규권역 일괄조회";
  $('[data-sheet-tab="new"]').textContent = "신규권역";
  $(".addressBlock .label").hidden = true;
  $("#addressBtn").textContent = "위치 찾기";
  $(".addressBlock .hint").textContent = "임시핀 · 30km 주변 호차 확인 (공간거리)";
  $("#selectAllVehicles").textContent = "전체 호차"; $("#clearVehicles").textContent = "선택 해제";
  $("#legacyVehicleState").hidden = false; $("#legacyVehicleState").removeAttribute("aria-hidden");
  $("#vehicleTrigger").setAttribute("aria-label", "호차 선택");
  const sidebar = $("#leftPanel"), addressPanel = $(".addressBlock");
  const filters = document.createElement("section"); filters.id = "periodFilterPanel"; filters.className = "block";
  filters.innerHTML = '<div class="label">② 조회 기준</div><div class="periodBasis" role="group" aria-label="조회 기준"><label><input type="radio" name="periodBasis" value="vehicle" checked>호차 기준</label><label><input type="radio" name="periodBasis" value="driver">기사 기준</label></div>';
  filters.insertAdjacentHTML('beforeend', '<label id="allStoresControl"><input id="includeUnvisitedStores" type="checkbox" checked>기간 이력 없는 저장 매장도 표시</label>');
  $(".customerBlock").after(filters);
  filters.append($("#legacyVehicleState"), $("#periodDriver"));
  $('#periodDriver').multiple=true;
  filters.after($("#periodStoreListSection"));
  $("#periodStoreListSection").after($("#runListTool"));
  const periodCenter = $("#mobileCenter").cloneNode(true); periodCenter.id = "periodCenter";
  periodCenter.setAttribute("aria-label", "기간별 센터"); periodCenter.onchange = event => {if(state.mode==="BASE_60D")selectCenter(event.target.value);};
  filters.append(periodCenter);
  const newAreaTools = document.createElement("div"); newAreaTools.id = "newAreaTools";
  $("#results").before(addressPanel); newAreaTools.append($("#newAreaBatchTool"));
  $("#runListTool").after(newAreaTools);
  filters.after($('#manualRouteTool'));
  $('#manualRouteTool').after($('#periodStoreListSection'));
  $('#includeUnvisitedStores').onchange = event => { generalAllStores = event.target.checked; clearSelection(); loadBaseMap(); };
  $('#manualAddSelected').onclick = () => addManualPoint(state.selected || state.virtual);
  $('#manualAdd').onclick = () => {
    const lat = $('#manualLat').value.trim(), lng = $('#manualLng').value.trim();
    addManualPoint({ label: $('#manualLabel').value, lat: lat ? Number(lat) : null, lng: lng ? Number(lng) : null });
  };
  $('#manualClear').onclick = () => {cancelManualRoadRoute(); manualDraft.clear(); for (const id of ['manualLabel','manualLat','manualLng']) $('#' + id).value = ''; renderManualDraft('경유 입력을 초기화했습니다.'); };
  for(const id of ['manualLabel','manualLat','manualLng'])$('#'+id).addEventListener('input',cancelManualRoadRoute);
  $('#manualValidate').onclick = async () => {
    try {await queryManualRoadRoute();}
    catch (error) { $('#manualStatus').textContent = error.message; }
  };
  renderManualDraft();
  $("#vehicleSelect").after($("#selectAllVehicles"), $("#clearVehicles"));
  syncPeriodBasis();
  // Keep one set of panels: reparent for mobile instead of duplicating controls.
  activateSheet("stores");
  if (innerWidth <= 760) showMobileMap();
  bindEvents();
  // Local design shell uses the same controllers; it cannot authorize API calls.
  window.MapUiLocalBridge={
    state,
    isDataReady:()=>dateReady,
    initMap,
    stores:()=>allStores.slice(),
    fixedTerritoryMasterState:()=>({version:baseVehicleMeta?.version||null,stale:baseVehicleMeta?.stale!==false}),
    fixedTerritoryStores:()=>window.MapUiLocalBridge.navigationStores().map(row=>({...row,...(baseVehicles.get(String(row.customerCode))||{baseVehicle:'',baseVehicleState:'UNKNOWN'})})),
    loadBaseVehicleMasterForTerritory:()=>loadBaseVehicles(window.MapUiLocalBridge.navigationStores().map(row=>String(row.customerCode||''))),
    navigationStores:()=>{if(state.mode==='DATE_ROUTE')return filteredDateStores(allStores).map(row=>({...row}));const list=new Map(latestSnapshotRows.map(r=>[r.customerCode,r]));for(const row of allStores){const prior=list.get(row.customerCode);const conflict=prior&&row.address&&prior.address&&row.address.replace(/\s/g,'')!==prior.address.replace(/\s/g,'');list.set(row.customerCode,{...row,...(conflict?{coordinateStatus:'CONFLICT'}:{})});}return [...list.values()];},
    selectNavigationStore:code=>{const row=(state.mode==='DATE_ROUTE'?filteredDateStores(allStores):allStores).find(r=>r.customerCode===code)||(state.mode==='BASE_60D'?latestSnapshotRows.find(r=>r.customerCode===code):null);if(row)selectStore(row,null,true,true);},
    queryRecordedRoute:()=>{cancelManualRoadRoute();const v=primarySelectedVehicle();if(!v||!operationStops.length||operationStops.some(s=>!Number.isSafeInteger(s.order)||s.order<1)){roadResult={state:'error',error:'RECORDED_ORDER_REQUIRED'};window.dispatchEvent(new CustomEvent('map-recorded-route',{detail:roadResult}));syncRoadRoutePanel();return;}loadRoadRoute(v,{explicit:true});},
    toggleConnections:()=>{state.connectionLines=false;state.lines.forEach(line=>line.setMap(null));state.lines=[];return {shown:false};},
    toggleRoadLines:value=>{if(!value){manualRoadLayer?.clear();roadLayer?.clear();}else{if(state.map){manualRoadLayer ||= window.RoadRouteUi.createLayer({map:state.map});manualRoadLayer.render(manualRoadResult);roadLayer ||= window.RoadRouteUi.createLayer({map:state.map});roadLayer.render(roadResult);}}},
    highlightManualLeg:index=>{if(state.map&&manualRoadResult){manualRoadLayer ||= window.RoadRouteUi.createLayer({map:state.map});manualRoadLayer.render({...manualRoadResult,selectedLeg:Number.isInteger(index)?index:undefined});}},
    async submitDailyQuery(start,end){
      const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
      if(state.mode!=='DATE_ROUTE'||!valid(start)||start!==end||end>localDate())return {ok:false,message:'일자별 운행은 선택한 배송일 한 날짜만 조회합니다.'};
      const queryConditions={vehicles:selectedVehicles().slice(),centerFilter:'',scope:periodVehicleScope};
      await changeSelectedDate(end,queryConditions);
      return {ok:dateReady,message:dateReady?'':$('#freshnessState').textContent};
    },
    setGeneralLegend(html){originalRouteLegend=html;syncRoadRoutePanel();},
    lookupStore(value){const key=String(value||'').trim();return allStores.filter(row=>[row.customerCode,row.customerName,row.address].includes(key));},
    manualStops:()=>manualDraft.stops(),
    replaceManualStops(points){cancelManualRoadRoute();const before=manualDraft.stops();try{manualDraft.clear();points.forEach(point=>manualDraft.add(point));renderManualDraft();return manualDraft.validate();}catch(error){manualDraft.clear();before.forEach(point=>manualDraft.add(point));renderManualDraft();throw error;}},
    queryManualRoute:queryManualRoadRoute,
    cancelManualRoute:cancelManualRoadRoute,
    manualRouteState:()=>manualRoadResult,
    clearManual(){cancelManualRoadRoute();manualDraft.clear();renderManualDraft();}
  };
  syncBoundaryButtons();
  $("#currentTime").textContent = formatTime(new Date());
  setInterval(() => { $("#currentTime").textContent = formatTime(new Date()); }, 10000);
  refreshVehicleUi(false);
  window.MapStaffEntry?.registerPurge(()=>hybridUi?.logout());
  window.addEventListener('map-staff-signed-out',purgeStaffData);
  window.addEventListener('map-staff-authenticated',()=>{
    SOURCE=window.VEHICLE_AREA_DATA||{vehicles:[]};ADMIN.clear();
    for(const feature of window.ADMIN_FEATURES||[])ADMIN.set(String(feature.properties?.code||''),feature);
    initVehicles();void initializeGeneral();void initMap();
  });
  window.addEventListener('pagehide',event=>{cancelManualRoadRoute();resetRoadRoute();if(event.persisted)hybridUi?.cancel();else{hybridUi?.dispose();mapObserver?.disconnect();for(const [name,fn]of mapHandlers)kakao?.maps?.event?.removeListener?.(state.map,name,fn);mapHandlers=[];}});window.addEventListener('pageshow',event=>{if(event.persisted)state.map?.relayout();});
  initMap();
  initializeGeneral();
})();
