import { createPostalGeometryReader, createPostalMap } from './postal-coverage-map.mjs?v=20261127-viewport-priority';
import { createPostalAreaDetails } from './postal-area-details.mjs?v=20261126-reentry';
import { postalTilesLevel, splitPostalBootstrap } from './postal-geometry.mjs?v=20261127-viewport-priority';
import { createCurrentRegistrationPanel } from './postal-current-registration-panel.mjs?v=20261124-current-registration';
import { coverageCenterBounds } from './coverage-center-viewport.mjs';

const API = '/api/map-phase2b/private/shadow-coverage/postal';
const noPostalItems = [];
const recentOperationsApi = '/api/map-phase2b/private/recent-operations';
const labels = {
  HIGH: '배송 밀도 높음', LOW: '배송 밀도 낮음',
  CANDIDATE: '기간 내 미배송 확인', UNKNOWN: '자료 미확인',
};
const operationLabels = { COMPLETED:'배송완료 근거', DISPATCH:'배차확정 근거', ORDER:'주문확정 근거', UNKNOWN:'운영이력 확인 필요' };
const dispatchLabels = { HIGH:'배차 밀도 높음', LOW:'배차 밀도 낮음', UNKNOWN:'배차 근거 미확인' };
const centerNames = { all: '전체', osan: '오산', honam: '호남', yeongnam: '영남' };
const osanLocalBounds = [126.67, 36.96, 127.29, 37.40];
const fmt = new Intl.NumberFormat('ko-KR');
const node = (name, text) => Object.assign(document.createElement(name), { textContent: text });
const statsText = period => period?.days + '일 · ' + period?.start + ' ~ ' + period?.end;
const evidenceDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? value.slice(5).replace('-', '/') : null;
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

async function viewportFrame(params, signal, known) {
  const started = performance.now();
  const response = await request('bootstrap',params,signal,known ? {'X-Map-Postal-Known':known} : undefined);
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
    '<form class="coverage-search" id="coverageSearch"><label for="coverageQuery">주소·매장명·고객코드·우편번호 검색</label>' +
    '<div class="coverage-search-row"><input id="coverageQuery" type="search" placeholder="주소, 매장명, 고객코드, 5자리 우편번호" ' +
    'maxlength="200" required autocomplete="off"><button type="submit" class="coverage-primary">검색</button></div></form>' +
    '<div class="postal-scope"><label id="postalLayerControl" hidden>지도 표시 기준 <select id="postalLayer" class="field">' +
    '<option value="archive">배송 밀도 게시본</option><option value="operations">최신 운영 근거</option>' +
    '<option value="dispatch-density" disabled hidden>배차 기준 밀도</option></select></label>' +
    '<div class="coverage-filters"><label>지도 집계 기간 <select id="coverageDays">' +
    '<option value="7" disabled hidden>7일</option><option value="30">30일</option><option value="60">60일</option><option value="90" selected>90일</option></select></label>' +
    '<label>담당 센터 <select id="coverageCenter"><option value="all">전체</option><option value="osan">오산</option>' +
    '<option value="yeongnam">영남</option><option value="honam">호남</option></select></label>' +
    '<label>검색 반경 <select id="coverageRadius"><option value="0">구역만</option><option value="500">500m</option>' +
    '<option value="1000">1km</option></select></label></div></div>' +
    '<div id="coverageSearchResults" class="coverage-results" aria-live="polite"></div>' +
    '<div id="coverageAnalysis">' +
    '<section class="coverage-detail" id="postalOperationsDetail" aria-label="우편번호 운영 근거 상세" hidden></section>' +
    '<section class="coverage-detail" id="coverageDetail" aria-label="우편번호 구역 상세" hidden></section>' +
    '<div id="postalArchive" class="coverage-list postal-candidates"><h2>미배송 확인 구역</h2><div id="postalCandidates"></div></div>' +
    '<details class="coverage-evidence" id="postalCurrentRegistration" hidden><summary>현재 등록 매장</summary>' +
    '<p data-current-postal-summary aria-live="polite"></p><div data-current-postal-roster aria-live="polite"></div></details>' +
    '<details class="coverage-evidence postal-data-status" id="postalDataStatus"><summary>자료 현황</summary>' +
    '<div id="postalOperations" hidden aria-live="polite"><div class="coverage-overview" id="postalOperationsSummary"></div></div>' +
    '<div id="postalArchiveStatus"><div id="postalOverview"><div class="coverage-overview"><h2 id="postalOverviewTitle">전국 집계</h2><p id="postalPeriod"></p><p id="postalObserved"></p>' +
    '<p class="coverage-note" id="postalRegistryScope">매장 수는 게시 자료 기준입니다. 최신 전체 등록 현황은 확인이 필요합니다.</p>' +
    '<dl class="coverage-kpis"><div><dt>게시본 등록 매장</dt><dd data-postal-kpi="registered" aria-describedby="postalRegistryScope">—</dd></div>' +
    '<div><dt>좌표 연결 배송</dt><dd data-postal-kpi="visits">—</dd></div>' +
    '<div><dt>표시 대상 구역</dt><dd data-postal-kpi="scopedAreas">—</dd></div>' +
    '<div><dt>배송 있는 구역</dt><dd data-postal-kpi="delivered">—</dd></div>' +
    '<div><dt>미배송 확인 구역</dt><dd data-postal-kpi="candidate">—</dd></div>' +
    '<div><dt>활성 오산신규</dt><dd data-postal-kpi="newActive">—</dd></div>' +
    '<div><dt>오산보류 이력</dt><dd data-postal-kpi="held">—</dd></div></dl></div>' +
    '<p class="coverage-note" id="postalFormula"></p><p class="coverage-note" id="postalNewEvidence"></p>' +
    '<div class="coverage-legend postal-badges" aria-label="오산 매장 상태">' +
    '<span data-postal-badge="active">오산신규 배송 확인</span><span data-postal-badge="unverified">오산신규 배송 미확인</span>' +
    '<span data-postal-badge="held">오산보류 이력</span></div>' +
    '<button type="button" id="postalUnmatched">미매칭 업장</button>' +
    '<details class="coverage-evidence"><summary>경계 출처와 원천 날짜</summary><div id="postalEvidence"></div></details></div>' +
    '<details class="coverage-evidence" id="recentOperationWindow"><summary>기간별 운영 근거</summary>' +
    '<label>운영이력 기간 <select id="recentOperationDays"><option value="7">7일</option><option value="30">30일</option>' +
    '<option value="60">60일</option><option value="90" selected>90일</option></select></label>' +
    '<div id="recentOperationSummary" aria-live="polite"></div></details></details></div></aside>' +
    '<section class="coverage-map-area" aria-label="국가기초구역 배송분포 지도"><div id="coverageMap"></div>' +
    '<div id="postalMapLegend" class="postal-map-legend">' +
    '<div id="postalLegendArchive" class="coverage-legend postal-legend" aria-label="배송 밀도 범례">' +
    Object.entries(labels).map(([key,label])=>'<span data-postal-tone="'+key+'">'+label+'</span>').join('')+'</div>' +
    '<div id="postalLegendOperations" class="coverage-legend postal-legend" aria-label="최신 운영 근거 범례" hidden>' +
    Object.entries(operationLabels).map(([key,label])=>'<span data-postal-tone="'+key+'">'+label+'</span>').join('')+'</div>' +
    '<div id="postalLegendDispatch" class="coverage-legend postal-legend" aria-label="배차 기준 밀도 범례" hidden>' +
    Object.entries(dispatchLabels).map(([key,label])=>'<span data-postal-tone="'+key+'">'+label+'</span>').join('')+'</div></div>' +
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
  let timer, refresh, selectedArea, bootstrapScope, recentOperationRead;
  let operationsCache, operationsPending, operationsDetailRead, operationsDisplayed;
  const viewCache = new Map();
  let submittedSearch = '', searchNeedsRefresh = false;
  const resize = new ResizeObserver(entries => {
    if (!active) return;
    if (entries.some(entry => entry.target === header)) windowHeight();
    if (entries.some(entry => entry.target === host) && map) { map.relayout(); scheduleView(); }
  });
  const range = () => find('coverageDays').value;
  const layer = () => find('postalLayer').value;
  const latest = () => layer() !== 'archive';
  const dispatchDensity = () => layer() === 'dispatch-density';
  const baseScope = () => ({ days: range()==='7'?'90':range(), center: find('coverageCenter').value });
  const scope = () => view ? { days: view.period.days, center: view.center, generation: view.generation } : baseScope();
  const timeout = signal => AbortSignal.any([signal, AbortSignal.timeout(16000)]);
  const areaDetails = createPostalAreaDetails(detail, { read, dismiss:() => { detailRead?.abort(); areaCard(null); }, openStore });
  const currentRegistration=createCurrentRegistrationPanel(find('postalCurrentRegistration'),{read,openStore});
  function updateCurrentRegistration(refresh=false) {
    currentRegistration.update({available:view?.currentRegistrationAvailable,generation:view?.generation,
      center:baseScope().center,area:selectedArea?.id,refresh});
  }
  const operationsParameters = generation => ({days:range(),center:baseScope().center,generation});
  const operationFigures = ({registered,observed,orders,dispatch,completed}) =>
    ['권역 게시본 등록 '+fmt.format(registered)+'곳','운영 근거 확인 '+fmt.format(observed)+'곳',
      '주문확정 '+fmt.format(orders)+'곳 · 배차확정 '+fmt.format(dispatch)+'곳 · 배송완료 '+fmt.format(completed)+'곳'];

  function cancelOperations() {
    operationsPending?.controller.abort();
    operationsPending = null;
  }

  async function readOperations(generation, signal) {
    const endpoint=layer(),params=operationsParameters(generation),key=JSON.stringify([endpoint,params]);
    signal.throwIfAborted();
    if (operationsCache?.key===key && operationsCache.until>Date.now()) return operationsCache.data;
    if (operationsPending?.key !== key) {
      cancelOperations();
      const controller = new AbortController(), pending = { key,controller };
      pending.work = read(endpoint,params,timeout(controller.signal)).then(data => {
        controller.signal.throwIfAborted();
        operationsCache={key,data,until:Date.now()+50000};
        return data;
      }).finally(() => {
        if (operationsPending === pending) operationsPending = null;
      });
      operationsPending = pending;
    }
    const data = await operationsPending.work;
    signal.throwIfAborted();
    return data;
  }

  function showOperations(data) {
    const target=find('postalOperationsSummary');
    if(dispatchDensity()) {
      if(!data||!data.observedDays) {target.replaceChildren(node('p','확정배차 자료 미확인'));return;}
      const {period,summary}=data;
      target.replaceChildren(node('h2','배차 기준 밀도'),node('p',statsText(period)),
        node('p','좌표 연결 '+fmt.format(summary.located)+'건 · 위치·권역 미확인 '+fmt.format(summary.unlocated)+'건'),
        node('p','자료가 확인된 날짜·센터 '+fmt.format(summary.observedScopeDays)+'건 · 미확인 '+fmt.format(summary.missingScopeDays)+'건'),
        node('p','같은 배송일에는 매장 한 곳을 한 건으로 계산합니다. 현재 위치로 확인된 배차 건수를 권역 면적(㎢)으로 나눕니다.'));
      return;
    }
    if (!data) { target.replaceChildren(node('p','운영이력 확인 필요')); return; }
    const {period,publishedThrough,summary}=data;
    target.replaceChildren(node('h2','최신 운영 근거'),node('p',statsText(period)),
      node('p','운영이력 원장 기준 '+publishedThrough),...operationFigures(summary).map(text=>node('p',text)),
      node('p','근거 확인 권역 '+fmt.format(summary.observedAreas)+'곳 · 운영이력 미확인 권역 '+fmt.format(summary.missingAreas)+'곳'),
      node('p','한 매장에 여러 근거가 있을 수 있습니다. 권역 연결이 확인된 매장만 색상에 반영합니다.'));
  }

  function showMapEvidence() {
    const target=find('postalMapSource');
    const data=latest()?operationsDisplayed:view;
    const date=evidenceDate(latest()?data?.publishedThrough:data?.period?.end);
    const days=data?.period?.days;
    const observed=latest()?data?.observedDays:data?.completeness?.observed;
    if(!date||!Number.isInteger(days)||!Number.isInteger(observed)||observed<0||observed>days){target.textContent='';return;}
    const basis=dispatchDensity()?'배차집계 ':latest()?'운영이력 ':'배송집계 ';
    target.textContent=basis+date+' 기준 · '+days+'일 중 '+observed+'일 '+(dispatchDensity()?'배차 근거 확인':'자료 확인');
  }

  async function showOperationsArea(area, offset=0) {
    const panel=find('postalOperationsDetail');
    operationsDetailRead?.abort();
    panel.replaceChildren();
    panel.hidden=!area;
    if (!area) return;
    const endpoint=layer(),isDispatch=endpoint==='dispatch-density';
    const action=(label,run)=>Object.assign(node('button',label),{type:'button',onclick:run});
    const title=node('h2',area.id==='unmatched'?'권역 연결 미확인':'우편번호 '+area.id);
    const line=node('p',isDispatch?'확정배차 확인 중':'운영 근거 확인 중');
    panel.append(title,action('닫기',()=>areaCard(null)),line);
    if (!view?.generation || area.id==='unmatched') {
      line.textContent=isDispatch?'이 권역의 확정배차 자료 미확인':'운영이력 확인 필요';
      return;
    }
    if(isDispatch&&!operationsDisplayed?.registry) {line.textContent='확정배차 자료 미확인';return;}
    const controller=operationsDetailRead=new AbortController();
    try {
      const params={...operationsParameters(view.generation),area:area.id,
        ...(isDispatch?{registry:operationsDisplayed.registry}:{offset})};
      const data=await read(endpoint,params,timeout(controller.signal));
      if(controller.signal.aborted || layer()!==endpoint || selectedArea?.id !== area.id) return;
      line.textContent=statsText(data.period)+' · 원장 기준 '+data.publishedThrough;
      if(isDispatch) {
        const counts=data.counts;
        panel.append(node('p',counts
          ? '좌표 연결 배차 '+fmt.format(counts.dispatchCount)+'건 · '+fmt.format(Math.round(counts.density*10)/10)+'건/km²'
          : '이 권역의 확정배차 자료 미확인'));
        return;
      }
      if (!data.counts) { panel.append(node('p','운영이력 확인 필요')); return; }
      panel.append(...operationFigures(data.counts).map(text=>node('p',text)));
      if (!data.counts.observed) panel.append(node('p','이 권역의 운영이력 확인이 필요합니다.'));
      const list=node('ul','');
      for(const member of data.members){
        const {code,name,flags}=member;
        const labels=[operationLabels.ORDER,operationLabels.DISPATCH,operationLabels.COMPLETED].filter((_,i)=>flags&(1<<i));
        const row=node('li','');
        row.append(action((name||code)+' · '+code,()=>openStore?.(member)),node('p',labels.join(' · ')||operationLabels.UNKNOWN));
        list.append(row);
      }
      panel.append(list);
      if(offset)panel.append(action('이전',()=>void showOperationsArea(area,Math.max(0,offset-12))));
      if(data.next!==null)panel.append(action('다음',()=>void showOperationsArea(area,data.next)));
    } catch(error) {
      if(controller.signal.aborted)return;
      if(isDispatch&&error.status===409){void readView(true);return;}
      line.textContent=isDispatch?'확정배차를 확인하지 못했습니다.':'운영이력을 확인하지 못했습니다.';
    }
  }

  async function readOperationWindow() {
    const section=find('recentOperationWindow'), target=find('recentOperationSummary');
    recentOperationRead?.abort();
    if (!active || !section.open || !find('postalDataStatus').open) return;
    const request = recentOperationRead = new AbortController();
    const days=find('recentOperationDays').value;
    const center=find('coverageCenter').value;
    target.textContent='기간별 운영 근거 확인 중';
    try {
      const response=await fetch(recentOperationsApi+'?'+new URLSearchParams({days,summary:'1'}),{
        credentials:'same-origin',cache:'no-store',signal:timeout(request.signal)
      });
      if (!response.ok) throw Error('RECENT_OPERATION_WINDOW_UNAVAILABLE');
      const report=await response.json();
      if (!report.ok || !report.centers || report.days!==Number(days)) throw Error('RECENT_OPERATION_WINDOW_UNAVAILABLE');
      if (request.signal.aborted || recentOperationRead!==request || !active) return;
      const selected=center==='all'?['osan','yeongnam','honam']:[center];
      const dates=[node('p','조회 기간 '+report.startDate+' ~ '+report.endDate)];
      if (!report.sourceUnavailable && report.publishedThrough) {
        dates.push(node('p','운영이력 원장 기준 '+report.publishedThrough+'. 지도 색상과 구역 집계는 별도 게시본 기준입니다.'));
      }
      target.replaceChildren(...dates,...selected.map(key=>{
        const {confirmedDays,calendar=[]}=report.centers[key];
        if (report.sourceUnavailable) return node('p',centerNames[key]+' · 배송이력 확인 필요');
        const observed=new Set(calendar.flatMap(day=>Object.values(day.sources).flatMap(source=>source.evidence??[])));
        const labels=[['order_confirmed','주문확정'],['dispatch_confirmed','배차확정'],['delivery_completed','배송완료']]
          .filter(([kind])=>observed.has(kind)).map(([,label])=>label);
        const partial=labels.length?'일부 '+labels.join('·')+' 근거 확인 · ':'';
        return node('p',centerNames[key]+' · '+(confirmedDays.length===report.days?'배송이력 확인':partial+'배송이력 확인 필요'));
      }));
    } catch {
      if (!request.signal.aborted && recentOperationRead===request && active) target.textContent='기간별 운영 근거 미확인';
    }
  }
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
    areaDetails.open(latest()?null:area,scope());
    void showOperationsArea(latest()?area:null);
    updateCurrentRegistration();
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
    if (!active || !map) return;
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
    find('postalLayerControl').hidden=!data.operationsAvailable;
    const dispatchOption=find('postalLayer').querySelector('[value="dispatch-density"]');
    dispatchOption.disabled=dispatchOption.hidden=!data.dispatchDensityAvailable;
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
    find('postalPeriod').textContent = '지도 색상·구역 집계 기준 ' + statsText(data.period) + ' · ' + centerNames[data.center];
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
      ? '현재 범위에서 미배송이 확인된 구역이 없습니다.' : '배송 자료 미확인')]));
  }

  async function readView(force = false) {
    if (!active || !map) return;
    const { box, level, world } = map.viewport(), params = baseScope();
    const scopeKey=[range(),layer(),params.center].join(':');
    const key = [scopeKey,level,Boolean(world), ...box.map(value => value.toFixed(5))].join(':');
    const first = !view && Boolean(world);
    const firstScope = first ? [params.days,params.center].join(':') : null;
    if (loadingKey === key || (first && firstScope === bootstrapScope)) return;
    if (!force && key === viewKey) {
      if (loadingKey) cancelViewport();
      return;
    }
    viewportRead?.abort();
    const controller = viewportRead = new AbortController();
    loadingKey = key;
    bootstrapScope = firstScope;
    if (!view) message('우편번호 경계를 불러오는 중입니다.');
    try {
      const signal = timeout(controller.signal);
      const detailed=postalTilesLevel(box)==='detail';
      const requested = { ...params, level, ...(world ? { indexed:'1' } : {}),
        ...(detailed?{buffered:'1'}:{}),
        box:box.map(value => value.toFixed(5)).join(',') };
      // The in-memory cache lasts only between the protected view refreshes.
      const at=Date.now();
      const exact=viewCache.get(key);
      const saved = force ? null : exact?.until>at ? exact : detailed ? [...viewCache.values()].find(entry=>{
        const bounds=entry.data.coveredBox;
        return entry.scopeKey===scopeKey&&entry.until>at&&entry.data.tier==='detail'&&
          Array.isArray(bounds)&&bounds.length===4&&box[0]>=bounds[0]&&box[1]>=bounds[1]&&box[2]<=bounds[2]&&box[3]<=bounds[3];
      }) : null;
      const cached = saved?.data;
      const frame = !cached && (first && !geometry.hasOverview() || detailed)
        ? await viewportFrame(detailed ? {...requested,viewport:'1'} : requested,signal,
          geometry.knownTiles(detailed ? view?.boundary : view?.overview))
        : null;
      const data = cached || frame?.view || await read('view',requested,signal);
      if (!active || viewportRead !== controller) return;
      if(dispatchDensity()&&!data.dispatchDensityAvailable) {
        find('postalLayer').value='archive';
        find('postalLayer').onchange();
        return;
      }
      const sameRelease = view?.generation === data.generation && view?.boundary === data.boundary &&
        view?.assignmentReview === data.assignmentReview;
      const [slices,operations] = await Promise.all([
        (frame && geometry.acceptBootstrap(data,frame.bytes,frame.duration)) || geometry.read(data,signal),
        latest() ? readOperations(data.generation,signal).catch(error => {
          if (error.status === 401 || error.status === 403 || error.code === 'POSTAL_GENERATION_MISMATCH') throw error;
          return null;
        }) : null,
      ]);
      if (!active || viewportRead !== controller) return;
      if (view && !sameRelease) clearPublishedView({ keepMap:true });
      const operationsChanged=operationsDisplayed!==operations;
      operationsDisplayed=operations;
      const same = sameRelease && view?.period.days === data.period.days && view.center === params.center && view.layer===layer();
      view = { ...data, center: params.center,layer:layer() };
      viewKey = key;
      viewCache.delete(key);
      viewCache.set(key, cached ? saved : { data,scopeKey,until:Date.now()+(data.coveredBox?60000:20000) });
      if (viewCache.size > 6) viewCache.delete(viewCache.keys().next().value);
      host.dataset.postalGeometry = JSON.stringify({ indexed:Boolean(data.overview), combined:Boolean(frame), ...geometry.metrics() });
      applyView(view,same);
      updateCurrentRegistration(force);
      if (latest() && (operationsChanged || !same)) showOperations(operations);
      showMapEvidence();
      map.show(latest()?{...view,tones:operations?.tones??noPostalItems,badges:noPostalItems}:view,slices);
      if (!same && selectedArea) areaCard({ id:selectedArea.id });
      else if (latest() && selectedArea && (operationsChanged || !find('postalOperationsDetail').firstChild)) void showOperationsArea(selectedArea);
      if (searchNeedsRefresh) {
        searchNeedsRefresh = false;
        void runSearch(submittedSearch, { refresh:true });
      }
      const missing=dispatchDensity()
        ? operations?.observedDays?'':'선택 범위의 확정배차 자료 미확인'
        : (latest()?!operations:!hasDeliveryEvidence(data))?'선택 범위의 배송 자료 미확인':'';
      message(missing);
    } catch (error) {
      if (!active || viewportRead !== controller || controller.signal.aborted) return;
      if (error.status === 401 || error.status === 403) {
        reset();
        message('직원 인증을 다시 확인해 주세요.');
        return;
      }
      if (error.code === 'POSTAL_GENERATION_MISMATCH') clearPublishedView();
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

  function searchItems(rows, signal, query, autoPick) {
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
    if (autoPick && rows.length === 1 && rows[0].exact !== false && !rows[0].assignmentPending) buttons[0].click();
  }

  async function existingAddress(query, signal, allowGeocoder) {
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
    if (!address || !allowGeocoder || !active) return [];
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

  async function runSearch(query, { refresh = false } = {}) {
    if (!active || !map || query.length < 2) return;
    submittedSearch = query;
    searchRead?.abort();
    const request = searchRead = new AbortController();
    const signal = timeout(request.signal);
    searchResults.replaceChildren(node('p', '주소와 매장을 찾고 있습니다.'));
    try {
      let rows = await read('search', scope(), signal, { 'X-Map-Customer-Query': encodeURIComponent(query) });
      if (!rows.length) rows = await existingAddress(query, signal, !refresh);
      if (searchRead !== request || request.signal.aborted) return;
      if (rows.length) searchItems(rows, request.signal, query, !refresh);
      else searchResults.replaceChildren(node('p', '승인된 주소 자료와 매장 목록에서 검색 결과가 없습니다.'));
    } catch (error) {
      if (searchRead !== request || request.signal.aborted) return;
      if (error.status === 409) void readView(true);
      searchResults.replaceChildren(node('p', error.code === 'POSTAL_ADDRESS_UNVERIFIED' ?
        '등록 주소의 좌표 검증이 필요합니다.' : '검색을 완료하지 못했습니다. 다시 시도해 주세요.'));
    }
  }

  function cancelViewport() {
    clearTimeout(timer);
    viewportRead?.abort();
    viewportRead = loadingKey = bootstrapScope = null;
  }

  function clearPublishedView({ retainSelection = true, keepMap = false } = {}) {
    const area = retainSelection ? selectedArea?.id : null;
    [detailRead, searchRead, recentOperationRead, operationsDetailRead].forEach(request => request?.abort());
    detailRead = searchRead = recentOperationRead = operationsDetailRead = null;
    view = viewKey = null;
    cancelOperations();
    if (!keepMap) operationsCache = null;
    operationsDisplayed = null;
    viewCache.clear();
    searchNeedsRefresh = retainSelection && Boolean(submittedSearch);
    delete host.dataset.postalGeometry;
    if (!keepMap) map?.clear();
    areaCard(null);
    if (area) selectedArea = { id:area };
    searchResults.replaceChildren();
    find('postalCandidates').replaceChildren();
    find('postalEvidence').replaceChildren();
    find('postalOperationsSummary').replaceChildren();
    find('recentOperationSummary').replaceChildren();
    for (const id of ['postalPeriod','postalObserved','postalFormula','postalNewEvidence','postalMapSource']) find(id).textContent = '';
    root.querySelectorAll('[data-postal-kpi]').forEach(entry => { entry.textContent = '—'; });
    delete root.dataset.postalView;
    message();
  }

  function reset() {
    cancelViewport();
    clearPublishedView({ retainSelection:false });
    geometry.clear();
    submittedSearch = '';
    searchNeedsRefresh = false;
    find('coverageQuery').value = '';
  }

  find('coveragePanelToggle').onclick = () => collapse(!root.classList.contains('coverage-panel-collapsed'));
  find('postalDataStatus').ontoggle = readOperationWindow;
  find('recentOperationWindow').ontoggle = readOperationWindow;
  find('recentOperationDays').onchange = readOperationWindow;
  find('postalUnmatched').onclick = () => { if (view) areaCard({ id:'unmatched' }); };
  find('coverageSearch').onsubmit = event => {
    event.preventDefault();
    void runSearch(find('coverageQuery').value.normalize('NFKC').trim());
  };
  function clearSearch() {
    searchRead?.abort();
    submittedSearch = '';
    searchNeedsRefresh = false;
    searchResults.replaceChildren();
  }
  find('coverageQuery').oninput = clearSearch;
  find('coverageRadius').onchange = () => { clearSearch(); map?.point(null); };
  function changeScope(centerChanged) {
    viewportRead?.abort();
    cancelOperations();
    loadingKey=bootstrapScope=null;
    clearSearch();
    detailRead?.abort();
    if(latest()) {
      operationsDetailRead?.abort();
      operationsDisplayed=null;
      find('postalOperationsDetail').replaceChildren();
      showOperations(null);
      map?.clear(true);
    }
    find('postalMapSource').textContent='';
    if (centerChanged) {
      const {center} = baseScope();
      viewportRead?.abort();
      areaCard(null);
      map?.point(null);
      map?.focus(null, coverageCenterBounds(center));
      regionButton.textContent = center === 'all' || center === 'osan' ? '오산·화성' : centerNames[center];
      if (view?.center !== center) message(centerNames[center] + ' 센터 자료를 불러오는 중입니다.');
      void readOperationWindow();
    }
    scheduleView();
  }
  find('coverageDays').onchange = () => changeScope(false);
  find('postalLayer').onchange = () => {
    const showLatest=latest(), week=find('coverageDays').querySelector('[value="7"]');
    week.disabled=week.hidden=!showLatest;
    if(!showLatest&&range()==='7')find('coverageDays').value='90';
    find('postalArchive').hidden=showLatest;
    find('postalArchiveStatus').hidden=showLatest;
    find('postalOperations').hidden=!showLatest;
    find('postalLegendArchive').hidden=showLatest;
    find('postalLegendOperations').hidden=layer()!=='operations';
    find('postalLegendDispatch').hidden=!dispatchDensity();
    find('postalMapSource').textContent='';
    viewportRead?.abort();
    cancelOperations();
    loadingKey=bootstrapScope=null;
    operationsDetailRead?.abort();
    operationsDisplayed=null;
    map?.clear(true);
    areaCard(selectedArea);
    scheduleView();
  };
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
      active = true;
      root.hidden = false;
      windowHeight();
      resize.observe(header);
      resize.observe(host);
      void start();
      void readOperationWindow();
      refresh = setInterval(() => { if (active && !document.hidden) void readView(true); }, 60000);
    },
    close() {
      active = false;
      owner++;
      root.hidden = true;
      clearInterval(refresh);
      resize.disconnect();
      cancelViewport();
      cancelOperations();
    },
    invalidate() {
      cancelViewport();
      clearPublishedView();
      if (active) {
        void readView(true);
        void readOperationWindow();
      }
    },
    disposeMap() {
      active = false;
      reset();
      map?.destroy();
      map = null;
      find('coverageDays').value = '90';
      find('postalLayer').value='archive';
      find('postalLayer').onchange();
      find('postalLayerControl').hidden=true;
      find('coverageCenter').value = 'all';
      regionButton.textContent = '오산·화성';
      find('coverageRadius').value = '0';
      collapse(false);
      host.replaceChildren();
    },
  };
}
