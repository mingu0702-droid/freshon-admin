import { createCoveragePanel } from './shadow-coverage-panel.mjs?v=20261109-field-analysis';

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

  let panel, stylesheet, active = false, previous;
  let returnTabs = [];

  function close(restoreScroll = false) {
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

  function syncAvailability() {
    const available = window.KAKAO_MAP_CONFIG?.shadowCoverageEnabled === true && window.MapStaffEntry?.session();
    if (!available) {
      close();
      tab.remove();
      return;
    }
    if (tab.isConnected) return;
    stylesheet ||= document.createElement('link');
    if (!stylesheet.isConnected) {
      stylesheet.rel = 'stylesheet';
      stylesheet.href = new URL('./shadow-coverage.css?v=20261109-field-analysis', import.meta.url);
      document.head.append(stylesheet);
    }
    tabs.append(tab);
  }

  tab.onclick = () => {
    if (active || !window.MapStaffEntry?.session()) return;
    panel ||= createCoveragePanel({ workspace, header });
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

  window.addEventListener('map-shadow-coverage-capability', syncAvailability);
  window.addEventListener('map-staff-ready', syncAvailability);
  window.addEventListener('pagehide', event => {
    close();
    if (!event.persisted) panel?.disposeMap();
  });
  window.MapStaffEntry?.registerPurge(() => {
    close();
    panel?.disposeMap();
    tab.remove();
  });
  syncAvailability();
}
