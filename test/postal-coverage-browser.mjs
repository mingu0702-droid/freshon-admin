import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, snapshotRoot, statusFile, packageDir, auditFile, output, sdk = 'fixture'] = process.argv.slice(2);
assert(['postal', 'h3', 'server-postal', 'server-h3'].includes(mode));
assert([snapshotRoot, statusFile, packageDir, auditFile, output].every(value => path.isAbsolute(value || '')));
const origin = 'https://freshon-admin-stage-preview-template.onrender.com';
const staffId = 'postal-local-fixture';
const statusDigest = '8d8ff1ebb24eb95d0fb9902138b3bd813e087249baa0e6552060ee5c961e43f5';
const roots = { h3: '/api/map-phase2b/private/shadow-coverage', postal: '/api/map-phase2b/private/shadow-coverage/postal' };
const pathnameOf = url => new URL(url).pathname.replace(/^\/opsmap(?=\/api\/)/, '');
const audit = JSON.parse(await readFile(auditFile, 'utf8'));
const date = '2026-11-07';

async function runServer(kind) {
  const { createStageVerificationApp } = await import('../src/stageVerificationEntry.js');
  const { createStaffPasswordHash } = await import('../src/opsmap-abc/mapStaffAuth.js');
  const { openOpsmapSyncGenerationStore } = await import('../src/opsmapSyncGeneration.js');
  const generation = await (await openOpsmapSyncGenerationStore(snapshotRoot)).read();
  assert.equal(generation.index.sha256, audit.generation);
  let savedSession, revision = 0, rejectedRemoteCalls = 0;
  const githubContent = (value, revision = 1) => {
    const bytes = Buffer.from(JSON.stringify(value));
    return Response.json({ sha: revision.toString(16).padStart(40, '0'), encoding: 'base64',
      size: bytes.length, content: bytes.toString('base64') });
  };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname !== 'api.github.com') { rejectedRemoteCalls++; throw Error('TEST_NETWORK_BLOCKED'); }
    const file = url.pathname.split('/').at(-1);
    if (file === 'freshon-cache') return Response.json({ private:true, permissions:{ push:true } });
    if (options.method === 'PUT') {
      assert.equal(file, 'staff-sessions-v1.json');
      savedSession = JSON.parse(Buffer.from(JSON.parse(options.body).content, 'base64'));
      revision++;
      return Response.json({ ok:true });
    }
    if (file === 'staff-sessions-v1.json' && savedSession) return githubContent(savedSession, revision);
    return new Response(null, { status:404 });
  };
  const password = randomBytes(18).toString('hex');
  let jsKey = '0'.repeat(32);
  if (sdk === 'live-sdk') {
    const legacy = await readFile(new URL('../public/daily-routes.html', import.meta.url), 'utf8');
    const keys = [...new Set([...legacy.matchAll(/appkey=([a-f0-9]{32})/gi)].map(match => match[1]))];
    assert.equal(keys.length, 1, 'existing JavaScript key required');
    jsKey = keys[0];
  }
  const app = createStageVerificationApp({
    env: {
      RENDER_EXTERNAL_URL:origin, RENDER_SERVICE_ID:'srv-da47hugu01pc73etpfa0',
      MAP_STAFF_ID:staffId, MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash(password),
      MAP_STAFF_SESSION_SECRET:randomBytes(32).toString('base64url'), KAKAO_MAP_JAVASCRIPT_KEY:jsKey,
      GITHUB_TOKEN:'isolated-test', GITHUB_CACHE_REPO:'mingu0702-droid/freshon-cache',
      OPSMAP_MANUAL_PIN_GITHUB_BRANCH:'stage/opsmap-manual-pins',
      OPSMAP_STAGE_SYNC_READ_APPROVED:'1', OPSMAP_STAGE_SYNC_DIR:snapshotRoot, OPSMAP_SHADOW_DATA_DIR:generation.coverage,
      OPSMAP_STAGE_STORE_STATUS_APPROVED:'1', OPSMAP_STAGE_STORE_STATUS_FILE:statusFile, OPSMAP_STAGE_STORE_STATUS_SHA256:statusDigest,
      ...(kind === 'postal' ? { OPSMAP_SHADOW_COVERAGE_FORMAT:'postal', OPSMAP_SHADOW_POSTAL_DIR:packageDir,
        OPSMAP_SHADOW_POSTAL_REVIEW_DIR:process.env.OPSMAP_SHADOW_POSTAL_REVIEW_DIR,
        OPSMAP_SHADOW_POSTAL_REVIEW_SHA256:process.env.OPSMAP_SHADOW_POSTAL_REVIEW_SHA256,
        OPSMAP_SHADOW_POSTAL_BOUNDARY_SHA256:audit.manifestSha256, OPSMAP_SHADOW_POSTAL_RELEASE_SHA256:audit.releaseSha256 } : {})
    },
    openScheduledStore:async () => (await openOpsmapSyncGenerationStore(snapshotRoot)),
    fetchImpl, readHub:async action => {
      if (action === 'mapModelStatus') return { data:{ customer:{ freshon:date, delivery:date } } };
      if (action === 'customerRegistry') return { ok:true, data:{ rows:[] } };
      throw Error('FIXTURE_HUB_READ');
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  app.emit('opsmap-stage-listening');
  const sample = [...generation.registry.values()].find(row => row.hasPoint && row.center === 'osan' && row.address &&
    row.lat > 37.12 && row.lat < 37.20 && row.lng > 126.99 && row.lng < 127.14);
  assert(sample);
  process.send({ url:'http://127.0.0.1:' + server.address().port, password, sample:{ code:sample.code, address:sample.address } });
  process.on('message', id => process.send({ id, rss:process.memoryUsage().rss, heapUsed:process.memoryUsage().heapUsed,
    peakRss:process.resourceUsage().maxRSS * 1024, rejectedRemoteCalls }));
}

const quantile = (values, q) => {
  const ordered = values.slice().sort((a,b) => a-b);
  return +ordered[Math.max(0, Math.ceil(q * ordered.length) - 1)].toFixed(2);
};
const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

async function runBrowser() {
  const { chromium } = await import('playwright');
  const out = await mkdir(output, { recursive:true });
  const { stat } = await import('node:fs/promises');
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const executablePath = process.env.OPSMAP_TEST_CHROMIUM || (await stat(chrome).catch(() => null) ? chrome : undefined);
  const fixture = await readFile(new URL('./fixtures/shadow-coverage-kakao.js', import.meta.url), 'utf8');
  const baseMap = sdk === 'fixture' ? await readFile(new URL('../prototypes/shadow-coverage/basemap.json', import.meta.url), 'utf8')
    .then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) : null;
  const child = fork(fileURLToPath(import.meta.url), ['server-' + mode, snapshotRoot, statusFile, packageDir, auditFile, output, sdk],
    { execArgv:['--max-old-space-size=320'], stdio:['ignore','pipe','pipe','ipc'], windowsHide:true });
  const ended = once(child, 'exit');
  child.stdout.resume();
  child.stderr.resume();
  let browser, serial = 0, step = '서버 시작', page;
  const responseStatuses = {};
  const report = { format:mode, sdk, fullStageApp:true, deployed:false, browser:[], server:[] };
  try {
    const [port] = await Promise.race([once(child, 'message'), ended.then(() => { throw Error('Local stage process exited'); })]);
    const privateSnapshot = '/api/map-phase2b/preview/snapshot';
    async function memory() {
      const id = ++serial;
      const pending = once(child, 'message');
      child.send(id);
      const [sample] = await Promise.race([pending, ended.then(() => { throw Error('Local stage process exited'); })]);
      assert.equal(sample.id, id);
      const values = {};
      for (const [key, value] of Object.entries(sample)) if (key !== 'id') {
        values[key] = key === 'rejectedRemoteCalls' ? value : +(value / 1048576).toFixed(2);
      }
      report.server.push(values);
      return values;
    }
    await memory();
    const unauthorized = await fetch(port.url + roots[mode] + '/view?box=124,33,132,39&level=12');
    assert.equal(unauthorized.status, 401);
    browser = await chromium.launch({ executablePath, headless:true, args:['--disable-background-networking',
      '--disk-cache-size=1048576', '--disable-application-cache'] });
    report.chrome = browser.version();

    for (const width of [1440,390]) {
      const phone = width === 390;
      const context = await browser.newContext({ viewport:{width,height:phone ? 844 : 900}, deviceScaleFactor:phone ? 2 : 1,
        isMobile:phone, hasTouch:phone, serviceWorkers:'block' });
      page = await context.newPage();
      page.setDefaultTimeout(18000);
      const sdkStatuses = [], sdkAssets = new Set(), rejectedSdkAssets = new Set(), sdkFailures = new Set();
      let pageErrorCount = 0;
      const shapes = '#coverageMap ' + (mode === 'postal' ? 'canvas.postal-map-overlay' : 'svg.coverage-overlay path');
      const reqs = { view:0, tile:0, h3:0, inspected:0, posted:0 };
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.hostname === 'dapi.kakao.com' && url.pathname === '/v2/maps/sdk.js') sdkStatuses.push(response.status());
        if (url.origin !== origin && response.ok()) sdkAssets.add(url.hostname);
        if (url.origin === origin && /(?:postal|shadow-coverage|map-sdk-config)/.test(url.pathname)) {
          const status = response.status();
          responseStatuses[status] = (responseStatuses[status] || 0) + 1;
        }
      });
      page.on('pageerror', () => { pageErrorCount++; });
      page.on('requestfailed', request => {
        const url = new URL(request.url());
        if (/kakao|daum/.test(url.hostname)) sdkFailures.add(url.hostname);
      });
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const endpoint = pathnameOf(request.url());
        if (url.origin !== origin) {
          const get = request.method() === 'GET';
          const sdkLoader = url.hostname === 'dapi.kakao.com' && url.pathname === '/v2/maps/sdk.js';
          if (sdkLoader && sdk === 'fixture') return route.fulfill({ contentType:'text/javascript', body:fixture });
          const mapAsset = /^(?:(?:t\d+|s\d+)\.(?:daumcdn|kakaocdn)\.net|(?:maps?\d*|mts\d*|maptile|st\d+)\.(?:daumcdn\.net|kakaocdn\.net|kakao\.com|daum\.net))$/.test(url.hostname);
          if (sdk === 'live-sdk' && get && (sdkLoader || mapAsset)) return route.continue();
          if (/kakao|daum/.test(url.hostname)) rejectedSdkAssets.add(url.hostname + ' ' + request.resourceType());
          return route.abort();
        }
        if (endpoint === roots[mode] + '/view') reqs.view++;
        if (endpoint === roots.postal + '/geometry') reqs.tile++;
        if (endpoint === roots.h3 + '/view') reqs.h3++;
        if (endpoint === roots.postal + '/point') reqs.inspected++;
        if (request.method() === 'POST' && !url.pathname.endsWith('/auth/login') && !url.pathname.endsWith('/auth/logout')) {
          reqs.posted++;
        }
        try {
          const response = await route.fetch({ url:port.url + url.pathname + url.search, headers:await request.allHeaders(),
            maxRedirects:0, timeout:18000 });
          const head = response.headers();
          // Playwright's fixture forwarder exposes decompressed bodies.
          if (head['content-encoding'] && endpoint === roots.postal + '/geometry') {
            delete head['content-encoding'];
            delete head['content-length'];
            await route.fulfill({ status:response.status(), headers:head, body:await response.body() });
          } else await route.fulfill({ response });
        } catch { await route.abort().catch(() => {}); }
      });
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      const heap = async () => {
        await cdp.send('HeapProfiler.collectGarbage');
        const { usedSize, totalSize } = await cdp.send('Runtime.getHeapUsage');
        return { usedMiB:+(usedSize / 1048576).toFixed(2), totalMiB:+(totalSize / 1048576).toFixed(2) };
      };
      step = width + 'px full staff login';
      await page.goto(origin + '/opsmap/', { waitUntil:'domcontentloaded' });
      await page.locator('#mapStaffEntry input[name=username]').fill(staffId);
      await page.locator('#mapStaffEntry input[name=password]').fill(port.password);
      await page.locator('#mapStaffEntry button[type=submit]').click();
      await page.waitForFunction(() => document.body.dataset.mapStaffState === 'authenticated');
      const snapshot = await page.evaluate(async p => {
        const response = await fetch(p + '?scope=general');
        const body = await response.json();
        return { status:response.status, count:Array.isArray(body.data) ? body.data.length : 0 };
      }, privateSnapshot);
      assert.deepEqual(snapshot, { status:200,count:6043 });
      step = width + 'px Kakao SDK';
      const nativeSdk = await page.evaluate(async () => {
        let maps;
        try { maps = (await window.KakaoMapsAdapter.ready()).maps; }
        catch { return 'MAP_SDK_UNAVAILABLE'; }
        maps.Map = new Proxy(maps.Map, { construct(Target, args, next) {
          const result = Reflect.construct(Target, args, next);
          if (args[0]?.id === 'coverageMap') window.__postalTestMap = result;
          return result;
        }});
        return null;
      });
      if (nativeSdk) {
        await writeFile(path.join(output, mode + '-' + sdk + '-sdk-diagnostic.json'), JSON.stringify({ code:nativeSdk, sdkStatuses,
          loaded:[...sdkAssets], rejected:[...rejectedSdkAssets], failures:[...sdkFailures] }));
        throw Error(nativeSdk);
      }
      if (baseMap) await page.evaluate(outlines => {
        const maps = window.kakao.maps;
        const MapControl = maps.Map;
        const data = outlines.features;
        if (!Array.isArray(data)) return;
        maps.Map = new Proxy(MapControl,{ construct(Target, args, next) {
          const map = Reflect.construct(Target,args,next);
          if (args[0]?.id !== 'coverageMap' || !map.layer) return map;
          const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
          svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:-1';
          map.layer.prepend(svg);
          const baseSetBounds = map.setBounds;
          map.setBounds = function(bounds){
            baseSetBounds.call(this,bounds);
            const length = Math.max((bounds.ne.lng-bounds.sw.lng)/Math.max(this.element.clientWidth-56,120),
              (bounds.ne.lat-bounds.sw.lat)/Math.max(this.element.clientHeight-56,120),.00001);
            this.setLevel(Math.min(13, Math.max(1, Math.ceil(Math.log2(length*170000)))));
          };
          const render = () => {
            const ns = svg.namespaceURI;
            const path = document.createElementNS(ns,'path');
            const groups = data.flatMap(item => item.rings || item);
            path.setAttribute('d',groups.filter(ring => Array.isArray(ring[0]) && typeof ring[0][0] === 'number')
              .map(ring => 'M'+ring.map(([x,y]) => { const p=map.project(new maps.LatLng(y,x)); return p.x.toFixed(1)+','+p.y.toFixed(1); }).join('L')+'Z').join(''));
            path.setAttribute('stroke','#bac6d0'); path.setAttribute('fill','#eef0e8'); path.setAttribute('fill-rule','evenodd');
            svg.replaceChildren(path);
          };
          maps.event.addListener(map,'idle',render);
          render();
          return map;
        }});
      }, baseMap);

      const scopes = {
        nation:[124.1,32.95,131.95,38.8],
        region:[126.67,36.96,127.29,37.40],
        detail:[127.043,37.135,127.101,37.165],
      };
      const viewResponse = response => {
        return pathnameOf(response.url()) === roots[mode] + '/view' && response.ok();
      };
      const drawCount = () => page.evaluate(() => Number(JSON.parse(document.getElementById('coverageMap')?.dataset.postalDraw || '{}').count || 0));
      async function settled(before, level) {
        if (mode === 'postal') {
          await page.waitForFunction(({ before, level }) => {
            const record = JSON.parse(document.getElementById('coverageMap').dataset.postalDraw || '{}');
            return record.count > before && record.shown > 0 && (level == null || record.level === level);
          }, { before, level });
        } else await page.locator(shapes).first().waitFor({ state:'attached' });
        await page.evaluate(nextPaint);
      }
      async function fit(name) {
        const before = await drawCount(), response = page.waitForResponse(viewResponse);
        const began = performance.now();
        if (mode === 'postal' && name !== 'detail') await page.locator('[data-preset="' + name + '"]').click();
        else await page.evaluate(box => {
          const { LatLng, LatLngBounds } = kakao.maps;
          window.__postalTestMap.setBounds(new LatLngBounds(new LatLng(box[1],box[0]),new LatLng(box[3],box[2])),28);
          kakao.maps.event.trigger(window.__postalTestMap,'idle');
        }, scopes[name]);
        await response;
        await settled(before);
        return +(performance.now() - began).toFixed(2);
      }
      step = width + 'px first map';
      const initial = page.waitForResponse(viewResponse), initialStart = performance.now();
      await page.getByRole('button', { name:'음영권역', exact:true }).click();
      await initial;
      await settled(0);
      const firstMs = +(performance.now() - initialStart).toFixed(2);
      if (mode === 'h3') await fit('nation');
      const pc = phone ? 'mobile' : 'pc';
      const data = { width, snapshot:6043, firstMs, requests:reqs, sdkStatuses, scenes:[] };
      for (const name of ['nation','region','detail']) {
        step = width + 'px ' + name;
        const latency = name === 'nation' ? firstMs : await fit(name);
        if (name === 'detail' && mode === 'postal') {
          const waiting = page.waitForResponse(response => pathnameOf(response.url()) === roots.postal + '/point' && response.status() === 200);
          const box = await page.locator('#coverageMap').boundingBox();
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          const detail = (await (await waiting).json()).data;
          assert.equal(detail.state,'MATCHED');
          assert.match(detail.area.id, /^\d{5}$/);
          assert.equal(detail.area.status, detail.area.visits ? (detail.area.density >= 100 ? 'HIGH' : 'LOW') :
            (detail.area.registered ? detail.area.status : 'UNKNOWN'));
          const card = page.locator('#coverageDetail[data-postal-code="' + detail.area.id + '"]');
          await card.waitFor({ state:'visible' });
          assert.match(await card.innerText(), new RegExp(detail.area.id));
          data.selected = { id:detail.area.id, tone:detail.area.status, visits:detail.area.visits, density:detail.area.density };
        }
        const draw = await page.evaluate(() => JSON.parse(document.getElementById('coverageMap').dataset.postalDraw || '{}'));
        const result = { name, latency, draw, cssWidth:width };
        if (mode === 'postal') {
          assert.equal(draw.tier, { nation:'national', region:'regional', detail:'detail' }[name], 'each actual viewport uses the intended boundary detail');
          const file = mode + '-' + pc + '-' + name + '.png';
          await page.screenshot({ path:path.join(output,file), animations:'disabled' });
          result.screenshot = file;
        }
        data.scenes.push(result);
      }

      step = width + 'px repeated zoom and DevTools';
      await fit('region');
      const baselineHeap = await heap();
      const previousLevel = await page.evaluate(() => window.__postalTestMap.getLevel());
      await page.evaluate(() => {
        const frames = [];
        let previous, id;
        const work = now => { if (previous !== undefined) frames.push(now - previous); previous = now; id = requestAnimationFrame(work); };
        id = requestAnimationFrame(work);
        window.__stopPostalFrames = () => { cancelAnimationFrame(id); return frames; };
      });
      const timings = [], drawTimes = [], serverTimes = [];
      let rasterCacheHits = 0;
      const traceEvents = {};
      const events = ({ value }) => {
        for (const event of value) if (['Paint','DrawFrame','Layout','UpdateLayoutTree','FunctionCall','RunTask'].includes(event.name)) {
          const row = traceEvents[event.name] ||= { count:0, totalMs:0, maxMs:0 };
          row.count++;
          row.totalMs += (event.dur || 0) / 1000;
          row.maxMs = Math.max(row.maxMs, (event.dur || 0) / 1000);
        }
      };
      cdp.on('Tracing.dataCollected', events);
      for (let i = 0; i < 36; i++) {
        const level = i % 2 ? previousLevel : Math.max(1, previousLevel - 1);
        if (i === 0) await cdp.send('Tracing.start', { categories:'devtools.timeline,disabled-by-default-devtools.timeline.frame',
          transferMode:'ReportEvents' });
        const response = page.waitForResponse(response => viewResponse(response) && +new URL(response.url()).searchParams.get('level') === level);
        const before = await drawCount(), started = performance.now();
        await page.evaluate(level => {
          window.__postalTestMap.setLevel(level, { animate:false });
          kakao.maps.event.trigger(window.__postalTestMap,'idle');
        }, level);
        const reply = await response;
        await settled(before, level);
        const serverTiming = await reply.headerValue('server-timing');
        const serverTime = serverTiming?.match(new RegExp((mode === 'postal' ? 'postal' : 'total') + ';dur=(\\d+(?:\\.\\d+)?)'))?.[1];
        if (serverTime) serverTimes.push(Number(serverTime));
        if (mode === 'postal') {
          const draw = await page.evaluate(() => JSON.parse(document.getElementById('coverageMap').dataset.postalDraw));
          drawTimes.push(draw.drawMs);
          rasterCacheHits += Number(draw.cached);
        }
        timings.push(performance.now() - started);
        if (i === 3) {
          const traceDone = new Promise(resolve => cdp.once('Tracing.tracingComplete',resolve));
          await cdp.send('Tracing.end');
          await traceDone;
        }
        if (i % 12 === 11) await memory();
      }
      const intervals = await page.evaluate(() => window.__stopPostalFrames());
      const elapsed = intervals.reduce((sum, value) => sum + value, 0);
      const postHeap = await heap();
      const devTools = await cdp.send('Performance.getMetrics');
      data.performance = { zooms:timings.length, endToEndP50Ms:quantile(timings,.50), endToEndP95Ms:quantile(timings,.95),
        backendP95Ms:serverTimes.length ? quantile(serverTimes,.95) : null,
        canvasP95Ms:drawTimes.length ? quantile(drawTimes,.95) : null, fps:+(intervals.length * 1000 / elapsed).toFixed(2),
        frameP95Ms:quantile(intervals,.95), beforeGC:baselineHeap, afterGC:postHeap, traceEvents, rasterCacheHits,
        layoutCount:devTools.metrics.find(row => row.name === 'LayoutCount')?.value };
      assert.equal(timings.length,36);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);

      if (mode === 'postal') {
        step = width + 'px period, center, search and rollback isolation';
        const view = () => page.evaluate(() => JSON.parse(document.getElementById('shadowCoverage').dataset.postalView || '{}'));
        const publishedStores = page.locator('[data-postal-kpi="registered"]');
        assert.equal(await page.locator('#postalOverview dt').first().innerText(), '게시본 등록 매장');
        assert.match(await page.locator('#postalRegistryScope').innerText(), /최신 전체 등록 현황은 확인이 필요합니다/);
        const numbers = [];
        for (const days of [30,60,90]) {
          await page.locator('#coverageDays').selectOption(String(days));
          await page.waitForFunction(days => JSON.parse(document.getElementById('shadowCoverage').dataset.postalView || '{}').days === days, days);
          const v = await view();
          assert.equal(v.registered,6043);
          assert.equal(await publishedStores.innerText(), '6,043');
          assert.equal(v.visits,audit.periods[days].located);
          assert.deepEqual([v.observed,v.missing,v.active,v.unknown,v.held],
            [audit.periods[days].observedOsan,audit.periods[days].missing,audit.periods[days].new,audit.periods[days].newUnknown,6]);
          assert.equal(v.high + v.low + v.candidate + v.unknownAreas, 34525);
          numbers.push(v);
        }
        data.periods = numbers;
        await page.locator('#coverageCenter').selectOption('honam');
        await page.waitForFunction(() => JSON.parse(document.getElementById('shadowCoverage').dataset.postalView || '{}').center === 'honam');
        let v = await view();
        assert.equal(v.observed,0);
        assert.equal(v.unknownAreas,34525);
        assert.equal(await publishedStores.innerText(), v.registered.toLocaleString('ko-KR'));
        await page.locator('#coverageCenter').selectOption('all');
        await page.waitForFunction(() => JSON.parse(document.getElementById('shadowCoverage').dataset.postalView || '{}').center === 'all');
        const searchBox = page.locator('#coverageQuery');
        for (const needle of [data.selected.id, port.sample.code, port.sample.address]) {
          await searchBox.fill(needle);
          const result = page.waitForResponse(response => pathnameOf(response.url()) === roots.postal + '/search' && response.ok());
          await page.locator('#coverageSearch button').click();
          const json = await (await result).json();
          assert.ok(json.data.length > 0, 'registry and postal search preserved');
          await page.locator('#coverageSearchResults button').first().waitFor();
        }
        assert.equal(reqs.h3,0);
        assert(reqs.tile > 0);
        await page.getByRole('button',{name:'매장·권역 지도',exact:true}).filter({visible:true}).click();
        assert(await page.locator('main.workspace').isVisible());
        assert.equal(await page.locator('#coverageMap canvas.postal-map-overlay').count(),1);
        const afterClose = await heap();
        data.afterCloseHeapMiB = afterClose.usedMiB;
        assert.equal(await page.locator('#coverageDetail').count(), 1);
        assert.equal(await page.locator('#coverageDetail').isHidden(), true);
      }
      assert.equal(pageErrorCount, 0, 'Unexpected page errors');
      data.mapAssets = [...sdkAssets];
      data.rejectedSdkAssets = [...rejectedSdkAssets];
      data.sdkFailures = [...sdkFailures];
      report.browser.push(data);
      await memory();
      await context.close();
      console.log(JSON.stringify({ format:mode, width, zooms:data.performance.zooms,
        fps:data.performance.fps, p95:data.performance.endToEndP95Ms,
        heapMiB:data.performance.afterGC.usedMiB, sdkStatuses:data.sdkStatuses }));
    }
    await memory();
    report.peakRssMiB = Math.max(...report.server.map(item => item.peakRss));
    assert(report.peakRssMiB < 512);
    assert(report.server.every(item => item.rejectedRemoteCalls === 0));
    await writeFile(path.join(output, mode + '-' + sdk + '-full-service.json'), JSON.stringify(report,null,2));
    console.log(mode + ' ' + sdk + ' PASS, full service peak RSS ' + report.peakRssMiB + ' MiB');
  } catch {
    console.error(JSON.stringify({ error:'POSTAL_BROWSER_TEST_FAILED', step, responseStatuses }));
    process.exitCode = 1;
  } finally {
    await browser?.close();
    if (child.exitCode === null) { child.kill(); await ended; }
  }
}
if (mode.startsWith('server-')) await runServer(mode.slice(7));
else await runBrowser();
