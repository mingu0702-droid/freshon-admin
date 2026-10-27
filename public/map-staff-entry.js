(() => {
  'use strict';
  const rawFetch = window.fetch.bind(window), ACTIVITY_THROTTLE_MS = 60000;
  let session = null, epoch = 0, timer = null, booted = false, booting = null, lastActivityCheck = 0, checking = null, checkingOwner = -1, confirming = null, confirmingOwner = -1, signingOut = null, logoutRequired = false;
  const requests = new Set(), purges = new Set();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('map-staff-session') : null;
  const entry = document.createElement('section'); entry.id = 'mapStaffEntry';
  entry.setAttribute('aria-label', '운영지도 직원 로그인');
  entry.innerHTML = '<form><h1>운영지도</h1><p>직원 로그인 후 지도를 사용할 수 있습니다.</p><label>공용 아이디<input name="username" autocomplete="username" maxlength="128" required></label><label>비밀번호<input name="password" type="password" autocomplete="current-password" maxlength="1024" required></label><button type="submit">로그인</button><p role="status" aria-live="polite">직원 로그인 상태를 확인하고 있습니다.</p></form>';
  document.body.append(entry);
  const form = entry.querySelector('form'), account = form.elements.username, password = form.elements.password;
  const submit = form.querySelector('button'), message = form.querySelector('[role="status"]');
  document.body.dataset.mapStaffState = 'checking'; submit.disabled = true;
  function isMapRequest(input) {
    let url; try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href); } catch { return false; }
    if (url.origin !== location.origin) return false;
    return /^\/api\/map-phase2b\/(?!auth(?:\/|$)|admin(?:\/|$))/.test(url.pathname)
      || /^\/api\/(?:fixed-dispatch(?:\/customer-search)?|monthly-dispatch-summary|monthly-dispatch-route|vehicle-driver-master|mobile\/customer-search|daily-route|status|delivery-admin\/status)\/?$/.test(url.pathname)
      || /^\/(?:vehicle-data|new-area-data|admin-features)\.js$/.test(url.pathname);
  }
  function status() {
    const unknown = document.body.dataset.mapStaffState === 'checking';
    const button = document.querySelector('#staffLogout');
    if (button) { button.textContent = session ? '직원 로그아웃' : unknown ? '연결 재확인' : '직원 로그인'; button.onclick = session ? logout : unknown ? () => void check() : () => account.focus(); }
    const header = document.querySelector('#approvedSiteHeader');
    let label = document.querySelector('#mapStaffSessionState');
    if (header && !label) { label = document.createElement('span'); label.id = 'mapStaffSessionState'; label.setAttribute('role', 'status'); header.append(label); }
    if (label) label.textContent = session ? '직원 로그인됨' : unknown ? '직원 인증 확인 중' : '직원 로그인 필요';
  }
  function deadline(value) {
    if (!session || value?.authenticated !== true) return;
    const expiresAt = Number(value.expiresAt), idleExpiresAt = Number(value.idleExpiresAt);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(idleExpiresAt)) return;
    session = { authenticated: true, expiresAt, idleExpiresAt };
    clearTimeout(timer);
    // Server deadlines include activity from other tabs of this same session.
    const end = Math.min(expiresAt, idleExpiresAt);
    timer = setTimeout(() => expire('직원 인증이 만료되었습니다. 다시 로그인해 주세요.'), Math.max(0, end - Date.now()));
  }
  function observe(response) {
    if (!session) return;
    const expiresAt = Number(response.headers.get('x-staff-expires-at'));
    const idleExpiresAt = Number(response.headers.get('x-staff-idle-expires-at'));
    if (expiresAt && idleExpiresAt) deadline({ authenticated: true, expiresAt, idleExpiresAt });
  }
  function revoke(text, unknown = false) {
    epoch++; session = null; clearTimeout(timer); password.value = '';
    for (const controller of requests) controller.abort(); requests.clear();
    delete window.VEHICLE_AREA_DATA; delete window.ADMIN_FEATURES;
    document.body.dataset.mapStaffState = unknown ? 'checking' : 'signed-out'; entry.hidden = false; submit.disabled = unknown;
    account.disabled = unknown; password.disabled = unknown;
    message.textContent = text || '직원 로그인 후 지도를 사용할 수 있습니다.'; status();
    window.MapStaff?.clear();
    window.dispatchEvent(new CustomEvent('map-staff-signed-out'));
    window.dispatchEvent(new CustomEvent('map-navigation-logout'));
    return Promise.allSettled([...purges].map(purge => Promise.resolve().then(purge)));
  }
  async function unavailable() {
    await revoke('네트워크 문제로 직원 인증을 확인하지 못했습니다. 보호정보는 잠시 차단됩니다.', true);
    const retry=document.createElement('button');retry.type='button';retry.textContent='연결 재확인';
    retry.onclick=()=>{retry.disabled=true;void check();};message.append(retry);
  }
  async function auth(path, options = {}) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await rawFetch('/api/map-phase2b/auth/' + path, { cache: 'no-store', credentials: 'same-origin',
        ...options, signal: controller.signal, headers: { 'content-type': 'application/json', ...options.headers } });
      const value = await response.json();
      if (!response.ok) throw Object.assign(Error('STAFF_AUTH_FAILED'), { status: response.status, code: typeof value.error === 'string' ? value.error : '' });
      return value;
    } finally { clearTimeout(timeout); }
  }
  function confirmSession(activity = false) {
    // This promise covers only the status request, never the map bootstrap.
    // A map401 during bootstrap must not await its own enclosing check().
    if (confirming && confirmingOwner===epoch) return confirming;
    const owner=epoch;confirmingOwner=owner;
    confirming=auth('session', activity ? {headers:{'x-map-staff-activity':'1'}} : {}).finally(()=>{if(confirmingOwner===owner)confirming=null;});
    return confirming;
  }
  async function loadData(owner) {
    const optional=document.documentElement.dataset.referenceDataOptional==='true';
    const current=()=>{if(owner!==epoch||!session)throw new DOMException('Session changed','AbortError');};
    function missing(name){
      current();window[name]=null;document.body.dataset.mapReferenceDataState='unconfirmed';
      let notice=document.getElementById('mapReferenceDataNotice');
      if(!notice){notice=document.createElement('p');notice.id='mapReferenceDataNotice';notice.setAttribute('role','status');(document.getElementById('approvedSiteHeader')||document.body).prepend(notice);}
      notice.textContent='기준자료 일부 미연결 · 저장 매장 조회 가능';
    }
    // The two independent reference reads no longer block each other. Optional
    // legacy files cannot hold up the private saved map indefinitely.
    await Promise.all([['vehicle-data.js','VEHICLE_AREA_DATA'],['admin-features.js','ADMIN_FEATURES']].map(async([url,name])=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),optional?3000:10000);
      try{
        const response=await window.fetch('/'+url,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
        current();
        if(optional&&[401,403,404,503].includes(response.status)){await response.body?.cancel();missing(name);return;}
        if(!response.ok)throw Error('MAP_DATA_UNAVAILABLE');
        const text=await response.text();current();
        const match=text.match(/^\s*window\.([A-Z_]+)\s*=\s*([\s\S]*?);?\s*$/);
        if(!match||match[1]!==name)throw Error('MAP_DATA_UNAVAILABLE');
        window[name]=JSON.parse(match[2]);
      }catch(error){
        current();
        if(optional){missing(name);return;}
        throw error;
      }finally{clearTimeout(timer);}
    }));
  }
  async function bootstrap(owner) {
    await loadData(owner);
    if (!booted) {
      for (const placeholder of document.querySelectorAll('script[type="application/x-map-staff"]')) {
        if (placeholder.dataset.loaded === '1') continue;
        if (owner !== epoch || !session) throw new DOMException('Session changed', 'AbortError');
        const script = document.createElement('script');
        if (placeholder.dataset.module === '1') script.type = 'module';
        if (placeholder.dataset.src) {
          await new Promise((resolve, reject) => {
            script.onload = resolve; script.onerror = () => reject(Error('MAP_UI_UNAVAILABLE'));
            script.src = placeholder.dataset.src; document.body.append(script);
          });
        } else { script.textContent = placeholder.textContent; document.body.append(script); }
        placeholder.dataset.loaded = '1';
      }
      booted = true;
    } else window.dispatchEvent(new CustomEvent('map-staff-authenticated'));
    if (owner !== epoch || !session) throw new DOMException('Session changed', 'AbortError');
    entry.hidden = true; document.body.dataset.mapStaffState = 'authenticated'; status();
  }
  async function accept(value) {
    if (value?.authenticated !== true) { await revoke('직원 로그인 후 지도를 사용할 수 있습니다.'); return false; }
    session = value; lastActivityCheck = Date.now(); account.disabled = false; password.disabled = false; deadline(value);
    const owner = epoch; document.body.dataset.mapStaffState = 'loading'; message.textContent = '지도 불러오는 중…';
    booting = bootstrap(owner);
    try { await booting; return true; }
    catch (error) {
      if (owner === epoch && error.name !== 'AbortError') { message.textContent = '지도를 불러오지 못했습니다. 새로고침 후 다시 확인해 주세요.'; submit.disabled = true; }
      return false;
    } finally { booting = null; }
  }
  async function check({activity = false} = {}) {
    if (logoutRequired) return null;
    if (checking && checkingOwner===epoch) return checking;
    const owner = epoch;
    checkingOwner=owner;
    checking = (async () => {
      try {
        const value = await confirmSession(activity);
        if (owner !== epoch) return null;
        if (!value.authenticated) { await revoke(value.reason === 'SESSION_UNAVAILABLE' ? '서버 재시작 또는 세션 종료로 다시 로그인이 필요합니다.' : '직원 로그인 후 지도를 사용할 수 있습니다.'); return null; }
        if (session) { deadline(value); return session; }
        await accept(value); return session;
      } catch {
        if (owner === epoch) await unavailable();
        return null;
      } finally { if(checkingOwner===owner)checking = null; }
    })();
    return checking;
  }
  function signOut(text) {
    if (signingOut) return signingOut;
    logoutRequired = true; const pending = revoke(text), owner = epoch; submit.disabled = true;
    channel?.postMessage('logout-pending');
    signingOut = (async () => {
      try {
        await auth('logout', { method: 'POST', body: '{}' }); await pending;
        if (owner === epoch) { logoutRequired = false; submit.disabled = false; channel?.postMessage('session-changed'); }
      } catch {
        if (owner === epoch) { message.textContent = '화면 정보는 지웠지만 서버 로그아웃을 확인하지 못했습니다. 로그아웃을 다시 시도해 주세요.'; submit.disabled = true;
          const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '로그아웃 재시도'; retry.onclick = () => { retry.remove(); void signOut(text); }; message.append(retry); }
        await pending;
      } finally { signingOut = null; }
    })();
    return signingOut;
  }
  // An availability/source error never sends an employee logout request.
  const expire = () => check();
  const logout = () => signOut('로그아웃되었습니다.');
  window.fetch = async (input, options = {}) => {
    if (!isMapRequest(input)) return rawFetch(input, options);
    if (!session) throw Object.assign(Error('STAFF_LOGIN_REQUIRED'), { status: 401 });
    const owner = epoch, controller = new AbortController(), signal = options.signal || (input instanceof Request ? input.signal : null);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort();
    requests.add(controller); let handedOff = false;
    const current = () => { if (owner !== epoch || !session) throw new DOMException('Session changed', 'AbortError'); };
    const cleanup = () => { requests.delete(controller); signal?.removeEventListener('abort', abort); };
    try {
      const response = await rawFetch(input, { ...options, signal: controller.signal });
      if (owner !== epoch || !session) { void response.body?.cancel().catch(() => {}); throw new DOMException('Session changed', 'AbortError'); }
      if (response.status === 401) {
        let verified;
        try { verified = await confirmSession(); }
        catch { if(owner===epoch)await unavailable(); }
        if(owner===epoch&&verified?.authenticated===false)await revoke(verified.reason==='SESSION_UNAVAILABLE'?'서버 재시작 또는 세션 종료로 다시 로그인이 필요합니다.':'직원 인증이 만료되었습니다. 다시 로그인해 주세요.');
        if (!verified?.authenticated || owner !== epoch || !session) { void response.body?.cancel().catch(() => {}); throw Object.assign(Error('STAFF_LOGIN_REQUIRED'), { status: 401 }); }
        deadline(verified);
        // Staff session is valid: preserve the original source/permission response.
      }
      observe(response);
      if (!response.body) return response;
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(stream) {
          try {
            current(); const value = await reader.read(); current();
            if (value.done) { stream.close(); reader.releaseLock(); cleanup(); }
            else stream.enqueue(value.value);
          } catch (error) { stream.error(error); void reader.cancel().catch(() => {}); cleanup(); }
        },
        cancel(reason) { cleanup(); return reader.cancel(reason); }
      });
      const guarded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      for (const method of ['json', 'text', 'blob', 'arrayBuffer', 'formData', 'bytes']) {
        if (typeof guarded[method] !== 'function') continue;
        const consume = guarded[method].bind(guarded);
        guarded[method] = async (...args) => { current(); const value = await consume(...args); current(); return value; };
      }
      handedOff = true; return guarded;
    } finally { if (!handedOff) cleanup(); }
  };
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (submit.disabled || booting || logoutRequired) return;
    submit.disabled = true; const owner = epoch;
    let body = JSON.stringify({ id: account.value, password: password.value }); password.value = '';
    try {
      const value = await auth('login', { method: 'POST', body }); body = '';
      if (owner !== epoch) return;
      await accept(value);
    } catch (error) {
      if (owner !== epoch) return;
      message.textContent = error.status === 429 ? '시도가 많습니다. 잠시 후 다시 시도해 주세요.'
        : error.code === 'STAFF_AUTH_NOT_CONFIGURED' ? '직원 로그인 설정이 필요합니다.'
          : error.status >= 500 ? '로그인 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'
            : '로그인하지 못했습니다. 아이디와 비밀번호를 확인해 주세요.';
    } finally { body = ''; password.value = ''; if (!session && !logoutRequired) submit.disabled = false; }
  });
  for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart']) document.addEventListener(name, event => {
    if (session && event.isTrusted && Date.now()-lastActivityCheck>=ACTIVITY_THROTTLE_MS) { lastActivityCheck=Date.now();void check({activity:true}); }
  }, { passive: true, capture: true });
  channel?.addEventListener('message', event => {
    if (event.data === 'logout-pending') { logoutRequired=true;void revoke('다른 탭에서 로그아웃 중입니다.');submit.disabled=true;return; }
    if (event.data === 'session-changed') { logoutRequired=false;submit.disabled=false;void check(); }
    else if (event.data === 'logout') void check();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && session) void check(); });
  window.addEventListener('pageshow', event => { if (event.persisted) void check(); });
  window.MapStaffEntry = Object.freeze({ check, logout, expire, observe, status,
    session: () => session && { ...session }, registerPurge: purge => { purges.add(purge); return () => purges.delete(purge); } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void check(), { once: true }); else void check();
})();
