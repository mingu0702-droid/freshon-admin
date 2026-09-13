(() => {
  'use strict';
  let generation = 0, controller = null, expiryTimer = null, requested = null;
  const dialog = document.createElement('dialog');
  dialog.id = 'mapStaffDialog';
  dialog.setAttribute('aria-label', '직원용 보호 상세');
  document.body.append(dialog);
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('map-staff-session') : null;
  function clear() {
    generation++; controller?.abort(); controller = null; clearTimeout(expiryTimer);
    requested = null; dialog.replaceChildren(); if (dialog.open) dialog.close();
  }
  function node(tag, text, parent = dialog) { const item = document.createElement(tag); item.textContent = text; parent.append(item); return item; }
  function shell(title) {
    dialog.replaceChildren();
    node('h2', title);
    const close = node('button', '닫기'); close.type = 'button'; close.addEventListener('click', clear);
    if (!dialog.open) dialog.showModal();
  }
  async function request(path, options = {}) {
    controller?.abort(); controller = new AbortController();
    const response = await fetch('/api/map-phase2b/' + path, { ...options, cache: 'no-store', credentials: 'same-origin',
      signal: controller.signal, headers: { 'content-type': 'application/json', ...options.headers } });
    if (!response.ok) throw Object.assign(new Error('REQUEST_FAILED'), { status: response.status });
    return response.json();
  }
  function deadline(session) {
    clearTimeout(expiryTimer);
    if (session?.authenticated) expiryTimer = setTimeout(clear, Math.max(0, Math.min(session.expiresAt, session.idleExpiresAt) - Date.now()));
  }
  async function logout() {
    clear(); channel?.postMessage('logout');
    try { await request('auth/logout', { method: 'POST', body: '{}' }); }
    catch (error) { if (error.name !== 'AbortError') { shell('로그아웃 확인 필요'); node('p', '화면 정보는 지웠지만 서버 로그아웃을 확인하지 못했습니다. 다시 시도해 주세요.'); node('button', '로그아웃 재시도').onclick = logout; } }
  }
  function loginForm(id) {
    shell('직원 공용 로그인');
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
        deadline(session); await showRequested(id);
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
    shell(target.kind === 'history' ? '최근 배송기사 이력' : '출입·배송 메모'); node('p', '불러오는 중…');
    try {
      const query = new URLSearchParams({ customerCode: target.customerCode, date: target.date || '' });
      if (target.rangeStart) query.set('startDate', target.rangeStart);
      if (target.rangeEnd) query.set('endDate', target.rangeEnd);
      const payload = await request('private/' + (target.kind === 'history' ? 'driver-history' : 'customer-detail') + '?' + query);
      if (id !== generation) return;
      const session = await request('auth/session');
      if (id !== generation) return;
      if (!session.authenticated) { clear(); return; }
      deadline(session); shell(target.kind === 'history' ? '최근 배송기사 이력' : '출입·배송 메모');
      node('button', '로그아웃').onclick = logout;
      if (target.kind === 'history') {
        const rows = Array.isArray(payload.data) ? payload.data : [];
        if (!rows.length) node('p', '선택 기간의 원천 이력이 없습니다.');
        rows.forEach(row => line(row.deliveryDate + ' · ' + (row.vehicle || '미등록') + '호 · ' + (row.kind === 'COMPLETED' ? '방문 완료' : '배차'), [row.driverName || '기사 미등록', row.driverPhone || '연락처 미등록'].join(' · ')));
      } else {
        const data = payload.data || {};
        if (data.memoState === 'NEEDS_CONFIRMATION') node('p', '허용 항목을 확실히 구분할 수 없어 원천 확인이 필요합니다.');
        line('출입방법', data.accessInfo); line('비밀번호', data.password); line('배송 특이사항', data.specialRemark); line('배송요일', data.deliveryPattern || '미등록');
      }
    } catch (error) {
      if (error.name === 'AbortError' || id !== generation) return;
      if (error.status === 401) { loginForm(id); return; }
      shell('보호 상세 조회 실패'); node('p', '원천 조회를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
  }
  async function open(target) {
    clear(); requested = { ...target }; const id = generation;
    shell('직원 인증 확인'); node('p', '불러오는 중…');
    try {
      const session = await request('auth/session');
      if (id !== generation) return;
      if (!session.authenticated) loginForm(id); else { deadline(session); await showRequested(id); }
    } catch (error) { if (error.name !== 'AbortError' && id === generation) { shell('인증 상태 확인 실패'); node('p', '잠시 후 다시 시도해 주세요.'); } }
  }
  channel?.addEventListener('message', event => { if (event.data === 'logout') clear(); });
  dialog.addEventListener('cancel', clear);
  window.addEventListener('pagehide', clear);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
  window.MapStaff = Object.freeze({ open, clear, logout });
})();
