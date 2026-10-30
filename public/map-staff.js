(() => {
  'use strict';
  let generation = 0, controller = null, authController = null, expiryTimer = null, requested = null, sessionHint = null, detailPending = false, refreshTimer = null, inlineHost = null, inlineTrigger = null;
  const metrics = [];
  const trace = document.createElement('output'); trace.id = 'staffRequestMetrics'; trace.hidden = true; document.body.append(trace);
  const dialog = document.createElement('dialog');
  let surface=dialog;
  dialog.id = 'mapStaffDialog';
  dialog.setAttribute('aria-label', '직원용 보호 상세');
  document.body.append(dialog);
  const loadingStyle = document.createElement('style');
  loadingStyle.textContent = '.staffLoadingSpinner{display:inline-block;width:1em;height:1em;margin-right:.5em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;vertical-align:middle;animation:staffLoadingSpin .8s linear infinite}@keyframes staffLoadingSpin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.staffLoadingSpinner{animation:none}}';
  document.head.append(loadingStyle);
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('map-staff-session') : null;
  function clear() {
    generation++; controller?.abort(); authController?.abort(); controller = null; clearTimeout(expiryTimer);
    clearTimeout(refreshTimer);refreshTimer=null;
    if(inlineHost){inlineHost.replaceChildren();inlineHost.hidden=true;}
    if(inlineTrigger)inlineTrigger.setAttribute('aria-expanded','false');
    inlineHost=null;inlineTrigger=null;surface=dialog;
    requested = null; detailPending = false; dialog.replaceChildren(); if (dialog.open) dialog.close();
  }
  function node(tag, text, parent = surface) { const item = document.createElement(tag); item.textContent = text; parent.append(item); return item; }
  function shell(title, modal = false) {
    if(dialog.open)dialog.close();dialog.replaceChildren();
    surface=!modal&&inlineHost?.isConnected?inlineHost:dialog;
    surface.replaceChildren();surface.dataset.modal=String(modal);
    if(surface!==dialog){surface.hidden=false;surface.classList.add('staffAuxCard');inlineTrigger?.setAttribute('aria-expanded','true');}
    node('h2',title);
    const close=node('button','접기');close.type='button';close.addEventListener('click',clear);
    if(surface===dialog){if(modal)dialog.showModal();else dialog.show();}
  }
  async function request(path, options = {}) {
    const isDetail = path.startsWith('private/'), isLogout = path === 'auth/logout', local = new AbortController();
    if (isDetail) { controller?.abort(); controller = local; }
    else if (!isLogout) { authController?.abort(); authController = local; }
    const start = performance.now(); let status = 0, receivedAt = null, serverTiming = '', headersMs = 0, parseMs = 0;
    const timer = setTimeout(() => local.abort(), isDetail ? 20000 : 10000);
    try {
      const response = await fetch('/api/map-phase2b/' + path, { ...options, cache: 'no-store', credentials: 'same-origin',
        signal: local.signal, headers: { 'content-type': 'application/json', ...options.headers } });
      status = response.status; headersMs = performance.now() - start; receivedAt = response.headers.get('x-request-received-at'); serverTiming = response.headers.get('server-timing') || '';
      if (!response.ok) {
        // Classify only known availability codes; never display or retain the body.
        let notReady = false, detailCode = null;
        if (path.startsWith('private/customer-detail')) {
          try { const code=(await response.json()).error; if(['DETAIL_UPSTREAM_TIMEOUT','DETAIL_SOURCE_AUTH_REQUIRED','DETAIL_SOURCE_FORBIDDEN','DETAIL_NOT_FOUND','DETAIL_INVALID_RESPONSE','DETAIL_SOURCE_RATE_LIMITED'].includes(code))detailCode=code; } catch (_) { /* No raw body is retained. */ }
        }
        if (path.startsWith('private/driver-history') && status === 503) {
          try { notReady = ['READ_MODEL_NOT_READY', 'READ_MODEL_RANGE_NOT_READY'].includes((await response.json()).error); } catch (_) { /* HTTP error remains an error */ }
        }
        throw Object.assign(new Error('REQUEST_FAILED'), { status, notReady, detailCode,
          sourceChanged: ['PERIOD_SOURCE_CHANGED','HISTORY_SOURCE_CHANGED','HISTORY_LOCATOR_CHANGED'].includes(response.headers.get('x-history-failure')) });
      }
      const parsedAt = performance.now(), value = await response.json(); parseMs = performance.now() - parsedAt;
      local.signal.throwIfAborted();
      if(isDetail&&status===202&&value?.error==='PLANNED_SOURCE_UNOBSERVED')throw Object.assign(new Error('PLANNED_SOURCE_UNOBSERVED'),{status,detailCode:'PLANNED_SOURCE_UNOBSERVED'});
      if (isDetail && (value?.ok !== true || value.data == null)) throw Object.assign(new Error('DETAIL_INVALID_RESPONSE'),{status:502,detailCode:'DETAIL_INVALID_RESPONSE'});
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
    if(window.MapStaffEntry)return window.MapStaffEntry.logout();
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
  function line(label, value, state) { const dl=node('div','');dl.className='staffDetailLine';node('b',label,dl);const blank=state==='CLEARED'?'삭제 확인':state==='DELETED'?'삭제된 정보':state==='CONFLICT'?'변경값 확인 필요':state==='UNOBSERVED'?'확인된 자료 없음':'미등록';node('span',value===true?'있음':value===false?'없음':value||blank,dl); }
  async function showRequested(id) {
    const target = requested;
    if (!target || id !== generation) return;
    detailPending = true;
    shell(target.kind === 'history' ? '최근 배송기사 이력' : '출입·배송 메모');
    surface.dataset.state = 'loading';
    const loading = node('p', ''); loading.setAttribute('role', 'status'); loading.setAttribute('aria-live', 'polite');
    const spinner = node('span', '', loading); spinner.className = 'staffLoadingSpinner'; spinner.setAttribute('aria-hidden', 'true');
    node('span', '상세정보 불러오는 중...', loading);
    const delayNotice = setTimeout(() => {
      if (id === generation && detailPending) loading.textContent = '상세정보 조회가 지연되고 있습니다. 잠시만 기다려 주세요.';
    }, 5000);
    try {
      const query = new URLSearchParams({ customerCode: target.customerCode, date: target.date || '' });
      if (target.refresh===true) query.set('refresh','1');
      if (target.rangeStart) query.set('startDate', target.rangeStart);
      if (target.rangeEnd) query.set('endDate', target.rangeEnd);
      const payload = await request('private/' + (target.kind === 'history' ? 'driver-history' : 'customer-detail') + '?' + query);
      if (id !== generation || (inlineHost && !inlineHost.isConnected)) return;
      if(target.kind !== 'history' && (payload.data?.customerCode !== target.customerCode || target.date && payload.data?.memoDate !== target.date)) throw Object.assign(new Error('DETAIL_INVALID_RESPONSE'),{status:502,detailCode:'DETAIL_INVALID_RESPONSE'});
      // Server validates the session again after the upstream read.
      shell(target.kind === 'history' ? '최근 배송기사 이력' : '출입·배송 메모');
      node('button', '로그아웃').onclick = logout;
      if (target.kind === 'history') {
        if (payload.meta?.complete === false) {
          surface.dataset.state = 'not-ready';
          node('p', '기사 이력이 아직 준비되지 않았습니다. 기사 없음으로 판단하지 마세요.');
          return;
        }
        const rows = Array.isArray(payload.data) ? payload.data : [];
        surface.dataset.state = rows.length ? 'ready' : payload.meta?.coverageComplete === true ? 'empty' : 'not-ready';
        if (!payload.meta?.coverageComplete) {
          node('p','전체 수집 완전성은 별도 미검증입니다.');
          const details=node('details','');node('summary','검증 상태 상세',details);
          node('p','기록 확인일: '+((payload.meta?.availableRecordDates||[]).join(', ')||'확인된 날짜 없음'),details);
          node('p','검증 미확인일: '+((payload.meta?.unconfirmedDates||[]).join(', ')||'확인 필요'),details);
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
        surface.dataset.state = 'ready';
        const data = payload.data || {};
        const c=payload.meta?.cache||{};
        const checked=typeof c.checkedAt==='string'&&Number.isFinite(Date.parse(c.checkedAt))?new Date(c.checkedAt).toLocaleString('ko-KR'):null;
        const note=node('p',(c.stale?'저장된 이전 확인값':'저장된 정보')+(checked?' · '+checked:' · 확인시각 없음')+(c.currentness==='SOURCE_CHANGED'?' · 원천 변경 반영 대기':''));
        note.className='staffCacheNotice';note.dataset.stale=String(c.stale!==false);
        const refresh=node('button','최신 정보 확인');refresh.type='button';refresh.onclick=()=>{if(id===generation&&!detailPending){requested={...requested,refresh:true};void showRequested(id);}};
        if(data.memoState==='NEEDS_CONFIRMATION')node('p','구분되지 않거나 충돌한 항목은 확인이 필요합니다.');
        if(data.memoState==='DELETED')node('p','원천에서 삭제가 확인된 정보입니다.');
        const fields=data.fieldState||{};
        line('출입방법',data.accessInfo,fields.accessInfo);line('비밀번호',data.password,fields.password);
        line('보안키',data.securityKey,fields.securityKey||'UNOBSERVED');line('일반 키',data.generalKey,fields.generalKey||'UNOBSERVED');
        line('배송 특이사항',data.specialRemark,fields.specialRemark);line('배송요일',data.deliveryPattern,fields.deliveryPattern||'UNOBSERVED');
        clearTimeout(refreshTimer);
        refreshTimer=setTimeout(()=>{if(id===generation&&requested&&!document.hidden&&!detailPending){requested={...requested,refresh:true};void showRequested(id);}},60000);

      }
    } catch (error) {
      if (error.name === 'AbortError' || id !== generation) return;
      if(error.detailCode==='PLANNED_SOURCE_UNOBSERVED'){
        shell('예정 배차자료 확인 대기');surface.dataset.state='not-ready';
        node('p','선택한 배송일의 예정 자료를 아직 확인하지 못했습니다. 보호정보 조회 완료로 처리하지 않았습니다.');return;
      }
      if (['DETAIL_SOURCE_AUTH_REQUIRED','DETAIL_SOURCE_FORBIDDEN'].includes(error.detailCode)) {
        shell('원천 조회 권한 확인 필요'); surface.dataset.state='source-auth';
        node('p','직원 로그인은 유지 중입니다. 원천 인증 또는 선택 매장의 조회 권한을 확인해야 합니다.');
        node('button','다시 확인').onclick=()=>{if(id===generation&&!detailPending)void showRequested(id);};
        return;
      }
      if (error.status === 401) {
        sessionHint = null;
        if (!window.MapStaffEntry?.session()?.authenticated) { void window.MapStaffEntry?.expire(); return; }
        shell('원천 인증 확인 필요'); surface.dataset.state = 'source-auth';
        node('p', '직원 로그인은 유지 중입니다. 선택 매장의 원천 조회 권한 또는 원천 인증을 확인해야 합니다.');
        node('button', '다시 확인').onclick = () => { if (id === generation && !detailPending) void showRequested(id); };
        return;
      }
      if (error.notReady) {
        shell('기사 이력 준비 중'); surface.dataset.state = 'not-ready';
        node('p', '기사 이력이 아직 준비되지 않았습니다. 기사 없음으로 판단하지 마세요. 공개 고객정보와 지도는 계속 사용할 수 있습니다.');
        node('button', '다시 확인').onclick = () => { if (id === generation && !detailPending) void showRequested(id); };
        return;
      }
      shell(target.kind === 'history' ? '기사 이력 조회 실패' : '보호 상세 조회 실패'); node('p', error.sourceChanged ? '조회 중 원천 데이터가 변경되었습니다. 다시 시도해 주세요.' : error.detailCode === 'DETAIL_NOT_FOUND' ? '선택한 고객·배송일의 보호정보를 확인하지 못했습니다. 정보가 삭제된 것으로 처리하지 않습니다.' : error.detailCode === 'DETAIL_INVALID_RESPONSE' ? '원천 응답이 선택한 고객·배송일과 일치하지 않아 표시하지 않았습니다.' : error.detailCode === 'DETAIL_SOURCE_RATE_LIMITED' ? '원천 조회가 일시 제한되었습니다. 잠시 후 다시 시도해 주세요.' : error.status === 504 ? '원천 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.' : error.status === 422 ? '원천 데이터 확인이 필요합니다.' : '원천 조회를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      surface.dataset.state = 'error';
      node('p', '공개 고객정보와 지도는 계속 사용할 수 있습니다.');
      node('button', '다시 시도').onclick = () => { if (id === generation && !detailPending) void showRequested(id); };
    } finally { clearTimeout(delayNotice); if (id === generation) detailPending = false; }
  }
  async function open(target, host=null, trigger=null) {
    if(host&&host===inlineHost&&trigger===inlineTrigger&&requested?.kind===target.kind&&requested?.customerCode===target.customerCode){clear();return;}
    if(detailPending&&!host&&JSON.stringify(requested)===JSON.stringify(target))return;
    clear();inlineHost=host?.isConnected?host:null;inlineTrigger=trigger||null;
    if(inlineHost){inlineHost.hidden=false;inlineTrigger?.setAttribute('aria-expanded','true');}
    requested={...target};const id=generation;
    if (sessionHint?.authenticated && Date.now() < Math.min(sessionHint.expiresAt, sessionHint.idleExpiresAt)) { deadline(sessionHint); void showRequested(id); return; }
    if(window.MapStaffEntry){
      const session=await window.MapStaffEntry.check();
      if(id!==generation||!session?.authenticated)return;
      deadline(session);void showRequested(id);return;
    }
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
  window.addEventListener('map-staff-signed-out',()=>{sessionHint=null;clear();});
  window.addEventListener('map-staff-session',event=>{if(event.detail?.authenticated===false){sessionHint=null;clear();}});
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
  const hostWatcher=new MutationObserver(()=>{if(inlineHost&&!inlineHost.isConnected)clear();});hostWatcher.observe(document.body,{childList:true,subtree:true});
  window.MapStaff = Object.freeze({ open, clear, logout });
})();

