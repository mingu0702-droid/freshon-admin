import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStageVerificationApp } from '../src/stageVerificationEntry.js';
import { createStaffPasswordHash } from '../src/opsmap-abc/mapStaffAuth.js';
import { snapshotProjection } from '../src/productionSnapshotStore.js';
import { createShadowCoverageStore } from '../src/shadowCoverage/store.js';

const [directory, output, mode] = process.argv.slice(2);
const fieldAnalysis = mode === 'field-analysis';
assert(path.isAbsolute(directory || '') && path.isAbsolute(output || ''));
await fs.mkdir(output, { recursive: true });
const stageOrigin = 'https://freshon-admin-stage-preview-template.onrender.com';
const base = '31e50c9ce1d2d0213d1c48bb079d09cd29effd44';
const sdkFixture = await fs.readFile(new URL('./fixtures/shadow-coverage-kakao.js', import.meta.url), 'utf8');
const source = await createShadowCoverageStore({ directory }).readPeriod(90);
assert.equal(source.index.kind, 'OBSERVED');
const date = source.index.asOf;
const sample = source.catalog.stores.find(row => row.cell && row.address && row.name && row.code && row.registered);
assert(sample);
const result = { scope: (fieldAnalysis ? 'FIELD_ANALYSIS' : 'THIRD_TAB') + '_LOCAL_CHROMIUM_SDK_FIXTURE_REAL_PRIVATE_H3', base,
  checks: [], errors: [], screenshots: [], requestsToStage: 0, providerCalls: 0, sourceWrites: 0 };
function check(label, condition) {
  assert(condition, label);
  result.checks.push(label);
}

const fixed = { baseVehicleGroup: 'osan', baseVehicleState: 'VERIFIED_MASTER',
  baseVehicleSource: 'FIXED_DISPATCH_PRIMARY', baseVehicleVersion: 'a'.repeat(64), baseVehicleCheckedAt: date };
const stores = [
  ['S990001', '검수 매장 1', '경기 오산시 검수로 1', 37.148, 127.077, '101'],
  ['S990002', '검수 매장 2', '경기 오산시 검수로 2', 37.181, 127.110, '101'],
  ['S990003', '검수 매장 3', '경기 오산시 검수로 3', 37.156, 127.150, '102']
].map(([customerCode, customerName, address, lat, lng, vehicle]) => ({ ...fixed, customerCode, customerName,
  address, lat, lng, vehicle, baseVehicle: vehicle, lastDeliveryDate: date }));
const rows = [...stores, ...Array.from({ length: 4489 }, (_, i) => ({
  ...fixed, customerCode: 'Q' + String(i).padStart(6, '0'), customerName: '검수 매장 ' + (i + 4),
  lat: 34.6 + (i % 83) * .014, lng: 126.8 + (i % 55) * .012, vehicle: '120', baseVehicle: '120', lastDeliveryDate: date
}))];
const preservedAsOf = fieldAnalysis ? '2026-11-02' : date;
const current = snapshotProjection({ version: 'phase2b-map-snapshot-v1', latestDate: preservedAsOf, startDate: source.window.start,
  rows: rows.map(row => ({ ...row, lastDeliveryDate: preservedAsOf })) });
const dayRows = stores.slice(0, 2).map((row, index) => ({ ...row, deliveryDate: date, sequence: index + 1, order: index + 1, status: 'COMPLETED' }));
let sessionFile = null;
let sessionRevision = 0;
const content = (value, sha = 'b'.repeat(40)) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return Response.json({ sha, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') });
};
const fetchFixture = async (input, options = {}) => {
  const url = new URL(input);
  assert.equal(url.hostname, 'api.github.com');
  const file = url.pathname.split('/').at(-1);
  if (file === 'freshon-cache') return Response.json({ private: true, permissions: { push: true } });
  if (options.method === 'PUT') {
    assert.equal(file, 'staff-sessions-v1.json');
    sessionFile = JSON.parse(Buffer.from(JSON.parse(options.body).content, 'base64'));
    sessionRevision++;
    return Response.json({ ok: true });
  }
  if (file === 'staff-sessions-v1.json' && sessionFile) return content(sessionFile, sessionRevision.toString(16).padStart(40, '0'));
  if (file === 'map-snapshot-v1.json') return content({ schema: 1, current, previous: null });
  return new Response(null, { status: 404 });
};
const password = randomBytes(16).toString('hex');
const app = createStageVerificationApp({
  env: {
    RENDER_EXTERNAL_URL: stageOrigin, RENDER_GIT_COMMIT: base,
    MAP_STAFF_ID: 'coverage-local-fixture', MAP_STAFF_PASSWORD_HASH: await createStaffPasswordHash(password),
    MAP_STAFF_SESSION_SECRET: randomBytes(32).toString('base64url'), KAKAO_MAP_JAVASCRIPT_KEY: '0'.repeat(32),
    GITHUB_CACHE_REPO: 'mingu0702-droid/freshon-cache', GITHUB_TOKEN: 'fixture-only',
    OPSMAP_MANUAL_PIN_GITHUB_BRANCH: 'stage/opsmap-manual-pins',
    OPSMAP_SNAPSHOT_STORE_ENABLED: '1', OPSMAP_SNAPSHOT_STORE_REPO: 'mingu0702-droid/freshon-cache',
    OPSMAP_SNAPSHOT_STORE_BRANCH: 'stage/opsmap-snapshots', OPSMAP_SHADOW_DATA_DIR: directory
  },
  fetchImpl: fetchFixture,
  readHub: async action => {
    if (action === 'mapModelStatus') return { data: { customer: { freshon: date, delivery: date } } };
    if (action === 'customerRegistry') return { ok: true, data: { rows: [] } };
    throw Error('NO_REMOTE_SOURCE');
  }
});
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const url = stageOrigin + '/opsmap/';
const shade = '/api/map-phase2b/private/shadow-coverage/';
const viewPath = response => new URL(response.url()).pathname.endsWith(shade + 'view');
let browser, failed;

const fixtureAddresses = ['경기도 오산시 검증로 777', '경기도 오산시 검증동 777-1'];

async function open(width, { failView = false, failSdk = false, missingKey = false, allowAddressLookup = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 930 },
    isMobile: width === 390, hasTouch: width === 390, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => result.errors.push({ width, name: error.name, message: error.message.replace(/https?:\S+/g, '[URL]').slice(0, 100) }));
  const views = [], http = {}, lookupCalls = [];
  page.on('response', response => {
    const endpoint = new URL(response.url()).pathname.split('/').at(-1);
    if (['map-sdk-config', 'snapshot', 'base-vehicles', 'view'].includes(endpoint)) http[endpoint] = response.status();
  });
  let holdNext, release, sdkRequests = 0;
  await context.route('**/*', async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === 'https://dapi.kakao.com' && requestUrl.pathname === '/v2/maps/sdk.js') {
      sdkRequests++;
      if (failSdk && sdkRequests === 1) return route.abort();
      return route.fulfill({ contentType: 'application/javascript', body: sdkFixture });
    }
    if (requestUrl.origin !== stageOrigin) return route.abort();
    const pathname = requestUrl.pathname;
    if (missingKey && pathname.endsWith('/map-sdk-config') && requestUrl.searchParams.has('sdkOnly')) {
      missingKey = false;
      return route.fulfill({ status: 503, json: { error: 'MAP_JAVASCRIPT_KEY_UNCONFIGURED', shadowCoverageEnabled: true } });
    }
    if (pathname.endsWith('/private/address-lookup')) {
      const query = route.request().postDataJSON()?.query;
      lookupCalls.push(fixtureAddresses.includes(query) ? fixtureAddresses.indexOf(query) : -1);
      if (!allowAddressLookup || !fixtureAddresses.includes(query)) return route.fulfill({
        status: 503, json: { ok: false, error: 'GEOCODING_DISABLED' }
      });
      return route.fulfill({ json: { ok: true, data: {
        documents: [{ address_name: query, x: '127.108', y: '37.17' }],
        status: 'OK', exact: true, resolution: { kind: 'EXACT' }, retention: 'REQUEST_ONLY'
      } } });
    }
    if (pathname.endsWith('/assignments')) return route.fulfill({ json: { ok: true, data: dayRows, meta: { complete: true, date } } });
    if (pathname.endsWith('/route-plan')) return route.fulfill({ json: { ok: true, data: { stops: dayRows, date, vehicle: '101' } } });
    const view = pathname.endsWith(shade + 'view');
    let held;
    if (view) {
      views.push({ days: requestUrl.searchParams.get('days'), center: requestUrl.searchParams.get('center') });
      held = holdNext;
      holdNext = null;
      if (failView) {
        failView = false;
        return route.fulfill({ status: 503, json: { ok: false, error: 'COVERAGE_DATA_UNAVAILABLE' } });
      }
    }
    try {
      const response = await route.fetch({ url: origin + pathname + requestUrl.search,
        headers: await route.request().allHeaders(), maxRedirects: 0, timeout: 15000 });
      if (held) await held;
      if (allowAddressLookup && pathname.endsWith('/map-sdk-config') && response.ok()) {
        return route.fulfill({ response, json: { ...await response.json(), addressLookupPending: false,
          allowExternalAddressLookup: true, addressLookupServerProxy: true } });
      }
      await route.fulfill({ response });
    } catch {
      await route.abort().catch(() => {});
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#mapStaffEntry input[name=username]').fill('coverage-local-fixture');
  await page.locator('#mapStaffEntry input[name=password]').fill(password);
  await page.locator('#mapStaffEntry button[type=submit]').click();
  await page.waitForFunction(() => document.body.dataset.mapStaffState === 'authenticated');
  return { page, context, views, http, lookupCalls, sdkRequests: () => sdkRequests,
    holdNextView() { holdNext = new Promise(resolve => { release = resolve; }); },
    releaseView() { release?.(); holdNext = null; } };
}

const toggle = page => page.getByRole('button', { name: '음영권역', exact: true });
const general = page => page.getByRole('button', { name: '매장·권역 지도', exact: true });
const daily = page => page.getByRole('button', { name: '일자별 운행', exact: true });
const ready = page => page.locator('#coverageMap .coverage-overlay path').first().waitFor({ state: 'attached' });
const setView = (page, lat, lng, level, id = '#coverageMap') => page.evaluate(([y, x, z, selector]) => {
  const map = __coverageFixture.mapFor(document.querySelector(selector));
  map.setCenter(new kakao.maps.LatLng(y, x));
  map.setLevel(z);
}, [lat, lng, level, id]);

async function capture(page, width) {
  await page.evaluate(() => {
    const badge = document.createElement('div');
    badge.textContent = '로컬 검수 · 카카오 SDK 모의 · 배송 실집계';
    badge.style.cssText = 'position:absolute;left:10px;bottom:8px;padding:4px 7px;z-index:70;pointer-events:none;background:#fffdf3;color:#554826;border:1px solid #ddcf9f;border-radius:4px;font:11px sans-serif';
    document.querySelector('#coverageMap').append(badge);
  });
  const name = (fieldAnalysis ? 'field-analysis-' : 'third-tab-') + width + '.png';
  await page.screenshot({ path: path.join(output, name), fullPage: width === 390, animations: 'disabled' });
  result.screenshots.push(name);
}

async function clickHex(page, cells) {
  await page.locator('#coverageMap').scrollIntoViewIfNeeded();
  const hit = await page.evaluate(values => {
    const host = document.querySelector('#coverageMap');
    const projection = __coverageFixture.mapFor(host).getProjection();
    const rect = host.getBoundingClientRect();
    for (const cell of values) {
      const point = projection.containerPointFromCoords(new kakao.maps.LatLng(...cell.location));
      const x = rect.left + point.x, y = rect.top + point.y;
      if (document.elementFromPoint(x, y)?.closest('#coverageMap')) return { x, y, id: cell.id };
    }
    return null;
  }, cells.filter(cell => cell.visits > 0));
  assert(hit, 'no clickable visible cell in fixture viewport');
  await page.mouse.click(hit.x, hit.y);
  await page.locator('#coverageDetail .coverage-cell-id').waitFor();
  return hit.id;
}

async function exercise(width) {
  const session = await open(width);
  const { page, views } = session;
  try {
    await page.waitForFunction(() => MapUiLocalBridge.isDataReady() && Boolean(MapUiLocalBridge.state.map));
    await toggle(page).waitFor();
    check(width + ' starts with the original workspace and three menu labels', await page.locator('main.workspace').isVisible() &&
      await general(page).getAttribute('aria-pressed') === 'true' && views.length === 0 &&
      JSON.stringify((await page.locator('#approvedSiteHeader nav button:visible').allTextContents()).map(text => text.trim())) ===
      JSON.stringify(['매장·권역 지도', '일자별 운행', '음영권역']));

    const picker = page.locator('#baseVehiclePicker > summary');
    await picker.click();
    await page.locator('#vehicleList input[value="101"]').check();
    await page.waitForFunction(() => MapUiLocalBridge.state.selectedVehicles.join(',') === '101');
    if (await page.locator('#baseVehiclePicker').getAttribute('open') !== null) await picker.click();
    await setView(page, 37.17, 127.11, 5, '#map');
    await page.locator('#map [data-customer-code="S990002"]').waitFor({ state: 'visible' });
    const operating = await page.evaluate(() => {
      const state = MapUiLocalBridge.state;
      window.__operatingMap = state.map;
      const center = state.map.getCenter();
      return { level: state.map.getLevel(), center: [center.getLat(), center.getLng()], vehicles: state.selectedVehicles, markers: state.overlays.length };
    });

    session.holdNextView();
    const first = page.waitForResponse(response => viewPath(response) && response.ok());
    await toggle(page).click();
    await page.locator('#coverageMapState').getByText('분석 격자를 불러오고 있습니다.').waitFor();
    check(width + ' single click opens separate view with search and loading visible', await page.locator('#coverageQuery').isVisible() &&
      await page.locator('#coverageDays').inputValue() === '90' && !await page.locator('main.workspace').isVisible() &&
      await page.locator('main.workspace').evaluate(node => node.inert) && await toggle(page).getAttribute('aria-pressed') === 'true' &&
      await general(page).getAttribute('aria-pressed') === 'false');
    session.releaseView();
    const initial = await first;
    const initialView = (await initial.json()).data;
    await ready(page);
    const periods = page.locator('#coverageObserved');
    check(width + ' automatic 90-day private view and observed dates', initialView.period.days === 90 && views[0].days === '90' &&
      (await periods.innerText()).includes('76/90일 · 미확인 14일') &&
      initialView.completeness.missingDates.join() === source.window.missing.join() && initial.headers()['cache-control'].includes('no-store'));
    check(width + ' only the analysis map contains H3 shapes', await page.locator('#map .coverage-overlay').count() === 0 &&
      await page.evaluate(() => __coverageFixture.maps() === 2 && MapUiLocalBridge.state.map === __operatingMap));

    if (width === 390) {
      await page.getByRole('button', { name: '분석 접기' }).click();
      check('mobile collapse keeps address search and map visible', !await page.locator('#coverageAnalysis').isVisible() &&
        await page.locator('#coverageQuery').isVisible() && await page.locator('#coverageMap').isVisible());
      await page.getByRole('button', { name: '분석 펼치기' }).click();
      check('mobile analysis reopens without losing 90-day filter', await page.locator('#coverageAnalysis').isVisible() &&
        await page.locator('#coverageDays').inputValue() === '90');
    } else {
      const sidebar = await page.locator('#coverageSidebar').boundingBox();
      const map = await page.locator('#coverageMap').boundingBox();
      check('desktop uses a left analysis panel and right map', sidebar.x < map.x && Math.abs(sidebar.y - map.y) < 2 && map.width > sidebar.width);
    }
    check(width + ' no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await capture(page, width);

    for (const query of width === 1440 ? [sample.code, sample.name, sample.address] : [sample.address]) {
      await page.locator('#coverageQuery').fill(query);
      await page.locator('#coverageSearch button').click();
      await page.locator('#coverageSearchResults button:enabled').first().waitFor();
    }
    const before = await page.evaluate(() => __coverageFixture.mapFor(document.getElementById('coverageMap')).getLevel());
    await page.locator('#coverageSearchResults button:enabled').first().click();
    await page.locator('#coverageDetail .coverage-vehicle-list').waitFor();
    await page.locator('#coverageMap .coverage-selected').waitFor({ state: 'attached' });
    check(width + ' stored address focuses the analysis map and highlights a cell', await page.evaluate(level =>
      __coverageFixture.mapFor(document.getElementById('coverageMap')).getLevel() !== level, before));
    await page.locator('#coverageDetail').getByRole('button', { name: '닫기' }).click();
    await page.locator('#coverageQuery').fill('');

    const detailView = page.waitForResponse(response => viewPath(response) && response.ok());
    await setView(page, 37.17, 127.11, 5);
    const zoomed = (await (await detailView).json()).data;
    await page.waitForFunction(n => document.querySelectorAll('#coverageMap .coverage-overlay path').length === n, zoomed.cells.length);
    const selected = await clickHex(page, zoomed.cells);
    const details = await page.locator('#coverageDetail').innerText();
    check(width + ' click on a rendered hex shows selected cell counts and vehicles', details.includes(selected) &&
      details.includes('등록 매장') && details.includes('배송 이력') && details.includes('이 격자의 배송 이력 호차') && zoomed.resolution === 8);
    await page.locator('#coverageDetail').getByRole('button', { name: '닫기' }).click();

    for (const days of ['30', '60']) {
      await page.locator('#coverageDays').selectOption(days);
      await page.waitForFunction(n => document.querySelector('#coverageObserved').textContent.includes('/' + n + '일'), days);
    }
    check(width + ' changing period updates rendered evidence', views.some(view => view.days === '30') && views.some(view => view.days === '60'));
    if (width === 1440) {
      await page.locator('#coverageCenter').selectOption('yeongnam');
      await page.getByText('선택 센터의 배송 자료가 확인되지 않았습니다.', { exact: true }).waitFor();
      check('center without confirmed records remains unconfirmed', views.at(-1).center === 'yeongnam');
    }

    session.holdNextView();
    const pending = page.waitForRequest(request => viewPath(request));
    await setView(page, 37.174, 127.117, 5);
    await pending;
    await general(page).click();
    await page.locator('main.workspace').waitFor();
    const restored = await page.evaluate(() => {
      const state = MapUiLocalBridge.state, center = state.map.getCenter();
      return { sameMap: state.map === __operatingMap, level: state.map.getLevel(), center: [center.getLat(), center.getLng()],
        vehicles: state.selectedVehicles, markers: state.overlays.length };
    });
    check(width + ' returns to identical original map, camera, filter and pins', restored.sameMap &&
      restored.level === operating.level && restored.center.join() === operating.center.join() &&
      restored.vehicles.join() === operating.vehicles.join() && restored.markers === operating.markers &&
      !await page.locator('#shadowCoverage').isVisible());
    await toggle(page).click();
    session.releaseView();
    await ready(page);
    check(width + ' re-entry cancels stale response and loads default 90 days on the same analysis map',
      views.at(-1).days === '90' && await page.locator('#coverageDays').inputValue() === '90' &&
      await page.evaluate(() => __coverageFixture.maps() === 2));

    await daily(page).click();
    await page.waitForFunction(() => MapUiLocalBridge.state.mode === 'DATE_ROUTE');
    check(width + ' daily operation opens from analysis', await page.locator('#chooseRoutes').isVisible() &&
      !await page.locator('#shadowCoverage').isVisible());
    await toggle(page).click();
    await ready(page);
    await daily(page).click();
    check(width + ' returning to prior daily mode retains the operating map', await page.evaluate(() =>
      MapUiLocalBridge.state.mode === 'DATE_ROUTE' && MapUiLocalBridge.state.map === __operatingMap));
    await general(page).click();
    await page.waitForFunction(() => MapUiLocalBridge.state.mode === 'BASE_60D');
    check(width + ' both legacy tabs remain switchable', await page.locator('main.workspace').isVisible() &&
      await toggle(page).getAttribute('aria-pressed') === 'false');
    if (width === 1440) {
      await toggle(page).click();
      await ready(page);
      await page.locator('#staffLogout').click();
      await page.waitForFunction(() => document.body.dataset.mapStaffState === 'signed-out');
      check('logout clears the independent map and protected controls', !await page.locator('#shadowCoverage').isVisible() &&
        !await page.locator('#modeShadowCoverage').count() && !await page.locator('#coverageMap .coverage-overlay').count());
    }
  } catch (error) {
    result.failureState = await page.evaluate(() => ({
      staff: document.body.dataset.mapStaffState,
      sdk: document.getElementById('map')?.dataset.sdkState,
      tab: Boolean(document.getElementById('modeShadowCoverage')),
      capability: window.KAKAO_MAP_CONFIG?.shadowCoverageEnabled,
      dataReady: window.MapUiLocalBridge?.isDataReady(),
      markers: window.MapUiLocalBridge?.state.overlays.length,
      rows: window.MapUiLocalBridge?.state.currentRows.length,
      stores: window.MapUiLocalBridge?.stores().length,
      vehicles: window.MapUiLocalBridge?.state.selectedVehicles,
      analysis: document.getElementById('shadowCoverage')?.hidden === false,
      mapMessage: document.getElementById('coverageMapMessage')?.textContent
    }));
    result.failureState.http = session.http;
    throw error;
  } finally {
    session.releaseView();
    await session.context.close();
  }
}

async function retryCase(options, message, label) {
  const { page, context, views } = await open(1440, options);
  try {
    await toggle(page).click();
    await page.locator('#coverageMapState').getByText(message).waitFor();
    check(label + ' exposes retry and keeps analysis open', await page.locator('#coverageRetry').isVisible() &&
      await page.locator('#coverageQuery').isVisible());
    await page.locator('#coverageRetry').click();
    await ready(page);
    check(label + ' retry restores automatic 90-day hexes', views.at(-1).days === '90' &&
      !await page.locator('#coverageRetry').isVisible());
  } finally { await context.close(); }
}

async function checkFieldAnalysis(width) {
  const { page, context, lookupCalls } = await open(width, { allowAddressLookup: width === 1440 });
  try {
    await page.waitForFunction(() => MapUiLocalBridge.isDataReady() && Boolean(MapUiLocalBridge.state.map));
    const first = page.waitForResponse(response => viewPath(response) && response.ok());
    await toggle(page).click();
    const initial = (await (await first).json()).data;
    await ready(page);
    const visibleList = page.locator('#coverageCellList .coverage-list-row');
    await visibleList.first().waitFor();
    check(width + ' scope and completeness visible on entry', (await page.locator('#coverageBasis').innerText()).includes(source.index.asOf) &&
      (await page.locator('#coverageObserved').innerText()).includes('76/90일 · 미확인 14일') &&
      (await page.locator('#coveragePreserved').innerText()).includes('4,492곳 (2026-11-02) · 별도 범위') &&
      (await page.locator('[data-metric="registered"]').innerText()) === '6,043' &&
      (await page.locator('[data-metric="located"]').innerText()) === '4,737' &&
      (await page.locator('#coverageGaps').innerText()).includes('위치 미연결'));
    check(width + ' visible orange candidates are labeled separately from gray uncertainty',
      await page.locator('#coverageListTitle').innerText() === '관측기간 미배송 후보' &&
      await page.locator('#coverageMap path[data-tone="candidate"]').count() > 0 &&
      await page.locator('#coverageMap path[data-tone="unknown"]').count() === initial.cells.filter(cell => cell.status === 'UNKNOWN').length &&
      await page.locator('#coverageMap path[data-tone="candidate"]').first().evaluate(node =>
        Number(getComputedStyle(node).fillOpacity) > 0 && getComputedStyle(node).fill === 'rgb(245, 158, 11)'));
    check(width + ' nationwide R8 candidates are ranked and nearby histories are visible by default',
      initial.summaryResolution === 8 && initial.summary.candidates > 0 &&
      initial.candidateList.rows.every((row, index, rows) => row.status === 'CANDIDATE' &&
        (!index || rows[index - 1].registered >= row.registered)) &&
      (await visibleList.first().innerText()).includes('관측 방문 0건') &&
      (await visibleList.first().innerText()).includes('배송 이력') &&
      (await page.locator('#coverageViewport').innerText()).includes('현재 지도 R' + initial.resolution));
    check(width + ' analysis layout fits viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await capture(page, width);

    await visibleList.first().click();
    const detail = page.locator('#coverageDetail');
    await detail.locator('.coverage-cell-id').waitFor();
    await page.locator('#coverageMap .coverage-selected').waitFor({ state: 'attached' });
    const content = await detail.innerText();
    check(width + ' candidate click focuses selected hex and discloses evidence', content.includes(initial.candidateList.rows[0].id) &&
      content.includes('시·군·구') && content.includes('읍·면·동') && content.includes('고객코드') &&
      content.includes('관측 배송일') && content.includes('마지막 배송일') &&
      content.includes('중심 직선') && content.includes('도로거리 아님') &&
      content.includes('76/90일 확인 · 14일 미확인') &&
      await page.locator('#coverageMap .coverage-selected').count() > 0);
    check(width + ' nationwide candidate total does not change on focus',
      await page.locator('[data-metric="candidates"]').innerText() === initial.summary.candidates.toLocaleString('ko-KR'));
    await detail.getByRole('button', { name: '닫기' }).click();

    if (width === 1440) {
      const zoomRequest = page.waitForResponse(response => viewPath(response) && response.ok());
      await setView(page, 37.17, 127.11, 5);
      const zoomed = (await (await zoomRequest).json()).data;
      await page.waitForFunction(n => document.querySelectorAll('#coverageMap .coverage-overlay path').length === n, zoomed.cells.length);
      const clicked = await clickHex(page, zoomed.cells);
      const detailText = await detail.innerText();
      check('hex click shows distinct recorded dates and historical vehicles', detailText.includes(clicked) &&
        /관측 배송일\s+[1-9]\d*일/.test(detailText) && detailText.includes('이 격자의 배송 이력 호차'));
      await detail.getByRole('button', { name: '닫기' }).click();
      for (const filter of ['delivery', 'review']) {
        const next = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(shade + 'list') && response.ok());
        await page.locator('#coverageListFilter').selectOption(filter);
        const payload = (await (await next).json()).data;
        await page.locator('#coverageCellList .coverage-list-row').first().waitFor();
        check('list filter ' + filter + ' returns its own status',
          payload.rows.length > 0 && payload.rows.every(row => row.status === (filter === 'delivery' ? 'DELIVERED' : 'UNKNOWN')));
      }
      await page.locator('#coverageCellList .coverage-list-row').first().click();
      const gray = page.locator('#coverageMap path.coverage-selected[data-tone="unknown"]');
      await gray.waitFor({ state: 'attached' });
      check('selected uncertain hex has a gray dashed outline', await gray.evaluate(node =>
        getComputedStyle(node).stroke === 'rgb(100, 116, 139)' && getComputedStyle(node).strokeDasharray !== 'none'));
      await detail.getByRole('button', { name: '닫기' }).click();
      for (const days of [30, 60, 90]) {
        await page.locator('#coverageDays').selectOption(String(days));
        await page.waitForFunction(n => document.querySelector('#coverageBasis').textContent.includes('분석 ' + n + '일'), days);
        await page.locator('#coverageQuery').fill(sample.code);
        const pending = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(shade + 'search') && response.ok());
        await page.locator('#coverageSearch button').click();
        const response = await pending;
        const payload = (await response.json()).data;
        await page.locator('#coverageSearchResults .coverage-search-result').first().waitFor();
        const row = payload.results[0];
        check(days + ' day stored search follows selected analysis period',
          new URL(response.url()).searchParams.get('days') === String(days) && payload.days === days &&
          (await page.locator('.coverage-search-caption').innerText()).startsWith(days + '일 · ') &&
          row.stats.registeredWithin[500] <= row.stats.registeredWithin[1000]);
      }
    }

    const addresses = width === 1440 ? fixtureAddresses : [fixtureAddresses[0]];
    for (const [index, address] of addresses.entries()) {
      await page.locator('#coverageQuery').fill(address);
      await page.locator('#coverageSearch button').click();
      if (width === 1440) {
        const row = page.locator('#coverageSearchResults button[data-kind="address"]');
        await row.waitFor();
        const text = await row.innerText();
        check((index ? 'lot' : 'road') + ' address uses approved proxy and gets cell plus both radii',
          lookupCalls.length === index + 1 && lookupCalls[index] === index &&
          text.includes('H3 ') && text.includes('관측 방문') && text.includes('500m') && text.includes('1km') &&
          text.includes('배송 이력'));
      } else {
        await page.getByText('미등록 주소 조회는 승인된 주소 서비스 연결 후 사용할 수 있습니다.', { exact: true }).waitFor();
        check('unapproved address fallback makes no lookup request', lookupCalls.length === 0);
      }
    }
  } finally { await context.close(); }
}

try {
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.OPSMAP_TEST_CHROMIUM || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  if (fieldAnalysis) {
    await checkFieldAnalysis(1440);
    await checkFieldAnalysis(390);
  } else {
    await exercise(1440);
    await exercise(390);
    await retryCase({ failView: true }, '분석 격자를 불러오지 못했습니다.', 'H3 API failure');
    await retryCase({ failSdk: true }, '지도를 불러오지 못했습니다.', 'Kakao SDK loading failure');
    await retryCase({ missingKey: true }, '지도를 불러오지 못했습니다.', 'Kakao configuration failure');
  }
  check('no uncaught browser errors', !result.errors.length);
} catch (error) {
  failed = true;
  result.failure = String(error.stack || error).replace(/https?:[^\s'"]+/g, '[URL]').slice(0, 1350);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(output, (fieldAnalysis ? 'field-analysis' : 'third-tab') + '-browser.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ scope: result.scope, checks: result.checks.length, errors: result.errors, failure: result.failure }));
  if (failed) process.exitCode = 1;
}
