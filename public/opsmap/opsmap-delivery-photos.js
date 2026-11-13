/* Protected delivery images stay in the active view's memory; never use the map cache. */
(() => {
  'use strict';
  const API = '/api/map-phase2b/private/delivery-photos';
  const KINDS = Object.freeze({FRONT_DOOR_DELIVERY:'매장 문 앞 납품 사진', INSIDE_DELIVERY:'매장 안 납품 사진'});
  const INDEX_KINDS = Object.keys(KINDS);
  const MAX_PHOTOS = 40, MAX_IMAGE_BYTES = 4 * 1024 * 1024, MAX_JSON_BYTES = 256 * 1024;
  const SAFE_FAILURE_CODES = new Set(['UNVERIFIED', 'SOURCE_UNAVAILABLE', 'NOT_CONFIGURED', 'INVALID_SOURCE_RESPONSE',
    'UPSTREAM_AUTH_REQUIRED', 'PHOTO_APPROVAL_REQUIRED', 'PHOTO_BUDGET_NOT_CONFIGURED', 'PHOTO_BUDGET_NOT_INITIALIZED', 'PHOTO_BUDGET_INVALID', 'PHOTO_BUDGET_NOT_APPROVED', 'PHOTO_BUDGET_EXHAUSTED', 'PHOTO_BUDGET_CONFLICT', 'PHOTO_BUDGET_READBACK_UNVERIFIED', 'PHOTO_BUDGET_UNAVAILABLE', 'PHOTO_SOURCE_DISABLED', 'PHOTO_LOOKUP_FAILED', 'PHOTO_FORBIDDEN', 'PHOTO_NOT_FOUND',
    'PHOTO_RATE_LIMITED', 'PHOTO_TIMEOUT', 'INVALID_PHOTO_RESPONSE', 'DELIVERY_IDENTITY_MISMATCH',
    'PHOTO_IDENTITY_UNVERIFIED', 'PHOTO_ATTACHMENTS_INVALID', 'PHOTO_ATTACHMENT_LIMIT_EXCEEDED',
    'PHOTO_IMAGES_INVALID', 'PHOTO_IMAGE_LIMIT_EXCEEDED', 'PHOTO_LOGIN_HTTP_ERROR', 'PHOTO_LOGIN_REDIRECT_REJECTED', 'PHOTO_LOGIN_NETWORK_ERROR', 'PHOTO_LOGIN_SESSION_MISSING', 'PHOTO_CONTENT_TYPE_INVALID', 'PHOTO_JSON_INVALID', 'PHOTO_BODY_UNAVAILABLE',
    'PHOTO_UPSTREAM_UNAVAILABLE', 'PHOTO_MEDIA_AUTH_REQUIRED', 'PHOTO_IMAGE_DECODE_FAILED', 'INVALID_MEDIA_URL', 'PHOTO_JSON_TOO_LARGE', 'INVALID_PHOTO_REQUEST', 'PHOTO_LIMIT_EXCEEDED', 'MEDIA_ORIGIN_REJECTED', 'INVALID_MEDIA_TYPE', 'MEDIA_TOO_LARGE', 'UPSTREAM_REDIRECT_REJECTED', 'PHOTO_HISTORY_CHANGED', 'PHOTO_HISTORY_INDEX_INVALID', 'PHOTO_HISTORY_NOT_CONFIGURED', 'PHOTO_HISTORY_INDEX_UNAVAILABLE']);
  const SAFE_STAGES=new Set(['source-session','source-login','source-http','source-task-search','source-task-detail','source-content-type','source-json','source-identity','source-attachments','source-category','source-media','source-timeout','source-size','source-index','staff-session']);
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const safeText = (value, maximum) => typeof value === 'string' && value.length <= maximum;
  const validRecordId = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
  const photoTitle = photo => KINDS[photo.kind];
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
    if (target.history && data.coverage !== 'INCOMPLETE') throw Error('UNVERIFIED');
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
        if (photo.kind === 'REFRIGERATOR_DOOR' || photo.kind === 'ENTRANCE_LOCK') continue;
        if (!Object.hasOwn(KINDS, photo.kind)) { unclassified = true; continue; }
        if (!validRecordId(photo.recordId) || !validRecordId(delivery.deliveryId)) throw Error('UNVERIFIED');
        photos.push({ id: photo.id, kind: photo.kind, thumbnailUrl: mediaPath(photo.thumbnailUrl), url: mediaPath(photo.url),
          recordId:photo.recordId, date:delivery.date, deliveryId:delivery.deliveryId });
      }
      if (delivery.status === 'EMPTY' && delivery.photos.length) throw Error('UNVERIFIED');
      return { customerCode: delivery.customerCode, date: delivery.date, deliveryId: delivery.deliveryId, notes: delivery.notes || '', status: unclassified ? 'UNVERIFIED' : delivery.status, photos };
    }).sort((a, b) => b.date.localeCompare(a.date) || (target.history
      ? b.deliveryId.length - a.deliveryId.length || b.deliveryId.localeCompare(a.deliveryId)
      : a.deliveryId.localeCompare(b.deliveryId)));
  }
  function normalizeIndexedHistory(payload, target) {
    const data = payload?.ok === true && payload.data;
    if (!data || data.mode !== 'INDEXED' || data.customerCode !== target.customerCode ||
        !['COMPLETE','COLLECTING','FAILED','AUTH_REQUIRED'].includes(data.state) ||
        !Array.isArray(data.items) || data.items.length > 24 ||
        INDEX_KINDS.some(kind => !Number.isSafeInteger(data.counts?.[kind]) || data.counts[kind] < 0) ||
        (data.nextCursor !== null && (typeof data.nextCursor !== 'string' || !/^[a-f0-9]{64}\.\d{1,8}$/.test(data.nextCursor)))) throw Error('UNVERIFIED');
    const {scope, counts, state, nextCursor} = data;
    if (scope !== null && (!validDate(scope?.from) || !validDate(scope?.through) || scope.from > scope.through ||
        !Number.isSafeInteger(scope.missingDays) || scope.missingDays < 0)) throw Error('UNVERIFIED');
    if (state === 'COMPLETE' && (!scope || scope.missingDays !== 0)) throw Error('UNVERIFIED');
    const seen = new Set();
    const items = data.items.map(({date, deliveryId, photo}) => {
      if (!validDate(date) || !validRecordId(deliveryId) || !INDEX_KINDS.includes(photo?.kind) ||
          !safeText(photo.id, 128) || !photo.id || seen.has(photo.id) ||
          !validRecordId(photo.recordId)) throw Error('UNVERIFIED');
      seen.add(photo.id);
      return {id:photo.id, kind:photo.kind, date, deliveryId, recordId:photo.recordId, url:mediaPath(photo.url)};
    });
    return {scope, counts, state, nextCursor, items};
  }
  function node(tag, text, parent, className) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    parent?.append(result); return result;
  }
  function createController({ host, fetcher = window.fetch.bind(window), requestTimeoutMs = 15000 } = {}) {
    let generation = 0, requestController, timer, deadline = 0, target = null, deliveries = [], selected = null, photoList = [], viewerController = null, viewerIndex = -1, focusBeforeViewer = null;
    let indexedPage = null;
    const images = new Map(); // Active thumbnails and the open viewer only.
    const viewer = node('div', undefined, document.body, 'deliveryPhotoViewer'); viewer.hidden = true;
    viewer.setAttribute('role', 'dialog'); viewer.setAttribute('aria-modal', 'true'); viewer.setAttribute('aria-label', '납품 사진 확대 보기');
    const head = node('header', undefined, viewer), viewerTitle = node('h2', '', head), closeButton = node('button', '닫기', head);
    closeButton.type = 'button'; closeButton.setAttribute('aria-label', '확대 사진 닫기');
    const stage = node('div', undefined, viewer, 'deliveryPhotoStage'), foot = node('footer', undefined, viewer);
    const previous = node('button', '이전', foot), count = node('p', '', foot), next = node('button', '다음', foot);
    previous.type = next.type = 'button'; previous.setAttribute('aria-label', '이전 사진'); next.setAttribute('aria-label', '다음 사진');
    function releaseImage(entry) {
      entry.controller.abort();
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    function closeViewer() {
      viewerController?.abort(); viewerController = null; viewerIndex = -1;
      stage.replaceChildren(); viewer.hidden = true;
      for (const [path, entry] of images) {
        if (entry.thumbnail) continue;
        releaseImage(entry);
        images.delete(path);
      }
      if (focusBeforeViewer?.isConnected) focusBeforeViewer.focus(); focusBeforeViewer = null;
    }
    function purge() {
      generation++; requestController?.abort(); requestController = null; clearTimeout(timer); closeViewer();
      delete host.dataset.failureCode;
      delete host.dataset.failureStage; delete host.dataset.failureHttp; delete host.dataset.failureSourceHttp;
      for (const entry of images.values()) releaseImage(entry);
      images.clear();
      deliveries = []; selected = null; photoList = []; indexedPage = null; host.replaceChildren();
    }
    function shell(message, state, action) {
      host.replaceChildren(); host.dataset.state = state;
      node('h3', '납품 사진', host);
      const status = node('p', message, host, 'deliveryPhotoStatus'); status.setAttribute('role', 'status');
      if (host.dataset.failureCode) node('small', host.dataset.failureCode, host);
      if (action) { const button = node('button', action.label, host); button.type = 'button'; button.onclick = action.run; }
    }
    function dateSearch() {
      const controls = node('div', undefined, host, 'deliveryPhotoControls');
      const label = node('label', '배송일 ', controls), input = node('input', undefined, label);
      input.type = 'date'; input.setAttribute('aria-label', '납품 사진 조회 배송일');
      input.value = target?.date || new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
      const button = node('button', '배송일 조회', controls); button.type = 'button';
      button.onclick = () => { if (target && validDate(input.value)) void open({customerCode: target.customerCode, date: input.value}); };
      if (target && !target.history) {
        const history = node('button', '과거 사진 조회', controls);
        history.type = 'button'; history.onclick = () => open({customerCode:target.customerCode, history:true});
      }
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
      const photoStage = path === '/api/map-phase2b/auth/session' ? 'staff-session' : path.includes('/media/') ? 'image' : path.includes('deliveryId=') ? 'task' : 'discovery';
      const abort = () => timeout.abort(); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) timeout.abort();
      let response;
      try {
        response = await fetcher(path, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', ...options, signal: timeout.signal });
        if (!response.ok) {
          let code = '', detail = {};
          try { const body = JSON.parse(new TextDecoder().decode(await readBody(response, 4096, timeout.signal))); const candidate = typeof body.error === 'string' ? body.error : body.error?.code || ''; code = /^[A-Z_]{1,64}$/.test(candidate) ? candidate : '';
            if (SAFE_STAGES.has(body.error?.stage)) detail.sourceStage=body.error.stage;
            if ([200,400,401,403,404,409,410,413,422,429,500,502,503,504].includes(body.error?.sourceHttpStatus)) detail.sourceHttpStatus=body.error.sourceHttpStatus; } catch (_) { /* No raw server body retained. */ }
          throw Object.assign(Error(code || 'REQUEST_FAILED'), { status: response.status, ...detail });
        }
        return await consume(response, timeout.signal);
      } catch (error) {
        if (timeout.signal.aborted && !signal?.aborted) error = Error('PHOTO_TIMEOUT');
        error.photoStage = photoStage; throw error;
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
      if (error.status === 401 && error.message !== 'UPSTREAM_AUTH_REQUIRED') { block(); return; }
      purge(); const current = generation;
      host.dataset.failureCode = SAFE_FAILURE_CODES.has(error.message) ? error.message : 'PHOTO_LOOKUP_FAILED';
      host.dataset.failureStage = SAFE_STAGES.has(error.sourceStage) ? error.sourceStage : ['staff-session', 'discovery', 'task', 'image'].includes(error.photoStage) ? error.photoStage : 'ui-response';
      if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) host.dataset.failureHttp = String(error.status);
      if ([200,400,401,403,404,409,410,413,422,429,500,502,503,504].includes(error.sourceHttpStatus)) host.dataset.failureSourceHttp=String(error.sourceHttpStatus);
      if (target?.history && ['PHOTO_HISTORY_NOT_CONFIGURED', 'PHOTO_HISTORY_INDEX_UNAVAILABLE', 'PHOTO_HISTORY_INDEX_INVALID'].includes(error.message)) {
        const pending = error.message === 'PHOTO_HISTORY_NOT_CONFIGURED';
        shell(pending ? '과거 사진 인덱스 연결 대기' : '과거 사진 인덱스 조회 실패', pending ? 'unverified' : 'error',
          {label:'다시 조회', run:() => current === generation && target && open(target)});
        dateSearch(); return;
      }
      if (error.message === 'UPSTREAM_AUTH_REQUIRED') { shell('Delivery Admin 인증 연결이 필요합니다. 직원 로그인은 유지됩니다.', 'upstream-auth-required'); return; }
      if (error.message === 'PHOTO_SOURCE_DISABLED') { shell('납품 사진 연결이 비활성 상태입니다.', 'source-disabled'); return; }
      if (error.message === 'PHOTO_UPSTREAM_UNAVAILABLE') {
        shell('사진 원천 서비스가 일시 중단되었습니다.', 'source-unavailable', {label:'다시 조회', run:() => current === generation && target && open(target)});
        return;
      }
      const sourceContractErrors = {
        PHOTO_CONTENT_TYPE_INVALID: '사진 원천 응답 형식이 JSON이 아닙니다.',
        PHOTO_JSON_INVALID: '사진 원천의 JSON 형식을 확인하지 못했습니다.',
        PHOTO_BODY_UNAVAILABLE: '사진 원천의 응답 내용을 읽지 못했습니다.',
        PHOTO_IDENTITY_UNVERIFIED: '사진 원천의 고객·배송일·배송 기록을 확인하지 못했습니다.',
        PHOTO_ATTACHMENTS_INVALID: '사진 원천의 첨부 목록 형식을 확인하지 못했습니다.',
        PHOTO_ATTACHMENT_LIMIT_EXCEEDED: '사진 원천의 첨부 목록이 허용 범위를 초과했습니다.',
        PHOTO_IMAGES_INVALID: '사진 원천의 이미지 목록 형식을 확인하지 못했습니다.',
        PHOTO_IMAGE_LIMIT_EXCEEDED: '사진 원천의 이미지 목록이 허용 범위를 초과했습니다.'
      };
      if (Object.hasOwn(sourceContractErrors, error.message)) { shell(sourceContractErrors[error.message], 'unverified'); if (!target?.history) dateSearch(); return; }
      const forbidden = error.status === 403, unverified = ['UNVERIFIED', 'SOURCE_UNAVAILABLE', 'NOT_CONFIGURED', 'INVALID_SOURCE_RESPONSE'].includes(error.message) || error.status === 404 || error.status === 422 || error.status === 503;
      shell(forbidden ? '사진 조회 권한이 없습니다.' : unverified ? '사진 미확인 · 배송 사진 원천 또는 연결 상태를 확인해 주세요.' : '사진 조회 실패 · 잠시 후 다시 시도해 주세요.', forbidden ? 'forbidden' : unverified ? 'unverified' : 'error', forbidden ? null : { label: '다시 조회', run: () => current === generation && target && open(target) });
    }
    async function image(path, signal, thumbnail = false) {
      if (deadline <= Date.now()) throw Object.assign(Error('AUTH_REQUIRED'), { status: 401 });
      let entry = images.get(path);
      if (!entry) {
        const id = generation, controller = new AbortController();
        entry = {controller, thumbnail, url:null};
        images.set(path, entry);
        entry.promise = (async () => {
          const blob = await request(path, { signal: controller.signal }, async (response, requestSignal) => {
            const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
            if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) throw Error('UNVERIFIED');
            return new Blob([await readBody(response, MAX_IMAGE_BYTES, requestSignal)], { type });
          });
          if (id !== generation || controller.signal.aborted || deadline <= Date.now()) throw Object.assign(Error('AUTH_REQUIRED'), { status: 401 });
          entry.url = URL.createObjectURL(blob);
          return entry.url;
        })();
      } else if (thumbnail) entry.thumbnail = true;
      const url = await entry.promise;
      if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      if (deadline <= Date.now()) throw Object.assign(Error('AUTH_REQUIRED'), { status: 401 });
      return url;
    }
    function mediaFailureText(error) {
      if (error.status === 404 || error.status === 410) return '사진 파일을 찾을 수 없습니다.';
      if (error.status === 403) return '사진 파일 접근이 거부되었습니다.';
      if (['PHOTO_MEDIA_AUTH_REQUIRED', 'UPSTREAM_AUTH_REQUIRED'].includes(error.message)) return '사진 파일 인증이 필요합니다.';
      if (error.message === 'PHOTO_UPSTREAM_UNAVAILABLE') return '사진 원천 서비스를 사용할 수 없습니다.';
      return '사진 파일을 불러오지 못했습니다.';
    }
    const requiresSession = error => error.status === 401 || error.message === 'UPSTREAM_AUTH_REQUIRED';
    const safeMediaCode = error => SAFE_FAILURE_CODES.has(error.message) ? error.message : 'PHOTO_LOOKUP_FAILED';
    async function enlarge(index) {
      if (deadline <= Date.now()) { block(); return; }
      if (!photoList[index]) return;
      const photo = photoList[index], title = photoTitle(photo);
      const id = generation;
      viewerController?.abort(); viewerController = new AbortController(); const controller = viewerController;
      if (viewer.hidden) focusBeforeViewer = document.activeElement;
      viewerIndex = index; stage.replaceChildren(); viewer.hidden = false; closeButton.focus();
      viewerTitle.textContent = photo.recordId
        ? `${photo.date} · 배송 ID ${photo.deliveryId} · 원본 기록 ID ${photo.recordId}`
        : (photo.date || selected?.date || '') + ' · ' + title;
      count.textContent = `${index + 1} / ${photoList.length}`; previous.disabled = index === 0; next.disabled = index === photoList.length - 1;
      node('p', '사진 불러오는 중…', stage, 'deliveryPhotoViewerStatus');
      try {
        if (!await authorize(id) || controller.signal.aborted) return;
        const url = await image(photo.url, controller.signal);
        if (!alive(id) || controller.signal.aborted || viewerIndex !== index) return;
        stage.replaceChildren(); const img = node('img', undefined, stage); img.alt = title + ' 확대 사진'; img.src = url;
        img.onerror = () => { if (viewerIndex === index && alive(id)) { stage.replaceChildren(); node('p', '사진 파일을 열지 못했습니다.', stage, 'deliveryPhotoViewerStatus'); } };
      } catch (error) {
        if (controller.signal.aborted || id !== generation) return;
        if (requiresSession(error) && (!target?.indexed || error.status === 401)) { failure(error, id); return; }
        stage.replaceChildren();
        node('p', mediaFailureText(error), stage, 'deliveryPhotoViewerStatus');
        node('small', safeMediaCode(error), stage);
      }
    }
    async function loadThumbnail(thumb, photo, title, id) {
      try {
        const url = await image(photo.thumbnailUrl, requestController.signal, true);
        if (!alive(id)) return false;
        const img = node('img');
        img.alt = title + ' 썸네일';
        img.src = url;
        try { await img.decode(); } catch { throw Error('PHOTO_IMAGE_DECODE_FAILED'); }
        if (!alive(id)) return false;
        thumb.replaceChildren(img);
        return true;
      } catch (error) {
        if (!alive(id)) return false;
        if (requiresSession(error)) { failure(error, id); return false; }
        thumb.replaceChildren();
        node('span', mediaFailureText(error), thumb, 'deliveryPhotoMissing');
        node('small', safeMediaCode(error), thumb);
        return false;
      }
    }
    function renderHistory(list) {
      shell('과거 기록 확인 필요', list.length ? 'ready' : 'unverified');
      dateSearch();
      const groups = node('div', undefined, host, 'deliveryPhotoGroups');
      photoList = list.flatMap(delivery => delivery.photos);
      const id = generation;
      for (const delivery of list) {
        const group = node('section', undefined, groups);
        node('h4', `${delivery.date} · 배송 ID ${delivery.deliveryId}`, group);
        const grid = node('div', undefined, group, 'deliveryPhotoGrid');
        for (const photo of delivery.photos) {
          const card = node('div', undefined, grid), index = photoList.indexOf(photo);
          const button = node('button', `원본 기록 ID ${photo.recordId} · 사진 확대`, card);
          button.type = 'button';
          button.onclick = () => enlarge(index);
          const preview = node('button', '썸네일 표시', card, 'deliveryPhotoThumb');
          preview.type = 'button';
          preview.onclick = async () => {
            preview.disabled = true;
            if (!await loadThumbnail(preview, photo, photoTitle(photo), id)) return;
            preview.disabled = false;
            preview.setAttribute('aria-label', '썸네일 확대');
            preview.onclick = () => enlarge(index);
          };
        }
      }
    }
    function renderIndexedHistory({scope, counts, state, nextCursor, items}, failedRefresh = false) {
      const total = INDEX_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
      const statuses = {COMPLETE: total ? '과거 사진 이력 확인 완료' : '사진 없음',
        COLLECTING:'과거 이력 확인 중', FAILED:'과거 이력 조회 실패', AUTH_REQUIRED:'과거 이력 조회 실패 · Delivery Admin 인증 필요'};
      shell(failedRefresh ? '과거 이력 갱신 실패 · 마지막 확인 목록입니다.' : statuses[state],
        failedRefresh ? 'stale' : state === 'COMPLETE' ? total ? 'ready' : 'empty' : state.toLowerCase(),
        failedRefresh || state !== 'COMPLETE' ? {label:'다시 조회', run:() => open(target)} : null);
      if (scope) node('p', `${scope.from} ~ ${scope.through} · 미확인 ${scope.missingDays}일`, host);
      dateSearch();
      photoList = items;
      const groups = node('div', undefined, host, 'deliveryPhotoGroups');
      for (const kind of INDEX_KINDS) {
        const title = KINDS[kind];
        const group = node('section', undefined, groups);
        node('h4', title + ' · ' + (counts[kind] || state === 'COMPLETE' ? `${counts[kind]}장` : '확인 중'), group);
        const list = node('ul', undefined, group);
        for (const [index, photo] of items.entries()) {
          if (photo.kind !== kind) continue;
          const row = node('li', undefined, list);
          const button = node('button', `${photo.date} · 사진 확대`, row);
          button.type = 'button'; button.onclick = () => enlarge(index);
        }
      }
      if (target.cursor) {
        const first = node('button', '사진 목록 처음으로', host);
        first.type = 'button'; first.onclick = () => open({customerCode:target.customerCode, history:true});
      }
      if (nextCursor) {
        const next = node('button', '이전 사진 더 보기', host);
        next.type = 'button'; next.onclick = () => open({customerCode:target.customerCode, history:true, cursor:nextCursor});
      }
    }
    function renderList() {
      host.replaceChildren(); host.dataset.state = 'ready'; node('h3', '납품 사진', host);
      dateSearch();
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
      host.dataset.state = 'loading';
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
        let loaded = 0, failed = 0;
        for (const [kind, title] of Object.entries(KINDS)) {
          const group = node('section', undefined, groups); node('h4', title, group);
          const matching = photoList.filter(photo => photo.kind === kind);
          if (!matching.length) { node('p', selected.status === 'UNVERIFIED' ? '미확인' : '사진 없음', group, 'deliveryPhotoMissing'); continue; }
          const grid = node('div', undefined, group, 'deliveryPhotoGrid');
          for (const photo of matching) {
            const index = photoList.indexOf(photo), thumb = node('button', undefined, grid, 'deliveryPhotoThumb'); thumb.type = 'button'; thumb.setAttribute('aria-label', title + ' 사진 ' + (index + 1) + ' 확대'); thumb.onclick = () => enlarge(index);
            node('span', '불러오는 중', thumb, 'deliveryPhotoMissing');
            tasks.push(async () => {
              if (await loadThumbnail(thumb, photo, title, id)) loaded++;
              else failed++;
            });
          }
        }
        node('p', selected.notes ? '배송 특이사항\n' + selected.notes : '배송 특이사항 없음', body, 'deliveryPhotoNotes');
        // Six thumbnails per explicit batch, at most two bodies in flight.
        // Other dates and remaining originals never preload in the background.
        let loadingBatch = false;
        const more = node('button', '사진 더 보기', body); more.type = 'button';
        const loadBatch = async () => {
          if (loadingBatch || !alive(id)) return;
          loadingBatch = true; more.disabled = true;
          const batch = tasks.splice(0, 6);
          const work = async () => { while (batch.length && alive(id)) await batch.shift()(); };
          await Promise.all([work(), work()]);
          loadingBatch = false; more.disabled = false; more.hidden = !tasks.length;
          if (!alive(id) || !photoList.length) return;
          if (!loaded && failed) host.dataset.state = 'media-error';
          else if (failed) host.dataset.state = 'partial';
          else if (selected.status === 'READY') host.dataset.state = 'ready';
        };
        more.onclick = () => void loadBatch();
        await loadBatch();
      } catch (error) { if (!requestController?.signal.aborted) failure(error, id); }
    }
    async function open(value) {
      const retained = value.history === true && value.customerCode === target?.customerCode && deadline > Date.now()
        && indexedPage?.items.length ? {page:indexedPage, target} : null;
      purge(); target = { customerCode: String(value.customerCode || ''), ...(value.history === true
        ? {history:true, ...(value.cursor ? {cursor:value.cursor} : {})} : validDate(value.date) ? {date:value.date} : {}) };
      if (!target.customerCode || target.customerCode.length > 128) { shell('사진 미확인 · 고객코드가 필요합니다.', 'unverified'); return; }
      const id = generation; requestController = new AbortController(); shell('배송 기록 확인 중…', 'loading');
      let authorized = false;
      try {
        authorized = await authorize(id);
        if (!authorized) return;
        if (target.history) {
          const params = new URLSearchParams({customerCode:target.customerCode, ...(target.cursor ? {cursor:target.cursor} : {})});
          const payload = await request(API + '/history?' + params);
          if (!alive(id)) return;
          if (payload?.data?.mode === 'INDEXED') {
            const page = normalizeIndexedHistory(payload, target);
            if (retained && page.state !== 'COMPLETE' && !page.items.length) {
              target = retained.target; indexedPage = retained.page;
              renderIndexedHistory({...indexedPage, state:page.state}, true); return;
            }
            indexedPage = page;
            target.indexed = true;
            renderIndexedHistory(indexedPage);
          } else renderHistory(normalize(payload, target));
          return;
        }
        const list = normalize(await request(API + '?' + new URLSearchParams(target)), target);
        if (!alive(id)) return;
        deliveries = list;
        if (!list.length) { shell('사진 없음 · 선택한 배송일에 조회 가능한 배송 기록이 없습니다.', 'empty'); dateSearch(); return; }
        const selectedDelivery = list.find(d => d.date === target.date) || list[0];
        await selectDelivery(selectedDelivery);
      } catch (error) {
        if (id !== generation || requestController?.signal.aborted) return;
        if (error.message === 'PHOTO_HISTORY_CHANGED' && target.cursor) {
          if (retained) { target = retained.target; indexedPage = retained.page; }
          return open({customerCode:target.customerCode, history:true});
        }
        if (retained && authorized && alive(id) && error.status !== 401 && error.status !== 403 && error.message !== 'PHOTO_SOURCE_DISABLED') {
          target = retained.target; indexedPage = retained.page;
          renderIndexedHistory(indexedPage, true); return;
        }
        failure(error, id);
      }
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
    const date = (state.mode === 'DATE_ROUTE' ? state.selectedDate : row.lastDeliveryDate) || '';
    if (currentHost?.isConnected && currentHost.dataset.customerCode === String(row.customerCode) && currentHost.dataset.deliveryDate === date) return;
    reset(); currentHost = node('section', undefined, detail, 'deliveryPhotos');
    currentHost.dataset.customerCode = String(row.customerCode); currentHost.dataset.deliveryDate = date;
    currentHost.setAttribute('aria-label', '납품 사진');
    current = createController({ host: currentHost });
    node('h3', '납품 사진', currentHost); node('p', '직원 인증 후 배송일별 사진을 조회합니다.', currentHost, 'deliveryPhotoStatus');
    const button = node('button', '납품 사진 조회', currentHost); button.type = 'button';
    button.onclick = () => current?.open({customerCode:row.customerCode, date});
    const historyButton = node('button', '과거 사진 조회', currentHost); historyButton.type = 'button';
    historyButton.onclick = () => current?.open({customerCode:row.customerCode, history:true});
  }
  function schedule() { if (observing) return; observing = true; queueMicrotask(() => { observing = false; mountSelection(); }); }
  function mount() {
    if (mounted) return; mounted = true;
    observer = new MutationObserver(schedule); const root = document.querySelector('#detailSection'); if (root) observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    window.addEventListener('map-store-selected', () => { reset(); schedule(); });
    window.addEventListener('map-navigation-context-changed', schedule);
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
