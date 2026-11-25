const fmt = new Intl.NumberFormat('ko-KR');
const kst = new Intl.DateTimeFormat('ko-KR', { timeZone:'Asia/Seoul', dateStyle:'medium', timeStyle:'short' });
const weekdays = { Mon:'월', Tue:'화', Wed:'수', Thu:'목', Fri:'금', Sat:'토' };
const filters = [['all','전체'],['confirmed','배송 확인'],['candidate','미배송 확인'],['unknown','배송 미확인'],['new','오산신규 이력'],['held','오산보류 이력']];
const observation = { OBSERVED:'배송 확인', CANDIDATE:'기간 내 미배송 확인', UNVERIFIED:'배송 미확인' };
const n = value => fmt.format(value ?? 0);
const time = value => Number.isFinite(Date.parse(value)) ? kst.format(new Date(value)) : '미확인';
const number = value => Number.isInteger(value) ? n(value) + '건' : '미확인';
const word = value => value ?? '미확인';
const make = (tag, text, attrs = {}) => Object.assign(document.createElement(tag), { textContent:text, ...attrs });
const button = (text, click) => make('button',text,{ type:'button', onclick:click });
const signalOf = controller => AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);

function definition(list, label, value) {
  list.append(make('dt',label), make('dd',value));
}
function readback(value, prefix = '조회') {
  return prefix + ' ' + time(value);
}

function completionLabel(row) {
  if (row.deliveryObservation === 'UNVERIFIED') return '미확인';
  return n(row.observedDeliveryCount) + '건' + (row.deliveryObservation === 'CANDIDATE' ? ' 관측' : '');
}

export function createPostalAreaDetails(root, { read, dismiss, openStore }) {
  root.innerHTML = '<div class="postal-region-head"><div><h2 id="postalAreaTitle"></h2><p id="postalAreaName"></p></div>' +
    '<button type="button" id="postalRegionToggle" aria-expanded="true" aria-controls="postalRegionBody">접기</button>' +
    '<button type="button" id="postalAreaClose" aria-label="권역 상세 닫기">×</button></div>' +
    '<div id="postalRegionBody"><dl id="postalAreaSummary" class="postal-details-stat"></dl>' +
    '<details class="postal-region-evidence"><summary>수집기간과 미확인 날짜</summary><div id="postalAreaEvidence"></div></details>' +
    '<form id="postalAreaSearch"><label for="postalStoreQuery">권역 업장 검색</label><div class="coverage-search-row">' +
    '<input id="postalStoreQuery" type="search" placeholder="업장명·고객코드·주소" maxlength="200" autocomplete="off">' +
    '<button type="submit">찾기</button></div><label for="postalAreaStatus">상태</label><select id="postalAreaStatus"></select></form>' +
    '<p id="postalStoreState" role="status" aria-live="polite"></p><div id="postalStoreList"></div><nav id="postalStorePages" aria-label="업장 목록 페이지"></nav></div>';
  const find = id => root.querySelector('#' + id);
  const results = find('postalStoreList'), pager = find('postalStorePages'), status = find('postalStoreState');
  const search = find('postalStoreQuery'), filter = find('postalAreaStatus');
  filter.replaceChildren(...filters.map(([value,label])=>new Option(label,value)));
  let chosen, scope, rosterQuery, historyQuery, cached, requestKey, currentHistory;
  let loadedOffset = 0;

  function abortHistory() {
    historyQuery?.abort();
    historyQuery = null;
    currentHistory = null;
  }
  function collapse(collapsed) {
    find('postalRegionBody').hidden = collapsed;
    const functionButton = find('postalRegionToggle');
    functionButton.textContent = collapsed ? '펼치기' : '접기';
    functionButton.setAttribute('aria-expanded',String(!collapsed));
  }
  find('postalRegionToggle').onclick = () => collapse(!find('postalRegionBody').hidden);
  find('postalAreaClose').onclick = dismiss;

  function figures(data) {
    if (!data) return;
    find('postalAreaName').textContent = data.area ? data.name || '지역명 미확인' : '구역 배정 미확인';
    const list = find('postalAreaSummary');
    list.replaceChildren();
    const t = data.totals;
    const deliveryUnverified = !t.visits && (!data.source.deliveryObservationDays || t.unknown > 0);
    for (const [key,value] of [
      ['분석 기간',data.period.days + '일'],
      ['등록 업장 / 배송 확인',n(t.registered) + '곳 / ' + (deliveryUnverified ? '미확인' : n(t.delivered) + '곳')],
      ['배송 구역 상태',t.visits?'배송 확인':!deliveryUnverified&&t.candidates?'기간 내 미배송 확인':'배송이력 확인 필요'],
      ['관측 배송',deliveryUnverified ? '미확인' : n(t.visits) + '건'],
      ['오산신규 확인 / 미확인',n(t.newActive) + ' / ' + n(t.newUnknown) + '곳'],
      ['오산보류 이력',n(t.held) + '곳'], ['기간 내 미배송 확인',n(t.candidates) + '곳'],
      ['배송 미확인',n(t.unknown) + '곳']
    ]) definition(list,key,value);
    if (chosen.nearby) definition(list,'직선 ' + chosen.nearby.radius + 'm 내 등록',n(chosen.nearby.registered) + '곳');
    const s = data.source;
    const evidence = find('postalAreaEvidence');
    evidence.replaceChildren(
      make('p', data.period.start + ' ~ ' + data.period.end + ' · ' + (s.deliveryObservationDays
        ? '배송 ' + n(s.deliveryObservationDays) + '일 관측' : '배송 자료 미확인')),
      make('p','배송일 미확인 ' + n(s.missingDates.length) + '일' + (s.missingDates.length ? ' · ' + s.missingDates.join(', ') : '')),
      make('p','원천 전체 수집 확인 ' + n(s.completeDays) + '일'),
      make('p','배송 원천 관측 ' + time(s.observedAt)),
      make('p','기준호차 조회 근거 ' + (s.fixed.state === 'LAST_VERIFIED_RETAINED' ? '이전 정상 자료 · ' : '') + time(s.fixed.checkedAt)),
      make('p','MIS 주문 원천 미연결')
    );
  }

  function historyBody(data, target, row, owner) {
    const order = make('p','주문번호·주문일·주문 배송상태 미연결', { className:'coverage-note' });
    const rows = make('ol','',{ className:'postal-history-list' });
    for (const item of data.deliveries) {
      const fields = make('dl','',{ className:'postal-details-stat' });
      definition(fields,'배송 기록일',item.observedDate);
      definition(fields,'배송예정일',word(item.scheduledDate));
      definition(fields,'실제 배송일',word(item.actualDate));
      definition(fields,'배송ID',word(item.deliveryId === null ? '미연결' : item.deliveryId));
      if (item.archivedKey) definition(fields,'보존 배송 키',item.archivedKey);
      definition(fields,'확정호차',word(item.confirmedVehicle));
      definition(fields,'배송 상태','완료 관측');
      const li = document.createElement('li');
      li.append(fields);
      rows.append(li);
    }
    const line = make('p',data.filteredCount ? '관측 완료 배송 ' + n(data.filteredCount) + '건' :
      row.deliveryObservation === 'CANDIDATE' ? '기간 전체 배송 자료에서 배송 기록이 없습니다.' : '연결된 배송 기록이 미확인입니다.');
    const pages = make('nav','',{ className:'postal-item-pages' });
    pages.setAttribute('aria-label','배송 이력 페이지');
    if (data.offset > 0) pages.append(button('이전',()=>void loadHistory(row,owner,target,Math.max(0,data.offset-data.limit))));
    if (data.next !== null) pages.append(button('다음',()=>void loadHistory(row,owner,target,data.next)));
    target.replaceChildren(order,line,rows,pages,make('p',readback(data.source.queriedAt),{className:'coverage-note'}));
    target.dataset.historyCount = String(data.filteredCount);
    target.dataset.historyOffset = String(data.offset);
    target.dataset.historyAsOf = String(data.source.queriedAt);
  }
  async function loadHistory(row, owner, target, offset = 0) {
    if (!chosen || !scope?.generation || !owner.open) return;
    historyQuery?.abort();
    const request = historyQuery = new AbortController();
    const requestedAt = new Date().toISOString();
    if (!target.dataset.historyAsOf) target.replaceChildren(make('p','이력을 불러오는 중입니다.'));
    try {
      const data = await read('history',{...scope,area:chosen.id,offset},signalOf(request),{ 'X-Map-Customer-Code':row.code });
      if (historyQuery !== request || !owner.open) return;
      historyBody(data,target,row,owner);
    } catch (error) {
      if (historyQuery !== request || request.signal.aborted || !owner.open) return;
      target.querySelector('.postal-history-error')?.remove();
      const errorLine = make('p','이력 조회 실패 ' + time(requestedAt) +
        (target.dataset.historyAsOf ? ' · 이전 조회 ' + time(target.dataset.historyAsOf) : ''),{className:'postal-history-error'});
      errorLine.append(' ',button('다시 시도',()=>void loadHistory(row,owner,target,offset)));
      if (!target.dataset.historyAsOf) target.replaceChildren(errorLine);
      else target.append(errorLine);
    }
  }

  function renderList(data) {
    abortHistory();
    loadedOffset = data.offset;
    const articles = data.stores.map(row => {
      const item = make('article','',{ className:'postal-store-row' });
      const title = button(row.name,() => {
        if (!openStore?.(row)) status.textContent = '기존 지도에서 이 업장을 확인할 수 없습니다.';
      });
      title.className = 'postal-store-title';
      title.dataset.postalStore = row.code;
      title.setAttribute('aria-label',row.name + ' 기존 지도 카드 열기');
      const code = make('p',row.code + (row.registered ? ' · 등록 업장' : ' · 배차 원천에서 관측'),{ className:'postal-store-code' });
      const address = make('p',row.address || '주소 미확인',{ className:'postal-store-address' });
      const badges = make('p',observation[row.deliveryObservation],{ className:'postal-store-status' });
      badges.dataset.observedDelivery = row.deliveryObservation;
      if (row.assignmentPending) badges.append(' · 경계 배정 보류');
      if (row.newStore) badges.append(' · 오산신규 이력');
      if (row.heldHistory) badges.append(' · 오산보류 이력');
      const values = make('dl','',{ className:'postal-details-stat' });
      const days = (row.fixedWeekdays || []).map(day => weekdays[day] ?? day).join(' ');
      for (const [key,value] of [
        ['기준호차',word(row.baseVehicle)], ['확정호차',row.confirmedVehicles.join(' · ') || '미확인'],
        ['영업 상태',word(row.operationStatus)], ['배송요일', (days ? days + (row.fixedWeekdayState === 'PARTIAL' ? ' · 일부 미확인' : '') :
          row.fixedWeekdayState === 'NO_DELIVERY' ? '등록된 요일 없음' : '미확인')],
        ['최근 주문일',word(row.recentOrderDate)], ['최근 배송 기록일',word(row.lastObservedDeliveryDate)],
        ['선택기간 주문',number(row.orderCount)], ['선택기간 배송',completionLabel(row)],
      ]) definition(values,key,value);
      const history = document.createElement('details');
      history.dataset.postalHistory = row.code;
      const summary = make('summary','주문·배송 이력');
      const historyContent = make('div','',{ className:'postal-store-history' });
      history.append(summary,historyContent);
      history.addEventListener('toggle',()=>{
        if (!history.open) {
          if (currentHistory === history) abortHistory();
          historyContent.replaceChildren();
          delete historyContent.dataset.historyAsOf;
          delete historyContent.dataset.historyCount;
          delete historyContent.dataset.historyOffset;
          return;
        }
        if (currentHistory && currentHistory !== history) currentHistory.open = false;
        currentHistory = history;
        void loadHistory(row,history,historyContent);
      });
      item.append(title,code,address,badges,values,history);
      return item;
    });
    results.replaceChildren(...articles.length ? articles : [make('p','조건에 맞는 업장이 없습니다.')]);
    pager.replaceChildren();
    if (data.offset > 0) pager.append(button('이전 업장',()=>void loadRoster(Math.max(0,data.offset-data.limit))));
    if (data.next !== null) pager.append(button('다음 업장',()=>void loadRoster(data.next)));
    results.dataset.pageOffset = String(data.offset);
    results.dataset.totalRows = String(data.filteredCount);
    status.textContent = '검색 결과 ' + n(data.filteredCount) + '곳 · ' + readback(data.source.queriedAt);
    if (data.source.fixed.state === 'LAST_VERIFIED_RETAINED') status.textContent += ' · 이전 정상 기준호차 사용';
    if (data.source.fixed.state === 'UNAVAILABLE') status.textContent += ' · 기준호차 조회 미확인';
  }

  async function loadRoster(offset = 0, force = false) {
    if (!chosen || !scope?.generation) return;
    const q = search.value.normalize('NFKC').trim();
    const fields = { ...scope, area:chosen.id, offset, filter:filter.value };
    const key = JSON.stringify([fields,q]);
    if (!force && requestKey === key) return;
    const request = new AbortController();
    rosterQuery?.abort();
    rosterQuery = request;
    requestKey = key;
    const requestedAt = new Date().toISOString();
    const fallback = cached?.key === key ? cached.data : null;
    status.textContent = '권역 업장을 불러오는 중입니다.';
    try {
      const data = await read('stores',fields,signalOf(request),{ 'X-Map-Customer-Query':encodeURIComponent(q) });
      if (rosterQuery !== request) return;
      cached = { key,data };
      figures(data);
      renderList(data);
    } catch (error) {
      if (rosterQuery !== request || request.signal.aborted) return;
      const hasPrior = cached &&
        cached.data.generation === scope.generation && cached.data.period.days === Number(scope.days) &&
        cached.data.center === scope.center && (cached.data.area || 'unmatched') === chosen.id ? cached.data : fallback;
      status.textContent = (error.code==='POSTAL_DETAILS_UNCONFIGURED' ? '권역 상세 자료 미연결' : '목록 조회 실패') + ' · ' +
        readback(requestedAt) + (hasPrior ? ' · 이전 정상 조회 ' + time(hasPrior.source.queriedAt) : '');
      status.append(' ',button('다시 시도',()=>void loadRoster(offset,true)));
      if (!hasPrior) results.replaceChildren();
      requestKey = null;
    }
  }

  find('postalAreaSearch').onsubmit = event => { event.preventDefault(); void loadRoster(0); };
  filter.onchange = () => { void loadRoster(0); };
  function clearVisible() {
    results.replaceChildren(); pager.replaceChildren(); status.replaceChildren();
    find('postalAreaSummary').replaceChildren();
    find('postalAreaEvidence').replaceChildren();
    delete results.dataset.totalRows;
    delete results.dataset.pageOffset;
  }
  return {
    open(area, nextScope) {
      if (!area) { this.clear(); return; }
      const scopeChanged = scope?.generation !== nextScope?.generation || Number(scope?.days) !== Number(nextScope?.days) ||
        scope?.center !== nextScope?.center;
      const change = chosen?.id !== area.id;
      chosen = area;
      scope = nextScope;
      find('postalAreaTitle').textContent = area.id === 'unmatched' ? '우편번호 미매칭 업장' : '우편번호 ' + area.id;
      if (change || scopeChanged) {
        rosterQuery?.abort(); abortHistory();
        requestKey = cached = null;
        loadedOffset = 0;
        clearVisible();
        find('postalAreaName').textContent = '';
        if (change) { search.value = ''; filter.value = 'all'; collapse(false); }
      }
      root.hidden = false;
      root.dataset.postalCode = area.id;
      void loadRoster(loadedOffset);
    },
    clear() {
      rosterQuery?.abort(); abortHistory();
      rosterQuery = chosen = scope = cached = requestKey = null;
      loadedOffset = 0;
      root.hidden = true;
      delete root.dataset.postalCode;
      clearVisible();
      search.value = '';
      filter.value = 'all';
    },
  };
}
