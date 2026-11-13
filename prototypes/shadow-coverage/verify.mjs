import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { statusFor, densityLevel } from './server.mjs';

const mode = process.argv[2];
const evidence = process.env.OPSMAP_PROTOTYPE_RESULTS;
assert(['h3','admin','postal'].includes(mode));
assert(evidence && path.isAbsolute(evidence));
assert.equal(statusFor({ visits: 1, stores: 2, eligibleStores: 0 }), 'delivered');
assert.equal(statusFor({ visits: 0, stores: 1, eligibleStores: 1 }), 'candidate');
assert.equal(statusFor({ visits: 0, stores: 2, eligibleStores: 1 }), 'unknown');
assert.equal(statusFor({ visits: 0, stores: 0, eligibleStores: 0 }), 'unknown');
assert.equal(densityLevel({ visits: 100, areaKm2: 1 }), 2);
assert.equal(densityLevel({ visits: 100, areaKm2: 2 }), 1);
await mkdir(evidence, { recursive: true });
const serverFile = new URL('server.mjs', import.meta.url);
const run = promisify(execFile);
const server = spawn(process.execPath, ['--max-old-space-size=320', fileURLToPath(serverFile), mode], {
  env: { ...process.env, OPSMAP_PROTOTYPE_PORT: '0' }, stdio: ['ignore','pipe','pipe'], windowsHide: true,
});
const ended = once(server, 'exit');
let browser, stopping = false;
const lines = readline.createInterface({ input: server.stdout });
server.stderr.on('data', data => process.stderr.write(data));
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await browser?.close();
  if (server.exitCode === null) { server.kill(); await ended; }
}

const percentile = (array, q) => {
  const sorted = array.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? +sorted[Math.max(0, Math.ceil(sorted.length*q)-1)].toFixed(2) : null;
};
const turn = (scope, layout) => scope + '-' + layout;
const centerOf = map => [Math.round(map.x + map.width*0.51), Math.round(map.y + map.height*0.58)];

async function getBrowserRss(session) {
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  const ids = [...new Set(processInfo.map(item => item.id))];
  assert(ids.length && ids.every(id => Number.isInteger(id) && id > 0), 'Chromium process IDs');
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '(Get-Process -Id ' + ids.join(',') + ' -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum'],
      { windowsHide: true, timeout: 10000 });
    assert(Number(stdout) > 0);
    return { processCount: ids.length, rssMiB: +(Number(stdout) / 1048576).toFixed(2) };
  }
  const { stdout } = await run('ps', ['-o', 'rss=', '-p', ids.join(',')], { timeout: 10000 });
  const totalKiB = stdout.trim().split(/\s+/).reduce((total, value) => total + Number(value), 0);
  assert(totalKiB > 0);
  return { processCount: ids.length, rssMiB: +(totalKiB / 1024).toFixed(2) };
}
async function ready(page, scope, count = 0) {
  await page.waitForFunction(({ scope, count }) => {
    const { ready, renderCount, cycles } = window.opsmapBench?.metrics || {};
    return ready && renderCount > count && cycles.at(-1)?.scope === scope;
  }, { scope, count }, { timeout: 120000 });
}

async function verifyTotals(meta, baseURL) {
  const b = meta.diagnostics;
  assert.equal(meta.evidence.observedDays, 76);
  assert.equal(meta.evidence.missingDates.length, 14);
  assert.equal(meta.evidence.centerDays.honam + meta.evidence.centerDays.yeongnam, 0);
  assert.equal(meta.evidence.completed, 88136);
  assert.equal(meta.evidence.bound, 87983);
  assert.equal(meta.evidence.unplaced, 153);
  assert.equal(meta.evidence.stores, 6043);
  assert.equal(meta.evidence.newActive, 756);
  assert.equal(meta.evidence.newUnknown, 223);
  assert.equal(meta.evidence.held, 6);
  if (b.state?.startsWith('BOUNDARIES_')) return { pass: false, reason: b.state };
  const samples = [];
  const zooms = mode === 'h3' ? [6.5,10.65,13.2,14.25] : [7];
  for (const z of zooms) {
    const response = await fetch(baseURL + '/api/view?bbox=124,32.98,132.2,39.6&w=1130&h=842&z=' + z,
      { signal: AbortSignal.timeout(120000) });
    assert.equal(response.status, 200);
    const result = await response.json();
    const sum = result.summary;
    assert.equal(sum.stores, b.mappedStores);
    assert.equal(sum.visits, b.mappedVisits);
    assert.equal(sum.newActive, meta.evidence.newActive);
    assert.equal(sum.newUnknown, meta.evidence.newUnknown);
    assert.equal(sum.held, meta.evidence.held);
    assert.equal(new Set(result.features.map(f => f.id)).size, result.features.length);
    assert(!JSON.stringify(result).match(/"customerCode"|"address"|"telephone"|"password"/i));
    assert(result.features.every(f => f.areaKm2 > 0 && f.rings.length > 0));
    samples.push({ zoom: z, resolution: result.resolution, count: sum.count, stores: sum.stores, visits: sum.visits,
      candidate: sum.candidate, observed: sum.delivered, unknown: sum.unknown });
  }
  return { pass: true, samples };
}

async function testScope(page, session, browserSession, key, scope, baseURL, measurement) {
  if (scope !== 'nation') {
    const before = await page.evaluate(() => window.opsmapBench.metrics.renderCount);
    await page.locator('button[data-view=' + scope + ']').click();
    await ready(page, scope, before);
  } else await ready(page, scope);
  const file = path.join(evidence, mode + '-' + turn(scope, key) + '.png');
  const map = await page.locator('#map').boundingBox();
  assert(map && map.width >= 390 && map.height >= 400);
  const initial = await page.evaluate(() => window.opsmapBench.metrics.cycles.at(-1));
  if (measurement.layerConnected) assert(initial.features > 0, mode + ' ' + key + ' ' + scope + ' contains evidence shapes');
  const viewport = page.viewportSize();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const state = await page.locator('#availability-label').innerText();
  assert.match(state, /76\/90일 관측 · 미확인 14일/);
  assert(await page.locator('#map').isVisible());
  await page.screenshot({ path: file, fullPage: false });
  const perf = await session.send('Performance.getMetrics');
  const statsBefore = await fetch(baseURL + '/api/metrics').then(r => r.json());
  const [x,y] = centerOf(map);
  const ySafe = Math.min(viewport.height - 25, y);
  await page.evaluate(() => window.opsmapBench.startFrames());
  for (let cycle = 0; cycle < 4; cycle++) {
    const current = await page.evaluate(() => window.opsmapBench.metrics.renderCount);
    await page.mouse.move(x, ySafe);
    await page.mouse.down();
    await page.mouse.move(x+(cycle%2 ? -32 : 32), ySafe+(cycle%2 ? 13 : -13), { steps: 12 });
    await page.mouse.up();
    await ready(page, scope, current);
    const moved = await page.evaluate(() => window.opsmapBench.metrics.renderCount);
    await page.mouse.move(x, ySafe);
    await page.mouse.wheel(0, cycle%2 ? 100 : -100);
    await ready(page, scope, moved);
  }
  const frames = await page.evaluate(() => window.opsmapBench.stopFrames());
  assert(frames.intervals.length > 0);
  const cycles = await page.evaluate(() => window.opsmapBench.metrics.cycles);
  const interactions = cycles.slice(-8).map(x => x.updateAfterGestureMs);
  const statsAfter = await fetch(baseURL + '/api/metrics').then(r => r.json());
  const mapHeight = Math.round(map.height);
  const postMemory = await session.send('Performance.getMetrics');
  const browserMemory = await getBrowserRss(browserSession);
  measurement.cases[turn(scope,key)] = {
    ...initial, viewport, mapHeight, fps: frames.fps, frameCount: frames.intervals.length, frameP95Ms: percentile(frames.intervals, 0.95),
    maxFrameGapMs: percentile(frames.intervals, 1), samples: interactions.filter(Number.isFinite).length,
    refreshMedianMs: percentile(interactions, 0.5), refreshP95Ms: percentile(interactions, 0.95),
    browserJsHeapMiB: +(perf.metrics.find(value => value.name === 'JSHeapUsedSize').value / 1048576).toFixed(2),
    browserJsHeapAfterMiB: +(postMemory.metrics.find(value => value.name === 'JSHeapUsedSize').value / 1048576).toFixed(2),
    browserProcessCount: browserMemory.processCount, browserCombinedRssMiB: browserMemory.rssMiB,
    serverRssMiB: statsAfter.rssMiB, serverRssAtCaptureMiB: statsBefore.rssMiB, serverPeakRssMiB: statsAfter.peakRssMiB,
    screenshot: path.basename(file),
  };
  if (scope === 'detail' && measurement.layerConnected) {
    const target = await page.evaluate(() => window.opsmapBench.regionTarget());
    assert(target, 'a delivered feature must be selectable in the detail view');
    await page.mouse.click(map.x + target.point[0], map.y + target.point[1]);
    await page.locator('#inspection').waitFor({ state: 'visible' });
    assert.match(await page.locator('#area-facts').innerText(), /등록 매장[\s\S]*관측 배송/);
    await page.screenshot({ path: path.join(evidence, mode + '-detail-selected-' + key + '.png') });
    await page.locator('#close-inspection').click();
    assert(await page.locator('#inspection').isHidden());
  }
  console.log(mode, turn(scope,key), JSON.stringify({ feature: initial.features, refreshP95Ms: measurement.cases[turn(scope,key)].refreshP95Ms,
    fps: frames.fps, rssMiB: statsAfter.peakRssMiB, browserRssMiB: browserMemory.rssMiB }));
}

try {
  let bootTimeout;
  const line = await Promise.race([
    once(lines, 'line').then(values => values[0]),
    ended.then(([code]) => { throw Error('Layer server exited: ' + code); }),
    new Promise((_,reject) => { bootTimeout = setTimeout(() => reject(Error('Layer startup timeout')),120000); }),
  ]).finally(() => clearTimeout(bootTimeout));
  const boot = JSON.parse(line);
  const meta = await fetch(boot.url + '/api/meta').then(r => r.json());
  const connected = !meta.diagnostics.state?.startsWith('BOUNDARIES_');
  const report = { mode, meta, layerConnected: connected, host: process.platform, node: process.version, cases: {} };
  browser = await chromium.launch({ headless: true, args: ['--disable-background-networking','--no-first-run','--disable-application-cache','--disk-cache-size=1048576'] });
  report.chromium = browser.version();
  const browserSession = await browser.newBrowserCDPSession();
  for (const [key, viewport] of [['pc',{width:1440,height:900}], ['mobile',{width:390,height:844}]]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: key === 'pc' ? 1 : 2,
      isMobile: key === 'mobile', hasTouch: key === 'mobile' });
    const unwanted = [];
    const errors = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === boot.url) return route.continue();
      unwanted.push(url.origin); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const session = await context.newCDPSession(page);
    await session.send('Performance.enable');
    await page.goto(boot.url + '/?bench=1', { waitUntil: 'domcontentloaded' });
    for (const scope of ['nation','region','detail']) await testScope(page, session, browserSession, key, scope, boot.url, report);
    assert.deepEqual(unwanted, []);
    assert.deepEqual(errors, []);
    await context.close();
  }
  report.conservation = await verifyTotals(meta, boot.url);
  report.final = await fetch(boot.url + '/api/metrics').then(r => r.json());
  assert(report.final.rssMiB < 512 && report.final.peakRssMiB < 512, '512MiB server reference exceeded');
  await writeFile(path.join(evidence, mode + '-metrics.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(mode, connected ? 'PASS' : meta.diagnostics.state, 'peak RSS', report.final.peakRssMiB);
} finally {
  await shutdown();
}
