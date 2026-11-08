import { createCoverageMap } from './shadow-coverage-map.mjs?v=20261109-shadow-reentry';

const API = '/api/map-phase2b/private/shadow-coverage';
const STATUS = { DELIVERED: '관측 배송 이력', CANDIDATE: '관측기간 미배송 후보', EMPTY: '검증 범위 내 공백', UNKNOWN: '자료 부족' };
const LIST_TITLES = { candidate: STATUS.CANDIDATE, delivery: '배송 이력 격자', review: '자료 부족 격자' };
const fmt = value => Number(value || 0).toLocaleString('ko-KR');
const VIEW_TAG = /^"coverage-[a-f0-9]{64}"$/;
const time = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const visitLabel = record => record.status === 'UNKNOWN' ? '미확인' : fmt(record.visits) + '건';

function statusBadge(status) {
  const badge = element('span', 'coverage-badge', STATUS[status] || STATUS.UNKNOWN);
  badge.dataset.status = status;
  return badge;
}

function setDateList(parent, title, dates) {
  if (!dates.length) return;
  const heading = element('strong', '', title + ' ' + dates.length + '일');
  parent.append(heading, element('p', '', dates.join(' · ')));
}

export function createCoveragePanel({ workspace, header }) {
  const root = document.createElement('main');
  root.id = 'shadowCoverage';
  root.className = 'shadow-coverage';
  root.hidden = true;
  root.setAttribute('aria-labelledby', 'coverageTitle');
  root.innerHTML = `
    <aside id="coverageSidebar" class="coverage-sidebar" aria-label="음영권역 분석">
      <div class="coverage-heading">
        <h1 id="coverageTitle">음영권역 분석</h1>
        <button type="button" id="coveragePanelToggle" aria-controls="coverageAnalysis" aria-expanded="true">분석 접기</button>
      </div>
      <form class="coverage-search" id="coverageSearch">
        <label for="coverageQuery">주소·고객코드·매장 검색</label>
        <div class="coverage-search-row">
          <input id="coverageQuery" type="search" placeholder="도로명·지번 주소, 고객코드, 매장명" maxlength="200" required autocomplete="off">
          <button type="submit" class="coverage-primary" disabled>검색</button>
        </div>
      </form>
      <div id="coverageSearchResults" class="coverage-results" aria-live="polite"></div>
      <div id="coverageAnalysis">
        <div class="coverage-filters">
          <label>자료 기간 <select id="coverageDays"><option value="30">30일</option><option value="60">60일</option><option value="90" selected>90일</option></select></label>
          <label>담당 센터 <select id="coverageCenter"><option value="all">전체</option><option value="osan">오산</option><option value="yeongnam">영남</option><option value="honam">호남</option></select></label>
          <label>검색 반경 <select id="coverageRadius"><option value="0">격자만</option><option value="500">500m</option><option value="1000">1km</option></select></label>
        </div>
        <div class="coverage-overview" aria-label="분석 핵심 현황">
          <p id="coverageBasis">분석 기준일을 확인하고 있습니다.</p>
          <p id="coverageObserved" aria-live="polite"></p>
          <h2 id="coverageNationalTitle">전국 집계</h2>
          <dl class="coverage-kpis">
            <div><dt>등록 매장</dt><dd data-metric="registered">—</dd></div>
            <div><dt>좌표 확인 매장</dt><dd data-metric="located">—</dd></div>
            <div><dt>미배송 후보 격자</dt><dd data-metric="candidates">—</dd></div>
            <div><dt>후보 격자 내 매장</dt><dd data-metric="candidateStores">—</dd></div>
            <div><dt>배송 이력 격자</dt><dd data-metric="delivered">—</dd></div>
            <div><dt>자료 부족 격자</dt><dd data-metric="review">—</dd></div>
          </dl>
          <p id="coveragePreserved"></p>
          <p id="coverageGaps"></p>
          <p id="coverageViewport"></p>
        </div>
        <div class="coverage-legend" aria-label="배송 격자 범례">
          <span data-tone="delivery">관측 배송 이력</span><span data-tone="candidate">관측기간 미배송 후보</span>
          <span data-tone="unknown">자료 부족</span><span data-tone="empty">검증 범위 내 공백</span>
        </div>
        <p class="coverage-note">관측기간 후보 · 주변 호차는 배송 이력 참고</p>
        <p id="coverageStatus" role="status" aria-live="polite"></p>
        <div class="coverage-detail" id="coverageDetail" aria-label="선택 격자 상세" hidden></div>
        <div class="coverage-list" aria-labelledby="coverageListTitle">
          <div class="coverage-list-head">
            <h2 id="coverageListTitle">관측기간 미배송 후보</h2>
            <select id="coverageListFilter" aria-label="격자 목록 필터">
              <option value="candidate">미배송 후보</option><option value="delivery">배송 있음</option><option value="review">자료 부족</option>
            </select>
          </div>
          <p class="coverage-note">전국 H3 R8 · 등록 매장 많은 순</p>
          <div id="coverageCellList" aria-live="polite"></div>
          <div class="coverage-list-pages">
            <button type="button" id="coverageListPrevious" hidden>이전</button>
            <button type="button" id="coverageListMore" hidden>다음</button>
          </div>
        </div>
        <details class="coverage-evidence" id="coverageEvidence">
          <summary id="coverageEvidenceTitle">집계 근거와 날짜</summary>
          <div id="coverageEvidenceBody"></div>
          <button type="button" id="coverageRefresh">다시 읽기</button>
        </details>
      </div>
    </aside>
    <section class="coverage-map-area" aria-label="배송 관측 격자 지도">
      <div id="coverageMap"></div>
      <div id="coverageMapState" class="coverage-map-state" hidden>
        <p id="coverageMapMessage" role="status" aria-live="polite"></p>
        <button type="button" id="coverageRetry" hidden>다시 시도</button>
      </div>
    </section>`;
  workspace.after(root);
  const find = id => root.querySelector('#' + id);
  const sidebar = find('coverageSidebar');
  const host = find('coverageMap');
  const searchButton = find('coverageSearch').querySelector('button');
  const panelToggle = find('coveragePanelToggle');
  const retryButton = find('coverageRetry');
  const status = find('coverageStatus');
  const detail = find('coverageDetail');
  const searchResults = find('coverageSearchResults');
  const cellList = find('coverageCellList');
  const evidence = find('coverageEvidenceBody');
  const requests = new Map();
  let map, baseMap, active = false, mapOwner = 0, timer, view = null, selected = null, pendingView = null;
  let days = 90, center = 'all', loadedCenter = 'all', lastKey = '', failedKey = '';
  let viewTag = '', viewSession = null, openedAt = 0;
  let list = null, listKey = '', listOffset = 0, searchOwner, addressProxy;
  const resize = new ResizeObserver(entries => {
    if (!active) return;
    if (entries.some(entry => entry.target === header)) fitWorkspace();
    if (map && entries.some(entry => entry.target === host)) {
      baseMap.relayout();
      scheduleView();
    }
  });

  function fitWorkspace() {
    root.style.setProperty('--coverage-header-height', header.getBoundingClientRect().height + 'px');
  }

  function collapsePanel(collapsed) {
    root.classList.toggle('coverage-panel-collapsed', collapsed);
    panelToggle.setAttribute('aria-expanded', String(!collapsed));
    panelToggle.textContent = collapsed ? '분석 펼치기' : '분석 접기';
  }

  function showMapState(message, retry) {
    find('coverageMapMessage').textContent = message;
    retryButton.hidden = !retry;
    retryButton.onclick = retry || null;
    find('coverageMapState').hidden = !message;
  }

  async function startMap(retryFailed = false) {
    const owner = ++mapOwner;
    const reopening = Boolean(map);
    try {
      if (!map) {
        showMapState('음영권역 지도를 불러오고 있습니다.');
        const { maps } = await window.KakaoMapsAdapter.ready({ retryFailed });
        if (!active || owner !== mapOwner) return;
        baseMap ||= new maps.Map(host, { center: new maps.LatLng(36.8, 127.2), level: 11 });
        map = createCoverageMap(baseMap, maps, { idle: scheduleView, select: id => void selectCell(id), enabled: () => active });
      }
      baseMap.relayout();
      searchButton.disabled = false;
      await loadView(false, reopening);
    } catch {
      if (active && owner === mapOwner) {
        showMapState('지도를 불러오지 못했습니다.', () => void startMap(true));
      }
    }
  }

  function filters() {
    find('coverageDays').value = String(days);
    find('coverageCenter').value = center;
  }

  function abort(name) {
    requests.get(name)?.abort();
    requests.delete(name);
  }

  async function read(name, path, params, headers) {
    abort(name);
    const controller = new AbortController();
    // Only the first analysis view may still be waiting for the boot restore.
    const timeout = setTimeout(() => controller.abort(), name === 'view' && !view ? 25000 : 10000);
    requests.set(name, controller);
    try {
      const url = API + path + '?' + new URLSearchParams(params);
      const started = performance.now();
      const response = await fetch(url, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers
      });
      if (!response.ok) throw Object.assign(Error('COVERAGE_REQUEST_FAILED'), { status: response.status });
      const payload = await response.json();
      if (!active || requests.get(name) !== controller) return null;
      const unchanged = name === 'view' && payload?.unchanged === true;
      if (payload?.ok !== true || (!unchanged && !payload.data)) throw Error('COVERAGE_RESPONSE_INVALID');
      if (name !== 'view') return payload.data;
      const timing = Object.fromEntries((response.headers.get('server-timing') || '').split(',').map(item => item.trim().split(';dur=')));
      return { data: payload?.data, tag: response.headers.get('etag'), unchanged, requestMs: performance.now() - started,
        serverMs: Number(timing.total) || null, sessionMs: Number(timing.session) || null, analysisMs: Number(timing.coverage) || null };
    } catch (error) {
      if (!active || requests.get(name) !== controller) return null;
      throw error;
    } finally {
      clearTimeout(timeout);
      if (requests.get(name) === controller) requests.delete(name);
    }
  }

  function distanceLabel(meters) {
    return meters < 1000 ? fmt(meters) + 'm' : (meters / 1000).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + 'km';
  }

  function nearbyLabels(nearby, compact = false) {
    if (!nearby?.nearest) return ['주변 관측 배송 격자 없음', '주변 배송 이력 호차 미확인'];
    const location = compact ? '' : nearby.nearest.label + ' · ';
    const label = '인접 배송 ' + fmt(nearby.adjacentCount) + '격자 · 최근접 ' + location +
      '중심 직선 ' + distanceLabel(nearby.nearest.distanceMeters);
    const vehicles = nearby.vehicles.map(vehicle => vehicle + '호').join(' · ');
    const remaining = nearby.vehicleCount - nearby.vehicles.length;
    return [label, vehicles ? (nearby.vehicleScope === 'adjacent' ? '인접' : '최근접') + ' 배송 이력 ' + vehicles +
      (remaining ? ' 외 ' + fmt(remaining) + '대' : '') : '주변 배송 이력 호차 미확인'];
  }

  function renderList() {
    const filter = find('coverageListFilter').value;
    find('coverageListTitle').textContent = LIST_TITLES[filter];
    cellList.replaceChildren();
    for (const cell of list?.rows || []) {
      const row = element('button', 'coverage-list-row');
      row.type = 'button';
      row.dataset.cellId = cell.id;
      row.setAttribute('aria-pressed', String(selected?.id === cell.id));
      row.append(element('strong', '', cell.label),
        element('small', '', '등록 ' + fmt(cell.registered) + '곳 · 관측 방문 ' + visitLabel(cell)),
        ...nearbyLabels(cell.nearby, true).map(label => element('small', '', label)));
      row.onclick = () => {
        map.focus(cell.location);
        void selectCell(cell.id);
      };
      cellList.append(row);
    }
    if (!list?.rows.length) cellList.append(element('p', 'coverage-empty', list
      ? '이 범위에서 해당 격자가 확인되지 않았습니다.' : '격자 목록을 불러오고 있습니다.'));
    find('coverageListPrevious').hidden = !list || !listOffset;
    find('coverageListMore').hidden = list?.next == null;
  }

  async function loadList(offset = 0) {
    if (!active || !view || view.period.days !== days || loadedCenter !== center) return;
    const filter = find('coverageListFilter').value;
    abort('list');
    if (!offset && filter === 'candidate') {
      list = view.candidateList;
      listOffset = 0;
      renderList();
      return;
    }
    const owner = listKey;
    try {
      const result = await read('list', '/list', { days, center, generation: view.generation, filter, offset });
      if (!result || owner !== listKey || filter !== find('coverageListFilter').value) return;
      list = result;
      listOffset = offset;
      renderList();
    } catch (error) {
      if (!active || owner !== listKey) return;
      cellList.replaceChildren(element('p', 'coverage-empty', '격자 목록을 불러오지 못했습니다.'));
      if (error.status === 409) void loadView(true);
    }
  }

  function updateList(data) {
    const key = [data.generation, data.period.days, loadedCenter].join(':');
    if (listKey === key) return;
    listKey = key;
    list = null;
    listOffset = 0;
    renderList();
    void loadList();
  }

  function paint() {
    if (map) map.render(view?.cells || [], selected);
  }

  function renderView(data) {
    const { period, completeness, summary } = data;
    const { viewportSummary, preservedMap } = data;
    const confirmed = completeness.recordedDays;
    const sourceText = confirmed == null ? '센터별 일자 집계 미확인' :
      '기록 확인 ' + confirmed + '/' + period.days + '일 · 미확인 ' + completeness.missingDates.length + '일';
    find('coverageBasis').textContent = '분석 ' + period.days + '일 · 기준 ' + period.end;
    find('coverageObserved').textContent = sourceText;
    const selectedCenter = find('coverageCenter').selectedOptions[0]?.textContent;
    find('coverageNationalTitle').textContent = (loadedCenter === 'all' ? '전국 집계' : '전국 · ' + selectedCenter + ' 센터') +
      ' · H3 R' + data.summaryResolution;
    for (const stat of root.querySelectorAll('[data-metric]')) stat.textContent = fmt(summary[stat.dataset.metric]);
    find('coveragePreserved').textContent = preservedMap
      ? '보존 지도 ' + fmt(preservedMap.count) + '곳' + (preservedMap.asOf ? ' (' + preservedMap.asOf + ')' : '') + ' · 별도 범위'
      : '보존 지도 미확인 · 별도 범위';
    find('coverageGaps').textContent = '좌표 미확인 ' + fmt(summary.missingStoreLocation) + '곳 · 배송 위치 미연결 ' +
      fmt(summary.unplacedVisits) + '건 · 원천 식별 미확인 ' + fmt(summary.unidentifiedVisits) + '건';
    find('coverageViewport').textContent = '현재 지도 R' + data.resolution + ' · 배송 ' + fmt(viewportSummary.delivered) +
      ' · 후보 ' + fmt(viewportSummary.candidates) + ' · 자료 부족 ' + fmt(viewportSummary.review) +
      ' · 공백 ' + fmt(viewportSummary.empty) + '격자';
    evidence.replaceChildren(
      element('p', '', period.start + ' ~ ' + period.end + ' · 마지막 확인 ' + (period.latest || '미확인')),
      element('p', '', '집계 갱신 ' + time.format(new Date(data.refreshedAt)) + ' · 원천 확인 ' + time.format(new Date(data.sourceObservedAt))),
      element('p', '', '등록 매장 ' + fmt(summary.registered) + '곳 · 위치 미확인 ' + fmt(summary.missingStoreLocation) + '곳'),
      element('p', '', '배송 완료 ' + fmt(completeness.recordedVisits) + '건 · 격자 연결 ' + fmt(summary.visits) + '건 · 위치 미연결 ' + fmt(summary.unplacedVisits) + '건'),
      element('p', '', '현재 지도 ' + fmt(viewportSummary.total) + '격자 · 표시 ' + fmt(data.cells.length) + '격자')
    );
    const centers = [['osan', '오산'], ['yeongnam', '영남'], ['honam', '호남']];
    evidence.append(element('p', '', centers.map(([key, label]) =>
      label + ' ' + (completeness.recordedCenters[key] ? fmt(completeness.recordedCenters[key]) + '건' : '기록 미확인')).join(' · ')));
    setDateList(evidence, '기록 미확인', completeness.missingDates);
    setDateList(evidence, '원천 완전성 미확인', completeness.unverifiedDates);
    if (!completeness.scopedCells) evidence.append(element('p', '', '이 격자 크기의 검증된 분석 범위가 확인되지 않았습니다.'));
    if (data.stale) {
      status.textContent = '마지막 정상 집계를 표시 중입니다 · ' + time.format(new Date(data.refreshedAt));
    } else if (!completeness.recordedVisits && center !== 'all' && !completeness.dateComplete) {
      status.textContent = '선택 센터의 배송 자료가 확인되지 않았습니다.';
    } else {
      status.textContent = data.truncated ? '지도를 확대하면 나머지 격자를 확인할 수 있습니다.' : '';
    }
    updateList(data);
    paint();
  }

  function currentSession() {
    const session = window.MapStaffEntry?.session();
    return session?.authenticated && Date.now() < Math.min(session.expiresAt, session.idleExpiresAt) ? session.expiresAt : null;
  }

  function recordPaint(mode, started, query) {
    const owner = mapOwner;
    const painted = view;
    requestAnimationFrame(() => {
      if (!active || owner !== mapOwner || view !== painted) return;
      const now = performance.now();
      const requestMs = query?.requestMs || 0;
      root.dataset.viewMetrics = JSON.stringify({ mode, displayMs: Math.round(now - openedAt),
        setupMs: Math.round(Math.max(0, started - openedAt - requestMs)), requestMs: Math.round(requestMs),
        serverMs: query?.serverMs ?? null, sessionMs: query?.sessionMs ?? null, analysisMs: query?.analysisMs ?? null,
        transferMs: query?.serverMs ? Math.round(Math.max(0, requestMs - query.serverMs)) : null,
        renderMs: Math.round(now - started) });
    });
  }

  async function loadView(force = false, reopening = false) {
    if (!active || !map) return;
    const viewport = map.viewport();
    const box = viewport.box.map(value => value.toFixed(5)).join(',');
    const key = [days, center, viewport.level, box].join(':');
    if (key === pendingView?.key) return;
    if (!force && !reopening && (key === lastKey || key === failedKey)) {
      abort('view');
      pendingView = null;
      return;
    }
    const request = pendingView = { key };
    const wantedCenter = center;
    const tag = reopening && key === lastKey && viewSession !== null && viewSession === currentSession() ? viewTag : '';
    if (tag) recordPaint('cached', performance.now());
    else if (reopening && view) resetView();
    if (!view) showMapState('분석 격자를 불러오고 있습니다.');
    try {
      const result = await read('view', '/view', { days, center, box, level: viewport.level }, tag ? { 'X-Coverage-View-Tag': tag } : undefined);
      if (!result || pendingView !== request) return;
      if (result.unchanged) {
        if (!tag || result.tag !== tag || viewSession !== currentSession()) throw Error('COVERAGE_REVALIDATION_INVALID');
        root.dataset.viewValidation = 'unchanged';
        return;
      }
      const data = result.data;
      if (!Array.isArray(data.cells) || data.cells.length > 360) throw Error('COVERAGE_VIEW_INVALID');
      const started = performance.now();
      if (view && (view.generation !== data.generation || view.period.days !== data.period.days || loadedCenter !== wantedCenter)) {
        clearSelection();
        if (view.generation !== data.generation) clearSearch();
      }
      view = data;
      viewTag = VIEW_TAG.test(result.tag) ? result.tag : '';
      viewSession = currentSession();
      loadedCenter = wantedCenter;
      lastKey = key;
      failedKey = '';
      renderView(view);
      showMapState('');
      if (!root.dataset.viewMetrics || tag) recordPaint('fresh', started, result);
      if (tag) root.dataset.viewValidation = 'updated';
    } catch (error) {
      if (!active || pendingView !== request) return;
      if (tag || error.status === 401 || error.status === 403) resetView();
      failedKey = key;
      if (view) {
        days = view.period.days;
        center = loadedCenter;
        filters();
        updateList(view);
        status.textContent = '조회에 실패했습니다. 마지막 정상 집계를 표시합니다 · ' + time.format(new Date(view.refreshedAt));
      } else {
        showMapState('분석 격자를 불러오지 못했습니다.', () => void loadView(true));
      }
    } finally {
      if (pendingView === request) pendingView = null;
    }
  }

  function scheduleView() {
    clearTimeout(timer);
    if (active) timer = setTimeout(() => void loadView(), 140);
  }

  function clearSelection() {
    abort('detail');
    selected = null;
    detail.hidden = true;
    detail.replaceChildren();
    paint();
  }

  function renderDetail(cell, offset) {
    const header = element('div', 'coverage-detail-head');
    header.append(statusBadge(cell.status));
    const close = element('button', '', '닫기');
    close.type = 'button';
    close.onclick = clearSelection;
    header.append(close);
    const fields = element('dl', 'coverage-detail-metrics');
    const { administrative, evidence: dates, deliveryDays } = cell;
    const [nearby, vehicles] = nearbyLabels(cell.nearby);
    const facts = [
      ['시·군·구(대표)', administrative.district || '미확인'], ['읍·면·동(대표)', administrative.locality || '미확인'],
      ['등록 매장', fmt(cell.registered) + '곳'], ['관측기간 방문', visitLabel(cell)],
      ['관측 배송일', deliveryDays == null || cell.status === 'UNKNOWN' ? '날짜별 집계 미확인' : fmt(deliveryDays) + '일'],
      ['마지막 배송일', cell.lastDelivery || '확인된 기록 없음'],
      ['확인·누락', dates.recordedDays == null ? '센터별 일자 미확인' :
        fmt(dates.recordedDays) + '/' + fmt(dates.totalDays) + '일 확인 · ' + fmt(dates.missingDates.length) + '일 미확인'],
      ['자료 기간', view.period.start + ' ~ ' + view.period.end]
    ];
    for (const [label, value] of facts) {
      fields.append(element('dt', '', label), element('dd', '', value));
    }
    detail.replaceChildren(header, element('h2', '', cell.label), element('p', 'coverage-cell-id', cell.id));
    if (cell.address) detail.append(element('p', 'coverage-address', cell.address));
    detail.append(fields, element('h3', '', '이 격자의 배송 이력 호차'),
      element('p', 'coverage-vehicle-list', cell.vehicles.length ? cell.vehicles.map(vehicle => vehicle + '호').join(' · ') : '확인된 호차 없음'),
      element('h3', '', '가까운 배송 격자'),
      element('p', 'coverage-nearby', nearby + (cell.nearby.nearest ? ' · 도로거리 아님' : '')),
      element('p', 'coverage-nearby-id', cell.nearby.nearest ? '최근접 H3 ' + cell.nearby.nearest.id : ''),
      element('p', '', vehicles),
      element('h3', '', '고객코드 · 매장'));
    const list = element('ul', 'coverage-stores');
    for (const store of cell.stores) {
      const row = element('li');
      row.append(element('strong', '', store.name), element('small', '', store.code + (store.registered ? ' · 등록' : ' · 배송 이력') +
        (store.vehicles.length ? ' · ' + store.vehicles.map(vehicle => vehicle + '호').join(', ') : '')));
      list.append(row);
    }
    if (!cell.stores.length) list.append(element('li', '', '확인된 고객 정보가 없습니다.'));
    detail.append(list);
    if (offset || cell.next !== null) {
      const paging = element('div', 'coverage-detail-paging');
      for (const [label, target] of [['이전 매장', offset ? Math.max(0, offset - 40) : null], ['다음 매장', cell.next]]) {
        if (target === null) continue;
        const button = element('button', '', label);
        button.type = 'button';
        button.onclick = () => void selectCell(cell.id, target);
        paging.append(button);
      }
      detail.append(paging);
    }
    detail.hidden = false;
    if (getComputedStyle(panelToggle).display !== 'none') {
      const box = sidebar.getBoundingClientRect();
      const selectedBox = detail.getBoundingClientRect();
      if (selectedBox.bottom > box.bottom) sidebar.scrollTop += Math.max(0, selectedBox.top - box.top - 10);
    }
  }

  async function selectCell(id, offset = 0, regionLabel) {
    if (!view || !active) return;
    if (view.period.days !== days || loadedCenter !== center) return;
    const current = view;
    collapsePanel(false);
    const requested = current.cells.find(cell => cell.id === id) || list?.rows.find(cell => cell.id === id);
    if (requested) selected = requested;
    paint();
    detail.hidden = false;
    const provisional = requested ? '관측 방문 ' + visitLabel(requested) + ' · 등록 ' + fmt(requested.registered) + '곳' : '격자 상세를 불러오고 있습니다.';
    detail.replaceChildren(element('p', '', provisional), element('p', '', current.period.start + ' ~ ' + current.period.end));
    try {
      const cell = await read('detail', '/cell', { id, offset, days: current.period.days, center: loadedCenter, generation: current.generation });
      if (!cell || view?.generation !== current.generation || view.period.days !== current.period.days) return;
      if (regionLabel && cell.label === '행정구역 미확인') cell.label = regionLabel + ' 격자';
      selected = cell;
      renderDetail(cell, offset);
      renderList();
      paint();
    } catch (error) {
      if (!active) return;
      const retry = element('button', '', '다시 읽기');
      retry.type = 'button';
      retry.onclick = () => void selectCell(id, offset, regionLabel);
      detail.replaceChildren(element('p', '', provisional), element('p', '', current.period.start + ' ~ ' + current.period.end), retry);
      if (error.status === 409) void loadView(true);
    }
  }

  function renderSearch(result, radius) {
    searchResults.replaceChildren();
    if (!result.results.length) {
      searchResults.append(element('p', 'coverage-empty', '저장된 주소·매장·행정구역에서 일치 항목을 찾지 못했습니다.'));
      return;
    }
    searchResults.append(element('p', 'coverage-search-caption', result.days + '일 · ' + result.start + ' ~ ' + result.end));
    for (const row of result.results) {
      const button = element('button', 'coverage-search-result');
      button.type = 'button';
      button.dataset.kind = row.kind;
      button.append(element('strong', '', row.name), element('small', '', [row.code, row.address].filter(Boolean).join(' · ')));
      if (row.stats) {
        const stats = row.stats;
        button.append(element('span', '', '관측 방문 ' + visitLabel(stats) + ' · 등록 ' + fmt(stats.registered) + '곳'));
        button.append(element('small', '', 'H3 ' + row.id + ' · 이력 호차 ' + (stats.vehicles.map(v => v + '호').join(', ') || '미확인')),
          ...nearbyLabels(stats.nearby).map(label => element('small', '', label)), statusBadge(stats.status));
        button.append(element('small', '', '반경 내 등록 매장 500m ' + fmt(stats.registeredWithin[500]) +
          '곳 · 1km ' + fmt(stats.registeredWithin[1000]) + '곳'));
      } else {
        button.append(element('span', '', row.bounds ? '행정구역 범위' : '저장된 좌표가 없습니다.'));
      }
      button.disabled = !row.location && !row.bounds;
      button.onclick = () => {
        map.focus(row.location, row.bounds, radius);
        if (row.id) void selectCell(row.id, 0, row.kind === 'store' ? undefined : row.name);
      };
      searchResults.append(button);
    }
  }

  function clearSearch() {
    abort('search');
    searchOwner?.abort();
    searchOwner = null;
    searchResults.replaceChildren();
  }

  function searchMessage(message) {
    searchResults.replaceChildren(element('p', 'coverage-empty', message));
  }

  async function search(event) {
    event.preventDefault();
    clearSearch();
    const query = find('coverageQuery').value.trim();
    if (query.length < 2) {
      searchMessage('검색어를 두 글자 이상 입력해 주세요.');
      return;
    }
    const owner = searchOwner = new AbortController();
    const radius = Number(find('coverageRadius').value);
    const params = { days, center, radius };
    if (view) params.generation = view.generation;
    searchMessage('저장된 위치를 찾는 중입니다.');
    try {
      const data = await read('search', '/search', params, { 'x-map-customer-query': encodeURIComponent(query) });
      if (!data || searchOwner !== owner) return;
      if (data.results.length) {
        renderSearch(data, radius);
        return;
      }
      const requests = window.NewAreaRequests;
      const address = requests?.addressQuery(query, window.Phase2bUi.addressVariants);
      if (!address) {
        renderSearch(data, radius);
        return;
      }
      const adapter = window.KakaoMapsAdapter;
      if (window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup !== true) await adapter?.refreshAddressLookup?.();
      if (!active || searchOwner !== owner) return;
      if (window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup !== true) {
        searchMessage('미등록 주소 조회는 승인된 주소 서비스 연결 후 사용할 수 있습니다.');
        return;
      }
      addressProxy ||= adapter?.geocoder?.();
      if (!addressProxy?.serverProxy) throw Error('APPROVED_ADDRESS_PROXY_REQUIRED');
      searchMessage('승인된 주소 서비스에서 정확한 위치를 찾는 중입니다.');
      const documents = await requests.lookup(addressProxy, address, { signal: owner.signal });
      if (!active || searchOwner !== owner) return;
      const [document] = documents;
      if (documents.length !== 1 || !window.Phase2bUi.addressMatches(address, document.address_name)) {
        searchMessage('일치하는 주소 좌표를 확인하지 못했습니다.');
        return;
      }
      const point = [Number(document.y), Number(document.x)];
      const pointResult = await read('search', '/point', params, { 'x-map-coverage-point': point.join(',') });
      if (!pointResult || searchOwner !== owner) return;
      pointResult.results = pointResult.results.map(result => ({ ...result, kind: 'address', name: document.address_name }));
      renderSearch(pointResult, radius);
    } catch (error) {
      if (!active || searchOwner !== owner) return;
      searchMessage(error.code ? window.NewAreaRequests.message(error) : '검색을 완료하지 못했습니다. 다시 검색해 주세요.');
      if (error.status === 409) void loadView(true);
    }
  }

  function changeFilters() {
    filters();
    clearSelection();
    clearSearch();
    abort('list');
    listKey = '';
    list = null;
    renderList();
    lastKey = '';
    void loadView(true);
  }

  find('coverageDays').onchange = event => { days = Number(event.target.value); changeFilters(); };
  find('coverageCenter').onchange = event => { center = event.target.value; changeFilters(); };
  find('coverageRefresh').onclick = () => void loadView(true);
  panelToggle.onclick = () => collapsePanel(panelToggle.getAttribute('aria-expanded') === 'true');
  find('coverageSearch').onsubmit = search;
  find('coverageQuery').oninput = clearSearch;
  find('coverageRadius').onchange = clearSearch;
  find('coverageListFilter').onchange = () => { list = null; renderList(); void loadList(); };
  find('coverageListPrevious').onclick = () => void loadList(Math.max(0, listOffset - 12));
  find('coverageListMore').onclick = () => { if (list?.next != null) void loadList(list.next); };

  function resetView() {
    view = list = null;
    viewTag = lastKey = listKey = '';
    viewSession = null;
    listOffset = 0;
    clearSelection();
    clearSearch();
    abort('list');
    renderList();
    evidence.replaceChildren();
    status.textContent = '';
    find('coverageBasis').textContent = '분석 기준일을 확인하고 있습니다.';
    for (const id of ['coverageObserved', 'coveragePreserved', 'coverageGaps', 'coverageViewport']) find(id).textContent = '';
    for (const stat of root.querySelectorAll('[data-metric]')) stat.textContent = '—';
    delete root.dataset.viewMetrics;
    delete root.dataset.viewValidation;
  }

  return {
    open(started) {
      if (view && viewSession !== currentSession()) resetView();
      openedAt = started;
      delete root.dataset.viewMetrics;
      delete root.dataset.viewValidation;
      active = true;
      root.hidden = false;
      sidebar.scrollTop = 0;
      filters();
      fitWorkspace();
      resize.observe(header);
      resize.observe(host);
      void startMap();
    },
    close() {
      active = false;
      root.hidden = true;
      mapOwner++;
      resize.disconnect();
      clearTimeout(timer);
      clearSearch();
      for (const controller of requests.values()) controller.abort();
      requests.clear();
      map?.suspend();
      pendingView = null;
      failedKey = '';
      const resetList = selected || listOffset || find('coverageListFilter').value !== 'candidate';
      clearSelection();
      find('coverageEvidence').open = false;
      find('coverageQuery').value = '';
      find('coverageRadius').value = '0';
      if (resetList) {
        find('coverageListFilter').value = 'candidate';
        list = view?.candidateList || null;
        listOffset = 0;
        renderList();
      }
      searchButton.disabled = true;
      showMapState('');
    },
    invalidate() {
      abort('view');
      pendingView = null;
      resetView();
      if (active) void loadView(true);
    },
    disposeMap() {
      resetView();
      map?.destroy();
      map = baseMap = addressProxy = null;
      days = 90;
      center = 'all';
      collapsePanel(false);
      host.replaceChildren();
    }
  };
}
