import { createPostalGeometryReader, createPostalMap } from './postal-coverage-map.mjs?v=20261116-center';
import { createPostalAreaDetails } from './postal-area-details.mjs?v=20261116-center';
import { splitPostalBootstrap } from './postal-geometry.mjs';
import { coverageCenterBounds } from './coverage-center-viewport.mjs';

const API = '/api/map-phase2b/private/shadow-coverage/postal';
const labels = {
  HIGH: '배송 밀도 높음', LOW: '배송 밀도 낮음',
  CANDIDATE: '관측기간 미배송 후보', UNKNOWN: '자료 미확인',
};
const centerNames = { all: '전체', osan: '오산', honam: '호남', yeongnam: '영남' };
const osanLocalBounds = [126.67, 36.96, 127.29, 37.40];
const overviewReuseMs = 15000;
const fmt = new Intl.NumberFormat('ko-KR');
const node = (name, text) => Object.assign(document.createElement(name), { textContent: text });
const statsText = period => period?.days + '일 · ' + period?.start + ' ~ ' + period?.end;
const pointLocation = item => Number.isFinite(item?.lat) && Number.isFinite(item?.lng) ? [item.lat, item.lng] : null;
const hasDeliveryEvidence = ({completeness,summary}) => completeness.observed > 0 || summary.recorded > 0;

function request(endpoint, params, signal, headers) {
  const url = API + '/' + endpoint + '?' + new URLSearchParams(params);
  return fetch(url,{ credentials:'same-origin', cache:'no-store', signal, headers });
}

async function reply(response) {
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    const message = payload?.error || 'POSTAL_DATA_UNAVAILABLE';
    throw Object.assign(Error(message), { status: response.status, code: message });
  }
  return payload.data;
}

async function read(endpoint, params, signal, headers) {
  return reply(await request(endpoint,params,signal,headers));
}

async function firstViewport(params, signal) {
  const started = performance.now();
  const response = await request('bootstrap',params,signal);
  if (response.status === 404) return null;
  if (!response.ok) return reply(response);
  const raw = await response.arrayBuffer();
  signal.throwIfAborted();
  return { ...splitPostalBootstrap(raw), duration:performance.now() - started };
}

export function createCoveragePanel({ workspace, header, openStore }) {
  const root = document.createElement('main');
  root.id = 'shadowCoverage';
  root.className = 'shadow-coverage postal-coverage';
  root.hidden = true;
  root.setAttribute('aria-labelledby', 'coverageTitle');
  root.innerHTML = '<aside id="coverageSidebar" class="coverage-sidebar" aria-label="음영권역 분석">' +
    '<div class="coverage-heading"><h1 id="coverageTitle">우편번호별 음영권역</h1>' +
    '<button type="button" id="coveragePanelToggle" aria-controls="coverageAnalysis" aria-expanded="true">분석 접기</button></div>' +
    '<form class="coverage-search" id="coverageSearch"><label for="coverageQuery">주소·고객코드·우편번호 검색</label>' +
    '<div class="coverage-search-row"><input id="coverageQuery" type="search" placeholder="주소, 매장명, 고객코드, 5자리 우편번호" ' +
    'maxlength="200" required autocomplete="off"><button type="submit" class="coverage-primary">검색</button></div></form>' +
    '<div id="coverageSearchResults" class="coverage-results" aria-live="polite"></div>' +
    '<div id="coverageAnalysis"><div class="coverage-filters"><label>자료 기간 <select id="coverageDays">' +
    '<option value="30">30일</option><option value="60">60일</option><option value="90" selected>90일</option></select></label>' +
    '<label>담당 센터 <select id="coverageCenter"><option value="all">전체</option><option value="osan">오산</option>' +
    '<option value="yeongnam">영남</option><option value="honam">호남</option></select></label>' +
    '<label>검색 반경 <select id="coverageRadius"><option value="0">구역만</option><option value="500">500m</option>' +
    '<option value="1000">1km</option></select></label></div>' +
    '<div id="postalOverview"><div class="coverage-overview"><h2 id="postalOverviewTitle">전국 집계</h2><p id="postalPeriod"></p><p id="postalObserved"></p>' +
    '<p class="coverage-note" id="postalRegistryScope">매장 수는 게시 자료 기준입니다. 최신 전체 등록 현황은 확인이 필요합니다.</p>' +
    '<dl class="coverage-kpis"><div><dt>게시본 등록 매장</dt><dd data-postal-kpi="registered" aria-describedby="postalRegistryScope">—</dd></div>' +
    '<div><dt>좌표 연결 배송</dt><dd data-postal-kpi="visits">—</dd></div>' +
    '<div><dt>표시 대상 구역</dt><dd data-postal-kpi="scopedAreas">—</dd></div>' +
    '<div><dt>배송 있는 구역</dt><dd data-postal-kpi="delivered">—</dd></div>' +
    '<div><dt>미배송 후보 구역</dt><dd data-postal-kpi="candidate">—</dd></div>' +
    '<div><dt>활성 오산신규</dt><dd data-postal-kpi="newActive">—</dd></div>' +
    '<div><dt>오산보류 이력</dt><dd data-postal-kpi="held">—</dd></div></dl></div>' +
    '<div class="coverage-legend postal-legend" aria-label="배송 분류 범례">' +
    Object.entries(labels).map(([key, label]) => '<span data-postal-tone="' + key + '">' + label + '</span>').join('') + '</div>' +
    '<p class="coverage-note" id="postalFormula"></p><p class="coverage-note" id="postalNewEvidence"></p>' +
    '<div class="coverage-legend postal-badges" aria-label="오산 매장 상태">' +
    '<span data-postal-badge="active">오산신규 배송 확인</span><span data-postal-badge="unverified">오산신규 배송 미확인</span>' +
    '<span data-postal-badge="held">오산보류 이력</span></div>' +
    '<button type="button" id="postalUnmatched">미매칭 업장</button>' +
    '<div class="coverage-list postal-candidates"><h2>관측기간 미배송 후보</h2><div id="postalCandidates"></div></div>' +
    '<details class="coverage-evidence"><summary>경계 출처와 원천 날짜</summary><div id="postalEvidence"></div></details></div>' +
    '<section class="coverage-detail" id="coverageDetail" aria-label="우편번호 구역 상세" hidden></section></div></aside>' +
    '<section class="coverage-map-area" aria-label="국가기초구역 배송분포 지도"><div id="coverageMap"></div>' +
    '<div class="postal-map-controls" role="group" aria-label="지도 보기"><button type="button" data-preset="nation">전국</button>' +
    '<button type="button" data-preset="region">오산·화성</button><button type="button" id="postalZoomIn" aria-label="지도 확대">+</button>' +
    '<button type="button" id="postalZoomOut" aria-label="지도 축소">−</button></div>' +
    '<p id="postalMapSource" class="postal-map-source"></p>' +
    '<div id="coverageMapState" class="coverage-map-state" hidden><p id="coverageMapMessage" role="status"></p>' +
    '<button type="button" id="coverageRetry" hidden>다시 시도</button></div></section>';
  workspace.after(root);

  const find = id => root.querySelector('#' + id);
  const host = find('coverageMap'), mapState = find('coverageMapState'), mapText = find('coverageMapMessage');
  const detail = find('coverageDetail'), status = find('coverageRetry');
  const searchResults = find('coverageSearchResults'), geometry = createPostalGeometryReader(API);
  const regionButton = root.querySelector('[data-preset="region"]');
  let map, active = false, owner = 0, viewportRead, detailRead, searchRead, view, viewKey, loadingKey;
  let timer, refresh, selectedArea, bootstrapScope, releaseOverview;
  const resize = new ResizeObserver(entries => {
    if (!active) return;
    if (entries.some(entry => entry.target === header)) windowHeight();
    if (entries.some(entry => entry.target === host) && map) { map.relayout(); scheduleView(); }
  });
  const baseScope = () => ({ days: find('coverageDays').value, center: find('coverageCenter').value });
  const scope = () => view ? { days: view.period.days, center: view.center, generation: view.generation } : baseScope();
  const timeout = signal => AbortSignal.any([signal, AbortSignal.timeout(16000)]);
  const areaDetails = createPostalAreaDetails(detail, { read, dismiss:() => { detailRead?.abort(); areaCard(null); }, openStore });
  function windowHeight() {
    root.style.setProperty('--coverage-header-height', header.getBoundingClientRect().height + 'px');
  }
  function message(text = '', retry = null) {
    mapState.hidden = !text;
    mapText.textContent = text;
    status.hidden = !retry;
    status.onclick = retry;
  }
  function collapse(hidden) {
    root.classList.toggle('coverage-panel-collapsed', hidden);
    find('coveragePanelToggle').textContent = hidden ? '분석 펼치기' : '분석 접기';
    find('coveragePanelToggle').setAttribute('aria-expanded', String(!hidden));
  }

  function areaCard(area) {
    selectedArea = area;
    const geographic = area && area.id !== 'unmatched' ? area : null;
    map?.select(geographic);
    root.classList.toggle('postal-area-active',!!area);
    areaDetails.open(area,scope());
    if (area) collapse(false);
  }

  function pickArea(area, location) {
    const point = location || area?.location;
    const radius = Number(find('coverageRadius').value);
    if (point) map?.focus(point, null, location ? radius : 0);
    if (location) map?.point(location, radius);
    areaCard(area);
  }
  async function choosePoint(location, fromSearch = false, signal) {
    if (!view) return;
    detailRead?.abort();
    const request = detailRead = new AbortController();
    try {
      const data = await read('point', { ...scope(), radius: fromSearch ? find('coverageRadius').value : 0 },
        timeout(signal ? AbortSignal.any([signal, request.signal]) : request.signal),
        { 'X-Map-Coverage-Point': location.map(value => Number(value.toFixed(9))).join(',') });
      if (!active || detailRead !== request || signal?.aborted) return;
      if (!data.area) {
        areaCard(null);
        searchResults.replaceChildren(node('p', data.state === 'AMBIGUOUS' ? '경계에 여러 우편번호가 닿아 있습니다.' : '공식 경계에서 우편번호를 찾지 못했습니다.'));
      } else if (fromSearch) pickArea(data.area, location);
      else areaCard(data.area);
    } catch (error) {
      if (active && detailRead === request && !signal?.aborted && !request.signal.aborted) {
        if (error.status === 409) void readView(true);
        message('우편번호 구역을 확인하지 못했습니다.', () => void choosePoint(location, fromSearch));
      }
    }
  }

  function applyView(data, sameScope) {
    const { completeness, summary, source } = data;
    const observed = hasDeliveryEvidence(data);
    root.dataset.postalView = JSON.stringify({ days: data.period.days, center: data.center, tier: data.tier,
      observed: completeness.observed, missing: completeness.missing.length, registered: summary.registered, visits: summary.visits,
      assignmentHeldStores:summary.assignmentHeldStores, assignmentHeldVisits:summary.assignmentHeldVisits,
      areas: summary.areas, active: summary.newActive, unknown: summary.newUnknown, held: summary.held,
      high: summary.high, low: summary.low, candidate: summary.candidate, unknownAreas: summary.unknown,
      recorded: summary.recorded, hasDeliveryEvidence: observed, scopedAreas: summary.scopedAreas,
      unverifiedScopedAreas: summary.unverifiedScopedAreas });
    if (sameScope) return;
    find('postalOverviewTitle').textContent = data.center === 'all' ? '전국 집계' : centerNames[data.center] + '센터 집계';
    find('postalPeriod').textContent = statsText(data.period) + ' · ' + centerNames[data.center];
    find('postalObserved').textContent = (observed ? '배송 ' + completeness.observed + '/' + data.period.days + '일 관측'
      : '배송 자료 미확인') + ' · 미확인 ' + completeness.missing.length + '일';
    const kpis = { ...summary, delivered: summary.high + summary.low };
    if (!observed) kpis.visits = kpis.delivered = kpis.candidate = null;
    root.querySelectorAll('[data-postal-kpi]').forEach(entry => {
      const value = kpis[entry.dataset.postalKpi];
      entry.textContent = value == null ? '미확인' : fmt.format(value);
    });
    find('postalFormula').textContent = '밀도 = 좌표 연결 배송 ÷ 구역 면적. ' + data.densityHighAt + '건/km²부터 높음.';
    find('postalNewEvidence').textContent = '오산신규 배송 미확인 ' + fmt.format(summary.newUnknown) + '곳 · 등록 매장 구역 중 자료 미확인 ' +
      fmt.format(summary.unverifiedScopedAreas) + '곳';
    find('postalUnmatched').textContent = '우편번호 미매칭 ' + fmt.format(summary.unmatchedStores) + '곳 보기';
    find('postalMapSource').textContent = source.label + ' · ' + (source.asOf || '경계 기준일 미공개');
    const credit = node('a', source.label);
    credit.href = source.url; credit.target = '_blank'; credit.rel = 'noopener';
    const dates = node('p', '배송 원천 미확인 ' + (completeness.sourceMissing.join(' · ') || '0일'));
    find('postalEvidence').replaceChildren(credit,
      node('p', source.version + ' · 경계 배포 기준일 ' + (source.asOf || '미공개') +
        (source.sourceChangeAsOf ? ' · 제공 속성 최신 변경일 ' + source.sourceChangeAsOf : '')),
      node('p', '관측 일수 ' + ['osan','yeongnam','honam'].map(key => centerNames[key] + ' ' +
        (completeness.centerObserved[key] ? completeness.centerObserved[key] + '일' : '미확인')).join(' · ')),
      node('p', '주소·좌표 미연결 배송 ' + fmt.format(summary.unplaced) + '건 · 경계 미연결 배송 ' +
        fmt.format(summary.boundaryUnplaced) + '건 · 경계 미연결 등록 매장 ' + fmt.format(summary.unmatchedStores) + '곳'),
      node('p', '경계 배정 보류 매장 ' + fmt.format(summary.assignmentHeldStores ?? 0) + '곳 · 배송 ' +
        fmt.format(summary.assignmentHeldVisits ?? 0) + '건은 구역별 집계에서 보류'),
      node('p', '원천 전체 수집 완전성 미확인 ' + completeness.unverified.length + '일'),
      dates);
    const list = data.candidates.slice(0, 12).map(area => {
      const button = node('button', area.id + ' · 등록 ' + fmt.format(area.registered) + '곳');
      button.type = 'button'; button.className = 'coverage-search-result'; button.onclick = () => pickArea(area);
      return button;
    });
    find('postalCandidates').replaceChildren(...(list.length ? list : [node('p', observed
      ? '현재 범위에서 확인된 후보가 없습니다.' : '배송 자료 미확인')]));
  }

  async function readView(force = false) {
    if (!active || !map) return;
    const { box, level, world } = map.viewport(), params = baseScope();
    const key = [params.days,params.center,level,Boolean(world), ...box.map(value => value.toFixed(5))].join(':');
    const first = !view && Boolean(world);
    const firstScope = first ? [params.days,params.center].join(':') : null;
    if (loadingKey === key || (!force && key === viewKey) || (first && firstScope === bootstrapScope)) return;
    viewportRead?.abort();
    const controller = viewportRead = new AbortController();
    loadingKey = key;
    bootstrapScope = firstScope;
    if (!view) message('우편번호 경계를 불러오는 중입니다.');
    try {
      const signal = timeout(controller.signal);
      const requested = { ...params, level, ...(world ? { indexed:'1' } : {}),
        box:box.map(value => value.toFixed(5)).join(',') };
      // Refresh the protected view before using any versioned overview cache.
      const frame = first && !geometry.hasOverview() ? await firstViewport(requested,signal) : null;
      const data = frame?.view || await read('view',requested,signal);
      if (!active || viewportRead !== controller) return;
      const slices = frame ? geometry.acceptBootstrap(data,frame.bytes,frame.duration) : await geometry.read(data,signal);
      if (!active || viewportRead !== controller) return;
      const same = view?.period.days === data.period.days && view.center === params.center && view.generation === data.generation &&
        view.boundary === data.boundary && view.assignmentReview === data.assignmentReview;
      view = { ...data, center: params.center };
      viewKey = key;
      host.dataset.postalGeometry = JSON.stringify({ indexed:Boolean(data.overview), combined:Boolean(frame), ...geometry.metrics() });
      applyView(view,same);
      map.show(view, slices);
      if (!same && selectedArea) {
        selectedArea = { id:selectedArea.id };
        areaDetails.open(selectedArea,scope());
      }
      const stale = data.stale ? '마지막 확인 ' + data.period.end + ' 기준' : '';
      const missing = !hasDeliveryEvidence(data) ? '선택 범위의 배송 자료 미확인' : '';
      message([stale, missing].filter(Boolean).join(' · '));
    } catch (error) {
      if (!active || viewportRead !== controller || controller.signal.aborted) return;
      const reason = error.code === 'POSTAL_GENERATION_MISMATCH' ? '최신 원장과 우편번호 자료의 세대가 다릅니다.'
        : error.code === 'POSTAL_DATA_UNCONFIGURED' ? '국가기초구역 자료 연결을 확인해 주세요.'
        : error.code?.startsWith('POSTAL_ASSIGNMENT_REVIEW_') ? '경계 배정 확인 자료를 연결해 주세요.' : '우편번호 자료를 읽지 못했습니다.';
      message(reason + (view ? ' 이전 화면을 유지합니다.' : ''), () => void readView(true));
    } finally {
      if (viewportRead === controller) {
        loadingKey = bootstrapScope = null;
        if (first && viewKey === key) scheduleView();
      }
    }
  }

  function scheduleView() {
    if (!active) return;
    clearTimeout(timer);
    timer = setTimeout(() => void readView(), 60);
  }
  async function start(retryFailed = false) {
    const attempt = ++owner;
    try {
      if (!map) {
        message('지도를 불러오는 중입니다.');
        const { maps } = await window.KakaoMapsAdapter.ready({ retryFailed });
        if (!active || attempt !== owner) return;
        map = createPostalMap(host, maps, { idle: scheduleView, select: location => void choosePoint(location) });
        map.focus(null, coverageCenterBounds(baseScope().center));
      }
      map.relayout();
      void readView(true);
    } catch {
      if (active && attempt === owner) message('지도를 불러오지 못했습니다.', () => void start(true));
    }
  }

  function searchItems(rows, signal, query) {
    const buttons = rows.map(row => {
      const button = node('button', (row.name || query) + (row.assignmentPending ? ' · 우편번호 미확인' : ''));
      button.type = 'button'; button.className = 'coverage-search-result';
      button.onclick = () => {
        if (!active || signal.aborted) return;
        if (row.kind === 'store' && !row.area) {
          if (!openStore?.(row)) areaCard({ id:'unmatched' });
          return;
        }
        if (!row.location) { searchResults.replaceChildren(node('p', '등록 매장의 위치와 우편번호 연결을 확인해 주세요.')); return; }
        if (row.kind === 'store' && Number(find('coverageRadius').value)) void choosePoint(row.location, true, signal);
        else if (row.area || row.kind === 'area') pickArea(row.area || row, row.kind === 'store' ? row.location : null);
        else if (row.kind === 'region') { map.focus(row.location, row.bounds); void choosePoint(row.location, false, signal); }
        else void choosePoint(row.location, true, signal);
      };
      return button;
    });
    searchResults.replaceChildren(...buttons);
    if (rows.length === 1 && rows[0].exact !== false && !rows[0].assignmentPending) buttons[0].click();
  }

  async function existingAddress(query, signal) {
    const requests = window.NewAreaRequests, bridge = window.MapUiLocalBridge, config = () => window.KAKAO_MAP_CONFIG;
    if (!requests) return [];
    const address = requests.addressQuery(query, window.Phase2bUi?.addressVariants);
    const officialInput = address || /^\d{19}$/.test(query);
    if (!officialInput) return [];
    const locally = await bridge?.findStoredSearchRows?.(query, { signal, address: true }) || [];
    const localPoints = locally.map(row => bridge?.storedSearchPoint?.(row)).filter(Boolean);
    if (localPoints.length) return localPoints.map(point => ({ name: point.customerName || query, location: pointLocation(point) }));
    const generation = bridge?.searchSnapshotGeneration?.() ?? null;
    const preserved = await requests.stageAddress(query, generation, { signal }).catch(error => {
      if ([401, 403, 409].includes(error.status)) throw error;
      return null;
    });
    if ((bridge?.searchSnapshotGeneration?.() ?? null) !== generation) throw Object.assign(Error('Coverage snapshot changed'), { status:409 });
    if (preserved?.point) return [{ name: query, location: pointLocation(preserved.point) }];
    if (preserved?.points?.length) return preserved.points.map((point, i) => ({ name: '공식 위치 ' + (i + 1), location: pointLocation(point) }));
    if (preserved?.status === 'ADDRESS_AMBIGUOUS') {
      const matches = bridge?.storedSearchCustomers?.(preserved.customerCodes || []) || [];
      return matches.map(row => bridge?.storedSearchPoint?.(row)).filter(Boolean)
        .map(point => ({ name: point.customerName || query, location: pointLocation(point) }));
    }
    if (preserved?.status === 'STORED_COORDINATE_UNVERIFIED') {
      throw Object.assign(Error('등록 매장 좌표 미확인'), { code: 'POSTAL_ADDRESS_UNVERIFIED' });
    }
    if (!address) return [];
    const adapter = window.KakaoMapsAdapter;
    if (!config()?.allowIndependentAddressLookup) await adapter?.refreshAddressLookup?.();
    const geocoder = adapter?.geocoder?.();
    if (!config()?.allowIndependentAddressLookup || !geocoder?.serverProxy || signal.aborted) return [];
    const approved = await requests.lookup(geocoder, address, { mode: 'official', signal });
    return (approved?.rows || []).map((row, i) => ({
      name: approved.rows.length === 1 ? approved.resolution?.road || query : '공식 위치 ' + (i + 1),
      location: pointLocation({ lat: Number(row.y), lng: Number(row.x) }),
    }));
  }

  async function search(event) {
    event.preventDefault();
    if (!active || !view) return;
    const query = find('coverageQuery').value.normalize('NFKC').trim();
    if (query.length < 2) return;
    searchRead?.abort();
    const request = searchRead = new AbortController();
    const signal = timeout(request.signal);
    searchResults.replaceChildren(node('p', '주소와 매장을 찾고 있습니다.'));
    try {
      let rows = await read('search', scope(), signal, { 'X-Map-Customer-Query': encodeURIComponent(query) });
      if (!rows.length) rows = await existingAddress(query, signal);
      if (!active || searchRead !== request || request.signal.aborted) return;
      if (rows.length) searchItems(rows, signal, query);
      else searchResults.replaceChildren(node('p', '승인된 주소 자료와 매장 목록에서 검색 결과가 없습니다.'));
    } catch (error) {
      if (!active || searchRead !== request || request.signal.aborted) return;
      if (error.status === 409) void readView(true);
      searchResults.replaceChildren(node('p', error.code === 'POSTAL_ADDRESS_UNVERIFIED' ?
        '등록 주소의 좌표 검증이 필요합니다.' : '검색을 완료하지 못했습니다. 다시 시도해 주세요.'));
    }
  }

  function reset(keepOverview = false) {
    clearTimeout(timer);
    clearTimeout(releaseOverview);
    [viewportRead, detailRead, searchRead].forEach(request => request?.abort());
    viewportRead = detailRead = searchRead = null;
    view = viewKey = loadingKey = bootstrapScope = null;
    geometry.clear(keepOverview);
    delete host.dataset.postalGeometry;
    map?.clear(keepOverview && geometry.hasOverview());
    areaCard(null);
    searchResults.replaceChildren();
    find('coverageQuery').value = '';
    find('postalCandidates').replaceChildren();
    find('postalEvidence').replaceChildren();
    for (const id of ['postalPeriod','postalObserved','postalFormula','postalNewEvidence','postalMapSource']) find(id).textContent = '';
    root.querySelectorAll('[data-postal-kpi]').forEach(entry => { entry.textContent = '—'; });
    delete root.dataset.postalView;
    message();
  }

  find('coveragePanelToggle').onclick = () => collapse(!root.classList.contains('coverage-panel-collapsed'));
  find('postalUnmatched').onclick = () => { if (view) areaCard({ id:'unmatched' }); };
  find('coverageSearch').onsubmit = search;
  find('coverageQuery').oninput = () => { searchRead?.abort(); searchResults.replaceChildren(); };
  find('coverageRadius').onchange = () => { searchRead?.abort(); searchResults.replaceChildren(); map?.point(null); };
  function changeScope(centerChanged) {
    searchRead?.abort();
    detailRead?.abort();
    searchResults.replaceChildren();
    if (centerChanged) {
      const {center} = baseScope();
      viewportRead?.abort();
      areaCard(null);
      map?.point(null);
      map?.focus(null, coverageCenterBounds(center));
      regionButton.textContent = center === 'all' || center === 'osan' ? '오산·화성' : centerNames[center];
      if (view?.center !== center) message(centerNames[center] + ' 센터 자료를 불러오는 중입니다.');
    }
    scheduleView();
  }
  find('coverageDays').onchange = () => changeScope(false);
  find('coverageCenter').onchange = () => changeScope(true);
  root.querySelector('[data-preset="nation"]').onclick = () => map?.focus(null, coverageCenterBounds('all'));
  regionButton.onclick = () => {
    const {center} = baseScope();
    map?.focus(null, center === 'all' || center === 'osan' ? osanLocalBounds : coverageCenterBounds(center));
  };
  find('postalZoomIn').onclick = () => map?.zoom(-1);
  find('postalZoomOut').onclick = () => map?.zoom(1);

  return {
    open() {
      clearTimeout(releaseOverview);
      active = true;
      root.hidden = false;
      windowHeight();
      resize.observe(header);
      resize.observe(host);
      void start();
      refresh = setInterval(() => { if (active && !document.hidden) void readView(true); }, 60000);
    },
    close() {
      active = false;
      owner++;
      root.hidden = true;
      clearInterval(refresh);
      resize.disconnect();
      reset(true);
      if (geometry.hasOverview()) releaseOverview = setTimeout(() => {
        geometry.clear();
        map?.clear();
      },overviewReuseMs);
    },
    invalidate() { reset(); if (active) void readView(true); },
    disposeMap() {
      reset();
      map?.destroy();
      map = null;
      find('coverageDays').value = '90';
      find('coverageCenter').value = 'all';
      regionButton.textContent = '오산·화성';
      find('coverageRadius').value = '0';
      collapse(false);
      host.replaceChildren();
    },
  };
}
