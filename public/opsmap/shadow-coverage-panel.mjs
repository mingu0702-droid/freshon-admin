import { createCoverageMap } from './shadow-coverage-map.mjs?v=20261109-stage';

const API = '/api/map-phase2b/private/shadow-coverage';
const STATUS = { DELIVERED: '배송 기록', UNDLVRD: '기록 0건', EMPTY: '기록 0건', UNKNOWN: '자료 부족' };
const fmt = value => Number(value || 0).toLocaleString('ko-KR');
const time = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

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

export function createCoveragePanel(sidebar) {
  const root = document.createElement('section');
  root.id = 'shadowCoverage';
  root.className = 'shadow-coverage';
  root.hidden = true;
  root.setAttribute('aria-labelledby', 'coverageTitle');
  root.innerHTML = `
    <div class="coverage-heading">
      <h2 id="coverageTitle">음영권역</h2>
      <button type="button" id="coverageRefresh">다시 읽기</button>
    </div>
    <div class="coverage-filters">
      <label>자료 기간 <select id="coverageDays"><option value="30">30일</option><option value="60">60일</option><option value="90" selected>90일</option></select></label>
      <label>담당 센터 <select id="coverageCenter"><option value="all">전체</option><option value="osan">오산</option><option value="yeongnam">영남</option><option value="honam">호남</option></select></label>
    </div>
    <div class="coverage-legend" aria-label="격자 범례 · 배송 관측 건수">
      <span data-tone="light">1–9건</span><span data-tone="medium">10–49건</span><span data-tone="dense">50건 이상</span><span data-tone="unknown">자료 부족</span>
    </div>
    <p class="coverage-note">배송 이력 참고용 · 배차 가능 여부는 별도 확인</p>
    <p id="coverageStatus" role="status" aria-live="polite"></p>
    <details class="coverage-evidence" id="coverageEvidence">
      <summary id="coverageEvidenceTitle">집계 기준과 자료 기간</summary>
      <div id="coverageEvidenceBody"></div>
    </details>
    <div class="coverage-detail" id="coverageDetail" aria-label="선택 격자 상세" hidden></div>
    <details class="coverage-tools" id="coverageTools">
      <summary>격자 목록·주변 검색</summary>
      <form class="coverage-search" id="coverageSearch">
        <label for="coverageQuery">주소·매장·지역 검색</label>
        <div class="coverage-search-row">
          <input id="coverageQuery" type="search" placeholder="주소, 고객코드, 시·군·구" maxlength="200" required autocomplete="off">
          <button type="submit">검색</button>
        </div>
        <label for="coverageRadius">검색 범위
          <select id="coverageRadius"><option value="0">선택 격자</option><option value="500">반경 500m</option><option value="1000">반경 1km</option></select>
        </label>
      </form>
      <div id="coverageSearchResults" class="coverage-results" aria-live="polite"></div>
      <div class="coverage-list">
        <select id="coverageListFilter" aria-label="격자 목록 필터">
          <option value="review">기록 미확인·자료 부족</option><option value="all">현재 지도 전체</option><option value="delivery">배송 기록 있음</option>
        </select>
        <div id="coverageCellList"></div>
        <button id="coverageListMore" type="button" hidden>격자 더 보기</button>
      </div>
    </details>`;
  const searchBlock = sidebar.querySelector(":scope > .customerBlock");
  if (searchBlock) searchBlock.after(root);
  else sidebar.prepend(root);
  const find = id => root.querySelector('#' + id);
  const status = find('coverageStatus');
  const detail = find('coverageDetail');
  const searchResults = find('coverageSearchResults');
  const cellList = find('coverageCellList');
  const evidence = find('coverageEvidenceBody');
  const requests = new Map();
  let map, active = false, timer, view = null, selected = null;
  let days = 90, center = 'all', loadedCenter = 'all', lastKey = '', pendingKey = '', listLimit = 12;

  function filters() {
    find('coverageDays').value = String(days);
    find('coverageCenter').value = center;
  }

  function abort(name) {
    requests.get(name)?.abort();
    requests.delete(name);
  }

  async function read(name, path, params, query) {
    abort(name);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    requests.set(name, controller);
    try {
      const url = API + path + '?' + new URLSearchParams(params);
      const response = await fetch(url, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(query ? { headers: { 'x-map-customer-query': encodeURIComponent(query) } } : {})
      });
      if (!response.ok) throw Object.assign(Error('COVERAGE_REQUEST_FAILED'), { status: response.status });
      const payload = await response.json();
      if (!active || requests.get(name) !== controller) return null;
      if (payload?.ok !== true || !payload.data) throw Error('COVERAGE_RESPONSE_INVALID');
      return payload.data;
    } catch (error) {
      if (!active || requests.get(name) !== controller) return null;
      throw error;
    } finally {
      clearTimeout(timeout);
      if (requests.get(name) === controller) requests.delete(name);
    }
  }

  function renderList() {
    const filter = find('coverageListFilter').value;
    const allowed = cell => filter === 'all' || (filter === 'delivery' ? cell.status === 'DELIVERED' : cell.status !== 'DELIVERED');
    const cells = (view?.cells || []).filter(allowed).sort((a, b) =>
      b.registered - a.registered || b.visits - a.visits);
    cellList.replaceChildren();
    for (const cell of cells.slice(0, listLimit)) {
      const row = element('button', 'coverage-list-row');
      row.type = 'button';
      row.dataset.cellId = cell.id;
      row.setAttribute('aria-pressed', String(selected?.id === cell.id));
      const text = element('span');
      text.append(element('strong', '', cell.label), element('small', '', '등록 ' + fmt(cell.registered) + ' · 배송 ' + fmt(cell.visits)));
      row.append(text, statusBadge(cell.status));
      row.onclick = () => {
        map.focus(cell.location);
        void selectCell(cell.id);
      };
      cellList.append(row);
    }
    if (!cells.length) cellList.append(element('p', 'coverage-empty', '현재 화면에서 이 조건에 해당하는 격자가 없습니다.'));
    find('coverageListMore').hidden = cells.length <= listLimit;
  }

  function paint() {
    if (map) map.render(view?.cells || [], selected);
  }

  function renderView(data) {
    const { period, completeness, summary } = data;
    find('coverageEvidenceTitle').textContent = '자료 ' + period.end + ' · 기록 미확인 ' + completeness.missingDates.length + '일';
    evidence.replaceChildren(
      element('p', '', period.start + ' ~ ' + period.end + ' · 기록 ' + (period.days - completeness.missingDates.length) + '/' + period.days + '일'),
      element('p', '', '집계 갱신 ' + time.format(new Date(data.refreshedAt)) + ' · 원천 확인 ' + time.format(new Date(data.sourceObservedAt))),
      element('p', '', '등록 매장 ' + fmt(summary.registered) + '곳 · 위치 미확인 ' + fmt(summary.missingStoreLocation) + '곳'),
      element('p', '', '배송 완료 ' + fmt(completeness.recordedVisits) + '건 · 격자 연결 ' + fmt(summary.visits) + '건 · 위치 미연결 ' + fmt(summary.unplacedVisits) + '건'),
      element('p', '', 'H3 R' + data.resolution + ' · 현재 화면 ' + fmt(data.cells.length) + '격자 · 배송 기록 ' + fmt(summary.delivered) + ' · 자료 부족 ' + fmt(summary.review))
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
    renderList();
    paint();
  }

  async function loadView(force = false) {
    if (!active || !map) return;
    const viewport = map.viewport();
    const box = viewport.box.map(value => value.toFixed(5)).join(',');
    const key = [days, center, viewport.level, box].join(':');
    if (key === pendingKey) return;
    if (!force && key === lastKey) {
      abort('view');
      pendingKey = '';
      return;
    }
    pendingKey = key;
    const wantedCenter = center;
    if (!view) status.textContent = '분석 격자를 불러오고 있습니다.';
    try {
      const data = await read('view', '/view', { days, center, box, level: viewport.level });
      if (!data || pendingKey !== key) return;
      if (!Array.isArray(data.cells) || data.cells.length > 360) throw Error('COVERAGE_VIEW_INVALID');
      if (view && (view.generation !== data.generation || view.period.days !== data.period.days || loadedCenter !== wantedCenter)) {
        clearSelection();
        searchResults.replaceChildren();
      }
      view = data;
      loadedCenter = wantedCenter;
      lastKey = key;
      renderView(view);
    } catch {
      if (!active || pendingKey !== key) return;
      if (view) {
        days = view.period.days;
        center = loadedCenter;
        filters();
        status.textContent = '조회에 실패했습니다. 마지막 정상 집계를 표시합니다 · ' + time.format(new Date(view.refreshedAt));
      } else {
        status.textContent = '저장된 분석 자료를 불러오지 못했습니다. 새로고침해 주세요.';
      }
    } finally {
      if (pendingKey === key) pendingKey = '';
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
    const facts = [
      ['등록 매장', fmt(cell.registered) + '곳'], ['배송 이력', fmt(cell.visits) + '건'],
      ['격자 내 고객', fmt(cell.customers) + '곳'], ['최근 배송일', cell.lastDelivery || '확인된 기록 없음'],
      ['자료 기간', view.period.start + ' ~ ' + view.period.end]
    ];
    for (const [label, value] of facts) {
      fields.append(element('dt', '', label), element('dd', '', value));
    }
    detail.replaceChildren(header, element('h2', '', cell.label), element('p', 'coverage-cell-id', cell.id));
    if (cell.address) detail.append(element('p', 'coverage-address', cell.address));
    detail.append(fields, element('h3', '', '확정호차 이력'),
      element('p', 'coverage-vehicle-list', cell.vehicles.length ? cell.vehicles.map(vehicle => vehicle + '호').join(' · ') : '확인된 호차 없음'),
      element('h3', '', '고객코드 · 매장'));
    const list = element('ul', 'coverage-stores');
    for (const store of cell.stores) {
      const row = element('li');
      row.append(element('strong', '', store.name), element('small', '', store.code +
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
  }

  async function selectCell(id, offset = 0, regionLabel) {
    if (!view || !active) return;
    if (view.period.days !== days || loadedCenter !== center) return;
    const current = view;
    const requested = current.cells.find(cell => cell.id === id);
    if (requested) selected = requested;
    paint();
    detail.hidden = false;
    const provisional = requested ? '배송 ' + fmt(requested.visits) + '건 · 등록 ' + fmt(requested.registered) + '곳' : '격자 상세를 불러오고 있습니다.';
    detail.replaceChildren(element('p', '', provisional), element('p', '', current.period.start + ' ~ ' + current.period.end));
    try {
      const cell = await read('detail', '/cell', { id, offset, days: current.period.days, center: loadedCenter, generation: current.generation });
      if (!cell || view?.generation !== current.generation || view.period.days !== current.period.days) return;
      if (regionLabel && cell.label === '행정구역 미확인') cell.label = regionLabel + ' 중심 격자';
      selected = cell;
      renderDetail(cell, offset);
      renderList();
      paint();
    } catch (error) {
      if (!active) return;
      const retry = element('button', '', '다시 읽기');
      retry.type = 'button';
      retry.onclick = () => void selectCell(id, offset);
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
    searchResults.append(element('p', 'coverage-search-caption', '90일 · 대표 격자 기준'));
    for (const row of result.results) {
      const button = element('button', 'coverage-search-result');
      button.type = 'button';
      button.dataset.kind = row.kind;
      button.append(element('strong', '', row.name), element('small', '', [row.code, row.address].filter(Boolean).join(' · ')));
      if (row.stats) {
        const stats = row.stats;
        button.append(element('span', '', '배송 ' + fmt(stats.visits) + '건 · 등록 ' + fmt(stats.registered) + '곳'));
        button.append(element('small', '', '최근 ' + (stats.lastDelivery || '기록 없음') + ' · ' + (stats.vehicles.map(v => v + '호').join(', ') || '호차 미확인')));
        button.append(statusBadge(stats.status));
        if (radius) button.append(element('small', '', '반경 내 등록 매장 ' + fmt(stats.nearbyRegistered) + '곳'));
      } else {
        button.append(element('span', '', row.bounds ? '행정구역 범위' : '저장된 좌표가 없습니다.'));
      }
      button.disabled = !row.location && !row.bounds;
      button.onclick = () => {
        map.focus(row.location, row.bounds, radius);
        if (row.id) void selectCell(row.id, 0, row.kind === 'region' ? row.name : undefined);
      };
      searchResults.append(button);
    }
  }

  async function search(event) {
    event.preventDefault();
    const query = find('coverageQuery').value.trim();
    if (query.length < 2) {
      searchResults.replaceChildren(element('p', '', '검색어를 두 글자 이상 입력해 주세요.'));
      return;
    }
    const radius = Number(find('coverageRadius').value);
    searchResults.replaceChildren(element('p', '', '저장된 위치를 찾는 중입니다.'));
    try {
      const params = { center, radius };
      if (view) params.generation = view.generation;
      const data = await read('search', '/search', params, query);
      if (data) renderSearch(data, radius);
    } catch (error) {
      if (!active) return;
      searchResults.replaceChildren(element('p', '', '검색을 완료하지 못했습니다. 다시 검색해 주세요.'));
      if (error.status === 409) void loadView(true);
    }
  }

  function changeFilters() {
    filters();
    clearSelection();
    abort('search');
    searchResults.replaceChildren();
    listLimit = 12;
    lastKey = '';
    void loadView(true);
  }

  find('coverageDays').onchange = event => { days = Number(event.target.value); changeFilters(); };
  find('coverageCenter').onchange = event => { center = event.target.value; changeFilters(); };
  find('coverageRefresh').onclick = () => void loadView(true);
  find('coverageSearch').onsubmit = search;
  find('coverageQuery').oninput = () => { abort('search'); searchResults.replaceChildren(); };
  find('coverageRadius').onchange = () => { abort('search'); searchResults.replaceChildren(); };
  find('coverageListFilter').onchange = () => { listLimit = 12; renderList(); };
  find('coverageListMore').onclick = () => { listLimit += 12; renderList(); };

  return {
    open(operatingMap, maps) {
      map = createCoverageMap(operatingMap, maps, { idle: scheduleView, select: id => void selectCell(id) });
      active = true;
      root.hidden = false;
      filters();
      scheduleView();
    },
    close() {
      active = false;
      clearTimeout(timer);
      for (const controller of requests.values()) controller.abort();
      requests.clear();
      map?.destroy();
      map = view = selected = null;
      pendingKey = lastKey = '';
      detail.hidden = root.hidden = true;
      detail.replaceChildren();
      searchResults.replaceChildren();
      cellList.replaceChildren();
      evidence.replaceChildren();
      find('coverageEvidenceTitle').textContent = '집계 기준과 자료 기간';
      find('coverageEvidence').open = find('coverageTools').open = false;
      find('coverageQuery').value = '';
      find('coverageRadius').value = '0';
      days = 90;
      center = 'all';
      listLimit = 12;
      status.textContent = '';
    }
  };
}
