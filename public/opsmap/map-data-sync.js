((root) => {
  function staffStatus(appliedDate, checking = false, osanDelivery = false) {
    const validDate = typeof appliedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(appliedDate) &&
      Number.isFinite(Date.parse(appliedDate)) && new Date(appliedDate).toISOString().slice(0, 10) === appliedDate;
    if (!validDate) return checking ? '매장정보 확인 중' : '매장정보 반영일을 확인할 수 없습니다';
    const label = osanDelivery ? '오산센터 배송정보 ' : '매장정보 ';
    return label + appliedDate.replaceAll('-', '.') + '까지 반영' + (checking ? ' · 새 정보 확인 중' : '');
  }
  root.MapFreshnessSummary = Object.freeze({ staffStatus });
  if (typeof document === 'undefined') return;

  const strip = document.createElement('span');
  strip.id = 'mapFreshnessStatus';
  strip.className = 'mapFreshnessStrip';
  strip.setAttribute('role', 'status');
  strip.textContent = '매장정보 확인 중';
  const style = document.createElement('style');
  style.id = 'r11FreshnessStyle';
  style.textContent = `
    #approvedSiteHeader{height:auto!important;flex-wrap:wrap!important;row-gap:2px!important;padding-top:8px!important;padding-bottom:5px!important}
    .mapFreshnessStrip{display:block;flex:0 0 100%;order:10;width:100%;min-width:0;max-width:100%;padding:2px 0 0;text-align:right;color:#68768c;font-size:11px;line-height:1.45;white-space:normal;overflow-wrap:anywhere}
    #dotDataStatus:not([data-period-notice]){display:none!important}
    @media(min-width:901px){.dotRestored .workspace{height:calc(100dvh - var(--r11-header-height,96px))}}
    @media(max-width:900px){.mapFreshnessStrip{text-align:left;font-size:10px}}
  `;
  let appliedDate = null, checking = true, osanDelivery = false;
  const render = () => {
    const text = staffStatus(appliedDate, checking, osanDelivery);
    if (strip.textContent !== text) strip.textContent = text;
  };
  window.MapDataSync = {
    onPublished: null,
    applied(date, osanThrough) { appliedDate = osanThrough || date; osanDelivery = Boolean(osanThrough); render(); },
    setChecking(value) { checking = value; render(); }
  };
  window.addEventListener('map-staff-signed-out', () => {
    appliedDate = null;
    osanDelivery = false;
    checking = true;
    render();
  });

  let headerObserver, headerHeight = 0;
  function attachSummary() {
    const header = document.querySelector('#approvedSiteHeader');
    if (!header) {
      if (!strip.isConnected) document.querySelector('#mapDateBar').prepend(strip);
      return;
    }
    header.append(strip);
    document.head.append(style);
    headerObserver?.disconnect();
    const resize = () => {
      const value = Math.ceil(header.getBoundingClientRect().height);
      if (value && value !== headerHeight) {
        headerHeight = value;
        document.documentElement.style.setProperty('--r11-header-height', value + 'px');
        window.MapUiLocalBridge?.relayoutPreservingView?.();
      }
    };
    if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(header);
    resize();
  }
  if (!document.querySelector('#approvedSiteHeader')) {
    headerObserver = new MutationObserver(attachSummary);
    headerObserver.observe(document.body, { childList: true, subtree: true });
  }
  attachSummary();
})(typeof window === 'object' ? window : globalThis);
