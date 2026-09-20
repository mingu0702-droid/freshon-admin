(() => {
  'use strict';
  let generation = 0, controller = null, authController = null, expiryTimer = null, requested = null, sessionHint = null, detailPending = false;
  const metrics = [];
  const trace = document.createElement('output'); trace.id = 'staffRequestMetrics'; trace.hidden = true; document.body.append(trace);
  const dialog = document.createElement('dialog');
  dialog.id = 'mapStaffDialog';
  dialog.setAttribute('aria-label', '직원용 보호 상세');
  document.body.append(dialog);
  const loadingStyle = document.createElement('style');
  loadingStyle.textContent = '#mapStaffDialog .staffLoadingSpinner{display:inline-block;width:1em;height:1em;margin-right:.5em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;vertical-align:middle;animation:staffLoadingSpin .8s linear infinite}@keyframes staffLoadingSpin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){#mapStaffDialog .staffLoadingSpinner{animation:none}}';
  document.head.append(loadingStyle);
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('map-staff-session') : null;
  function clear() {
    generation++; controller?.abort(); authController?.abort(); controller = null; clearTimeout(expiryTimer);
    requested = null; detailPending = false; dialog.replaceChildren(); if (dialog.open) dialog.close();
  }
  function node(tag, text, parent = dialog) { const item = document.createElement(tag); item.textContent = text; parent.append(item); return item; }
  function shell(title, modal = false) {
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    dialog.dataset.modal = String(modal);
    node('h2', title);
    const close = node('button', '닫기'); close.type = 'button'; close.addEventListener('click', clear);
    if (modal) dialog.showModal(); else dialog.show();
  }
  async function request(path, options = {}) {
    const isDetail = path.startsWith('private/'), isLogout = path === 'auth/logout', local = new AbortController();
    if (isDetail) { controller?.abort(); controller = local; }
    else if (!isLogout) { authController?.abort(); authController = local; }
    const start = performance.now(); let status = 0, receivedAt = null, serverTiming = '', headersMs = 0, parseMs = 0;
    const timer = isDetail ? null : setTimeout(() => local.abort(), 10000);
    try {
      const response = await fetch('/api/map-phase2b/' + path, { ...options, cache: 'no-store', credentials: 'same-origin',
        signal: local.signal, headers: { 'content-type': 'application/json', ...options.headers } });
      status = response.status; headersMs = performance.now() - start; receivedAt = response.headers.get('x-request-received-at'); serverTiming = response.headers.get('server-timing') || '';
      if (!response.ok) {
        // Classify only known availability codes; never display or retain the body.
        let notReady = false;
        if (path.startsWith('private/driver-history') && status === 503) {
          try { notReady = ['READ_MODEL_NOT_READY', 'READ_MODEL_RANGE_NOT_READY'].includes((await response.json()).error); } catch (_) { /* HTTP error remains an error */ }
        }
        throw Object.assign(new Error('REQUEST_FAILED'), { status, notReady,
          sourceChanged: ['PERIOD_SOURCE_CHANGED','HISTORY_SOURCE_CHANGED','HISTORY_LOCATOR_CHANGED'].includes(response.headers.get('x-history-failure')) });
      }
      const parsedAt = performance.now(), value = await response.json(); parseMs = performance.now() - parsedAt;
      const expiresAt = Number(response.headers.get('x-staff-expires-at')), idleExpiresAt = Number(response.headers.get('x-staff-idle-expires-at'));
      if (isDetail && expiresAt && idleExpiresAt && !local.signal.aborted) deadline({ authenticated: true, expiresAt, idleExpiresAt });
      return value;
    } finally {
      clearTimeout(timer);
      metrics.push({ endpoint: path.split('?')[0], status, browserTotalMs: +(performance.now()-start).toFixed(2), headersMs: +headersMs.toFixed(2), parseMs: +parseMs.toFixed(2), receivedAt, serverTiming });
      if (metrics.length > 25) metrics.shift(); trace.textContent = JSON.stringify(metrics);
    }
  }
  function deadline(session) {
    sessionHint = session;
    clearTimeout(expiryTimer);
    if (session?.authenticated) expiryTimer = setTimeout(() => { sessionHint = null; clear(); }, Math.max(0, Math.min(session.expiresAt, session.idleExpiresAt) - Date.now()));
  }
  async function logout() {
    sessionHint = null; clear(); channel?.postMessage('logout');
    try { await request('auth/logout', { method: 'POST', body: '{}' }); }
    catch (error) { if (error.name !== 'AbortError') { shell('로그아웃 확인 필요'); node('p', '화면 정보는 지웠지만 서버 로그아웃을 확인하지 못했습니다. 다시 시도해 주세요.'); node('button', '로그아웃 재시도').onclick = logout; } }
  }
  function loginForm(id) {
    shell('직원 공용 로그인', true);
    node('p', '지도 보호 상세 읽기 전용 · 관리자 권한은 제공되지 않습니다.');
    const form = node('form', '');
    const accountLabel = node('label', '공용 아이디', form), account = document.createElement('input');
    account.name = 'username'; account.autocomplete = 'username'; account.required = true; account.maxLength = 128; accountLabel.append(account);
    const passwordLabel = node('label', '비밀번호', form), password = document.createElement('input');
    password.type = 'password'; password.name = 'password'; password.autocomplete = 'current-password'; password.required = true; password.maxLength = 1024; passwordLabel.append(password);
    const submit = node('button', '로그인', form); submit.type = 'submit';
    const message = node('p', '', form); message.setAttribute('role', 'status');
    form.addEventListener('submit', async event => {
      event.preventDefault(); submit.disabled = true;
      let body = JSON.stringify({ id: account.value, password: password.value }); password.value = '';
      try {
        const session = await request('auth/login', { method: 'POST', body }); body = '';
        if (id !== generation) return;
        deadline(session);
        dialog.close(); shell('로그인 완료'); node('p', '상세정보 불러오는 중…');
        // Login is complete; the explicitly requested detail runs independently.
        void showRequested(id);
      } catch (error) {
        if (error.name !== 'AbortError' && id === generation) message.textContent = error.status === 429 ? '시도가 많습니다. 잠시 후 다시 시도해 주세요.' : error.status === 503 ? '직원 로그인 설정이 필요합니다.' : '로그인하지 못했습니다. 아이디와 비밀번호를 확인해 주세요.';
      } finally { body = ''; password.value = ''; submit.disabled = false; }
    });
    account.focus();
  }
  function line(label, value) { const dl = node('div', ''); dl.className = 'staffDetailLine'; node('b', label, dl); node('span', value || '원천 미등록', dl); }
  async function showRequested(id) {
    const target = requested;
    if (!target || id !== generation) return;
    detailPending = true;
    const detailStarted = performance.now();
    shell(target.kind === 'history' ? '최근 배송기사 이력' : '출입·배송 메모');
    dialog.dataset.state = 'loading';
    const loading = node('p', ''); loading.setAttribute('role', 'status'); loading.setAttribute('aria-live', 'polite');
    const spinner = node('span', '', loading); spinner.className = 'staffLoadingSpinner'; spinner.setAttribute('aria-hidden', 'true');
    node('span', '상세정보 불러오는 중...', loading);
    const delayNotice = setTimeout(() => {
      if (id === generation && detailPending) loading.textContent = '상세정보 조회가 지연되고 있습니다. 잠시만 기다려 주세요.';
    }, 5000);
    try {
      const query = new URLSearchParams({ customerCode: target.customerCode, date: target.date || '' });
      if (target.rangeStart) query.set('startDate', target.rangeStart);
      if (target.rangeEnd) query.set('endDate', target.rangeEnd);
      const payload = await request('private/' + (target.kind === 'history' ? 'driver-history' : 'customer-detail') + '?' + query);
      if (id !== generation) return;
      // Server validates the session again after the upstream read.
      shell(target.kind === 'history' ? '최근 배송기사 이력' : '출입·배송 메모');
      node('button', '로그아웃').onclick = logout;
      if (target.kind === 'history') {
        if (payload.meta?.complete === false) {
          dialog.dataset.state = 'not-ready';
          node('p', '기사 이력이 아직 준비되지 않았습니다. 기사 없음으로 판단하지 마세요.');
          return;
        }
        const rows = Array.isArray(payload.data) ? payload.data : [];
        dialog.dataset.state = rows.length ? 'ready' : payload.meta?.coverageComplete === true ? 'empty' : 'not-ready';
        if (!payload.meta?.coverageComplete) {
          node('p', 'Delivery 기사정보 확인 중 · 전체 기간 수집 완전성 미확인');
          line('원천', payload.meta?.source || '미확인');
          line('기록 확인일', (payload.meta?.availableRecordDates || []).join(', ') || '없음');
          line('완전성 미확인일', (payload.meta?.unconfirmedDates || []).join(', ') || '미확인');
        }
        if (!rows.length) node('p', payload.meta?.coverageComplete === true ? '선택 기간의 기사 이력이 없습니다.' : 'Delivery 기사정보 미확인 · 원천 완전성 확인 중 (기사 없음 아님)');
        rows.forEach(row => {
          const entry = node('div', ''); entry.className = 'staffDetailLine';
          const heading = node('b', row.deliveryDate + ' · ', entry);
          node('span', window.Phase2bUi.normalizeVehicleLabel(row.vehicle) || '미등록', heading).className = 'vehicleLabel';
          node('span', ' · ' + (row.kind === 'COMPLETED' ? '방문 완료' : '배차'), heading);
          node('span', [row.driverName || '기사 미등록', row.driverPhone || '연락처 미등록'].join(' · '), entry);
        });
      } else {
        dialog.dataset.state = 'ready';
        const data = payload.data || {};
        if (data.memoState === 'NEEDS_CONFIRMATION') node('p', '허용 항목을 확실히 구분할 수 없어 원천 확인이 필요합니다.');
        line('출입방법', data.accessInfo); line('비밀번호', data.password); line('배송 특이사항', data.specialRemark); line('배송요일', data.deliveryPattern || '미등록');
      }
    } catch (error) {
      if (error.name === 'AbortError' || id !== generation) return;
      if (error.status === 401) { sessionHint = null; loginForm(id); return; }
      if (error.notReady) {
        shell('기사 이력 준비 중'); dialog.dataset.state = 'not-ready';
        node('p', '기사 이력이 아직 준비되지 않았습니다. 기사 없음으로 판단하지 마세요. 공개 고객정보와 지도는 계속 사용할 수 있습니다.');
        node('button', '다시 확인').onclick = () => { if (id === generation && !detailPending) void showRequested(id); };
        return;
      }
      shell(target.kind === 'history' ? '기사 이력 조회 실패' : '보호 상세 조회 실패'); node('p', error.sourceChanged ? '조회 중 원천 데이터가 변경되었습니다. 다시 시도해 주세요.' : error.status === 504 && performance.now() - detailStarted >= 5000 ? '상세정보 조회가 지연되고 있습니다. 다시 시도해 주세요.' : error.status === 422 ? '원천 데이터 확인이 필요합니다.' : '원천 조회를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      dialog.dataset.state = 'error';
      node('p', '공개 고객정보와 지도는 계속 사용할 수 있습니다.');
      node('button', '다시 시도').onclick = () => { if (id === generation && !detailPending) void showRequested(id); };
    } finally { clearTimeout(delayNotice); if (id === generation) detailPending = false; }
  }
  async function open(target) {
    if (detailPending && JSON.stringify(requested) === JSON.stringify(target)) return;
    clear(); requested = { ...target }; const id = generation;
    if (sessionHint?.authenticated && Date.now() < Math.min(sessionHint.expiresAt, sessionHint.idleExpiresAt)) { void showRequested(id); return; }
    loginForm(id);
    try {
      const session = await request('auth/session');
      if (id !== generation) return;
      if (session.authenticated) { deadline(session); void showRequested(id); }
    } catch (error) { /* Keep the login form; never display raw cancellation text. */ }
  }
  channel?.addEventListener('message', event => { if (event.data === 'logout') { sessionHint = null; clear(); } });
  dialog.addEventListener('cancel', clear);
  window.addEventListener('pagehide', clear);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
  window.MapStaff = Object.freeze({ open, clear, logout });
})();
