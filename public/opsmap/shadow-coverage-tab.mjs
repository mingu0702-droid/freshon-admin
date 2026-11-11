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
  let probeTimer, probeRequest, probeUntil = 0;
  let returnTabs = [];

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

  function stopAvailabilityProbe() {
    clearTimeout(probeTimer);
    probeTimer = null;
    probeUntil = 0;
    probeRequest?.abort();
    probeRequest = null;
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
    stylesheet ||= document.createElement('link');
    if (!stylesheet.isConnected) {
      stylesheet.rel = 'stylesheet';
      stylesheet.href = new URL('./shadow-coverage.css?v=20261111-store-status', import.meta.url);
      document.head.append(stylesheet);
    }
    tabs.append(tab);
  }

  tab.onclick = async () => {
    if (active || opening || !window.MapStaffEntry?.session()) return;
    if (!panel) {
      const attempt = opening = {};
      tab.setAttribute('aria-busy', 'true');
      tab.textContent = '음영권역 불러오는 중';
      try {
        const { createCoveragePanel } = await import('./shadow-coverage-panel.mjs?v=20261111-store-status5');
        if (opening !== attempt || !tab.isConnected || !window.MapStaffEntry?.session()) return;
        panel = createCoveragePanel({ workspace, header });
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
  window.addEventListener('map-shadow-coverage-capability', syncAvailability);
  window.addEventListener('map-staff-ready', syncAvailability);
  window.addEventListener('map-customer-registry-updated', () => panel?.invalidate());
  window.addEventListener('pageshow', event => { if (event.persisted) syncAvailability(); });
  window.addEventListener('pagehide', () => {
    stopAvailabilityProbe();
    close();
    panel?.disposeMap();
  });
  window.MapStaffEntry?.registerPurge(() => {
    stopAvailabilityProbe();
    close();
    panel?.disposeMap();
    tab.remove();
  });
  syncAvailability();
}
