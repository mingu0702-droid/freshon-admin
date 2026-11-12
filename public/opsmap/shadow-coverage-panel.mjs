import { createCoverageMap } from './shadow-coverage-map.mjs?v=20261111-delivery-status';

const API = '/api/map-phase2b/private/shadow-coverage';
const STATUS = { DELIVERED: '관측 배송 이력', CANDIDATE: '관측기간 미배송 후보', EMPTY: '검증 범위 내 공백', UNKNOWN: '자료 부족' };
const LIST_TITLES = { candidate: STATUS.CANDIDATE, delivery: '배송 이력 격자', review: '자료 부족 격자' };
const PROVIDERS = [['FRESHON','프레시온'],['CJ','CJ택배'],['NAVER_SHOPPING','네이버쇼핑']];
const PROVIDER_STATUS = {NOT_CONNECTED:'자료 미연결',UNVERIFIED:'자료 미확인',AVAILABLE_CONFIRMED:'가능 확인',
  UNAVAILABLE_CONFIRMED:'불가 확인',NO_DELIVERY_HISTORY:'관측 배송기록 없음'};
const EMPTY = Object.freeze([]);
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

const visitLabel = record => record.visits === null ? '배송 관측 매장 ' + fmt(record.observedStores) + '곳'
  : record.status === 'UNKNOWN' ? '미확인' : fmt(record.visits) + '건';

function deliveryLabel(delivery) {
  if (delivery?.state === 'CONFIRMED_ZERO') return '완료 배송 0건 확인';
  if (delivery?.state !== 'CONFIRMED_DELIVERY') return '완료 배송 미확인';
  return '완료 배송 ' + (delivery.complete ? '' : '확인분 ') + fmt(delivery.observedCompletedCount) + '건' +
    (delivery.lastCompletedOn ? ' · 최근 ' + delivery.lastCompletedOn : '');
}

function deliveryCohortLabel(filter) {
  return filter.days + '일 신규 이력 중 완료 배송 확인 ' + fmt(filter.confirmedNewActive) + '곳 · 0건 확인 ' +
    fmt(filter.newZero) + '곳 · 미확인 ' + fmt(filter.newUnknown) + '곳' +
    (filter.missingDays ? ' · 배송 기록 누락 ' + fmt(filter.missingDays) + '일' : '');
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
      <section id="coverageProviderComparison" class="coverage-provider-comparison" aria-label="주소별 공급자 비교" aria-live="polite" hidden></section>
      <div id="coverageAnalysis">
        <div class="coverage-filters">
          <label>자료 기간 <select id="coverageDays"><option value="30">30일</option><option value="60">60일</option><option value="90" selected>90일</option></select></label>
          <label>담당 센터 <select id="coverageCenter"><option value="all">전체</option><option value="osan">오산</option><option value="yeongnam">영남</option><option value="honam">호남</option></select></label>
          <label>검색 반경 <select id="coverageRadius"><option value="0">격자만</option><option value="500">500m</option><option value="1000">1km</option></select></label>
          <label>격자 크기 <select id="coverageResolution"><option value="auto">자동</option><option value="8">R8</option><option value="9">R9</option><option value="10">R10</option><option value="11">R11</option></select></label>
        </div>
        <fieldset class="coverage-providers"><legend>공급자 레이어</legend>${PROVIDERS.map(([id,label])=>
          `<label><input type="checkbox" data-coverage-provider="${id}" checked><span class="coverage-provider-key" data-key="${id}">${label}<small data-provider-state="${id}">${id==='FRESHON'?'집계 확인 중':'자료 미연결'}</small></span></label>`).join('')}
          <label><input id="coverageOverlapToggle" type="checkbox" checked><span class="coverage-provider-key" data-key="OVERLAP">3사 중첩 보기</span></label>
          <p id="coverageProviderMapStatus" class="coverage-note" aria-live="polite"></p>
        </fieldset>
        <div class="coverage-filter-feedback"><p id="coverageFilterProgress" role="status" aria-live="polite"></p><button type="button" id="coverageFilterRetry" hidden>조건 다시 조회</button></div>
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
            <div><dt>활성 오산신규</dt><dd id="coverageNewCount">—</dd></div>
            <div><dt>오산보류 확인</dt><dd id="coverageHeldCount">—</dd></div>
          </dl>
          <p id="coveragePreserved"></p>
          <p id="coverageGaps"></p>
          <p id="coverageViewport"></p>
          <p id="coverageStoreBasis" aria-live="polite"></p>
        </div>
        <div class="coverage-legend" aria-label="배송 격자 범례">
          <span data-tone="delivery">관측 배송 이력</span><span data-tone="candidate">관측기간 미배송 후보</span>
          <span data-tone="new">활성 오산신규</span><span data-tone="held">오산보류</span><span>점선 원: 90일 이력</span>
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
      <a class="open-coordinate-credit" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">일부 주소 위치 © OpenStreetMap contributors</a>
      <div id="coverageMapSummary" class="coverage-map-summary" hidden>
        <p id="coverageMapCount"></p>
        <div class="coverage-legend" aria-label="지도 범례"><span data-tone="candidate">미배송 후보</span><span data-tone="delivery">배송 이력</span><span data-tone="new">활성 오산신규</span><span data-tone="held">오산보류</span><span data-tone="unknown">자료 부족</span><span data-tone="empty">확인 공백</span></div>
      </div>
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
  const comparison = find('coverageProviderComparison');
  const cellList = find('coverageCellList');
  const evidence = find('coverageEvidenceBody');
  const requests = new Map();
  let map, baseMap, active = false, mapOwner = 0, timer, refreshTimer, view = null, selected = null, pendingView = null;
  let days = 90, center = 'all', loadedCenter = 'all', lastKey = '', failedKey = '', failedFilter = null;
  let viewTag = '', viewSession = null;
  let list = null, listKey = '', listOffset = 0, searchOwner, addressProxy, pendingSearchKey;
  const enabledProviders = new Set(PROVIDERS.map(([id])=>id));
  let providerMeta, providerCells = EMPTY, providerPaths = EMPTY, providerScope = '', providerViewKey = '', comparisonRow;
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
        map = createCoverageMap(baseMap, maps, { idle: scheduleView, select: id => chooseMapCell(id), enabled: () => active });
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

  const centerLabel = value => ({all:'전체', osan:'오산', yeongnam:'영남', honam:'호남'})[value] || '';
  function filterProgress(message = '', busy = false) {
    find('coverageFilterProgress').textContent = message;
    find('coverageFilterRetry').hidden = !failedFilter;
    if (busy) cellList.setAttribute('aria-busy', 'true');
    else cellList.removeAttribute('aria-busy');
  }

  function abort(name) {
    requests.get(name)?.abort();
    requests.delete(name);
  }

  async function read(name, path, params, headers) {
    abort(name);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    requests.set(name, controller);
    try {
      const url = API + path + '?' + new URLSearchParams(params);
      const response = await fetch(url, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers
      });
      if (!response.ok) {
        const error=await response.json().catch(()=>null);
        throw Object.assign(Error('COVERAGE_REQUEST_FAILED'),{status:response.status,code:error?.error});
      }
      const payload = await response.json();
      if (!active || requests.get(name) !== controller) return null;
      const unchanged = name === 'view' && payload?.unchanged === true;
      if (payload?.ok !== true || (!unchanged && !payload.data)) throw Error('COVERAGE_RESPONSE_INVALID');
      if (name !== 'view') return payload.data;
      return { data: payload.data, tag: response.headers.get('etag'), unchanged };
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
        chooseMapCell(cell.id);
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
    const freshon=enabledProviders.has('FRESHON');
    if (map) map.render(freshon ? view?.cells || EMPTY : EMPTY,
      freshon && !(view?.resolution >= 8 && selected?.resolution && selected.resolution !== view.resolution) ? selected : null,
      freshon ? view?.candidateViewport?.markers : EMPTY, providerPaths, freshon ? view?.statusPins || EMPTY : EMPTY);
  }

  function updateProviderPaths() {
    providerPaths=providerCells.flatMap(cell=>{
      if(!Array.isArray(cell.boundary)||cell.boundary.length<3)return [];
      const paths=PROVIDERS.filter(([id])=>enabledProviders.has(id)&&
        ['AVAILABLE_CONFIRMED','UNAVAILABLE_CONFIRMED'].includes(cell.providers?.[id]?.status)).map(([id])=>
        ({id:cell.id,boundary:cell.boundary,provider:id,status:cell.providers[id].status}));
      if(find('coverageOverlapToggle').checked&&['TWO_AVAILABLE','ALL_AVAILABLE'].includes(cell.overlap?.status)&&
        paths.filter(item=>item.status==='AVAILABLE_CONFIRMED').length>1)paths.push({id:cell.id,boundary:cell.boundary,provider:'OVERLAP',status:'AVAILABLE_CONFIRMED'});
      return paths;
    });
    paint();
  }

  function renderProviderStates() {
    for(const [id] of PROVIDERS){
      const entry=providerMeta?.[id];
      const source=entry?.source==='FRESHON_OBSERVED_DELIVERY'?'보존 배송 이력':entry?.source;
      const state=entry?.serviceSourceConnected?'자료 연결':id==='FRESHON'&&view?'관측 배송 기록':
        entry?.connection==='UNVERIFIED'?'자료 미확인':id==='FRESHON'?'집계 확인 중':'자료 미연결';
      root.querySelector(`[data-provider-state="${id}"]`).textContent=[state,entry?.sourceAsOf||
        (id==='FRESHON'?view?.period.end:null),source||(id==='FRESHON'&&view?'보존 배송 이력':null)].filter(Boolean).join(' · ');
    }
  }

  async function loadProviderLayers(data) {
    const scope=[data.generation,days,center].join(':');
    const same=providerScope===scope;
    if(!same){abort('providers');abort('provider-map');providerScope=scope;providerMeta=null;providerCells=EMPTY;providerViewKey='';updateProviderPaths();renderProviderStates();}
    const params={days,center,generation:data.generation};
    if(!providerMeta){
      if(requests.has('providers'))return;
      const meta=await read('providers','/provider-overlap',params).catch(()=>null);
      if(!meta||providerScope!==scope||meta.contract!=='opsmap-provider-coverage-v1'||meta.kind!=='APPROVED')return;
      providerMeta=meta.providers;
      renderProviderStates();
      if(comparisonRow)void compareProviders(comparisonRow);
    }
    if(!PROVIDERS.some(([id])=>enabledProviders.has(id)&&providerMeta[id]?.serviceSourceConnected))return;
    const box=map.viewport().box.map(value=>value.toFixed(5)).join(',');
    if(providerViewKey===box)return;
    providerViewKey=box;
    const result=await read('provider-map','/provider-overlap',{...params,box}).catch(()=>null);
    if(providerScope!==scope||providerViewKey!==box)return;
    if(result?.kind!=='APPROVED'){providerViewKey='';return;}
    providerCells=Array.isArray(result.cells)?result.cells:EMPTY;
    find('coverageProviderMapStatus').textContent=result.truncated?'지도를 확대하면 나머지 공급자 격자를 확인할 수 있습니다.':'';
    updateProviderPaths();
  }

  function renderView(data) {
    const { period, completeness, summary } = data;
    const { viewportSummary, candidateViewport, preservedMap } = data;
    const confirmed = completeness.recordedDays;
    const sourceText = confirmed == null ? '센터별 일자 집계 미확인' :
      '기록 확인 ' + confirmed + '/' + period.days + '일 · 미확인 ' + completeness.missingDates.length + '일';
    find('coverageBasis').textContent = '분석 ' + period.days + '일 · 기준 ' + period.end;
    find('coverageObserved').textContent = sourceText;
    const selectedCenter = centerLabel(loadedCenter);
    find('coverageNationalTitle').textContent = (loadedCenter === 'all' ? '전국 집계' : '전국 · ' + selectedCenter + ' 센터') +
      ' · H3 R' + data.summaryResolution;
    for (const stat of root.querySelectorAll('[data-metric]')) stat.textContent = fmt(summary[stat.dataset.metric]);
    find('coveragePreserved').textContent = preservedMap
      ? '보존 지도 ' + fmt(preservedMap.count) + '곳' + (preservedMap.asOf ? ' (' + preservedMap.asOf + ')' : '') + ' · 별도 범위'
      : '보존 지도 미확인 · 별도 범위';
    find('coverageGaps').textContent = '좌표 미확인 ' + fmt(summary.missingStoreLocation) + '곳 · 배송 위치 미연결 ' +
      fmt(summary.unplacedVisits) + '건 · 원천 식별 미확인 ' + fmt(summary.unidentifiedVisits) + '건';
    const stores = data.storeStatus;
    const deliveryFilter = stores?.deliveryFilter;
    const tally = (key, unknown) => stores?.[key] == null ? '미확인'
      : fmt(stores[key]) + '곳' + (unknown ? ' 확인' : '');
    find('coverageNewCount').textContent = stores?.NEW == null ? '배송 검증 대기' : tally('NEW',deliveryFilter?.newUnknown);
    find('coverageHeldCount').textContent = deliveryFilter ? fmt(deliveryFilter.held) + '곳' : tally('HELD',stores?.currentUnknown);
    const history = stores && (!stores.historyUnknown || stores.pastNew || stores.pastHeld)
      ? '보존 90일 관측 신규 ' + fmt(stores.pastNew) + '곳(다른 현재 호차 ' + fmt(stores.changedFromNew) + ') · 보류 ' +
        fmt(stores.pastHeld) + '곳(해제·다른 현재 호차 ' + fmt(stores.changedFromHeld) + ')' +
        (stores.evidenceAsOf ? ' · ' + stores.historyStart + ' ~ ' + stores.evidenceAsOf : '') +
        (stores.historyStart !== stores.rollingStart ? ' · 오늘 기준 90일 확인 신규 ' + fmt(stores.rollingNew) + '곳 · 보류 ' + fmt(stores.rollingHeld) + '곳' : '') +
        (stores.historyUnknown ? ' · 일부 이력 미확인' : '')
      : '90일 기준호차 이력 미확인';
    find('coverageStoreBasis').textContent = '매장 상태 전체 등록 기준 · ' + (stores?.fixedCheckedAt ? '기준호차 확인 ' + time.format(new Date(stores.fixedCheckedAt)) : '기준호차 미확인') +
      ' · ' + history + (deliveryFilter?.source === 'SEALED_COMPLETED_DELIVERIES' ? ' · ' + deliveryCohortLabel(deliveryFilter) + ' (' + deliveryFilter.start + ' ~ ' + deliveryFilter.end + ')' :
        ' · 완료 배송 검증 자료 미연결') +
      ' · 마지막 배송 수집 ' + time.format(new Date(data.sourceObservedAt));
    find('coverageViewport').textContent = '화면 H3 R' + data.resolution + ' · ' + (candidateViewport
      ? (data.resolution > data.summaryResolution ? 'R8 ' : '') + '후보 ' + fmt(candidateViewport.cells) + '격자 · ' + fmt(candidateViewport.stores) + '곳' +
        (data.resolution < data.summaryResolution ? ' · 주황 숫자: 묶인 후보 격자 수' : '')
      : '후보 ' + fmt(viewportSummary.candidates) + '격자');
    find('coverageMapCount').textContent = '현재 화면 ' + (data.resolution > data.summaryResolution ? 'R8 ' : '') + '후보 ' + fmt(candidateViewport?.cells ?? viewportSummary.candidates) + '격자' + (candidateViewport ? ' · ' + fmt(candidateViewport.stores) + '곳' : '');
    find('coverageMapSummary').hidden = false;
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
    void loadProviderLayers(data);
  }

  function currentSession() {
    const session = window.MapStaffEntry?.session();
    return session?.authenticated && Date.now() < Math.min(session.expiresAt, session.idleExpiresAt) ? session.expiresAt : null;
  }

  const pointResults=new Map();
  async function readPoint(name,location,params){
    const point=location.join(','),session=currentSession();
    const key=generation=>JSON.stringify([session,generation,params.days,params.center,params.resolution,point]);
    const cached=params.generation&&session&&pointResults.get(key(params.generation));
    if(cached&&cached.expires>Date.now()){abort(name);return cached.data;}
    const data=await read(name,'/point',{...params,detail:'1'},{'x-map-coverage-point':point});
    if(data?.cell&&data.generation&&session&&session===currentSession()){
      if(pointResults.size>=16)pointResults.delete(pointResults.keys().next().value);
      pointResults.set(key(data.generation),{data,expires:Date.now()+60_000});
    }
    return data;
  }

  async function loadView(force = false, reopening = false) {
    if (!active || !map) return;
    const viewport = map.viewport();
    const box = viewport.box.map(value => value.toFixed(5)).join(',');
    const resolution = find('coverageResolution').value;
    const key = [days, center, viewport.level, box, resolution].join(':');
    if (key === pendingView?.key) return;
    if (!force && !reopening && (key === lastKey || key === failedKey)) {
      abort('view');
      pendingView = null;
      return;
    }
    const request = pendingView = { key };
    const started = performance.now();
    const wantedCenter = center, wantedDays = days;
    const switching = view && (view.period.days !== wantedDays || loadedCenter !== wantedCenter);
    if (switching) {
      failedFilter = null;
      filterProgress(wantedDays + '일 · ' + centerLabel(wantedCenter) + ' 조회 중 · 현재 ' + view.period.days + '일 · ' + centerLabel(loadedCenter) + ' 표시', true);
    }
    const tag = (force || reopening) && key === lastKey && viewSession !== null && viewSession === currentSession() ? viewTag : '';
    if (!tag && reopening && view) resetView();
    if (!view) showMapState('분석 격자를 불러오고 있습니다.');
    try {
      const result = await read('view', '/view', { days, center, box, level: viewport.level, resolution }, tag ? { 'X-Coverage-View-Tag': tag } : undefined);
      if (!result || pendingView !== request) return;
      if (result.unchanged) {
        if (!tag || result.tag !== tag || viewSession !== currentSession()) throw Error('COVERAGE_REVALIDATION_INVALID');
        return;
      }
      const data = result.data;
      if (!Array.isArray(data.cells) || data.cells.length > 360) throw Error('COVERAGE_VIEW_INVALID');
      if (view && (view.generation !== data.generation || view.period.days !== data.period.days || loadedCenter !== wantedCenter)) {
        clearSelection();
        if (view.generation !== data.generation) clearSearch();
      }
      const detailViewChanged = !view || view.resolution !== data.resolution;
      view = data;
      viewTag = VIEW_TAG.test(result.tag) ? result.tag : '';
      viewSession = currentSession();
      loadedCenter = wantedCenter;
      lastKey = key;
      failedKey = '';
      failedFilter = null;
      filterProgress();
      renderView(view);
      if (detailViewChanged && focusedSearchRow) void showSearchCell(focusedSearchRow);
      find('coverageMap').dataset.coverageView = JSON.stringify({resolution:data.resolution,days:data.period.days,
        cells:data.cells.length,ms:Math.round(performance.now()-started)});
      showMapState('');
    } catch (error) {
      if (!active || pendingView !== request) return;
      if (tag || error.status === 401 || error.status === 403) resetView();
      failedKey = key;
      if (view) {
        if (switching) failedFilter = { days: wantedDays, center: wantedCenter };
        filterProgress(switching ? '조건 조회 실패 · 현재 ' + view.period.days + '일 · ' + centerLabel(loadedCenter) + ' 표시' : '');
        days = view.period.days;
        center = loadedCenter;
        filters();
        updateList(view);
        status.textContent = '조회에 실패했습니다. 마지막 정상 집계를 표시합니다 · ' + time.format(new Date(view.refreshedAt));
      } else {
        showMapState('분석 격자를 불러오지 못했습니다.', () => void loadView(true));
      }
    } finally {
      if (pendingView === request) {
        pendingView = null;
        cellList.removeAttribute('aria-busy');
      }
    }
  }

  function scheduleView() {
    clearTimeout(timer);
    if (active) timer = setTimeout(() => void loadView(), 140);
  }

  function clearSelection() {
    abort('detail');
    abort('focus-point');
    focusedSearchRow = null;
    focusedSearchDetail = null;
    selected = null;
    detail.hidden = true;
    detail.replaceChildren();
    paint();
  }

  function renderDetail(cell, offset, period) {
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
      ['자료 기간', period.start + ' ~ ' + period.end]
    ];
    if (cell.storeStatus) {
      const count=(key,unknown)=>cell.storeStatus[key] || !unknown ? fmt(cell.storeStatus[key]) : '미확인';
      const active = cell.deliveryFilter?.newActive == null ? '배송 검증 대기' : fmt(cell.deliveryFilter.newActive);
      facts.push(['매장 상태', '활성 오산신규 ' + active +
        ' · 오산보류 ' + (cell.deliveryFilter ? fmt(cell.deliveryFilter.held) : count('HELD',cell.storeStatus.unknown)) +
        ' · 기준호차 미확인 ' + fmt(cell.storeStatus.unknown)],
      ['완료 배송 확인', cell.deliveryFilter ? deliveryCohortLabel(cell.deliveryFilter) : '검증 자료 미연결']);
    }
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
      row.append(element('small', '', '현재 기준호차 ' + (store.currentVehicle || '미확인') +
        (store.asOf ? ' · 기준 ' + store.asOf : '')));
      const observed = (store.observations || []).map(event => event.date + ' ' + event.vehicle).join(' · ');
      const history = (store.history || []).map(event => event.date + ' ' + event.fromVehicle + ' → ' + event.vehicle).join(' · ');
      row.append(element('small', '', '90일 기준호차 관측 ' + (observed || '확인된 관측 없음')),
        element('small', '', '기준호차 변경일 ' + (history || (store.historyComplete ? '변경 기록 없음' : '미확인')) +
          (history && !store.historyComplete ? ' · 일부 기간 미확인' : '')));
      row.append(element('small', '', period.days + '일 ' + deliveryLabel(store.delivery)));
      if (store.newActive || store.newUnknown || store.current || store.pastNew || store.pastHeld) row.append(element('small', '',
        [store.newActive === true ? '활성 오산신규 · 완료 배송 확인' : '', store.current === 'HELD' ? '오산보류 · 기준호차 분류' : '',
          store.newUnknown ? '활성 여부 배송 검증 대기' : '',
          store.pastNew ? (store.vehicle && store.vehicle !== '오산신규' ? '오산신규 이력 · 현재 다른 기준호차' : '오산신규 이력') : '',
          store.pastHeld ? '오산보류 이력' : ''].filter(Boolean).join(' · ')));
      if (store.location) {
        const move = element('button', '', '매장 핀으로 이동');
        move.type = 'button';
        move.onclick = () => { map.focus(store.location); map.searchPoint(store.location); };
        row.append(move);
      }
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

  async function selectCell(id, offset = 0, regionLabel, bundled) {
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
      const ready=!offset&&bundled?.generation===current.generation&&bundled.cell?.id===id;
      if(ready)abort('detail');
      const cell=ready?{...bundled.cell}:await read('detail','/cell',{id,offset,days:current.period.days,center:loadedCenter,generation:current.generation});
      if (!cell || view?.generation !== current.generation || view.period.days !== current.period.days) return;
      if (regionLabel && cell.label === '행정구역 미확인') cell.label = regionLabel + ' 격자';
      selected = cell;
      renderDetail(cell, offset, current.period);
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

  function renderProviderComparison(row, result) {
    const list=element('dl','coverage-provider-results');
    for(const [id,label] of PROVIDERS){
      const record=result?.providers?.[id], meta=providerMeta?.[id];
      const reading=record && PROVIDER_STATUS[record.status];
      const freshonStatus=record?.history?.status==='DELIVERY_OBSERVED'?'관측 배송 이력':STATUS[row.stats?.status];
      const state=id==='FRESHON' ? (record?.status?.endsWith('_CONFIRMED')?reading:freshonStatus||reading||'격자 자료 미확인') :
        reading||(meta?.connection==='CONNECTED'||meta?.connection==='UNVERIFIED'?'자료 미확인':'자료 미연결');
      list.append(element('dt','',label),element('dd','',state));
    }
    const overlap={ALL_AVAILABLE:'3사 가능 확인',TWO_AVAILABLE:'2사 가능 확인',ONE_AVAILABLE:'1사 가능 확인',
      ALL_UNAVAILABLE:'3사 불가 확인'}[result?.overlap?.status] || '비교 가능한 공급자 자료가 부족합니다.';
    comparison.replaceChildren(element('h2','', '주소별 공급자 비교 · 격자 기준'),list,element('p','coverage-note',overlap));
    comparison.hidden=false;
  }

  async function compareProviders(row) {
    comparisonRow=row;
    renderProviderComparison(row);
    if(!row.id||!view||!PROVIDERS.some(([id])=>providerMeta?.[id]?.serviceSourceConnected))return;
    const generation=view.generation;
    const data=await read('provider-point','/provider-overlap',{days,center,generation,cells:row.id}).catch(()=>null);
    if(data?.kind==='APPROVED'&&comparisonRow===row&&view?.generation===generation)renderProviderComparison(row,data.cells?.[0]);
  }

  let focusedSearchRow = null, focusedSearchDetail = null;
  function chooseMapCell(id) {
    focusedSearchRow = null;
    focusedSearchDetail = null;
    abort('focus-point');
    void selectCell(id);
  }

  async function showSearchCell(row) {
    const current = view, resolution = Math.max(8, current?.resolution || row.detailResolution || 8);
    const label = row.kind === 'store' ? undefined : row.name;
    const use = (id,bundle=focusedSearchDetail) => { if (id) void selectCell(id,0,label,bundle); };
    if(!current){
      const bundle=focusedSearchDetail;
      if(!active||focusedSearchRow!==row||bundle?.days!==days||!bundle.cell||bundle.cell.id!==(row.detailId||row.id))return;
      // A verified point response already has its own period and generation. A slow
      // initial viewport read must not hide the detail or make a second request.
      collapsePanel(false);
      selected=label&&bundle.cell.label==='행정구역 미확인'?{...bundle.cell,label:label+' 격자'}:bundle.cell;
      renderDetail(selected,0,bundle);
      paint();
      return;
    }
    if(resolution===8&&row.id){use(row.id);return;}
    if (!row.location || resolution === (row.detailResolution || 8)) {
      use(row.detailId || row.id);
      return;
    }
    try {
      const next=await readPoint('focus-point',row.location,{days,center,generation:current.generation,resolution});
      if (focusedSearchRow!==row || view?.generation!==current.generation || Math.max(8,view.resolution)!==resolution) return;
      const point=next?.results?.[0];
      use(point?.detailId || point?.id,next);
    } catch (error) {
      if (focusedSearchRow===row && error.status===409) void loadView(true);
    }
  }

  function focusSearchResult(row, radius) {
    map.focus(row.location, row.bounds, radius);
    map.searchPoint(row.location);
    if(row.location)void compareProviders(row);
    if(focusedSearchRow!==row)focusedSearchDetail=null;
    focusedSearchRow=row;
    void showSearchCell(row);
  }

  function renderSearch(result, radius, autoFocus = false) {
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
      const basis=({OFFICIAL_PUBLIC_PARCEL:'공식 필지 대표점',OFFICIAL_PUBLIC_BUILDING:'공식 건물 위치',
        OFFICIAL_PUBLIC_ADDRESS:'공식 주소 대표점',MAP_CLICK_TEMPORARY:'직접 선택한 임시 위치',
        STAGE_PRESERVED_COORDINATE:'저장 좌표',KAKAO_ADDRESS_TEMPORARY:'승인된 외부 주소 위치'})[row.coordinateSource];
      if(basis)button.append(element('small','',basis));
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
      button.onclick = () => focusSearchResult(row, radius);
      searchResults.append(button);
    }
    if (autoFocus && result.results.length===1 && result.results[0].location) focusSearchResult(result.results[0],radius);
  }

  function clearSearch() {
    abort('search');
    abort('provider-point');
    abort('focus-point');
    if(focusedSearchRow)clearSelection();
    focusedSearchDetail=null;
    searchOwner?.abort();
    searchOwner = null;
    pendingSearchKey = null;
    map?.searchPoint(null);
    comparisonRow=null;
    comparison.replaceChildren();
    comparison.hidden=true;
    searchResults.replaceChildren();
  }

  function searchMessage(message) {
    searchResults.replaceChildren(element('p', 'coverage-empty', message));
  }

  async function search(event) {
    event.preventDefault();
    const query = find('coverageQuery').value.normalize('NFKC').trim();
    const radius = Number(find('coverageRadius').value);
    const key = JSON.stringify([query,days,center,radius,view?.generation]);
    if (pendingSearchKey === key) return;
    clearSearch();
    if (query.length < 2) {
      searchMessage('검색어를 두 글자 이상 입력해 주세요.');
      return;
    }
    const owner = searchOwner = new AbortController();
    pendingSearchKey = key;
    const choice = find('coverageResolution').value;
    const params = { days, center, radius, resolution:choice === 'auto' ? Math.max(8, view?.resolution || 8) : choice };
    if (view) params.generation = view.generation;
    const current = () => active && searchOwner === owner;
    const pointFor = async (point, name) => {
      if (!current() || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
      const location = [point.lat,point.lng];
      map.focus(location,null,radius);
      map.searchPoint(location);
      const preview=element('div','coverage-search-result');
      preview.dataset.kind='address';
      preview.append(element('strong','',name),element('span','','위치 확인 · 격자 자료 조회 중'));
      searchResults.replaceChildren(preview);
      let data;
      try{data=await readPoint('search',location,params);}
      catch(error){
        if(!current())return;
        if([401,403].includes(error.status)){map.searchPoint(null);throw error;}
        if(error.status===409)void loadView(true);
        const retry=element('button','','격자 다시 조회');retry.type='button';
        retry.onclick=()=>void pointFor(point,name).catch(failSearch);
        preview.lastElementChild.textContent='위치 확인 · 격자 자료 조회 실패';preview.append(retry);return;
      }
      if (!data || !current()) return;
      const results=data.results.map(row=>({...row,kind:'address',name,coordinateSource:point.coordinateSource}));
      renderSearch({...data,results},radius);
      if(results[0])void compareProviders(results[0]);
      if(results[0]?.id){focusedSearchDetail=data;focusedSearchRow=results[0];void showSearchCell(focusedSearchRow);}
    };
    const candidatesFor = points => {
      searchMessage('공식 위치 후보를 선택해 주세요.');
      points.forEach((point,index)=>{
        const button=element('button','coverage-search-result',`공식 위치 후보 ${index+1}`);
        button.type='button';
        button.onclick=()=>void pointFor(point,query).catch(failSearch);
        searchResults.append(button);
      });
    };
    const failSearch = error => {
      if (!current()) return;
      const problem=error.code||error.status?window.NewAreaRequests.message(error):'검색을 완료하지 못했습니다. 다시 검색해 주세요.';
      searchMessage(error.message==='COVERAGE_REQUEST_FAILED'?'격자 자료 조회 실패 · '+problem:problem);
      if (error.status === 409) void loadView(true);
    };
    searchMessage('저장된 위치를 찾는 중입니다.');
    try {
      const requests = window.NewAreaRequests;
      const address = requests?.addressQuery(query, window.Phase2bUi.addressVariants);
      const addressInput=!!address||/^\d{19}$/.test(query);
      const bridge=window.MapUiLocalBridge;
      const local=await bridge?.findStoredSearchRows?.(query,{signal:owner.signal,address:addressInput})||[];
      if(!current())return;
      const storedPoints=rows=>rows.map(row=>bridge?.storedSearchPoint?.(row)).filter(Boolean);
      const showStored=async rows=>{
        const points=storedPoints(rows);
        if(!points.length)return false;
        if(points.length===1&&rows.length===1)await pointFor(points[0],points[0].customerName||query);
        else{
          searchMessage('매장 또는 위치를 선택해 주세요.');
          for(const point of points){
            const button=element('button','coverage-search-result',[point.customerCode,point.customerName].filter(Boolean).join(' · ')||'저장 위치');
            button.type='button';button.onclick=()=>void pointFor(point,point.customerName||query).catch(failSearch);searchResults.append(button);
          }
        }
        return true;
      };
      if(await showStored(local)||!current())return;
      const adapter = window.KakaoMapsAdapter;
      let preserved,storedError;
      if(addressInput)try {
        // Address evidence belongs to the coordinate Snapshot, not the H3 release.
        const generation=bridge?.searchSnapshotGeneration?.()??null;
        preserved=await requests.stageAddress(query,generation,{signal:owner.signal});
        if(preserved&&(bridge?.searchSnapshotGeneration?.()??null)!==generation){
          throw Object.assign(Error('STAGE_BATCH_GENERATION_CHANGED'),{status:409,code:'STAGE_BATCH_GENERATION_CHANGED'});
        }
      } catch(error){ if ([401,403,409].includes(error.status)) throw error;storedError=error; }
      if (!current()) return;
      if(preserved?.customerCodes?.length&&bridge?.storedSearchCustomers&&
        bridge.storedSearchCustomers(preserved.customerCodes).length!==preserved.customerCodes.length){
        searchMessage('매장 주소가 변경되었습니다 · 현재 주소를 확인해 주세요.');return;
      }
      if (preserved?.point) { await pointFor(preserved.point,query); return; }
      if (preserved?.status==='OFFICIAL_ADDRESS_AMBIGUOUS' && preserved.points?.length) { candidatesFor(preserved.points); return; }
      if (preserved?.status==='ADDRESS_AMBIGUOUS') {
        const rows=bridge?.storedSearchCustomers?.(preserved.customerCodes||[])||[];
        if(rows.length>1&&await showStored(rows))return;
        searchMessage('같은 주소에 여러 위치가 있습니다. 시·군·구 또는 고객코드를 확인해 주세요.');return;
      }
      if(preserved?.status==='STORED_COORDINATE_UNVERIFIED'){searchMessage('등록 매장의 주소는 확인했으나 좌표 검증이 필요합니다.');return;}
      let coverageError;
      const data=await read('search','/search',params,{'x-map-customer-query':encodeURIComponent(query)}).catch(error=>{coverageError=error;return null;});
      if(!current())return;
      if (data?.results.length) { renderSearch(data,radius,true); return; }
      if (!addressInput) { if(coverageError)throw coverageError;if(data)renderSearch(data,radius,true);return; }
      if ([401,403].includes(coverageError?.status))throw coverageError;
      if (!window.KAKAO_MAP_CONFIG?.allowIndependentAddressLookup && !window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup) await adapter?.refreshAddressLookup?.();
      if (!current()) return;
      addressProxy ||= adapter?.geocoder?.();
      if (address && window.KAKAO_MAP_CONFIG?.allowIndependentAddressLookup===true && addressProxy?.serverProxy) {
        const result=await requests.lookup(addressProxy,address,{mode:'official',signal:owner.signal}).catch(error=>{
          if (error.code!=='OFFICIAL_ADDRESS_LOOKUP_DISABLED') throw error;
        });
        if (!current()) return;
        const points=(result?.rows||[]).map(row=>({lat:Number(row.y),lng:Number(row.x),coordinateSource:'OFFICIAL_PUBLIC_BUILDING'}));
        if (points.length===1) { await pointFor(points[0],result.resolution?.road||query); return; }
        if (points.length>1) { candidatesFor(points); return; }
      }
      const temporary=requests.temporaryPoint(query);
      if (temporary) { await pointFor(temporary,query); return; }
      if (!address) { searchMessage('승인된 자료에서 해당 필지 위치를 찾지 못했습니다.'); return; }
      if (window.KAKAO_MAP_CONFIG?.allowExternalAddressLookup !== true) {
        if(storedError||coverageError)throw storedError||coverageError;
        const reason=requests.message({code:window.KAKAO_MAP_CONFIG?.addressLookupReason||'GEOCODING_DISABLED'});
        searchMessage('저장·공식 자료에서 일치하는 위치 없음 · '+reason+' · 시·군·구를 확인해 주세요.');
        return;
      }
      if (!addressProxy?.serverProxy) throw Error('APPROVED_ADDRESS_PROXY_REQUIRED');
      searchMessage('승인된 주소 서비스에서 정확한 위치를 찾는 중입니다.');
      const reply = await requests.lookup(addressProxy,address,{mode:'address',signal:owner.signal});
      if (!active || searchOwner !== owner) return;
      const points=reply.rows.flatMap(row=>{
        const label=row.road_address?.address_name||row.address_name;
        if(!window.Phase2bUi.addressMatches(address,label))return [];
        return [{lat:Number(row.y),lng:Number(row.x),coordinateSource:'KAKAO_ADDRESS_TEMPORARY',label}];
      });
      if(points.length>1){candidatesFor(points);return;}
      if (points.length!==1||reply.resolution?.kind!=='EXACT') {
        searchMessage('일치하는 주소 좌표를 확인하지 못했습니다.');
        return;
      }
      await pointFor(points[0],points[0].label);
    } catch (error) {
      failSearch(error);
    } finally {if(current())pendingSearchKey=null;}
  }

  function changeFilters() {
    failedFilter = null;
    filterProgress();
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
  find('coverageResolution').onchange = () => { if (!focusedSearchRow) clearSelection(); void loadView(true); };
  find('coverageRefresh').onclick = () => void loadView(true);
  find('coverageFilterRetry').onclick = () => { if (failedFilter) { ({ days, center } = failedFilter); changeFilters(); } };
  panelToggle.onclick = () => collapsePanel(panelToggle.getAttribute('aria-expanded') === 'true');
  find('coverageSearch').onsubmit = search;
  find('coverageOverlapToggle').onchange=updateProviderPaths;
  for(const toggle of root.querySelectorAll('[data-coverage-provider]')) toggle.onchange=()=>{
    const id=toggle.dataset.coverageProvider;
    if(toggle.checked)enabledProviders.add(id);else enabledProviders.delete(id);
    updateProviderPaths();
    if(view)void loadProviderLayers(view);
  };
  find('coverageQuery').oninput = clearSearch;
  find('coverageRadius').onchange = clearSearch;
  find('coverageListFilter').onchange = () => { list = null; renderList(); void loadList(); };
  find('coverageListPrevious').onclick = () => void loadList(Math.max(0, listOffset - 12));
  find('coverageListMore').onclick = () => { if (list?.next != null) void loadList(list.next); };

  function resetView() {
    pointResults.clear();
    view = list = null;
    providerScope=providerViewKey='';
    providerMeta=null;
    providerCells=providerPaths=EMPTY;
    abort('providers');abort('provider-map');
    find('coverageProviderMapStatus').textContent='';
    renderProviderStates();
    viewTag = lastKey = listKey = '';
    viewSession = null;
    failedFilter = null;
    filterProgress();
    find('coverageMapCount').textContent = '';
    find('coverageMapSummary').hidden = true;
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
    for (const id of ['coverageNewCount','coverageHeldCount','coverageStoreBasis']) find(id).textContent = '—';
  }

  return {
    open() {
      if (view && viewSession !== currentSession()) resetView();
      active = true;
      root.hidden = false;
      sidebar.scrollTop = 0;
      filters();
      fitWorkspace();
      resize.observe(header);
      resize.observe(host);
      void startMap();
      refreshTimer = setInterval(() => { if (!document.hidden) void loadView(true); }, 60000);
    },
    close() {
      active = false;
      root.hidden = true;
      mapOwner++;
      resize.disconnect();
      clearTimeout(timer);
      clearInterval(refreshTimer);
      clearSearch();
      for (const controller of requests.values()) controller.abort();
      requests.clear();
      map?.suspend();
      pendingView = null;
      failedKey = '';
      failedFilter = null;
      filterProgress();
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
