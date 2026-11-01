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
    if (!value.name) { target.textContent = value.state === 'LOADING' ? '담당 기사 불러오는 중…' : value.state === 'ERROR' ? '담당 기사 조회 실패' : value.state === 'ASSIGNMENT_UNCONFIRMED' ? '담당 기사 확인 필요' : '담당 기사 정보 없음'; return; }
    const name = document.createElement('span'); name.textContent = value.name; target.append(name);
    const href = phoneHref(value.phone);
    if (href) { target.append(document.createTextNode(' · ')); const link = document.createElement('a'); link.href = href; link.textContent = value.phone; link.setAttribute('aria-label', value.name + ' 기사에게 전화'); target.append(link); }
  }
  function create({ fetcher = root.fetch.bind(root), getTarget, onRender = () => {} } = {}) {
    let generation = 0, current = '', saved = null, pending = null, controller = null;
    const render = value => { paint(getTarget(), value); onRender(); };
    function clear() { generation++; controller?.abort(); current = ''; saved = null; pending = null; const target = getTarget(); if (target) target.replaceChildren(); }
    async function load(context) {
      if (!context) { clear(); render({ state: 'ASSIGNMENT_UNCONFIRMED' }); return; }
      const identity = JSON.stringify(context);
      if (identity === current && saved) { render(saved); return; }
      if (identity === current && pending) { render({ state: 'LOADING' }); return pending; }
      clear(); current = identity; const owner = generation; controller = new AbortController(); render({ state: 'LOADING' });
      pending = (async () => {
        let value;
        try {
          const response = await fetcher('/api/map-phase2b/private/driver-contact?' + new URLSearchParams(context), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
          const payload = await response.json();
          if (!response.ok) throw Object.assign(Error('DRIVER_CONTACT_FAILED'), { code: payload.error });
          if (!payload.ok || Object.entries(context).some(([key, expected]) => payload.meta?.[key] !== expected)) throw Error('DRIVER_CONTACT_CONTEXT_MISMATCH');
          value = { state: payload.meta.state, name: payload.data?.driverName, phone: payload.data?.phone, meta: payload.meta };
        } catch (error) {
          if (error.name === 'AbortError') return;
          value = { state: /^DRIVER_ASSIGNMENT_/.test(error.code || '') ? 'ASSIGNMENT_UNCONFIRMED' : 'ERROR' };
        }
        if (owner !== generation || identity !== current || document.body.dataset.mapStaffState !== 'authenticated') return;
        saved = value; render(value);
      })().finally(() => { if (owner === generation) pending = null; });
      return pending;
    }
    root.addEventListener('map-staff-signed-out', clear);
    root.addEventListener('map-store-selected', event => { if (!event.detail?.customerCode) clear(); });
    return { load, clear };
  }
  root.MapDriverContact = Object.freeze({ create, paint, phoneHref });
})(typeof window === 'undefined' ? globalThis : window);
