const header = document.querySelector('#approvedSiteHeader nav');
const sidebar = document.querySelector('#leftPanel .scrollside');
const tab = document.createElement('button');
const label = document.createElement('span');
const switchState = document.createElement('small');
tab.id = 'modeShadowCoverage';
tab.type = 'button';
tab.className = 'tab';
tab.setAttribute('aria-label', '음영권역');
tab.setAttribute('aria-controls', 'shadowCoverage');
tab.hidden = true;
label.textContent = '음영권역 ';
tab.append(label, switchState);

let operatingMap, controller, loading, active = false, owner = 0;

function updateToggle() {
  tab.setAttribute('aria-pressed', String(active));
  switchState.textContent = active ? 'ON' : 'OFF';
}

function close() {
  owner++;
  active = false;
  controller?.close();
  updateToggle();
}

function syncAvailability() {
  const map = window.MapUiLocalBridge?.state.map;
  if (map !== operatingMap) close();
  operatingMap = map;
  tab.hidden = !(header && sidebar && map && window.kakao?.maps?.AbstractOverlay &&
    window.KAKAO_MAP_CONFIG?.shadowCoverageEnabled && window.MapStaffEntry?.session());
  if (!tab.hidden && !tab.isConnected) header.append(tab);
}

tab.onclick = async () => {
  if (active) return close();
  if (tab.hidden || !operatingMap || !window.MapStaffEntry?.session()) return;
  active = true;
  updateToggle();
  tab.title = '';
  const ticket = ++owner;
  try {
    loading ||= Promise.all([
      import('./shadow-coverage-panel.mjs?v=20261109-stage'),
      new Promise((resolve, reject) => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = new URL('./shadow-coverage.css?v=20261109-stage', import.meta.url);
        css.onload = resolve;
        css.onerror = () => { css.remove(); reject(Error('COVERAGE_STYLE_UNAVAILABLE')); };
        document.head.append(css);
      })
    ]).catch(error => { loading = null; throw error; });
    const [module] = await loading;
    if (ticket !== owner || !window.MapStaffEntry?.session()) return;
    controller ||= module.createCoveragePanel(sidebar);
    controller.open(operatingMap, window.kakao.maps);
  } catch {
    if (ticket !== owner) return;
    close();
    tab.title = '음영권역을 열지 못했습니다. 다시 선택해 주세요.';
  }
};

updateToggle();
window.addEventListener('map-sdk-ready', syncAvailability);
window.addEventListener('map-staff-ready', syncAvailability);
window.addEventListener('pagehide', close);
window.MapStaffEntry?.registerPurge(() => { close(); tab.hidden = true; });
syncAvailability();
