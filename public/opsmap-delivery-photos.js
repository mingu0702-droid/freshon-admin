/* Protected delivery images stay in the active view's memory; never use the map cache. */
(() => {
  'use strict';
  const API = '/api/map-phase2b/private/delivery-photos';
  const KINDS = Object.freeze({ REFRIGERATOR_DOOR: '냉장고 문 확인', ENTRANCE_LOCK: '출입문 잠금 확인' });
  const MAX_PHOTOS = 40, MAX_IMAGE_BYTES = 4 * 1024 * 1024, MAX_JSON_BYTES = 256 * 1024;
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const safeText = (value, maximum) => typeof value === 'string' && value.length <= maximum;
  function mediaPath(value) {
    if (typeof value !== 'string') throw Error('UNVERIFIED');
    const url = new URL(value, location.href);
    if (url.origin !== location.origin || url.username || url.password || url.search || url.hash || !/^\/api\/map-phase2b\/private\/delivery-photos\/media\/[A-Za-z0-9_-]{8,160}$/.test(url.pathname)) throw Error('UNVERIFIED');
    return url.pathname;
  }
  function normalize(payload, target) {
    const data = payload?.ok === true && payload.data;
    if (!data || data.customerCode !== target.customerCode || !Array.isArray(data.deliveries) || data.deliveries.length > 100) throw Error('UNVERIFIED');
    const identities = new Set();
    return data.deliveries.map(delivery => {
      if (delivery.customerCode !== target.customerCode || !validDate(delivery.date) || !safeText(delivery.deliveryId, 128) || !delivery.deliveryId || (target.date && delivery.date !== target.date) || (target.deliveryId && delivery.deliveryId !== target.deliveryId)) throw Error('UNVERIFIED');
      const identity = delivery.date + '\n' + delivery.deliveryId;
      if (identities.has(identity)) throw Error('UNVERIFIED');
      identities.add(identity);
      if (!['READY', 'EMPTY', 'UNVERIFIED'].includes(delivery.status) || !Array.isArray(delivery.photos) || delivery.photos.length > MAX_PHOTOS || !safeText(delivery.notes || '', 4000)) throw Error('UNVERIFIED');
      const photos = [], ids = new Set(); let unclassified = false;
      for (const photo of delivery.photos) {
        if (!safeText(photo.id, 128) || !photo.id || ids.has(photo.id)) throw Error('UNVERIFIED');
        ids.add(photo.id);
        if (!KINDS[photo.kind]) { unclassified = true; continue; }
        photos.push({ id: photo.id, kind: photo.kind, thumbnailUrl: mediaPath(photo.thumbnailUrl), url: mediaPath(photo.url) });
      }
      if (delivery.status === 'EMPTY' && delivery.photos.length) throw Error('UNVERIFIED');
      return { customerCode: delivery.customerCode, date: delivery.date, deliveryId: delivery.deliveryId, notes: delivery.notes || '', status: unclassified ? 'UNVERIFIED' : delivery.status, photos };
    }).sort((a, b) => b.date.localeCompare(a.date) || a.deliveryId.localeCompare(b.deliveryId));
  }
  function node(tag, text, parent, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    parent?.append(result); return result;
  }
  function createController({ host, fetcher = window.fetch.bind(window), requestTimeoutMs = 15000 } = {}) {
    let generation = 0, requestController, timer, deadline = 0, target = null, deliveries = [], selected = null, photoList = [], urls = new Set(), viewerUrl = null, viewerController = null, viewerIndex = -1, focusBeforeViewer = null;
    const imagePromises = new Map(); // Current view only, keyed by opaque same-origin handle.
    const viewer = node('div', undefined, document.body, 'deliveryPhotoViewer'); viewer.hidden = true;
    viewer.setAttribute('role', 'dialog'); viewer.setAttribute('aria-modal', 'true'); viewer.setAttribute('aria-label', '납품 사진 확대 보기');
    const head = node('header', undefined, viewer), viewerTitle = node('h2', '', head), closeButton = node('button', '닫기', head);
    closeButton.type = 'button'; closeButton.setAttribute('aria-label', '확대 사진 닫기');
    const stage = node('div', undefined, viewer, 'deliveryPhotoStage'), foot = node('footer', undefined, viewer);
    const previous = node('button', '이전', foot), count = node('p', '', foot), next = node('button', '다음', foot);
    previous.type = next.type = 'button'; previous.setAttribute('aria-label', '이전 사진'); next.setAttribute('aria-label', '다음 사진');
    function closeViewer() {
      viewerController?.abort(); viewerController = null; viewerIndex = -1;
      stage.replaceChildren(); viewer.hidden = true;
      viewerUrl = null; // Shared with the active thumbnail until purge().
      if (focusBeforeViewer?.isConnected) focusBeforeViewer.focus(); focusBeforeViewer = null;
    }
    function purge() {
      generation++; requestController?.abort(); requestController = null; clearTimeout(timer); closeViewer();
      for (const url of urls) URL.revokeObjectURL(url); urls.clear();
      imagePromises.clear();
      deliveries = []; selected = null; photoList = []; host.replaceChildren();
    }
    function shell(message, state, action) {
      host.replaceChildren(); host.dataset.state = state;
      node('h3', '납품 사진', host);
      const status = node('p', message, host, 'deliveryPhotoStatus'); status.setAttribute('role', 'status');
      if (action) { const button = node('button', action.label, host); button.type = 'button'; button.onclick = action.run; }
    }
    function block(message = '직원 인증이 만료되었습니다. 로그인 후 다시 조회해 주세요.') {
      purge(); deadline = 0;
      shell(message, 'auth-required', { label: '직원 로그인', run: () => window.MapStaff?.open({ kind: 'notes', customerCode: target?.customerCode, date: target?.date }) });
      const retry = node('button', '로그인 후 다시 조회', host); retry.type = 'button'; retry.onclick = () => target && open(target);
    }
    function alive(id) { return id === generation && !requestController?.signal.aborted && deadline > Date.now(); }
    async function readBody(response, maximum, signal) {
      if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw Error('BODY_TOO_LARGE'); }
      const reader = response.body?.getReader(); if (!reader) throw Error('BODY_UNAVAILABLE');
      const parts = []; let bytes = 0;
      const abort = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        while (true) {
          if (signal.aborted) throw new DOMException('Request aborted', 'AbortError');
          const { done, value } = await reader.read();
          if (signal.aborted) throw new DOMException('Request aborted', 'AbortError');
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maximum) { await reader.cancel(); throw Error('BODY_TOO_LARGE'); }
          parts.push(value);
        }
        const joined = new Uint8Array(bytes); let offset = 0;
        for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
        return joined;
      } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
    }
    async function request(path, options = {}, consume = async (response, signal) => JSON.parse(new TextDecoder().decode(await readBody(response, MAX_JSON_BYTES, signal)))) {
      const timeout = new AbortController(), timeoutId = setTimeout(() => timeout.abort(), requestTimeoutMs);
      const signal = options.signal || requestController?.signal;
      const abort = () => timeout.abort(); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) timeout.abort();
      let response;
      try {
        response = await fetcher(path, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', ...options, signal: timeout.signal });
        if (!response.ok) {
          let code = '';
          try { const body = JSON.parse(new TextDecoder().decode(await readBody(response, 4096, timeout.signal))); const candidate = typeof body.error === 'string' ? body.error : body.error?.code || ''; code = /^[A-Z_]{1,64}$/.test(candidate) ? candidate : ''; } catch (_) { /* No raw server body retained. */ }
          throw Object.assign(Error(code || 'REQUEST_FAILED'), { status: response.status });
        }
        return await consume(response, timeout.signal);
      } finally { clearTimeout(timeoutId); signal?.removeEventListener('abort', abort); if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
    }
    async function authorize(id) {
      const session = await request('/api/map-phase2b/auth/session');
      if (id !== generation) return false;
      const end = Math.min(Number(session.expiresAt), Number(session.idleExpiresAt));
      if (session.authenticated !== true || !Number.isFinite(end) || end <= Date.now()) { block(); return false; }
      deadline = end; clearTimeout(timer);
      timer = setTimeout(() => block(), Math.min(end - Date.now(), 2147483647)); return true;
    }
    function failure(error, id) {
      if (id !== generation) return;
      if (error.status === 401) { block(); return; }
      purge(); const current = generation;
      if (error.message === 'UPSTREAM_AUTH_REQUIRED') { shell('Delivery Admin 인증 연결이 필요합니다. 직원 로그인은 유지됩니다.', 'upstream-auth-required'); return; }
      if (error.message === 'PHOTO_SOURCE_DISABLED') { shell('납품 사진 연결이 비활성 상태입니다.', 'source-disabled'); return; }
      const forbidden = error.status === 403, unverified = ['UNVERIFIED', 'SOURCE_UNAVAILABLE', 'NOT_CONFIGURED', 'INVALID_SOURCE_RESPONSE'].includes(error.message) || error.status === 404 || error.status === 422 || error.status === 503;
      shell(forbidden ? '사진 조회 권한이 없습니다.' : unverified ? '사진 미확인 · 배송 사진 원천 또는 연결 상태를 확인해 주세요.' : '사진 조회 실패 · 잠시 후 다시 시도해 주세요.', forbidden ? 'forbidden' : unverified ? 'unverified' : 'error', forbidden ? null : { label: '다시 조회', run: () => current === generation && target && open(target) });
    }
    async function image(path, signal) {
      if (deadline <= Date.now()) throw Object.assign(Error('AUTH_REQUIRED'), { status: 401 });
      if (!imagePromises.has(path)) {
        const id = generation, viewSignal = requestController?.signal;
        imagePromises.set(path, (async () => {
          const blob = await request(path, { signal: viewSignal }, async (response, requestSignal) => {
            const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
            if (!/^image\/(jpeg|png|webp)$/.test(type)) throw Error('UNVERIFIED');
            return new Blob([await readBody(response, MAX_IMAGE_BYTES, requestSignal)], { type });
          });
          if (id !== generation || viewSignal?.aborted || deadline <= Date.now()) throw Object.assign(Error('AUTH_REQUIRED'), { status: 401 });
          const url = URL.createObjectURL(blob); urls.add(url); return url;
        })());
      }
      const url = await imagePromises.get(path);
      if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      if (deadline <= Date.now()) throw Object.assign(Error('AUTH_REQUIRED'), { status: 401 });
      return url;
    }
    async function enlarge(index) {
      if (deadline <= Date.now()) { block(); return; }
      if (!photoList[index]) return;
      const id = generation;
      viewerController?.abort(); viewerController = new AbortController(); const controller = viewerController;
      if (viewer.hidden) focusBeforeViewer = document.activeElement;
      viewerIndex = index; stage.replaceChildren(); viewer.hidden = false; closeButton.focus();
      viewerUrl = null;
      viewerTitle.textContent = selected.date + ' · ' + KINDS[photoList[index].kind];
      count.textContent = `${index + 1} / ${photoList.length}`; previous.disabled = index === 0; next.disabled = index === photoList.length - 1;
      node('p', '사진 불러오는 중…', stage, 'deliveryPhotoViewerStatus');
      try {
        const url = await image(photoList[index].url, controller.signal);
        if (!alive(id) || controller.signal.aborted || viewerIndex !== index) return;
        viewerUrl = url; stage.replaceChildren(); const img = node('img', undefined, stage); img.alt = KINDS[photoList[index].kind] + ' 확대 사진'; img.src = url;
        img.onerror = () => { if (viewerIndex === index && alive(id)) { stage.replaceChildren(); node('p', '사진 파일을 열지 못했습니다.', stage, 'deliveryPhotoViewerStatus'); } };
      } catch (error) {
        if (controller.signal.aborted || id !== generation) return;
        if (error.status === 401 || error.status === 403) { failure(error, id); return; }
        stage.replaceChildren(); node('p', error.status === 410 || error.status === 404 ? '삭제되었거나 사용할 수 없는 사진입니다.' : '사진 조회 실패', stage, 'deliveryPhotoViewerStatus');
      }
    }
    function renderList() {
      host.replaceChildren(); host.dataset.state = 'ready'; node('h3', '납품 사진', host);
      const label = node('label', '배송일 · 배송 기록', host), select = node('select', undefined, label); select.setAttribute('aria-label', '납품 사진 배송일');
      deliveries.forEach((delivery, i) => { const option = node('option', delivery.date + ' · ' + delivery.deliveryId, select); option.value = String(i); });
      const button = node('button', '조회', host); button.type = 'button'; button.onclick = () => selectDelivery(deliveries[Number(select.value)]);
      const body = node('div', undefined, host); body.id = 'deliveryPhotoContent';
      return { select, body };
    }
    async function selectDelivery(delivery) {
      if (!delivery) return;
      const list = deliveries.slice(); purge(); deliveries = list;
      const id = generation; selected = delivery; requestController = new AbortController();
      const { select, body } = renderList(); select.value = String(deliveries.findIndex(d => d.date === delivery.date && d.deliveryId === delivery.deliveryId));
      node('p', '사진 불러오는 중…', body, 'deliveryPhotoStatus');
      try {
        if (!await authorize(id)) return;
        const params = new URLSearchParams({ customerCode: target.customerCode, date: delivery.date, deliveryId: delivery.deliveryId });
        const exact = normalize(await request(API + '?' + params), { customerCode: target.customerCode, date: delivery.date, deliveryId: delivery.deliveryId });
        if (!alive(id)) return;
        if (exact.length !== 1) throw Error('UNVERIFIED');
        selected = exact[0]; photoList = selected.photos;
        body.replaceChildren();
        if (selected.status === 'UNVERIFIED') { node('p', '사진 미확인 · 사진 분류 또는 원천 확인이 필요합니다.', body, 'deliveryPhotoStatus'); host.dataset.state = 'unverified'; }
        if (!photoList.length && selected.status !== 'UNVERIFIED') { node('p', '사진 없음 · 해당 배송에 등록된 사진이 없습니다.', body, 'deliveryPhotoStatus'); host.dataset.state = 'empty'; }
        const groups = node('div', undefined, body, 'deliveryPhotoGroups'), tasks = [];
        for (const [kind, title] of Object.entries(KINDS)) {
          const group = node('section', undefined, groups); node('h4', title, group);
          const matching = photoList.filter(photo => photo.kind === kind);
          if (!matching.length) { node('p', selected.status === 'UNVERIFIED' ? '미확인' : '사진 없음', group, 'deliveryPhotoMissing'); continue; }
          const grid = node('div', undefined, group, 'deliveryPhotoGrid');
          for (const photo of matching) {
            const index = photoList.indexOf(photo), thumb = node('button', undefined, grid, 'deliveryPhotoThumb'); thumb.type = 'button'; thumb.setAttribute('aria-label', title + ' 사진 ' + (index + 1) + ' 확대'); thumb.onclick = () => enlarge(index);
            node('span', '불러오는 중', thumb, 'deliveryPhotoMissing');
            tasks.push(async () => { try { const url = await image(photo.thumbnailUrl, requestController.signal); if (!alive(id)) { URL.revokeObjectURL(url); urls.delete(url); return; } thumb.replaceChildren(); const img = node('img', undefined, thumb); img.alt = title + ' 썸네일'; img.src = url; img.onerror = () => { thumb.replaceChildren(); node('span', '파일 미확인', thumb, 'deliveryPhotoMissing'); }; } catch (error) { if (!alive(id)) return; if (error.status === 401 || error.status === 403) { failure(error, id); return; } thumb.replaceChildren(); node('span', error.status === 404 || error.status === 410 ? '삭제된 사진' : '조회 실패', thumb, 'deliveryPhotoMissing'); } });
          }
        }
        node('p', selected.notes ? '배송 특이사항\n' + selected.notes : '배송 특이사항 없음', body, 'deliveryPhotoNotes');
        // At most two thumbnail bodies are in flight; no preload of other dates or originals.
        const work = async () => { while (tasks.length && alive(id)) await tasks.shift()(); };
        await Promise.all([work(), work()]);
      } catch (error) { if (!requestController?.signal.aborted) failure(error, id); }
    }
    async function open(value) {
      purge(); target = { customerCode: String(value.customerCode || ''), ...(validDate(value.date) ? { date: value.date } : {}) };
      if (!target.customerCode || target.customerCode.length > 128) { shell('사진 미확인 · 고객코드가 필요합니다.', 'unverified'); return; }
      const id = generation; requestController = new AbortController(); shell('배송 기록 확인 중…', 'loading');
      try {
        if (!await authorize(id)) return;
        const list = normalize(await request(API + '?' + new URLSearchParams(target)), target);
        if (!alive(id)) return;
        deliveries = list;
        if (!list.length) { shell('사진 없음 · 조회 가능한 배송 기록이 없습니다.', 'empty'); return; }
        const selectedDelivery = list.find(d => d.date === target.date) || list[0];
        await selectDelivery(selectedDelivery);
      } catch (error) { if (!requestController?.signal.aborted) failure(error, id); }
    }
    function clear() { purge(); target = null; deadline = 0; }
    closeButton.onclick = closeViewer; previous.onclick = () => enlarge(viewerIndex - 1); next.onclick = () => enlarge(viewerIndex + 1);
    viewer.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeViewer(); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); enlarge(viewerIndex - 1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); enlarge(viewerIndex + 1); }
      if (event.key === 'Tab') { const buttons = [closeButton, previous, next].filter(b => !b.disabled); const index = buttons.indexOf(document.activeElement); event.preventDefault(); buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus(); }
    });
    return Object.freeze({ open, clear, expire: block, destroy() { clear(); viewer.remove(); } });
  }
  let current = null, currentHost = null, mounted = false, observing = false, observer;
  function reset() { current?.destroy(); current = null; currentHost?.remove(); currentHost = null; }
  function mountSelection() {
    if (document.hidden) { reset(); return; }
    const state = window.MapUiLocalBridge?.state, row = state?.selected, detail = document.querySelector('#detailSection.open #detail .detailBody');
    if (!row?.customerCode || !detail) { reset(); return; }
    if (currentHost?.isConnected && currentHost.dataset.customerCode === String(row.customerCode)) return;
    reset(); currentHost = node('section', undefined, detail, 'deliveryPhotos'); currentHost.dataset.customerCode = String(row.customerCode); currentHost.setAttribute('aria-label', '납품 사진');
    current = createController({ host: currentHost });
    node('h3', '납품 사진', currentHost); node('p', '직원 인증 후 배송일별 사진을 조회합니다.', currentHost, 'deliveryPhotoStatus');
    const button = node('button', '납품 사진 조회', currentHost); button.type = 'button'; button.onclick = () => current?.open({ customerCode: row.customerCode, date: state.mode === 'DATE_ROUTE' ? state.selectedDate : row.lastDeliveryDate });
  }
  function schedule() { if (observing) return; observing = true; queueMicrotask(() => { observing = false; mountSelection(); }); }
  function mount() {
    if (mounted) return; mounted = true;
    observer = new MutationObserver(schedule); const root = document.querySelector('#detailSection'); if (root) observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    window.addEventListener('map-store-selected', () => { reset(); schedule(); });
    window.addEventListener('map-navigation-logout', () => current?.expire());
    document.querySelector('#staffLogout')?.addEventListener('click', () => current?.expire());
    document.addEventListener('visibilitychange', () => { if (document.hidden) { reset(); } else schedule(); });
    window.addEventListener('pagehide', reset);
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('map-staff-session') : null;
    channel?.addEventListener('message', event => { if (event.data === 'logout') current?.expire(); });
    schedule();
  }
  window.MapDeliveryPhotos = Object.freeze({ mount, createController, normalize, mediaPath });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
})();
