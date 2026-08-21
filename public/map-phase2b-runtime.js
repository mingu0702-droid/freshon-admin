(function () {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const SOURCE = window.VEHICLE_AREA_DATA || { vehicles: [] };
  const ADMIN = new Map((window.ADMIN_FEATURES || []).map((feature) => [String(feature.properties?.code || ""), feature]));
  const COLORS = ["#2563eb", "#7c3aed", "#0f766e", "#b45309", "#0891b2", "#db2777", "#dc2626", "#059669", "#9333ea", "#c2410c"];
  const state = { mode: "BASE_60D", areaOn: true, centerFilter: "", map: null, overlays: [], lines: [], polygons: [], selected: null, virtual: null, currentRows: [], routeRows: [], newAreaResults: [], fitRequested: true, userMovedMap: false, suppressMapEventsUntil: 0, baseRequestId: 0, routeRequestId: 0, searchRequestId: 0, addressRequestId: 0, detailRequestId: 0, todayRequestId: 0 };
  const allStores = [];
  const storeByVehicleAndCode = new Map();
  const storesByCode = new Map();
  const driverByVehicle = new Map();
  const requestControllers = new Map();
  const memoryResponses = new Map();

  SOURCE.vehicles.forEach((vehicle, vehicleIndex) => {
    (vehicle.customers || []).forEach((customer) => {
      const row = normalizeStore(customer, vehicle, vehicleIndex);
      allStores.push(row);
      storeByVehicleAndCode.set(`${vehicle.vehicle}|${row.customerCode}`, row);
      if (!storesByCode.has(row.customerCode)) storesByCode.set(row.customerCode, row);
    });
  });

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
      color: COLORS[vehicleIndex % COLORS.length],
      adminCode: String(customer.admin_code || ""),
      raw: customer,
      vehicleRaw: vehicle
    };
  }

  function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function vehicleColor(vehicle) {
    const index = SOURCE.vehicles.findIndex((item) => String(item.vehicle) === String(vehicle));
    return COLORS[(index < 0 ? 0 : index) % COLORS.length];
  }

  function selectedVehicles() {
    return vehicleChecks().filter((item) => item.checked).map((item) => item.value);
  }

  function setSelectedVehicles(values) {
    const wanted = new Set((values || []).map(String));
    vehicleChecks().forEach((item) => { item.checked = wanted.has(item.value); });
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
        <span class="vehicleNo">${esc(vehicle.vehicle)}호</span>
        <span class="vehicleArea">${esc(vehicle.area_label || vehicle.primary_area || vehicle.group || "권역")}</span>
      </label>`).join("");
    vehicleChecks().forEach((input) => { input.onchange = () => { state.centerFilter = ""; refreshVehicleUi(true); }; });
    [$("#vehicle"), $("#mobileVehicle")].forEach((select) => {
      select.innerHTML = vehicles.map((vehicle) => `<option value="${esc(vehicle)}">${esc(vehicle)}호</option>`).join("");
      if (vehicles.includes("101")) select.value = "101";
    });
    $("#mobileBaseVehicle").innerHTML = `<option value="">전체 호차</option>${vehicles.map((vehicle) => `<option value="${esc(vehicle)}">${esc(vehicle)}호</option>`).join("")}`;
    refreshDriverMaster();
  }

  async function refreshDriverMaster() {
    try {
      const payload = await fetchJson(`/api/vehicle-driver-master?date=${encodeURIComponent(inferLatestDate())}`, { channel: "driver-master", ttl: 300000, timeout: 15000 });
      const rows = payload.vehicles || payload.results || [];
      const drivers = new Map(rows.map((row) => [normalizeVehicle(row.vehicle || row.vehicleNumber), row.driverName || row.name || ""]));
      rows.forEach((row) => driverByVehicle.set(normalizeVehicle(row.vehicle || row.vehicleNumber), row));
      [$("#vehicle"), $("#mobileVehicle")].forEach((select) => [...select.options].forEach((option) => {
        const driver = drivers.get(option.value);
        if (driver) option.textContent = `${option.value}호 · ${driver}`;
      }));
    } catch (_) { /* vehicle-data remains the verified operational source */ }
  }

  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), "ko", { numeric: true });
  }

  function initMap() {
    if (!window.kakao?.maps?.load) {
      setMapMessage("카카오 지도를 불러오지 못했습니다.");
      loadBaseMap();
      return;
    }
    kakao.maps.load(() => {
      state.map = new kakao.maps.Map($("#map"), { center: new kakao.maps.LatLng(36.7, 127.7), level: 13 });
      window.kakaoGeocoder = new kakao.maps.services.Geocoder();
      window.kakaoPlaces = new kakao.maps.services.Places();
      kakao.maps.event.addListener(state.map, "dragstart", () => { if (Date.now() >= state.suppressMapEventsUntil) state.userMovedMap = true; });
      kakao.maps.event.addListener(state.map, "zoom_start", () => { if (Date.now() >= state.suppressMapEventsUntil) state.userMovedMap = true; });
      kakao.maps.event.addListener(state.map, "zoom_changed", () => $("#map").classList.toggle("mapZoomFar", state.map.getLevel() >= 9));
      kakao.maps.event.addListener(state.map, "click", clearSelection);
      if (window.ResizeObserver) new ResizeObserver(() => state.map?.relayout?.()).observe($("#map"));
      loadBaseMap();
    });
  }

  function setMapMessage(message) {
    $("#map").innerHTML = `<div style="display:grid;place-items:center;height:100%;color:#667085;background:#f8fafc">${esc(message)}</div>`;
  }

  function clearMap() {
    [...state.overlays, ...state.lines, ...state.polygons].forEach((item) => item.setMap?.(null));
    state.overlays = [];
    state.lines = [];
    state.polygons = [];
  }

  function clearSelection() {
    $$(".marker.selected").forEach((item) => item.classList.remove("selected"));
    state.selected = null;
    $("#detailSection").classList.remove("open");
    $("#detail").className = "idle";
    $("#detail").textContent = "검색하거나 핀을 선택하면 점포정보가 표시됩니다.";
  }

  function markerElement(row, index, kind) {
    const button = document.createElement("button");
    const completed = row.status === "COMPLETED";
    const pending = row.status && !completed;
    button.className = `marker${completed ? " done" : pending ? " pending" : ""}${kind === "virtual" ? " virtual" : ""}`;
    button.style.background = !index && row.vehicle ? vehicleColor(row.vehicle) : "";
    button.innerHTML = `${kind === "virtual" ? "신규" : index || esc(row.vehicle || "")}<span class="markerLabel">${esc(row.customerName || row.address || "선택 위치")}</span>`;
    button.onclick = () => row.representative ? selectVehicleStatus(row, button) : selectStore(row, button, true);
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
      customerName: `${vehicle}호`,
      address: stores[0]?.areaLabel || stores[0]?.vehicleGroup || "",
      lat: stores.reduce((sum, row) => sum + row.lat, 0) / stores.length,
      lng: stores.reduce((sum, row) => sum + row.lng, 0) / stores.length,
      storeCount: stores.length,
      vehicleGroup: stores[0]?.vehicleGroup || "",
      representative: true
    }));
  }

  function renderStops(rows, options = {}) {
    clearMap();
    state.currentRows = rows.slice();
    if (!state.map) return;
    const valid = rows.filter((row) => Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng)));
    if (!valid.length) {
      $("#mapStatusSub").textContent = "조회 결과 없음";
      return;
    }
    const bounds = new kakao.maps.LatLngBounds();
    valid.forEach((row, index) => {
      const position = new kakao.maps.LatLng(Number(row.lat), Number(row.lng));
      bounds.extend(position);
      const overlay = new kakao.maps.CustomOverlay({
        position,
        content: markerElement(row, options.numbered ? Number(row.order) || index + 1 : null, options.virtual ? "virtual" : ""),
        yAnchor: 1.05,
        zIndex: options.virtual ? 7 : 3
      });
      overlay.setMap(state.map);
      state.overlays.push(overlay);
    });
    if (state.areaOn && options.boundaries !== false) drawSelectedBoundaries(options.vehicles || selectedVehicles());
    const mobileRoute = innerWidth <= 760 && options.numbered;
    if (state.fitRequested && !state.userMovedMap) {
      state.suppressMapEventsUntil = Date.now() + 700;
      state.map.relayout?.();
      state.map.setBounds(bounds, mobileRoute ? 130 : 55, 40, mobileRoute ? 260 : 55, 40);
      state.fitRequested = false;
    }
  }

  function drawSelectedBoundaries(selected) {
    const vehicles = selected.length
      ? SOURCE.vehicles.filter((vehicle) => selected.includes(String(vehicle.vehicle)))
      : SOURCE.vehicles;
    vehicles.forEach((vehicle) => {
      const color = vehicleColor(vehicle.vehicle);
      [...new Set(vehicle.detail_admin_codes || [])].forEach((code) => {
        const feature = ADMIN.get(String(code));
        if (!feature) return;
        geometryPaths(feature.geometry).forEach((path) => {
          if (path.length < 3) return;
          const polygon = new kakao.maps.Polygon({ path, strokeWeight: selected.length ? 3 : 2, strokeColor: color, strokeOpacity: .76, fillColor: color, fillOpacity: selected.length ? .05 : .015 });
          polygon.setMap(state.map);
          state.polygons.push(polygon);
        });
      });
    });
  }

  function geometryPaths(geometry) {
    if (!geometry) return [];
    const ring = (coordinates) => coordinates.map(([lng, lat]) => new kakao.maps.LatLng(lat, lng));
    if (geometry.type === "Polygon") return geometry.coordinates.map(ring);
    if (geometry.type === "MultiPolygon") return geometry.coordinates.flatMap((polygon) => polygon.map(ring));
    return [];
  }

  function drawRoute(rows) {
    if (!state.map || rows.length < 2) return;
    const actual = rows.filter((row) => row.status === "COMPLETED");
    const pending = rows.filter((row) => row.status !== "COMPLETED");
    const estimated = pending.length ? (actual.length ? [actual[actual.length - 1], ...pending] : pending) : [];
    if (actual.length > 1) addLine(actual, "#14825d", "solid", 5);
    if (estimated.length > 1) addLine(estimated, "#f59e0b", "shortdash", 4);
  }

  function addLine(rows, color, style, weight) {
    const line = new kakao.maps.Polyline({
      path: rows.map((row) => new kakao.maps.LatLng(Number(row.lat), Number(row.lng))),
      strokeWeight: weight,
      strokeColor: color,
      strokeOpacity: .9,
      strokeStyle: style
    });
    line.setMap(state.map);
    state.lines.push(line);
  }

  function selectStore(row, element, focus, skipEnrich = false) {
    $$(".marker.selected").forEach((item) => item.classList.remove("selected"));
    element?.classList.add("selected");
    state.selected = row;
    if (focus && state.map && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng))) {
      state.suppressMapEventsUntil = Date.now() + 500;
      state.map.panTo(new kakao.maps.LatLng(Number(row.lat), Number(row.lng)));
    }
    const routeMode = state.mode === "DATE_ROUTE";
    const vehicle = normalizeVehicle(row.vehicle);
    const orderCard = routeMode && row.order ? `<div class="stat"><strong>${esc(row.order)}</strong><span>착순</span></div>` : "";
    const statusCard = row.status ? `<div class="stat"><strong>${row.status === "COMPLETED" ? "완료" : "잔여"}</strong><span>상태</span></div>` : "";
    $("#detailSection").classList.add("open");
    $("#detail").className = "detailCard";
    $("#detail").innerHTML = `<div class="detailHead"><button id="detailClose" class="detailClose" aria-label="닫기">×</button><div class="code">${esc(row.customerCode || "외부 주소")}</div><div class="storeName">${esc(row.customerName || "가상 위치")}</div></div>
      <div class="detailBody">
        <div class="detailLine"><b>주소</b><span>${esc(row.address || "-")}</span></div>
        <div class="detailLine"><b>호차</b><span>${vehicle ? `${esc(vehicle)}호` : "-"}</span></div>
        <div class="detailLine"><b>점주번호</b><span>${esc(row.ownerPhone || row.phone || "-")}</span></div>
        <div class="detailLine"><b>출입정보</b><span>${esc(row.accessInfo || row.accessMemo || "-")}</span></div>
        <div class="detailLine"><b>비밀번호</b><span>${esc(row.password || "-")}</span></div>
        <div class="detailLine"><b>최근배송</b><span>${esc(row.lastDeliveryDate || row.deliveryDate || "-")}</span></div>
        <div class="detailLine"><b>특이사항</b><span>${esc(row.specialRemark || row.deliveryRemark || row.accessMemo || "-")}</span></div>
        <div class="detailLine"><b>최근 클레임</b><span>${row.claimSummary ? esc(row.claimSummary) : "연결 데이터 없음"}</span></div>
        <div class="detailLine"><b>배송요일</b><span>${esc(row.deliveryPattern || row.deliveryPatternText || "-")}</span></div>
        <div class="detailLine"><b>배송권역</b><span>${esc(row.areaLabel || row.region || "-")}</span></div>
        <div class="stats"><div class="stat"><strong>${row.deliveryCount90d ?? row.deliveryCount ?? "-"}</strong><span>60일 배송</span></div>${orderCard}${statusCard}</div>
        <div class="mobileActions"><button id="mobileMapView" class="primary">지도 보기</button><button id="mobileRouteView" class="ghost">${esc(vehicle || "선택")}호 운행동선</button></div>
        <div id="nearWrap"></div>
      </div>`;
    $("#detailClose")?.addEventListener("click", clearSelection);
    if (Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng))) renderNearest(row);
    $("#mobileMapView")?.addEventListener("click", showMobileMap);
    $("#mobileRouteView")?.addEventListener("click", () => {
      if (vehicle && [...$("#mobileVehicle").options].some((option) => option.value === vehicle)) $("#mobileVehicle").value = vehicle;
      showMobileMap();
      document.body.classList.add("routeSheetOpen");
    });
    if (!skipEnrich && row.customerCode && !(row.ownerPhone || row.phone || row.accessInfo || row.password || row.specialRemark)) enrichStoreDetail(row, element);
  }

  async function enrichStoreDetail(row, element) {
    const requestId = ++state.detailRequestId;
    try {
      const payload = await fetchJson(`/api/map-phase2b/preview/search?q=${encodeURIComponent(row.customerCode)}`, { channel: "store-detail", ttl: 300000, timeout: 30000 });
      if (requestId !== state.detailRequestId || state.selected?.customerCode !== row.customerCode) return;
      const exact = (payload.data || []).map(normalizeApiStore).find((item) => item.customerCode === row.customerCode);
      if (exact) selectStore({ ...row, ...exact }, element, false, true);
    } catch (error) { if (!isSilentRequestError(error)) console.warn("store detail unavailable", row.customerCode, error.message); }
  }

  async function selectVehicleStatus(row, element) {
    $$(".marker.selected").forEach((item) => item.classList.remove("selected"));
    element?.classList.add("selected");
    const vehicle = normalizeVehicle(row.vehicle);
    $("#detailSection").classList.add("open");
    $("#detail").className = "detailCard";
    $("#detail").innerHTML = `<div class="detailHead"><button id="detailClose" class="detailClose">×</button><div class="code">${esc(vehicle)}호</div><div class="storeName">당일 운행 현황 조회 중...</div></div>`;
    $("#detailClose")?.addEventListener("click", clearSelection);
    const requestId = ++state.todayRequestId;
    try {
      const payload = await fetchJson(`/api/map-phase2b/preview/today-status?vehicle=${encodeURIComponent(vehicle)}`, { channel: "today-vehicle", ttl: 30000, timeout: 30000 });
      if (requestId !== state.todayRequestId) return;
      const status = payload.data?.vehicles?.[0];
      renderVehiclePanel(vehicle, status, row);
    } catch (error) {
      if (isSilentRequestError(error) || requestId !== state.todayRequestId) return;
      renderVehiclePanel(vehicle, null, row, error.message);
    }
  }

  function renderVehiclePanel(vehicle, status, row, error = "") {
    const driver = driverByVehicle.get(vehicle) || {};
    const lastTime = formatTime(status?.lastCompletedAt);
    const end = formatTime(status?.estimatedEndAt);
    const estimate = end ? `${end}${status.estimateConfidence === "낮음" ? " 전후 · 신뢰도 낮음" : " 예상"}` : "계산 데이터 부족";
    $("#detailSection").classList.add("open");
    $("#detail").className = "detailCard";
    $("#detail").innerHTML = `<div class="detailHead"><button id="detailClose" class="detailClose">×</button><div class="code">${esc(vehicle)}호 · ${esc(status?.driverName || driver.driverName || driver.name || "기사 미확인")}</div><div class="storeName">${esc(status?.status || (error ? "조회 실패" : "데이터없음"))}</div></div><div class="detailBody">
      ${error ? `<div class="notice show">${esc(error)}</div>` : ""}
      <div class="stats"><div class="stat"><strong>${status?.totalStops ?? row.storeCount ?? "-"}</strong><span>총 착지</span></div><div class="stat"><strong>${status?.completedStops ?? "-"}</strong><span>완료</span></div><div class="stat"><strong>${status?.remainingStops ?? "-"}</strong><span>잔여</span></div></div>
      <div class="detailLine"><b>진행률</b><span>${status ? `${status.progressPercent}%` : "-"}</span></div><div class="detailLine"><b>최근 완료</b><span>${status?.lastCompletedOrder ? `${status.lastCompletedOrder}착 / ${lastTime || "-"}` : "-"}</span></div><div class="detailLine"><b>다음 예정</b><span>${status?.nextOrder ? `${status.nextOrder}착` : "-"}</span></div><div class="detailLine"><b>최근 평균</b><span>${status?.avgMinutesPerStop ? `${status.avgMinutesPerStop}분/착` : "-"}</span></div><div class="detailLine"><b>예상 종료</b><span>${esc(estimate)}</span></div><div class="detailLine"><b>연락처</b><span>${esc(status?.driverPhone || driver.driverPhone || driver.phone || "-")}</span></div><div class="detailLine"><b>운수사</b><span>${esc(status?.carrierName || driver.carrierName || driver.companyName || "-")}</span></div>
      <button id="vehicleTodayRoute" class="primary" style="width:100%;height:35px;margin-top:7px">실제 운행동선 보기</button></div>`;
    $("#detailClose")?.addEventListener("click", clearSelection);
    $("#vehicleTodayRoute")?.addEventListener("click", () => { $("#date").value = status?.date || localDate(); $("#vehicle").value = vehicle; loadRoute("pc"); });
  }

  async function renderNearest(point) {
    let rows = [];
    try {
      const response = await fetchJson(`/api/map-phase2b/preview/nearest?lat=${encodeURIComponent(point.lat)}&lng=${encodeURIComponent(point.lng)}`, { channel: "nearest", ttl: 30000, timeout: 35000 });
      rows = response.data || [];
    } catch (error) {
      if (isSilentRequestError(error)) return;
      $("#nearWrap").innerHTML = `<div class="hint">근접호차 조회 실패: ${esc(error.message)}</div>`;
      return;
    }
    $("#nearWrap").innerHTML = rows.length
      ? `<div class="label" style="margin-top:10px">가까운 호차 <span class="mini">최대 3개</span></div>${rows.map((row) => `<div class="judgeCard"><b>${esc(normalizeVehicle(row.vehicle))}호</b> · ${formatDistance(row.distanceKm ?? row.distance)} · 주변 배송처 ${esc(row.nearbyCount ?? row.count ?? "-")}곳</div>`).join("")}`
      : `<div class="hint">주변 배송처가 없습니다.</div>`;
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
    if (code.includes(target)) return 2;
    if (name.startsWith(target) || name.includes(target)) return 3;
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
    const local = storeByVehicleAndCode.get(`${vehicle}|${code}`) || storesByCode.get(code) || {};
    return {
      ...local,
      ...row,
      customerCode: code || local.customerCode || "",
      customerName: row.customerName || row.name || local.customerName || "",
      address: row.address || row.customerAddress || local.address || "",
      vehicle: vehicle || local.vehicle || "",
      lat: numberOrNull(row.lat ?? row.latitude) ?? local.lat ?? null,
      lng: numberOrNull(row.lng ?? row.longitude) ?? local.lng ?? null,
      ownerPhone: row.ownerPhone || row.storePhone || row.customerPhone || local.ownerPhone || "",
      accessInfo: row.accessInfo || row.accessMemo || row.specialRemark || local.accessInfo || "",
      password: row.password || row.doorPassword || local.password || "",
      lastDeliveryDate: row.lastDeliveryDate || row.deliveryDate || local.lastDeliveryDate || ""
    };
  }

  async function search() {
    const text = $("#query").value.trim();
    if (!text) return;
    setSearchState("검색 중", true);
    $("#results").innerHTML = "";
    const requestId = ++state.searchRequestId;
    const localRows = rankSearchRows(allStores, text).slice(0, 20);
    if (localRows.length) {
      setSearchState(`${localRows.length}건 · 60일 캐시`);
      requestMapFit(); renderResults(localRows); renderStops(localRows, { boundaries: false }); selectStore(localRows[0]);
      return;
    }
    const candidates = [];
    const errors = [];
    try {
      candidates.push(...await fixedDispatchSearch(text));
    } catch (error) { if (!isSilentRequestError(error)) errors.push(`기존검색:${error.message}`); }
    try {
      const hub = await fetchJson(`/api/map-phase2b/preview/search?q=${encodeURIComponent(text)}`, { channel: "hub-search", ttl: 60000, timeout: 30000 });
      candidates.push(...(hub.data || []));
    } catch (error) { if (!isSilentRequestError(error)) errors.push(`Hub검색:${error.message}`); }
    if (requestId !== state.searchRequestId) return;
    const rows = rankSearchRows(candidates, text).slice(0, 20);
    if (!rows.length) {
      setSearchState(errors.length ? `조회 실패 · ${errors.join(" / ")}` : "결과 없음");
      return;
    }
    setSearchState(`${rows.length}건${errors.length ? " · 일부 API 오류" : ""}`);
    requestMapFit();
    renderResults(rows);
    renderStops(rows, { boundaries: false });
    selectStore(rows[0]);
  }

  function renderResults(rows) {
    $("#results").innerHTML = rows.map((row, index) => `<button class="resultItem ${index === 0 ? "selected" : ""}" data-result="${index}"><div class="resultName">${esc(row.customerCode)} · ${esc(row.customerName || "-")}</div><div class="resultMeta"><span class="chip">${esc(row.vehicle || "-")}호</span>${esc(row.address || "-")}</div></button>`).join("");
    $$("[data-result]").forEach((element) => {
      element.onclick = () => {
        const row = rows[Number(element.dataset.result)];
        requestMapFit();
        renderStops([row], { boundaries: false });
        selectStore(row);
      };
    });
  }

  async function searchExternalAddress(text) {
    if (!validNewAreaInput(text)) {
      setSearchState("주소 또는 고객정보를 정확히 입력하세요.");
      $("#searchNotice").textContent = "주소 또는 고객정보를 정확히 입력하세요.";
      $("#searchNotice").classList.add("show");
      return;
    }
    const requestId = ++state.addressRequestId;
    const local = rankSearchRows(allStores, text).slice(0, 20);
    if (local.length) {
      setSearchState(`${local.length}건 · 60일 캐시`); renderResults(local); requestMapFit(); renderStops(local, { boundaries: false }); selectStore(local[0]); return;
    }
    let existing = [];
    try {
      const response = await fetchJson(`/api/map-phase2b/preview/search?q=${encodeURIComponent(text)}`, { channel: "address-search", ttl: 60000, timeout: 30000 });
      existing = rankSearchRows(response.data || [], text).slice(0, 20);
    } catch (error) {
      if (isSilentRequestError(error)) return;
      $("#searchNotice").textContent = `등록 매장 조회 실패: ${error.message} · 주소 검색은 계속합니다.`;
      $("#searchNotice").classList.add("show");
    }
    if (requestId !== state.addressRequestId) return;
    if (existing.length) {
      setSearchState(`${existing.length}건`);
      renderResults(existing);
      requestMapFit();
      renderStops(existing, { boundaries: false });
      selectStore(existing[0]);
      return;
    }
    setSearchState("주소 확인 중", true);
    const point = await geocodeAddress(text);
    if (!point) {
      setSearchState("조회 결과 없음");
      return;
    }
    const virtual = { customerCode: "", customerName: point.placeName || "미등록 신규 주소", address: point.address || text, lat: point.lat, lng: point.lng, virtual: true };
    showVirtual(virtual);
    const judged = await judgeNewAreaPoint({ address: virtual.address, customer: virtual.customerName }, point);
    if (requestId === state.addressRequestId) renderAddressJudge(judged);
  }

  function geocodeAddress(address) {
    return new Promise((resolve) => {
      const keyword = String(address || "").trim();
      if (!keyword || !window.kakaoGeocoder) return resolve(null);
      window.kakaoGeocoder.addressSearch(keyword, (result, status) => {
        if (status === kakao.maps.services.Status.OK && result[0]) return resolve({ lat: Number(result[0].y), lng: Number(result[0].x), address: result[0].address_name });
        if (!window.kakaoPlaces) return resolve(null);
        window.kakaoPlaces.keywordSearch(keyword, (items, placeStatus) => {
          if (placeStatus === kakao.maps.services.Status.OK && items[0]) {
            resolve({ lat: Number(items[0].y), lng: Number(items[0].x), address: items[0].road_address_name || items[0].address_name, placeName: items[0].place_name });
            return;
          }
          const cleaned = keyword.replace(/\s*(apt|APT)\s*$/i, "").trim();
          if (!cleaned || cleaned === keyword) return resolve(null);
          window.kakaoPlaces.keywordSearch(cleaned, (retryItems, retryStatus) => {
            if (retryStatus !== kakao.maps.services.Status.OK || !retryItems[0]) return resolve(null);
            resolve({ lat: Number(retryItems[0].y), lng: Number(retryItems[0].x), address: retryItems[0].road_address_name || retryItems[0].address_name, placeName: retryItems[0].place_name });
          });
        });
      });
    });
  }

  function showVirtual(row) {
    setSearchState("미등록 주소");
    $("#searchNotice").textContent = "Customer에 저장하지 않는 세션 임시핀입니다.";
    $("#searchNotice").classList.add("show");
    $("#results").innerHTML = `<button class="resultItem selected"><div class="resultName">📍 ${esc(row.address)}</div><div class="resultMeta">임시핀 · 주변 배송처/근접호차 표시</div></button>`;
    requestMapFit();
    renderStops([row], { virtual: true, boundaries: false });
    selectStore(row);
    state.virtual = row;
  }

  function renderAddressJudge(row) {
    $("#addressJudgeResults").innerHTML = `<div class="judgeCard"><div class="judgeTop"><span class="judgeBadge ${row.decision === "O" ? "ok" : row.decision === "검토" ? "review" : "no"}">${esc(row.decision)}</span><b>${esc(row.customer || "신규 주소")}</b></div><div>권역판정: <b>${row.decision === "O" ? "가능" : esc(row.reason)}</b></div><div>배송요일: <b>${esc(row.deliveryDays || "")}</b></div><div>근접호차: <b>${esc(row.vehicle || "-")}호</b>${row.nearestDistance == null ? "" : ` · ${formatDistance(row.nearestDistance)}`}</div>${row.facility ? `<span class="facility">차량 진입 확인 필요</span>` : ""}</div>`;
  }

  function refreshVehicleUi(run) {
    const selected = selectedVehicles();
    $("#selectedVehicleCount").textContent = selected.length ? `${selected.length}대` : "전체";
    $("#vehicleModeLabel").textContent = selected.length === 1 ? "해당 호차 집중모드" : selected.length > 1 ? "선택 호차 권역 비교" : "최근 60일 전체 권역";
    $("#mapStatusTitle").textContent = selected.length === 1 ? `${selected[0]}호 최근 60일 권역` : selected.length > 1 ? `${selected.length}대 호차 권역 비교` : "최근 60일 전체 권역";
    $("#vehicleChips").className = selected.length ? "" : "vehiclePlaceholder";
    $("#vehicleChips").innerHTML = selected.length ? selected.slice(0, 4).map((vehicle) => `<span class="vehicleChip">${vehicle}호</span>`).join("") + (selected.length > 4 ? `<span class="vehicleChip">+${selected.length - 4}</span>` : "") : "전체 권역";
    if (run) { requestMapFit(); loadBaseMap(); }
  }

  async function loadBaseMap() {
    state.mode = "BASE_60D";
    const requestId = ++state.baseRequestId;
    const selected = selectedVehicles();
    $("#vehicleModeLabel").textContent = "조회중...";
    if (!state.areaOn) {
      clearMap(); state.currentRows = [];
      $("#mapStatusSub").textContent = "권역선 OFF · 빈 지도";
      $("#vehicleModeLabel").textContent = "완료";
      return;
    }
    const selectedSet = new Set(selected.map(String));
    let stores = state.centerFilter ? allStores.filter((row) => row.vehicleGroup === state.centerFilter)
      : selected.length ? allStores.filter((row) => selectedSet.has(String(row.vehicle))) : allStores.slice();
    if (requestId !== state.baseRequestId) return;
    const rows = selected.length === 1 ? stores : representativeRows(stores);
    if (!rows.length) {
      clearMap();
      state.currentRows = [];
      $("#mapStatusSub").textContent = "조회 결과 없음";
      $("#vehicleModeLabel").textContent = "완료"; return;
    }
    renderStops(rows, { vehicles: selected.length ? selected : state.centerFilter ? SOURCE.vehicles.filter((vehicle) => vehicle.group === state.centerFilter).map((vehicle) => String(vehicle.vehicle)) : [] });
    const latest = String(latestDateFromRows(stores) || latestDateFromRows(allStores) || inferLatestDate()).slice(0, 10);
    updateDateRange(latest);
    $("#mapStatusSub").textContent = `${formatShort(daysBefore(latest, 59))} ~ ${formatShort(latest)} 기준 · ${stores.length}개 매장`;
    const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(`${latest}T00:00:00+09:00`)) / 86400000));
    $("#freshnessState").textContent = `60일 스냅샷 · ${ageDays <= 1 ? "정상" : `지연 ${ageDays}일`}`;
    $("#vehicleModeLabel").textContent = "완료 · 스냅샷";
    if (selected.length === 1) refreshSelectedVehicle(selected[0], requestId);
  }

  async function refreshSelectedVehicle(vehicle, requestId) {
    try {
      const params = new URLSearchParams({ mode: "BASE_90D", vehicle, south: "33", west: "124", north: "39", east: "132" });
      const response = await fetchJson(`/api/map-phase2b/preview/bounds?${params}`, { channel: "base-vehicle", ttl: 300000, timeout: 35000 });
      if (requestId !== state.baseRequestId || selectedVehicles().join("|") !== vehicle || !state.areaOn) return;
      const rows = (response.data || []).map(normalizeApiStore);
      if (!rows.length) return;
      renderStops(rows, { vehicles: [vehicle] });
      const latest = String(response.meta?.dataAsOf || response.meta?.latestDate || latestDateFromRows(rows) || inferLatestDate()).slice(0, 10);
      updateDateRange(latest);
      $("#mapStatusSub").textContent = `${formatShort(daysBefore(latest, 59))} ~ ${formatShort(latest)} 기준 · ${rows.length}개 매장`;
      $("#freshnessState").textContent = "실데이터 갱신 완료 · 5분 캐시";
      $("#vehicleModeLabel").textContent = "완료";
    } catch (error) {
      if (isSilentRequestError(error) || requestId !== state.baseRequestId) return;
      $("#freshnessState").textContent = `실데이터 갱신 실패 · 스냅샷 유지`;
      $("#vehicleModeLabel").textContent = "실패 · 스냅샷 표시";
    }
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
    const configured = $("#latestDate")?.textContent?.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(configured)) return configured;
    const snapshot = String(SOURCE.last_new_store_import?.updatedAt || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(snapshot) ? snapshot : new Date().toISOString().slice(0, 10);
  }

  function latestDateFromRows(rows) {
    return rows.map((row) => String(row.lastDeliveryDate || row.deliveryDate || "").slice(0, 10))
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort().pop() || "";
  }

  function updateDateRange(latest) {
    const start = daysBefore(latest, 59);
    $("#latestDate").textContent = latest;
    $("#rangeText").textContent = `${formatShort(start)} ~ ${formatShort(latest)} 기준`;
    $("#date").max = latest;
    $("#mobileDate").max = latest;
  }

  async function loadRoute(source) {
    const date = source === "mobile" ? $("#mobileDate").value : $("#date").value;
    const vehicle = source === "mobile" ? $("#mobileVehicle").value : $("#vehicle").value;
    requestMapFit();
    setRouteLoading(source, "운행동선 조회 중...");
    const requestId = ++state.routeRequestId;
    let payload = null;
    try {
      const response = await fetchJson(`/api/map-phase2b/preview/route-plan?date=${encodeURIComponent(date)}&vehicle=${encodeURIComponent(vehicle)}`, { channel: "route-plan", ttl: 30000, timeout: 45000 });
      if (requestId !== state.routeRequestId) return;
      payload = response.data || null;
    } catch (error) {
      if (isSilentRequestError(error)) return;
      setRouteLoading(source, `조회 실패: ${error.message}`);
      return;
    }
    if (!payload?.stops?.length) {
      setRouteLoading(source, "조회 결과 없음");
      return;
    }
    const stops = dedupeRouteStops((payload.stops || []).map((stop) => normalizeRouteStop(stop, vehicle))).filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
    if (!stops.length) {
      setRouteLoading(source, "조회 결과 없음");
      return;
    }
    const completed = stops.filter((stop) => stop.status === "COMPLETED").length;
    payload = { ...payload, stops, totalStops: stops.length, completedStops: completed, remainingStops: stops.length - completed };
    state.mode = "DATE_ROUTE";
    state.routeRows = stops;
    renderStops(stops, { numbered: true, boundaries: false });
    drawRoute(stops);
    renderRouteSummary(payload, source);
    $("#mapStatusTitle").textContent = `${vehicle}호 특정일 운행`;
    $("#mapStatusSub").textContent = `${date} · 실제 운행동선`;
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
    const html = `<div class="routeMode"><span class="routeDot"></span>실제 운행동선</div><div class="routeSummary"><div class="routeMetric"><strong>${payload.totalStops || 0}</strong><small>총 착지</small></div><div class="routeMetric"><strong>${payload.completedStops || 0}</strong><small>완료</small></div><div class="routeMetric"><strong>${payload.remainingStops || 0}</strong><small>잔여</small></div></div><div class="resultMeta">초록 실선 = 실제 운행<br>주황 점선 = 잔여 예상 동선</div>`;
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
    state.mode = "BASE_60D";
    state.routeRows = [];
    document.body.classList.remove("routeSheetOpen");
    requestMapFit();
    loadBaseMap();
  }

  function syncBoundaryButtons() {
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
    state.areaOn = !state.areaOn;
    syncBoundaryButtons();
    requestMapFit();
    if (state.mode === "BASE_60D") loadBaseMap(); else rerenderCurrentMap();
  }

  function resetMapOverview() {
    setSelectedVehicles([]);
    $("#mobileBaseVehicle").value = "";
    $("#mobileCenter").value = "all";
    state.mode = "BASE_60D";
    state.routeRows = [];
    document.body.classList.remove("routeSheetOpen");
    clearSelection();
    refreshVehicleUi(false);
    requestMapFit();
    loadBaseMap();
  }

  function selectCenter(group) {
    state.centerFilter = group === "all" ? "" : group;
    const values = group === "all" ? [] : SOURCE.vehicles.filter((vehicle) => vehicle.group === group).map((vehicle) => String(vehicle.vehicle));
    setSelectedVehicles(values);
    $$(".vehicleItem").forEach((item) => { item.style.display = group === "all" || item.dataset.group === group ? "flex" : "none"; });
    $("#mobileBaseVehicle").value = "";
    refreshVehicleUi(true);
  }

  function nearestStores(point, limit = 8) {
    return allStores.map((row) => ({ ...row, distance: distanceKm(point, row) })).filter((row) => Number.isFinite(row.distance)).sort((a, b) => a.distance - b.distance).slice(0, limit);
  }

  function withinRadius(point, radiusKm) {
    return allStores.map((row) => ({ ...row, distance: distanceKm(point, row) })).filter((row) => Number.isFinite(row.distance) && row.distance <= radiusKm).sort((a, b) => a.distance - b.distance);
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
    if (/제주/.test(value)) return "제주도";
    if (apartmentUnitReason(value)) return "아파트";
    if (/부산|대구|울산|경남|경북|영남/.test(value)) return "영남권";
    if (/광주|전남|전북|호남/.test(value)) return "호남권";
    if (/동선외|배송동선\s*맞지/.test(value)) return "배송동선 맞지않음";
    return "";
  }

  function parseNewArea(inputId) {
    const starters = /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충청북도|충남|충청남도|전북|전라북도|전남|전라남도|경북|경상북도|경남|경상남도|제주|S\d+|B\d+)/;
    const merged = [];
    $(inputId).value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
      if (merged.length && !starters.test(line) && !line.includes("\t")) merged[merged.length - 1] += ` ${line}`;
      else merged.push(line);
    });
    return merged.map((line) => {
      const cells = line.includes("\t") ? line.split(/\t/).map((value) => value.trim()) : line.split(/\s{2,}/).map((value) => value.trim());
      return { address: cells[0] || line, customer: cells.slice(1).join(" ") };
    });
  }

  function validNewAreaInput(value) {
    const text = String(value || "").trim();
    if (/^[SB]\d{3,}$/i.test(text)) return true;
    if (text.length < 5) return false;
    return /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|충북|충남|전라|전북|전남|경상|경북|경남|제주|(?:로|길|동|읍|면)\s*\d|\d{1,4}[-번길로동읍면가])/i.test(text);
  }

  async function judgeNewAreaRow(row) {
    if (!validNewAreaInput(row.address) && !validNewAreaInput(row.customer)) return { ...row, decision: "X", reason: "주소 또는 고객정보를 정확히 입력하세요.", deliveryDays: "", facility: false, nearby: [] };
    const point = await geocodeAddress(row.address);
    return judgeNewAreaPoint(row, point);
  }

  function judgeNewAreaPoint(row, point) {
    const exception = legacyException(`${row.address} ${row.customer}`);
    if (!point) return { ...row, decision: "X", reason: exception || "주소 좌표 확인 불가", deliveryDays: "", facility: facilityReview(`${row.address} ${row.customer}`), nearby: [] };
    const nearby = withinRadius(point, .5);
    const nearest = nearby.length ? nearby : nearestStores(point, 6);
    const distance = nearest[0]?.distance ?? null;
    let decision = "X";
    let reason = "배송동선 맞지않음";
    if (!exception && nearby.length) { decision = "O"; reason = ""; }
    else if (!exception && distance !== null && distance <= 1) { decision = "O"; reason = ""; }
    else if (!exception && distance !== null && distance <= 2.5) { decision = "검토"; reason = "주변 데이터 부족"; }
    if (exception) reason = exception;
    return { ...row, ...point, decision, reason, deliveryDays: combineNearbyPatterns(nearest), facility: facilityReview(`${row.address} ${row.customer}`), nearby: nearest, vehicle: nearest[0]?.vehicle || "-", nearestDistance: distance };
  }

  async function runNewArea(inputId, statusId, resultId) {
    const rows = parseNewArea(inputId);
    if (!rows.length) { $(statusId).textContent = "주소를 입력해주세요."; return; }
    $(statusId).textContent = `${rows.length}건 판단 중...`;
    const judged = [];
    for (const row of rows) judged.push(await judgeNewAreaRow(row));
    state.newAreaResults = judged;
    $(statusId).textContent = `${judged.length}건 판단 완료`;
    $(resultId).innerHTML = judged.map((row) => `<div class="judgeCard"><div class="judgeTop"><span class="judgeBadge ${row.decision === "O" ? "ok" : row.decision === "검토" ? "review" : "no"}">${esc(row.decision)}</span><b>${esc(row.customer)}</b></div><div>${esc(row.address)}</div><div>권역판정: <b>${row.decision === "O" ? "가능" : esc(row.reason)}</b></div><div>배송요일: <b>${esc(row.deliveryDays || "")}</b>${row.deliveryDays ? "" : " <span class=\"mini\">(기존 규칙 공란)</span>"}</div><div>근접호차: <b>${esc(row.vehicle)}호</b>${row.nearestDistance == null ? "" : ` · ${formatDistance(row.nearestDistance)}`}</div>${row.facility ? `<span class="facility">차량 진입 확인 필요</span>` : ""}</div>`).join("");
  }

  function distanceKm(a, b) {
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
  function isSilentRequestError(error) { return Boolean(error?.silent || error?.name === "AbortError"); }
  async function fetchJson(url, options = {}) {
    const { channel = new URL(url, location.href).pathname, timeout = 30000, ttl = 0 } = options;
    const cached = memoryResponses.get(url);
    if (ttl && cached?.expiresAt > Date.now()) return cached.value;
    const previous = requestControllers.get(channel);
    if (previous) previous.controller.abort("superseded");
    const controller = new AbortController();
    const token = Symbol(channel);
    requestControllers.set(channel, { controller, token });
    const timer = setTimeout(() => controller.abort("timeout"), timeout);
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      const json = await response.json().catch(() => ({}));
      if (requestControllers.get(channel)?.token !== token) { const stale = new Error("STALE_RESPONSE"); stale.silent = true; throw stale; }
      if (!response.ok || json.error) throw new Error(json.error || `HTTP_${response.status}`);
      if (ttl) memoryResponses.set(url, { value: json, expiresAt: Date.now() + ttl });
      return json;
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) {
        const aborted = new Error(controller.signal.reason === "timeout" ? "요청 시간이 초과되었습니다. 잠시 후 다시 시도해주세요." : "REQUEST_CANCELLED");
        aborted.silent = controller.signal.reason !== "timeout";
        throw aborted;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (requestControllers.get(channel)?.token === token) requestControllers.delete(channel);
    }
  }
  function showMobileMap() {
    if (innerWidth > 760) return;
    document.body.classList.add("mobileMap");
    setTimeout(() => {
      state.map?.relayout?.();
      requestMapFit();
      rerenderCurrentMap();
    }, 60);
  }
  function hideMobileMap() { document.body.classList.remove("mobileMap", "routeSheetOpen"); }

  async function loadTodayStatus() {
    const stateElement = $("#todayStatusState");
    stateElement.textContent = "당일 현황 조회 중...";
    const requestId = ++state.todayRequestId;
    try {
      const payload = await fetchJson(`/api/map-phase2b/preview/today-status?date=${encodeURIComponent(localDate())}`, { channel: "today-all", ttl: 30000, timeout: 45000 });
      if (requestId !== state.todayRequestId) return;
      const rows = payload.data?.vehicles || [];
      stateElement.textContent = `${payload.data?.date || localDate()} · ${rows.length}대`;
      $("#todayStatusList").innerHTML = rows.length ? rows.map((row, index) => `<button class="resultItem" data-today="${index}"><div class="resultName">${esc(row.vehicle)}호 · ${esc(row.status)}</div><div class="resultMeta">${row.completedStops}/${row.totalStops} · ${row.progressPercent}%${row.estimatedEndAt ? ` · 예상 ${formatTime(row.estimatedEndAt)}` : ""}</div></button>`).join("") : `<div class="hint">당일 운행 데이터가 없습니다.</div>`;
      $$('[data-today]').forEach((button) => button.onclick = () => {
        const row = rows[Number(button.dataset.today)];
        setSelectedVehicles([normalizeVehicle(row.vehicle)]); refreshVehicleUi(true);
        renderVehiclePanel(normalizeVehicle(row.vehicle), row, { storeCount: row.totalStops });
      });
    } catch (error) {
      if (isSilentRequestError(error)) return;
      stateElement.textContent = `당일 현황 조회 실패 · ${error.message}`;
    }
  }

  function exportNewArea(format) {
    if (!state.newAreaResults.length) { $("#newAreaBatchStatus").textContent = "먼저 일괄 판단을 실행해주세요."; return; }
    const rows = state.newAreaResults.map((row) => ({ 고객: row.customer, 주소: row.address, 권역판정: row.decision === "O" ? "가능" : row.reason, 배송요일: row.deliveryDays || "", 근접호차: row.vehicle || "", 거리: row.nearestDistance == null ? "" : formatDistance(row.nearestDistance), 시설확인: row.facility ? "차량 진입 확인 필요" : "" }));
    if (format === "xlsx" && window.XLSX) {
      const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), "신규권역판정"); XLSX.writeFile(book, "신규권역판정.xlsx"); return;
    }
    const columns = Object.keys(rows[0]);
    const csv = [columns, ...rows.map((row) => columns.map((column) => row[column]))].map((line) => line.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" })); link.download = "신규권역판정.csv"; link.click(); URL.revokeObjectURL(link.href);
  }

  function bindEvents() {
    $("#vehicleTrigger").onclick = () => $("#vehicleSelect").classList.toggle("open");
    document.addEventListener("click", (event) => { if (!$("#vehicleSelect").contains(event.target)) $("#vehicleSelect").classList.remove("open"); });
    $("#vehicleQuery").oninput = (event) => { const value = event.target.value.replace(/\D/g, ""); $$(".vehicleItem").forEach((item) => { item.style.display = !value || item.querySelector("input").value.includes(value) ? "flex" : "none"; }); };
    $("#vehicleQuery").onkeydown = (event) => {
      if (event.key !== "Enter") return;
      const first = $$(".vehicleItem").find((item) => item.style.display !== "none");
      if (!first) return;
      setSelectedVehicles([first.querySelector("input").value]); state.centerFilter = ""; $("#vehicleSelect").classList.remove("open"); refreshVehicleUi(true);
    };
    $("#selectAllVehicles").onclick = () => { state.centerFilter = ""; vehicleChecks().forEach((item) => { if (item.closest("label").style.display !== "none") item.checked = true; }); refreshVehicleUi(true); };
    $("#clearVehicles").onclick = () => { state.centerFilter = ""; vehicleChecks().forEach((item) => { item.checked = false; }); refreshVehicleUi(true); };
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
    $("#todayBtn").onclick = () => { $("#date").value = inferLatestDate(); };
    $("#routePlan").onclick = () => loadRoute("pc");
    $("#endRoute").onclick = endRoute;
    $("#areaToggle").onclick = toggleBoundaries;
    $("#mapReset").onclick = resetMapOverview;
    $("#mobileAreaToggle").onclick = toggleBoundaries;
    $("#mobileMapReset").onclick = resetMapOverview;
    $("#mobileCenter").onchange = (event) => selectCenter(event.target.value);
    $("#mobileBaseVehicle").onchange = (event) => { state.centerFilter = ""; setSelectedVehicles(event.target.value ? [event.target.value] : []); $("#mobileCenter").value = "all"; refreshVehicleUi(true); };
    $("#judgeNewAreaBatch").onclick = () => runNewArea("#newAreaBatchInput", "#newAreaBatchStatus", "#newAreaBatchResults");
    $("#clearNewAreaBatch").onclick = () => { $("#newAreaBatchInput").value = ""; $("#newAreaBatchResults").innerHTML = ""; };
    $("#exportNewAreaCsv").onclick = () => exportNewArea("csv");
    $("#exportNewAreaExcel").onclick = () => exportNewArea("xlsx");
    $("#todayStatusTool")?.addEventListener("toggle", (event) => { if (event.target.open) loadTodayStatus(); });
    $("#mobileBack").onclick = hideMobileMap;
    $("#closeMobileRoute").onclick = () => document.body.classList.remove("routeSheetOpen");
    $("#mobileToday").onclick = () => { $("#mobileDate").value = inferLatestDate(); };
    $("#mobileRoutePlan").onclick = () => loadRoute("mobile");
    $("#openWms").onclick = () => { location.href = "/daily-routes.html?tab=wms"; };
    $("#openOperations").onclick = () => { location.href = "/operations-data.html"; };
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") clearSelection(); });
  }

  initVehicles();
  bindEvents();
  syncBoundaryButtons();
  refreshVehicleUi(false);
  initMap();
})();
