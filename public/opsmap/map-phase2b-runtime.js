(function () {
  "use strict";

  const vehicleLabel = value => Phase2bUi.normalizeVehicleLabel(value);
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  let SOURCE = window.VEHICLE_AREA_DATA || { vehicles: [] };
  const DEFAULT_PERIOD_CENTER = window.location?.origin==='https://freshon-admin-stage-preview-template.onrender.com'?'':'osan';
  const state = { mode: "BASE_60D", connectionLines:false, rangeStart: "", rangeEnd: "", routeDate: "", selectedVehicles: [], driverKey: "", centerFilter: DEFAULT_PERIOD_CENTER, selectedDate: "", latestDate: "", map: null, overlays: [], lines: [], selected: null, virtual: null, currentRows: [], routeRows: [], newAreaResults: [], fitRequested: true, userMovedMap: false, suppressMapEventsUntil: 0, baseRequestId: 0, routeRequestId: 0, searchRequestId: 0, addressRequestId: 0, detailRequestId: 0, todayRequestId: 0 };
  let mapInitializing=null,mapObserver=null,mapHandlers=[],mapCamera=null,cameraSelection=0;
  let searchTemporaryOverlay=null,searchTemporaryRadius=null,searchTemporaryClick=null;
  let newAreaPositionControl=null;
  let addressCandidateOverlays=[];
  let temporaryAreaFacts=null, newAreaVehicleKey=null, newAreaObservedFlight=null;
  let temporaryAreaSourceVersion=null, temporaryAreaDispatchMeta=null;
  let newAreaDispatchOverlays=[];
  let clusterPanel=null,clusterPopupCleanup=null;
  let routeCameraEpoch=null;
  let operationStops = [], runFilter = "ALL";
  const dailySnapshots = new Map();
  let dailyRead = null, dailyError = null, actualRouteLayer = null, dailyView = null;
  const dailyEvidenceReads=new Map();
  const dailyRosters=new Map();
  let rosterAuthorized=true, rosterCoordinateRequest=null;
  const usesDeliveryRoster=()=>location.hostname==='freshon-admin-stage-preview-template.onrender.com';
  let approvedMarkerOrder = new Map();
  const modeViews = { BASE_60D: { vehicles: [], scope: "all", centerFilter: DEFAULT_PERIOD_CENTER }, DATE_ROUTE: { vehicles: [], scope: "all", centerFilter: "" } };
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
      if (panel) { panel.dataset.state=value.state;panel.textContent=({cached:'저장된 지도 표시 중 · 최신 자료 확인 중', 'logged-out':'로그아웃되었습니다', held:'최신 자료 확인 중 · 이전 지도 표시',error:'자료 조회 실패 · 이전 지도 표시',loading:'자료 확인 중',legacy:'저장된 지도 표시 중',ready:'지도 자료 확인 완료 · 전체 자료 확인 필요',empty:'선택 범위에 매장이 없습니다',checking:'자료 확인 중',unconfirmed:'기간 자료 확인 필요',missing:'저장된 자료가 없습니다',preparing:'자료 준비 중', 'latest-available':'새 자료가 있습니다 · 선택 기간 유지',cancelled:'조회 취소 · 이전 지도 표시'})[value.state]||'자료 확인 필요'; }
    }});
    return hybridUi;
  });
  function purgeStaffData(){
    liveAddressLocations?.clear();
    if(addressScheduleFrame!==null)cancelAnimationFrame(addressScheduleFrame);
    addressScheduleFrame=null;
    cancelManualRoadRoute();manualDraft?.clear();window.dispatchEvent(new CustomEvent('map-navigation-logout'));
    ++initialRequestId;++periodRequestId;++dateRequestId;
    for(const key of ['baseRequestId','routeRequestId','searchRequestId','addressRequestId','detailRequestId','todayRequestId'])++state[key];
    clearTimeout(initialTimer);clearTimeout(periodTimer);clearTimeout(baseVehicleTimer);clearInterval(generalSnapshotPoll);generalSnapshotPoll=null;clearTimeout(customerRegistryRetry);customerRegistryRetry=null;customerRegistry?.purge();
    clearTimeout(snapshotRecoveryTimer);snapshotRecoveryTimer=null;snapshotRetryAfter=0;snapshotFlight=null;
    rosterAuthorized=false;
    dailyRead?.controller.abort();
    dailyRosters.clear(); rosterCoordinateRequest=null;
    dailySnapshots.clear(); dailyEvidenceReads.clear(); dailyRead = dailyError = dailyView = null;
    hybridUi?.cancel();requestControllers.forEach(v=>v.controller.abort());requestControllers.clear();memoryResponses.clear();apiDiagnostics.clear();
    latestSnapshotRows=[];periodRows=[];allStores=[];generalRegistryRows.clear();operationStops=[];coordinateByCode.clear();baseVehicles.clear();baseVehicleExtraCodes.clear();baseVehicleRequest=null;periodSelectionCache=null;dateReady=false;datedSourceDate='';dailyMeta=null;closeClusterPanel();
    storeByVehicleAndCode.clear();storesByCode.clear();resetDriverMaster();geocodeCache.clear();approvedMarkerOrder.clear();
    indexedRows=null;pointIndex=null;baseVehicleMeta=null;snapshotMeta=null;periodMeta=null;modelStatus=null;
    searchIndex=searchFlight=newAreaObservedFlight=null;searchSequence++;delete $('#map').dataset.searchMetrics;
    SOURCE={vehicles:[]};state.currentRows=[];state.routeRows=[];state.newAreaResults=[];state.selectedVehicles=[];state.virtual=null;
    clearSelection();clearMap();updateOperationMetrics(null);renderPeriodStoreList([]);resetRoadRoute();clearNewAreaBatch();renderManualDraft();
    for(const selector of ['#results','#runList','#addressJudgeResults','#periodDriver','#vehicleList','#navSuggestions','#operationsPanel'])$(selector)?.replaceChildren();
    vehicleRegions = null; renderVehicleQuickFilter([]);
    for(const selector of ['#routeSummary','#mobileRouteSummary','#mapStatusSub'])$(selector)?.replaceChildren();
    delete $('#map').dataset.dailyStops;delete $('#map').dataset.dailyLocated;
    $('#freshnessState').textContent='직원 로그인 필요';$('#periodStoreListCount').textContent='';
  }
  const manualDraft = window.ManualWaypoints?.createDraft();
  let modeViewInitialized = false, markerFrame = null;
  let markerSourceVersion=0;
  let markerEntries = new Map(), indexedRows = null, pointIndex = null, detailFrame = null, resizeFrame = null;
  let periodSelectionCache = null;
  let baseVehicles = new Map(), baseVehicleRequest = null, baseVehicleTimer = null, baseVehicleTries = 0;
  let recentPeriodMode = true;
  let baseVehicleStatus='LOADING';
  let baseVehicleMeta=null;
  const baseVehicleExtraCodes=new Set();
  const renderMetrics = { renders: 0, created: 0, removed: 0, reused: 0, lastMs: 0 };
  let roadResult = null, roadLayer = null;
  let roadLinesVisible=true;
  let manualRoadResult=null,manualRoadLayer=null;
  const manualRoadController=window.ManualRoadRouteUi?.createController({onChange:result=>{
    manualRoadResult=result;renderManualRoadState();
    if(state.map){manualRoadLayer ||= window.RoadRouteUi.createLayer({map:state.map});if(roadLinesVisible)manualRoadLayer.render(result);else manualRoadLayer.clear();}
    window.dispatchEvent(new CustomEvent('map-manual-route',{detail:result}));
  }});
  function renderManualRoadState(){
    if(!window.ManualRoadRouteUi)return;
    const result=manualRoadResult;
    const text=window.MapDotUi.describeRoute(result);
    $('#manualStatus').textContent=text;
    const status=$('#plannerStatus');if(status){status.hidden=!result||result.state==='idle';status.textContent=text;status.dataset.state=result?.state||'idle';}
    const button=$('#planRoute');if(button)button.disabled=result?.state==='loading';
    const advanced=$('#manualValidate');if(advanced)advanced.disabled=result?.state==='loading';
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
    resetRoadRoute();routeCameraEpoch=mapCamera?.interaction()??0;return manualRoadController.load(draft);
  }
  let originalRouteLegend = $('.legend')?.innerHTML || '';
  const roadController = window.RoadRouteUi?.createController({ onChange: result => {
    roadResult = result;
    syncRoadRoutePanel();
    if (state.map) {
      roadLayer ||= RoadRouteUi.createLayer({ map: state.map });
      if(roadLinesVisible)roadLayer.render(result);else roadLayer.clear();
    }
    window.dispatchEvent(new CustomEvent('map-recorded-route',{detail:result}));
  } });
  function osanRoadVehicle(vehicle = primarySelectedVehicle()) {
    return isDailyDataReady() && selectedVehicles().length === 1 && Boolean(vehicle);
  }
  function navigationDailyContext() {
    const vehicles = selectedVehicles();
    if (!isDailyDataReady() || vehicles.length !== 1 || hasDatedDriverFilter()) return null;
    const [vehicle] = vehicles;
    const dispatchGroups = new Set();
    for (const row of allStores) {
      if (normalizeVehicle(row.vehicle) !== vehicle) continue;
      const group = vehicleListGroup(row.dispatchCenterCode || row.centerCode || row.centerId || row.center || row.centerName);
      if (group !== 'unknown') dispatchGroups.add(group);
    }
    const groups = dispatchGroups.size ? dispatchGroups : new Set(
      [...baseVehicles.values(), ...latestSnapshotRows]
        .filter(row => normalizeVehicle(row.baseVehicle) === vehicle && row.baseVehicleState === 'VERIFIED_MASTER' &&
          row.baseVehicleSource === 'FIXED_DISPATCH_PRIMARY' && /^[a-f0-9]{64}$/.test(row.baseVehicleVersion || ''))
        .map(row => vehicleListGroup(row.baseVehicleGroup))
    );
    return { key: state.selectedDate + '|' + vehicle, osan: groups.size === 1 && groups.has('osan') };
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
    routeCameraEpoch=mapCamera?.interaction()??0;
    return roadController?.load({ date: state.selectedDate, vehicle });
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
    if(state.mode!==next){resetDriverMaster();if(state.mode==='DATE_ROUTE'){++dateRequestId;dailyRead?.controller.abort();dailyRead=null;dailyView=null;clearActualRoute();}}
    if(state.mode!==next){closeClusterPanel();window.dispatchEvent(new CustomEvent('map-navigation-context-changed',{detail:{mode:next,date:next==='DATE_ROUTE'?state.routeDate:''}}));}
    if(state.mode!==next&&next==='DATE_ROUTE'){dateReady=false;datedSourceDate='';dailyMeta=null;state.currentRows=[];state.routeRows=[];operationStops=[];}
    if(state.mode!==next){cancelManualRoadRoute();clearSelection();cancelAddressLookup();++state.searchRequestId;++state.addressRequestId;state.virtual=null;$('#query').value='';$('#addressQuery').value='';$('#results').replaceChildren();$('#addressJudgeResults').replaceChildren();clearMap();}
    if(!preservePeriod){hybridUi?.cancel();if(state.mode!==next)hybridUi?.closePeriod();}
    if (state.mode !== next) cancelNewAreaWork();
    if (state.mode !== next) {resetRoadRoute();cancelManualRoadRoute();}
    if (modeViewInitialized && state.mode !== next) {
      modeViews[state.mode] = { vehicles: selectedVehicles().slice(), scope: periodVehicleScope, centerFilter: state.centerFilter, basis:periodBasis, driverKeys:selectedDriverKeys.slice(), driverKey:state.driverKey,
        center: state.map?.getCenter(), level: state.map?.getLevel() };
    }
    if (!modeViewInitialized || state.mode !== next) {
      const view = modeViews[next]; state.mode = next;
      setSelectedVehicles(view.vehicles); state.centerFilter = next==='DATE_ROUTE'?'':view.centerFilter;
      periodBasis=next==='DATE_ROUTE'?'vehicle':view.basis||'vehicle';selectedDriverKeys=next==='DATE_ROUTE'?[]:(view.driverKeys||[]).slice();state.driverKey=next==='DATE_ROUTE'?'':view.driverKey||'';
      periodVehicleScope = view.scope;
      if (view.center && state.map) { state.map.setLevel(view.level); state.map.setCenter(view.center); state.fitRequested = false; }
      else requestMapFit();
      modeViewInitialized = true;
      refreshVehicleUi(false);
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
  let unifiedSearchController = null, unifiedSelectionActive = false, unifiedResetting = false;
  let searchIndex, searchFlight, searchInputAt, searchSequence = 0;
  const memoryResponses = new Map();
  let latestSnapshotRows = [];
  let generalRegistryRows = new Map();
  const coordinateByCode = new Map();
  let dateRequestId = 0;
  let dateReady = false;
  let datedSourceDate = '', dailyMeta = null;
  const geocodeCache = new Map();
  let customerRegistryBusy=false,customerRegistryRetry=null,customerRegistryCheckedAt='',customerRegistrySourceCheckedAt='';
  const customerRegistry=window.MapCustomerRegistry?.create({
    pageSize:500,
    authenticated:()=>document.body.dataset.mapStaffState==='authenticated',
    readPage:async({cursor,signal,limit})=>{if(signal.aborted)throw Object.assign(Error('CANCELLED'),{name:'AbortError'});const params=new URLSearchParams({limit:String(limit)});if(cursor)params.set('cursor',cursor);else if(customerRegistry.summary().version)params.set('since',customerRegistry.summary().version);const result=await fetchJson('/api/map-phase2b/private/customer-registry?'+params,{channel:'customer-registry-page',ttl:0,timeout:30000});if(signal.aborted)throw Object.assign(Error('CANCELLED'),{name:'AbortError'});if(Number.isFinite(Date.parse(result.meta?.checkedAt)))customerRegistrySourceCheckedAt=result.meta.checkedAt;return result;}
  });
  const registrySelection=()=>({customerCode:state.selected?.customerCode||'',query:$('#query')?.value||'',center:state.centerFilter,vehicles:selectedVehicles()});
  function scheduleVisibleAddressRows(rows,{advance=false}={}){
    const candidates=rows.filter(row=>row.coordinateSearch||!(Number.isFinite(row.lat)&&Number.isFinite(row.lng)));
    const registry=customerRegistry?.summary();
    // Wait for the already requested bulk address projection instead of racing
    // hundreds of selected-customer reads during the same initial load.
    if(registry&&!registry.complete&&['idle','loading'].includes(registry.status)){
      liveAddressLocations?.schedule(candidates.filter(row=>row.customerCode===state.selected?.customerCode),{priority:true});return;
    }
    if(!customerRegistry){liveAddressLocations?.schedule(candidates);return;}
    const selected=state.selected?.customerCode;
    const eligible=candidates.filter(row=>liveAddressLocations?.canSchedule?.(row)??true);
    const imported=customerRegistry.locationRows(eligible.filter(row=>row.customerOnly),registrySelection(),{limit:40,extend:advance&&!liveAddressLocations?.busy?.()});
    liveAddressLocations?.schedule([
      ...eligible.filter(row=>row.customerCode===selected),
      ...eligible.filter(row=>!row.customerOnly&&row.customerCode!==selected),
      ...imported.filter(row=>row.customerCode!==selected)
    ]);
  }
  async function syncCustomerRegistry(){
    if(!customerRegistry||customerRegistryBusy||!generalMap||state.mode!=='BASE_60D'||document.body.dataset.mapStaffState!=='authenticated')return;
    customerRegistryBusy=true;const owner=initialRequestId,before=customerRegistry.summary().version,known=new Set(allStores.map(r=>r.customerCode));
    try{const options={selection:registrySelection(),maxPages:100},result=await (customerRegistry.summary().status==='logged-out'?customerRegistry.reconnect(options):customerRegistry.sync(options));if(owner!==initialRequestId||document.body.dataset.mapStaffState!=='authenticated'||state.mode!=='BASE_60D')return;
      customerRegistryCheckedAt=customerRegistrySourceCheckedAt;
      if(result.complete&&result.version!==before){replaceStoreSnapshot([],snapshotMeta);ensureDateVehicles();if(state.selected){const next=storesByCode.get(state.selected.customerCode);if(next)state.selected={...state.selected,...next};}state.fitRequested=false;await loadBaseMap();const added=allStores.filter(r=>!known.has(r.customerCode)).map(r=>r.customerCode);if(added.length)void loadBaseVehicles(added);window.dispatchEvent(new CustomEvent('map-customer-registry-updated',{detail:{count:result.count,checkedAt:customerRegistryCheckedAt,version:result.version}}));}
      if(result.complete&&!performance.getEntriesByName('opsmap-customer-ready','mark').length)performance.mark('opsmap-customer-ready');
      syncSourceFreshness();
    }catch(error){if(owner===initialRequestId&&document.body.dataset.mapStaffState==='authenticated'){clearTimeout(customerRegistryRetry);customerRegistryRetry=setTimeout(()=>void syncCustomerRegistry(),15000);}}
    finally{customerRegistryBusy=false;}
  }
  let addressLocationFrame=null,addressFocusRequest=null,addressScheduleFrame=null;
  function scheduleMapAddressWork({advance=false}={}){
    if(!state.map||!dateReady||document.hidden||document.body.dataset.mapStaffState!=='authenticated')return;
    void window.KakaoMapsAdapter?.refreshAddressLookup?.();
    const rows=state.selected?[state.selected,...state.currentRows]:state.currentRows;
    scheduleVisibleAddressRows(rows,{advance});
  }
  function deferMapAddressWork(){
    if(addressScheduleFrame!==null)return;
    addressScheduleFrame=requestAnimationFrame(()=>{addressScheduleFrame=null;scheduleMapAddressWork();});
  }
  window.addEventListener('map-address-capability',deferMapAddressWork);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)deferMapAddressWork();});
  const liveAddressLocations=window.MapAddressLocations?.create({
    // The shared server still serializes provider calls and enforces the daily
    // ledger. Avoid an additional four-second delay for every visible store.
    spacingMs:400,
    readAddress:async(row,signal)=>{const observedDate=row.raw?.lastDeliveryDate||storesByCode.get(row.customerCode)?.lastDeliveryDate||row.lastDeliveryDate||'',date=state.mode==='DATE_ROUTE'?row.deliveryDate||state.selectedDate:observedDate||snapshotMeta?.latestDate||localDate();const response=await fetchJson(`/api/map-phase2b/private/customer-detail?view=store&customerCode=${encodeURIComponent(row.customerCode)}&date=${date}`,{channel:'auto-address-'+row.customerCode,ttl:0,timeout:30000,headers:{'x-map-address-location':'1'}});if(signal.aborted)throw Object.assign(Error('CANCELLED'),{name:'AbortError'});const source=response.data,current=source?.sourceBasis==='CURRENT_CUSTOMER_LOOKUP',dated=source?.sourceBasis==='DATED_DELIVERY_LOOKUP'&&source.currentMasterState==='NOT_FOUND'&&source.detailDate===date&&observedDate===date;if(source?.customerCode!==row.customerCode||!current&&!dated||source?.locationState!=='SOURCE_ROW')throw Error('CURRENT_ADDRESS_UNCONFIRMED');return source;},
    lookup:(address,signal)=>geocodeAddress(address,signal),
    queryFor:address=>NewAreaRequests.addressQuery(address,Phase2bUi.addressVariants),
    enabled:()=>!document.hidden&&document.body.dataset.mapStaffState==='authenticated'&&window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup===true&&window.MapManualPins?.verified?.()===true,
    onChange:()=>{if(addressLocationFrame)return;addressLocationFrame=requestAnimationFrame(()=>{
      addressLocationFrame=null;if(document.body.dataset.mapStaffState!=='authenticated')return;
      for(const row of allStores)liveAddressLocations.apply(row);
      if(state.selected){liveAddressLocations.apply(state.selected);refreshCoordinateEvidence(state.selected);if(state.selected.coordinateSource==='KAKAO_ADDRESS_LIVE'){if(/좌표 미확인|좌표 정확성 미확인|GPS 없음/.test($('#searchState')?.textContent||''))setSearchState('매장 선택');if(addressFocusRequest?.code===state.selected.customerCode){if(addressFocusRequest.interaction==null||addressFocusRequest.interaction===mapCamera?.interaction())focusMapPoint(state.selected,{zoom:true});addressFocusRequest=null;}}}
      indexedRows=null;pointIndex=null;markerSourceVersion++;state.fitRequested=false;void loadBaseMap();
      window.dispatchEvent(new Event('map-coordinate-updated'));
    });}
  });

  SOURCE.vehicles.forEach((vehicle, vehicleIndex) => {
    (vehicle.customers || []).forEach((customer) => {
      const row = normalizeStore(customer, vehicle, vehicleIndex);
      allStores.push(row);
      storeByVehicleAndCode.set(`${vehicle.vehicle}|${row.customerCode}`, row);
      if (!storesByCode.has(row.customerCode)) storesByCode.set(row.customerCode, row);
    });
  });

  function retainedPointMatches(incoming, saved) {
    const currentAddress = incoming.address || incoming.customerAddress || incoming.basicAddress || "";
    const savedAddress = saved.address || saved.customerAddress || saved.basicAddress || "";
    const currentHash = incoming.currentAddressHash || incoming.originalAddressHash || incoming.addressHash || "";
    const savedHash = saved.currentAddressHash || saved.originalAddressHash || saved.addressHash || "";
    if (currentHash && savedHash && currentHash !== savedHash) return false;
    const sameText = currentAddress && savedAddress && currentAddress.normalize('NFKC').replace(/\s+/g,' ').trim() === savedAddress.normalize('NFKC').replace(/\s+/g,' ').trim();
    if (currentAddress && savedAddress && !sameText) return false;
    const requiresProof = ['STAGE_REGISTRY_POINT','DELIVERY_COMPLETION_GPS','BUILDING_LOCATION','ADDRESS_LOCATION'].includes(saved.coordinateEvidence);
    return !requiresProof || Boolean(sameText || currentHash && currentHash === savedHash);
  }

  function replaceStoreSnapshot(rows, meta) {
    if (state.mode === 'BASE_60D') {
      const merged = new Map(latestSnapshotRows.map(row => [String(row.customerCode || row.code), { ...row, relations: [], history: [] }]));
      for (const row of rows || []) merged.set(String(row.customerCode || row.code), row);
      rows = [...merged.values()];
    }
    const previousByCode = state.mode === 'DATE_ROUTE' ? coordinateByCode : new Map([...latestSnapshotRows, ...(generalMap?generalRegistryRows.values():allStores)].map(row => [String(row.customerCode || row.code), row]));
    if(generalMap&&state.mode==='BASE_60D'&&customerRegistry){const observed=new Map(rows.map(row=>[String(row.customerCode||row.code),{...previousByCode.get(String(row.customerCode||row.code)),...row,customerOnly:false,deliveryObserved:true}]));for(const row of generalRegistryRows.values())if(row.customerOnly&&!observed.has(row.customerCode))observed.set(row.customerCode,row);rows=customerRegistry.merge([...observed.values()]);}
    const vehicleMeta = new Map(SOURCE.vehicles.map((vehicle, index) => [String(vehicle.vehicle), { vehicle, index }]));
    const next = [];
    storeByVehicleAndCode.clear();
    storesByCode.clear();
    (rows || []).forEach((item) => {
      const vehicle = normalizeVehicle(state.mode==='DATE_ROUTE' ? item.confirmedVehicle || item.vehicle || '미확인' : item.vehicle || item.primaryVehicle90d || item.latestVehicle);
      const found = vehicleMeta.get(vehicle) || { vehicle: { vehicle }, index: 0 };
      const previous = item.currentMasterStatus==='UNAVAILABLE'?{}:previousByCode.get(String(item.customerCode || item.code || "")) || {};
      const sameAddress=retainedPointMatches(item,previous);
      const row = normalizeStore({ ...item, id: item.customerCode || item.code, name: item.customerName || item.name,
        address: item.address || item.customerAddress || item.latestAddress || previous.address,
        delivery_pattern: item.deliveryPattern || item.deliveryPatternText || previous.deliveryPattern,
        lat: item.lat === null ? null : item.lat ?? item.latitude ?? (sameAddress&&previous.coordinateSource!=='KAKAO_ADDRESS_LIVE'?previous.lat:null), lng: item.lng === null ? null : item.lng ?? item.longitude ?? (sameAddress&&previous.coordinateSource!=='KAKAO_ADDRESS_LIVE'?previous.lng:null) }, found.vehicle, found.index);
      if(!sameAddress&&(item.lat==null||item.lng==null))row.coordinateStatus='CONFLICT';
      row.customerName ||= previous.customerName || "";
      row.areaLabel ||= previous.areaLabel || "";
      row.region ||= previous.region || "";
      row.lastDeliveryDate = item.lastDeliveryDate || (meta?.recordKind==='PLANNED_ASSIGNMENTS'?'':item.deliveryDate) || "";
      if(state.mode==='DATE_ROUTE'&&row.dispatchCenterCode)row.vehicleGroup=vehicleListGroup(row.dispatchCenterCode);
      row.history = item.relations || item.history || [];
      if(item.residentSummary)row.residentSummary=item.residentSummary;
      if(item.periodAggregate?.verified===true)row.periodAggregate=item.periodAggregate;
      if(item.historyCoverage)row.historyCoverage=item.historyCoverage;
      if(item.currentMasterStatus)row.currentMasterStatus=item.currentMasterStatus;
      for(const key of ['customerOnly','deliveryObserved','currentAddressHash','originalAddressHash','customerRegistryAddressHash','customerRegistryStatus','customerRegistryUpdatedAt','customerRegistryVersion','customerLifecycle','coordinateSearch','coordinateEvidence','addressChanged','coordinateStatus','resolutionStatus','addressLocationKey'])if(item[key]!==undefined)row[key]=item[key];
      row.driverKey = item.driverKey || "";
      row.driverIdentity = item.driverIdentity || '';
      row.driverName = item.driverName || "";
      Object.assign(row, baseVehicles.get(String(row.customerCode)) || {baseVehicle:normalizeVehicle(item.baseVehicle||''),baseVehicleState:item.baseVehicle?'PUBLISHED_ONLY':'UNKNOWN'});
      if(!archivedDatedAssignments(meta)){
        window.MapManualPins?.apply(row);
        liveAddressLocations?.apply(row);
      }
      row.deliveryCount90d = item.deliveryCount90d ?? item.deliveryCount ?? null;
      next.push(row);
      storeByVehicleAndCode.set(`${row.vehicle}|${row.customerCode}`, row);
      if (!storesByCode.has(row.customerCode)) storesByCode.set(row.customerCode, row);
    });
    allStores = next;
    if(generalMap&&state.mode==='BASE_60D')generalRegistryRows=new Map(next.map(row=>[row.customerCode,row]));
    liveAddressLocations?.onSourceSync(JSON.stringify([meta?.preservation?.version,meta?.sourceGeneration,meta?.sourceObservedAt,meta?.generatedAt,customerRegistry?.summary().version]),allStores);
    window.dispatchEvent(new Event('map-stores-replaced'));
    snapshotMeta = meta || snapshotMeta;
    if(state.virtual?.searchTemporary&&(temporaryAreaSourceVersion!==newAreaSourceVersion()||temporaryAreaDispatchMeta!==baseVehicleMeta)){
      renderSearchTemporaryNearby(state.virtual,{loadDispatch:false});
    }
  }

  let periodRows = [], periodMeta = null, periodRequestId = 0, periodTimer = null;
  let modelStatus = null, initialRequestId = 0, initialTimer = null;
  let generalSnapshotPoll=null,generalSnapshotPolling=false;
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
    const recovery=meta.recovery==='RESTORING'?' · 최신 자료 복원 중':
      ['LAST_VERIFIED_RETAINED','UNAVAILABLE'].includes(meta.recovery)?' · 최신 자료 조회 실패, 확인된 자료 표시 중':'';
    $('#sourceCollectedAt').textContent=`최신 원천 수집일: ${meta.sourceObservedAt||meta.sourceCollectedAt||'미확인'}${customerRegistryCheckedAt?' · Customer 확인 '+new Date(customerRegistryCheckedAt).toLocaleTimeString('ko-KR',{hour12:false}):''}${recovery}`;
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
      .filter(row => (!generalMap||row.customerRegistryStatus!=='DELETED')&&(!state.centerFilter || periodBasis === "driver" ||
        (row.baseVehicleGroup||vehicleListGroup(row.dispatchCenterCode||row.raw?.center)) === state.centerFilter));
    periodSelectionCache = {source:allStores,key,rows}; return rows;
  }
  let snapshotFlight, snapshotRecoveryTimer, snapshotRetryAfter=0, snapshotFailure;
  async function refreshStoreSnapshot() {
    const id=initialRequestId;
    if(snapshotFlight?.id===id)return snapshotFlight.task;
    const flight={id};
    flight.task=readStoreSnapshot(id).finally(()=>{if(snapshotFlight===flight)snapshotFlight=null;});
    snapshotFlight=flight;
    return flight.task;
  }
  async function readStoreSnapshot(id) {
    try {
      const adapter=stageAddressBatchEnabled()?null:await hybridUiReady;
      const payload = await adapter?.readGeneral({masterOnly:true}) || await fetchJson("/api/map-phase2b/preview/snapshot", { channel: "map-snapshot", ttl: 0, timeout: 10000 });
      if(id!==initialRequestId)throw Object.assign(Error('QUERY_CANCELLED'),{name:'AbortError'});
      if(payload.meta?.phase==='ERROR')throw Error('SNAPSHOT_READ_FAILED');
      snapshotFailure=null;
      if(payload.pending===true||payload.meta?.complete===false){snapshotReadState='pending';snapshotRetryAfter=2000;return;}
      if (!Array.isArray(payload.data)) throw new Error("스냅샷 확인 실패");
      latestSnapshotRows = payload.data; coordinateByCode.clear();
      snapshotReadState = 'ready';
      latestSnapshotRows.forEach(row => coordinateByCode.set(String(row.customerCode || row.code), row));
      snapshotMeta = payload.meta || {};
      snapshotRetryAfter=snapshotMeta.recovery==='RESTORING'?Math.max(1000,Number(snapshotMeta.retryAfterMs)||2000):0;
      performance.mark('opsmap-snapshot-ready');
      syncSourceFreshness();
      state.latestDate = snapshotMeta.latestDate || latestDateFromRows(latestSnapshotRows);
      $("#selectedDate").max = localDate();
      // Coordinates and Snapshot freshness never select the Period or Daily date.
    } catch (error) {
      if(isSilentRequestError(error))throw error;
      snapshotReadState = error.code==='PHASE2B_SNAPSHOT_RESTORING'?'pending':'error';
      snapshotRetryAfter=snapshotReadState==='pending'?error.retryAfterMs??2000:0;
      snapshotFailure=error;
    }
  }
  function scheduleSnapshotRecovery(id,until=Date.now()+30000) {
    clearTimeout(snapshotRecoveryTimer);
    const delay=Math.max(1000,snapshotRetryAfter);
    if(id!==initialRequestId||!generalMap||!snapshotRetryAfter)return;
    if(Date.now()+delay>until){
      $('#freshnessState').textContent=dateReady?'매장 복원 지연 · 마지막 확인 지도 표시':'매장 복원 지연 · 다시 조회해 주세요.';
      return;
    }
    snapshotRecoveryTimer=setTimeout(async()=>{
      snapshotRecoveryTimer=null;
      if(id!==initialRequestId||!generalMap)return;
      await pollGeneralSnapshot({recovering:true});
      if(snapshotRetryAfter)scheduleSnapshotRecovery(id,until);
    },delay);
  }
  function snapshotFailureLabel(){
    return [401,403].includes(snapshotFailure?.status)?'직원 인증 또는 조회 권한을 확인해 주세요.':
      snapshotFailure?.code==='REQUEST_TIMEOUT'?'매장 자료 응답 시간이 초과됐습니다.':'저장 매장 자료를 확인할 수 없습니다.';
  }
  function applySnapshotRange() {
    const end=snapshotMeta?.endDate||snapshotMeta?.latestDate;
    if(!recentPeriodMode||!OpsmapDaily.day(end))return;
    const start=OpsmapDaily.day(snapshotMeta?.startDate)?snapshotMeta.startDate:daysBefore(end,89);
    state.rangeStart=start;state.rangeEnd=end;
    $('#rangeStart').value=start;$('#rangeEnd').value=end;
  }
  async function pollGeneralSnapshot({recovering=false}={}){
    if(generalSnapshotPolling||!generalMap||state.mode!=='BASE_60D'||!recovering&&document.hidden||document.body.dataset.mapStaffState!=='authenticated')return{ok:false,skipped:true};
    generalSnapshotPolling=true;const owner=initialRequestId,oldRows=latestSnapshotRows,oldMeta=snapshotMeta;
    const version=m=>JSON.stringify([m?.preservation?.version,m?.sourceGeneration,m?.version,m?.generatedAt,m?.rowCount]);
    try{
      await refreshStoreSnapshot();
      if(owner!==initialRequestId||!generalMap||state.mode!=='BASE_60D'||document.body.dataset.mapStaffState!=='authenticated')return{ok:false,skipped:true};
      if(snapshotReadState!=='ready')throw Error('SNAPSHOT_READ_FAILED');
      if(version(oldMeta)===version(snapshotMeta)&&oldRows.length===latestSnapshotRows.length)return{ok:true,changed:false};
      const previousByCode=new Map(oldRows.map(row=>[String(row.customerCode||row.code),row]));
      const added=latestSnapshotRows.map(row=>String(row.customerCode||row.code)).filter(code=>!previousByCode.has(code));
      // An approved registry generation can move a store even when its last delivery is older.
      const verifiedRegistry=/^[a-f0-9]{64}$/.test(snapshotMeta?.sourceGeneration||'')&&snapshotMeta.registryComplete!==false;
      if(!verifiedRegistry){
        const merged=new Map(previousByCode);
        for(const row of latestSnapshotRows){
          const code=String(row.customerCode||row.code),prior=previousByCode.get(code);
          if(prior&&(prior.lastDeliveryDate||'')>(row.lastDeliveryDate||''))continue;
          merged.set(code,row);
        }
        latestSnapshotRows=[...merged.values()];
        coordinateByCode.clear();
        latestSnapshotRows.forEach(row=>coordinateByCode.set(String(row.customerCode||row.code),row));
      }
      applySnapshotRange();periodRows=[];replaceStoreSnapshot([],snapshotMeta);ensureDateVehicles();dateReady=true;
      if(state.selected){const next=storesByCode.get(state.selected.customerCode);if(next){state.selected={...state.selected,...next};refreshCoordinateEvidence(state.selected);void enrichStoreDetail(state.selected);}}
      if(oldRows.length)state.fitRequested=false;
      await loadBaseMap();
      void initMap().then(()=>afterSearchPaint(()=>{if(owner===initialRequestId&&generalMap&&added.length)void loadBaseVehicles(added);}));
      void window.MapDataSync?.refresh?.();return{ok:true,changed:true,added:added.length,stores:allStores.length};
    }catch(error){
      if(owner!==initialRequestId||document.body.dataset.mapStaffState!=='authenticated')return{ok:false,skipped:true};
      latestSnapshotRows=oldRows;snapshotMeta=oldMeta;coordinateByCode.clear();oldRows.forEach(row=>coordinateByCode.set(String(row.customerCode||row.code),row));
      if(!snapshotRetryAfter&&!dateReady){setPeriodViewState('error');renderPeriodStoreList([]);$('#freshnessState').textContent=snapshotFailureLabel();}
      const label=$('#mapFreshnessStatus');if(label)label.title='자동 매장 조회 지연 · 기존 지도 유지';return{ok:false,changed:false};
    }finally{generalSnapshotPolling=false;}
  }
  function startGeneralSnapshotPolling(){
    if(generalSnapshotPoll!==null)return;
    generalSnapshotPoll=setInterval(()=>{
      if(document.hidden)return;
      void pollGeneralSnapshot();void syncCustomerRegistry();
      if(generalMap&&state.mode==='BASE_60D')scheduleMapAddressWork({advance:true});
    },60000);
  }
  async function initializeGeneral() {
    startGeneralSnapshotPolling();
    recentPeriodMode=true;
    const id=++initialRequestId;
    ++periodRequestId;++dateRequestId;++state.routeRequestId;++state.todayRequestId;
    clearTimeout(initialTimer);clearTimeout(periodTimer);hybridUi?.closePeriod();hybridUi?.cancel();resetRoadRoute();
    cancelNewAreaWork();clearSelection();selectedDriverKeys=[];
    generalMap=true;generalAllStores=true;periodBasis='vehicle';state.driverKey='';
    switchMode('BASE_60D');refreshVehicleUi(false);syncModeUi();syncPeriodBasis();
    $('#includeUnvisitedStores').checked=true;dateReady=false;setPeriodViewState('loading');
    try {
      const adapter=stageAddressBatchEnabled()?null:await hybridUiReady,cached=await adapter?.readCachedGeneral();
      if(id!==initialRequestId||!generalMap)return;
      if(cached){if(recentPeriodMode){state.rangeStart=cached.meta.startDate;state.rangeEnd=cached.meta.endDate;$('#rangeStart').value=state.rangeStart;$('#rangeEnd').value=state.rangeEnd;}latestSnapshotRows=cached.data;snapshotMeta=cached.meta;coordinateByCode.clear();cached.data.forEach(row=>coordinateByCode.set(row.customerCode,row));periodRows=[];replaceStoreSnapshot([],snapshotMeta);ensureDateVehicles();dateReady=true;setPeriodViewState(allStores.length?'ready':'empty');await loadBaseMap();}
      await refreshStoreSnapshot();
      if(id!==initialRequestId||!generalMap)return;
      if(snapshotReadState==='error'&&cached){dateReady=true;setPeriodViewState(allStores.length?'ready':'empty');$('#freshnessState').textContent='저장된 정상 지도 유지 · 네트워크 최신성 미확인';return;}
      if(snapshotReadState==='pending'){
        scheduleSnapshotRecovery(id);
        if(cached){$('#freshnessState').textContent='최신 매장 자료 복원 중 · 저장된 지도 표시';return;}
        setPeriodViewState('not-ready');renderPeriodStoreList([]);$('#freshnessState').textContent='매장 자료 복원 중 · 매장 수 미확인';return;
      }
      if(snapshotReadState!=='ready')throw Error('SNAPSHOT_READ_FAILED');
      applySnapshotRange();
      periodRows=[];replaceStoreSnapshot([],snapshotMeta);ensureDateVehicles();dateReady=true;
      setPeriodViewState(allStores.length?'ready':'empty');await loadBaseMap();
      if(id!==initialRequestId||!generalMap)return;
      $('#freshnessState').textContent='전체 저장 매장 반영됨 — 운영 전체 매장 완전성 미검증';syncSourceFreshness();
      scheduleSnapshotRecovery(id);
      void initMap().then(()=>afterSearchPaint(()=>{
        if(id!==initialRequestId||!generalMap)return;
        void loadBaseVehicles(latestSnapshotRows.map(row=>row.customerCode));
        void syncCustomerRegistry();
        if(recentPeriodMode&&adapter)void adapter.refreshLatest().then(value=>{
          const range=MapPeriodUi.recentRange(value);
          if(!range||id!==initialRequestId||!generalMap||!recentPeriodMode)return;
          state.rangeStart=range.start;state.rangeEnd=range.end;
          $('#rangeStart').value=range.start;$('#rangeEnd').value=range.end;
          syncDateHeading();
        }).catch(()=>{});
      }));
    }catch(error){if(id!==initialRequestId||isSilentRequestError(error))return;setPeriodViewState('error');renderPeriodStoreList([]);$('#freshnessState').textContent=snapshotFailureLabel();}
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
    if(usesDeliveryRoster())return changeSelectedDate(maxDailyDate());
    generalMap=false;
    const kept = isDailyDataReady(); dailyError=null;
    ++initialRequestId; clearTimeout(initialTimer); clearTimeout(periodTimer); ++periodRequestId;
    switchMode("DATE_ROUTE"); syncModeUi();
    if(!kept) resetDailyView();
    dailyRead?.controller.abort(); dailyRead=null;
    const id = ++dateRequestId;
    $("#freshnessState").textContent = "운행 가능일 확인 중";
    try {
      const adapter=await hybridUiReady;
      const stored=window.MAP_ROLLING_DATE_INDEX_ENABLED===true;
      const status=stored?await adapter?.readPeriodStatus():null;
      const reviewDate=status?.reviewOnly===true&&status.availableReviewDate===window.LOCAL_REVIEW_CONFIG?.date?status.availableReviewDate:null;
      if(stored&&status?.ready!==true&&!reviewDate)throw Error('PUBLISHED_DATE_UNAVAILABLE');
      // A saved review day is usable as that day only. It is never a complete
      // published range, and must not inherit the general map's rows.
      const response = stored?{meta:{complete:true,date:reviewDate||status.completedThrough}}:await fetchJson("/api/map-phase2b/preview/assignments?date=latest", { channel: "latest-route-date", ttl: 0, timeout: 120000 });
      if (id !== dateRequestId || state.mode !== "DATE_ROUTE") return;
      const date = response.meta?.date;
      if (!usableDatedAssignments(response.meta) || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("운행일 확인 실패");
      await changeSelectedDate(date,null,{provided:response.data ? response : null});
    } catch (error) { if (id === dateRequestId && !isSilentRequestError(error)) {dailyError=error;renderDailyReadState();} }
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

  async function collectBaseVehicleBatches(batches,fetchBatch){
    const rows=[];let identity=null,last;
    for(const batch of batches){
      const payload=await fetchBatch(batch);last=payload;
      if(!Array.isArray(payload?.data)){
        if(rows.length)throw new Error('BASE_BATCH_INCOMPLETE');
        return payload;
      }
      const meta=payload.meta||{};
      if(payload.ok!==true||!/^[a-f0-9]{64}$/.test(meta.version||'')||meta.basis!=='FIXED_DISPATCH_PRIMARY'
        ||!Number.isFinite(Date.parse(meta.checkedAt))||typeof meta.stale!=='boolean')throw new Error('BASE_BATCH_EVIDENCE');
      const current=JSON.stringify([meta.version,meta.checkedAt,meta.basis,meta.stale]);
      if(identity!==null&&identity!==current)throw new Error('BASE_VERSION_CHANGED');
      identity=current;
      const expected=new Set(batch),seen=new Set();
      for(const row of payload.data){
        if(!expected.has(row.customerCode)||seen.has(row.customerCode)||row.baseVehicleVersion!==meta.version
          ||row.baseVehicleCheckedAt!==meta.checkedAt||row.baseVehicleStale!==meta.stale||row.baseVehicleSource!==meta.basis)throw new Error('BASE_BATCH_ROW_EVIDENCE');
        seen.add(row.customerCode);
      }
      if(seen.size!==expected.size)throw new Error('BASE_BATCH_INCOMPLETE');
      rows.push(...payload.data);
    }
    return {...last,data:rows};
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
        const payload=await collectBaseVehicleBatches(batches,async batch=>stageReadOnly
            ?await fetchJson('/api/map-phase2b/preview/base-vehicles?customerCodes='+encodeURIComponent(batch.join(',')),{channel:'base-vehicles',ttl:0,timeout:30000})
            :await fetchJson('/api/map-phase2b/preview/base-vehicles',{channel:'base-vehicles',ttl:0,timeout:30000,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customerCodes:batch})}));
        const rows=Array.isArray(payload?.data)?payload.data:[];
        const previousMeta=baseVehicleMeta;
        if(stageReadOnly&&payload?.meta?.refresh==='READ_ONLY'&&!Array.isArray(payload.data)){
          clearTimeout(baseVehicleTimer);
          baseVehicleTimer=setTimeout(()=>void loadBaseVehicles(),300000);
          baseVehicleMeta=baseVehicles.size&&previousMeta?.checkedAt
            ? {...payload.meta,checkedAt:previousMeta.checkedAt,version:previousMeta.version,stale:true}
            : payload.meta;
          baseVehicleStatus=baseVehicles.size?'READY':payload.phase==='ERROR'?'ERROR':'NOT_READY';return;
        }
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
        const reviewNote=document.querySelector('#reviewBanner small');
        if(reviewNote&&baseVehicleMeta?.stale===true){reviewNote.dataset.masterReference='stale';reviewNote.textContent=`10/23 저장자료 · 기준호차 ${String(baseVehicleMeta.checkedAt||'').slice(0,10)||'시점 미확인'} 이전 확인값 · 현재 기준 미확인 · 미게시`;window.dispatchEvent(new Event('resize'));}
        const changed=JSON.stringify(previousMeta)!==JSON.stringify(baseVehicleMeta)||rows.some(r=>JSON.stringify(previous.get(r.customerCode))!==JSON.stringify(r));
        if(!changed)return;
        if(state.mode==='BASE_60D'&&dateReady){
          replaceStoreSnapshot(periodRows,snapshotMeta);ensureDateVehicles();periodSelectionCache=null;
          if(state.selected){const selected=baseVehicles.get(state.selected.customerCode);if(selected){Object.assign(state.selected,selected);if(periodBasis==='vehicle')state.selected.vehicle=selected.baseVehicle;const label=$('#detailBaseVehicle');if(label)label.textContent=MapPeriodUi.baseVehicleLabel(selected);}}
          state.fitRequested=false;await loadBaseMap();
          if(state.selected&&periodBasis==='vehicle'&&!filteredPeriodStores().some(row=>row.customerCode===state.selected.customerCode)){
            $('#mapStatusSub').textContent+=' · 선택 고객의 기준호차/센터가 갱신되어 현재 필터에서 제외됐습니다. 선택 정보는 유지합니다.';
          }
          $('#map').setAttribute('data-base-vehicle-metrics',JSON.stringify({apiMs:apiDiagnostics.get('base-vehicles')?.ms??null,appliedMs:Math.round(performance.now()-baseStarted),rows:rows.length,stale:!!baseVehicleMeta?.stale,refresh:baseVehicleMeta?.refresh||null,lastError:/^FIXED_(?:STORE|MASTER)_[A-Z_]+$/.test(baseVehicleMeta?.lastError||'')?baseVehicleMeta.lastError:null,cacheState:/^[A-Z_]{1,40}$/.test(baseVehicleMeta?.cacheState||'')?baseVehicleMeta.cacheState:null,progress:payload.progress?{phase:/^[A-Z_]{1,40}$/.test(payload.progress.phase||'')?payload.progress.phase:null,center:['011','012','013'].includes(payload.progress.center)?payload.progress.center:null,page:Number.isSafeInteger(payload.progress.page)?payload.progress.page:null,sourceRows:Number.isSafeInteger(payload.progress.sourceRows)?payload.progress.sourceRows:null,expectedRows:Number.isSafeInteger(payload.progress.expectedRows)?payload.progress.expectedRows:null}:null}));
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

  const archivedDatedAssignments = meta => meta?.reviewOnly === true && meta.source === 'STAGE_VERIFIED_DELIVERY_ARCHIVE';
  const usableDatedAssignments = meta => meta?.complete === true || archivedDatedAssignments(meta);
  function maxDailyDate() {
    return location.hostname==='freshon-admin-stage-preview-template.onrender.com' ? OpsmapDaily.dispatch(Date.now()) : localDate();
  }

  function rosterCenters() {
    if (state.centerFilter === 'osan') return ['osan','osanColdStorage'];
    if (Object.hasOwn(OpsmapDaily.centers,state.centerFilter)) return [state.centerFilter];
    return ['osan','honam','yeongnam','osanColdStorage'];
  }

  function rosterScopeStatus() {
    const saved=dailyRosters.get(state.selectedDate), centers=rosterCenters();
    const loaded=centers.map(center=>saved?.scopes.get(center)).filter(Boolean);
    const failures=centers.map(center=>saved?.errors.get(center)).filter(Boolean);
    const partial=loaded.length<centers.length;
    const selected=selectedVehicles();
    const contributing=selected.length?loaded.filter(scope=>scope.rows.some(row=>row.state!=='CANCELLED'&&selected.includes(row.vehicle))):loaded;
    const observedScopes=contributing.length?contributing:loaded;
    const retained=observedScopes.some(scope=>saved.errors.has(scope.center)||!scope.currentReadComplete);
    const loading=dailyRead?.date===state.selectedDate&&centers.some(center=>dailyRead.pending.has(center));
    const observed=observedScopes.map(scope=>scope.lastSuccessAt||scope.publishedAt).filter(Boolean).sort()[0];
    const empty=!partial&&!retained&&!loading&&periodBasis==='vehicle'&&
      (periodVehicleScope!=='selected'||selected.length>0)&&loaded.every(scope=>selected.length
        ? scope.source.unassigned===0&&!scope.rows.some(row=>row.state!=='CANCELLED'&&selected.includes(row.vehicle))
        : scope.activeCount===0);
    return {loaded,failures,partial,retained,loading,observed,empty};
  }

  function renderRosterReadState() {
    if (!rosterAuthorized) return;
    const {loaded,failures,partial,retained,loading,observed}=rosterScopeStatus();
    const message=loaded.length ? retained?'마지막 확인 배차 유지':loading?'배차 갱신 중':'배차 확인'
      : loading?'배송지 조회 중':failures.length?OpsmapDaily.errorLabel(failures[0])+' · 착지 수 미확인':'배송지 조회 대기';
    const status=$('#freshnessState');
    status.setAttribute('aria-live','polite');
    status.textContent=[message,loaded.length&&partial?'일부 센터 미확인':'',observed&&formatTime(observed,true)].filter(Boolean).join(' · ');
    $('#syncOperation').disabled=loading;
    if (!loaded.length) $('#mapStatusSub').textContent=status.textContent;
  }

  function rosterQuery(date,center,vehicle) {
    const params=new URLSearchParams({date,center});
    if (vehicle) params.set('vehicle',vehicle);
    return '/api/map-phase2b/private/dated-delivery?'+params;
  }

  function isStaffAccessError(error) {
    return [401,403].includes(error?.status)||error?.code==='STAFF_LOGIN_REQUIRED';
  }

  function installRoster(saved) {
    if (!saved.scopes.size) return;
    const scopes=[...saved.scopes.values()];
    const rows=OpsmapDaily.rosterRows(scopes).map(row=>{
      const point=coordinateByCode.get(row.customerCode)||generalRegistryRows.get(row.customerCode);
      if (!point||point.customerRegistryStatus==='DELETED') return row;
      const conflict=point.coordinateStatus==='CONFLICT';
      return {...row,customerName:point.customerName||point.name,address:point.address||point.customerAddress,
        lat:conflict?null:point.lat,lng:conflict?null:point.lng,coordinateStatus:point.coordinateStatus,
        coordinateSource:point.coordinateSource,coordinateAccuracy:point.coordinateAccuracy,
        coordinateEvidence:point.coordinateEvidence,originalAddressHash:point.originalAddressHash,
        currentAddressHash:point.currentAddressHash};
    });
    const generatedAt=scopes.map(scope=>scope.lastSuccessAt||scope.publishedAt).filter(Boolean).sort().at(-1);
    installDaily({data:rows,meta:{date:saved.date,roster:true,complete:true,generatedAt}});
  }

  function ensureRosterCoordinates() {
    if (coordinateByCode.size||rosterCoordinateRequest) return;
    const owner=rosterCoordinateRequest={};
    void hybridUiReady.then(adapter=>adapter?.readGeneral({masterOnly:true})).then(payload=>payload||
      fetchJson('/api/map-phase2b/preview/snapshot',{channel:'daily-coordinates',timeout:15000})).then(payload=>{
      if (owner!==rosterCoordinateRequest||!rosterAuthorized||!Array.isArray(payload.data)||payload.meta?.complete===false) return;
      for (const row of payload.data) if (row.customerCode) coordinateByCode.set(String(row.customerCode),row);
      const saved=dailyRosters.get(state.selectedDate);
      if (state.mode==='DATE_ROUTE'&&saved) installRoster(saved);
    }).catch(error=>{
      if (owner===rosterCoordinateRequest&&isStaffAccessError(error)) purgeStaffData();
    }).finally(()=>{if(owner===rosterCoordinateRequest)rosterCoordinateRequest=null;});
  }

  async function changeRosterDate(date,conditions) {
    if (!rosterAuthorized||!OpsmapDaily.day(date)||date>maxDailyDate()) return;
    if (state.mode!=='DATE_ROUTE'||date!==state.selectedDate) {
      dailyRead?.controller.abort();
      dailyRead=null;
      ++initialRequestId; clearTimeout(initialTimer); clearTimeout(periodTimer); ++periodRequestId;
      hybridUi?.cancel(); resetRoadRoute(); cancelManualRoadRoute();
      generalMap=false; switchMode('DATE_ROUTE');
      state.selectedDate=state.routeDate=date;
      resetDailyView(); requestMapFit(); clearNewAreaBatch();
      $('#addressJudgeResults').replaceChildren(); $('#results').replaceChildren();
      window.dispatchEvent(new CustomEvent('map-navigation-context-changed',{detail:{mode:'DATE_ROUTE',date}}));
    }
    if (conditions) {
      setSelectedVehicles(conditions.vehicles);
      state.centerFilter=conditions.centerFilter;
      periodVehicleScope=conditions.scope;
      refreshVehicleUi(false);
    }
    syncModeUi(); updateDateRange(date); $('#runListTool').open=true;
    for (const selector of ['#selectedDate','#date','#mobileDate']) {
      $(selector).value=date;
      $(selector).max=maxDailyDate();
    }
    const saved=dailyRosters.get(date)||{date,scopes:new Map(),errors:new Map(),chronologies:new Map()};
    dailyRosters.delete(date); dailyRosters.set(date,saved);
    while (dailyRosters.size>4) dailyRosters.delete(dailyRosters.keys().next().value);
    if (!isDailyDataReady()) installRoster(saved);
    ensureRosterCoordinates();
    if (dailyRead?.date===date) {
      for (const center of rosterCenters()) if (!dailyRead.visited.has(center)) dailyRead.pending.add(center);
      return dailyRead.promise;
    }
    const read={date,controller:new AbortController(),pending:new Set(rosterCenters()),visited:new Set()};
    dailyRead=read;
    const active=()=>rosterAuthorized&&read===dailyRead&&!read.controller.signal.aborted&&state.mode==='DATE_ROUTE'&&state.selectedDate===date;
    renderRosterReadState();
    read.promise=(async()=>{
      try {
        for (const center of read.pending) {
          if (!active()) return;
          read.visited.add(center);
          try {
            const response=await fetchJson(rosterQuery(date,center),{channel:'dated-roster:'+center,signal:read.controller.signal,
              timeout:16000,allowSourceError:true});
            if (!active()) return;
            const scope=OpsmapDaily.verifyRoster(response,date,center);
            const prior=saved.scopes.get(center);
            const before=prior?.lastSuccessAt||prior?.publishedAt||'';
            const after=scope.lastSuccessAt||scope.publishedAt||'';
            if (prior&&(after<before||!scope.currentReadComplete&&prior.currentReadComplete&&after===before)) {
              saved.errors.set(center,Error(scope.error||'DELIVERY_SOURCE_REGRESSION'));
              continue;
            }
            const updated=new Map(saved.scopes);
            updated.set(center,scope);
            OpsmapDaily.rosterRows(updated.values());
            if(prior&&!OpsmapDaily.sameRosterScope(prior,scope)){
              for(const key of saved.chronologies.keys())if(key.startsWith(center+'|'))saved.chronologies.delete(key);
            }
            saved.scopes=updated;
            saved.errors.delete(center);
            if (!prior||prior.sha256!==scope.sha256||!OpsmapDaily.sameRosterScope(prior,scope)) installRoster(saved);
          } catch (error) {
            if (!active()) return;
            if (isStaffAccessError(error)) {purgeStaffData();return;}
            saved.errors.set(center,error);
          } finally {
            read.pending.delete(center);
            if (active()) renderRosterReadState();
          }
        }
        if(active()&&!saved.scopes.size&&date<localDate()&&!isDailyDataReady()){
          const archive=await fetchJson('/api/map-phase2b/preview/assignments?date='+date,
            {channel:'dated-legacy-archive',signal:read.controller.signal,timeout:12000})
            .then(value=>archivedDatedAssignments(value?.meta)?OpsmapDaily.validate(value,date):null).catch(()=>null);
          if(active()&&archive)installDaily(archive);
        }
      } finally {
        if (active()) {
          dailyRead=null;
          if (isDailyDataReady()) void loadBaseMap();
          else renderRosterReadState();
        }
      }
    })();
    return read.promise;
  }

  function currentRosterRoute() {
    const vehicles=selectedVehicles();
    if (vehicles.length!==1) return null;
    const saved=dailyRosters.get(state.selectedDate);
    if (!saved) return null;
    const vehicle=vehicles[0];
    const centers=new Set(operationStops.filter(row=>row.vehicle===vehicle).map(row=>row.dispatchCenterCode));
    if (centers.size!==1) return null;
    const [center]=centers;
    const scope=saved.scopes.get(center);
    return scope?{saved,scope,vehicle,key:center+'|'+vehicle}:null;
  }

  function visibleActualPoints() {
    const rows=dailyView?.shown||[];
    if (!dailyMeta?.roster) return OpsmapDaily.actualPoints(rows);
    const route=currentRosterRoute();
    const evidence=route?.saved.chronologies.get(route.key);
    return evidence?OpsmapDaily.rosterPoints(rows,evidence.points):[];
  }

  function applyRosterTimes() {
    if (!dailyMeta?.roster) return;
    const route=currentRosterRoute();
    const evidence=route?.saved.chronologies.get(route.key);
    for (const row of operationStops) row.actualCompletedAt=evidence?.status.get(row.deliveryId)||null;
  }

  async function loadRosterChronology() {
    const route=currentRosterRoute();
    if (!rosterAuthorized||!route||!operationStops.some(row=>row.status==='COMPLETED')) return;
    const {saved,scope,vehicle,key}=route;
    const requestKey=JSON.stringify([scope.date,scope.center,vehicle,scope.lastSuccessAt,scope.generation,scope.source.sha256]);
    const prior=dailyEvidenceReads.get(requestKey);
    if (prior?.pending) return prior.pending;
    if (prior?.nextAttempt>Date.now()) return;
    const entry={};
    entry.pending=fetchJson(rosterQuery(scope.date,scope.center,vehicle),{channel:'dated-chronology:'+scope.center+'|'+vehicle,
      timeout:12000,allowSourceError:true}).then(response=>{
      const current=currentRosterRoute();
      if (!rosterAuthorized||current?.saved!==saved||current.key!==key||!OpsmapDaily.sameRosterScope(current.scope,scope)) return;
      const evidence=OpsmapDaily.chronology(scope,response,vehicle);
      const retained=saved.chronologies.get(key);
      if (evidence.points.size||evidence.tiedCount||!retained) saved.chronologies.set(key,evidence);
      applyRosterTimes();
      renderRunList();
      drawRoute();

    }).catch(error=>{
      if (rosterAuthorized&&isStaffAccessError(error)) purgeStaffData();
    }).finally(()=>{
      entry.pending=null;
      entry.nextAttempt=Date.now()+30000;
    });
    dailyEvidenceReads.set(requestKey,entry);
    while (dailyEvidenceReads.size>32) dailyEvidenceReads.delete(dailyEvidenceReads.keys().next().value);
    return entry.pending;
  }


  function resetDailyView() {
    delete $('#map').dataset.dailyEvidence;
    dateReady=false; datedSourceDate=''; dailyMeta=null; dailyView=null;
    state.currentRows=[]; state.routeRows=[]; operationStops=[];
    clearSelection(); clearMap(); renderRunList(); updateOperationMetrics(null);
  }
  function renderDailyReadState() {
    if(usesDeliveryRoster()&&!dailyMeta?.reviewOnly)return renderRosterReadState();
    const ready=isDailyDataReady(), loading=dailyRead?.date===state.selectedDate;
    const observed=dailyMeta?.sourceObservedAt || dailyMeta?.generatedAt || dailyMeta?.observedAt || dailyMeta?.checkedAt;
    const freshness=$("#freshnessState");
    freshness.setAttribute('aria-live','polite');
    freshness.textContent=loading?(ready?'갱신 중 · 마지막 정상 결과 표시':'배송지 조회 중')
      :dailyError?OpsmapDaily.errorLabel(dailyError)+(ready?' · 마지막 확인 결과 표시':' · 배송지 수 미확인')
      :ready?(dailyMeta.retained||dailyMeta.previousVerifiedRetained?'마지막 확인 결과 · 최신 확인 대기':
        dailyMeta.reviewOnly?'저장 기록 · 전체 배차 미확인':state.selectedDate+(dailyMeta.centerScope==='osan'?' 오산 편성 조회 완료 · 타 센터 미조회':' 편성 조회 완료'))
        +(observed?' · '+formatTime(observed):''):'배송지 조회 대기';
    $("#syncOperation").disabled=loading;
    if(!ready) $("#mapStatusSub").textContent=freshness.textContent;
  }
  function installDaily(payload) {
    const date=payload.meta.date;
    const sameView=isDailyDataReady();
    dailyMeta=payload.meta;
    if(!sameView || dailyView?.payload!==payload) {
      const selected=state.selected;
      replaceStoreSnapshot(payload.data,payload.meta);
      if(selected?.customerCode){
        const next=selected.deliveryId ? allStores.find(row=>row.deliveryId===selected.deliveryId)
          : storeByVehicleAndCode.get(datedVisitKey(selected.vehicle,selected.customerCode));
        if(next)state.selected={...selected,...next};
        else if(!selected.outsideReason)clearSelection({preserveSearch:true});
      }
      datedSourceDate=date; dateReady=true;
      dailyView={payload};
      ensureDateVehicles();
      void loadBaseMap();
    }
    dailyMeta=payload.meta;
    lastRefreshedAt=payload.meta.sourceObservedAt||payload.meta.generatedAt||payload.meta.observedAt||payload.meta.checkedAt||'';
  }
  async function changeSelectedDate(date,queryConditions=null,{provided=null}={}) {
    if(usesDeliveryRoster())return changeRosterDate(date,queryConditions);
    if(!OpsmapDaily.day(date)||date>maxDailyDate())return;
    const contextChanged=state.mode!=='DATE_ROUTE'||date!==state.selectedDate;
    generalMap=false;
    if(contextChanged){
      dailyRead?.controller.abort(); dailyRead=null; hybridUi?.cancel();
      ++initialRequestId; clearTimeout(initialTimer); clearTimeout(periodTimer); ++periodRequestId;
      resetRoadRoute(); cancelManualRoadRoute();
      switchMode('DATE_ROUTE');
      state.selectedDate=date; state.routeDate=date; dailyError=null; resetDailyView(); requestMapFit();
      window.dispatchEvent(new CustomEvent('map-navigation-context-changed',{detail:{mode:'DATE_ROUTE',date}}));
      clearNewAreaBatch();
      $('#addressJudgeResults').replaceChildren(); $('#results').replaceChildren();
    }
    if(queryConditions){setSelectedVehicles(queryConditions.vehicles);state.centerFilter=queryConditions.centerFilter;periodVehicleScope=queryConditions.scope;refreshVehicleUi(false);}
    if(dailyRead?.date===date){if(queryConditions)void loadBaseMap();return dailyRead.promise;}
    syncModeUi(); $('#runListTool').open=true; updateDateRange(date);
    for(const id of ['#selectedDate','#date','#mobileDate']){$(id).value=date;$(id).max=maxDailyDate();}
    $('#syncOperation').textContent=date===localDate()?'↻ 현재상태 동기화':'↻ 데이터 새로고침';
    const cached=dailySnapshots.get(date);
    if(cached){dailySnapshots.delete(date);dailySnapshots.set(date,cached);installDaily(cached);if(queryConditions)void loadBaseMap();}
    const controller=new AbortController(), token=++dateRequestId;
    const read={date,controller};
    dailyRead=read; dailyError=null; renderDailyReadState();
    const owns=()=>dateRequestId===token&&state.mode==='DATE_ROUTE'&&state.selectedDate===date&&!controller.signal.aborted;
    read.promise=(async()=>{
      try{
        const adapter=await hybridUiReady;
        if(!owns())return;
        let response=provided||await adapter?.readDate(date);
        if(!owns())return;
        if(response?.meta?.coverageComplete===true && response.meta.rowCount===undefined)
          response={...response,meta:{...response.meta,rowCount:response.data.length}};
        response ||= await fetchJson('/api/map-phase2b/preview/assignments?date='+date,{channel:'selected-date',signal:controller.signal,timeout:45000});
        if(!owns())return;
        OpsmapDaily.validate(response,date);
        if(response.meta.retained===true || response.meta.previousVerifiedRetained===true || archivedDatedAssignments(response.meta)){
          if(response.meta.failure)dailyError=Object.assign(Error(response.meta.failure.code),response.meta.failure);
          if(cached?.meta.complete===true && cached.meta.retained!==true)return;
        }
        const version=meta=>meta.sourceGeneration??meta.sourceRevision??meta.version;
        const previousVersion=version(cached?.meta||{}), nextVersion=version(response.meta);
        if(cached?.meta.source===response.meta.source && Number.isSafeInteger(previousVersion)&&Number.isSafeInteger(nextVersion)&&nextVersion<previousVersion)
          throw Error('GENERATION_CHANGED');
        if(cached && JSON.stringify(cached.data)===JSON.stringify(response.data)){
          dailyMeta=response.meta;dailyView.payload=response;
          lastRefreshedAt=response.meta.sourceObservedAt||response.meta.generatedAt||response.meta.observedAt||response.meta.checkedAt||'';
          if(cached.meta.reviewOnly!==response.meta.reviewOnly)void loadBaseMap();
          else void loadDailyCompletionEvidence();
        }else installDaily(response);
        dailySnapshots.delete(date);dailySnapshots.set(date,response);
        while(dailySnapshots.size>4)dailySnapshots.delete(dailySnapshots.keys().next().value);
      }catch(error){if(owns())dailyError=error;}
      finally{if(owns()){dailyRead=null;renderDailyReadState();renderRunList();if(isDailyDataReady()&&!operationStops.length)updateOperationMetrics(verifiedEmptyDailyScope()?{totalStops:0,completedStops:0,remainingStops:0}:null);}}
    })();
    return read.promise;
  }

  function ensureDateVehicles() {
    const known = new Set(vehicleChecks().map(input => input.value));
    const vehicles = new Set();
    const baseGroups = new Map();
    for (const row of allStores) {
      if (row.baseVehicle) vehicles.add(row.baseVehicle);
      if (row.vehicle) vehicles.add(row.vehicle);
      for (const item of row.history || []) if (item.vehicle) vehicles.add(item.vehicle);
      if (row.baseVehicleGroup && !baseGroups.has(row.baseVehicle)) baseGroups.set(row.baseVehicle, row.baseVehicleGroup);
    }
    vehicles.forEach(vehicle => {
      if (known.has(vehicle)) return;
      const label = document.createElement("label");
      label.className = "vehicleItem";
      label.dataset.group=baseGroups.get(vehicle)||'';
      label.innerHTML = `<input type="checkbox" value="${esc(vehicle)}"><span class="vehicleNo">${esc(vehicleLabel(vehicle))}</span><span class="vehicleArea"></span>`;
      label.querySelector("input").onchange = () => applyVehicleFilter(selectedVehicles());
      $("#vehicleList").append(label);
      ["#vehicle", "#mobileVehicle", "#operationVehicle", "#mobileBaseVehicle"].forEach((id) => $(id).add(new Option(`${vehicleLabel(vehicle)}`, vehicle)));
    });
    $$('.vehicleItem').forEach(label=>{const group=baseGroups.get(label.querySelector('input')?.value);if(group)label.dataset.group=group;});
    sortVehicleControls();
  }

  function normalizeStore(customer, vehicle, vehicleIndex) {
    return {
      customerCode: String(customer.id || customer.code || customer.customerCode || "").trim(),
      deliveryId: customer.deliveryId || "",
      customerName: customer.name || customer.customerName || "",
      address: customer.address || "",
      vehicle: String(vehicle.vehicle || "").replace(/호(?:차)?$/, ""),
      vehicleGroup: vehicle.group || "",
      center: customer.center || customer.centerName || '',
      dispatchCenterCode: customer.dispatchCenterCode || customer.centerCode || '',
      areaLabel: vehicle.area_label || "",
      lat: numberOrNull(customer.lat),
      lng: numberOrNull(customer.lng),
      coordinateSource: customer.coordinateSource || '',
      coordinateAccuracy: customer.coordinateAccuracy || '',
      storeInteriorVerified: customer.storeInteriorVerified === true,
      deliveryPattern: customer.delivery_pattern || "",
      region: customer.region || "",
      addressRegion: customer.addressRegion || '',
      ton: customer.ton || vehicle.primary_ton || "",
      dailyAmount: customer.avg_order_amount ?? null,
      color: vehicleColor(vehicle.vehicle),
      adminCode: String(customer.admin_code || ""),
      raw: customer,
      vehicleRaw: vehicle,
      status: customer.status === "COMPLETED" || !customer.status && customer.appRecorded === true ? "COMPLETED" : customer.status === "PENDING" || !customer.status && customer.appRecorded === false ? "PENDING" : "",
      actualCompletedAt: customer.actualDeliveryEvents?.map(event=>event.at).sort()[0] || customer.actualDeliveryEvent?.at || null,
      actualDeliveryEvent: customer.actualDeliveryEvent || null, actualDeliveryEvents:customer.actualDeliveryEvents,
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
    mapCamera?.releaseFocus();
    state.fitRequested = true;
    state.userMovedMap = false;
  }

  function vehicleChecks() {
    return $$("#vehicleList input[type=checkbox]");
  }

  function vehicleListGroup(value) {
    return ({osan:'osan',osanColdStorage:'osan',yeongnam:'yeongnam',honam:'honam','011':'osan','012':'yeongnam','013':'honam','오산':'osan','영남':'yeongnam','호남':'honam','오산센터':'osan','영남센터':'yeongnam','호남센터':'honam'})[String(value || '').trim()] || 'unknown';
  }

  let vehicleRegions;
  function currentVehicleRegions() {
    const dated = state.mode === 'DATE_ROUTE';
    const ready = !dated || isDailyDataReady();
    if (vehicleRegions?.rows === allStores && vehicleRegions.dated === dated && vehicleRegions.ready === ready) return vehicleRegions.byVehicle;
    const byVehicle = new Map();
    if (ready) for (const row of allStores) {
      if (row.customerRegistryStatus === 'DELETED') continue;
      const verified = row.baseVehicleState === 'VERIFIED_MASTER' && row.baseVehicleSource === 'FIXED_DISPATCH_PRIMARY' && /^[a-f0-9]{64}$/.test(row.baseVehicleVersion || '');
      const vehicle = dated ? row.vehicle : verified && row.baseVehicle;
      if (!vehicle) continue;
      const region = window.MapVehiclePickerRegions?.addressMunicipality(row.address);
      if (!region) continue;
      if (!byVehicle.has(vehicle)) byVehicle.set(vehicle, new Set());
      byVehicle.get(vehicle).add(region);
    }
    vehicleRegions = { rows: allStores, dated, ready, byVehicle: new Map([...byVehicle].map(([vehicle, regions]) =>
      [vehicle, [...regions].sort((a, b) => a.localeCompare(b, 'ko')).join(' / ')])) };
    return vehicleRegions.byVehicle;
  }

  function filterVehicleList() {
    const query = $('#vehicleQuery').value.normalize('NFKC').trim();
    const regions = currentVehicleRegions();
    const visibleGroups = new Set();
    $$('#vehicleList .vehicleItem').forEach(item => {
      const vehicle = item.querySelector('input').value;
      const region = regions.get(vehicle) || '';
      const area = item.querySelector('.vehicleArea');
      const label = region || '담당 지역 미확인';
      if (area.textContent !== label) area.textContent = label;
      const matchesCenter = !state.centerFilter || vehicleListGroup(item.dataset.group) === vehicleListGroup(state.centerFilter);
      const visible = matchesCenter && (Phase2bUi.vehicleMatches(query, vehicle) || region.includes(query));
      item.style.display = visible ? 'flex' : 'none';
      if (visible) visibleGroups.add(item.dataset.listGroup);
    });
    $$('#vehicleList .vehicleGroupHeading').forEach(heading => {
      heading.hidden = !visibleGroups.has(heading.dataset.listGroup);
    });
    $('#selectAllVehicles').disabled = !visibleGroups.size;
  }

  function visibleVehicleItems() {
    return $$('#vehicleList .vehicleItem').filter(item => item.style.display !== 'none');
  }

  function applyVehicleFilter(vehicles) {
    setSelectedVehicles(vehicles);
    periodVehicleScope = vehicles.length ? 'selected' : 'all';
    $('#mobileBaseVehicle').value = vehicles.length === 1 ? vehicles[0] : '';
    $('#vehicleSelect').classList.remove('open');
    refreshVehicleUi(true, { preserveSearch: true });
  }

  function sortVehicleControls() {
    const list = $('#vehicleList'), groups = ['osan','yeongnam','honam','unknown'];
    const names = {osan:'오산',yeongnam:'영남',honam:'호남',unknown:'미확인'};
    const items = $$('#vehicleList .vehicleItem');
    const groupKey = item => vehicleListGroup(item.dataset.group);
    const hired = item => /^용/.test(item.querySelector('input').value.trim());
    const sortKey = item => item.querySelector('input').value.trim().replace(/^용(?:차)?[\s-]*/, '');
    items.sort((a,b) => groups.indexOf(groupKey(a)) - groups.indexOf(groupKey(b)) || Number(hired(a)) - Number(hired(b)) || naturalCompare(sortKey(a),sortKey(b)) || naturalCompare(a.querySelector('input').value,b.querySelector('input').value));
    list.querySelectorAll('.vehicleGroupHeading').forEach(heading => heading.remove());
    let previous = '';
    for (const item of items) {
      const group = groupKey(item), key = group + (hired(item) ? '-hired' : '');
      item.dataset.listGroup = key;
      if (key !== previous) {
        const heading = document.createElement('div');heading.className = 'vehicleGroupHeading';heading.dataset.listGroup = key;
        heading.textContent = names[group] + (hired(item) ? ' · 용차' : '');list.append(heading);previous = key;
      }
      list.append(item);
    }
    for (const id of ['#vehicle','#mobileVehicle','#operationVehicle','#mobileBaseVehicle']) {
      const select = $(id), value = select.value;
      [...select.options].filter(option => option.value).sort((a,b) => naturalCompare(a.value,b.value)).forEach(option => select.add(option));
      select.value = value;
    }
    filterVehicleList();
  }

  function initVehicles() {
    const vehicles = SOURCE.vehicles.map((item) => String(item.vehicle)).sort(naturalCompare);
    $("#vehicleList").innerHTML = SOURCE.vehicles.slice().sort((a, b) => naturalCompare(a.vehicle, b.vehicle)).map((vehicle) => `
      <label class="vehicleItem" data-group="${esc(vehicle.group || "")}">
        <input type="checkbox" value="${esc(vehicle.vehicle)}">
        <span class="vehicleNo">${esc(vehicleLabel(vehicle.vehicle))}</span>
        <span class="vehicleArea">${esc(vehicle.area_label || vehicle.primary_area || vehicle.group || "권역")}</span>
      </label>`).join("");
    vehicleChecks().forEach((input) => { input.onchange = () => applyVehicleFilter(selectedVehicles()); });
    [$("#vehicle"), $("#mobileVehicle"), $("#operationVehicle")].forEach((select) => {
      select.innerHTML = '<option value="">전체 호차</option>' + vehicles.map((vehicle) => `<option value="${esc(vehicle)}">${esc(vehicleLabel(vehicle))}</option>`).join("");
      select.value = "";
    });
    $("#mobileBaseVehicle").innerHTML = `<option value="">전체 호차</option>${vehicles.map((vehicle) => `<option value="${esc(vehicle)}">${esc(vehicleLabel(vehicle))}</option>`).join("")}`;
    $("#operationVehicle").value = "";
    sortVehicleControls();
    refreshDriverMaster();
  }

  let driverMasterDate='',driverMasterPending=null,driverMasterRequestId=0,driverMasterState='idle',driverMasterCheckedAt=0;
  function driverReferenceDate(){return state.mode==='DATE_ROUTE'?state.selectedDate:localDate();}
  function resetDriverMaster(){
    ++driverMasterRequestId;requestControllers.get('driver-master')?.controller.abort('context-changed');
    driverMasterPending=null;driverMasterDate='';driverMasterState='idle';driverMasterCheckedAt=0;driverByVehicle.clear();selectedDriverContact?.clear();
    syncDriverMasterUi();
  }
  const selectedDriverContact=window.MapDriverContact?.create({getTarget:()=>$('#detailDriver'),onRender:()=>positionDetailPopup()});
  function refreshSelectedDriverContact(){
    if(window.OPSMAP_DRIVER_CONTACT_ENABLED!==true)return;
    const row=state.selected;if(!row||!selectedDriverContact)return;
    const route=state.mode==='DATE_ROUTE',vehicle=normalizeVehicle(route?row.vehicle:row.baseVehicle),date=driverReferenceDate();
    const verifiedBase=row.baseVehicleState==='VERIFIED_MASTER'&&row.baseVehicleSource==='FIXED_DISPATCH_PRIMARY'&&/^[a-f0-9]{64}$/.test(row.baseVehicleVersion||'');
    const context=/^[A-Z]\d+$/.test(row.customerCode||'')&&vehicle&&(route||verifiedBase)?{customerCode:row.customerCode,vehicle,date,context:route?'DATE_ROUTE':'BASE'}:null;
    void selectedDriverContact.load(context);
  }
  function storeDriverDetail(row){
    const routeMode=state.mode==='DATE_ROUTE',date=driverReferenceDate();
    const verifiedBase=row.baseVehicleState==='VERIFIED_MASTER'&&row.baseVehicleSource==='FIXED_DISPATCH_PRIMARY'&&/^[a-f0-9]{64}$/.test(row.baseVehicleVersion||'');
    const vehicle=normalizeVehicle(routeMode?row.vehicle:row.baseVehicle);
    const detail={label:'담당 기사',text:'담당 기사 정보 없음',title:'',source:''};
    if(!routeMode&&(!verifiedBase||!vehicle)){detail.text+=' · 기준호차 확인 필요';return detail;}
    // A historical delivery driver is never the current base-vehicle assignment.
    if(routeMode)return {...detail,text:String(row.driverName||'').trim()||'담당 기사 정보 없음',title:'',source:'ASSIGNMENT'};
    if(window.OPSMAP_DRIVER_CONTACT_ENABLED!==true)return {...detail,text:'기사 연락처 미연결',source:'DISABLED'};
    const driver=driverMasterDate===date?driverByVehicle.get(vehicle):null;
    const name=String(driver?.driverName||driver?.name||'').trim();
    if(!name){
      if(driverMasterState==='loading')detail.text='담당 기사 불러오는 중…';
      else if(driverMasterState==='error'&&driverMasterDate===date)detail.text='담당 기사 조회 실패';
      return detail;
    }
    return {...detail,text:name,title:'',source:'VEHICLE_DRIVER_MASTER'};
  }
  function syncDriverMasterUi(){
    const date=driverReferenceDate(),current=driverMasterDate===date;
    [$('#vehicle'),$('#mobileVehicle'),$('#operationVehicle')].forEach(select=>[...(select?.options||[])].forEach(option=>{
      if(!option.value)return;
      const driver=current?driverByVehicle.get(normalizeVehicle(option.value)):null;
      const name=String(driver?.driverName||driver?.name||'').trim();
      option.textContent=vehicleLabel(option.value)+(name?' · '+name:'');
    }));
    const label=$('#detailDriverLabel'),value=$('#detailDriver');
    if(state.selected&&label&&value){const detail=storeDriverDetail(state.selected);label.textContent=detail.label;value.textContent=detail.text;value.title=detail.title;value.dataset.source=detail.source;refreshSelectedDriverContact();}
  }
  async function refreshDriverMaster() {
    if(window.OPSMAP_DRIVER_CONTACT_ENABLED!==true){driverMasterState='disabled';driverByVehicle.clear();syncDriverMasterUi();return;}
    const observedDate=driverReferenceDate(),observedMode=state.mode;
    if(!observedDate)return;
    if(driverMasterDate===observedDate&&['ready','error'].includes(driverMasterState)&&Date.now()-driverMasterCheckedAt<300000){syncDriverMasterUi();return;}
    if(driverMasterPending?.date===observedDate&&driverMasterPending.mode===observedMode){syncDriverMasterUi();return;}
    const requestId=++driverMasterRequestId;
    driverMasterPending={id:requestId,date:observedDate,mode:observedMode};driverMasterDate='';driverMasterState='loading';driverByVehicle.clear();syncDriverMasterUi();
    try {
      const payload = await fetchJson(`/api/vehicle-driver-master?date=${encodeURIComponent(observedDate)}`, { channel: "driver-master", ttl: 300000, timeout: 15000 });
      if(requestId!==driverMasterRequestId||state.mode!==observedMode||driverReferenceDate()!==observedDate)return;
      const rows = payload.vehicles || payload.results || [];
      if(!Array.isArray(rows))throw Error('DRIVER_MASTER_INVALID');
      rows.forEach(row=>{const vehicle=normalizeVehicle(row.vehicle||row.vehicleNumber);if(vehicle&&(!row.effectiveDate||row.effectiveDate<=observedDate))driverByVehicle.set(vehicle,row);});
      driverMasterDate=observedDate;driverMasterState='ready';driverMasterCheckedAt=Date.now();syncDriverMasterUi();
    } catch (_) {
      if(requestId!==driverMasterRequestId||state.mode!==observedMode||driverReferenceDate()!==observedDate)return;
      driverMasterDate=observedDate;driverMasterState='error';driverMasterCheckedAt=Date.now();driverByVehicle.clear();syncDriverMasterUi();
    } finally {if(driverMasterPending?.id===requestId)driverMasterPending=null;}
  }

  window.addEventListener('map-driver-capability',()=>{selectedDriverContact?.clear();void refreshDriverMaster();});
  window.addEventListener('pagehide',event=>{clearSearchTemporaryPin();if(!event.persisted)mapCamera?.dispose();});

  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), "ko", { numeric: true });
  }

  function initMap() {
    if(state.map){mapCamera?.scheduleRelayout();return Promise.resolve(state.map);}
    if(mapInitializing)return mapInitializing;
    performance.mark('opsmap-sdk-start');
    $('#map').dataset.sdkState='loading';
    mapInitializing=window.KakaoMapsAdapter.ready().then(()=>{
      $('#map').replaceChildren();state.map=new kakao.maps.Map($('#map'),{center:new kakao.maps.LatLng(36.7,127.7),level:13});
      $('#map').dataset.sdkState='ready';
      performance.mark('opsmap-sdk-ready');
      mapCamera=window.MapViewPolicy?.createCamera({map:state.map,element:$('#map')});
      const userGesture=()=>{mapCamera?.userGesture();state.userMovedMap=true;state.fitRequested=false;};
      for(const type of ['wheel','pointerdown','touchstart'])$('#map').addEventListener(type,userGesture,{passive:true});
      if(window.KakaoMapsAdapter?.geocoder)window.kakaoGeocoder=window.KakaoMapsAdapter.geocoder();
      const listen=(name,fn)=>{kakao.maps.event.addListener(state.map,name,fn);mapHandlers.push([name,fn]);};
      listen('dragstart',userGesture);
      listen('zoom_start',()=>{if(Date.now()>=state.suppressMapEventsUntil)userGesture();});
      listen('zoom_changed',()=>$('#map').classList.toggle('mapZoomFar',state.map.getLevel()>=9));
      listen('center_changed',scheduleDetailPosition);listen('zoom_changed',scheduleDetailPosition);
      listen('idle',()=>{if(dateReady&&!markerFrame)markerFrame=requestAnimationFrame(()=>{markerFrame=null;renderStops(state.currentRows,{viewportOnly:true,numbered:state.mode==='DATE_ROUTE'});deferMapAddressWork();});});
      listen('click',event=>{if(searchTemporaryClick)return searchTemporaryClick(event);clearSelection();});
      if(window.ResizeObserver){mapObserver=new ResizeObserver(()=>{if(resizeFrame)return;resizeFrame=requestAnimationFrame(()=>{resizeFrame=null;mapCamera?.scheduleRelayout();scheduleDetailPosition();});});for(const node of [$('#map'),$('#leftPanel'),$('#detailSection'),$('#approvedSiteHeader')])if(node)mapObserver.observe(node);}
      loadBaseMap();window.dispatchEvent(new CustomEvent('map-sdk-ready'));return state.map;
    }).catch(()=>{state.map=null;$('#map').dataset.sdkState='error';setMapMessage('카카오 지도 연결을 확인해 주세요. 매장 검색·목록은 계속 사용할 수 있습니다.');const retry=document.createElement('button');retry.id='retryMapSdk';retry.textContent='지도 다시 연결';retry.onclick=()=>{window.KakaoMapsAdapter.reset();void initMap();};$('#map').append(retry);loadBaseMap();return null;}).finally(()=>{mapInitializing=null;});
    return mapInitializing;
  }

  function setMapMessage(message) {
    $("#map").innerHTML = `<div style="display:grid;place-items:center;height:100%;color:#667085;background:#f8fafc">${esc(message)}</div>`;
  }

  function clearMap() {
    closeClusterPanel(); clearActualRoute();
    [...state.overlays, ...state.lines].forEach((item) => item.setMap?.(null));
    state.overlays = [];
    state.lines = [];
    markerEntries.clear(); indexedRows = null; pointIndex = null;
  }

  function clearSelection({preserveSearch=false,fast=false}={}) {
    addressFocusRequest=null;
    if(!preserveSearch){invalidateUnifiedSearch();if(typeof clearSearchTemporaryPin==='function')clearSearchTemporaryPin({restoreView:false});closeUnifiedSearchResults();cancelAddressLookup();}
    ++cameraSelection;mapCamera?.releaseFocus();
    closeClusterPanel();
    const temporarySelection = Boolean(state.selected?.outsideReason);
    window.MapStaff?.clear();selectedDriverContact?.clear();
    if($("#detail").contains($("#staffAuxContent")))$("#detailSection").append($("#staffAuxContent"));
    ++state.detailRequestId;
    requestControllers.get("store-detail")?.controller.abort("superseded");
    $$(".marker.selected").forEach((item) => item.classList.remove("selected"));
    state.selected = null;window.dispatchEvent(new CustomEvent("map-store-selected",{detail:{customerCode:null}}));
    $$("[data-search-code]").forEach(button => { button.classList.remove("selected"); button.setAttribute("aria-pressed", "false"); });
    $$("[data-period-store]").forEach(button => { button.classList.remove("selected"); button.setAttribute("aria-pressed", "false"); });
    if(!fast)renderRunList();
    $("#detailSection").classList.remove("open");
    $("#detail").className = "idle";
    $("#detail").textContent = "검색하거나 핀을 선택하면 점포정보가 표시됩니다.";
    if (state.mode === "BASE_60D"&&!fast) renderPeriodStoreList();
    if (temporarySelection && state.mode === "BASE_60D") { state.fitRequested = false; renderStops(state.currentRows); }
  }

  function closeClusterPanel(){
    clusterPopupCleanup?.();clusterPopupCleanup=null;
    clusterPanel?.remove();clusterPanel=null;
  }

  function anchorClusterPanel(panel,row){
    const map=state.map,mapNode=$('#map'),position=new kakao.maps.LatLng(row.lat,row.lng);
    const anchor=document.createElement('div');anchor.className='mapClusterAnchor';anchor.append(panel);
    panel.classList.add('mapClusterPopup');panel.setAttribute('role','dialog');
    // Keep SDK anchor dimensions invariant: Kakao caches initial content size.
    const overlay=new kakao.maps.CustomOverlay({position,content:anchor,clickable:true,xAnchor:0,yAnchor:0,zIndex:60});
    let frame=null,disposed=false,adjustCamera=true;
    const rect=node=>node?.getClientRects().length&&!node.hidden?node.getBoundingClientRect():null;
    function layout(){
      frame=null;if(disposed)return;
      // Resize must settle before projecting or adjusting the popup's camera.
      mapCamera?.relayout?.();
      const cameraSize=mapCamera?.dimensions?.();
      if(cameraSize&&(cameraSize.width!==mapNode.clientWidth||cameraSize.height!==mapNode.clientHeight)){schedule();return;}
      const mapRect=mapNode.getBoundingClientRect(),visual=window.visualViewport;
      const viewport={left:visual?.offsetLeft||0,top:visual?.offsetTop||0,width:visual?.width||innerWidth,height:visual?.height||innerHeight};
      const area=window.MapViewPolicy?.cameraFocusViewport({mapRect,viewportRect:viewport,headerRect:rect($('#approvedSiteHeader')),
        occluders:$$('#leftPanel,#detailSection.open,#mobileWorkspace,#manualPinEditor:not([hidden]),.mobileMapControls').map(rect).filter(Boolean)})||mapRect;
      const width=Math.max(0,Math.min(292,area.width-16)),gap=52;
      panel.style.width=width+'px';panel.style.maxHeight=Math.max(0,Math.min(360,area.height*.48,area.height-gap-16))+'px';
      overlay.setPosition(position);
      const height=panel.getBoundingClientRect().height;
      const point=map.getProjection().containerPointFromCoords(position),x=mapRect.left+point.x,y=mapRect.top+point.y;
      const minX=area.left+8+width/2,maxX=area.right-8-width/2,minY=area.top+8+height+gap,maxY=area.bottom-8;
      if(adjustCamera){
        adjustCamera=false;
        const dx=Math.max(minX,Math.min(maxX,x))-x,dy=Math.max(Math.min(minY,maxY),Math.min(maxY,y))-y;
        if(Math.abs(dx)>1||Math.abs(dy)>1){
          const projection=map.getProjection();
          const center=projection.coordsFromContainerPoint(new kakao.maps.Point(mapRect.width/2-dx,mapRect.height/2-dy));
          state.suppressMapEventsUntil=Date.now()+700;map.setCenter(center);schedule();return;
        }
      }
      const shift=Math.max(minX-x,Math.min(maxX-x,0));
      const below=y-height-gap<area.top+8&&y+height+gap<=area.bottom-8;
      anchor.style.transform=`translate(${Math.round(shift)}px,${below?Math.round(height+gap*2):0}px)`;
      anchor.style.setProperty('--cluster-tail-x',Math.max(12,Math.min(width-12,width/2-shift))+'px');
      anchor.classList.toggle('clusterBelow',below);
      // A panned-away pin must not leave a detached list fixed over the map.
      anchor.style.visibility=x<area.left||x>area.right||y<area.top||y>area.bottom||width<160?'hidden':'visible';
    }
    function schedule(){if(!disposed&&frame===null)frame=requestAnimationFrame(layout);}
    function resize(){adjustCamera=true;schedule();}
    const escape=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeClusterPanel();}};
    const stop=event=>{event.stopPropagation();kakao.maps.event.preventMap?.();};
    for(const name of ['pointerdown','click','dblclick','wheel','touchstart'])anchor.addEventListener(name,stop,{passive:true});
    const names=['center_changed','zoom_changed','bounds_changed','idle'];
    names.forEach(name=>kakao.maps.event.addListener(map,name,schedule));
    const observer=window.ResizeObserver?new ResizeObserver(entries=>{if(entries.some(entry=>entry.target===mapNode))adjustCamera=true;schedule();}):null;
    observer?.observe(mapNode);observer?.observe(panel);
    window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize);
    document.addEventListener('keydown',escape,true);
    const cleanupEvents=['map-navigation-context-changed','map-navigation-logout','pagehide'];
    cleanupEvents.forEach(name=>window.addEventListener(name,closeClusterPanel));
    clusterPopupCleanup=()=>{
      disposed=true;if(frame!==null)cancelAnimationFrame(frame);observer?.disconnect();
      names.forEach(name=>kakao.maps.event.removeListener(map,name,schedule));
      window.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('resize',resize);
      document.removeEventListener('keydown',escape,true);cleanupEvents.forEach(name=>window.removeEventListener(name,closeClusterPanel));
      overlay.setMap(null);anchor.remove();
    };
    mapCamera?.releaseFocus();overlay.setMap(map);schedule();
  }

  function showCluster(row){
    const members=(row.clusterRows||[]).filter(item=>item.customerCode);
    if(!members.length||!state.map)return;
    closeClusterPanel();
    state.fitRequested=false;state.suppressMapEventsUntil=Date.now()+700;
    const locations=new Map();
    for(const item of members){
      if(!Number.isFinite(item.lat)||!Number.isFinite(item.lng))continue;
      const key=item.lat+':'+item.lng;if(!locations.has(key))locations.set(key,[]);locations.get(key).push(item);
    }
    const sameLocation=locations.size===1&&[...locations.values()][0].length===members.length;
    const b=row.clusterBounds;
    if(!sameLocation&&b&&(b.north-b.south>0.00001||b.east-b.west>0.00001)){
      const bounds=new kakao.maps.LatLngBounds();bounds.extend(new kakao.maps.LatLng(b.south,b.west));bounds.extend(new kakao.maps.LatLng(b.north,b.east));state.map.setBounds(bounds,90,80,90,80);
    }else if(!sameLocation){
      state.map.setLevel(Math.min(4,state.map.getLevel()));state.map.panTo(new kakao.maps.LatLng(row.lat,row.lng));
    }
    const panel=document.createElement('section');panel.id='mapClusterPanel';panel.className='mapClusterPanel';panel.setAttribute('aria-label','묶음 매장 목록');
    const heading=document.createElement('div');heading.className='clusterPanelHeading';
    const title=document.createElement('h3');title.textContent=`${row.clusterLabel||'선택한 위치'} · ${members.length}개 매장`;
    const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','묶음 목록 닫기');close.onclick=closeClusterPanel;heading.append(title,close);panel.append(heading);
    const actions=document.createElement('div');actions.className='clusterPanelActions';
    const vehicles=row.clusterVehicles||row.vehicles||[];
    if(vehicles.length===1&&vehicles[0]){
      const filter=document.createElement('button');filter.type='button';filter.textContent=`${vehicles[0]}호차만 보기`;
      filter.onclick=()=>{closeClusterPanel();state.centerFilter='';periodBasis='vehicle';periodVehicleScope='selected';syncPeriodBasis();setSelectedVehicles([vehicles[0]]);refreshVehicleUi(true);};actions.append(filter);
    }
    const all=document.createElement('button');all.type='button';all.textContent='전체 호차';all.onclick=()=>{state.centerFilter='';$('#periodCenter').value='all';applyVehicleFilter([]);};actions.append(all);panel.append(actions);
    const query=document.createElement('input');query.type='search';query.placeholder='이 묶음에서 매장 검색';query.setAttribute('aria-label','묶음 매장 검색');panel.append(query);
    // Region clusters keep their zoom action, with co-located stores reachable first.
    if(!sameLocation){
      const groups=[...locations.values()].filter(items=>items.length>1).sort((a,b)=>b.length-a.length);
      if(groups.length){
        const groupList=document.createElement('div');groupList.className='clusterLocationGroups';groupList.setAttribute('aria-label','같은 위치 매장 묶음');
        for(const items of groups){
          const button=document.createElement('button');button.type='button';button.textContent=`같은 위치 · ${items.length}개 매장 · ${items[0].customerName||items[0].customerCode}`;
          button.onclick=()=>showCluster({lat:items[0].lat,lng:items[0].lng,clusterLabel:'같은 위치',clusterRows:items,clusterVehicles:[...new Set(items.map(item=>item.vehicle||item.baseVehicle).filter(Boolean))]});groupList.append(button);
        }
        panel.append(groupList);
      }
    }
    const list=document.createElement('div');list.className='clusterMemberList';panel.append(list);
    const more=document.createElement('button');more.type='button';more.textContent='더 보기';panel.append(more);
    let limit=40;
    function paint(){
      const q=query.value.trim().toLocaleLowerCase('ko');const matches=members.filter(item=>[item.customerCode,item.customerName,item.address,item.vehicle].join(' ').toLocaleLowerCase('ko').includes(q));
      list.replaceChildren();
      for(const item of matches.slice(0,limit)){
        const button=document.createElement('button');button.type='button';button.dataset.clusterCode=item.customerCode;
        const code=document.createElement('span');code.className='clusterMemberCode';code.textContent=item.customerCode;
        const name=document.createElement('strong');name.textContent=item.customerName||item.customerCode;
        const meta=document.createElement('small');meta.textContent=[vehicleLabel(item.vehicle||item.baseVehicle),item.address].filter(Boolean).join(' · ');
        button.append(code,name,meta);button.onclick=()=>{closeClusterPanel();selectStore(item,null,true);};list.append(button);
      }
      if(!matches.length){const empty=document.createElement('p');empty.textContent='일치하는 매장이 없습니다.';list.append(empty);}
      more.hidden=matches.length<=limit;more.textContent=`더 보기 (${Math.min(limit,matches.length)}/${matches.length})`;
    }
    query.oninput=()=>{limit=40;paint();};more.onclick=()=>{limit+=40;paint();};
    panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.stopPropagation();closeClusterPanel();}});
    clusterPanel=panel;paint();
    if(sameLocation)anchorClusterPanel(panel,{lat:members[0].lat,lng:members[0].lng});
    else ($('#map').parentElement||document.body).append(panel);
  }

  function selectStoreMarker(row,element){
    // A selected/nav-protected store can sit above its same-location cluster.
    // Let that real pin expose the complete customer-code group as well.
    if(state.mode==='BASE_60D'&&row.customerCode&&Number.isFinite(row.lat)&&Math.abs(row.lat)<=90&&Number.isFinite(row.lng)&&Math.abs(row.lng)<=180){
      const members=[],codes=new Set();
      for(const item of [row,...state.currentRows]){
        if(!item.customerCode||item.virtual||item.representative||item.nearbyVehicle||item.clusterCount||item.lat!==row.lat||item.lng!==row.lng)continue;
        const code=String(item.customerCode);if(codes.has(code))continue;codes.add(code);members.push(item);
      }
      if(members.length>1){
        showCluster({lat:row.lat,lng:row.lng,clusterLabel:'같은 위치',clusterRows:members,clusterVehicles:[...new Set(members.map(item=>item.vehicle||item.baseVehicle).filter(Boolean))]});return;
      }
    }
    selectStore(row,element,false);
  }

  function markerElement(row, index, kind) {
    const button = document.createElement("button");
    const completed = state.mode === "DATE_ROUTE" && row.status === "COMPLETED";
    const pending = state.mode === "DATE_ROUTE" && row.status && !completed;
    const compact = kind === "store" && !index;
    button.className = `marker${completed ? " done" : pending ? " pending" : ""}${kind === "virtual" ? " virtual" : ""}${kind === "nearbyVehicle" ? " nearbyVehicle" : ""}${compact ? " storeDot" : ""}`;
    button.dataset.customerCode = row.customerCode || "";
    if(row.deliveryId)button.dataset.deliveryId=row.deliveryId;
    button.dataset.coordinateSource=row.coordinateSource||'';
    button.dataset.vehicle = row.vehicle || "";
    button.title = `${row.vehicle ? vehicleLabel(row.vehicle) + " · " : ""}${row.customerName || row.address || ""}`;
    button.dataset.masterCheckedAt=row.baseVehicleCheckedAt||'';button.dataset.masterStale=String(row.baseVehicleStale===true);
    button.setAttribute("aria-label", state.mode === "BASE_60D" ? button.title : `${button.title} · ${completed ? "완료" : pending ? "미완료" : "상태 미확인"}`);
    if (row.customerCode && runVisitId(row) === runVisitId(state.selected)) button.classList.add("selected");
    const pinColor=row.clusterCount?(window.MapViewPolicy.regionColors[row.clusterColorKey]||vehicleColor(row.vehicle)):vehicleColor(row.vehicle);
    button.style.setProperty('--pin-color',pinColor);
    const label = kind === "virtual" ? "임시" : index || (["representative", "nearbyVehicle"].includes(kind) ? row.vehicle : "");
    if (kind === "store" && state.mode === "BASE_60D") button.classList.add("store");
    button.innerHTML = `<svg class="pinShape" viewBox="0 0 28 34" aria-hidden="true"><path d="M14 1C6.8 1 1 6.8 1 14C1 23 14 34 14 34S27 23 27 14C27 6.8 21.2 1 14 1Z"/></svg><span class="pinNumber">${esc(kind === "store" && state.mode === "BASE_60D" ? row.vehicle || '?' : label)}</span><span class="markerLabel">${esc(button.title)}</span>`;
    button.onclick = () => row.virtual ? showNearbyReference(row) : row.representative || row.nearbyVehicle ? selectVehicleStatus(row, button) : selectStoreMarker(row, button);
    if (row.clusterCount) {
      button.classList.add("periodCluster");
      button.querySelector(".pinNumber").textContent = String(row.clusterCount);
      button.setAttribute("aria-label", (row.clusterLabel||"권역")+" · "+row.clusterCount + "개 매장 · 목록 보기");
      button.onclick = () => showCluster(row);
    }
    if(kind!=='virtual'&&document.body.classList.contains('approvedShellCandidate')){
      const pin=document.createElement('div');pin.className=row.clusterCount?'clusterpin':'pin';
      pin.style.setProperty('--pin',pinColor);
      const number=document.createElement(row.clusterCount?'b':'span');number.textContent=String(row.clusterCount?(row.clusterLabel||'매장'):row.vehicle||'•');pin.append(number);
      if(!row.clusterCount&&index)pin.title=`${vehicleLabel(row.vehicle)||'호차 정보 없음'} · 착순 ${index}`;
      if(row.clusterCount){const small=document.createElement('small');small.textContent=row.clusterCount+'개 매장';pin.append(small);}
      button.classList.add('approvedMarker');button.replaceChildren(pin);
    }
    if(window.MapNavigationEditor?.values?.().includes(row.customerCode))button.classList.add('navAssigned');
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
      customerName: `${vehicleLabel(vehicle)} · ${stores.length}개 매장`,
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
    if (dataChanged || !pointIndex) { markerSourceVersion++;indexedRows = rows; pointIndex = MapPeriodUi.spatialIndex(rows); }
    if (!options.viewportOnly) { state.lines.forEach(line => line.setMap(null)); state.lines = []; }
    const mapBounds = state.map.getBounds?.();
    const sw = mapBounds?.getSouthWest(), ne = mapBounds?.getNorthEast();
    const marginLat = sw && (ne.getLat()-sw.getLat())*.15, marginLng = sw && (ne.getLng()-sw.getLng())*.15;
    let valid = pointIndex.valid;
    // Cluster membership is geographic and independent of panning/viewport size.
    if (state.mode!=='DATE_ROUTE' && state.selected && Number.isFinite(state.selected.lat) && Number.isFinite(state.selected.lng)
      && !valid.some(row => row.customerCode === state.selected.customerCode)) valid=[...valid,state.selected];
    const bounds = new kakao.maps.LatLngBounds();
    const navCodes=window.MapNavigationEditor?.values?.().filter(Boolean)||[];
    // Overview: one selectable pin per hocha, never one synthetic badge that
    // hides multiple vehicles. Focus: every actual store pin (same-coordinate
    // stores remain reachable through the co-located store selector).
    const chosenVehicles = selectedVehicles();
    const vehicleOverview = state.mode!=='DATE_ROUTE' && periodBasis === 'vehicle' &&
      (periodVehicleScope === 'all' || chosenVehicles.length > 1);
    const focusedStops = state.mode==='DATE_ROUTE' && chosenVehicles.length===1 || !vehicleOverview &&
      ((periodBasis === 'vehicle' && periodVehicleScope === 'selected' && chosenVehicles.length === 1)
        || (state.mode === 'DATE_ROUTE' && periodBasis === 'driver'));
    const projectPin = row => state.map.getProjection().containerPointFromCoords(new kakao.maps.LatLng(row.lat,row.lng));
    const viewport = state.fitRequested ? null : {width:$('#map').clientWidth,height:$('#map').clientHeight};
    const protectedOverviewCodes = new Set([...navCodes, state.selected?.customerCode].filter(Boolean));
    const representatives = vehicleOverview ? representativeRows(valid) : [];
    const readyOverview = vehicleOverview && (representatives.length || state.mode!=='BASE_60D'||baseVehicleStatus==='READY');
    const markerSource = readyOverview
      ? [...representatives, ...valid.filter(row => protectedOverviewCodes.has(row.customerCode))]
      : valid;
    const pins = readyOverview
      ? markerSource.filter(row => {
          if (!viewport) return true;
          if (protectedOverviewCodes.has(row.customerCode)) return true;
          const p = projectPin(row);
          return Number.isFinite(p?.x) && Number.isFinite(p?.y) &&
            p.x >= -80 && p.y >= -80 && p.x <= viewport.width + 80 && p.y <= viewport.height + 80;
        })
      : window.MapViewPolicy.stableClusters(markerSource, projectPin,
          state.map.getLevel(), state.selected?.customerCode, viewport,
          {mode:state.mode,maxMarkers:innerWidth<=760?120:180,
            grouping:focusedStops?'individual':'territory',
            protectedCodes:navCodes,sourceVersion:markerSourceVersion});
    const osanCenter=state.fitRequested&&window.MapNavigationLookup?.registeredCenters?.().find(row=>row.id==='osan');
    if (state.fitRequested) {
      if(osanCenter)bounds.extend(new kakao.maps.LatLng(osanCenter.lat,osanCenter.lng));
      pointIndex.valid.forEach(row => bounds.extend(new kakao.maps.LatLng(row.lat,row.lng)));
    }
    const entries = pins.map((row,index) => ({row,index,key:row.clusterKey||[row.virtual?'virtual':'store',runVisitId(row),row.lat,row.lng].join('|'),
      fingerprint:JSON.stringify([row.lat,row.lng,row.clusterBounds,row.clusterMemberKey,row.vehicle,row.customerName,row.address,row.status,row.order,row.clusterCount,row.lastDeliveryDate,row.visitCount,row.driverKey,row.clusterLabel,row.clusterColorKey,state.selected?.customerCode===row.customerCode,navCodes.includes(row.customerCode),Boolean(options.numbered),Boolean(row.virtual),Boolean(row.representative),Boolean(row.nearbyVehicle),state.mode,state.rangeStart,state.rangeEnd])}));
    const reconciled = MapPeriodUi.reconcile(markerEntries, entries, ({row,index}) => {
      const position = new kakao.maps.LatLng(Number(row.lat), Number(row.lng));
      bounds.extend(position);
      const overlay = new kakao.maps.CustomOverlay({
        position,
        clickable: true,
        content: markerElement(row, options.numbered ? Number(row.order) || '—' : null, row.virtual ? "virtual" : row.nearbyVehicle ? "nearbyVehicle" : row.representative ? "representative" : "store"),
        xAnchor: .5,
        yAnchor: 1,
        zIndex: row.customerCode&&row.customerCode===state.selected?.customerCode ? 40 : navCodes.includes(row.customerCode)?25:row.virtual?15:row.clusterCount?3:5
      });
      overlay.setMap(state.map);
      return overlay;
    }, overlay => overlay.setMap(null));
    markerEntries = reconciled.next;
    state.overlays = [...markerEntries.values()].map(entry=>entry.value);
    const mobileRoute = innerWidth <= 760 && options.numbered;
    if ((pointIndex.valid.length || osanCenter) && state.fitRequested && !state.userMovedMap) {
      state.suppressMapEventsUntil = Date.now() + 700;
      mapCamera?.relayout();
      state.map.setBounds(bounds, mobileRoute ? 130 : 55, 40, mobileRoute ? 260 : 55, 40);
      state.fitRequested = false;
    }
    if(state.userMovedMap)state.fitRequested=false;
    renderMetrics.renders++; renderMetrics.created+=reconciled.created; renderMetrics.removed+=reconciled.removed; renderMetrics.reused+=reconciled.reused;
    renderMetrics.lastMs=+(performance.now()-started).toFixed(2);
    if(markerEntries.size&&renderMetrics.firstMs===undefined){
      renderMetrics.firstMs=renderMetrics.lastMs;
      performance.mark('opsmap-first-markers');
      requestAnimationFrame(()=>{
        if(document.body.dataset.mapStaffState!=='authenticated'||!markerEntries.size)return;
        const mark=name=>Math.round(performance.getEntriesByName('opsmap-'+name).at(-1)?.startTime)||null;
        const nav=performance.getEntriesByType('navigation')[0];
        $('#map').dataset.bootMetrics=JSON.stringify({serverResponse:Math.round(nav?.responseStart)||null,
          authentication:mark('staff-verified'),uiReady:mark('staff-ready'),snapshot:mark('snapshot-ready'),snapshotRequest:apiDiagnostics.get('snapshot')?.ms??null,
          restore:apiDiagnostics.get('snapshot')?.restoreMs??null,sdkRequest:mark('sdk-request'),sdkStart:mark('sdk-start'),sdk:mark('sdk-ready'),
          firstPin:Math.round(performance.now()),pinRender:renderMetrics.firstMs,
          active:markerEntries.size,sourceRows:state.currentRows.length});
      });
    }
    $("#map").setAttribute('data-render-metrics',JSON.stringify({...renderMetrics,sourceRows:rows.length,active:markerEntries.size}));
  }

  function clearActualRoute() {
    if(!actualRouteLayer)return;
    actualRouteLayer.items.forEach(item=>item.setMap(null));
    actualRouteLayer.info?.close();
    actualRouteLayer=null;
  }
  function drawRoute() {
    const vehicles=selectedVehicles();
    const points=state.map&&isDailyDataReady()&&vehicles.length===1 ? visibleActualPoints() : [];
    const key=JSON.stringify([state.selectedDate,...points.map(({row,at})=>[runVisitId(row),row.customerName,row.lat,row.lng,at])]);
    if(actualRouteLayer?.key===key)return;
    clearActualRoute();
    if(points.length<2)return;
    const path=points.map(({row})=>new kakao.maps.LatLng(row.lat,row.lng));
    const info=new kakao.maps.InfoWindow({removable:true,zIndex:20});
    const items=[];
    const open=(indices,position)=>{
      info.setContent('<div style="padding:8px;font-size:12px"><b>실제 완료 시각 순 직선 동선</b>'+indices.map(index=>{
        const {row,at}=points[index];
        return '<div>'+esc(index===0?'시작':index===points.length-1?'종료':'경유')+' · '+esc(row.customerName)+' ('+esc(row.customerCode)+') · '+esc(formatTime(at,true))+'</div>';
      }).join('')+'</div>');
      info.setPosition(position);info.open(state.map);
    };
    for(let i=1;i<path.length;i++){
      const line=new kakao.maps.Polyline({map:state.map,path:[path[i-1],path[i]],strokeWeight:5,strokeColor:'#087985',strokeOpacity:.9,strokeStyle:'solid',zIndex:3});
      kakao.maps.event.addListener(line,'click',event=>open([i-1,i],event?.latLng||path[i]));
      items.push(line);
    }
    for(const index of [0,path.length-1]){
      const badge=document.createElement('button');
      badge.type='button';badge.textContent=index?'종료':'시작';
      badge.style.cssText='border:1px solid #fff;border-radius:5px;background:'+(index?'#9f1239':'#06626d')+';color:#fff;padding:3px 6px';
      badge.onclick=()=>open([index],path[index]);
      items.push(new kakao.maps.CustomOverlay({map:state.map,position:path[index],content:badge,yAnchor:1.8,zIndex:9,clickable:true}));
    }
    actualRouteLayer={key,items,info};
  }

  function scheduleDetailPosition() {
    if (!detailFrame) detailFrame=requestAnimationFrame(()=>{detailFrame=null;positionDetailPopup();});
  }
  function positionDetailPopup() {
    // Screen-space right panel: map projection and zoom never set panel geometry.
    window.MapDotUi?.dockDetail();mapCamera?.scheduleFocus();
  }

  function focusMapPoint(row,{zoom=false,key=''}={}) {
    if(!state.map||numberOrNull(row.lat)===null||numberOrNull(row.lng)===null)return;
    state.fitRequested=false;state.suppressMapEventsUntil=Date.now()+700;
    if(zoom&&state.map.getLevel()>5)state.map.setLevel(5);
    const point=new kakao.maps.LatLng(Number(row.lat),Number(row.lng));
    if(!mapCamera?.focus(point,{key:key||row.customerCode||row.vehicle||'selection'}))state.map.panTo(point);
  }

  function coordinateEvidenceLabel(row) {
    if (numberOrNull(row.lat) === null || numberOrNull(row.lng) === null) return '';
    if (row.coordinateSource === 'MANUAL_PIN') return '사용자 수동 확정 위치 · 원본 주소 보존';
    if (row.coordinateEvidence === 'DELIVERY_COMPLETION_GPS') return '배송 완료 GPS 위치 · 출입구 위치 미검증';
    if (row.coordinateSource === 'BUILDING_VERIFIED' && row.coordinateEvidence === 'BUILDING_LOCATION') return '공공 데이터로 확인한 건물 위치';
    if (row.coordinateSource === 'ADDRESS_REPRESENTATIVE' && row.coordinateEvidence === 'ADDRESS_LOCATION') return '공공 데이터의 주소 대표 위치';
    if (row.coordinateSource === 'VERIFIED_STORE_POINT') return '검증된 저장 위치';
    if (['KAKAO_ADDRESS_LIVE','KAKAO_BUILDING_EXACT_ADDRESS','KAKAO_VERIFIED_BUILDING','KAKAO_ADDRESS_REVALIDATION'].includes(row.coordinateSource)) return '주소 기준 위치';
    if (row.coordinateSource === 'HISTORICAL_GPS_SAME_BUILDING') return '동일 주소의 저장 위치';
    return '';
  }
  function refreshCoordinateEvidence(row) {
    const body = $('#detail .detailBody');
    if (!body) return;
    body.querySelectorAll('.coordinateEvidence,.coordinateWarning').forEach(node => node.remove());
    const unlocated = row.coordinateStatus === 'CONFLICT' || numberOrNull(row.lat) === null || numberOrNull(row.lng) === null;
    const text = unlocated ? '위치 확인 필요' : coordinateEvidenceLabel(row);
    body.querySelectorAll('[data-nav-pick]').forEach(button => button.disabled = !window.MapNavigationLookup?.located(row));
    if (!text) return;
    const node = document.createElement('div');
    node.className = unlocated ? 'coordinateWarning' : 'coordinateEvidence';
    node.textContent = text;
    const actions = body.querySelector('.mobileActions');
    if (actions) body.insertBefore(node, actions); else body.append(node);
  }

  function navigationPointActions(row){
    if(!window.MapNavigation)return '';
    const disabled=window.MapNavigationLookup.located(row)?'':' disabled';
    return '<div class="navPickActions" role="group" aria-label="경로 지점 지정">'+
      [['origin','출발'],['waypoint','경유'],['destination','도착']].map(([role,label])=>'<button type="button" data-nav-pick="'+role+'"'+disabled+'>'+label+'</button>').join('')+'</div><p data-nav-feedback role="status"></p>';
  }

  function selectStore(row, element, focus, skipEnrich = false, trace) {
    if(!row.virtual){if(!unifiedSelectionActive)invalidateUnifiedSearch();if(typeof clearSearchTemporaryPin==='function')clearSearchTemporaryPin({restoreView:false});closeUnifiedSearchResults();}
    ++cameraSelection;
    closeClusterPanel();
    ++state.detailRequestId;requestControllers.get("store-detail")?.controller.abort("superseded");
    window.MapStaff?.clear();selectedDriverContact?.clear();
    const routeStop = state.mode === "DATE_ROUTE" && operationStops.find((stop) => stop.customerCode === row.customerCode && stop.vehicle === row.vehicle);
    if (routeStop) row = { ...row, ...routeStop, ...Object.fromEntries(["accessInfo", "accessMemo", "password", "detailAddress", "specialRemark"].filter((key) => row[key]).map((key) => [key, row[key]])) };
    // Search and dated stops may be fresh copies of the stored source rows.
    // Apply the confirmed overlay again before rendering their coordinate origin.
    window.MapManualPins?.apply(row);
    applyUnifiedSearchCoordinateGuard(row);
    liveAddressLocations?.apply(row);
    const expanded = state.selected?.customerCode === row.customerCode && $(".detailMore")?.open;
    $$(".marker.selected").forEach((item) => item.classList.remove("selected"));
    element?.classList.add("selected");
    state.selected = row;window.dispatchEvent(new CustomEvent('map-store-selected',{detail:{customerCode:row.customerCode}}));
    $$("[data-search-code]").forEach(button => {
      const active = button.dataset.searchCode === row.customerCode;
      button.classList.toggle("selected", active); button.setAttribute("aria-pressed", String(active));
    });
    $$(".marker").forEach((pin) => pin.classList.toggle("selected", Boolean(row.customerCode) && (row.deliveryId ? pin.dataset.deliveryId === row.deliveryId : pin.dataset.customerCode === row.customerCode && pin.dataset.vehicle === row.vehicle)));
    if (!trace) renderRunList();
    if (state.mode === "BASE_60D") {
      if (!trace) renderPeriodStoreList();
      $$("[data-period-store]").forEach(button => { const active = button.dataset.periodStore === row.customerCode; button.classList.toggle("selected", active); button.setAttribute("aria-pressed", String(active)); });
      if (element?.classList.contains("marker")) scrollSelectedInside('#periodStoreList','.periodStore.selected');
    }
    if (element?.classList.contains("marker")) scrollSelectedInside('#runList','.runStop.selected');
    const unlocated = numberOrNull(row.lat) === null || numberOrNull(row.lng) === null;
    trace?.mark('coordinates');
    if (trace && !unlocated) { focusMapPoint(row,{zoom:focus}); trace.mark('map'); }
    if (unlocated) $("#mapStatusSub").textContent = "좌표 미확인 · 지도 위치를 변경하지 않습니다.";
    addressFocusRequest=unlocated?{code:row.customerCode,interaction:mapCamera?.interaction()}:null;
    // Rebuild the selected entry in both views, even if it was inside a cluster
    // or outside the current vehicle filter. Its overlay must be above peers.
    if(state.map&&!unlocated){state.fitRequested=false;renderStops(state.currentRows,{viewportOnly:true,numbered:state.mode==='DATE_ROUTE'});}
    trace?.mark('pin');
    const routeMode = state.mode === "DATE_ROUTE";
    const vehicle = normalizeVehicle(row.vehicle);
    const detailDriver=storeDriverDetail(row);
    const detailCenter=window.MapLocationContract?.dispatchCenter(row).label||'담당 센터 미확인';
    const detailAddressRegion=row.addressRegion||window.MapLocationContract?.addressRegion(row.address)||'주소 권역 미확인';
    const orderCard = routeMode && row.order ? `<div class="stat"><strong>${esc(row.order)}</strong><span>착순</span></div>` : "";
    const statusCard = row.status ? `<div class="stat"><strong>${row.status === "COMPLETED" ? "완료" : "잔여"}</strong><span>상태</span></div>` : "";
    $("#detailSection").classList.add("open");
    $("#detail").className = "detailCard";
    if($("#detail").contains($("#staffAuxContent")))$("#detailSection").append($("#staffAuxContent"));
    $("#detail").innerHTML = `<div class="detailHead"><button id="detailClose" class="detailClose" aria-label="닫기">×</button><div class="code">${esc(row.customerCode || "신규 주소")}</div><div class="storeName">${esc(row.customerName || "선택 위치")}</div></div>
      <div class="detailBody">
        <dl class="dotDetailFacts"><dt>담당 센터</dt><dd>${esc(detailCenter)}</dd><dt hidden>주소 권역</dt><dd id="detailAddressRegion" hidden>${esc(detailAddressRegion)}</dd><dt>${routeMode?"확정호차":"기준호차"}</dt><dd${routeMode?'':' id="detailBaseVehicle"'}>${esc(routeMode?vehicleLabel(vehicle)||'선택일 편성 없음':MapPeriodUi.baseVehicleLabel(row))}</dd><dt id="detailDeliveryDaysLabel" hidden>배송요일</dt><dd id="detailDeliveryDaysValue" hidden></dd><dt id="detailDriverLabel">${esc(detailDriver.label)}</dt><dd id="detailDriver" title="${esc(detailDriver.title)}" data-source="${esc(detailDriver.source)}">${esc(detailDriver.text)}</dd><dt>주소</dt><dd>${esc(row.address||'주소 불러오는 중…')}</dd><dt id="detailAddressLabel" hidden>상세주소</dt><dd id="detailAddressValue" hidden></dd></dl>

        ${navigationPointActions(row)}
        <div class="staffActions"><button id="staffNotes" aria-expanded="false" aria-controls="staffAuxContent">출입배송정보 ▸</button><button id="staffHistory" aria-expanded="false" aria-controls="staffAuxContent">최근 배송기사이력 ▸</button></div>
        ${!routeMode && row.history?.length ? `<div class="periodRecent">최근배송 ${esc(row.lastDeliveryDate)} · ${row.visitCount===null?'전체 기간 횟수 미확인':(row.visitCount??row.history.length)+'회 이력'}</div>` : ""}
        <div class="mobileActions"><button id="mobileMapView" class="primary">매장 위치 중심으로 보기</button><button id="mobileRouteView" class="ghost">${esc(vehicleLabel(vehicle) || "선택 호차")} 운행동선</button></div>
        <div id="nearWrap"></div>
      </div>`;
    refreshCoordinateEvidence(row);
    refreshSelectedDriverContact();
    requestAnimationFrame(positionDetailPopup);
    $(".detailMore")?.addEventListener("toggle", positionDetailPopup);
    const openStaff = kind => {const trigger=kind==='history'?$("#staffHistory"):$("#staffNotes");trigger.after($("#staffAuxContent"));window.MapStaff?.open({ kind, current:kind==='notes'&&!routeMode, customerCode: row.customerCode, date: routeMode ? state.selectedDate : row.lastDeliveryDate || state.selectedDate,
      rangeStart: routeMode ? daysBefore(state.selectedDate, 59) : state.rangeStart, rangeEnd: routeMode ? state.selectedDate : state.rangeEnd }, $("#staffAuxContent"), trigger);positionDetailPopup();};
    $("#staffHistory")?.addEventListener("click", () => openStaff("history"));
    $("#staffNotes")?.addEventListener("click", () => openStaff("notes"));
    if (innerWidth <= 760) { showMobileMap(); $("#mobileWorkspace").classList.add("collapsed"); }
    $("#detailClose")?.addEventListener("click", clearSelection);
    if ((routeMode || row.virtual) && numberOrNull(row.lat) !== null && numberOrNull(row.lng) !== null) renderNearest(row);
    $("#mobileMapView")?.addEventListener("click", () => {showMobileMap();if(Number.isFinite(row.lat)&&Number.isFinite(row.lng))focusMapPoint(row);});
    $("#mobileRouteView")?.addEventListener("click", () => {
      if (vehicle && [...$("#mobileVehicle").options].some((option) => option.value === vehicle)) $("#mobileVehicle").value = vehicle;
      setSelectedVehicles(vehicle ? [vehicle] : []); refreshVehicleUi(true);
      showMobileMap(); activateSheet("runs");
    });
    if(!unlocated&&!trace)focusMapPoint(row,{zoom:focus});
    trace?.mark('detail');
    if (!skipEnrich && row.customerCode) {
      if (trace) afterSearchPaint(()=>{if(state.selected===row)void enrichStoreDetail(row,element);});
      else enrichStoreDetail(row, element);
    }
    if(row.customerCode)liveAddressLocations?.schedule([row],{priority:true});
  }

  async function enrichStoreDetail(row, element) {
    const requestId = ++state.detailRequestId, detailMode=state.mode, detailVehicle=row.vehicle;
    try {
      const detailDate = detailMode === 'DATE_ROUTE' ? state.selectedDate : row.lastDeliveryDate || snapshotMeta?.latestDate || state.latestDate || state.selectedDate;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(detailDate || '') || !Number.isFinite(Date.parse(detailDate)) || new Date(detailDate).toISOString().slice(0,10)!==detailDate) throw Error('DETAIL_DATE_UNCONFIRMED');
      const payload = await fetchJson(`/api/map-phase2b/private/customer-detail?view=store&customerCode=${encodeURIComponent(row.customerCode)}&date=${detailDate}`, { channel: "store-detail", ttl: 0, timeout: 60000 });
      if (requestId !== state.detailRequestId || state.mode!==detailMode || state.selected?.customerCode !== row.customerCode || detailMode==='DATE_ROUTE'&&state.selected?.vehicle!==detailVehicle || document.body.dataset.mapStaffState!=='authenticated') return;
      const exact = payload.data;
      if (!Phase2bUi.storeDetailMatches(exact,row.customerCode,detailDate)) throw Error('DETAIL_RESPONSE_CONTRACT');
      liveAddressLocations?.acceptAddress(row,exact);liveAddressLocations?.schedule([row],{priority:true});
      // DOM only: never merge Customer addresses into rows, public summaries or IndexedDB.
      const title=$('#detail .storeName');if(title&&exact.customerName)title.textContent=exact.customerName;
      const facts=$('#detail .dotDetailFacts');
      const addressLabel=facts&&[...facts.querySelectorAll('dt')].find(node=>node.textContent==='주소');
      if(addressLabel?.nextElementSibling)addressLabel.nextElementSibling.textContent=exact.address||'주소 미확인';
      const regionNode=$('#detailAddressRegion');if(regionNode)regionNode.textContent=exact.addressRegion||window.MapLocationContract?.addressRegion(exact.address)||'주소 권역 미확인';
      if(facts){
        const detailAddress=String(exact.detailAddress||'').trim();
        const detailAddressLabel=$('#detailAddressLabel'),detailAddressValue=$('#detailAddressValue');
        if(detailAddressLabel&&detailAddressValue){detailAddressLabel.hidden=detailAddressValue.hidden=!detailAddress;detailAddressValue.textContent=detailAddress;}
        // Mon~Sun fixed-dispatch values are vehicle assignments, never delivery weekdays.
        const pattern=typeof exact.deliveryPattern==='string'?exact.deliveryPattern.trim():'';
        const days=['CURRENT_CUSTOMER_LOOKUP','DATED_CUSTOMER_LOOKUP'].includes(exact.sourceBasis)&&exact.locationState==='SOURCE_ROW'&&!/^(?:미확인|확인\s*필요|unknown|unconfirmed|[-—])$/i.test(pattern)?pattern:'';
        const daysLabel=$('#detailDeliveryDaysLabel'),daysValue=$('#detailDeliveryDaysValue');
        if(daysLabel&&daysValue){daysLabel.hidden=daysValue.hidden=!days;daysValue.textContent=days;}
        facts.dataset.deliveryPattern=exact.deliveryPattern||'';facts.dataset.detailAddressState=exact.detailAddressState||'';
        facts.dataset.sourceBasis=exact.sourceBasis||'';facts.dataset.sourceDate=exact.sourceDate||'';
      }
      positionDetailPopup();
    } catch (error) {
      if (isSilentRequestError(error) || requestId!==state.detailRequestId || state.selected?.customerCode!==row.customerCode || document.body.dataset.mapStaffState!=='authenticated') return;
      const label=[...($('#detail .dotDetailFacts')?.querySelectorAll('dt')||[])].find(node=>node.textContent==='주소');
      if(label?.nextElementSibling&&!row.address)label.nextElementSibling.textContent='주소 조회 지연 · 다시 선택하면 재시도합니다.';
    }
  }

  function scrollSelectedInside(containerSelector,rowSelector){
    requestAnimationFrame(()=>{const container=$(containerSelector),row=$(rowSelector);if(!container||!row)return;
      const a=container.getBoundingClientRect(),b=row.getBoundingClientRect();
      if(b.top<a.top)container.scrollTop+=b.top-a.top;else if(b.bottom>a.bottom)container.scrollTop+=b.bottom-a.bottom;
    });
  }

  async function selectVehicleStatus(row, element) {
    closeClusterPanel();
    $$(".marker.selected").forEach((item) => item.classList.remove("selected"));
    element?.classList.add("selected");
    const vehicle = normalizeVehicle(row.vehicle),focusOwner=++cameraSelection,focusInteraction=mapCamera?.interaction();
    const focusRepresentative=()=>{if(focusOwner===cameraSelection&&focusInteraction===mapCamera?.interaction()&&selectedVehicles().includes(vehicle))focusMapPoint(row,{key:'vehicle:'+vehicle});};
    if (state.mode === 'BASE_60D') {
      // A baseline hocha pin must show all of its stored shops. The historical
      // period view has no confirmed stop order: do not invent a road route.
      periodBasis = 'vehicle'; periodVehicleScope = 'selected'; syncPeriodBasis();
      setSelectedVehicles([vehicle]);
      if ([...$('#mobileBaseVehicle').options].some(option => option.value === vehicle)) $('#mobileBaseVehicle').value = vehicle;
      refreshVehicleUi(false); requestMapFit(); await loadBaseMap();
      $('#mapStatusSub').textContent = `${vehicleLabel(vehicle)} 전체 매장 · 실제 운행순서는 일자별 운행에서 확인`;
      focusRepresentative();return;
    }
    if (selectedVehicles().length !== 1 || selectedVehicles()[0] !== vehicle) {
      setSelectedVehicles([vehicle]);
      if ([...$('#mobileBaseVehicle').options].some(option => option.value === vehicle)) $('#mobileBaseVehicle').value = vehicle;
      refreshVehicleUi(false); requestMapFit(); await loadBaseMap();
    }
    $('#operationVehicle').value = vehicle;
    await loadOperationStatus(vehicle, true, row);focusRepresentative();
  }



  function renderVehiclePanel(vehicle, status, row, error = "") {
    window.MapStaff?.clear();selectedDriverContact?.clear();
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

  function renderRunList() {
    const selectedVehicle = primarySelectedVehicle();
    if ($("#runListTitle")) $("#runListTitle").textContent = selectedVehicle ? `${selectedVehicle}호 운행 목록` : "운행 목록";
    if ($("#selectedVehicleBadge")) $("#selectedVehicleBadge").textContent = selectedVehicle ? `선택 호차: ${selectedVehicle}호` : "호차 선택";
    if ($("#runListTool")) $("#runListTool").hidden = state.mode!=='DATE_ROUTE';
    const archived = archivedDatedAssignments(dailyMeta);
    const list = isDailyDataReady() ? operationStops : [];
    const {shown} = window.OpsmapDaily?.projection(list,runFilter) || {shown:list};
    const archiveLabel = dailyMeta?.recordKind === 'CUSTOMER_DAILY_ROUTES' ? '저장 배차' : '보존 완료 기록';
    const route=dailyMeta?.roster&&currentRosterRoute();
    const ties=route&&route.saved.chronologies.get(route.key)?.tiedCount;
    const archiveScope=dailyMeta?.vehicles?.length ? ' · 확인 범위 '+dailyMeta.vehicles.length+'대' : '';
    $("#runListCount").textContent = archived ? `${archiveLabel} ${shown.length}곳${archiveScope}` : list.length ? `${shown.length}/${list.length}착` : verifiedEmptyDailyScope() ? '0착' : '배송지 수 미확인';
    if(ties)$("#runListCount").textContent+=" · 동일 시각 "+ties+"착 순서 미확정";
    const emptyText=list.length ? '선택한 상태의 배송지가 없습니다.' :
      dailyMeta?.roster&&!verifiedEmptyDailyScope()?'선택 범위의 착지 수를 확인하지 못했습니다.':
      !isDailyDataReady()?'날짜를 선택해 배송지를 조회해 주세요.':'선택한 조건의 배송지가 없습니다.';
    $("#runList").innerHTML = shown.length ? shown.map(row => {
      const selected = runVisitId(state.selected) === runVisitId(row);
      return `<button class="runStop${selected ? " selected" : ""}" data-run-code="${esc(row.customerCode)}" data-run-vehicle="${esc(row.vehicle)}" data-run-visit="${esc(runVisitId(row))}" aria-pressed="${selected}"><span class="runOrder">${esc(row.order || "-")}</span><span class="runInfo"><span class="runCode">${esc(row.customerCode)}</span><div class="runName">${esc(row.customerName || "점포명 미확인")}</div><span class="runMeta"><span class="statusChip ${row.status === "COMPLETED" ? "done" : ""}">${row.status === "COMPLETED" ? "완료" : row.status === "PENDING" ? "미완료" : "상태 미확인"}</span><span>${esc(formatTime(row.actualCompletedAt,true) || "-")}</span><span class="runDistance">${row.lat == null || row.lng == null ? "좌표 미확인" : ""}</span></span></span></button>`;
    }).join("") : emptyText;
    const byVisit=new Map(shown.map(row=>[runVisitId(row),row]));
    $$('[data-run-code]').forEach(button=>button.onclick=()=>{
      const row=byVisit.get(button.dataset.runVisit);
      if(row){state.fitRequested=false;selectStore(row,null,true);}
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
    closeClusterPanel();
    if(point?.searchTemporary){renderSearchTemporaryNearby(point,{loadDispatch:false});focusMapPoint(point,{zoom:false,key:'search-temporary'});return;}
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

  function normalizeSearchAddress(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase('ko-KR')
      .replace(/\([^)]*\)|\[[^\]]*\]/g,' ')
      .replace(/서울특별시|서울시/g,'서울').replace(/부산광역시|부산시/g,'부산')
      .replace(/대구광역시|대구시/g,'대구').replace(/인천광역시|인천시/g,'인천')
      .replace(/광주광역시|광주시/g,'광주').replace(/대전광역시|대전시/g,'대전')
      .replace(/울산광역시|울산시/g,'울산').replace(/세종특별자치시|세종시/g,'세종')
      .replace(/경기도/g,'경기').replace(/강원특별자치도|강원도/g,'강원')
      .replace(/충청북도/g,'충북').replace(/충청남도/g,'충남')
      .replace(/전북특별자치도|전라북도/g,'전북').replace(/전라남도/g,'전남')
      .replace(/경상북도/g,'경북').replace(/경상남도/g,'경남')
      .replace(/제주특별자치도|제주도/g,'제주').replace(/[\s,·.]+/g,'');
  }

  function searchTokens(value) { return normalizeSearchText(value).split(" ").filter(Boolean); }

  function rankSearchRow(query) {
    const compact = value => normalizeSearchText(value).replace(/\s/g, '');
    const target = compact(query);
    const tokens = searchTokens(query).map(compact);
    const address = normalizeSearchAddress(query);
    const addressEndsInNumber = /\d$/.test(address);
    return (row, indexed) => {
      if(!target)return 99;
      const code = indexed?.code ?? compact(row.customerCode), name = indexed?.name ?? compact(row.customerName);
      if(code === target)return 0;
      if(name === target)return 1;
      if(name.includes(target))return 2;
      if(code.includes(target))return 3;
      if(tokens.every(token => name.includes(token)))return 4;
      if(address && (indexed?.addresses ?? [row.address,row.customerAddress,row.roadAddress,row.roadNameAddress,row.jibunAddress].filter(Boolean).map(normalizeSearchAddress))
        .some(normalized => {
          const at=normalized.indexOf(address);
          return at>=0&&(!addressEndsInNumber||!/[\d-]/.test(normalized.charAt(at+address.length)));
        }))return 5;
      return 99;
    };
  }

  function rankSearchRows(query) {
    const registryVersion=customerRegistry?.summary().version;
    if (searchIndex?.period!==periodRows || searchIndex?.snapshot!==latestSnapshotRows ||
        searchIndex?.stores!==allStores || searchIndex?.registryVersion!==registryVersion) {
      const records = new Map();
      const currentRows=newAreaRegistryRows();
      for (const source of [currentRows,allStores,periodRows]) for (const value of source) {
        const code=String(value.customerCode||value.code||value.id||'').trim();
        if(!/^[A-Z]\d{3,}$/.test(code))continue;
        const addresses=storeSearchAddresses(value);
        const primaryAddress=normalizeSearchAddress(addresses[0]);
        let entry=records.get(code);
        if(!entry){
          const row=normalizeApiStore(value);
          entry={row,code:code.toLowerCase(),name:normalizeSearchText(row.customerName).replace(/\s/g,''),primaryAddress,addresses:[]};
          records.set(code,entry);
        }else if(entry.primaryAddress&&entry.primaryAddress!==primaryAddress){
          continue;
        }
        for(const address of addresses){
          if(!address)continue;
          const normalized=normalizeSearchAddress(address);
          if(!entry.addresses.includes(normalized))entry.addresses.push(normalized);
        }
      }
      searchIndex={period:periodRows,snapshot:latestSnapshotRows,stores:allStores,registryVersion,records};
    }
    const rank = rankSearchRow(query), matches=[];
    for(const entry of searchIndex.records.values()){
      const priority=rank(entry.row,entry);
      if(priority<99)matches.push({row:entry.row,priority});
    }
    return matches.sort((a,b)=>a.priority-b.priority||naturalCompare(a.row.customerName,b.row.customerName)).slice(0,40).map(item=>item.row);
  }

  function afterSearchPaint(work) { requestAnimationFrame(()=>setTimeout(work,0)); }

  function startSearchTrace() {
    const id=++searchSequence, started=performance.now(), stages={input:Math.round(started-(searchInputAt??started))};
    const mark=phase=>{stages[phase]=Math.round(performance.now()-started);};
    return {mark,finish(kind){
      const publish=()=>{if(id===searchSequence)$('#map').dataset.searchMetrics=JSON.stringify({id,kind,...stages});};
      mark('total');publish();
      requestAnimationFrame(()=>{mark('frame');publish();});
    }};
  }

  function normalizeApiStore(row) {
    const code = String(row.customerCode || row.code || row.id || "").trim();
    const vehicle = normalizeVehicle(row.vehicle || row.confirmedVehicle || row.primaryVehicle90d);
    const local = { ...coordinateByCode.get(code), ...(storeByVehicleAndCode.get(`${vehicle}|${code}`) || storesByCode.get(code) || {}) };
    const liveFallback=local.coordinateSource==='KAKAO_ADDRESS_LIVE'&&(numberOrNull(row.lat??row.latitude)===null||numberOrNull(row.lng??row.longitude)===null);
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
      lastDeliveryDate: row.lastDeliveryDate || row.deliveryDate || local.lastDeliveryDate || "",
      ...(liveFallback?{coordinateSource:'KAKAO_ADDRESS_LIVE',coordinateAccuracy:'BUILDING'}:{})
    };
  }

  function closeUnifiedSearchResults() {
    const results=$('#results');results.replaceChildren();results.hidden=true;
    $('#query').setAttribute('aria-expanded','false');
  }

  function invalidateUnifiedSearch() {
    ++state.searchRequestId;
    unifiedSearchController?.abort('superseded');unifiedSearchController=null;
    searchFlight=null;
    for(const [channel,pending] of requestControllers){
      if(channel.startsWith('unified-') || ['period-search','exact-code-search','hub-search'].includes(channel))pending.controller.abort('superseded');
    }
    return state.searchRequestId;
  }

  function clearUnifiedSearch() {
    if(unifiedResetting)return;
    unifiedResetting=true;
    try{
      invalidateUnifiedSearch();
      if(typeof clearSearchTemporaryPin==='function')clearSearchTemporaryPin({restoreView:false});
      cancelAddressLookup();closeUnifiedSearchResults();
      $('#query').value='';$('#query').dispatchEvent(new Event('input',{bubbles:true}));
      setSearchState('');
      clearSelection({preserveSearch:true});
    }finally{unifiedResetting=false;}
  }

  function selectUnifiedSearchStore(value,{owner=state.searchRequestId,trace}={}) {
    if(owner!==state.searchRequestId || !/^[A-Z]\d{3,}$/.test(String(value?.customerCode||'')))return false;
    const row=normalizeApiStore(value);
    window.MapManualPins?.apply(row);
    if(value.addressChanged===true || value.resolutionStatus==='ADDRESS_CHANGED_REVIEW_REQUIRED' || value.coordinateStatus==='CONFLICT'){
      row.searchAddressConflict=true;
    }
    applyUnifiedSearchCoordinateGuard(row);
    if(!Number.isFinite(row.lat)||!Number.isFinite(row.lng)||row.lat<33||row.lat>39.5||row.lng<124||row.lng>132){row.lat=null;row.lng=null;}
    invalidateUnifiedSearch();closeUnifiedSearchResults();
    const selectedOwner=state.searchRequestId;
    unifiedSelectionActive=true;
    try{selectStore(row,null,true,false,trace);}finally{unifiedSelectionActive=false;}
    setSearchState(row.lat===null?'매장 선택 · 좌표 미확인 · 위치 확인 필요':'매장 선택');
    trace?.finish('store');
    // Fixed-dispatch lookup is optional enrichment, never a barrier to selection.
    const base=baseVehicles.get(row.customerCode);
    if(baseVehicleStatus==='READY'&&baseVehicleMeta?.version&&baseVehicleMeta.stale===false
      &&base?.baseVehicleState==='VERIFIED_MASTER'&&base.baseVehicleStale===false
      &&base.baseVehicleVersion===baseVehicleMeta.version&&base.baseVehicleCheckedAt===baseVehicleMeta.checkedAt)return true;
    afterSearchPaint(()=>{if(selectedOwner!==state.searchRequestId)return;void loadBaseVehicles([row.customerCode]).then(()=>{
      if(selectedOwner===state.searchRequestId && state.selected?.customerCode===row.customerCode)refreshSelectedDriverContact();
    });});
    return true;
  }

  function applyUnifiedSearchCoordinateGuard(row) {
    // A confirmed pin projection may have loaded before Customer changed.
    // Never let its later apply() override a verified search address conflict.
    const verifiedManual=row.coordinateSource==='MANUAL_PIN'&&row.resolutionStatus==='MANUAL_CONFIRMED'&&row.currentAddressHash&&row.manualPinAddressHash===row.currentAddressHash;
    if(!verifiedManual&&(row.searchAddressConflict===true || row.addressChanged===true)){
      row.lat=null;row.lng=null;row.coordinateStatus='CONFLICT';row.resolutionStatus='ADDRESS_CHANGED_REVIEW_REQUIRED';
    }
    return row;
  }

  function renderResults(rows,{owner=state.searchRequestId,trace}={}) {
    if(owner!==state.searchRequestId)return;
    closeUnifiedSearchResults();
    if(rows.length===1){selectUnifiedSearchStore(rows[0],{owner,trace});return;}
    if(!rows.length)return;
    const results=$('#results');results.hidden=false;$('#query').setAttribute('aria-expanded','true');
    results.innerHTML=rows.map((row,index)=>{
      const summary=[row.address||row.customerAddress,window.MapLocationContract?.dispatchCenter?.(row)?.label].filter(Boolean).join(' · ');
      return `<button type="button" class="resultItem" data-result="${index}" data-search-code="${esc(row.customerCode)}" aria-pressed="false"><div class="resultName">${esc(row.customerCode)} · ${esc(row.customerName||'-')}</div><div class="resultMeta">${esc(summary||'주소·센터 확인 필요')}</div></button>`;
    }).join('');
    $$('[data-result]').forEach(button=>button.onclick=()=>selectUnifiedSearchStore(rows[Number(button.dataset.result)],{owner}));
    trace?.finish('matches');
  }

  function unifiedAddressQuery(text) {
    return /(?:대로|로|길|동\d+가|동|리|읍|면|가|번지)\s*(?:(?:산|지하)\s*)?\d/.test(text);
  }

  async function search() {
    const text=$('#query').value.normalize('NFKC').trim();
    if(!text){clearUnifiedSearch();return;}
    if(state.mode!=='BASE_60D')return;
    if(searchFlight?.text===text)return searchFlight.task;
    const trace=startSearchTrace();
    const task=searchPeriod(text,trace).finally(()=>{if(searchFlight?.task===task)searchFlight=null;});
    searchFlight={text,task};
    return task;
  }

  function clearSearchTemporaryPin({restoreView=false}={}) {
    ++state.addressRequestId;
    addressController?.abort();addressController=null;searchTemporaryClick=null;
    newAreaPositionControl?.remove();newAreaPositionControl=null;
    temporaryAreaFacts=null;temporaryAreaSourceVersion=null;temporaryAreaDispatchMeta=null;
    newAreaVehicleKey=null;clearNewAreaDispatchOverlays();
    searchTemporaryOverlay?.setMap(null);searchTemporaryOverlay=null;
    searchTemporaryRadius?.setMap(null);searchTemporaryRadius=null;
    for(const overlay of addressCandidateOverlays)overlay.setMap(null);
    addressCandidateOverlays=[];
    const owned=state.virtual?.searchTemporary===true;
    if(owned){state.virtual=null;mapCamera?.releaseFocus();window.dispatchEvent(new CustomEvent('map-store-selected',{detail:{customerCode:null}}));}
    if(owned&&!state.selected?.customerCode){
      $('#detailSection').classList.remove('open');$('#detail').className='idle';
      $('#detail').textContent='검색하거나 핀을 선택하면 점포정보가 표시됩니다.';
    }
    if($('#results [data-search-address-guide],#results [data-address-candidate]'))closeUnifiedSearchResults();
    $('#map').removeAttribute('data-search-position-pending');
    if(restoreView&&state.map){state.fitRequested=false;renderStops(state.currentRows,{viewportOnly:true,numbered:state.mode==='DATE_ROUTE'});}
  }

  function showAddressCandidates(candidates,choose,results=$('#results')) {
    results.hidden=false;
    if(results.id==='results')$('#query').setAttribute('aria-expanded','true');
    results.innerHTML=candidates.map((candidate,index)=>`<button type="button" class="resultItem" data-address-candidate="${index}"><div class="resultName">${esc(candidate.customerCode?[candidate.customerCode,candidate.customerName].filter(Boolean).join(' · '):candidate.placeName||candidate.address)}</div>${candidate.placeName&&candidate.address?`<div class="resultMeta">${esc(candidate.address)}</div>`:''}</button>`).join('');
    results.querySelectorAll('[data-address-candidate]').forEach(button=>button.onclick=()=>choose(candidates[Number(button.dataset.addressCandidate)]));
    for(const overlay of addressCandidateOverlays)overlay.setMap(null);
    addressCandidateOverlays=[];
    if(!state.map||!window.kakao?.maps?.CustomOverlay||!window.kakao.maps.LatLngBounds)return;
    const bounds=new kakao.maps.LatLngBounds();
    for(const [i,candidate] of candidates.entries()){
      if(!newAreaCoordinate(candidate))continue;
      const position=new kakao.maps.LatLng(candidate.lat,candidate.lng), pin=document.createElement('button');
      pin.type='button';pin.className='vehicleChip';pin.textContent=String(i+1);
      pin.setAttribute('aria-label',`지도에서 위치 후보 ${i+1} 선택`);
      pin.onclick=()=>choose(candidate);
      const overlay=new kakao.maps.CustomOverlay({position,content:pin,clickable:true,yAnchor:1,zIndex:65});
      overlay.setMap(state.map);addressCandidateOverlays.push(overlay);bounds.extend(position);
    }
    if(addressCandidateOverlays.length>1)state.map.setBounds(bounds,90,65,140,65);
  }

  function waitForSearchMapPoint(text,{owner=state.searchRequestId,reason='외부 주소검색 미승인',customerMatchState='UNCONFIRMED'}={}) {
    if(owner!==state.searchRequestId||state.mode!=='BASE_60D')return;
    const regionMissing=unifiedAddressQuery(text)&&!/^(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|충북|충남|전라|전북|전남|경상|경북|경남|제주|[가-힣]+(?:시|군|구))/.test(text);
    const results=$('#results');results.hidden=false;
    const guide=document.createElement('div');guide.className='resultMeta';guide.dataset.searchAddressGuide='true';
    guide.textContent=regionMissing?'지역이 빠진 주소입니다. 시·군·구를 입력하거나 지도에서 임시 위치를 지정하세요.':'지도에서 임시 위치를 지정할 수 있습니다.';
    results.replaceChildren(guide);
    $('#query').setAttribute('aria-expanded','true');
    if(!state.map){setSearchState('지도 연결 후 임시 위치를 지정해 주세요.');return;}
    const requestId=state.addressRequestId;
    $('#map').setAttribute('data-search-position-pending','true');
    setSearchState(reason+' · 지도에서 임시 위치를 선택하세요.');
    searchTemporaryClick=event=>{
      if(owner!==state.searchRequestId||requestId!==state.addressRequestId)return;
      const lat=numberOrNull(event?.latLng?.getLat?.()),lng=numberOrNull(event?.latLng?.getLng?.());
      if(lat===null||lng===null||lat<33||lat>39.5||lng<124||lng>132){setSearchState('대한민국 지도 안에서 위치를 선택해 주세요.');return;}
      searchTemporaryClick=null;$('#map').removeAttribute('data-search-position-pending');
      finishAddress({lat,lng,address:text,coordinateSource:'MAP_CLICK_TEMPORARY'},{owner,customerMatchState});
    };
  }

  async function searchExternalAddress(text,{owner=state.searchRequestId,signal,lookupAllowed=true,customerMatchState='UNCONFIRMED',trace}={}) {
    if(state.mode!=='BASE_60D'||owner!==state.searchRequestId||signal?.aborted)return;
    clearSearchTemporaryPin();
    if (text.length<2||text.length>200||/^[A-Z]\d+$/i.test(text)) {setSearchState('주소 또는 상호를 정확히 입력하세요.');return;}
    const requestId=state.addressRequestId;
    const active=()=>owner===state.searchRequestId&&requestId===state.addressRequestId&&!signal?.aborted&&state.mode==='BASE_60D';
    if(!state.map)await initMap();
    if(!window.KAKAO_MAP_CONFIG?.allowIndependentAddressLookup&&!window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup)await window.KakaoMapsAdapter?.refreshAddressLookup?.();
    if(!active())return;
    const config=window.KAKAO_MAP_CONFIG;
    const place=!unifiedAddressQuery(text);
    const officialAllowed=!place&&config?.allowIndependentAddressLookup===true;
    const externalAllowed=lookupAllowed&&config?.allowExternalAddressLookup===true&&(!place||config?.allowExternalPlaceLookup===true);
    if(!officialAllowed&&!externalAllowed){
      const reason=lookupAllowed===false?'기존 매장 조회 미확인':config?.addressLookupReason?NewAreaRequests.message({code:config.addressLookupReason}):place?'외부 상호 검색 미승인':'외부 주소검색 미승인';
      waitForSearchMapPoint(text,{owner,customerMatchState,reason});
      return;
    }
    setSearchState(place?'상호 위치 확인 중':'주소 확인 중',true);
    const controller=new AbortController();addressController=controller;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    let point;
    trace?.mark('externalStart');
    try {point=await lookupInteractiveLocation(text,controller.signal,{allowExternal:externalAllowed});}
    catch(error){
      if(active()&&!isSilentRequestError(error))waitForSearchMapPoint(text,{owner,customerMatchState,reason:NewAreaRequests.message(error)});
      return;
    }finally{trace?.mark('externalEnd');signal?.removeEventListener('abort',abort);if(addressController===controller)addressController=null;}
    if(!active())return;
    if(!point||point.verifiedAddressOnly){
      waitForSearchMapPoint(point?.officialRoad||text,{owner,customerMatchState,
        reason:point?.verifiedAddressOnly?'공식 주소 확인 · 좌표 미확인':!lookupAllowed?'기존 매장 조회 미확인':config?.allowExternalAddressLookup!==true&&config?.addressLookupReason
          ?NewAreaRequests.message({code:config.addressLookupReason}):place?'일치하는 상호 없음':'일치하는 주소 위치 없음'});return;
    }
    const choose=candidate=>{
      if(!active())return;
      closeUnifiedSearchResults();
      if(candidate.customerCode){
        const row=normalizeApiStore({...candidate,customerName:candidate.customerName||candidate.placeName||candidate.customerCode});
        if(typeof selectUnifiedSearchStore==='function')return selectUnifiedSearchStore(row,{owner});
        clearSearchTemporaryPin();return selectStore(row,null,true);
      }
      finishAddress(candidate,{owner,customerMatchState,trace});
    };
    if(point.candidates){
      showAddressCandidates(point.candidates,choose);
      setSearchState(point.truncated?'표시된 후보를 선택하거나 검색어를 구체화해 주세요.':'주소·장소 후보를 선택해 주세요.');return;
    }
    choose(point);
  }

  async function searchPeriod(text,trace) {
    if(state.mode!=='BASE_60D')return;
    const owner=invalidateUnifiedSearch();
    if(typeof clearSearchTemporaryPin==='function')clearSearchTemporaryPin({restoreView:false});
    cancelAddressLookup();closeUnifiedSearchResults();setSearchState('검색 중',true);
    unifiedSearchController=new AbortController();const signal=unifiedSearchController.signal;
    const code=/^[A-Z]\d{3,}$/i.test(text)?text.toUpperCase():null;
    const local=code ? [storesByCode.get(code)||coordinateByCode.get(code)].filter(Boolean) : rankSearchRows(text);
    trace.mark('matching');
    if(local.length){
      setSearchState(local.length===1?'검색 결과 1건':`${local.length}개 매장 · 선택해 주세요.`);
      renderResults(local,{owner,trace});return;
    }
    const address=unifiedAddressQuery(text)||/^\d{19}$/.test(text);
    const active=()=>!signal.aborted&&owner===state.searchRequestId&&state.mode==='BASE_60D';
    if(address&&stageAddressBatchEnabled()){
      const generation=snapshotMeta?.sourceGeneration??null;
      trace.mark('apiStart');
      const evidence=await NewAreaRequests.stageAddress(text,generation,{signal}).catch(()=>null);
      trace.mark('apiEnd');
      if(!active())return;
      if((snapshotMeta?.sourceGeneration??null)===generation){
        const stored=(evidence?.customerCodes||[]).map(code=>storesByCode.get(code)||coordinateByCode.get(code)).filter(Boolean);
        if(stored.length){
          setSearchState(stored.length===1?'검색 결과 1건':`${stored.length}개 매장 · 선택해 주세요.`);
          renderResults(stored,{owner,trace});return;
        }
        const point=evidence?.point;
        if(point){
          if(!state.map)await initMap();
          if(active())finishAddress({...point,address:text},{owner,trace});
          return;
        }
        if(evidence?.status==='OFFICIAL_ADDRESS_AMBIGUOUS'&&evidence.points?.length){
          showAddressCandidates(evidence.points.map((point,index)=>({...point,address:text,placeName:`공식 위치 후보 ${index+1}`,
            coordinateSource:'OFFICIAL_PUBLIC_BUILDING'})),point=>finishAddress(point,{owner,trace}));
          setSearchState('주소 위치 후보를 선택해 주세요.');return;
        }
      }
    }
    const temporary=address&&NewAreaRequests.temporaryPoint(text);
    if(temporary){if(!state.map)await initMap();if(active())finishAddress({...temporary,address:text},{owner,trace});return;}
    let remote=[],meta=null,lookupError=null;
    trace.mark('remoteStart');
    try{
      const result=await fetchJson('/api/map-phase2b/private/customer-search',{
        channel:'unified-customer-search',ttl:0,timeout:30000,headers:{'x-map-customer-query':encodeURIComponent(text)}
      });
      if(!Array.isArray(result.data))throw new Error('CUSTOMER_SEARCH_CONTRACT');
      remote=result.data;meta=result.meta;
    }catch(error){if(isSilentRequestError(error)||!active())return;lookupError=error;}
    trace.mark('remoteEnd');
    if(!active())return;
    const matched=new Map();
    // The staff-only server can match a private address without returning it.
    // Do not re-filter that trusted match by the redacted public address field.
    for(const value of remote){
      if(!/^[A-Z]\d{3,}$/.test(String(value?.customerCode||'')))continue;
      const row=normalizeApiStore({...matched.get(value.customerCode),...value});
      matched.set(row.customerCode,row);
    }
    const rank=rankSearchRow(text);
    let rows=[...matched.values()].filter(row=>!code||row.customerCode===code)
      .sort((a,b)=>rank(a)-rank(b)||naturalCompare(a.customerName,b.customerName)).slice(0,40);
    if(rows.length){
      setSearchState(rows.length===1?'검색 결과 1건':`${rows.length}개 매장 · 선택해 주세요.`);
      renderResults(rows,{owner,trace});return;
    }
    closeUnifiedSearchResults();
    if(code){setSearchState(lookupError?'고객 조회 실패 · 다시 시도해 주세요.':'고객코드를 확인해 주세요.');return;}
    if(text.length<2){setSearchState('주소 또는 상호를 정확히 입력하세요.');return;}
    // A failed Customer lookup is not proof that this is a new customer.
    await searchExternalAddress(text,{owner,signal,lookupAllowed:!lookupError,trace,
      customerMatchState:meta?.customerMatchVerified===true?'NOT_IN_MASTER':'UNCONFIRMED'});
  }

  function finishAddress(point,{owner=state.searchRequestId,customerMatchState='UNCONFIRMED',trace}={}) {
    if(owner!==state.searchRequestId||state.mode!=='BASE_60D')return;
    const lat=numberOrNull(point?.lat),lng=numberOrNull(point?.lng);
    if(lat===null||lng===null||lat<33||lat>39.5||lng<124||lng>132){setSearchState('위치 좌표를 확인해 주세요.');return;}
    if(point.customerCode){
      const row=normalizeApiStore(point);
      if(typeof selectUnifiedSearchStore==='function')return selectUnifiedSearchStore(row,{owner,trace});
      return selectStore(row,null,true);
    }
    const virtual={customerCode:'',customerName:point.placeName||'임시 위치',address:point.address,
      lat,lng,virtual:true,searchTemporary:true,customerMatchState,
      coordinateSource:point.coordinateSource||'KAKAO_ADDRESS_TEMPORARY',
      coordinateAccuracy:({MAP_CLICK_TEMPORARY:'USER_SELECTED',KAKAO_PLACE_TEMPORARY:'PLACE',OFFICIAL_PUBLIC_PARCEL:'PARCEL',
        OFFICIAL_PUBLIC_ADDRESS:'ADDRESS',STAGE_PRESERVED_COORDINATE:'PRESERVED'})[point.coordinateSource]||'BUILDING'};
    NewAreaRequests.rememberTemporary(point.address,virtual);
    trace?.mark('coordinates');
    showVirtual(virtual,null,trace);
    setSearchState('임시 위치 표시 · 고객정보에 저장하지 않습니다.');
  }

  async function geocodeAddress(address, signal, requestCache = null) {
    if(signal?.aborted)throw Object.assign(Error('조회 취소'),{name:'AbortError'});
    const stored=[...new Map([...latestSnapshotRows,...allStores].filter(r=>[r.customerCode,r.customerName,r.address].includes(address)).map(r=>[r.customerCode,r])).values()].map(newAreaCoordinate).filter(Boolean);
    if(stored.length===1)return {...stored[0],lat:stored[0].lat,lng:stored[0].lng,address:stored[0].address};
    if(stored.length>1)return {candidates:stored.map(r=>({lat:r.lat,lng:r.lng,address:r.address,customerCode:r.customerCode,customerName:r.customerName}))};
    if(window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup!==true)throw Error('저장된 고객코드·점포명·주소를 선택해 주세요. 외부 주소 조회는 승인되지 않았습니다.');
    const started = performance.now();
    const attempts = [];
    const serverProxy=window.kakaoGeocoder?.serverProxy===true;
    if (!serverProxy&&geocodeCache.has(address)) return geocodeCache.get(address);
    for (const query of serverProxy?NewAreaRequests.addressQueries(address,Phase2bUi.addressVariants):Phase2bUi.addressVariants(address)) {
      const attemptStarted = performance.now();
      const key=query.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
      if(serverProxy&&requestCache&&!requestCache.has(key))requestCache.set(key,NewAreaRequests.lookup(window.kakaoGeocoder, query, { signal }));
      const result = await (serverProxy&&requestCache?requestCache.get(key):NewAreaRequests.lookup(window.kakaoGeocoder, query, { signal }));
      if(signal?.aborted)throw Object.assign(Error('조회 취소'),{name:'AbortError'});
      const exact = result.filter((row) => Phase2bUi.addressMatches(query, row.road_address?.address_name || row.address_name) || Phase2bUi.addressMatches(query, row.address?.address_name || ""));
      attempts.push({ query, ms: Math.round(performance.now() - attemptStarted), candidates: result.length, exact: exact.length });
      if (exact.length > 1) {
        geocodeDiagnostic = `후보 선택 · ${Math.round(performance.now() - started)}ms`;
        return { candidates: exact.map((row) => ({ lat: Number(row.y), lng: Number(row.x), address: row.road_address?.address_name || row.address_name, geocodeMs: Math.round(performance.now() - started) })) };
      }
      if (exact.length !== 1) { if(serverProxy&&!result.zeroResult)break; continue; }
      const row = exact[0];
      const point = { lat: Number(row.y), lng: Number(row.x), address: row.road_address?.address_name || row.address_name, geocodeMs: Math.round(performance.now() - started), attempts, query };
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)||point.lat<33||point.lat>39.5||point.lng<124||point.lng>132) { if(serverProxy)break; continue; }
      if(!serverProxy){while(geocodeCache.size>=128)geocodeCache.delete(geocodeCache.keys().next().value);geocodeCache.set(address, point);}
      geocodeDiagnostic = `성공 · ${point.geocodeMs}ms · ${attempts.length}회 조회`;

      return point;
    }

    geocodeDiagnostic = `확인 필요 · ${Math.round(performance.now() - started)}ms`;
    return null;
  }

  async function lookupOfficialAddress(text, signal, queries = NewAreaRequests.addressQueries(text,Phase2bUi.addressVariants),prefetched) {
    if(window.KAKAO_MAP_CONFIG?.allowIndependentAddressLookup!==true||window.kakaoGeocoder?.serverProxy!==true)return null;
    for(const query of queries){
      let result;
      try {
        if(prefetched?.has(query)){
          const point=prefetched.get(query).official;
          if(!point)continue;
          const kind=point.kind||'EXACT', source=point.points||[[point.lat,point.lng]];
          result={resolution:{kind,road:point.road,lot:point.lot},rows:source.map(([y,x],i)=>({x,y,place_name:kind==='CHOOSE'?'공식 위치 후보 '+(i+1):undefined}))};
        }else result=await NewAreaRequests.lookup(window.kakaoGeocoder,query,{signal,mode:'official'});
      }
      catch(error){ if(error.code==='OFFICIAL_ADDRESS_LOOKUP_DISABLED')return null; throw error; }
      const {kind,road,lot}=result.resolution||{};
      if(kind==='MANUAL')return {verifiedAddressOnly:true,officialRoad:road,officialLot:lot};
      const points=(result.rows||[]).map(row=>newAreaCoordinate({lat:Number(row.y),lng:Number(row.x),
        address:road||query,placeName:row.place_name,coordinateSource:'OFFICIAL_PUBLIC_BUILDING',coordinateAccuracy:'BUILDING'})).filter(Boolean);
      if(kind==='CHOOSE'&&points.length>=2)return {candidates:points,officialRoad:road,officialLot:lot};
      if(kind==='EXACT'&&points.length===1)return points[0];
    }
    return null;
  }

  async function lookupInteractiveLocation(text, signal, {allowExternal=true} = {}) {
    const geocoder=window.kakaoGeocoder;
    const address=unifiedAddressQuery(text);
    const official=address?await lookupOfficialAddress(text,signal):null;
    if(official&&!official.verifiedAddressOnly)return official;
    if(!allowExternal)return official;
    if(!geocoder?.serverProxy)return address?geocodeAddress(text,signal):null;
    const config=window.KAKAO_MAP_CONFIG;
    if(config?.allowExternalAddressLookup!==true||!address&&config.allowExternalPlaceLookup!==true)return official;
    const queries=address?NewAreaRequests.addressQueries(text,Phase2bUi.addressVariants):[text];
    if(!queries.length)return null;
    for(const query of queries){
      const result=await NewAreaRequests.lookup(geocoder,query,{signal,mode:address?'address':'place'});
      if(!result.rows?.length)continue;
      const candidates=result.rows.map(row=>({
        lat:Number(row.y),lng:Number(row.x),address:row.road_address?.address_name||row.address_name,
        placeName:row.place_name,coordinateSource:address?'KAKAO_ADDRESS_TEMPORARY':'KAKAO_PLACE_TEMPORARY'
      })).filter(newAreaCoordinate);
      if(!candidates.length)return null;
      if(address&&candidates.length===1&&result.resolution?.kind==='EXACT')return candidates[0];
      return {candidates,truncated:result.resolution?.kind==='TRUNCATED'};
    }
    return official;
  }

  function showVirtual(row, areaFacts=null, trace) {
    const lat=numberOrNull(row?.lat),lng=numberOrNull(row?.lng);
    if(!state.map||lat===null||lng===null||lat<33||lat>39.5||lng<124||lng>132){setSearchState('지도와 위치 좌표를 확인해 주세요.');return;}
    clearSelection({preserveSearch:true,fast:!!trace});clearSearchTemporaryPin();
    row={...row,customerCode:'',lat,lng,virtual:true,searchTemporary:true,customerMatchState:row.customerMatchState||'UNCONFIRMED'};
    $('#results').replaceChildren();
    const content=markerElement(row,null,'virtual');content.dataset.searchTemporaryPin='true';
    content.setAttribute('aria-label','임시 위치 · '+(row.address||''));
    searchTemporaryOverlay=new kakao.maps.CustomOverlay({position:new kakao.maps.LatLng(lat,lng),content,clickable:true,xAnchor:.5,yAnchor:1,zIndex:45});
    searchTemporaryOverlay.setMap(state.map);state.virtual=row;
    trace?.mark('pin');
    const locationBasis=({OFFICIAL_PUBLIC_BUILDING:'공식 자료 건물 위치',OFFICIAL_PUBLIC_ADDRESS:'공식 주소 대표점',
      OFFICIAL_PUBLIC_PARCEL:'공식 필지 대표점',STAGE_PRESERVED_COORDINATE:'저장 좌표'})[row.coordinateSource];
    $('#detailSection').classList.add('open');$('#detail').className='detailCard';
    $('#detail').innerHTML=`<div class="detailHead"><button id="detailClose" class="detailClose" aria-label="닫기">×</button><div class="code">임시 위치</div><div class="storeName">${esc(row.address||row.customerName||'선택 위치')}</div></div><div class="detailBody"><p class="hint">저장하지 않는 임시 핀입니다.${locationBasis?' · '+locationBasis:''}</p>${navigationPointActions(row)}${state.mode==='BASE_60D'?'<button type="button" id="searchPointToBatch" class="tiny">신규권역 일괄조회에 추가</button>':''}<label class="areaRadius">인근 호차 반경 <select id="newAreaSingleRadius"><option value="30">30km</option><option value="40">40km</option><option value="50">50km</option></select></label><div id="nearWrap" aria-live="polite"></div></div>`;
    $('#detailClose').onclick=()=>{clearSearchTemporaryPin();clearSelection();};
    $('#newAreaSingleRadius').value=String(newAreaRadius);
    $('#newAreaSingleRadius').onchange=event=>setNewAreaRadius(event.target.value);
    const addToBatch=$('#searchPointToBatch');
    if(addToBatch)addToBatch.onclick=()=>{
      const input=$('#newAreaBatchInput');
      const cell=value=>'"'+String(value||'').replace(/"/g,'""')+'"';
      const existing=parseNewArea('#newAreaBatchInput');
      if(!existing.some(item=>item.address===row.address)){
        input.value+=(input.value&&!input.value.endsWith('\n')?'\n':'')+cell(row.address)+'\t'+cell(row.customerName);
        input.dispatchEvent(new Event('input',{bubbles:true}));
      }
      newAreaSelectedPoints.set(row.address,{address:row.address,lat:row.lat,lng:row.lng,coordinateSource:row.coordinateSource});
      const open=$('#sourceBatch');
      if(open)open.click();else {const tool=$('#newAreaBatchTool');tool.hidden=false;tool.open=true;}
    };
    window.dispatchEvent(new CustomEvent('map-store-selected',{detail:{customerCode:null}}));
    temporaryAreaFacts=areaFacts;
    temporaryAreaSourceVersion=newAreaSourceVersion();
    temporaryAreaDispatchMeta=null;
    $('#nearWrap').textContent='주변 배송 근거 확인 중';
    if(kakao.maps.Circle){searchTemporaryRadius=new kakao.maps.Circle({center:new kakao.maps.LatLng(row.lat,row.lng),radius:500,strokeWeight:1,strokeColor:'#64748b',strokeOpacity:.55,strokeStyle:'shortdash',fillColor:'#64748b',fillOpacity:.05});searchTemporaryRadius.setMap(state.map);}
    requestAnimationFrame(positionDetailPopup);focusMapPoint(row,{zoom:true,key:'search-temporary'});
    trace?.mark('map');
    if(innerWidth<=760)showMobileMap();
    trace?.mark('detail');
    trace?.finish('temporary');
    afterSearchPaint(()=>renderSearchTemporaryNearby(row));
  }

  function renderSearchTemporaryNearby(point,{loadDispatch=true,fit=false}={}) {
    const panel=$('#nearWrap');
    if(!point?.searchTemporary||point!==state.virtual||!panel)return;
    const sourceVersion=newAreaSourceVersion();
    if(temporaryAreaSourceVersion!==sourceVersion){
      temporaryAreaFacts=null;
      temporaryAreaSourceVersion=sourceVersion;
    }
    if(temporaryAreaFacts&&temporaryAreaDispatchMeta!==baseVehicleMeta){
      temporaryAreaFacts={...temporaryAreaFacts,...newAreaDispatchFacts(point,temporaryAreaFacts.nearestStoreCode,newAreaEvidence())};
    }
    const facts=temporaryAreaFacts ||= judgeNewAreaPoint({
      address:point.originalAddress??point.address,customer:point.originalCustomer??point.customerName
    },point);
    temporaryAreaDispatchMeta=baseVehicleMeta;
    const customerStatus=({NOT_IN_MASTER:'고객 원장 미등록',REGISTERED:'등록 매장 주소'})[point.customerMatchState]||'고객 등록 여부 미확인';
    const wasOpen=panel.querySelector('details')?.open??true;
    const observedOpen=panel.querySelector('.areaObservedRoutes')?.open??false;
    panel.innerHTML=`<div class="areaInquiry">${customerStatus}${newAreaSummaryMarkup(facts)}
      <details class="areaVehicles"${wasOpen?' open':''}><summary>${newAreaVehicleTitle(facts,newAreaRadius)}</summary>
        ${newAreaVehicleContent(facts,newAreaRadius,true)}<p class="areaInquiryHint" data-area-dispatch-stop></p></details>
        ${newAreaObservationMarkup(observedOpen)}</div>`;
    bindNewAreaObservation(panel,facts);
    const groups=MapPeriodUi.areaDispatchVehicles(facts,newAreaRadius);
    panel.querySelector('[data-area-dispatch-overview]')?.addEventListener('click',()=>{
      newAreaVehicleKey=null;renderSearchTemporaryNearby(point,{loadDispatch:false,fit:true});
    });
    panel.querySelectorAll('[data-area-dispatch-vehicle]').forEach(button=>button.onclick=()=>{
      selectNewAreaDispatchVehicle(point,groups[Number(button.dataset.areaDispatchVehicle)]);
    });
    renderNewAreaDispatchMap(point,groups,{fit});
    const pending=loadDispatch&&prepareNewAreaDispatch();
    if(pending)void pending.then(()=>{
      if(point!==state.virtual)return;
      renderSearchTemporaryNearby(point,{loadDispatch:false});
    });
  }

  function clearNewAreaDispatchOverlays() {
    for(const overlay of newAreaDispatchOverlays)overlay.setMap(null);
    newAreaDispatchOverlays=[];
  }

  const areaVehicleKey=({vehicle,center})=>(center||'')+'|'+vehicle;

  function selectNewAreaDispatchVehicle(point,group) {
    if(point!==state.virtual||!group)return;
    const key=areaVehicleKey(group);
    newAreaVehicleKey=newAreaVehicleKey===key?null:key;
    renderSearchTemporaryNearby(point,{loadDispatch:false,fit:true});
  }

  function renderNewAreaDispatchMap(point,groups,{fit}={}) {
    clearNewAreaDispatchOverlays();
    if(!state.map||!window.kakao?.maps?.CustomOverlay)return;
    const active=groups.find(group=>areaVehicleKey(group)===newAreaVehicleKey);
    if(!active)newAreaVehicleKey=null;
    const stops=active?newAreaEvidence().dispatchStops.filter(stop=>areaVehicleKey(stop)===newAreaVehicleKey&&distanceKm(point,stop)<=newAreaRadius):
      groups.map(group=>group.nearestStop);
    const groupsByKey=new Map(groups.map(group=>[areaVehicleKey(group),group]));
    const bounds=fit&&kakao.maps.LatLngBounds?new kakao.maps.LatLngBounds():null;
    bounds?.extend(new kakao.maps.LatLng(point.lat,point.lng));
    for(const stop of stops){
      const group=groupsByKey.get(areaVehicleKey(stop));
      const weekdays=active?Phase2bUi.observedWeekdays(stop.mask):group.weekdays;
      const label=`${MapPeriodUi.areaVehicleLabel(group)} · ${stop.customerName||stop.customerCode} · 직선 ${MapPeriodUi.areaDistance(distanceKm(point,stop))} · ${MapPeriodUi.areaDispatchDays({weekdays})}`;
      const content=markerElement(stop,null,'nearbyVehicle');
      content.dataset.areaDispatchPin=active?'store':'vehicle';
      content.title=label;content.setAttribute('aria-label',label);
      content.onclick=event=>{
        event.stopPropagation();
        if(!active){selectNewAreaDispatchVehicle(point,group);return;}
        const status=$('#nearWrap [data-area-dispatch-stop]');
        if(status)status.textContent=label;
      };
      const position=new kakao.maps.LatLng(stop.lat,stop.lng);
      const overlay=new kakao.maps.CustomOverlay({position,content,clickable:true,xAnchor:.5,yAnchor:1.2,zIndex:44});
      overlay.setMap(state.map);newAreaDispatchOverlays.push(overlay);bounds?.extend(position);
    }
    if(bounds&&stops.length){
      mapCamera?.releaseFocus();state.fitRequested=false;state.suppressMapEventsUntil=Date.now()+700;
      state.map.setBounds(bounds,64,64,64,64);
    }
  }

  window.addEventListener('map-navigation-context-changed',()=>clearSearchTemporaryPin());
  window.addEventListener('map-navigation-logout',()=>clearSearchTemporaryPin());
  window.addEventListener('map-unified-search-clear',()=>clearSearchTemporaryPin());

  function renderVehicleQuickFilter(selected) {
    const quick = $('#vehicleQuickFilter');
    if (!quick) return;
    quick.hidden = !selected.length;
    const chips = $('#vehicleQuickChips'), key = JSON.stringify(selected);
    if (chips.dataset.selected === key) return;
    chips.dataset.selected = key;
    chips.innerHTML = selected.map(vehicle => `<button type="button" class="vehicleChip" data-remove-vehicle="${esc(vehicle)}" aria-label="${esc(vehicleLabel(vehicle))} 선택 해제">${esc(vehicleLabel(vehicle))} ×</button>`).join('');
    chips.querySelectorAll('button').forEach(chip => {
      chip.onclick = () => applyVehicleFilter(selectedVehicles().filter(vehicle => vehicle !== chip.dataset.removeVehicle));
    });
  }

  function refreshVehicleUi(run, { preserveSearch = false } = {}) {
    $("#periodCenter").value = $("#mobileCenter").value = state.centerFilter || "all";
    filterVehicleList();
    if (run) {closeClusterPanel();resetRoadRoute();}
    syncRoadRoutePanel();
    const selected = selectedVehicles();
    if (run) {
      ++state.todayRequestId; ++state.routeRequestId;
      requestControllers.get("operation-status")?.controller.abort("superseded");
      if (!preserveSearch) clearSelection();
      else if (state.selected && dateReady) {
        const visible = state.mode === 'BASE_60D' ? filteredPeriodStores() : filteredDateStores(allStores);
        if (!visible.some(row => row.customerCode === state.selected.customerCode)) clearSelection({preserveSearch: true});
      }
      if(state.mode!=="DATE_ROUTE")updateOperationMetrics(null);
    }
    if (state.mode === "BASE_60D" && selected.length) periodVehicleScope = "selected";
    $("#selectedVehicleCount").textContent = selected.length ? `${selected.length}대` : "선택 없음";
    $("#vehicleModeLabel").textContent = selected.length === 1 ? "해당 호차 집중모드" : selected.length > 1 ? "선택 호차 권역 비교" : "기준일 전체 권역";
    $("#mapStatusTitle").textContent = selected.length === 1 ? `${selected[0]}호 ${state.selectedDate} 권역` : selected.length > 1 ? `${selected.length}대 호차 권역 비교` : "기준일 전체 권역";
    $("#vehicleChips").className = selected.length ? "" : "vehiclePlaceholder";
    $("#vehicleChips").textContent = selected.length ? `${selected.length}개 호차 선택` : "전체 호차";
    renderVehicleQuickFilter(selected);
    $("#operationVehicle").value = selected.length === 1 ? selected[0] : "";
    if (run) {
      if(usesDeliveryRoster()&&state.mode==='DATE_ROUTE'&&state.selectedDate) {
        const saved=dailyRosters.get(state.selectedDate);
        if(rosterCenters().some(center=>!saved?.scopes.has(center)&&!saved?.errors.has(center)))void changeRosterDate(state.selectedDate);
      }
      if (!preserveSearch || (selected.length && !state.userMovedMap && !state.selected && !state.virtual)) requestMapFit();
      else state.fitRequested = false;
      void loadBaseMap();
    }
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
  function verifiedEmptyDailyScope(){
    if(dailyMeta?.roster)return rosterScopeStatus().empty;
    if(!isDailyDataReady()||dailyMeta?.complete!==true||dailyMeta.retained||dailyMeta.unassignedRows>0
      ||dailyError||periodBasis==='driver'||periodVehicleScope==='selected'&&!selectedVehicles().length)return false;
    const centers=dailyMeta.centerScope;
    if(!Array.isArray(centers))return dailyMeta.coverageComplete!==false;
    if(state.centerFilter)return centers.includes(state.centerFilter);
    const requested=selectedVehicles();
    const groupByVehicle=new Map(SOURCE.vehicles.map(row=>[normalizeVehicle(row.vehicle),vehicleListGroup(row.group)]));
    return requested.length?requested.every(v=>centers.includes(groupByVehicle.get(v))):['osan','yeongnam','honam'].every(center=>centers.includes(center));
  }
  function isDailyDataReady(){return dateReady&&state.mode==='DATE_ROUTE'&&datedSourceDate===state.selectedDate&&Boolean(datedSourceDate);}
  function filteredDateStores(rows) {
    if(!isDailyDataReady())return [];
    const selected=selectedVehicles();
    if(periodBasis==='vehicle'&&periodVehicleScope==='selected'&&!selected.length)return [];
    return rows.filter(row=>(periodBasis==='driver'||!selected.length||selected.includes(row.vehicle))&&(periodBasis==='driver'||!state.centerFilter||row.vehicleGroup===state.centerFilter)&&matchesDatedDriver(row));
  }
  async function loadBaseMap() {
    if (!dateReady || state.mode==='DATE_ROUTE'&&!isDailyDataReady()) return;
    const selected = selectedVehicles();
    const daily=state.mode==='DATE_ROUTE';
    if(daily) filterVehicleList();
    else void refreshDriverMaster();
    let stores;
    if(daily){
      const key=queryFilterIdentity();
      if(dailyView?.scopeKey!==key){
        dailyView.scopeKey=key;
        const scoped=filteredDateStores(allStores);
        dailyView.scoped=dailyMeta?.roster ? scoped : dedupeRouteStops(scoped);
        dailyView.filter=null;
      }
      operationStops=dailyView.scoped;
      applyRosterTimes();
      const projection=OpsmapDaily.projection(operationStops,runFilter);
      if(dailyView.filter!==runFilter){dailyView.filter=runFilter;dailyView.shown=projection.shown;}
      stores=dailyView.shown;
      state.routeRows=stores.filter(row=>Number.isFinite(row.lat)&&Number.isFinite(row.lng));
      renderRunList();
      const known=operationStops.length>0||verifiedEmptyDailyScope();
      updateOperationMetrics({totalStops:known?operationStops.length:null,completedStops:known&&!projection.unknown?projection.completed:null,remainingStops:known&&!projection.unknown?projection.pending:null});
      $('#map').dataset.dailyStops=String(stores.length);
      $('#map').dataset.dailyLocated=String(state.routeRows.length);
    }else stores=filteredPeriodStores().map(row=>({...row,color:vehicleColor(row.vehicle)}));
    stores.forEach(row=>{if(!daily||!archivedDatedAssignments(dailyMeta)){window.MapManualPins?.apply(row);liveAddressLocations?.apply(row);}});
    renderStops(stores,{numbered:daily,vehicles:selected});
    if(daily){drawRoute();void loadDailyCompletionEvidence();}
    deferMapAddressWork();

    const period = state.mode === "BASE_60D";
    if (period) {
      setPeriodViewState(generalAllStores && snapshotReadState === 'error' ? 'error' : stores.length ? "ready" : "empty");
      const subject = periodBasis === "driver" ? ($("#periodDriver").selectedOptions[0]?.textContent || "전체 기사") : periodVehicleScope === "all" ? "전체 호차" : selected.length === 1 ? selected[0] + "호" : selected.length ? selected.length + "개 호차" : "호차 선택 없음";
      const range = !OpsmapDaily.day(state.rangeEnd)||!OpsmapDaily.day(state.rangeStart)?'조회 기간 미확인':
        state.rangeStart === daysBefore(state.rangeEnd, 89) ? "최근 90일" : state.rangeStart.slice(5) + " ~ " + state.rangeEnd.slice(5);
      $("#periodIdentity").textContent = `${subject} · ${generalAllStores && periodBasis === 'vehicle' ? '저장된 전체 매장' : range} · ${stores.length}개 매장`;
      if (generalAllStores && snapshotReadState === 'error') $('#periodIdentity').textContent = '전체 매장 원천 조회 실패 · 전체 매장 수 미확인';
    }
    $("#mapStatusTitle").textContent = period ? "매장·권역 지도" : "일자별 운행";
    $("#mapStatusSub").textContent = period ? `${stores.length}개 매장 · ${periodBasis === 'driver' ? '선택 기사 배송지' : (baseVehicleMeta?.stale?'이전 기준호차':'기준호차')}`
      : dailyMeta?.roster&&!operationStops.length&&!verifiedEmptyDailyScope()?`${state.selectedDate} · 선택 범위 착지 수 미확인`:
        `${state.selectedDate} · ${stores.length}개 매장 · 해당일 편성`;
    if(period) $("#freshnessState").textContent=`지도 반영일 ${modelStatus?.periodLatest || periodMeta?.periodLatest || state.rangeEnd}`;
    else renderDailyReadState();
    if(period&&periodBasis==='vehicle'&&baseVehicleStatus!=='READY')$('#mapStatusSub').textContent=baseVehicleStatus==='ERROR'?'기준호차를 불러오지 못했습니다.':baseVehicleStatus==='NOT_READY'?'기준호차 자료를 확인해 주세요.':'기준호차를 불러오는 중입니다.';
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
    $("#date").max = maxDailyDate();
    $("#mobileDate").max = maxDailyDate();
  }

  async function loadRoute(source) {
    if(!isDailyDataReady())return;
    const date=state.selectedDate, vehicle=$(source==='mobile'?'#mobileVehicle':'#vehicle').value;
    if(vehicle&&!hasDatedDriverFilter())applyVehicleFilter([vehicle]);
    else await loadBaseMap();
    await loadDailyCompletionEvidence();
    if(state.mode!=='DATE_ROUTE'||state.selectedDate!==date||vehicle&&primarySelectedVehicle()!==vehicle)return;
    const points=visibleActualPoints();
    setRouteLoading(source,points.length>=2?'실제 완료 시각 순 직선 동선 · '+points.length+'곳':'개별 완료 시각과 위치가 확인된 지점이 2개 미만입니다.');
    if(source==='mobile')showMobileMap();
  }

  function resolveRouteStop(stop, vehicle) {
    const code = String(stop.customerCode || stop.code || "").trim();
    const local = storeByVehicleAndCode.get(`${normalizeVehicle(vehicle)}|${code}`) || storesByCode.get(code) || {};
    const useStoredPoint = retainedPointMatches(stop,local);
    return { ...local, ...stop, customerCode: code, customerName: stop.customerName || stop.name || local.customerName || "", address: stop.address || local.address || "", lat: numberOrNull(stop.lat) ?? (useStoredPoint ? local.lat ?? null : null), lng: numberOrNull(stop.lng) ?? (useStoredPoint ? local.lng ?? null : null), order: Number(stop.order || stop.sequence || stop.stopOrder || stop.savedOrder) || null, vehicle: normalizeVehicle(vehicle) };
  }

  function normalizeRouteStop(stop, vehicle) {
    const row = resolveRouteStop(stop, vehicle);
    const status = String(stop.status || "").trim().toUpperCase();
    const completed = status === "COMPLETED" || status === "DELIVERED" || stop.completed === true;
    return { ...row, status: completed ? "COMPLETED" : ['PENDING','INCOMPLETE'].includes(status)||stop.completed===false ? "PENDING" : "", actualCompletedAt: completed ? (stop.actualCompletedAt || stop.completedAt || null) : null, isEstimated: stop.isEstimated===true };
  }

  function runVisitId(row){return row?.deliveryId || datedVisitKey(row?.vehicle,row?.customerCode);}

  function datedVisitKey(vehicle, code) {
    return normalizeVehicle(vehicle) + "|" + String(code || "");
  }

  function dedupeRouteStops(rows) {
    const unique = new Map();
    rows.forEach((row, index) => {
      const key = row.customerCode ? `C:${datedVisitKey(row.vehicle,row.customerCode)}` : Number.isFinite(row.lat) && Number.isFinite(row.lng) ? `P:${row.lat.toFixed(6)},${row.lng.toFixed(6)}` : `R:${index}`;
      const old = unique.get(key);
      if (!old || (old.status !== "COMPLETED" && row.status === "COMPLETED")) unique.set(key, row);
    });
    return [...unique.values()].sort((a, b) => (Number(a.order) || 999999) - (Number(b.order) || 999999));
  }

  function renderRouteSummary(payload, source) {
    const connectionLabel = '방문 목록을 길찾기에 적용한 뒤 출발지·경유지·목적지를 확인해 주세요.';
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

  function resetMapOverview() {
    clearSearchTemporaryPin();
    cancelManualRoadRoute();
    setSelectedVehicles([]);
    periodVehicleScope = 'all'; periodSelectionCache = null; periodListLimit = 0;
    state.centerFilter = ''; state.driverKey = ''; selectedDriverKeys = [];
    $('#periodCenter').value = 'all';
    [...$('#periodDriver').options].forEach(option => { option.selected = option.value === ''; });
    $('#vehicleQuery').value = ''; filterVehicleList();
    $$('[data-source-center]').forEach(button => button.classList.remove('active'));
    $("#mobileBaseVehicle").value = "";
    $("#mobileCenter").value = "all";
    state.routeRows = [];
    document.body.classList.remove("routeSheetOpen");
    clearSelection();
    if(usesDeliveryRoster()&&state.mode==='DATE_ROUTE')refreshVehicleUi(true);
    else {refreshVehicleUi(false);requestMapFit();void loadBaseMap();}
  }

  function selectCenter(group) {
    ++state.searchRequestId; ++state.addressRequestId; ++state.detailRequestId;
    $('#results').replaceChildren();$('#addressJudgeResults').replaceChildren();
    setSelectedVehicles([]);state.driverKey='';$('#periodDriver').value='';periodVehicleScope='all';periodListLimit=0;periodSelectionCache=null;
    clearSelection();
    state.centerFilter = group === "all" ? "" : group;
    $('#periodCenter').value=group;$('#mobileCenter').value=group;
    filterVehicleList();
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

  function newAreaCoordinate(row, {fixedOnly=false}={}) {
    if (!row) return null;
    const point = {...row};
    if (/^[A-Z]\d+$/.test(point.customerCode||'')) window.MapManualPins?.apply(point);
    if (fixedOnly) {
      const source=point.coordinateSource||point.raw?.coordinateSource||'';
      if (point.virtual||point.searchTemporary||/(?:_TEMPORARY|_LIVE)$/.test(source)) return null;
    } else liveAddressLocations?.apply(point);
    const status = point.coordinateStatus || point.raw?.coordinateStatus;
    const lat = numberOrNull(point.lat), lng = numberOrNull(point.lng);
    if (['CONFLICT','UNVERIFIED','MISSING'].includes(status) || point.resolutionStatus === 'ADDRESS_CHANGED_REVIEW_REQUIRED' || lat === null || lng === null || lat < 33 || lat > 39.5 || lng < 124 || lng > 132) return null;
    return {...point, lat, lng};
  }

  function storedAreaMatches(address, batch) {
    const keys=value=>[...new Set([value,...NewAreaRequests.addressQueries(value,Phase2bUi.addressVariants)].map(normalizeSearchAddress).filter(Boolean))];
    if(!batch.storedAddresses){
      batch.storedAddresses=new Map();
      const stores=newAreaStoredCustomers(batch);
      for(const [code,store] of stores){
        if(!code)continue;
        const addresses=storeSearchAddresses(store);
        for(const key of new Set(addresses.filter(Boolean).flatMap(keys))){
          if(!batch.storedAddresses.has(key))batch.storedAddresses.set(key,new Map());
          batch.storedAddresses.get(key).set(code,store);
        }
      }
    }
    const matched=new Map();
    for(const key of keys(address))for(const [code,store] of batch.storedAddresses.get(key)||[])matched.set(code,store);
    return [...matched.values()];
  }

  function storeSearchAddresses(store) {
    const primary=store.address||store.customerAddress||store.basicAddress||store.latestAddress;
    if(store.addressChanged===true||store.resolutionStatus==='ADDRESS_CHANGED_REVIEW_REQUIRED')return [primary];
    return [primary,store.customerAddress,store.roadAddress,store.roadNameAddress,store.jibunAddress];
  }

  function newAreaStoredCustomers(batch) {
    return batch.registered ||= new Map(newAreaRegistryRows().filter(row=>!row.deliveryOnly&&row.customerRegistryStatus!=='DELETED')
      .map(row=>[row.customerCode||row.code,row]));
  }

  async function newAreaCustomerMatch(query, signal, batch) {
    if(signal?.aborted)throw signal.reason;
    if (!(window.kakaoGeocoder?.serverProxy||window.KAKAO_MAP_CONFIG?.addressLookupServerProxy) || !query) return null;
    const key=query.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
    const local=batch.prefetched?.get(query)?.customer;
    if (!local&&!batch.customers.has(key)) batch.customers.set(key,fetchJson('/api/map-phase2b/private/customer-search',{
      channel:'new-area-customer-search:'+batch.requestId+':'+batch.customers.size,
      ttl:0,timeout:12000,signal:batch.signal||signal,headers:{'x-map-customer-query':encodeURIComponent(query),'x-map-search-scope':'new-area'}
    }).then(result=>{
      if (!Array.isArray(result.data)) throw Object.assign(Error('CUSTOMER_SEARCH_CONTRACT'),{code:'CUSTOMER_SEARCH_CONTRACT'});
      return result;
    }));
    const result=local||await batch.customers.get(key);
    if(signal?.aborted)throw Object.assign(Error('조회 취소'),{name:'AbortError'});
    const rows=result.data.filter(store=>/^[A-Z]\d{3,}$/.test(store.customerCode||'') && (store.matchedBy==='ADDRESS'||store.matchedBy==='CODE'));
    if(result.meta?.truncated || rows.length>1)return {candidates:rows};
    if(!rows.length)return null;
    return {...newAreaStoredCustomers(batch).get(rows[0].customerCode),...rows[0]};
  }

  async function judgeNewAreaRow(row, signal, batch = {customers:new Map(),queries:new Map(),blocked:null}) {
    if (row.inputAmbiguous) return {...row,decision:'검토',reason:'입력 열 확인 필요',evidence:'주소/고객명 열 또는 따옴표를 확인해 주세요.',nearby:[]};
    if (/^[A-Z]\d{3,}$/i.test(row.address.trim())) {
      const code=row.address.trim().toUpperCase();
      const store=newAreaStoredCustomers(batch).get(code)||await newAreaCustomerMatch(code,signal,batch);
      if (!store||store.candidates) return {...row,decision:'검토',reason:'고객코드 확인 필요',evidence:'기존 고객 조회에서 코드 미확인 · 코드 문자열 지오코딩 안 함',nearby:[]};
      row={...row,customerCode:code,address:store.address||row.address,customer:row.customer||store.customerName,addressRegion:store.addressRegion,actualDispatchCenter:window.MapLocationContract?.dispatchCenter(store)};
      const saved = newAreaCoordinate(store);
      if (saved) return judgeNewAreaPoint(row,saved,batch);
      if (store.coordinateStatus === 'CONFLICT' || store.raw?.coordinateStatus === 'CONFLICT') return {...row,decision:'검토',reason:'주소·좌표 재확인 필요',evidence:'기존 좌표 직접 수정에서 위치를 확인해 주세요.',nearby:[]};
      return {...row,decision:'검토',reason:'고객 주소·좌표 미확인',lookupStatus:'DEFERRED',nearby:[]};
    }
    const stored = storedAreaMatches(row.address,batch);
    if(stored.length){
      const name=normalizeSearchText(row.customer);
      const named=name?stored.filter(store=>normalizeSearchText(store.customerName)===name):[];
      const matched=named.length===1?named:stored;
      const located=matched.map(newAreaCoordinate).filter(Boolean);
      if(located.length===matched.length)return judgeNewAreaPoint(row,NewAreaRequests.singleStoredLocation(located),batch);
      return {...judgeNewAreaPoint({...row,...(matched.length===1?{customerCode:matched[0].customerCode}:{})},null),
        reason:'기존 고객 좌표 확인 필요',evidence:'저장 고객 주소 일치 · 검증 좌표 확인 필요'};
    }
    const selectedPoint=batch.selectedPoints?.get(row.address);
    if(selectedPoint)return judgeNewAreaPoint(row,selectedPoint,batch);
    if (!validNewAreaInput(row.address)) return judgeNewAreaPoint(row,null);
    const manual = (manualDraft?.stops() || []).filter(stop => stop.label === row.address).map(newAreaCoordinate).filter(Boolean);
    if (manual.length) return judgeNewAreaPoint(row,manual.length === 1 ? {...manual[0],coordinateSource:'MANUAL_WAYPOINT'} : {candidates:manual},batch);
    const queries=NewAreaRequests.addressQueries(row.address,Phase2bUi.addressVariants);
    if (!queries.length) return {...judgeNewAreaPoint(row,null),evidence:'검색용 기본주소 확인 필요 · 원문 보존'};
    let matched=null, customerError=null;
    try {
      for(const query of queries){matched=await newAreaCustomerMatch(query,signal,batch);if(matched)break;}
    } catch(error) {
      if(signal?.aborted||isSilentRequestError(error))throw error;
      customerError=error;
    }
    if(matched?.candidates)return judgeNewAreaPoint(row,matched);
    if(matched){
      const saved=newAreaCoordinate(matched);
      if(saved)return judgeNewAreaPoint({...row,customerCode:matched.customerCode},saved,batch);
      return {...judgeNewAreaPoint({...row,customerCode:matched.customerCode},null),reason:'기존 고객 좌표 확인 필요',evidence:'인증된 고객 주소 매칭 · 저장·수동 좌표 확인 필요 · 외부 좌표로 대체하지 않음'};
    }
    const official=await lookupOfficialAddress(row.address,signal,queries,batch.prefetched);
    if(official&&!official.verifiedAddressOnly)return judgeNewAreaPoint(row,official,batch);
    if(customerError)throw customerError;
    const blocked=batch.blocked||window.kakaoGeocoder?.blockedReason;
    if(blocked)throw Object.assign(Error(blocked),{code:blocked==='GEOCODE_DAILY_LIMIT'?blocked:'GEOCODE_AUTOMATICALLY_BLOCKED'});
    if (window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup !== true) return {...judgeNewAreaPoint(row,official),evidence:official?.verifiedAddressOnly
      ?'공식 주소 일치 · 좌표 확인 후 직접 입력':NewAreaRequests.message({code:window.KAKAO_MAP_CONFIG?.addressLookupReason||'GEOCODING_DISABLED'})+' · 좌표 확인 후 직접 입력'};
    // Request-scoped reuse only. Neither the input nor response coordinates are persisted.
    const lookup = (batch.externalTail || Promise.resolve()).then(async () => {
      if (signal?.aborted) throw signal.reason;
      const hold = batch.blocked || window.kakaoGeocoder?.blockedReason;
      if (hold) throw Object.assign(Error(hold), {code:hold==='GEOCODE_DAILY_LIMIT'?hold:'GEOCODE_AUTOMATICALLY_BLOCKED'});
      try { return await geocodeAddress(row.address, signal, batch.queries); }
      catch (error) {
        if (NewAreaRequests.stopsExternal(error)) batch.blocked=error.code;
        throw error;
      }
    });
    batch.externalTail = lookup.catch(()=>{});
    return judgeNewAreaPoint(row, await lookup, batch);
  }

  const stageAddressBatchEnabled=()=>window.location?.origin==='https://freshon-admin-stage-preview-template.onrender.com';

  function readNewAreaObservations() {
    const generation=snapshotMeta?.sourceGeneration;
    if(!stageAddressBatchEnabled()||!generation)return Promise.resolve(null);
    if(newAreaObservedFlight?.generation===generation)return newAreaObservedFlight.task;
    const owner={generation};
    owner.task=fetchJson('/api/map-phase2b/private/stage-nearby-evidence?view=observed&generation='+encodeURIComponent(generation),
      {channel:'area-observed-routes',timeout:12000}).then(proof=>{
      if(newAreaObservedFlight!==owner||snapshotMeta?.sourceGeneration!==generation||proof?.generation!==generation||
        proof.vehicleStatus!=='READY'||!Array.isArray(proof.vehicleDays))return null;
      const rows=proof.vehicleDays.flatMap(([customerCode,vehicle,center,mask])=>{
        const store=coordinateByCode.get(customerCode);
        return store&&Number.isFinite(store.lat)&&Number.isFinite(store.lng)?[{customerCode,vehicle,center,mask,lat:store.lat,lng:store.lng}]:[];
      });
      if(proof.vehicleCounts&&rows.length!==proof.vehicleCounts.rows)return null;
      return {rows,unknownDays:proof.unknownDays,unverified:proof.unverifiedVehicleSources,byPoint:new WeakMap()};
    }).catch(()=>null).then(result=>{if(!result&&newAreaObservedFlight===owner)newAreaObservedFlight=null;return result;});
    newAreaObservedFlight=owner;
    return owner.task;
  }

  function observedNewAreaVehicles(row,evidence,radius) {
    if(!evidence||!Number.isFinite(row.lat)||!Number.isFinite(row.lng))return [];
    if(!evidence.byPoint.has(row))evidence.byPoint.set(row,Phase2bUi.nearbyVehicleWeekdays(row,evidence.rows));
    return Phase2bUi.vehiclesAtRadius(evidence.byPoint.get(row),radius);
  }

  const newAreaObservationMarkup=(open=false)=>stageAddressBatchEnabled()&&snapshotMeta?.sourceGeneration?
    `<details class="areaObservedRoutes"${open?' open':''}><summary>실제 완료 배송 호차·관측 요일</summary><div></div></details>`:'';

  function bindNewAreaObservation(parent,row) {
    const details=parent.querySelector?.('.areaObservedRoutes');
    if(!details)return;
    const render=async()=>{
      if(!details.open)return;
      const body=details.lastElementChild;
      if(!body.textContent)body.textContent='완료 배송 기록 조회 중';
      const evidence=await readNewAreaObservations();
      if(!details.isConnected||!details.open)return;
      if(!evidence){body.textContent='완료 배송 기록 미확인';return;}
      const vehicles=observedNewAreaVehicles(row,evidence,newAreaRadius);
      const scope=[Number.isInteger(evidence.unknownDays)?`${evidence.unknownDays}일 미확인`:null,
        evidence.unverified?.length?'영남·중앙냉동 원천 조회 권한 미확인':null].filter(Boolean).join(' · ');
      body.innerHTML=`<p class="areaInquiryHint">${newAreaRadius}km · 실제 완료 배송 ${vehicles.length}호차${scope?' · '+esc(scope):''}</p>
        <ul class="areaRouteList">${vehicles.map(item=>`<li>${esc(MapPeriodUi.areaVehicleLabel(item))} · 직선 ${MapPeriodUi.areaDistance(item.distance)} · ${esc(item.weekdays.join('·'))}</li>`).join('')}</ul>
        <p class="areaInquiryHint">관측 요일이며 정기 배차 일정은 별도 확인이 필요합니다.</p>`;
    };
    details.ontoggle=render;
    if(details.open)void render();
  }
  async function stageBatchAddressEvidence(rows,signal,requestId){
    const generation=snapshotMeta?.sourceGeneration??null;
    const inputs=rows.map(row=>{
      const code=row.address.trim().toUpperCase();
      return /^[A-Z]\d{3,}$/.test(code)?[code]:NewAreaRequests.addressQueries(row.address,Phase2bUi.addressVariants);
    });
    const resolved=[];
    for(let offset=0;offset<inputs.length;offset+=120){
      const chunk=inputs.slice(offset,offset+120);
      const result=await fetchJson('/api/map-phase2b/private/stage-address-evidence',{
        channel:'stage-address-batch:'+requestId,method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({generation,rows:chunk}),timeout:12000,signal
      }).catch(error=>({error:error.code||error.message,status:error.status}));
      if(signal.aborted)break;
      const error=result.error||((snapshotMeta?.sourceGeneration??null)!==generation?'STAGE_BATCH_GENERATION_CHANGED':
        result.generation!==generation||result.data?.length!==chunk.length?'STAGE_BATCH_UNAVAILABLE':null);
      resolved.push(...(error?chunk.map(()=>({error,httpStatus:result.status})):result.data));
    }
    return resolved;
  }
  function judgeStageAreaRow(row,evidence,batch){
    const status=evidence?.status;
    if(evidence?.point&&['STORED','OFFICIAL'].includes(status))return judgeNewAreaPoint(row,evidence.point,batch);
    const error=evidence?.error;
    const http=evidence?.httpStatus;
    const messages={STAGE_BATCH_GENERATION_EXPIRED:'검증 자료 사용 기간 만료 · 지도 새로고침 필요',STAGE_BATCH_GENERATION_CHANGED:'검증 자료가 변경됨 · 지도 새로고침 필요',
      CUSTOMER_CODE_NOT_FOUND:'저장 자료에서 고객코드 미확인',STORED_COORDINATE_UNVERIFIED:'저장 고객 확인 · 좌표 검증 필요',
      ADDRESS_NOT_MATCHED:'저장·공식 자료에서 주소 일치 없음',ADDRESS_AMBIGUOUS:'주소에 연결된 저장 위치가 여러 곳입니다',
      INVALID_ADDRESS:'주소 입력 확인 필요',OFFICIAL_COORDINATE_UNVERIFIED:'공식 주소 확인 · 좌표 검증 필요',
      OFFICIAL_ADDRESS_INDEX_UNAVAILABLE:'공식 주소 자료를 사용할 수 없습니다',OFFICIAL_ADDRESS_UNAVAILABLE:'공식 주소 조회 실패',
      STORED_REGISTRY_UNAVAILABLE:'저장 매장 자료 복원 중 · 다시 조회해 주세요',
      REQUEST_TIMEOUT:'저장 주소 조회 시간 초과',STAGE_BATCH_UNAVAILABLE:'저장 주소 자료 조회 실패'};
    const candidates=status==='OFFICIAL_ADDRESS_AMBIGUOUS'?evidence.points?.map(point=>({...point,coordinateSource:'OFFICIAL_PUBLIC_BUILDING'})):null;
    const failed=!!error||['OFFICIAL_ADDRESS_INDEX_UNAVAILABLE','OFFICIAL_ADDRESS_UNAVAILABLE','STORED_REGISTRY_UNAVAILABLE'].includes(status)||!status;
    const reason=http===401?'직원 로그인 필요':http===403?'주소 조회 권한 없음':messages[error||status]|| (candidates?'공식 주소 위치 후보 확인 필요':'저장 주소 조회 실패');
    const pending=judgeNewAreaPoint(row,candidates?{candidates}:null);
    return {...pending,reason:pending.decision==='X'?pending.reason:reason,evidence:(pending.decision==='X'?pending.evidence+' · ':'')+(http?`${reason} · HTTP ${http}`:reason),
      lookupStatus:failed?'FAILED':'DEFERRED',lookupError:failed,lookupHttpStatus:http};
  }
  function newAreaRegistryRows() {
    return customerRegistry?.summary().version?customerRegistry.merge(latestSnapshotRows):latestSnapshotRows;
  }

  function prepareNewAreaDispatch() {
    if(baseVehicleRequest)return baseVehicleRequest;
    if(document.body.dataset.mapStaffState!=='authenticated')return null;
    const codes=newAreaRegistryRows().map(row=>row.customerCode||row.code)
      .filter(code=>/^[A-Z]\d+$/.test(code)&&!baseVehicles.has(code)&&!baseVehicleExtraCodes.has(code));
    return codes.length?loadBaseVehicles(codes):null;
  }

  const dispatchDayKeys=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  function newAreaEvidence() {
    const locationRows=[],dispatchByCode=new Map(),dispatchStops=[];
    for(const store of newAreaRegistryRows()){
      const code=store.customerCode||store.code;
      if(!code||store.deliveryOnly||store.customerRegistryStatus==='DELETED')continue;
      const point=newAreaCoordinate({...store,customerCode:code,customerName:store.customerName||store.name||''},{fixedOnly:true});
      if(!point)continue;
      locationRows.push(point);
      const assignment=baseVehicles.get(code);
      if(assignment?.baseVehicleSource!=='FIXED_DISPATCH_PRIMARY'||!['VERIFIED_MASTER','UNASSIGNED'].includes(assignment.baseVehicleState))continue;
      const byVehicle=new Map();
      const primary=normalizeVehicle(assignment.baseVehicle);
      if(/^\d+$/.test(primary))byVehicle.set(primary,0);
      dispatchDayKeys.forEach((day,index)=>{
        const vehicle=normalizeVehicle(assignment.weekdays?.[day]);
        if(/^\d+$/.test(vehicle))byVehicle.set(vehicle,(byVehicle.get(vehicle)||0)|(1<<((index+1)%7)));
      });
      const assignments=[];
      for(const [vehicle,mask] of byVehicle){
        assignments.push({vehicle,weekdays:Phase2bUi.observedWeekdays(mask)});
        dispatchStops.push({customerCode:code,customerName:point.customerName,lat:point.lat,lng:point.lng,
          vehicle,center:assignment.baseVehicleGroup,mask});
      }
      dispatchByCode.set(code,{assignments,state:assignment.baseVehicleState});
    }
    return {locationRows,dispatchByCode,dispatchStops,dispatchCheckedAt:baseVehicleMeta?.checkedAt||'',
      dispatchStale:baseVehicleMeta?.stale!==false||!!baseVehicleMeta?.lastError};
  }

  function newAreaDispatchFacts(point,nearestCode,evidence) {
    const {dispatchByCode,dispatchStops,dispatchCheckedAt,dispatchStale}=evidence;
    const assigned=dispatchByCode.get(nearestCode);
    return {nearestDispatch:assigned?.assignments||[],nearestDispatchLabel:assigned?.state==='UNASSIGNED'?'미배정':'미확인',
      dispatchVehicles:Phase2bUi.nearbyVehicleWeekdays(point,dispatchStops),dispatchCheckedAt,dispatchStale};
  }

  function judgeNewAreaPoint(row, point, batch) {
    const checked=newAreaCoordinate(point);
    const text=row.address+' '+(row.customer||'');
    const exception=legacyException(text)||(checked?.address?legacyException(checked.address+' '+(row.customer||'')):'');
    const base={...row,...point,...checked,address:row.address,customer:row.customer,originalAddress:row.originalAddress,originalCustomer:row.originalCustomer,
      resolvedAddress:point?.address,lookupStatus:checked?'SUCCESS':'DEFERRED',addressRegion:row.addressRegion||point?.addressRegion||window.MapLocationContract?.addressRegion(row.address)||'주소 권역 미확인',
      actualDispatchCenter:row.actualDispatchCenter||point?.actualDispatchCenter||{state:'UNCONFIRMED',label:'담당 센터 미확인'},rangeStart:state.rangeStart,rangeEnd:state.rangeEnd,
      decision:'검토',nearestDistance:null,facility:facilityReview(text)||facilityReview(checked?.address)};
    if(!checked||point.candidates)return {...base,...(exception?{decision:'X',reason:exception,evidence:'기존 배송 제외 규칙 · 위치 미확인'}:
      {reason:point?.candidates?'주소 복수 후보':'주소 확인 필요',evidence:point?.candidates?'주소 후보를 먼저 확정해 주세요.':'검증된 주소 위치 미확인'})};
    const evidence=batch?(batch.evidence ||= newAreaEvidence()):newAreaEvidence();
    const nearest=Phase2bUi.nearestRegisteredStore(checked,evidence.locationRows);
    const nearestDistanceMeters=nearest?Math.round(nearest.distance*1000):null;
    const facts={...base,nearestStore:nearest?.customerName||'',nearestStoreCode:nearest?.customerCode||'',
      nearestDistance:nearest?.distance??null,nearestDistanceMeters,...newAreaDispatchFacts(checked,nearest?.customerCode,evidence)};
    if(exception)return {...facts,decision:'X',reason:exception,evidence:'기존 지역·시설·배송동선 제외 규칙'};
    if(point.coordinateSource==='MAP_CLICK_TEMPORARY')return {...facts,reason:'임시 위치 선택 · 배송판정 검토',evidence:'직접 선택한 위치의 실제 주소를 확인해 주세요.'};
    if(nearest?.distance<=0.5)return {...facts,decision:'O',reason:'',eligibilityBasis:'FIXED_REGISTRY_500M',
      evidence:'최근접 고정 등록 매장까지 직선 '+nearestDistanceMeters+'m(500m 이내) · 실제 수락·배송일'+(base.facility?'·차량 진입':'')+' 별도 확인'};
    if(base.facility)return {...facts,reason:'차량 진입 확인 필요',evidence:'시설 진입 확인 전 배송 가능 여부를 확정할 수 없습니다.'};
    if(!nearest)return {...facts,reason:'등록 매장 위치 미확인',evidence:'검증된 고정 등록 매장 좌표를 확인해 주세요.'};
    return {...facts,reason:'배송동선 확인 필요',evidence:'최근접 고정 등록 매장까지 직선 500m 초과 · 배송동선 추가 확인'};
  }

  let newAreaRequestId = 0;
  let newAreaRadius = 30;
  let newAreaBusy = false, batchController = null, addressController = null;
  let newAreaBatch = null;
  const newAreaSelectedPoints = new Map();
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
    $('#cancelNewAreaBatch').disabled = !value;
    const retry=$('#retryNewAreaBatch');
    if(retry)retry.disabled=value||!newAreaBatch?.rows.some((row,index)=>retryableAreaRow(row,newAreaBatch.judged[index]));
    $('#newAreaBatchResults').setAttribute('aria-busy', String(value));
  }
  function retryableAreaRow(row,result) {
    return !row.inputAmbiguous&&(!result||['FAILED','DEFERRED','LIMIT'].includes(result.lookupStatus));
  }
  function cancelNewAreaWork() {
    if(!newAreaBusy)return;
    batchController?.abort();
    batchController=null;
    setNewAreaBusy(false);
    publishNewAreaResults();
    $('#newAreaBatchStatus').textContent='조회 취소 · 완료 '+state.newAreaResults.length+'행 유지';
  }
  function clearNewAreaBatch(clearInput = true) {
    ++newAreaRequestId;
    batchController?.abort(); batchController = null;
    if(newAreaPositionControl)clearSearchTemporaryPin();
    newAreaBatch = null;
    if(clearInput)newAreaSelectedPoints.clear();
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

  async function judgeBatchRow(row, signal, batch) {
    const timeout = new AbortController();
    const limit = setTimeout(() => timeout.abort(Object.assign(Error('NEW_AREA_ROW_TIMEOUT'), {code:'NEW_AREA_ROW_TIMEOUT'})), 15000);
    const rowSignal = AbortSignal.any([signal, timeout.signal]);
    let stop;
    try {
      const cancelled = new Promise((_resolve,reject) => {
        stop = () => reject(rowSignal.reason);
        if (rowSignal.aborted) stop();
        else rowSignal.addEventListener('abort', stop, {once:true});
      });
      return await Promise.race([cancelled, judgeNewAreaRow(row, rowSignal, batch)]);
    } finally {
      clearTimeout(limit);
      rowSignal.removeEventListener('abort', stop);
    }
  }

  function newAreaSummaryMarkup(row) {
    const label=row.decision==='O'?'배송 가능 (O)':row.decision==='X'?'배송 불가 (X)':'검토 필요';
    const kind=row.decision==='O'?'ok':row.decision==='X'?'no':'review';
    const nearest=row.nearestStoreCode&&Number.isFinite(row.nearestDistanceMeters)
      ?`<strong>${esc(row.nearestStore||'매장명 미확인')} · ${esc(row.nearestStoreCode)}</strong> · <strong>${row.nearestDistanceMeters}m</strong>`:'등록 매장 위치 미확인';
    const assigned=row.nearestDispatch||[];
    const vehicles=assigned.map(item=>vehicleLabel(item.vehicle)).join(' · ')||row.nearestDispatchLabel||'미확인';
    const weekdays=assigned.map(item=>vehicleLabel(item.vehicle)+' '+MapPeriodUi.areaDispatchDays(item)).join(' · ')||'미확인';
    return `<div><span class="judgeBadge ${kind}">${label}</span> ${esc(row.reason||'')}</div>
      <div data-area-nearest>가장 가까운 등록 매장(직선거리): ${nearest}</div>
      <div data-area-nearest-vehicles>배차표상 호차: <strong>${esc(vehicles)}</strong></div>
      <div data-area-nearest-weekdays>배정 요일: <strong>${esc(weekdays)}</strong></div>
      <div class="areaInquiryHint" data-area-dispatch-reference>${esc(MapPeriodUi.areaDispatchReference(row))}</div>
      <div class="areaInquiryHint">${esc(row.evidence||'')}</div>`;
  }

  function newAreaVehicleTitle(row,radius) {
    const count=MapPeriodUi.areaDispatchVehicles(row,radius).length;
    return `${radius}km 내 참고 배차호차 · ${count?count+'대 확인':'확인된 호차 없음'}`;
  }

  function newAreaVehicleContent(row,radius,interactive=false) {
    const groups=MapPeriodUi.areaDispatchVehicles(row,radius);
    if(!groups.length)return '<p>이 범위에서 확인된 배차호차가 없습니다.</p>';
    const list=groups.map((item,index)=>{
      const label=`<b>${esc(MapPeriodUi.areaVehicleLabel(item))}</b> · 직선 ${MapPeriodUi.areaDistance(item.distance)} · ${esc(MapPeriodUi.areaDispatchDays(item))}`;
      return `<li>${interactive?`<button type="button" class="tiny areaDispatchChoice" data-area-dispatch-vehicle="${index}" aria-pressed="${newAreaVehicleKey===areaVehicleKey(item)}">${label}</button>`:label}</li>`;
    }).join('');
    return `<p class="areaInquiryHint">호차별 가장 가까운 배정 매장까지의 직선거리와 배차요일입니다.</p>
      ${interactive?'<button type="button" class="tiny" data-area-dispatch-overview>반경 지도 보기</button>':''}<ul class="areaRouteList">${list}</ul>`;
  }

  function setNewAreaRadius(value) {
    const next=MapPeriodUi.areaRadius(value);
    newAreaRadius=next;
    for(const id of ['#newAreaSingleRadius','#newAreaBatchRadius']){const input=$(id);if(input)input.value=String(next);}
    if(state.virtual?.searchTemporary)renderSearchTemporaryNearby(state.virtual,{loadDispatch:false,fit:true});
    for(const entry of $('#newAreaBatchResults').children){
      const row=newAreaBatch?.judged[Number(entry.dataset.areaIndex)];
      if(!row)continue;
      const details=entry.querySelector('.areaVehicles');
      if(details){details.firstElementChild.textContent=newAreaVehicleTitle(row,next);
        details.lastElementChild.innerHTML=details.open?newAreaVehicleContent(row,next):'';}
      bindNewAreaObservation(entry,row);
    }
  }

  function newAreaSourceVersion() {
    return JSON.stringify([snapshotMeta?.sourceGeneration,snapshotMeta?.preservation?.version,snapshotMeta?.version,
      snapshotMeta?.generatedAt,customerRegistry?.summary().version]);
  }

  function reviewNewAreaPosition(list,row,index,dialog) {
    const batch=newAreaBatch;
    clearSearchTemporaryPin();
    dialog.close();
    const requestId=state.addressRequestId;
    const control=newAreaPositionControl=document.createElement('div');
    control.className='newAreaPositionControl';
    control.innerHTML='<div role="status"></div><div class="newAreaPositionChoices" hidden></div><button type="button">취소하고 목록으로</button>';
    $('#map').after(control);
    const status=control.firstElementChild, cancel=control.lastElementChild;
    const finish=()=>{
      clearSearchTemporaryPin();
      if(newAreaBatch===batch&&state.mode==='BASE_60D'&&!dialog.open)$('#sourceBatch').click();
    };
    cancel.onclick=finish;
    control.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();finish();}};
    const choose=point=>{
      if(newAreaBatch!==batch||state.mode!=='BASE_60D'||state.addressRequestId!==requestId)return;
      if(batch.sourceVersion!==newAreaSourceVersion()){
        $('#newAreaBatchStatus').textContent='지도 자료가 갱신됐습니다. 다시 판단해 주세요.';
        finish();return;
      }
      const selected=newAreaCoordinate(point);
      if(!selected)return;
      const {lat,lng,address,coordinateSource,customerCode}=selected;
      const location={lat,lng,address:address||row.address,coordinateSource,customerCode,officialRoad:row.officialRoad,officialLot:row.officialLot};
      const resolved=judgeNewAreaPoint(batch.rows[index],location,batch);
      batch.manualPoints.set(index,location);
      batch.judged[index]=resolved;
      appendBatchResult(list,resolved,index);publishNewAreaResults();setNewAreaBusy(false);
      const located=batch.judged.filter(item=>item&&Number.isFinite(item.lat)&&Number.isFinite(item.lng)).length;
      $('#newAreaBatchStatus').textContent=`${index+1}번 행 위치 선택 완료 · 입력 ${batch.rows.length} · 위치 표시 ${located}`;
      finish();
    };
    const candidates=(row.candidates||[]).filter(newAreaCoordinate);
    if(candidates.length){
      status.textContent=`${index+1}번 행의 위치 후보를 선택하세요.`;
      showAddressCandidates(candidates,choose,control.querySelector('.newAreaPositionChoices'));
    }else{
      status.textContent=`${index+1}번 행의 위치를 지도에서 선택하세요. 좌표는 저장되지 않습니다.`;
      $('#map').setAttribute('data-search-position-pending','true');
      searchTemporaryClick=event=>{
        const point=newAreaCoordinate({lat:event?.latLng?.getLat?.(),lng:event?.latLng?.getLng?.()});
        if(point)choose({...point,address:row.officialRoad||row.address,coordinateSource:'MAP_CLICK_TEMPORARY'});
      };
    }
    if(innerWidth<=760)showMobileMap();
    cancel.focus();
  }

  function appendBatchResult(list, row, index) {
    const template = document.createElement('template');
    const pointLabel={OFFICIAL_PUBLIC_PARCEL:'공식 필지 대표점',OFFICIAL_PUBLIC_ADDRESS:'공식 주소 대표점',
      OFFICIAL_PUBLIC_BUILDING:'공식 자료 건물 위치',MAP_CLICK_TEMPORARY:'지도에서 직접 선택한 임시 위치'}[row.coordinateSource];
    const located=row.lookupStatus==='SUCCESS'&&Number.isFinite(row.lat)&&Number.isFinite(row.lng);
    template.innerHTML = `<div class="areaBatchEntry" data-area-index="${index}"><button type="button" class="judgeCard batchResult" data-judged="${index}">
      <b>${esc(row.customer || row.address)}</b><div>사용 주소: ${esc(row.address)}</div>
      ${pointLabel?`<div>${pointLabel}</div>`:''}
      ${!located?'<div>클릭하여 확인된 위치 입력</div>':''}
      ${newAreaSummaryMarkup(row)}
      ${row.officialRoad?`<div>공식 도로명: ${esc(row.officialRoad)} · 지번: ${esc(row.officialLot||'미확인')}</div>`:''}</button>
      ${located?`<details class="areaVehicles"><summary>${newAreaVehicleTitle(row,newAreaRadius)}</summary><div></div></details>${newAreaObservationMarkup()}`:''}</div>`;
    const entry = template.content.firstElementChild;
    const button = entry.querySelector?.('button') || entry;
    const details=entry.querySelector?.('.areaVehicles');
    bindNewAreaObservation(entry,row);
    details?.addEventListener('toggle',()=>{
      details.lastElementChild.innerHTML=details.open?newAreaVehicleContent(row,newAreaRadius):'';
    });
    button.disabled = true;
    const existing=[...list.children].find(item=>Number(item.dataset.areaIndex??item.dataset.judged)===index);
    existing?.remove();
    const next = [...list.children].find(item=>Number(item.dataset.areaIndex??item.dataset.judged)>index);
    list.insertBefore(entry, next || null);
    button.onclick = () => {
      if (!located) {
        const dialog = $('#mapBatchDialog'), manual = $('#manualRouteTool');
        if (row.inputAmbiguous || (!row.customerCode && /^[A-Z]\d{3,}$/i.test(row.address))) return;
        if (row.customerCode && window.MapManualPins?.open) { dialog?.close(); void window.MapManualPins.open(row.customerCode); return; }
        if (!row.customerCode && dialog?.open && newAreaBatch && !newAreaBusy && state.map) {
          reviewNewAreaPosition(list,row,index,dialog);
          return;
        }
        manual.open = true; manual.hidden = false; manual.inert = false; manual.dataset.modeHidden = 'false';
        $('#manualLabel').value = row.address;
        $('#manualLat').value = ''; $('#manualLng').value = '';
        if (dialog?.open) dialog.append(manual);
        else activateSheet('manual');
        $('#manualStatus').textContent = '이 주소의 확인된 위도·경도를 입력하고 좌표 지점 추가 후 신규권역 일괄 판단을 다시 실행해 주세요.';
        $('#manualLat').focus();
        return;
      }
      $('#mapBatchDialog')?.close();
      const areaFacts=newAreaBatch?.sourceVersion===newAreaSourceVersion()?row:null;
      showVirtual({...row,address:row.resolvedAddress||row.address,customerName:row.customer||'조회 주소',
        customerMatchState:row.customerCode?'REGISTERED':'UNCONFIRMED'},areaFacts);
    };
  }

  function publishNewAreaResults() {
    state.newAreaResults = newAreaBatch?.judged.filter(Boolean)||[];
    const empty=!state.newAreaResults.length;
    for(const id of ['#exportNewAreaCsv','#exportNewAreaExcel','#copyAreaDecision','#copyAreaMatching']) {
      const control=$(id);
      if(control)control.disabled=empty;
    }
    for(const button of $('#newAreaBatchResults').querySelectorAll('[data-judged]'))button.disabled=false;
  }

  function newAreaExportRows() {
    return newAreaBatch?newAreaBatch.rows.map((row,index)=>newAreaBatch.judged[index]||{...row,decision:'검토'}):state.newAreaResults;
  }

  async function runNewArea(inputId, statusId, resultId, retry = false) {
    if (newAreaBusy) return;
    const status = $(statusId), list = $(resultId);
    if (state.mode !== 'BASE_60D') { status.textContent = '매장·권역 지도에서 조회해 주세요.'; return; }
    const periodKey = state.rangeStart + '|' + state.rangeEnd;
    const input = $(inputId).value;
    const sourceVersion = newAreaSourceVersion();
    const sameBatch = newAreaBatch?.input===input && newAreaBatch.periodKey===periodKey && newAreaBatch.sourceVersion===sourceVersion;
    if(retry && !sameBatch){
      status.textContent='조회 조건이 바뀌었습니다. 다시 판단해 주세요.';return;
    }
    if(!retry){
      const manualPoints=sameBatch?newAreaBatch.manualPoints:new Map();
      clearNewAreaBatch(false);
      const rows = parseNewArea(inputId);
      if(!rows.length){status.textContent='주소를 입력해주세요.';return;}
      newAreaBatch={input,periodKey,sourceVersion,rows,manualPoints,judged:new Array(rows.length)};
    }
    const {rows,judged,manualPoints}=newAreaBatch;
    const indexes=rows.map((_row,index)=>index).filter(index=>!retry||retryableAreaRow(rows[index],judged[index]));
    if(!indexes.length)return;
    const requestId = ++newAreaRequestId;
    const controller = batchController = new AbortController();
    const {signal} = controller;
    const current = () => requestId === newAreaRequestId && !signal.aborted && state.mode === 'BASE_60D' &&
      periodKey === state.rangeStart + '|' + state.rangeEnd && sourceVersion===newAreaSourceVersion();
    const batch = {requestId,signal,customers:new Map(),queries:new Map(),blocked:null,selectedPoints:new Map(newAreaSelectedPoints)};
    const dispatchPending=prepareNewAreaDispatch();
    const retainedPoints=new Map();
    for(const index of indexes){
      const row=rows[index];
      const point=manualPoints.get(index)||batch.selectedPoints.get(row.address);
      if(point)retainedPoints.set(index,point);
    }
    const active = new Set();
    let next = 0, completed = 0;
    setNewAreaBusy(true);
    const counts={done:0,located:0,deferred:0,deliveryHold:0,failed:0,limited:0,inside:0};
    function countResult(row, change) {
      if(!row)return;
      counts.done+=change;
      if(row.lookupStatus==='SUCCESS'||newAreaCoordinate(row)){
        counts.located+=change;
        if(row.decision==='검토')counts.deliveryHold+=change;
      }
      else if(row.lookupStatus==='FAILED')counts.failed+=change;
      else if(row.lookupStatus==='LIMIT')counts.limited+=change;
      else counts.deferred+=change;
      if(row.decision==='O')counts.inside+=change;
    }
    judged.forEach(row=>countResult(row,1));
    function showProgress() {
      const checking=[...active].map(index=>index+1).sort((a,b)=>a-b).join(', ');
      const details=stageAddressBatchEnabled()?` · 위치 보류 ${counts.deferred} · 배송판정 보류 ${counts.deliveryHold} · 시스템 오류 ${counts.failed}`:` · 보류 ${counts.deferred} · 실패 ${counts.failed}`;
      status.textContent='입력 '+rows.length+' · 완료 '+counts.done+' · 위치 확인 '+counts.located+details+' · 한도대기 '+counts.limited+
        ' · 권역 내 '+counts.inside+(retry&&completed<indexes.length?' · 재조회 '+completed+'/'+indexes.length:'')+(checking?' · 확인 중 '+checking+'번':'');
    }
    async function worker() {
      while (current() && next<indexes.length) {
        const index=indexes[next++], row=rows[index];
        active.add(index);showProgress();
        let result;
        try { result=retainedPoints.has(index)?judgeNewAreaPoint(row,retainedPoints.get(index),batch):batch.stageRows&&!row.inputAmbiguous
          ?judgeStageAreaRow(row,batch.stageRows.get(index),batch):await judgeBatchRow(row,signal,batch); }
        catch (error) {
          if (!current()) return;
          if (NewAreaRequests.stopsExternal(error) || window.kakaoGeocoder?.blockedReason) batch.blocked=error.code || 'GEOCODE_AUTOMATICALLY_BLOCKED';
          const lookupStatus=NewAreaRequests.outcome(error);
          const reason=lookupStatus==='LIMIT'?'일일 주소 조회 한도 대기':lookupStatus==='DEFERRED'?NewAreaRequests.message(error):'조회 실패 · 검토필요';
          const unresolved=judgeNewAreaPoint(row,null);
          result={...unresolved,reason:unresolved.decision==='X'?unresolved.reason:reason,
            evidence:[unresolved.decision==='X'?unresolved.evidence:'',NewAreaRequests.message(error),'원문 보존'].filter(Boolean).join(' · '),
            lookupStatus,lookupError:lookupStatus==='FAILED'};
        }
        if (!current()) return;
        countResult(judged[index],-1);
        active.delete(index);judged[index]=result;completed++;
        countResult(result,1);
        appendBatchResult(list,result,index);showProgress();
      }
    }
    try {
      showProgress();
      if (stageAddressBatchEnabled()) {
        const requested=indexes.filter(index=>!retainedPoints.has(index)&&!rows[index].inputAmbiguous);
        const results=await stageBatchAddressEvidence(requested.map(index=>rows[index]),signal,requestId);
        batch.stageRows=new Map(requested.map((index,i)=>[index,results[i]]));
      }
      if (!current()) return;
      await Promise.all(Array.from({length:Math.min(3,indexes.length)},worker));
      if(dispatchPending)void dispatchPending.then(()=>{
        if(requestId!==newAreaRequestId||state.mode!=='BASE_60D'||sourceVersion!==newAreaSourceVersion()||judged!==newAreaBatch?.judged)return;
        const evidence=newAreaEvidence();
        judged.forEach((row,index)=>{
          if(row?.lookupStatus!=='SUCCESS')return;
          const updated={...row,...newAreaDispatchFacts(row,row.nearestStoreCode,evidence)};
          judged[index]=updated;appendBatchResult(list,updated,index);
        });
        publishNewAreaResults();
      });
    } finally {
      if (batchController===controller && requestId===newAreaRequestId) {
        const valid = current();
        controller.abort(); batchController=null; setNewAreaBusy(false);
        if(valid){
          publishNewAreaResults();active.clear();showProgress();
        } else {
          clearNewAreaBatch(false);status.textContent='조회 조건이 바뀌었습니다. 다시 판단해 주세요.';
        }
      }
    }
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
  function formatTime(value,seconds=false) { if (!value) return ""; const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", ...(seconds?{second:"2-digit"}:{}), hour12: false }).format(date); }
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
    const requestSignal = options.signal;
    const abort = () => controller.abort("cancelled");
    requestSignal?.addEventListener("abort", abort, { once: true });
    if (requestSignal?.aborted) abort();
    const timer = setTimeout(() => controller.abort("timeout"), timeout);
    const started = performance.now();
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers: options.headers, method:options.method,body:options.body });
      apiDiagnostics.set(new URL(url, location.href).pathname.split("/").pop(), { ms: Math.round(performance.now() - started), status: response.status, cache: response.headers.get("X-Phase2B-Cache") || "미제공",restoreMs:Number(response.headers.get('X-Opsmap-Restore-Ms'))||null });
      const json = await response.json().catch(error=>{if(response.ok)throw error;return {};});
      if (requestControllers.get(channel)?.token !== token) { const stale = new Error("STALE_RESPONSE"); stale.silent = true; throw stale; }
      if (!response.ok || json.error && !options.allowSourceError) {
        const retry=response.headers.get('Retry-After');
        const retryAfterMs=retry?Math.max(0,/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now()):undefined;
        throw Object.assign(new Error(json.error || `HTTP_${response.status}`), {status:response.status,sourceHttp:json.sourceHttp,
          code:json.sourceCode || json.error || `HTTP_${response.status}`,retryAfterMs:Number.isFinite(retryAfterMs)?retryAfterMs:undefined});
      }
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
      requestSignal?.removeEventListener("abort", abort);
      if (requestControllers.get(channel)?.token === token) requestControllers.delete(channel);
    }
  }
  function showMobileMap() {
    if (innerWidth > 760) return;
    const wasOpen = document.body.classList.contains("mobileMap");
    document.body.classList.add("mobileMap");
    if (wasOpen) return;
    setTimeout(() => {
      mapCamera?.scheduleRelayout();
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

  async function loadDailyCompletionEvidence(){
    if(dailyMeta?.roster)return loadRosterChronology();
    const vehicles=selectedVehicles(),vehicle=vehicles[0],meta=dailyMeta,date=state.selectedDate;
    if(stageAddressBatchEnabled())return;
    if(vehicles.length!==1||meta?.completionEvidence!=='DELIVERY_STATUS_RECORD_V1'||meta.retained||
      !meta.generatedAt||!operationStops.some(row=>row.status==='COMPLETED'))return;
    const key=[date,vehicle,meta.generatedAt].join('|'),view=dailyView;
    const entry=dailyEvidenceReads.get(key);
    if(entry?.applied===view||entry?.retryAt>Date.now())return;
    const query=new URLSearchParams({date,vehicle,observedAt:meta.generatedAt});
    const read=entry||{};
    if(!read.promise){
      read.promise=fetchJson('/api/map-phase2b/preview/daily-completions?'+query,{channel:'daily-completions:'+key,timeout:15000})
        .then(response=>{
          const result=response.data;
          if(response.ok!==true||result?.date!==date||result.vehicle!==vehicle||result.observedAt!==meta.generatedAt||
            result.complete!==true||!Array.isArray(result.events)||result.events.length>80)throw Error('DATED_ASSIGNMENTS_INCOMPLETE');
          return result.events;
        }).catch(()=>{read.promise=null;read.retryAt=Date.now()+30000;return null;});
      dailyEvidenceReads.set(key,read);
      while(dailyEvidenceReads.size>16)dailyEvidenceReads.delete(dailyEvidenceReads.keys().next().value);
    }
    const events=await read.promise;
    if(!events||view!==dailyView||!isDailyDataReady()||state.selectedDate!==date||dailyMeta?.generatedAt!==meta.generatedAt||
      selectedVehicles().join()!==vehicle||read.applied===view)return;
    const grouped=new Map();
    for(const item of events){
      const row=storeByVehicleAndCode.get(datedVisitKey(vehicle,item?.customerCode));
      if(row?.status!=='COMPLETED'||item?.event?.individual!==true)continue;
      const group=grouped.get(row)||[];group.push(item.event);grouped.set(row,group);
    }
    for(const [row,events] of grouped){
      row.actualDeliveryEvents=[...events,...(row.actualDeliveryEvents||[])];
      row.actualCompletedAt=row.actualDeliveryEvents.map(event=>event.at).sort()[0]||null;
    }
    read.applied=view;renderRunList();drawRoute();
  }

  async function loadOperationStatus() {
    if(isDailyDataReady())await loadBaseMap();
  }

  async function refreshSelectedDate() {
    if(state.mode==='BASE_60D'){periodMeta=null;return changePeriod(state.rangeStart,state.rangeEnd);}
    if(state.selectedDate)return changeSelectedDate(state.selectedDate);
    return selectLatestRoute();
  }

  async function exportNewArea(format) {
    if (!state.newAreaResults.length) { $("#newAreaBatchStatus").textContent = "먼저 일괄 판단을 실행해주세요."; return; }
    if(!$('#newAreaApplyDate').value){$('#newAreaBatchStatus').textContent='적용일을 선택해 주세요.';return;}
    if(format==='xlsx'&&!window.XLSX){$('#newAreaBatchStatus').textContent='Excel 내보내기 모듈이 연결되지 않았습니다. CSV 내보내기를 이용해 주세요.';return;}
    const results=newAreaExportRows(), date=$('#newAreaApplyDate').value, radius=newAreaRadius;
    const includeObserved=stageAddressBatchEnabled()&&!!snapshotMeta?.sourceGeneration;
    const generation=snapshotMeta?.sourceGeneration;
    const observations=includeObserved?await readNewAreaObservations():null;
    if(includeObserved&&(document.body.dataset.mapStaffState!=='authenticated'||snapshotMeta?.sourceGeneration!==generation))return;
    const headings=includeObserved?[...MapPeriodUi.areaExportHeadings,'실제 완료 배송 호차·직선거리·관측 요일']:MapPeriodUi.areaExportHeadings;
    const rows=MapPeriodUi.areaExportRows(results,date,radius).map((values,index)=>{
      if(includeObserved){
        const observed=observedNewAreaVehicles(results[index],observations,radius).map(item=>
          MapPeriodUi.areaVehicleLabel(item)+' / '+MapPeriodUi.areaDistance(item.distance)+' / '+item.weekdays.join('·')).join(' | ');
        values.push(observations?observed:'자료 미확인');
      }
      return Object.fromEntries(headings.map((key,i)=>[key,values[i]]));
    });
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
    const visibleStores = periodListLimit ? stores.slice(0,periodListLimit) : [];
    $("#periodStoreListCount").textContent = stores.length + "개 매장";
    panel.innerHTML = visibleStores.map(row => `<button class="resultItem periodStore${state.selected?.customerCode === row.customerCode ? " selected" : ""}" aria-pressed="${state.selected?.customerCode === row.customerCode}" data-period-store="${esc(row.customerCode)}"><span class="periodCode">${esc(row.customerCode)}</span><b>${esc(row.customerName || row.customerCode)}</b><span>${esc(row.lastDeliveryDate || "")} · ${esc(vehicleLabel(row.vehicle))}</span><span>${esc(row.driverName || "기사 미등록")} · ${row.visitCount===null?'방문횟수 미확인':(row.visitCount??row.history?.length??0)+'회'}</span></button>`).join("") || `<p class="hint">${stores.length ? '검색하거나 지도 핀을 선택하세요. 전체 목록은 요청할 때만 표시합니다.' : '조회 조건에 맞는 매장이 없습니다.'}</p>`;
    $("#periodListMore").hidden = !periodListLimit || stores.length <= periodListLimit;
    const toggle=$('#togglePeriodList');if(toggle){toggle.textContent=periodListLimit?'접기':'펼치기';toggle.setAttribute('aria-expanded',String(!!periodListLimit));}
    $("#periodListMore").textContent = periodListLimit ? '매장 100개 더 보기' : '목록 보기 (100개씩)';
    $$("[data-period-store]").forEach(button => button.onclick = () => { const row = stores.find(item => item.customerCode === button.dataset.periodStore); if (row) selectStore(row, null, true); });
  }

  function bindEvents() {
    $("#modePeriod").onclick = () => { if(state.mode==='BASE_60D'&&generalMap&&dateReady)return;void initializeGeneral(); };
    $("#modeDaily").onclick = () => { state.routeDate ? changeSelectedDate(state.routeDate) : selectLatestRoute(); };
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
    $("#vehicleQuery").oninput = filterVehicleList;
    $("#vehicleQuery").onkeydown = (event) => {
      if (event.key !== "Enter") return;
      const first = visibleVehicleItems()[0];
      if (!first) return;
      event.preventDefault();
      const input = first.querySelector('input');
      input.checked = !input.checked;
      applyVehicleFilter(selectedVehicles());
    };
    $("#selectAllVehicles").onclick = () => applyVehicleFilter(visibleVehicleItems().map(item => item.querySelector('input').value));
    $("#clearVehicles").onclick = () => applyVehicleFilter([]);
    $$("[data-center]").forEach((button) => { button.onclick = () => { selectCenter(button.dataset.center); $("#vehicleSelect").classList.remove("open"); }; });
    let composing = false;
    $("#query").oncompositionstart = () => { composing = true; };
    $("#query").oncompositionend = () => { composing = false; };
    $("#query").oninput = () => {
      if(unifiedResetting)return;
      searchInputAt=performance.now();
      invalidateUnifiedSearch();if(typeof clearSearchTemporaryPin==='function')clearSearchTemporaryPin({restoreView:false});
      cancelAddressLookup();closeUnifiedSearchResults();setSearchState('');
      if(!$('#query').value.trim())clearUnifiedSearch();
    };
    $("#query").onkeydown = (event) => {
      if(event.key==='Escape'){invalidateUnifiedSearch();clearSearchTemporaryPin();cancelAddressLookup();closeUnifiedSearchResults();return;}
      if(event.key==='Enter'&&!composing&&!event.isComposing){event.preventDefault();void search();}
    };
    $("#searchBtn").onclick = search;
    window.addEventListener('map-unified-search-clear',clearUnifiedSearch);
    window.addEventListener('opsmap-search-clear',clearUnifiedSearch);
    document.addEventListener('pointerdown',event=>{if(!$('#results').contains(event.target)&&event.target!==$('#query'))closeUnifiedSearchResults();});
    let addressComposing = false;
    $("#addressQuery").oncompositionstart = () => { addressComposing = true; };
    $("#addressQuery").oncompositionend = () => { addressComposing = false; };
    const runAddress = () => { const text = $("#addressQuery").value.trim();if(text){$('#query').value=text;$('#query').dispatchEvent(new Event('input',{bubbles:true}));void search();} };
    $("#addressBtn").onclick = runAddress;
    $("#addressQuery").onkeydown = (event) => { if (event.key === "Enter" && !addressComposing && !event.isComposing) runAddress(); };
    $("#todayBtn").onclick = selectLatestRoute;
    ["#date", "#mobileDate", "#selectedDate"].forEach((id) => { $(id).onchange = (event) => { changeSelectedDate(event.target.value); }; });
    $("#operationVehicle").onchange = (event) => { const vehicle = event.target.value; setSelectedVehicles([vehicle]); $("#vehicle").value = vehicle; $("#mobileVehicle").value = vehicle; refreshVehicleUi(true); };
    $("#syncOperation").onclick = () => {if(state.mode==="DATE_ROUTE")return refreshSelectedDate();};
    $("#routePlan").onclick = () => loadRoute("pc");
    $("#endRoute").onclick = endRoute;
    $("#mapReset").onclick = resetMapOverview;
    $("#mobileMapReset").onclick = resetMapOverview;
    $("#mobileCenter").onchange = (event) => selectCenter(event.target.value);
    $("#mobileBaseVehicle").onchange = (event) => { state.centerFilter = ""; periodVehicleScope = event.target.value ? "selected" : "all"; setSelectedVehicles(event.target.value ? [event.target.value] : []); $("#mobileCenter").value = "all"; refreshVehicleUi(true); };
    $("#judgeNewAreaBatch").onclick = () => runNewArea("#newAreaBatchInput", "#newAreaBatchStatus", "#newAreaBatchResults");
    const batchRadius=$('#newAreaBatchRadius');
    if(batchRadius)batchRadius.onchange=event=>setNewAreaRadius(event.target.value);
    $("#clearNewAreaBatch").onclick = () => clearNewAreaBatch();
    $('#cancelNewAreaBatch').onclick = cancelNewAreaWork;
    $('#retryNewAreaBatch').onclick = () => runNewArea('#newAreaBatchInput','#newAreaBatchStatus','#newAreaBatchResults',true);
    $('#newAreaBatchTool').addEventListener('toggle', event => { if (!event.target.open) cancelNewAreaWork(); });
    $('#newAreaBatchTool > summary').addEventListener('click', () => { if ($('#newAreaBatchTool').open) cancelNewAreaWork(); });
    $('#newAreaBatchInput').oninput = () => {
      if(newAreaBatch)clearNewAreaBatch(false);
      if(newAreaSelectedPoints.size){
        const addresses=new Set(parseNewArea('#newAreaBatchInput').map(row=>row.address));
        for(const address of newAreaSelectedPoints.keys())if(!addresses.has(address))newAreaSelectedPoints.delete(address);
      }
    };
    $("#exportNewAreaCsv").onclick = () => exportNewArea("csv");
    $("#exportNewAreaExcel").onclick = () => exportNewArea("xlsx");
    for(const [id,kind] of [['#copyAreaDecision','decision'],['#copyAreaMatching','matching']])$(id).onclick=async()=>{
      if(!state.newAreaResults.length)return;
      if(!$('#newAreaApplyDate').value){$('#newAreaBatchStatus').textContent='적용일을 선택해 주세요.';return;}
      try{await navigator.clipboard.writeText(MapPeriodUi.areaTsv(newAreaExportRows(),$('#newAreaApplyDate').value,kind));$('#newAreaBatchStatus').textContent=`${state.newAreaResults.length}행 · ${kind==='decision'?'BV:BY 4열':'BJ:BK 2열'} 복사 완료`;}
      catch{$('#newAreaBatchStatus').textContent='클립보드 권한을 확인해 주세요. 결과 Excel 내보내기도 사용할 수 있습니다.';}
    };
    $("#todayStatusTool")?.addEventListener("toggle", (event) => { if (event.target.open) loadTodayStatus(); });
    $("#mobileBack").onclick = hideMobileMap;
    $("#closeMobileRoute").onclick = () => document.body.classList.remove("routeSheetOpen");
    $("#mobileToday").onclick = selectLatestRoute;
    $("#mobileRoutePlan").onclick = () => loadRoute("mobile");
    $("#openOperations").onclick = showDiagnostics;
    $$('[data-run-filter]').forEach((button) => button.onclick = () => { runFilter = button.dataset.runFilter; void loadBaseMap(); });
    $$('[data-sheet-tab]').forEach((button) => button.onclick = () => activateSheet(button.dataset.sheetTab));
    $("#sheetExpand").onclick = () => { if ($("#mobileWorkspace").classList.contains("collapsed")) $("#mobileWorkspace").classList.remove("collapsed"); else $("#mobileWorkspace").classList.toggle("expanded"); };
    window.addEventListener("resize", () => { if (innerWidth <= 760) showMobileMap(); else hideMobileMap(); activateSheet(); requestAnimationFrame(positionDetailPopup); });
    for(const event of ['resize','scroll'])window.visualViewport?.addEventListener(event,()=>{mapCamera?.scheduleRelayout();scheduleDetailPosition();});
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
    if(generalMap){await pollGeneralSnapshot();return;}
    if(state.mode!=='BASE_60D')return;
    if(recentPeriodMode){const range=MapPeriodUi.recentRange(status);if(range)await changePeriod(range.start,range.end);}
    else await changePeriod(state.rangeStart,state.rangeEnd);
  };
  clearNewAreaBatch();
  syncModeUi();
  $("#runListTool").open = false;
  ["Total", "Completed", "Remaining", "Eta"].forEach((name) => { $("#op" + name).parentNode.id = name.toLowerCase() + "Metric"; });
  $("#newAreaBatchTool > summary").textContent = "④ 신규권역 일괄조회";
  $('[data-sheet-tab="new"]').textContent = "신규권역";
  $(".addressBlock .label").hidden = true;
  $("#addressBtn").textContent = "위치 찾기";
  $(".addressBlock .hint").textContent = "임시핀 · 30km 주변 호차 확인 (공간거리)";
  $("#selectAllVehicles").textContent = "전체선택"; $("#clearVehicles").textContent = "전체해제";
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
    refreshGeneralSnapshot:pollGeneralSnapshot,
    refreshCustomerRegistry:syncCustomerRegistry,
    customerRegistryStatus:()=>customerRegistry?.summary(),
    isDataReady:()=>state.mode==='DATE_ROUTE'?isDailyDataReady():dateReady,
    initMap,
    stores:()=>allStores.slice(),
    refreshManualCoordinates(){indexedRows=null;pointIndex=null;for(const row of allStores){window.MapManualPins?.apply(row);liveAddressLocations?.apply(row);}if(state.selected){window.MapManualPins?.apply(state.selected);applyUnifiedSearchCoordinateGuard(state.selected);liveAddressLocations?.apply(state.selected);refreshCoordinateEvidence(state.selected);}cancelManualRoadRoute();state.fitRequested=false;void loadBaseMap();window.dispatchEvent(new Event('map-coordinate-updated'));},
    addressLocationStatus:code=>code?liveAddressLocations?.status(storesByCode.get(String(code))):liveAddressLocations?.summary()||{located:0,review:0,retention:'PAGE_MEMORY_ONLY'},
    refreshFixedTerritoryMaster:()=>loadBaseVehicles(),
    fixedTerritoryMasterState:()=>baseVehicleMeta?{version:baseVehicleMeta.version,checkedAt:baseVehicleMeta.checkedAt,stale:baseVehicleMeta.stale}:null,
    printCoordinateStores:()=>latestSnapshotRows.slice(),
    fixedTerritoryStores:()=>window.MapUiLocalBridge.navigationStores('BASE_60D').map(row=>({...row,...(baseVehicles.get(String(row.customerCode))||{baseVehicle:'',baseVehicleState:'UNKNOWN'})})),
    navigationStores:(mode=state.mode)=>{if(mode==='DATE_ROUTE')return isDailyDataReady()?allStores.map(row=>liveAddressLocations?.apply({...row})||{...row}):[];const list=new Map(latestSnapshotRows.map(r=>[r.customerCode,r]));for(const row of allStores){const prior=list.get(row.customerCode);const conflict=prior&&row.address&&prior.address&&row.address.replace(/\s/g,'')!==prior.address.replace(/\s/g,'');list.set(row.customerCode,{...row,...(conflict?{coordinateStatus:'CONFLICT'}:{})});}return [...list.values()].map(row=>liveAddressLocations?.apply({...row})||row);},
    selectNavigationStore:code=>{const row=(state.mode==='DATE_ROUTE'&&!isDailyDataReady()?[]:allStores).find(r=>r.customerCode===code)||(state.mode==='BASE_60D'?latestSnapshotRows.find(r=>r.customerCode===code):null);if(row)selectStore(row,null,true);},
    queryRecordedRoute:()=>{cancelManualRoadRoute();const v=primarySelectedVehicle();if(!v||!operationStops.length||!dailyMeta?.roster&&operationStops.some(s=>!Number.isSafeInteger(s.order)||s.order<1)){roadResult={state:'error',error:'RECORDED_ORDER_REQUIRED'};window.dispatchEvent(new CustomEvent('map-recorded-route',{detail:roadResult}));syncRoadRoutePanel();return;}loadRoadRoute(v,{explicit:true});},
    toggleConnections:()=>{state.connectionLines=false;state.lines.forEach(line=>line.setMap(null));state.lines=[];return {shown:false};},
    toggleRoadLines:value=>{roadLinesVisible=Boolean(value);if(!roadLinesVisible){manualRoadLayer?.clear();roadLayer?.clear();}else{if(state.map){manualRoadLayer ||= window.RoadRouteUi.createLayer({map:state.map});manualRoadLayer.render(manualRoadResult);roadLayer ||= window.RoadRouteUi.createLayer({map:state.map});roadLayer.render(roadResult);}}},
    highlightManualLeg:index=>{if(roadLinesVisible&&state.map&&manualRoadResult){manualRoadLayer ||= window.RoadRouteUi.createLayer({map:state.map});manualRoadLayer.render({...manualRoadResult,selectedLeg:Number.isInteger(index)?index:undefined});}},
    highlightRecordedLeg:index=>{if(roadLinesVisible&&state.map&&roadResult){roadLayer ||= window.RoadRouteUi.createLayer({map:state.map});roadLayer.render({...roadResult,selectedLeg:Number.isInteger(index)?index:undefined});}},
    async submitDailyQuery(start,end){
      const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
      if(state.mode!=='DATE_ROUTE'||!valid(start)||start!==end||end>maxDailyDate())return {ok:false,message:'일자별 운행은 선택한 배송일 한 날짜만 조회합니다.'};
      const queryConditions={vehicles:selectedVehicles().slice(),centerFilter:state.centerFilter,scope:periodVehicleScope};
      await changeSelectedDate(end,queryConditions);
      return {ok:dateReady,message:dateReady?'':$('#freshnessState').textContent};
    },
    setGeneralLegend(html){originalRouteLegend=html;syncRoadRoutePanel();},
    lookupStore(value){const key=String(value||'').trim();return allStores.filter(row=>[row.customerCode,row.customerName,row.address].includes(key));},
    navigationVisitRows:()=>isDailyDataReady()?operationStops.map(row=>({...row})):[],
    navigationDailyContext,
    selectNavigationPoint:showVirtual,
    canLookupNavigationAddress:()=>window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup===true||window.KAKAO_MAP_CONFIG?.allowIndependentAddressLookup===true,
    lookupNavigationAddress:(text,signal)=>lookupInteractiveLocation(String(text||'').trim(),signal),
    relayoutPreservingView(){mapCamera?.scheduleRelayout();},
    fitNavigationBounds(bounds){
      const allowed=routeCameraEpoch!==null&&routeCameraEpoch===(mapCamera?.interaction()??0);routeCameraEpoch=null;
      if(allowed&&state.map){state.fitRequested=false;state.suppressMapEventsUntil=Date.now()+700;state.map.setBounds(bounds,70,60,120,60);}
    },
    navigationChanged(){cancelManualRoadRoute();resetRoadRoute();if(state.map)renderStops(state.currentRows,{viewportOnly:true,numbered:state.mode==='DATE_ROUTE'});},
    manualStops:()=>manualDraft.stops(),
    replaceManualStops(points){cancelManualRoadRoute();const before=manualDraft.stops();try{manualDraft.clear();points.forEach(point=>manualDraft.add(point));renderManualDraft();return manualDraft.validate();}catch(error){manualDraft.clear();before.forEach(point=>manualDraft.add(point));renderManualDraft();throw error;}},
    queryManualRoute:queryManualRoadRoute,
    cancelManualRoute:cancelManualRoadRoute,
    manualRouteState:()=>manualRoadResult,
    clearManual(){cancelManualRoadRoute();manualDraft.clear();renderManualDraft();}
  };
  $("#currentTime").textContent = formatTime(new Date());
  let observedDispatchDate;
  setInterval(() => {
    if(state.mode!=='DATE_ROUTE'||document.hidden)return;
    const limit=maxDailyDate();
    if(limit!==observedDispatchDate){
      observedDispatchDate=limit;
      for(const id of ['#date','#mobileDate','#selectedDate'])$(id).max=limit;
    }
    if(state.selectedDate)void refreshSelectedDate();
  }, 60000);
  setInterval(() => { $("#currentTime").textContent = formatTime(new Date()); }, 10000);
  refreshVehicleUi(false);
  window.MapStaffEntry?.registerPurge(()=>hybridUi?.logout());
  window.addEventListener('map-staff-signed-out',purgeStaffData);
  window.addEventListener('map-staff-ready',()=>{
    rosterAuthorized=true;
    SOURCE=window.VEHICLE_AREA_DATA||{vehicles:[]};
    initVehicles();void initializeGeneral();void initMap();
  });
  window.addEventListener('map-staff-reference-ready',()=>{
    const selected=selectedVehicles();
    SOURCE=window.VEHICLE_AREA_DATA;
    initVehicles();
    ensureDateVehicles();
    setSelectedVehicles(selected);
    refreshVehicleUi(false);
  });
  window.addEventListener('pagehide',event=>{cancelManualRoadRoute();resetRoadRoute();if(event.persisted)hybridUi?.cancel();else{hybridUi?.dispose();mapObserver?.disconnect();for(const [name,fn]of mapHandlers)kakao?.maps?.event?.removeListener?.(state.map,name,fn);mapHandlers=[];}});window.addEventListener('pageshow',event=>{if(event.persisted)mapCamera?.scheduleRelayout();});
  if(document.body.dataset.mapStaffState==='authenticated'||!window.MapStaffEntry){
    initMap();
    initializeGeneral();
  }
})();
