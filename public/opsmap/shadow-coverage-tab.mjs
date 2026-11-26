const header = document.getElementById('approvedSiteHeader');
const tabs = header?.querySelector('nav');
const workspace = document.querySelector('body > main.workspace');
const period = document.getElementById('modePeriod');
const daily = document.getElementById('modeDaily');

if (tabs && workspace && period && daily) {
  const tab = document.createElement('button');
  tab.id = 'modeShadowCoverage';
  tab.type = 'button';
  tab.className = 'tab';
  tab.textContent = '음영권역';
  tab.setAttribute('aria-pressed', 'false');
  tab.setAttribute('aria-controls', 'shadowCoverage');

  let panel, stylesheet, opening, active = false, previous;
  let panelCode, pinObserver;
  let probeTimer, probeRequest, probeUntil = 0;
  let returnTabs = [], registryVersion;

  function cancelOpening() {
    if (!opening) return;
    opening = null;
    tab.removeAttribute('aria-busy');
    tab.textContent = '음영권역';
  }

  function close(restoreScroll = false) {
    cancelOpening();
    if (!active) return;
    active = false;
    panel.close();
    for (const { original, proxy, hidden } of returnTabs) {
      proxy.remove();
      original.hidden = hidden;
    }
    returnTabs = [];
    workspace.hidden = previous.hidden;
    workspace.inert = previous.inert;
    document.body.classList.remove('shadow-coverage-open');
    tab.setAttribute('aria-pressed', 'false');
    const scroll = previous.scroll;
    requestAnimationFrame(() => {
      if (active || !window.MapStaffEntry?.session()) return;
      if (restoreScroll) window.scrollTo(0, scroll);
      window.MapUiLocalBridge?.state.map?.relayout();
    });
  }

  function openPostalStore(row) {
    const bridge = window.MapUiLocalBridge;
    if (!window.MapStaffEntry?.session() || !bridge?.navigationStores('BASE_60D').some(store => store.customerCode === row.code)) return false;
    close(false);
    if (bridge.state.mode !== 'BASE_60D') period.click();
    requestAnimationFrame(() => {
      if (!active && window.MapStaffEntry?.session()) bridge.selectNavigationStore(row.code);
    });
    return true;
  }

  function stopAvailabilityProbe() {
    clearTimeout(probeTimer);
    probeTimer = null;
    probeUntil = 0;
    probeRequest?.abort();
    probeRequest = null;
  }

  function preparePanelCode() {
    if (panelCode) return panelCode.task;
    stylesheet ||= document.createElement('link');
    if (!stylesheet.isConnected) {
      stylesheet.rel = 'stylesheet';
      stylesheet.href = new URL('./shadow-coverage.css?v=20261115-staff', import.meta.url);
      document.head.append(stylesheet);
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(7000)]);
    const preparation = { controller };
    preparation.task = (async () => {
      const response = await fetch('/api/map-phase2b/private/shadow-coverage/format',{ cache:'no-store', signal });
      if (!response.ok && response.status !== 404) throw Error('COVERAGE_FORMAT_UNAVAILABLE');
      const format = response.ok ? (await response.json()).format : 'h3';
      signal.throwIfAborted();
      if (format === 'h3') return import('./shadow-coverage-panel.mjs?v=20261116-center');
      if (format !== 'postal') throw Error('COVERAGE_FORMAT_UNAVAILABLE');
      if (!document.querySelector('link[data-postal-coverage]')) {
        const style = document.createElement('link');
        style.rel = 'stylesheet';
        style.dataset.postalCoverage = '1';
        style.href = new URL('./postal-coverage.css?v=20261126-layout',import.meta.url);
        document.head.append(style);
      }
      return import('./postal-coverage-panel.mjs?v=20261127-viewport-priority');
    })().catch(error => {
      if (panelCode === preparation) panelCode = null;
      throw error;
    });
    panelCode = preparation;
    return preparation.task;
  }

  function prepareAfterFirstPin() {
    if (panel || panelCode || pinObserver) return;
    const map = document.getElementById('map');
    if (!map) return;
    const warm = () => {
      if (!map.dataset.bootMetrics || !map.querySelector('.marker')) return;
      pinObserver?.disconnect();
      pinObserver = null;
      // Let the first map frame paint before requesting coverage.
      requestAnimationFrame(() => {
        if (!panel && tab.isConnected && window.MapStaffEntry?.session()) void preparePanelCode().catch(() => {});
      });
    };
    if (map.dataset.bootMetrics && map.querySelector('.marker')) return warm();
    pinObserver = new MutationObserver(warm);
    pinObserver.observe(map, { attributes:true, attributeFilter:['data-boot-metrics'] });
  }

  function resetPanelPreparation() {
    pinObserver?.disconnect();
    pinObserver = null;
    panelCode?.controller.abort();
    panelCode = null;
  }

  async function checkAvailability() {
    probeTimer = null;
    const controller = probeRequest = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch('/api/map-phase2b/private/map-sdk-config?sdkOnly=1', {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal
      });
      if (!response.ok && response.status !== 503) return;
      const payload = await response.json();
      if (probeRequest !== controller || !window.MapStaffEntry?.session()) return;
      window.KAKAO_MAP_CONFIG = { ...window.KAKAO_MAP_CONFIG,
        shadowCoverageEnabled: payload.shadowCoverageEnabled === true,
        shadowCoverageRestoring: payload.shadowCoverageRestoring === true };
    } catch {
      // The operating map remains available while the optional archive is restored.
    } finally {
      clearTimeout(timeout);
      if (probeRequest === controller) {
        probeRequest = null;
        syncAvailability();
      }
    }
  }

  function syncAvailability() {
    const session = window.MapStaffEntry?.session();
    const config = window.KAKAO_MAP_CONFIG;
    const available = session && config?.shadowCoverageEnabled === true;
    if (!available) {
      close();
      resetPanelPreparation();
      panel?.disposeMap();
      tab.remove();
      if (session && config?.shadowCoverageRestoring === true) {
        probeUntil ||= performance.now() + 25_000;
        if (!probeTimer && !probeRequest && performance.now() < probeUntil) {
          probeTimer = setTimeout(() => void checkAvailability(), 1500);
        }
      } else stopAvailabilityProbe();
      return;
    }
    stopAvailabilityProbe();
    if (tab.isConnected) return;
    tabs.append(tab);
    prepareAfterFirstPin();
  }

  tab.onclick = async () => {
    if (active || opening || !window.MapStaffEntry?.session()) return;
    if (!panel) {
      const attempt = opening = {};
      tab.setAttribute('aria-busy', 'true');
      tab.textContent = '음영권역 불러오는 중';
      try {
        const { createCoveragePanel } = await preparePanelCode();
        if (opening !== attempt || !tab.isConnected || !window.MapStaffEntry?.session()) return;
        panel = createCoveragePanel({ workspace, header, openStore:openPostalStore });
      } catch {
        if (opening === attempt) {
          cancelOpening();
          tab.textContent = '음영권역 다시 열기';
        }
        return;
      } finally {
        if (opening === attempt) cancelOpening();
      }
    }
    const prior = daily.getAttribute('aria-pressed') === 'true' ? daily : period;
    previous = { hidden: workspace.hidden, inert: workspace.inert, scroll: window.scrollY };
    // Keep the operating controls and their selected state while the analysis is open.
    returnTabs = [period, daily].map(original => {
      const proxy = document.createElement('button');
      proxy.type = 'button';
      proxy.className = 'tab';
      proxy.textContent = original.textContent;
      proxy.setAttribute('aria-pressed', 'false');
      proxy.onclick = () => {
        close(original === prior);
        if (original !== prior) original.click();
        original.focus({ preventScroll: true });
      };
      const hidden = original.hidden;
      original.before(proxy);
      original.hidden = true;
      return { original, proxy, hidden };
    });
    active = true;
    workspace.hidden = true;
    workspace.inert = true;
    document.body.classList.add('shadow-coverage-open');
    tab.setAttribute('aria-pressed', 'true');
    window.scrollTo(0, 0);
    panel.open();
  };

  period.addEventListener('click', cancelOpening);
  daily.addEventListener('click', cancelOpening);
  window.addEventListener('map-dispatch-reference-open', () => close());
  window.addEventListener('map-shadow-coverage-capability', syncAvailability);
  window.addEventListener('map-staff-ready', syncAvailability);
  window.addEventListener('map-customer-registry-updated', ({ detail }) => {
    const version = detail?.version;
    if (version && version === registryVersion) return;
    registryVersion = version;
    panel?.invalidate();
  });
  window.addEventListener('pageshow', event => { if (event.persisted) syncAvailability(); });
  window.addEventListener('pagehide', () => {
    stopAvailabilityProbe();
    resetPanelPreparation();
    close();
    panel?.disposeMap();
  });
  window.MapStaffEntry?.registerPurge(() => {
    registryVersion = null;
    stopAvailabilityProbe();
    resetPanelPreparation();
    close();
    panel?.disposeMap();
    tab.remove();
  });
  syncAvailability();
}
