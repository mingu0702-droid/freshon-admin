(function () {
  "use strict";

  const vehicleLabel = value => Phase2bUi.normalizeVehicleLabel(value);
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  let SOURCE = window.VEHICLE_AREA_DATA || { vehicles: [] };
  const ADMIN = new Map((window.ADMIN_FEATURES || []).map((feature) => [String(feature.properties?.code || ""), feature]));
  const state = { mode: "BASE_60D", connectionLines:false, rangeStart: "", rangeEnd: "", routeDate: "", selectedVehicles: [], driverKey: "", areaOn: false, centerFilter: "", selectedDate: "", latestDate: "", map: null, overlays: [], representativeOverlays: [], lines: [], polygons: [], selected: null, virtual: null, currentRows: [], routeRows: [], newAreaResults: [], fitRequested: true, userMovedMap: false, suppressMapEventsUntil: 0, baseRequestId: 0, routeRequestId: 0, searchRequestId: 0, addressRequestId: 0, detailRequestId: 0, todayRequestId: 0 };
  let mapInitializing=null,mapObserver=null,mapHandlers=[],mapCamera=null,cameraSelection=0;
  let searchTemporaryOverlay=null,searchTemporaryRadius=null,searchTemporaryClick=null;
  let clusterPanel=null,clusterPopupCleanup=null;
  let routeCameraEpoch=null;
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
    hybridUi?.cancel();requestControllers.forEach(v=>v.controller.abort());requestControllers.clear();memoryResponses.clear();apiDiagnostics.clear();
    latestSnapshotRows=[];periodRows=[];allStores=[];generalRegistryRows.clear();operationStops=[];coordinateByCode.clear();baseVehicles.clear();baseVehicleExtraCodes.clear();baseVehicleRequest=null;periodSelectionCache=null;dateReady=false;datedSourceDate='';dailyMeta=null;closeClusterPanel();
    storeByVehicleAndCode.clear();storesByCode.clear();unifiedSearchIndex=null;unifiedSearchKeys=new WeakMap();resetDriverMaster();geocodeCache.clear();approvedMarkerOrder.clear();
    indexedRows=null;pointIndex=null;baseVehicleMeta=null;snapshotMeta=null;periodMeta=null;modelStatus=null;
    SOURCE={vehicles:[]};ADMIN.clear();state.currentRows=[];state.routeRows=[];state.newAreaResults=[];state.selectedVehicles=[];state.virtual=null;
    clearSelection();clearMap();renderPeriodStoreList([]);resetRoadRoute();clearNewAreaBatch();renderManualDraft();
    for(const selector of ['#results','#runList','#addressJudgeResults','#periodDriver','#vehicleList','#navSuggestions','#operationsPanel'])$(selector)?.replaceChildren();
    vehicleRegions = null; renderVehicleQuickFilter([]);
    $('#freshnessState').textContent='직원 로그인 필요';$('#periodStoreListCount').textContent='';
  }
  const manualDraft = window.ManualWaypoints?.createDraft();
  let modeViewInitialized = false, markerFrame = null;
  let markerSourceVersion=0;
  let markerEntries = new Map(), indexedRows = null, pointIndex = null, boundaryKey = "", detailFrame = null, resizeFrame = null;
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
    if(state.mode!==next)resetDriverMaster();
    if(state.mode!==next){closeClusterPanel();window.dispatchEvent(new CustomEvent('map-navigation-context-changed',{detail:{mode:next,date:next==='DATE_ROUTE'?state.routeDate:''}}));}
    if(state.mode!==next&&next==='DATE_ROUTE'){dateReady=false;datedSourceDate='';dailyMeta=null;state.currentRows=[];state.routeRows=[];operationStops=[];}
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
  let unifiedSearchIndex = null, unifiedSearchKeys = new WeakMap();
  const memoryResponses = new Map();
  let latestSnapshotRows = [];
  let generalRegistryRows = new Map();
  const coordinateByCode = new Map();
  let dateRequestId = 0;
  let dateReady = false;
  let datedSourceDate = '', dailyMeta = null;
  let dateChosenByUser = false;
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
  const addressObservedDate=row=>row.raw?.lastDeliveryDate||storesByCode.get(row.customerCode)?.lastDeliveryDate||row.lastDeliveryDate||'';
  const liveAddressLocations=window.MapAddressLocations?.create({
    // The shared server still serializes provider calls and enforces the daily
    // ledger. Avoid an additional four-second delay for every visible store.
    spacingMs:400,
    addressReadDate:row=>state.mode==='DATE_ROUTE'?row.deliveryDate||state.selectedDate:addressObservedDate(row)||snapshotMeta?.latestDate||localDate(),
    readAddress:async(row,signal,date)=>{
      const observedDate=addressObservedDate(row);
      const response=await fetchJson(`/api/map-phase2b/private/customer-detail?view=store&customerCode=${encodeURIComponent(row.customerCode)}&date=${date}`,{channel:'auto-address-'+row.customerCode+'-'+date,ttl:0,timeout:30000,headers:{'x-map-address-location':'1'}});
      if(signal.aborted)throw Object.assign(Error('CANCELLED'),{name:'AbortError'});
      const source=response.data,current=source?.sourceBasis==='CURRENT_CUSTOMER_LOOKUP';
      const dated=source?.sourceBasis==='DATED_DELIVERY_LOOKUP'&&source.currentMasterState==='NOT_FOUND'&&source.detailDate===date&&observedDate===date;
      if(source?.customerCode!==row.customerCode||!current&&!dated||source?.locationState!=='SOURCE_ROW')throw Error('CURRENT_ADDRESS_UNCONFIRMED');
      return source;
    },
    lookup:(address,signal)=>geocodeAddress(address,signal),
    queryFor:address=>NewAreaRequests.addressQuery(address,Phase2bUi.addressVariants),
    enabled:()=>!document.hidden&&document.body.dataset.mapStaffState==='authenticated'&&window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup===true&&window.MapManualPins?.verified?.()===true,
    onChange:()=>{if(addressLocationFrame)return;addressLocationFrame=requestAnimationFrame(()=>{
      addressLocationFrame=null;if(document.body.dataset.mapStaffState!=='authenticated')return;
      for(const row of allStores)liveAddressLocations.apply(row);
      if(state.selected){liveAddressLocations.apply(state.selected);refreshCoordinateEvidence(state.selected);if(state.selected.coordinateSource==='KAKAO_ADDRESS_LIVE'){if(/^매장 선택 · 위치 확인 필요|좌표 미확인|좌표 정확성 미확인|GPS 없음/.test($('#searchState')?.textContent||''))setSearchState('매장 선택');if(addressFocusRequest?.code===state.selected.customerCode){if(addressFocusRequest.interaction==null||addressFocusRequest.interaction===mapCamera?.interaction())focusMapPoint(state.selected,{zoom:true});addressFocusRequest=null;}}}
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

  function replaceStoreSnapshot(rows, meta) {
    if (state.mode === 'BASE_60D') {
      const merged = new Map(latestSnapshotRows.map(row => [String(row.customerCode || row.code), { ...row, relations: [], history: [] }]));
      for (const row of rows || []) merged.set(String(row.customerCode || row.code), row);
      rows = [...merged.values()];
    }
    const previousByCode = new Map([...latestSnapshotRows, ...(generalMap&&state.mode==='BASE_60D'?generalRegistryRows.values():allStores)].map((row) => [String(row.customerCode || row.code), row]));
    if(generalMap&&state.mode==='BASE_60D'&&customerRegistry){const observed=new Map(rows.map(row=>[String(row.customerCode||row.code),{...previousByCode.get(String(row.customerCode||row.code)),...row,customerOnly:false,deliveryObserved:true}]));for(const row of generalRegistryRows.values())if(row.customerOnly&&!observed.has(row.customerCode))observed.set(row.customerCode,row);rows=customerRegistry.merge([...observed.values()]);}
    const vehicleMeta = new Map(SOURCE.vehicles.map((vehicle, index) => [String(vehicle.vehicle), { vehicle, index }]));
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
        lat: item.lat === null ? null : item.lat ?? item.latitude ?? (sameAddress&&previous.coordinateSource!=='KAKAO_ADDRESS_LIVE'?previous.lat:null), lng: item.lng === null ? null : item.lng ?? item.longitude ?? (sameAddress&&previous.coordinateSource!=='KAKAO_ADDRESS_LIVE'?previous.lng:null) }, found.vehicle, found.index);
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
      for(const key of ['customerOnly','deliveryObserved','currentAddressHash','customerRegistryAddressHash','customerRegistryStatus','customerRegistryUpdatedAt','customerRegistryVersion','customerLifecycle','coordinateSearch','coordinateEvidence','addressChanged','coordinateStatus','resolutionStatus','addressLocationKey'])if(item[key]!==undefined)row[key]=item[key];
      row.driverKey = item.driverKey || "";
      row.driverIdentity = item.driverIdentity || '';
      row.driverName = item.driverName || "";
      Object.assign(row, baseVehicles.get(String(row.customerCode)) || {baseVehicle:normalizeVehicle(item.baseVehicle||''),baseVehicleState:item.baseVehicle?'PUBLISHED_ONLY':'UNKNOWN'});
      window.MapManualPins?.apply(row);
      liveAddressLocations?.apply(row);
      row.deliveryCount90d = item.deliveryCount90d ?? item.deliveryCount ?? null;
      next.push(row);
      storeByVehicleAndCode.set(`${row.vehicle}|${row.customerCode}`, row);
      if (!storesByCode.has(row.customerCode)) storesByCode.set(row.customerCode, row);
    });
    allStores = next;unifiedSearchIndex=null;
    if(generalMap&&state.mode==='BASE_60D')generalRegistryRows=new Map(next.map(row=>[row.customerCode,row]));
    liveAddressLocations?.onSourceSync(JSON.stringify([meta?.preservation?.version,meta?.sourceGeneration,meta?.sourceObservedAt,meta?.generatedAt,customerRegistry?.summary().version]),allStores);
    window.dispatchEvent(new Event('map-stores-replaced'));
    snapshotMeta = meta || snapshotMeta;
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
    $('#sourceCollectedAt').textContent=`최신 원천 수집일: ${meta.sourceObservedAt||meta.sourceCollectedAt||'미확인'}${customerRegistryCheckedAt?' · Customer 확인 '+new Date(customerRegistryCheckedAt).toLocaleTimeString('ko-KR',{hour12:false}):''}`;
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
      .filter(row => (!generalMap||row.customerRegistryStatus!=='DELETED')&&(!state.centerFilter || periodBasis === "driver" || row.baseVehicleGroup === state.centerFilter));
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
  async function pollGeneralSnapshot(){
    if(generalSnapshotPolling||!generalMap||state.mode!=='BASE_60D'||document.hidden||document.body.dataset.mapStaffState!=='authenticated')return{ok:false,skipped:true};
    generalSnapshotPolling=true;const owner=initialRequestId,oldRows=latestSnapshotRows,oldMeta=snapshotMeta;
    const version=m=>JSON.stringify([m?.preservation?.version,m?.sourceGeneration,m?.version,m?.generatedAt,m?.rowCount]);
    try{
      await refreshStoreSnapshot();
      if(owner!==initialRequestId||!generalMap||state.mode!=='BASE_60D'||document.body.dataset.mapStaffState!=='authenticated')return{ok:false,skipped:true};
      if(snapshotReadState!=='ready')throw Error('SNAPSHOT_READ_FAILED');
      if(version(oldMeta)===version(snapshotMeta)&&oldRows.length===latestSnapshotRows.length)return{ok:true,changed:false};
      const merged=new Map(oldRows.map(r=>[String(r.customerCode||r.code),r])),added=[];
      for(const row of latestSnapshotRows){const code=String(row.customerCode||row.code),prior=merged.get(code);if(prior&&(prior.lastDeliveryDate||'')>(row.lastDeliveryDate||''))continue;if(!prior)added.push(code);merged.set(code,row);}
      latestSnapshotRows=[...merged.values()];coordinateByCode.clear();latestSnapshotRows.forEach(row=>coordinateByCode.set(String(row.customerCode||row.code),row));
      periodRows=[];replaceStoreSnapshot([],snapshotMeta);ensureDateVehicles();dateReady=true;
      if(state.selected){const next=storesByCode.get(state.selected.customerCode);if(next){state.selected={...state.selected,...next};refreshCoordinateEvidence(state.selected);void enrichStoreDetail(state.selected);}}
      state.fitRequested=false;await loadBaseMap();if(added.length)void loadBaseVehicles(added);
      void window.MapDataSync?.refresh?.();return{ok:true,changed:true,added:added.length,stores:allStores.length};
    }catch(error){
      if(owner!==initialRequestId||document.body.dataset.mapStaffState!=='authenticated')return{ok:false,skipped:true};
      latestSnapshotRows=oldRows;snapshotMeta=oldMeta;coordinateByCode.clear();oldRows.forEach(row=>coordinateByCode.set(String(row.customerCode||row.code),row));
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
      void syncCustomerRegistry();
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
    dateReady=false; datedSourceDate=''; dailyMeta=null;
    ++initialRequestId; clearTimeout(initialTimer); clearTimeout(periodTimer); ++periodRequestId;
    switchMode("DATE_ROUTE"); syncModeUi();
    state.currentRows=[];state.routeRows=[];operationStops=[];clearMap();renderRunList();updateOperationMetrics(null);
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
      if (response.meta?.complete !== true || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("운행일 확인 실패");
      await changeSelectedDate(date);
    } catch (error) { if (id === dateRequestId && !isSilentRequestError(error)) {dateReady=false;datedSourceDate='';state.currentRows=[];clearMap();renderRunList();$("#freshnessState").textContent = "운행일을 불러오지 못했습니다. 날짜를 선택해 다시 조회해 주세요.";} }
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
        if(stageReadOnly&&payload?.meta?.refresh==='READ_ONLY'&&!Array.isArray(payload.data)){
          clearTimeout(baseVehicleTimer);baseVehicleMeta=payload.meta;
          baseVehicleStatus=baseVehicles.size?'READY':payload.phase==='ERROR'?'ERROR':'NOT_READY';return;
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

  async function changeSelectedDate(date,queryConditions=null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T00:00:00Z')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date || date > localDate()) return;
    const contextChanged=state.mode!=='DATE_ROUTE'||date!==state.selectedDate;
    generalMap=false;resetRoadRoute();cancelManualRoadRoute();
    dateReady=false;datedSourceDate='';dailyMeta=null;
    ++initialRequestId; clearTimeout(initialTimer);
    clearTimeout(periodTimer); ++periodRequestId;
    switchMode("DATE_ROUTE"); state.routeDate = date; syncModeUi();
    if(queryConditions){setSelectedVehicles(queryConditions.vehicles);state.centerFilter=queryConditions.centerFilter;periodVehicleScope=queryConditions.scope;refreshVehicleUi(false);}
    const sameDate = date === state.selectedDate;
    state.selectedDate = date;
    if(contextChanged)window.dispatchEvent(new CustomEvent('map-navigation-context-changed',{detail:{mode:'DATE_ROUTE',date}}));
    void refreshDriverMaster();
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
    state.routeRows = [];state.currentRows=[];closeClusterPanel();clearMap();
    operationStops = []; renderRunList();
    state.mode = "DATE_ROUTE";
    clearSelection();
    $("#mapStatusSub").textContent = `${date} 배송지를 불러오는 중입니다.`;
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
      if(token!==dateRequestId||state.mode!=='DATE_ROUTE'||state.selectedDate!==date)return;
      if (response.meta?.complete !== true || response.meta.date !== date) throw new Error("날짜별 편성 검증 실패");
      let rows = response.data || [];
      if(!Array.isArray(rows)||rows.some(row=>!row||row.deliveryDate&&row.deliveryDate!==date))throw new Error('배송일이 일치하지 않습니다.');
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
      dailyMeta=response.meta;
      replaceStoreSnapshot(rows, response.meta);
      ensureDateVehicles();
      datedSourceDate=date;dateReady = true;
      await loadBaseMap();
      // Historical driver identity comes from assignment history, not today's master.
      await loadOperationStatus(primarySelectedVehicle(), selectedVehicles().length === 1);
    } catch (error) {
      if (token !== dateRequestId || isSilentRequestError(error)) return;
      dateReady=false;datedSourceDate='';state.currentRows=[];state.routeRows=[];operationStops=[];clearMap();renderRunList();
      $("#freshnessState").textContent = `${date} 배송지를 불러오지 못했습니다. 다시 조회해 주세요.`;
    }
  }

  function ensureDateVehicles() {
    const known = new Set(vehicleChecks().map((input) => input.value));
    [...new Set(allStores.flatMap((row) => [row.baseVehicle, row.vehicle, ...(row.history || []).map(item => item.vehicle)]).filter(Boolean))].forEach((vehicle) => {
      if (known.has(vehicle)) return;
      const label = document.createElement("label");
      label.className = "vehicleItem";
      label.dataset.group=allStores.find(row=>row.baseVehicle===vehicle&&row.baseVehicleGroup)?.baseVehicleGroup||'';
      label.innerHTML = `<input type="checkbox" value="${esc(vehicle)}"><span class="vehicleNo">${esc(vehicleLabel(vehicle))}</span><span class="vehicleArea"></span>`;
      label.querySelector("input").onchange = () => applyVehicleFilter(selectedVehicles());
      $("#vehicleList").append(label);
      ["#vehicle", "#mobileVehicle", "#operationVehicle", "#mobileBaseVehicle"].forEach((id) => $(id).add(new Option(`${vehicleLabel(vehicle)}`, vehicle)));
    });
    $$('.vehicleItem').forEach(label=>{const group=allStores.find(row=>row.baseVehicle===label.querySelector('input')?.value&&row.baseVehicleGroup)?.baseVehicleGroup;if(group)label.dataset.group=group;});
    sortVehicleControls();
  }

  function normalizeStore(customer, vehicle, vehicleIndex) {
    return {
      customerCode: String(customer.id || customer.code || customer.customerCode || "").trim(),
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
    mapCamera?.releaseFocus();
    state.fitRequested = true;
    state.userMovedMap = false;
  }

  function vehicleChecks() {
    return $$("#vehicleList input[type=checkbox]");
  }

  function vehicleListGroup(value) {
    return ({osan:'osan',yeongnam:'yeongnam',honam:'honam','011':'osan','012':'yeongnam','013':'honam','오산':'osan','영남':'yeongnam','호남':'honam','오산센터':'osan','영남센터':'yeongnam','호남센터':'honam'})[String(value || '').trim()] || 'unknown';
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
    $('#map').dataset.sdkState='loading';
    mapInitializing=window.KakaoMapsAdapter.ready().then(()=>{
      $('#map').replaceChildren();state.map=new kakao.maps.Map($('#map'),{center:new kakao.maps.LatLng(36.7,127.7),level:13});
      $('#map').dataset.sdkState='ready';
      mapCamera=window.MapViewPolicy?.createCamera({map:state.map,element:$('#map')});
      const userGesture=()=>{mapCamera?.userGesture();state.userMovedMap=true;state.fitRequested=false;};
      for(const type of ['wheel','pointerdown','touchstart'])$('#map').addEventListener(type,userGesture,{passive:true});
      if(kakao.maps.services){window.kakaoGeocoder=window.KakaoMapsAdapter?.geocoder?.()||new kakao.maps.services.Geocoder();window.kakaoPlaces=new kakao.maps.services.Places();}
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
    closeClusterPanel();
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
  }

  function clearSelection({preserveSearch=false}={}) {
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
    renderRunList();
    $("#detailSection").classList.remove("open");
    $("#detail").className = "idle";
    $("#detail").textContent = "검색하거나 핀을 선택하면 점포정보가 표시됩니다.";
    if (state.mode === "BASE_60D") renderPeriodStoreList();
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
    button.dataset.coordinateSource=row.coordinateSource||'';
    button.dataset.vehicle = row.vehicle || "";
    button.title = `${row.vehicle ? vehicleLabel(row.vehicle) + " · " : ""}${row.customerName || row.address || ""}`;
    button.dataset.masterCheckedAt=row.baseVehicleCheckedAt||'';button.dataset.masterStale=String(row.baseVehicleStale===true);
    button.setAttribute("aria-label", state.mode === "BASE_60D" ? button.title : `${button.title} · ${completed ? "완료" : pending ? "미완료" : "상태 미확인"}`);
    if (row.customerCode && row.customerCode === state.selected?.customerCode) button.classList.add("selected");
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
    if(document.body.classList.contains('approvedShellCandidate')){
      const pin=document.createElement('div');pin.className=row.clusterCount?'clusterpin':'pin';
      pin.style.setProperty('--pin',pinColor);
      const number=document.createElement(row.clusterCount?'b':'span');number.textContent=String(row.clusterCount?(row.clusterLabel||'매장'):row.vehicle||'•');pin.append(number);
      if(!row.clusterCount&&index)pin.title=`${vehicleLabel(row.vehicle)||'호차 정보 없음'} · 착순 ${index}`;
      if(row.clusterCount){const small=document.createElement('small');small.textContent=row.clusterCount+'개 매장';pin.append(small);}
      button.classList.add('approvedMarker');button.replaceChildren(pin);
    }
    if(state.mode==='DATE_ROUTE'&&window.MapNavigationEditor?.values?.().includes(row.customerCode))button.classList.add('navAssigned');
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
    if (state.selected && Number.isFinite(state.selected.lat) && Number.isFinite(state.selected.lng)
      && !valid.some(row => row.customerCode === state.selected.customerCode)) valid=[...valid,state.selected];
    const bounds = new kakao.maps.LatLngBounds();
    const navCodes=window.MapNavigationEditor?.values?.().filter(Boolean)||[];
    // Overview: one selectable pin per hocha, never one synthetic badge that
    // hides multiple vehicles. Focus: every actual store pin (same-coordinate
    // stores remain reachable through the co-located store selector).
    const chosenVehicles = selectedVehicles();
    const vehicleOverview = periodBasis === 'vehicle' &&
      (periodVehicleScope === 'all' || chosenVehicles.length > 1);
    const focusedStops = !vehicleOverview &&
      ((periodBasis === 'vehicle' && periodVehicleScope === 'selected' && chosenVehicles.length === 1)
        || (state.mode === 'DATE_ROUTE' && periodBasis === 'driver'));
    const projectPin = row => state.map.getProjection().containerPointFromCoords(new kakao.maps.LatLng(row.lat,row.lng));
    const viewport = state.fitRequested ? null : {width:$('#map').clientWidth,height:$('#map').clientHeight};
    const protectedOverviewCodes = new Set([...navCodes, state.selected?.customerCode].filter(Boolean));
    const markerSource = vehicleOverview
      ? [...representativeRows(valid), ...valid.filter(row => protectedOverviewCodes.has(row.customerCode))]
      : valid;
    const pins = vehicleOverview
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
    if (state.fitRequested) pointIndex.valid.forEach(row => bounds.extend(new kakao.maps.LatLng(row.lat,row.lng)));
    const entries = pins.map((row,index) => ({row,index,key:row.clusterKey||[row.virtual?'virtual':'store',row.customerCode || row.vehicle || '',row.lat,row.lng].join('|'),
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
    const nextBoundaryKey = [state.mode,state.rangeStart,state.rangeEnd,state.selectedDate,state.centerFilter,periodBasis,periodVehicleScope,state.driverKey,selectedVehicles().join(',')].join('|');
    if (!options.viewportOnly && (dataChanged || boundaryKey !== nextBoundaryKey)) {
      clearBoundaries(); state.representativeOverlays.forEach(overlay=>overlay.setMap(null)); state.representativeOverlays=[];
    }
    if (state.areaOn && boundaryKey !== nextBoundaryKey) { if (!state.polygons.length) drawSelectedBoundaries([]); boundaryKey=nextBoundaryKey; }
    // Vehicle overview already renders one representative per hocha.
    // Avoid duplicating those markers when a territory polygon is enabled.
    if (state.areaOn && !vehicleOverview && !state.representativeOverlays.length) addComparisonPins();
    if (!state.areaOn) state.representativeOverlays.forEach((overlay) => overlay.setMap(null));
    const mobileRoute = innerWidth <= 760 && options.numbered;
    if (pointIndex.valid.length && state.fitRequested && !state.userMovedMap) {
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
    }
    $("#map").setAttribute('data-render-metrics',JSON.stringify({...renderMetrics,sourceRows:rows.length,active:markerEntries.size,polygons:state.polygons.length}));
  }

  function drawSelectedBoundaries(_selected) {
    // The official administrative-boundary layer is the only polygon owner.
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
    if (['KAKAO_ADDRESS_LIVE','KAKAO_BUILDING_EXACT_ADDRESS','KAKAO_VERIFIED_BUILDING','KAKAO_ADDRESS_REVALIDATION'].includes(row.coordinateSource)) return '주소 기준 위치';
    if (row.coordinateSource === 'HISTORICAL_GPS_SAME_BUILDING') return '동일 주소의 저장 위치';
    return '';
  }
  function refreshCoordinateEvidence(row) {
    const body = $('#detail .detailBody');
    if (!body) return;
    body.querySelectorAll('.coordinateEvidence,.coordinateWarning').forEach(node => node.remove());
    const unlocated = numberOrNull(row.lat) === null || numberOrNull(row.lng) === null;
    const text = unlocated ? '위치 확인 필요' : row.coordinateSource==='KAKAO_ADDRESS_LIVE'?'주소 기준 위치':'';
    if (!text) return;
    const node = document.createElement('div');
    node.className = unlocated ? 'coordinateWarning' : 'coordinateEvidence';
    node.textContent = text;
    const actions = body.querySelector('.mobileActions');
    if (actions) body.insertBefore(node, actions); else body.append(node);
  }

  function selectStore(row, element, focus, skipEnrich = false) {
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
    $$(".marker").forEach((pin) => pin.classList.toggle("selected", Boolean(row.customerCode) && pin.dataset.customerCode === row.customerCode && pin.dataset.vehicle === row.vehicle));
    if (state.mode === "DATE_ROUTE") renderRunList();
    if (state.mode === "BASE_60D") {
      $$("[data-period-store]").forEach(button => { const active = button.dataset.periodStore === row.customerCode; button.classList.toggle("selected", active); button.setAttribute("aria-pressed", String(active)); });
      if (element?.classList.contains("marker")) scrollSelectedInside('#periodStoreList','.periodStore.selected');
    }
    if (element?.classList.contains("marker")) scrollSelectedInside('#runList','.runStop.selected');
    const unlocated = numberOrNull(row.lat) === null || numberOrNull(row.lng) === null;
    if (unlocated) $("#mapStatusSub").textContent = "좌표 미확인 · 지도 위치를 변경하지 않습니다.";
    addressFocusRequest=unlocated?{code:row.customerCode,interaction:mapCamera?.interaction()}:null;
    // Rebuild the selected entry in both views, even if it was inside a cluster
    // or outside the current vehicle filter. Its overlay must be above peers.
    if(state.map&&!unlocated){state.fitRequested=false;renderStops(state.currentRows,{viewportOnly:true,numbered:state.mode==='DATE_ROUTE'});}
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

        <div class="staffActions"><button id="staffNotes" aria-expanded="false" aria-controls="staffAuxContent">출입배송정보 ▸</button><button id="staffHistory" aria-expanded="false" aria-controls="staffAuxContent">최근 배송기사이력 ▸</button></div>
        ${!routeMode && row.history?.length ? `<div class="periodRecent">최근배송 ${esc(row.lastDeliveryDate)} · ${row.visitCount===null?'전체 기간 횟수 미확인':(row.visitCount??row.history.length)+'회 이력'}</div>` : ""}
        ${unlocated ? '<div class="coordinateWarning">위치 확인 필요</div>' : row.coordinateSource==='KAKAO_ADDRESS_LIVE'?'<small class="coordinateEvidence">주소 기준 위치</small>':""}
        <div class="mobileActions"><button id="mobileMapView" class="primary">매장 위치 중심으로 보기</button><button id="mobileRouteView" class="ghost">${esc(vehicleLabel(vehicle) || "선택 호차")} 운행동선</button></div>
        <div id="nearWrap"></div>
      </div>`;
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
    if(!unlocated)focusMapPoint(row,{zoom:focus});
    if (!skipEnrich && row.customerCode) enrichStoreDetail(row, element);
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
    if ($("#runListTool")) $("#runListTool").hidden = state.mode!=='DATE_ROUTE';
    const shown = operationStops.filter((row) => runFilter === "ALL" || row.status === runFilter);
    $("#runListCount").textContent = operationStops.length ? `${shown.length}/${operationStops.length}착` : isDailyDataReady()?'0착':'조회 대기';
    $("#runList").innerHTML = shown.length ? shown.map((row) => {
      const next = operationStops[operationStops.indexOf(row) + 1];
      const distance = next ? distanceKm(row, next) : Infinity;
      const selected = state.selected?.customerCode === row.customerCode && state.selected?.vehicle === row.vehicle;
      return `<button class="runStop${selected ? " selected" : ""}" data-run-code="${esc(row.customerCode)}" aria-pressed="${selected}"><span class="runOrder">${esc(row.order || "-")}</span><span class="runInfo"><span class="runCode">${esc(row.customerCode)}</span><div class="runName">${esc(row.customerName || "점포명 미확인")}</div><span class="runMeta"><span class="statusChip ${row.status === "COMPLETED" ? "done" : ""}">${row.status === "COMPLETED" ? "완료" : row.status === "PENDING" ? "미완료" : "상태 미확인"}</span><span>${esc(formatTime(row.actualCompletedAt || row.deliveryCompletedAt) || "-")}</span><span class="runDistance">${row.lat == null || row.lng == null ? "좌표 미확인" : Number.isFinite(distance) ? "다음 직선 " + formatDistance(distance) : "-"}</span></span></span></button>`;
    }).join("") : !isDailyDataReady()?"날짜를 선택해 배송지를 조회해 주세요.":"선택한 조건의 배송지가 없습니다.";
    // Historical Hub route totals exclude unlocated rows. Keep those source
    // assignments in a clearly separate list without inventing route order/status.
    const extraStops = isDailyDataReady()&&selectedVehicle ? filteredDateStores(allStores).filter(row => row.vehicle === selectedVehicle && (row.lat == null || row.lng == null) && !operationStops.some(stop => stop.customerCode === row.customerCode)) : [];
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
    closeClusterPanel();
    if(point?.searchTemporary){renderSearchTemporaryNearby(point);focusMapPoint(point,{zoom:false,key:'search-temporary'});return;}
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

  function prepareSearchQuery(query) {
    const tokens=normalizeSearchText(query).split(' ').filter(Boolean),address=normalizeSearchAddress(query);
    return {target:tokens.join(''),tokens,address,numbered:/\d$/.test(address)};
  }

  function searchRowKeys(row) {
    const code=String(row.customerCode||row.code||row.id||'').trim(),local=storesByCode.get(code)||coordinateByCode.get(code);
    const name=row.customerName||row.name||local?.customerName||local?.name||'';
    const address=row.address||row.customerAddress||local?.address||'';
    const raw=row.raw&&(!row.raw.address||row.raw.address===address)?row.raw:null;
    const road=row.roadAddress||raw?.roadAddress||'';
    const roadName=row.roadNameAddress||raw?.roadNameAddress||'';
    const lot=row.jibunAddress||raw?.jibunAddress||'';
    const cached=unifiedSearchKeys.get(row);
    if(cached&&cached.code===code&&cached.name===name&&cached.address===address&&cached.road===road&&cached.roadName===roadName&&cached.lot===lot)return cached;
    const keys={code,name,address,road,roadName,lot,codeKey:normalizeSearchText(code).replace(/\s/g,''),nameKey:normalizeSearchText(name).replace(/\s/g,''),
      addressKeys:[...new Set([address,road,roadName,lot].filter(Boolean).map(normalizeSearchAddress))]};
    unifiedSearchKeys.set(row,keys);
    return keys;
  }

  function unifiedLocalSearchRows() {
    if(unifiedSearchIndex?.period===periodRows&&unifiedSearchIndex.snapshot===latestSnapshotRows&&unifiedSearchIndex.stores===allStores)return unifiedSearchIndex.rows;
    const byCode=new Map();
    // Prefer the current materialized row, which includes Customer changes
    // and the active address/coordinate conflict guard.
    for(const source of [periodRows,latestSnapshotRows,allStores])for(const row of source){
      const code=String(row.customerCode||row.code||row.id||'').trim();
      if(/^[A-Z]\d{3,}$/.test(code))byCode.set(code,row);
    }
    unifiedSearchIndex={period:periodRows,snapshot:latestSnapshotRows,stores:allStores,rows:[...byCode.values()]};
    return unifiedSearchIndex.rows;
  }

  function rankSearchRow(row, query, keys = searchRowKeys(row)) {
    const {target,tokens,address,numbered}=typeof query==='string'?prepareSearchQuery(query):query;
    const {codeKey:code,nameKey:name,addressKeys}=keys;
    if(!target)return 99;
    if(code === target)return 0;
    if(name === target)return 1;
    if(name.includes(target))return 2;
    if(code.includes(target))return 3;
    if(tokens.every(token => name.includes(token)))return 4;
    if(address&&addressKeys.some(value=>{const at=value.indexOf(address);return at>=0&&(!numbered||!/[\d-]/.test(value.charAt(at+address.length)));}))return 5;
    return 99;
  }

  function rankSearchRows(rows, query) {
    const probe=typeof query==='string'?prepareSearchQuery(query):query,seen=new Set(),matched=[];
    for(const row of rows){
      const keys=searchRowKeys(row),{code,name}=keys,rank=rankSearchRow(row,probe,keys);
      if(rank>=99||!/^[A-Z]\d{3,}$/.test(code)||seen.has(code))continue;
      seen.add(code);matched.push({row,rank,name});
    }
    return matched.sort((a,b)=>a.rank-b.rank||naturalCompare(a.name,b.name)).map(({row})=>normalizeApiStore(row));
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
      setSearchState('');resetMapOverview();
    }finally{unifiedResetting=false;}
  }

  function selectUnifiedSearchStore(value,{owner=state.searchRequestId}={}) {
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
    try{selectStore(row,null,true);}finally{unifiedSelectionActive=false;}
    setSearchState(row.lat===null?'매장 선택 · 위치 확인 필요':'매장 선택');
    // Fixed-dispatch lookup is optional enrichment, never a barrier to selection.
    if(!baseVehicles.has(row.customerCode))void loadBaseVehicles([row.customerCode]).then(()=>{
      if(selectedOwner===state.searchRequestId && state.selected?.customerCode===row.customerCode)refreshSelectedDriverContact();
    });
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

  function renderResults(rows,{owner=state.searchRequestId,autoSelect=true}={}) {
    if(owner!==state.searchRequestId)return;
    closeUnifiedSearchResults();
    if(rows.length===1&&autoSelect){selectUnifiedSearchStore(rows[0],{owner});return;}
    if(!rows.length)return;
    const results=$('#results');results.hidden=false;$('#query').setAttribute('aria-expanded','true');
    results.innerHTML=rows.map((row,index)=>`<button type="button" class="resultItem" data-result="${index}" data-search-code="${esc(row.customerCode)}" aria-pressed="false"><div class="resultName">${esc(row.customerCode)} · ${esc(row.customerName||'-')}</div></button>`).join('');
    $$('[data-result]').forEach(button=>button.onclick=()=>selectUnifiedSearchStore(rows[Number(button.dataset.result)],{owner}));
  }

  function unifiedAddressQuery(text) {
    return Boolean(NewAreaRequests.addressQuery(text,Phase2bUi.addressVariants));
  }

  async function search() {
    const text=$('#query').value.normalize('NFKC').trim();
    if(!text){clearUnifiedSearch();return;}
    if(state.mode!=='BASE_60D')return;
    return searchPeriod(text);
  }

  function clearSearchTemporaryPin({restoreView=false}={}) {
    ++state.addressRequestId;
    addressController?.abort();addressController=null;searchTemporaryClick=null;
    searchTemporaryOverlay?.setMap(null);searchTemporaryOverlay=null;
    searchTemporaryRadius?.setMap(null);searchTemporaryRadius=null;
    const owned=state.virtual?.searchTemporary===true;
    if(owned){state.virtual=null;mapCamera?.releaseFocus();window.dispatchEvent(new CustomEvent('map-store-selected',{detail:{customerCode:null}}));}
    if(owned&&!state.selected?.customerCode){
      $('#detailSection').classList.remove('open');$('#detail').className='idle';
      $('#detail').textContent='검색하거나 핀을 선택하면 점포정보가 표시됩니다.';
    }
    if($('#results [data-search-address-link]'))closeUnifiedSearchResults();
    $('#map').removeAttribute('data-search-position-pending');
    if(restoreView&&state.map){state.fitRequested=false;renderStops(state.currentRows,{viewportOnly:true,numbered:state.mode==='DATE_ROUTE'});}
  }

  function waitForSearchMapPoint(text,{owner=state.searchRequestId,reason='외부 주소검색 미승인',customerMatchState='UNCONFIRMED'}={}) {
    if(owner!==state.searchRequestId||state.mode!=='BASE_60D')return;
    const regionMissing=!/^(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|충북|충남|전라|전북|전남|경상|경북|경남|제주|[가-힣]+(?:시|군|구))/.test(text);
    const results=$('#results');results.hidden=false;
    results.innerHTML=`<a class="resultItem" data-search-address-link href="https://map.kakao.com/link/search/${esc(encodeURIComponent(text))}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">카카오맵에서 주소 후보 확인 ↗</a><div class="resultMeta" data-search-address-guide>${regionMissing?'지역이 빠진 주소는 여러 곳일 수 있습니다. 시·군·구를 입력하세요.':'주소 후보의 시·군·구를 확인하세요.'} 지도 클릭으로 임시 위치를 지정할 수 있습니다.</div>`;
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

  async function searchExternalAddress(text,{owner=state.searchRequestId,signal,lookupAllowed=true,customerMatchState='UNCONFIRMED'}={}) {
    if(state.mode!=='BASE_60D'||owner!==state.searchRequestId||signal?.aborted)return;
    clearSearchTemporaryPin();
    const requestId=state.addressRequestId;
    const active=()=>owner===state.searchRequestId&&requestId===state.addressRequestId&&!signal?.aborted&&state.mode==='BASE_60D';
    if(lookupAllowed===false||window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup!==true){
      if(lookupAllowed)setSearchState('주소검색 연결 확인 중',true);
      if(!state.map)await initMap();
      if(!active())return;
      if(lookupAllowed)await window.KakaoMapsAdapter?.refreshAddressLookup?.();
      if(!active())return;
      if(lookupAllowed===false||window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup!==true){
        const blocked=window.kakaoGeocoder?.blockedReason;
        const availability=blocked?NewAreaRequests.message({code:blocked}):'주소검색 연결 미확인';
        const reason=lookupAllowed===false?'기존 매장 조회 미확인':availability;
        waitForSearchMapPoint(text,{owner,customerMatchState,reason});
        return;
      }
    }
    setSearchState('주소 확인 중',true);
    const controller=new AbortController();addressController=controller;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    let point;
    try {point=await geocodeAddress(text,controller.signal);}
    catch(error){
      if(active()&&!isSilentRequestError(error))waitForSearchMapPoint(text,{owner,customerMatchState,reason:NewAreaRequests.message(error)});
      return;
    }finally{signal?.removeEventListener('abort',abort);if(addressController===controller)addressController=null;}
    if(!active())return;
    if(!point){waitForSearchMapPoint(text,{owner,customerMatchState,reason:'일치하는 주소 위치 없음'});return;}
    const choose=candidate=>{
      if(!active())return;
      $('#results').replaceChildren();
      if(candidate.customerCode){
        const row=normalizeApiStore({...candidate,customerName:candidate.customerName||candidate.placeName||candidate.customerCode});
        if(typeof selectUnifiedSearchStore==='function')return selectUnifiedSearchStore(row,{owner});
        clearSearchTemporaryPin();return selectStore(row,null,true);
      }
      finishAddress(candidate,{owner,customerMatchState});
    };
    if(point.candidates){
      $('#results').innerHTML=point.candidates.map((candidate,index)=>`<button class="resultItem" data-address-candidate="${index}"><div class="resultName">${esc(candidate.customerCode?[candidate.customerCode,candidate.customerName].filter(Boolean).join(' · '):candidate.address)}</div></button>`).join('');
      $$('[data-address-candidate]').forEach(button=>button.onclick=()=>choose(point.candidates[Number(button.dataset.addressCandidate)]));
      setSearchState('주소 후보를 선택해 주세요.');return;
    }
    choose(point);
  }

  async function searchPeriod(text) {
    if(state.mode!=='BASE_60D')return;
    const owner=invalidateUnifiedSearch();
    if(typeof clearSearchTemporaryPin==='function')clearSearchTemporaryPin({restoreView:false});
    cancelAddressLookup();closeUnifiedSearchResults();
    const code=/^[A-Z]\d{3,}$/i.test(text)?text.toUpperCase():null;
    const exact=code&&(storesByCode.get(code)||coordinateByCode.get(code)||periodRows.find(row=>(row.customerCode||row.code)===code));
    if(exact){selectUnifiedSearchStore(exact,{owner});return;}
    setSearchState('검색 중',true);
    unifiedSearchController=new AbortController();const signal=unifiedSearchController.signal;
    const probe=prepareSearchQuery(text);
    const local=code?[]:rankSearchRows(unifiedLocalSearchRows(),probe);
    if(local.length){
      setSearchState(`저장된 매장 ${Math.min(local.length,40)}건 · 추가 확인 중`,true);
      renderResults(local.slice(0,40),{owner,autoSelect:false});
    }
    let remote=[],meta=null,lookupError=null;
    try{
      const result=await fetchJson('/api/map-phase2b/private/customer-search',{
        channel:'unified-customer-search',ttl:0,timeout:30000,headers:{'x-map-customer-query':encodeURIComponent(text)}
      });
      if(!Array.isArray(result.data))throw new Error('CUSTOMER_SEARCH_CONTRACT');
      remote=result.data;meta=result.meta;
    }catch(error){if(isSilentRequestError(error)||signal.aborted||owner!==state.searchRequestId)return;lookupError=error;}
    if(signal.aborted||owner!==state.searchRequestId||state.mode!=='BASE_60D')return;
    const matched=new Map(local.map(row=>[row.customerCode,row]));
    // The staff-only server can match a private address without returning it.
    // Do not re-filter that trusted match by the redacted public address field.
    for(const value of remote){
      if(!/^[A-Z]\d{3,}$/.test(String(value?.customerCode||'')))continue;
      const row=normalizeApiStore({...matched.get(value.customerCode),...value});
      matched.set(row.customerCode,row);
    }
    let rows=[...matched.values()].filter(row=>!code||row.customerCode===code)
      .sort((a,b)=>rankSearchRow(a,probe)-rankSearchRow(b,probe)||naturalCompare(a.customerName,b.customerName)).slice(0,40);
    if(rows.length){
      setSearchState(rows.length===1?'검색 결과 1건':`${rows.length}개 매장 · 선택해 주세요.`);
      renderResults(rows,{owner});return;
    }
    closeUnifiedSearchResults();
    if(code){setSearchState(lookupError?'고객 조회 실패 · 다시 시도해 주세요.':'고객코드를 확인해 주세요.');return;}
    if(!unifiedAddressQuery(text)){
      setSearchState(lookupError?'매장 조회 실패 · 다시 시도해 주세요.':'일치하는 매장이 없습니다. 도로명과 건물번호 또는 동·리와 지번을 입력해 주세요.');return;
    }
    // A failed Customer lookup is not proof that this is a new customer.
    await searchExternalAddress(text,{owner,signal,lookupAllowed:!lookupError,
      customerMatchState:meta?.customerMatchVerified===true?'NOT_IN_MASTER':'UNCONFIRMED'});
  }

  function finishAddress(point,{owner=state.searchRequestId,customerMatchState='UNCONFIRMED'}={}) {
    if(owner!==state.searchRequestId||state.mode!=='BASE_60D')return;
    const lat=numberOrNull(point?.lat),lng=numberOrNull(point?.lng);
    if(lat===null||lng===null||lat<33||lat>39.5||lng<124||lng>132){setSearchState('위치 좌표를 확인해 주세요.');return;}
    if(point.customerCode){
      const row=normalizeApiStore(point);
      if(typeof selectUnifiedSearchStore==='function')return selectUnifiedSearchStore(row,{owner});
      return selectStore(row,null,true);
    }
    const virtual={customerCode:'',customerName:point.placeName||'임시 위치',address:point.address,
      lat,lng,virtual:true,searchTemporary:true,customerMatchState,
      coordinateSource:point.coordinateSource||'KAKAO_ADDRESS_TEMPORARY',
      coordinateAccuracy:point.coordinateSource==='MAP_CLICK_TEMPORARY'?'USER_SELECTED':'BUILDING'};
    showVirtual(virtual);
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

  function showVirtual(row) {
    const lat=numberOrNull(row?.lat),lng=numberOrNull(row?.lng);
    if(!state.map||lat===null||lng===null||lat<33||lat>39.5||lng<124||lng>132){setSearchState('지도와 위치 좌표를 확인해 주세요.');return;}
    clearSelection({preserveSearch:true});clearSearchTemporaryPin();
    row={...row,customerCode:'',lat,lng,virtual:true,searchTemporary:true,customerMatchState:row.customerMatchState||'UNCONFIRMED'};
    $('#results').replaceChildren();
    const content=markerElement(row,null,'virtual');content.dataset.searchTemporaryPin='true';
    content.setAttribute('aria-label','임시 위치 · '+(row.address||''));
    searchTemporaryOverlay=new kakao.maps.CustomOverlay({position:new kakao.maps.LatLng(lat,lng),content,clickable:true,xAnchor:.5,yAnchor:1,zIndex:45});
    searchTemporaryOverlay.setMap(state.map);state.virtual=row;
    $('#detailSection').classList.add('open');$('#detail').className='detailCard';
    $('#detail').innerHTML=`<div class="detailHead"><button id="detailClose" class="detailClose" aria-label="닫기">×</button><div class="code">임시 위치</div><div class="storeName">${esc(row.address||row.customerName||'선택 위치')}</div></div><div class="detailBody"><p class="hint">저장하지 않는 임시 핀입니다.</p><div id="nearWrap"></div></div>`;
    $('#detailClose').onclick=()=>{clearSearchTemporaryPin();clearSelection();};
    window.dispatchEvent(new CustomEvent('map-store-selected',{detail:{customerCode:null}}));
    renderSearchTemporaryNearby(row);
    requestAnimationFrame(positionDetailPopup);focusMapPoint(row,{zoom:true,key:'search-temporary'});
    if(innerWidth<=760)showMobileMap();
  }

  function renderSearchTemporaryNearby(point) {
    if(!point?.searchTemporary||!$('#nearWrap'))return;
    const hasRange=Boolean(state.rangeStart&&state.rangeEnd);
    const rows=hasRange?newAreaComparisonStores():latestSnapshotRows.map(newAreaCoordinate).filter(Boolean).map(row=>({...row,vehicle:baseVehicles.get(row.customerCode)?.baseVehicle||''}));
    const nearby=rows.map(row=>({...row,distance:distanceKm(point,row)})).filter(row=>row.distance<=.5).sort((a,b)=>a.distance-b.distance);
    const references=Phase2bUi.nearbyVehicles(point,rows,30);
    const limits=hasRange?judgeNewAreaPoint({address:point.address,customer:'임시 위치'},point).dataLimits:'조회기간 미선택 · 저장 위치 참고';
    $('#nearWrap').innerHTML=`<p class="hint">${esc(limits||'저장 위치 참고')} · 직선거리이며 실제 운행 가능 여부는 미확정입니다.</p><details class="detailMore"><summary>500m 주변 매장 ${nearby.length}개 · 참고</summary>${nearby.slice(0,30).map(row=>`<div>${esc(row.customerCode)} · ${esc(row.customerName)} · ${formatDistance(row.distance)}</div>`).join('')||'<p class="hint">확인된 위치 근거가 없습니다.</p>'}</details><details class="detailMore"><summary>30km 근접호차 ${references.length}대 · 참고</summary>${references.map(row=>`<div>${esc(vehicleLabel(row.vehicle))} · ${formatDistance(row.distance)}</div>`).join('')||'<p class="hint">확인된 호차 근거가 없습니다.</p>'}</details>`;
    searchTemporaryRadius?.setMap(null);searchTemporaryRadius=null;
    if(kakao.maps.Circle){searchTemporaryRadius=new kakao.maps.Circle({center:new kakao.maps.LatLng(point.lat,point.lng),radius:500,strokeWeight:1,strokeColor:'#64748b',strokeOpacity:.55,strokeStyle:'shortdash',fillColor:'#64748b',fillOpacity:.05});searchTemporaryRadius.setMap(state.map);}
  }

  window.addEventListener('map-navigation-context-changed',()=>clearSearchTemporaryPin());
  window.addEventListener('map-navigation-logout',()=>clearSearchTemporaryPin());
  window.addEventListener('map-unified-search-clear',()=>clearSearchTemporaryPin());

  function renderAddressJudge(row) {
    row.addressRegion=window.MapLocationContract?.addressRegion(row.address)||'주소 권역 미확인';
    $("#addressJudgeResults").innerHTML = `<div class="judgeCard"><div class="judgeTop"><span class="judgeBadge ${row.decision === "O" ? "ok" : row.decision === "검토" ? "review" : "no"}">${esc(row.decision)}</span><b>${esc(row.customer || "신규 주소")}</b></div><div>주소 권역: ${esc(row.addressRegion||"주소 권역 미확인")} · 실제 담당 센터: ${esc(row.actualDispatchCenter?.label||"담당 센터 미확인")}</div><div>권역판정: <b>${row.decision === "O" ? "가능" : esc(row.reason)}</b></div><div>배송요일: <b>${esc(row.deliveryDays || "")}</b></div><div>근접호차: <b>${esc(vehicleLabel(row.vehicle || "-"))}</b>${row.nearestDistance == null ? "" : ` · ${formatDistance(row.nearestDistance)}`}</div>${row.facility ? `<span class="facility">차량 진입 확인 필요</span>` : ""}</div>`;
  }

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

  let navigationVehicleKey='';
  function refreshVehicleUi(run, { preserveSearch = false } = {}) {
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
      updateOperationMetrics(null);
    }
    if (state.mode === "BASE_60D" && selected.length) periodVehicleScope = "selected";
    $("#selectedVehicleCount").textContent = selected.length ? `${selected.length}대` : "선택 없음";
    $("#vehicleModeLabel").textContent = selected.length === 1 ? "해당 호차 집중모드" : selected.length > 1 ? "선택 호차 매장" : "전체 호차 매장";
    $("#mapStatusTitle").textContent = selected.length === 1 ? `${selected[0]}호 ${state.mode==='DATE_ROUTE'?'운행':'매장'}` : selected.length > 1 ? `${selected.length}대 호차 매장` : "전체 호차 매장";
    $("#vehicleChips").className = selected.length ? "" : "vehiclePlaceholder";
    $("#vehicleChips").textContent = selected.length ? `${selected.length}개 호차 선택` : "전체 호차";
    renderVehicleQuickFilter(selected);
    $("#operationVehicle").value = selected.length === 1 ? selected[0] : "";
    const nextNavigationVehicleKey=selected.join('\0');
    if(navigationVehicleKey!==nextNavigationVehicleKey){
      navigationVehicleKey=nextNavigationVehicleKey;
      queueMicrotask(()=>window.dispatchEvent(new Event('map-navigation-vehicle-changed')));
    }
    if (!selected.length) {
      operationStops = []; renderRunList();
      ++state.todayRequestId; updateOperationMetrics(null); $("#syncOperation").disabled = false;
      if (state.mode === "DATE_ROUTE") { state.routeRows = []; clearMap(); }
    }
    if (run) {
      operationStops = []; state.routeRows = []; renderRunList();
      if (!preserveSearch || (selected.length && !state.userMovedMap && !state.selected && !state.virtual)) requestMapFit();
      else state.fitRequested = false;
      loadBaseMap();
      if (state.mode === 'DATE_ROUTE') loadOperationStatus(primarySelectedVehicle(), selected.length === 1);
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
  function isDailyDataReady(){return dateReady&&state.mode==='DATE_ROUTE'&&datedSourceDate===state.selectedDate&&Boolean(datedSourceDate);}
  function filteredDateStores(rows) {
    if(!isDailyDataReady())return [];
    const selected=selectedVehicles();
    if(periodBasis==='vehicle'&&periodVehicleScope==='selected'&&!selected.length)return [];
    return rows.filter(row=>(periodBasis==='driver'||!selected.length||selected.includes(row.vehicle))&&(periodBasis==='driver'||!state.centerFilter||row.vehicleGroup===state.centerFilter)&&matchesDatedDriver(row));
  }
  async function loadBaseMap() {
    if (!dateReady || state.mode==='DATE_ROUTE'&&!isDailyDataReady()) return;
    if (state.mode === 'DATE_ROUTE') filterVehicleList();
    void refreshDriverMaster();
    const selected = selectedVehicles();
    let stores = state.mode === "BASE_60D" ? filteredPeriodStores()
      : filteredDateStores(allStores);
    stores.forEach(row=>{window.MapManualPins?.apply(row);liveAddressLocations?.apply(row);});
    if (state.mode === "BASE_60D") stores = stores.map(row => ({ ...row, color: vehicleColor(row.vehicle) }));
    renderStops(stores, { numbered: state.mode === "DATE_ROUTE", vehicles: selected });
    deferMapAddressWork();
    if(state.mode==='DATE_ROUTE'){
      state.routeRows=stores.filter(row=>Number.isFinite(row.lat)&&Number.isFinite(row.lng));
      operationStops=dedupeRouteStops(stores);renderRunList();
      updateOperationMetrics({totalStops:stores.length,completedStops:stores.every(row=>['COMPLETED','PENDING'].includes(row.status))?stores.filter(row=>row.status==='COMPLETED').length:null,remainingStops:stores.every(row=>['COMPLETED','PENDING'].includes(row.status))?stores.filter(row=>row.status==='PENDING').length:null});
    }
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
    $("#mapStatusSub").textContent = period ? `${stores.length}개 매장 · ${periodBasis === 'driver' ? '선택 기사 배송지' : (baseVehicleMeta?.stale?'이전 기준호차':'기준호차')}`
      : `${state.selectedDate} · ${stores.length}개 매장 · 해당일 편성`;
    $("#freshnessState").textContent = period ? `지도 반영일 ${modelStatus?.periodLatest || periodMeta?.periodLatest || state.rangeEnd}` : `${state.selectedDate} 편성 조회 완료`;
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
    $("#mapStatusSub").textContent = `${date} · 방문 목록 · 길찾기에서 경로를 조회하세요.`;
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
    return { ...row, status: completed ? "COMPLETED" : ['PENDING','INCOMPLETE'].includes(status)||stop.completed===false ? "PENDING" : "", actualCompletedAt: completed ? (stop.actualCompletedAt || stop.completedAt || null) : null, isEstimated: stop.isEstimated===true };
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

  function newAreaCoordinate(row) {
    if (!row) return null;
    const point = {...row};
    if (/^[A-Z]\d+$/.test(point.customerCode||'')) window.MapManualPins?.apply(point);
    liveAddressLocations?.apply(point);
    const status = point.coordinateStatus || point.raw?.coordinateStatus;
    const lat = numberOrNull(point.lat), lng = numberOrNull(point.lng);
    if (['CONFLICT','UNVERIFIED','MISSING'].includes(status) || point.resolutionStatus === 'ADDRESS_CHANGED_REVIEW_REQUIRED' || lat === null || lng === null || lat < 33 || lat > 39.5 || lng < 124 || lng > 132) return null;
    return {...point, lat, lng};
  }

  function newAreaComparisonStores() {
    const samePeriod = periodMeta?.startDate === state.rangeStart && periodMeta?.endDate === state.rangeEnd;
    // A resident customer/coordinate alone is not evidence of a delivery in this range.
    const dated = row => [row.lastDeliveryDate, row.deliveryDate, ...(row.relations || row.history || []).map(item => item.deliveryDate)]
      .some(date => date && date >= state.rangeStart && date <= state.rangeEnd);
    const complete = samePeriod && periodMeta.complete === true && (periodMeta.segmented !== true || periodMeta.aggregateComplete === true);
    const rows = complete ? periodRows : [...new Map([...latestSnapshotRows.filter(dated), ...(samePeriod ? periodRows : [])].map(row => [row.customerCode,row])).values()];
    return rows.map(row => {
      const saved = coordinateByCode.get(row.customerCode);
      const sameAddress = saved && (!row.address || !saved.address || row.address.replace(/\s/g,'') === saved.address.replace(/\s/g,''));
      const savedPoint = sameAddress ? newAreaCoordinate(saved) : null;
      const point = newAreaCoordinate(row) || (row.lat === undefined && row.lng === undefined && savedPoint ? newAreaCoordinate({...savedPoint,...row,lat:savedPoint.lat,lng:savedPoint.lng}) : null);
      return point && {...point, deliveryPattern:row.deliveryPattern || row.deliveryPatternText || (sameAddress ? saved.deliveryPattern : '') || '', vehicle:baseVehicles.get(row.customerCode)?.baseVehicle || ''};
    }).filter(Boolean);
  }

  async function newAreaCustomerMatch(query, signal, batch) {
    if (!window.kakaoGeocoder?.serverProxy || !query) return null;
    const key=query.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
    if (!batch.customers.has(key)) batch.customers.set(key,fetchJson('/api/map-phase2b/private/customer-search',{
      channel:'new-area-customer-search',ttl:0,timeout:30000,headers:{'x-map-customer-query':encodeURIComponent(query)}
    }).then(result=>{
      if (!Array.isArray(result.data)) throw Object.assign(Error('CUSTOMER_SEARCH_CONTRACT'),{code:'CUSTOMER_SEARCH_CONTRACT'});
      return result;
    }));
    const result=await batch.customers.get(key);
    if(signal?.aborted)throw Object.assign(Error('조회 취소'),{name:'AbortError'});
    const rows=result.data.filter(store=>/^[A-Z]\d{3,}$/.test(store.customerCode||'') && (store.matchedBy==='ADDRESS'||store.matchedBy==='CODE'));
    if(result.meta?.truncated || rows.length>1)return {candidates:rows};
    if(!rows.length)return null;
    return {...storesByCode.get(rows[0].customerCode),...rows[0]};
  }

  async function judgeNewAreaRow(row, signal, batch = {customers:new Map(),queries:new Map(),blocked:null}) {
    if (row.inputAmbiguous) return {...row,decision:'검토',reason:'입력 열 확인 필요',evidence:'주소/고객명 열 또는 따옴표를 확인해 주세요.',nearby:[]};
    if (/^[SB]\d{3,}$/i.test(row.address.trim())) {
      const code=row.address.trim().toUpperCase(),store=storesByCode.get(code)||latestSnapshotRows.find(item=>(item.customerCode||item.code)===code);
      if (!store) return {...row,decision:'검토',reason:'고객코드 확인 필요',evidence:'기존 고객 조회에서 코드 미확인 · 코드 문자열 지오코딩 안 함',nearby:[]};
      row={...row,customerCode:code,address:store.address||row.address,customer:row.customer||store.customerName,addressRegion:store.addressRegion,actualDispatchCenter:window.MapLocationContract?.dispatchCenter(store)};
      await liveAddressLocations?.ensure(store);
      const saved = newAreaCoordinate(store);
      if (saved) return judgeNewAreaPoint(row,saved);
      if (store.coordinateStatus === 'CONFLICT' || store.raw?.coordinateStatus === 'CONFLICT') return {...row,decision:'검토',reason:'주소·좌표 재확인 필요',evidence:'매장의 좌표 상태와 원본 주소를 확인해 주세요.',nearby:[]};
      if (!store.address) return {...row,decision:'검토',reason:'고객 주소·좌표 미확인',nearby:[]};
    }
    if (!validNewAreaInput(row.address)) return { ...row, decision: "검토", reason: "주소 확인 필요", deliveryDays: "", facility: false, nearby: [] };
    const manual = (manualDraft?.stops() || []).filter(stop => stop.label === row.address).map(newAreaCoordinate).filter(Boolean);
    if (manual.length) return judgeNewAreaPoint(row,manual.length === 1 ? {...manual[0],coordinateSource:'MANUAL_WAYPOINT'} : {candidates:manual});
    // Reuse saved/manual coordinates while external address lookup remains off.
    const stored = [...new Map([...latestSnapshotRows,...allStores].filter(store => [store.customerCode,store.customerName,store.address].includes(row.address)).map(store => [store.customerCode,store])).values()].map(newAreaCoordinate).filter(Boolean);
    if (stored.length) return judgeNewAreaPoint(row,NewAreaRequests.singleStoredLocation(stored));
    const queries=NewAreaRequests.addressQueries(row.address,Phase2bUi.addressVariants);
    if (!queries.length) return {...judgeNewAreaPoint(row,null),evidence:'검색용 기본주소 확인 필요 · 원문 보존'};
    let matched=null;
    for(const query of queries){matched=await newAreaCustomerMatch(query,signal,batch);if(matched)break;}
    if(matched?.candidates)return judgeNewAreaPoint(row,matched);
    if(matched){
      await liveAddressLocations?.ensure(matched);
      const saved=newAreaCoordinate(matched);
      if(saved)return judgeNewAreaPoint({...row,customerCode:matched.customerCode},saved);
      return {...judgeNewAreaPoint({...row,customerCode:matched.customerCode},null),reason:'기존 고객 좌표 확인 필요',evidence:'인증된 고객 주소 매칭 · 저장·수동 좌표 확인 필요 · 외부 좌표로 대체하지 않음'};
    }
    const blocked=batch.blocked||window.kakaoGeocoder?.blockedReason;
    if(blocked)throw Object.assign(Error(blocked),{code:blocked==='GEOCODE_DAILY_LIMIT'?blocked:'GEOCODE_AUTOMATICALLY_BLOCKED'});
    if (window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup !== true) return {...judgeNewAreaPoint(row,null),evidence:'저장 위치 미확인 · 매장 좌표 상태 또는 직접 지정한 경유지 위치를 확인해 주세요.'};
    // Request-scoped reuse only. Neither the input nor response coordinates are persisted.
    const point = await geocodeAddress(row.address, signal,batch.queries);
    return judgeNewAreaPoint(row, point);
  }

  function judgeNewAreaPoint(row, point) {
    const base = { ...row, ...point, address:row.address,customer:row.customer,originalAddress:row.originalAddress,originalCustomer:row.originalCustomer,resolvedAddress:point?.address,lookupStatus:newAreaCoordinate(point)?'SUCCESS':'DEFERRED',addressRegion:row.addressRegion||window.MapLocationContract?.addressRegion(row.address)||'주소 권역 미확인',actualDispatchCenter:row.actualDispatchCenter||{state:'UNCONFIRMED',label:'담당 센터 미확인'},rangeStart: state.rangeStart, rangeEnd: state.rangeEnd, decision: "검토", nearby: [], vehicle: "-", nearestDistance: null, facility: facilityReview(`${row.address} ${row.customer}`) };
    if (!point || point.candidates || !newAreaCoordinate(point)) return { ...base, reason: point?.candidates ? "주소 복수 후보" : "주소 확인 필요", evidence: point?.candidates ? "주소 후보를 먼저 확정해 주세요." : "검증된 저장·수동 좌표 미확인" };
    const comparisons = newAreaComparisonStores();
    const distances = comparisons.map(store => ({...store,distance:distanceKm(point,store)})).sort((a,b) => a.distance-b.distance);
    const nearby = distances.filter(store => store.distance <= .5);
    const conflicting=new Set(periodRows.filter(store=>['CONFLICT','UNVERIFIED','MISSING'].includes(store.coordinateStatus||store.raw?.coordinateStatus)||store.resolutionStatus==='ADDRESS_CHANGED_REVIEW_REQUIRED').map(store=>store.customerCode));
    const locationRows=[...new Map([...latestSnapshotRows.filter(store=>!conflicting.has(store.customerCode)),...comparisons].map(store=>[store.customerCode,store])).values()]
      .map(newAreaCoordinate).filter(Boolean).map(store=>({...store,vehicle:baseVehicles.get(store.customerCode)?.baseVehicle||store.vehicle||''}));
    const locationDistances=locationRows.map(store=>({...store,distance:distanceKm(point,store)})).sort((a,b)=>a.distance-b.distance);
    const storedNearby=locationDistances.filter(store=>store.distance<=.5);
    const references = Phase2bUi.nearbyVehicles(point, locationRows, 30);
    const exception = legacyException(`${row.address} ${row.customer}`);
    const periodComplete = dateReady && periodMeta?.complete === true && periodMeta.startDate === state.rangeStart && periodMeta.endDate === state.rangeEnd && (periodMeta.segmented !== true || periodMeta.aggregateComplete === true);
    const limits=[!periodComplete?'전체 기간 비교 미완료':null,periodMeta?.missingCoordinate>0 || periodComplete && comparisons.length < periodRows.length?'비교 원천 좌표 누락':null,periodMeta?.coverageComplete!==true?'전체 원천 완전성 미검증':null].filter(Boolean);
    const nearest=locationDistances[0];
    const facts={...base,nearby,references,storedNearbyCount:storedNearby.length,evidenceCount:nearby.length,dataLimits:limits.join(' · '),deliveryDays:combineNearbyPatterns(nearby),vehicle:nearby[0]?.vehicle||references[0]?.vehicle||'-',nearestStore:nearest?.customerName||'',nearestDistance:nearest?.distance??null};
    if(limits.length)return {...facts,reason:'위치 확인 완료 · 배송판정 검토',evidence:(exception?exception+' · ':'')+(nearby.length?'500m 내 기존 배송점 확인 · ':references.length?'30km 내 근접호차 확인 · ':'')+limits.join(' · ')+' · 인근 배송점 부재 확정 불가 · 직선거리이며 도로 진입 판정 아님'};
    if(exception)return {...facts,decision:'X',reason:exception,evidence:'기존 지역/시설 업무 제외 규칙'};
    if(base.facility)return {...facts,reason:'차량 진입 확인 필요',evidence:nearby.length?'500m 내 기존 배송점 확인 · 시설 진입 별도 확인':'시설 진입 확인 전 확정 불가'};
    if(nearby.length)return {...facts,decision:'O',reason:'',evidence:'500m 내 기존 배송점 확인 · 직선/공간거리 기준 · 도로 진입 별도 확인'};
    return {...facts,decision:'검토',reason:'500m 내 기존 배송점 미확인',evidence:(references.length?'검증된 비교 범위의 500m 내 배송점 없음':'검증된 비교 범위의 30km 내 배송점 없음')+' · 직선거리 기준 · 도로 진입 미확인 · 실제 운행가능 여부 미확정'};
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
    if (state.mode !== "BASE_60D") { $(statusId).textContent = "매장·권역 지도에서 조회해 주세요."; return; }
    const periodKey = state.rangeStart + "|" + state.rangeEnd;
    const rows = parseNewArea(inputId);
    if (!rows.length) { $(statusId).textContent = "주소를 입력해주세요."; return; }
    batchController = new AbortController();
    const signal = batchController.signal;
    setNewAreaBusy(true);
    $(statusId).textContent = `${rows.length}건 판단 중...`;
    const judged = [];
    const batch={customers:new Map(),queries:new Map(),blocked:null};
    const progress=()=>`입력 ${rows.length} · 완료 ${judged.length} · 위치 확인 ${judged.filter(row=>row.lookupStatus==='SUCCESS'||newAreaCoordinate(row)).length} · 보류 ${judged.filter(row=>!['SUCCESS','FAILED','LIMIT'].includes(row.lookupStatus)&&!newAreaCoordinate(row)).length} · 실패 ${judged.filter(row=>row.lookupStatus==='FAILED').length} · 한도대기 ${judged.filter(row=>row.lookupStatus==='LIMIT').length}`;
    for (const row of rows) {
      try { judged.push(await judgeNewAreaRow(row, signal,batch)); }
      catch (error) {
        if (requestId !== newAreaRequestId || isSilentRequestError(error)) return;
        if(NewAreaRequests.stopsExternal(error)||window.kakaoGeocoder?.blockedReason)batch.blocked=error.code||'GEOCODE_AUTOMATICALLY_BLOCKED';
        const lookupStatus=NewAreaRequests.outcome(error);
        judged.push({...row,decision:'검토',reason:lookupStatus==='LIMIT'?'일일 주소 조회 한도 대기':lookupStatus==='DEFERRED'?/^GEOCODER_/.test(error.code||'')?'주소 결과 확인 필요 · 보류':'주소 조회 차단 · 보류':'조회 실패 · 검토필요',evidence:NewAreaRequests.message(error)+' · 원문 보존',lookupStatus,lookupError:lookupStatus==='FAILED',nearby:[]});
      }
      if (requestId !== newAreaRequestId || periodKey !== state.rangeStart + "|" + state.rangeEnd || state.mode !== "BASE_60D") return;
      $(statusId).textContent = progress();
    }
    state.newAreaResults = judged;
    setNewAreaBusy(false); batchController = null;
    $("#exportNewAreaCsv").disabled = !judged.length;
    $("#exportNewAreaExcel").disabled = !judged.length;
    if(judged.length){$('#copyAreaDecision')?.removeAttribute('disabled');$('#copyAreaMatching')?.removeAttribute('disabled');}
    $(statusId).textContent = progress()+` · 권역 내 ${judged.filter(row=>row.decision==='O').length} · 행 실패 ${judged.filter(row=>row.lookupError).length}`;
    $(resultId).innerHTML = judged.map((row, index) => `<button class="judgeCard batchResult" data-judged="${index}"><div class="judgeTop"><span class="judgeBadge ${row.decision === "O" ? "ok" : "no"}">${row.decision === "O" ? "권역 가능" : esc(row.reason || "판단 보류")}</span><b>${esc(row.customer || row.address)}</b></div><div>사용 주소: ${esc(row.address)}</div>${!Number.isFinite(row.lat) || !Number.isFinite(row.lng) ? "<div>클릭하여 확인된 위치 입력</div>" : ""}<div>500m 저장위치 ${Number.isFinite(row.storedNearbyCount)?row.storedNearbyCount:'미확인'}개 · 기간 배송근거 ${Number.isFinite(row.evidenceCount)?row.evidenceCount:'미확인'}개</div><div>주소 권역: ${esc(row.addressRegion||"주소 권역 미확인")} · 실제 담당 센터: ${esc(row.actualDispatchCenter?.label||"담당 센터 미확인")}</div><div>${esc(row.evidence || "")} · ${esc(vehicleLabel(row.vehicle))} ${row.nearestDistance == null ? "" : formatDistance(row.nearestDistance)}</div><div>${esc(row.rangeStart || state.rangeStart)} ~ ${esc(row.rangeEnd || state.rangeEnd)}${Number.isFinite(row.evidenceCount) ? ` · 500m 근거 ${row.evidenceCount}개` : ''}</div><div>${esc(row.dataLimits || '')}</div><div>30km 근접호차: ${esc((row.references || []).map(item => vehicleLabel(item.vehicle) + " " + formatDistance(item.distance)).join(" · ") || "확인 근거 없음")}</div><div>인근 배송점 요일 자료(실배송요일 미확정): ${esc(row.deliveryDays || "확인 근거 없음")}${row.facility ? " · 차량 진입 확인 필요" : ""}</div></button>`).join("");
    $$('[data-judged]').forEach((button) => button.onclick = () => {
      const row = judged[Number(button.dataset.judged)];
      if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) {
        const dialog = $('#mapBatchDialog'), manual = $('#manualRouteTool');
        if (row.customerCode && window.MapManualPins?.open) { dialog?.close(); void window.MapManualPins.open(row.customerCode); return; }
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

  async function loadOperationStatus(vehicle, showRoute = false, representative = {}, refresh = false) {
    if (!isDailyDataReady()) return;
    // Saved review rows have no live run-status feed. Their dated assignments
    // remain selectable; absence of status/order must never turn them into zeros.
    if(dailyMeta?.reviewOnly===true){if(showRoute)await loadBaseMap();return;}
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
    const visibleStores = periodListLimit ? stores.slice(Math.max(0,periodListLimit-100),periodListLimit) : [];
    $("#periodStoreListCount").textContent = stores.length + "개 매장";
    panel.innerHTML = visibleStores.map(row => `<button class="resultItem periodStore${state.selected?.customerCode === row.customerCode ? " selected" : ""}" aria-pressed="${state.selected?.customerCode === row.customerCode}" data-period-store="${esc(row.customerCode)}"><span class="periodCode">${esc(row.customerCode)}</span><b>${esc(row.customerName || row.customerCode)}</b><span>${esc(row.lastDeliveryDate || "")} · ${esc(vehicleLabel(row.vehicle))}</span><span>${esc(row.driverName || "기사 미등록")} · ${row.visitCount===null?'방문횟수 미확인':(row.visitCount??row.history?.length??0)+'회'}</span></button>`).join("") || `<p class="hint">${stores.length ? '검색하거나 지도 핀을 선택하세요. 전체 목록은 요청할 때만 표시합니다.' : '조회 조건에 맞는 매장이 없습니다.'}</p>`;
    $("#periodListMore").hidden = !periodListLimit || stores.length <= periodListLimit;
    const toggle=$('#togglePeriodList');if(toggle){toggle.textContent=periodListLimit?'접기':'펼치기';toggle.setAttribute('aria-expanded',String(!!periodListLimit));}
    $("#periodListMore").textContent = periodListLimit ? '다음 100개 매장' : '목록 보기 (100개씩)';
    $$("[data-period-store]").forEach(button => button.onclick = () => { const row = stores.find(item => item.customerCode === button.dataset.periodStore); if (row) selectStore(row, null, true); });
  }

  function bindEvents() {
    $("#modePeriod").onclick = () => { if(state.mode==='BASE_60D'&&generalMap&&dateReady)return;void initializeGeneral(); };
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
      invalidateUnifiedSearch();if(typeof clearSearchTemporaryPin==='function')clearSearchTemporaryPin({restoreView:false});
      cancelAddressLookup();closeUnifiedSearchResults();setSearchState('');
      if(!$('#query').value.trim())clearUnifiedSearch();
    };
    $("#query").onkeydown = (event) => {
      if(event.key==='Escape'){invalidateUnifiedSearch();cancelAddressLookup();closeUnifiedSearchResults();return;}
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
    ["#date", "#mobileDate", "#selectedDate"].forEach((id) => { $(id).onchange = (event) => { dateChosenByUser = true; changeSelectedDate(event.target.value); }; });
    $("#operationVehicle").onchange = (event) => { const vehicle = event.target.value; setSelectedVehicles([vehicle]); $("#vehicle").value = vehicle; $("#mobileVehicle").value = vehicle; refreshVehicleUi(true); };
    $("#syncOperation").onclick = () => {if(state.mode==="DATE_ROUTE")return refreshSelectedDate();};
    $("#routePlan").onclick = () => loadRoute("pc");
    $("#endRoute").onclick = endRoute;
    $("#mapReset").onclick = resetMapOverview;
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
    fixedTerritoryMasterState:()=>({version:baseVehicleMeta?.version||null,stale:baseVehicleMeta?.stale!==false,checkedAt:baseVehicleMeta?.checkedAt||null,lastError:baseVehicleMeta?.lastError||null,refresh:baseVehicleMeta?.refresh||null}),
    fixedTerritoryStores:()=>window.MapUiLocalBridge.navigationStores().map(row=>({...row,...(baseVehicles.get(String(row.customerCode))||{baseVehicle:'',baseVehicleState:'UNKNOWN'})})),
    loadBaseVehicleMasterForTerritory:()=>loadBaseVehicles(window.MapUiLocalBridge.navigationStores().map(row=>String(row.customerCode||''))),
    navigationStores:()=>{if(state.mode==='DATE_ROUTE')return isDailyDataReady()?allStores.map(row=>liveAddressLocations?.apply({...row})||{...row}):[];const list=new Map(latestSnapshotRows.map(r=>[r.customerCode,r]));for(const row of allStores){const prior=list.get(row.customerCode);const conflict=prior&&row.address&&prior.address&&row.address.replace(/\s/g,'')!==prior.address.replace(/\s/g,'');list.set(row.customerCode,{...row,...(conflict?{coordinateStatus:'CONFLICT'}:{})});}return [...list.values()].map(row=>liveAddressLocations?.apply({...row})||row);},
    selectNavigationStore:code=>{const row=(state.mode==='DATE_ROUTE'&&!isDailyDataReady()?[]:allStores).find(r=>r.customerCode===code)||(state.mode==='BASE_60D'?latestSnapshotRows.find(r=>r.customerCode===code):null);if(row)selectStore(row,null,true);},
    queryRecordedRoute:()=>{cancelManualRoadRoute();const v=primarySelectedVehicle();if(!v||!operationStops.length||operationStops.some(s=>!Number.isSafeInteger(s.order)||s.order<1)){roadResult={state:'error',error:'RECORDED_ORDER_REQUIRED'};window.dispatchEvent(new CustomEvent('map-recorded-route',{detail:roadResult}));syncRoadRoutePanel();return;}loadRoadRoute(v,{explicit:true});},
    toggleConnections:()=>{state.connectionLines=false;state.lines.forEach(line=>line.setMap(null));state.lines=[];return {shown:false};},
    toggleRoadLines:value=>{roadLinesVisible=Boolean(value);if(!roadLinesVisible){manualRoadLayer?.clear();roadLayer?.clear();}else{if(state.map){manualRoadLayer ||= window.RoadRouteUi.createLayer({map:state.map});manualRoadLayer.render(manualRoadResult);roadLayer ||= window.RoadRouteUi.createLayer({map:state.map});roadLayer.render(roadResult);}}},
    highlightManualLeg:index=>{if(roadLinesVisible&&state.map&&manualRoadResult){manualRoadLayer ||= window.RoadRouteUi.createLayer({map:state.map});manualRoadLayer.render({...manualRoadResult,selectedLeg:Number.isInteger(index)?index:undefined});}},
    highlightRecordedLeg:index=>{if(roadLinesVisible&&state.map&&roadResult){roadLayer ||= window.RoadRouteUi.createLayer({map:state.map});roadLayer.render({...roadResult,selectedLeg:Number.isInteger(index)?index:undefined});}},
    async submitDailyQuery(start,end){
      const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
      if(state.mode!=='DATE_ROUTE'||!valid(start)||start!==end||end>localDate())return {ok:false,message:'일자별 운행은 선택한 배송일 한 날짜만 조회합니다.'};
      const queryConditions={vehicles:selectedVehicles().slice(),centerFilter:'',scope:periodVehicleScope};
      await changeSelectedDate(end,queryConditions);
      return {ok:dateReady,message:dateReady?'':$('#freshnessState').textContent};
    },
    setGeneralLegend(html){originalRouteLegend=html;syncRoadRoutePanel();},
    lookupStore(value){
      const key=String(value||'').trim();
      if(state.mode==='BASE_60D'&&storesByCode.has(key))return [storesByCode.get(key)];
      return allStores.filter(row=>[row.customerCode,row.customerName,row.address].includes(key));
    },
    navigationDailyIdentity:()=>{
      const vehicles=selectedVehicles();
      return isDailyDataReady()&&vehicles.length===1&&!hasDatedDriverFilter()?{date:state.selectedDate,vehicle:vehicles[0]}:null;
    },
    navigationVisitRows:()=>isDailyDataReady()?operationStops.map(row=>({...row})):[],
    canLookupNavigationAddress:()=>window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup===true,
    lookupNavigationAddress:(text,signal)=>geocodeAddress(String(text||'').trim(),signal),
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
  setInterval(() => { $("#currentTime").textContent = formatTime(new Date()); }, 10000);
  refreshVehicleUi(false);
  window.MapStaffEntry?.registerPurge(()=>hybridUi?.logout());
  window.addEventListener('map-staff-signed-out',purgeStaffData);
  window.addEventListener('map-staff-ready',()=>{
    SOURCE=window.VEHICLE_AREA_DATA||{vehicles:[]};ADMIN.clear();
    for(const feature of window.ADMIN_FEATURES||[])ADMIN.set(String(feature.properties?.code||''),feature);
    initVehicles();void initializeGeneral();void initMap();
  });
  window.addEventListener('pagehide',event=>{cancelManualRoadRoute();resetRoadRoute();if(event.persisted)hybridUi?.cancel();else{hybridUi?.dispose();mapObserver?.disconnect();for(const [name,fn]of mapHandlers)kakao?.maps?.event?.removeListener?.(state.map,name,fn);mapHandlers=[];}});window.addEventListener('pageshow',event=>{if(event.persisted)mapCamera?.scheduleRelayout();});
  if(document.body.dataset.mapStaffState==='authenticated'||!window.MapStaffEntry){
    initMap();
    initializeGeneral();
  }
})();
