// Phone details live only in the selected authenticated card, never IndexedDB.
(function (root) {
  function phoneHref(value) {
    const compact = String(value || '').replace(/[\s()-]/g, '');
    return /^(?:0\d{8,10}|\+82\d{8,10})$/.test(compact) ? 'tel:' + compact : null;
  }
  function paint(target, value) {
    if (!target) return;
    target.replaceChildren(); target.removeAttribute('title');
    target.dataset.state = value.state || 'UNREGISTERED';
    target.dataset.source = value.meta?.source || '';
    if (!value.name) {
      target.textContent=({LOADING:'담당 기사 불러오는 중…',ERROR:'담당 기사 조회 실패',ASSIGNMENT_UNCONFIRMED:'기사정보 확인 필요',
        UNCONNECTED:'기사 연락처 자료 미연결',AUTH_REQUIRED:'직원 로그인이 필요합니다.',FORBIDDEN:'기사정보 조회 권한을 확인해 주세요.'})[value.state]||'담당 기사 정보 없음';
      return;
    }
    const name = document.createElement('span'); name.textContent = value.name; target.append(name);
    const href = phoneHref(value.phone);
    if (href) { target.append(document.createTextNode(' · ')); const link = document.createElement('a'); link.href = href; link.textContent = value.phone; link.setAttribute('aria-label', value.name + ' 기사에게 전화'); target.append(link); }
    else if(value.state === 'PHONE_UNREGISTERED') target.append(document.createTextNode(' · 연락처 미등록'));
  }
  function create({ fetcher = root.fetch.bind(root), getTarget, onRender = () => {}, refreshMs = 60000 } = {}) {
    let generation = 0, current = '', saved = null, savedAt = 0, pending = null, controller = null;
    const render = value => { paint(getTarget(), value); onRender(); };
    function clear() { generation++; controller?.abort(); current = ''; saved = null; savedAt = 0; pending = null; const target = getTarget(); if (target) target.replaceChildren(); }
    async function load(context) {
      if (!context) { clear(); render({ state: 'ASSIGNMENT_UNCONFIRMED' }); return; }
      const identity = JSON.stringify(context);
      if (identity === current && saved && Date.now()-savedAt < refreshMs) { render(saved); return; }
      if (identity === current && pending) { render({ state: 'LOADING' }); return pending; }
      clear(); current = identity; const owner = generation; controller = new AbortController(); render({ state: 'LOADING' });
      pending = (async () => {
        let value;
        try {
          const response = await fetcher('/api/map-phase2b/private/driver-contact?' + new URLSearchParams(context), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
          const payload = await response.json();
          if (!response.ok) throw Object.assign(Error('DRIVER_CONTACT_FAILED'), { code: payload.error,status:response.status });
          if (!payload.ok || Object.entries(context).some(([key, expected]) => payload.meta?.[key] !== expected)) throw Error('DRIVER_CONTACT_CONTEXT_MISMATCH');
          const state = payload.meta.driverEvidence === 'UNCONFIRMED' ? 'ASSIGNMENT_UNCONFIRMED' : payload.meta.state;
          value = { state, name: payload.data?.driverName, phone: payload.data?.phone, meta: payload.meta };
        } catch (error) {
          if (error.name === 'AbortError') return;
          const code = error.code || '';
          const state = error.status===401?'AUTH_REQUIRED':error.status===403?'FORBIDDEN':
            /^DRIVER_(?:ASSIGNMENT_(?:UNCONFIRMED|NOT_FOUND|CONFLICT)|MASTER_CONFLICT|SOURCE_CONFLICT|EFFECTIVE_DATE_INVALID)$/.test(code)
            ? 'ASSIGNMENT_UNCONFIRMED'
            : /^DRIVER_(?:CONTACT_DISABLED|CENTER_SOURCE_UNVERIFIED|CREDENTIALS_(?:MISSING|INVALID)|SHEET_CONFIG_INVALID|SOURCE_NOT_CONFIGURED)$/.test(code)
              ? 'UNCONNECTED' : 'ERROR';
          value = {state};
        }
        if (owner !== generation || identity !== current || document.body.dataset.mapStaffState !== 'authenticated') return;
        saved = value; savedAt=Date.now(); render(value);
      })().finally(() => { if (owner === generation) pending = null; });
      return pending;
    }
    root.addEventListener('map-staff-signed-out', clear);
    root.addEventListener('map-store-selected', event => { if (!event.detail?.customerCode) clear(); });
    return { load, clear };
  }
  root.MapDriverContact = Object.freeze({ create, paint, phoneHref });
})(typeof window === 'undefined' ? globalThis : window);
