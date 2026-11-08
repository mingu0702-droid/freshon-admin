import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createStageVerificationApp } from '../src/stageVerificationEntry.js';
import { createStaffPasswordHash } from '../src/opsmap-abc/mapStaffAuth.js';
import { snapshotProjection } from '../src/productionSnapshotStore.js';
import { createShadowCoverageStore } from '../src/shadowCoverage/store.js';

const [directory, output] = process.argv.slice(2);
assert(path.isAbsolute(directory || '') && path.isAbsolute(output || ''));
await fs.mkdir(output, { recursive: true });
const stageOrigin = 'https://freshon-admin-stage-preview-template.onrender.com';
const base = '31e50c9ce1d2d0213d1c48bb079d09cd29effd44';
const sdkFixture = await fs.readFile(new URL('./fixtures/shadow-coverage-kakao.js', import.meta.url), 'utf8');
const source = await createShadowCoverageStore({ directory }).readPeriod(90);
assert.equal(source.index.kind, 'OBSERVED');
const date = source.index.asOf;
const sample = source.catalog.stores.find(row => row.cell && row.address && row.code && row.registered);
assert(sample);
const result = { scope: 'LOCAL_STAGE_CODE_CHROMIUM_SDK_FIXTURE_REAL_PRIVATE_H3', base,
  checks: [], render: {}, timings: {}, errors: [], requestsToStage: 0, providerCalls: 0, sourceWrites: 0 };
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
const current = snapshotProjection({ version: 'phase2b-map-snapshot-v1', latestDate: date, startDate: source.window.start, rows });
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
const shadeEndpoint = '/api/map-phase2b/private/shadow-coverage/';
const baseHtml = execFileSync('git', ['show', base + ':public/opsmap/map-phase2b-preview.html'], { encoding: 'utf8' });
const baseSdk = execFileSync('git', ['show', base + ':public/opsmap/kakao-maps-adapter.js'], { encoding: 'utf8' });
let browser, failed;
let rssPeak = process.memoryUsage().rss;
const sampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 75);

async function open(width, original = false) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 930 },
    isMobile: width === 390, hasTouch: width === 390, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(9500);
  page.on('pageerror', error => result.errors.push({ width, name: error.name, message: error.message.replace(/https?:\S+/g, '[URL]').slice(0, 100) }));
  const stats = { views: 0, cellReads: 0, searchReads: 0, maxBytes: 0, roadRequests: 0, radii: [] };
  let holdView, releaseView;
  await context.route('**/*', async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === 'https://dapi.kakao.com' && requestUrl.pathname === '/v2/maps/sdk.js') {
      return route.fulfill({ contentType: 'application/javascript', body: sdkFixture });
    }
    if (requestUrl.origin !== stageOrigin) return route.abort();
    const pathname = requestUrl.pathname;
    if (original && pathname === '/opsmap/') return route.fulfill({ contentType: 'text/html', body: baseHtml });
    if (original && pathname === '/opsmap/kakao-maps-adapter.js') return route.fulfill({ contentType: 'application/javascript', body: baseSdk });
    // Existing remote sources are fixture-only. Auth, snapshot and H3 use the Stage entry point.
    if (pathname.endsWith('/customer-search')) {
      const query = decodeURIComponent((await route.request().allHeaders())['x-map-customer-query'] || '');
      const found = stores.filter(row => [row.address, row.customerCode].includes(query));
      return route.fulfill({ json: { ok: true, data: found, meta: { customerMatchVerified: true } } });
    }
    if (pathname.endsWith('/assignments')) return route.fulfill({ json: { ok: true, data: dayRows, meta: { complete: true, date } } });
    if (pathname.endsWith('/route-plan')) return route.fulfill({ json: { ok: true, data: { stops: dayRows, date, vehicle: '101' } } });
    if (pathname.endsWith('/manual-road-route') && route.request().method() === 'POST') {
      stats.roadRequests++;
      const body = route.request().postDataJSON();
      assert.equal(body.mode, 'MANUAL_WAYPOINTS');
      assert.equal(body.waypoints.length, 1);
      const coords = [body.origin, ...body.waypoints, body.destination].map(point => [point.lat, point.lng]);
      return route.fulfill({ json: { ok: true, data: { mode: body.mode, requestId: body.requestId, source: 'kakao-directions', isGpsActual: false,
        state: 'success', complete: true, coveredLegs: 2, totalLegs: 2, distanceMeters: 4300, durationSeconds: 625,
        legs: coords.slice(1).map((_, index) => ({ index, distanceMeters: 2150, durationSeconds: index ? 312 : 313 })),
        chunks: [{ state: 'success', startLeg: 0, endLeg: 1, geometry: coords.slice(1)
          .map((point, index) => ({ legOffset: index, latLngs: [coords[index],
            [(coords[index][0] + point[0]) / 2 + .001, (coords[index][1] + point[1]) / 2], point] })) }] } } });
    }
    const shade = pathname.includes(shadeEndpoint);
    const view = shade && pathname.endsWith('/view');
    if (view) stats.views++;
    if (shade && pathname.endsWith('/cell')) stats.cellReads++;
    if (shade && pathname.endsWith('/search')) { stats.searchReads++; stats.radii.push(requestUrl.searchParams.get('radius')); }
    const response = await route.fetch({ url: origin + pathname + requestUrl.search,
      headers: await route.request().allHeaders(), maxRedirects: 0, timeout: 15000 });
    if (view && response.ok()) {
      stats.maxBytes = Math.max(stats.maxBytes, (await response.body()).length);
      if (holdView) await holdView;
    }
    await route.fulfill({ response }).catch(() => {});
  });
  const started = performance.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#mapStaffEntry input[name=username]').fill('coverage-local-fixture');
  await page.locator('#mapStaffEntry input[name=password]').fill(password);
  const submitting = performance.now();
  await page.locator('#mapStaffEntry button[type=submit]').click();
  await page.waitForFunction(() => document.body.dataset.mapStaffState === 'authenticated' &&
    window.MapUiLocalBridge?.isDataReady() && window.MapUiLocalBridge.state.overlays.length > 0);
  const initial = { openAndLoginMs: Math.round(performance.now() - started),
    submitToPinsMs: Math.round(performance.now() - submitting) };
  return { page, context, stats, initial,
    holdNextView() { holdView = new Promise(resolve => { releaseView = resolve; }); },
    releaseView() { releaseView?.(); holdView = undefined; } };
}

const setView = (page, lat, lng, level) => page.evaluate(([y, x, z]) => {
  const map = MapUiLocalBridge.state.map;
  map.setCenter(new kakao.maps.LatLng(y, x));
  map.setLevel(z);
}, [lat, lng, level]);
const measure = async page => {
  const session = await page.context().newCDPSession(page);
  await session.send('HeapProfiler.collectGarbage');
  const { usedSize } = await session.send('Runtime.getHeapUsage');
  await session.detach();
  return usedSize;
};
async function selectVehicle(page) {
  const picker = page.locator('#baseVehiclePicker > summary');
  await picker.click();
  await page.locator('#vehicleList input[value="101"]').check();
  await page.waitForFunction(() => MapUiLocalBridge.state.selectedVehicles.join(',') === '101');
  if (await page.locator('#baseVehiclePicker').getAttribute('open') !== null) await picker.click();
}

async function cameraSample(page, withShade) {
  const latencies = [], markerRenders = [];
  let before, middle;
  for (let i = 0; i < 28; i++) {
    const rendered = await page.locator('#map').evaluate(node => JSON.parse(node.dataset.renderMetrics).renders);
    const response = withShade && page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/shadow-coverage/view') && r.ok());
    const start = performance.now();
    await setView(page, 37.16 + i * .0008, 127.10 + i * .0006, i % 2 ? 6 : 7);
    await page.waitForFunction(n => JSON.parse(document.querySelector('#map').dataset.renderMetrics).renders > n, rendered);
    const markerMs = await page.locator('#map').evaluate(node => JSON.parse(node.dataset.renderMetrics).lastMs);
    if (response) {
      const view = (await (await response).json()).data;
      await page.waitForFunction(n => document.querySelectorAll('.coverage-overlay path').length === n, view.cells.length);
    }
    if (i >= 4) {
      latencies.push(Math.round(performance.now() - start));
      markerRenders.push(markerMs);
    }
    if (i === 3) before = await measure(page);
    if (i === 15) middle = await measure(page);
  }
  const p95 = rows => rows.sort((a, b) => a - b)[Math.ceil(rows.length * .95) - 1];
  const after = await measure(page);
  return { samples: latencies.length, p95Ms: p95(latencies), markerRenderP95Ms: p95(markerRenders),
    afterForcedGcBytes: after - before, lastTwelveAfterForcedGcBytes: after - middle };
}

const aggregate = page => page.locator('.coverage-overlay path').count();
async function showEvidence(page) {
  const summary = page.locator('#coverageEvidence > summary');
  await summary.click();
  const dates = await page.locator('#coverageEvidenceBody strong').filter({ hasText: '기록 미확인' }).locator('xpath=following-sibling::p[1]').innerText();
  check('exact missing dates are shown', dates === source.window.missing.join(' · ') && source.window.missing.length === 14);
  const facts = await page.locator('#coverageEvidenceBody').innerText();
  check('period and registry are shown separately from map', facts.includes('기록 76/90일') && facts.includes('등록 매장 6,043곳'));
  await summary.click();
}
async function markCapture(page) {
  await page.evaluate(() => {
    const badge = document.createElement('div');
    badge.textContent = '로컬 검수 · 카카오 SDK 모의 · 배송 실집계';
    badge.style.cssText = 'position:absolute;left:10px;bottom:8px;padding:4px 7px;z-index:70;pointer-events:none;background:#fffdf3;color:#554826;border:1px solid #ddcf9f;border-radius:4px;font:11px sans-serif';
    document.querySelector('#map').append(badge);
  });
}

try {
  const privatePath = '/opsmap' + shadeEndpoint + 'view?box=126,36,129,39';
  check('Stage code guards private coverage API before storage', (await fetch(origin + privatePath)).status === 401);
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.OPSMAP_TEST_CHROMIUM || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  for (const width of [1440, 390]) {
    const baseline = await open(width, true);
    result.timings[width] = { baseline: baseline.initial };
    check(width + ' original Stage UI has no shadow control', await baseline.page.locator('#modeShadowCoverage').count() === 0);
    if (width === 1440) {
      await selectVehicle(baseline.page);
      result.timings[width].baseline.panZoom = await cameraSample(baseline.page, false);
    }
    await baseline.context.close();
    const { page, context, stats, initial, holdNextView, releaseView } = await open(width);
    result.timings[width].candidate = initial;
    try {
      const toggle = page.getByRole('button', { name: '음영권역', exact: true });
      const ready = () => page.waitForFunction(() => Boolean(document.querySelector('.coverage-overlay path')));
      const markers = () => page.evaluate(() => MapUiLocalBridge.state.overlays.length);
      const mapCount = await page.evaluate(() => __coverageFixture.maps());
      check(width + ' defaults to OFF with no coverage requests', (await toggle.getAttribute('aria-pressed')) === 'false' && stats.views === 0 && !await aggregate(page));
      await selectVehicle(page);
      check(width + ' vehicle filter remains on the existing map', await page.evaluate(() =>
        MapUiLocalBridge.state.currentRows.every(row => row.baseVehicle === '101')));
      await setView(page, 37.17, 127.11, 5);
      const nativeMarker = page.locator('#map [data-customer-code="S990002"]');
      await nativeMarker.waitFor({ state: 'visible' });
      const count = await markers();
      const cold = performance.now();
      const responsePending = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/shadow-coverage/view') && r.ok());
      await toggle.click();
      const response = await responsePending;
      await ready();
      result.timings[width].firstOverlayMs = Math.round(performance.now() - cold);
      check(width + ' private coverage response is no-store', response.headers()['cache-control']?.includes('no-store') && response.headers().vary?.includes('Cookie'));
      check(width + ' shade paths cannot intercept pin clicks', (await page.locator('.coverage-overlay').evaluate(node => getComputedStyle(node).pointerEvents)) === 'none');
      check(width + ' shade layer uses the same map and marker count', (await page.evaluate(() => __coverageFixture.maps())) === mapCount && await markers() === count);
      await showEvidence(page);
      await nativeMarker.click();
      await page.waitForFunction(() => MapUiLocalBridge.state.selected?.customerCode === 'S990002');
      check(width + ' store marker retains click and detail', await page.locator('#detailSection').isVisible());
      const key = await page.evaluate(() => [MapUiLocalBridge.state.map.getLevel(), MapUiLocalBridge.state.selected.customerCode]);
      const selectedCount = await markers();
      await toggle.click();
      check(width + ' OFF leaves the pin, selection and zoom alone', !await aggregate(page) && await markers() === selectedCount &&
        JSON.stringify(await page.evaluate(() => [MapUiLocalBridge.state.map.getLevel(), MapUiLocalBridge.state.selected.customerCode])) === JSON.stringify(key));
      await toggle.click();
      await ready();

      const viewRequest = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/shadow-coverage/view') && r.ok());
      await setView(page, 37.17, 127.11, 4);
      const zoomed = await (await viewRequest).json();
      check(width + ' zoom adapts grid resolution', zoomed.data.resolution === 8);
      await page.waitForFunction(n => document.querySelectorAll('.coverage-overlay path').length === n, zoomed.data.cells.length);
      const click = await page.evaluate(cells => {
        const map = MapUiLocalBridge.state.map, projection = map.getProjection();
        const rect = document.querySelector('#map').getBoundingClientRect();
        for (const cell of cells) {
          const point = projection.containerPointFromCoords(new kakao.maps.LatLng(...cell.location));
          const x = rect.x + point.x, y = rect.y + point.y, target = document.elementFromPoint(x, y);
          if (target?.closest('#map') && !target.closest('button')) return { x, y, id: cell.id };
        }
        return null;
      }, zoomed.data.cells.filter(cell => cell.location && cell.visits > 0));
      assert(click);
      await page.mouse.click(click.x, click.y);
      await page.locator('#coverageDetail').getByText('자료 기간', { exact: true }).waitFor();
      check(width + ' selected hex shows deliveries, registered count and period',
        (await page.locator('#coverageDetail').innerText()).includes(source.window.start + ' ~ ' + date) &&
        (await page.locator('#coverageDetail .coverage-cell-id').innerText()) === click.id && stats.cellReads > 0);
      await page.locator('#coverageDetail').getByRole('button', { name: '닫기' }).click();
      await setView(page, 37.17, 127.11, 7);
      await ready();
      await markCapture(page);
      check(width + ' no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(output, 'candidate-' + width + '.png'), fullPage: width === 390, animations: 'disabled' });

      if (width === 1440) {
        for (const query of [stores[0].customerCode, stores[1].address]) {
          await page.locator('#query').fill(query);
          await page.locator('#searchBtn').click();
          await page.waitForFunction(code => MapUiLocalBridge.state.selected?.customerCode === code,
            query === stores[0].customerCode ? stores[0].customerCode : stores[1].customerCode);
        }
        check('existing customer code and exact address search work with the layer on',
          await toggle.getAttribute('aria-pressed') === 'true');
        await page.locator('#query').fill('경기 오산시 검수미등록길 100');
        await page.locator('#searchBtn').click();
        await page.locator('#map[data-search-position-pending]').waitFor();
        await page.evaluate(() => kakao.maps.event.trigger(MapUiLocalBridge.state.map, 'click',
          { latLng: new kakao.maps.LatLng(37.172, 127.108) }));
        await page.locator('#map [data-search-temporary-pin]').waitFor();
        check('existing temporary pin and 500m circle remain above the layer', await page.evaluate(() =>
          __coverageFixture.shapes().some(shape => shape.radius === 500)));
        await page.locator('#clearQuery').click();
        check('clearing the existing search keeps the shade layer', await toggle.getAttribute('aria-pressed') === 'true' &&
          !await page.locator('#map [data-search-temporary-pin]').count());

        await page.locator('#waypointPlanner > summary').click();
        await page.locator('#plannerStart').fill(stores[0].customerCode);
        await page.locator('#addWaypoint').click();
        await page.locator('#plannerWaypoint0').fill(stores[1].customerCode);
        await page.locator('#plannerEnd').fill(stores[2].customerCode);
        await page.locator('#planRoute').click();
        await page.locator('#navigationSummary[data-state=success]').waitFor({ state: 'attached' });
        check('manual origin, waypoint and destination draw both fixture road legs', stats.roadRequests === 1 &&
          (await page.locator('#navDistance').textContent()) === '4.3 km' &&
          (await page.locator('#navDuration').textContent()) === '11분' &&
          await page.evaluate(() => __coverageFixture.shapes().filter(shape => Array.isArray(shape.path)).length === 2));
        await toggle.click();
        check('turning the layer off preserves the road route', !await aggregate(page) &&
          await page.evaluate(() => document.querySelector('#navigationSummary').dataset.state === 'success' &&
            __coverageFixture.shapes().filter(shape => Array.isArray(shape.path)).length === 2));
        await toggle.click();
        await ready();
        await page.locator('#coverageTools > summary').click();
        for (const [radius, query] of [['500', sample.code], ['1000', sample.address]]) {
          await page.locator('#coverageRadius').selectOption(radius);
          await page.locator('#coverageQuery').fill(query);
          await page.locator('#coverageSearch').getByRole('button', { name: '검색' }).click();
          await page.locator('#coverageSearchResults .coverage-search-result').first().waitFor();
          check(radius + 'm search shows a stored match and count', (await page.locator('#coverageSearchResults').innerText()).includes('반경 내 등록 매장'));
        }
        check('500m and 1km queries used the private read endpoint', stats.radii.join(',') === '500,1000');
        await page.locator('#coverageTools > summary').click();
        for (const days of ['30', '60', '90']) {
          await page.locator('#coverageDays').selectOption(days);
          await page.waitForFunction(n => document.querySelector('#coverageEvidenceBody').textContent.includes('/' + n + '일'), days);
          check('retained ' + days + ' day filter', true);
        }

        await page.locator('#modeDaily').click();
        await page.waitForFunction(() => MapUiLocalBridge.state.mode === 'DATE_ROUTE');
        check('overlay stays enabled when existing daily mode opens', (await toggle.getAttribute('aria-pressed')) === 'true' &&
          await page.locator('#chooseRoutes').isVisible());
        await page.locator('#chooseRoutes').click();
        await page.locator('#vehicleList input[value="101"]').check();
        await page.locator('#selectedDate').fill(date);
        await page.locator('#queryRoutes').click();
        await page.waitForFunction(day => MapUiLocalBridge.state.selectedDate === day && MapUiLocalBridge.isDataReady() &&
          document.querySelectorAll('#runList [data-run-vehicle="101"]').length === 2, date);
        check('dated vehicle visits remain accessible with the shade layer on',
          await toggle.getAttribute('aria-pressed') === 'true');
        await page.locator('#modePeriod').click();
        await page.waitForFunction(() => MapUiLocalBridge.state.mode === 'BASE_60D');
        check('general mode returns without replacing the map', await page.evaluate(() => __coverageFixture.maps()) === mapCount);

        result.timings[width].panZoom = await cameraSample(page, true);
        check('pan and zoom keep the view capped at 360 grid paths', await aggregate(page) <= 360);
        const existing = await page.evaluate(() => MapUiLocalBridge.state.map.listeners.get('idle').size);
        holdNextView();
        const first = page.waitForRequest(r => new URL(r.url()).pathname.endsWith('/shadow-coverage/view'));
        await setView(page, 37.18, 127.115, 6);
        await first;
        await toggle.click();
        releaseView();
        check('closing pending viewport drops its layer and idle listener', !await aggregate(page) &&
          await page.evaluate(() => MapUiLocalBridge.state.map.listeners.get('idle').size) === existing - 1);
        await toggle.click();
        await ready();
      }

      await page.locator('#staffLogout').click();
      await page.waitForFunction(() => document.body.dataset.mapStaffState === 'signed-out');
      check(width + ' logout clears geometry and protected UI', !await aggregate(page) && !await toggle.isVisible() &&
        (await page.locator('#coverageEvidenceBody').textContent()) === '');
      const denial = await page.evaluate(async api => (await fetch(api)).status, privatePath);
      check(width + ' private H3 endpoint is 401 after logout', denial === 401);
      result.render[width] = stats;
    } catch (error) {
      result.failureState = await page.evaluate(() => ({
        mode: MapUiLocalBridge.state.mode, mapLevel: MapUiLocalBridge.state.map?.getLevel(),
        markers: MapUiLocalBridge.state.overlays.length,
        hasSample: MapUiLocalBridge.state.currentRows.some(row => row.customerCode === 'S990001'),
        hasIndividualMarker: Boolean(document.querySelector('#map [data-customer-code="S990002"]')),
        cells: document.querySelectorAll('.coverage-overlay path').length,
        shade: document.querySelector('#coverageStatus')?.textContent
      }));
      throw error;
    } finally {
      releaseView();
      await context.close();
    }
  }
  check('no uncaught browser errors', !result.errors.length);
} catch (error) {
  failed = true;
  result.failure = String(error.stack || error).replace(/https?:[^\s'"]+/g, '[URL]').slice(0, 1000);
} finally {
  clearInterval(sampler);
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  result.localProcessPeakRssBytes = rssPeak;
  await fs.writeFile(path.join(output, 'browser.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ scope: result.scope, checks: result.checks.length, failure: result.failure, errors: result.errors, timings: result.timings }));
  if (failed) process.exitCode = 1;
}
