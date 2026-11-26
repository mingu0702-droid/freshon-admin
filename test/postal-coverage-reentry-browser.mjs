import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { encodePostalZone, postalTilesLevel } from '../public/opsmap/postal-geometry.mjs';

const sdk = await readFile(new URL('./fixtures/shadow-coverage-kakao.js', import.meta.url), 'utf8');
const origin = 'http://127.0.0.1:44711';
const postalCode = '06241';
const errors = [];
const rosterReads = [];
const operationsReads = [];
const dispatchReads = [];
const viewportReads = [];
let generation = 'before-switch';
let observedDays = 76;
let searchReads = 0;
const period = { days:90, start:'2026-08-10', end:'2026-11-07' };
const location = [37.497, 127.029];
const rings = [[[127.027,37.495],[127.031,37.495],[127.031,37.499],[127.027,37.499]]];
const header = Buffer.alloc(8);
header.write('PCG1');
header.writeInt32LE(1,4);
const geometry = Buffer.concat([header,encodePostalZone({id:postalCode,bbox:[127.027,37.495,127.031,37.499]},rings)]);
let geometryReads = 0;
const browser = await chromium.launch({ channel:'chrome', headless:true });

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType:'text/html', body:
      '<header>운영지도</header><main></main><style>#coverageMap{width:650px;height:480px}</style>' });
    if (/^\/[a-z-]+\.mjs$/.test(url.pathname)) {
      return route.fulfill({ contentType:'text/javascript', body:
        await readFile(new URL('../public/opsmap' + url.pathname, import.meta.url)) });
    }
    const endpoint = url.pathname.split('/').pop();
    if (endpoint === 'geometry') {
      geometryReads++;
      return route.fulfill({body:geometry,contentType:'application/octet-stream'});
    }
    if (endpoint === 'recent-operations') {
      return route.fulfill({json:{
        ok:true,days:90,startDate:'2026-08-26',endDate:'2026-11-23',publishedThrough:'2026-11-23',
        centers:Object.fromEntries(['osan','yeongnam','honam'].map(center=>[center,{confirmedDays:[],calendar:[]}]))
      }});
    }
    let data;
    if (endpoint === 'view') {
      viewportReads.push([url.searchParams.get('level'),url.searchParams.get('box')]);
      data = {
        period, generation, stale:true, completeness:{ observed:observedDays, missing:[], sourceMissing:[], centerObserved:{}, unverified:[] },
        summary:{ recorded:observedDays ? 1 : 0 }, source:{ label:'fixture', url:'#' }, candidates:[],
        tier:postalTilesLevel(url.searchParams.get('box').split(',').map(Number)), boundary:'fixture-boundary',
        tiles:[['fixture-tile',geometry.length]], tones:[[6241,'LOW']], badges:[],
        operationsAvailable:true,dispatchDensityAvailable:true,
      };
    } else if(endpoint === 'operations') {
      const days=Number(url.searchParams.get('days')),area=url.searchParams.get('area');
      operationsReads.push([days,area]);
      const counts={registered:3,observed:2,orders:1,dispatch:1,completed:1};
      const operationPeriod={days,start:{7:'2026-11-17',30:'2026-10-25',60:'2026-09-25',90:'2026-08-26'}[days],end:'2026-11-23'};
      const scoped=area ? {counts,next:null,members:[{code:'S123',name:'검증 매장',flags:4}]} :
        {summary:{...counts,observedAreas:1,missingAreas:0},tones:[[6241,'COMPLETED']]};
      data={period:operationPeriod,publishedThrough:'2026-11-23',observedDays:Math.min(76,days),...scoped};
    } else if(endpoint === 'dispatch-density') {
      const days=Number(url.searchParams.get('days')),area=url.searchParams.get('area');
      dispatchReads.push([days,area,url.searchParams.get('registry')]);
      const registry='d'.repeat(64),dispatchPeriod={days,start:{7:'2026-11-19',30:'2026-10-27',60:'2026-09-27',90:'2026-08-28'}[days],
        end:'2026-11-25'};
      data={registry,period:dispatchPeriod,publishedThrough:'2026-11-25',observedDays:4,
        ...(area?{counts:area===postalCode?{dispatchCount:4,areaKm2:.02,density:200}:null}:
          {summary:{located:4,unlocated:2,observedScopeDays:4,missingScopeDays:days*3-4},tones:[[6241,'HIGH']]})};
    } else if (endpoint === 'search') {
      searchReads++;
      data = [{ id:postalCode, name:postalCode, kind:'area', location }];
    } else if (endpoint === 'stores') {
      rosterReads.push([url.searchParams.get('area'), url.searchParams.get('generation')]);
      data = {
        area:postalCode, name:generation, period, filteredCount:0, offset:0, next:null, stores:[], totals:{},
        source:{ missingDates:[], fixed:{}, queriedAt:'2026-11-23T00:00:00Z' },
      };
    } else {
      return route.fulfill({ status:404 });
    }
    return route.fulfill({ json:{ ok:true, data } });
  });
  await page.goto(origin);
  await page.addScriptTag({ content:sdk });
  await page.evaluate(async () => {
    const { createCoveragePanel } = await import('/postal-coverage-panel.mjs');
    window.KakaoMapsAdapter = { ready:async () => window.kakao };
    window.coverageFixture = createCoveragePanel({
      workspace:document.querySelector('main'), header:document.querySelector('header'),
    });
    window.coverageFixture.open();
  });
  await page.locator('#shadowCoverage[data-postal-view]').waitFor();
  assert.equal(await page.locator('#postalOverview').isVisible(),false);
  assert.match(await page.locator('#postalMapSource').innerText(),/배송집계 11\/07 기준 · 90일 중 76일 자료 확인/);
  assert.equal(await page.locator('#coverageMapState').isVisible(),false);
  assert.equal(await page.locator('#postalLegendArchive').isVisible(),true);
  await page.locator('#postalDataStatus > summary').click();
  assert.match(await page.locator('#postalPeriod').innerText(),/지도 색상·구역 집계 기준.*2026-11-07/);
  await page.locator('#recentOperationWindow summary').click();
  await page.getByText(/운영이력 원장 기준 2026-11-23/).waitFor();
  assert.match(await page.locator('#postalPeriod').innerText(),/2026-11-07/);
  await page.locator('#coverageQuery').fill(postalCode);
  await page.locator('#coverageQuery').press('Enter');
  await page.getByText(generation, { exact:true }).waitFor();
  const zoomed = page.waitForResponse(response => new URL(response.url()).searchParams.get('level') === '2');
  await page.getByRole('button',{name:'지도 확대'}).click();
  await zoomed;
  const viewport = viewportReads.at(-1);
  const drawAt = level => page.waitForFunction(expected =>
    JSON.parse(document.querySelector('#coverageMap').dataset.postalDraw || '{}').level === expected,level);
  await drawAt(2);
  await page.getByRole('button',{name:'지도 축소'}).click();
  await drawAt(3);
  const warmedReads = viewportReads.length;
  await page.getByRole('button',{name:'지도 확대'}).click();
  await drawAt(2);
  await page.getByRole('button',{name:'지도 축소'}).click();
  await drawAt(3);
  await page.getByRole('button',{name:'지도 확대'}).click();
  await drawAt(2);
  const drawn = await page.locator('#coverageMap').getAttribute('data-postal-draw');
  assert.ok(JSON.parse(drawn).cached,'returning to the same view reuses its Canvas raster');
  assert.equal(JSON.parse(drawn).shown,1);
  assert.equal(viewportReads.length,warmedReads,'both previously verified viewports remain in memory');
  assert.equal(geometryReads,1,'the same immutable tile is reused across viewports');
  const firstRosterCount = rosterReads.length;

  await page.evaluate(() => window.coverageFixture.close());
  assert.equal(await page.locator('#shadowCoverage').isVisible(), false);
  const revalidated = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/view'));
  await page.evaluate(() => window.coverageFixture.open());
  await revalidated;
  assert.equal(await page.locator('#coverageQuery').inputValue(), postalCode);
  assert.equal(await page.locator('#coverageSearchResults button').count(), 1);
  assert.equal(await page.locator('#coverageDetail').getAttribute('data-postal-code'), postalCode);
  assert.equal(rosterReads.length, firstRosterCount);
  assert.equal(searchReads, 1);
  assert.deepEqual(viewportReads.at(-1), viewport);

  generation = 'after-switch';
  await page.evaluate(() => {
    window.coverageFixture.close();
    window.coverageFixture.invalidate();
  });
  assert.equal(await page.locator('#coverageDetail').getAttribute('data-postal-code'), null);
  assert.equal(await page.locator('#postalStoreList').textContent(), '');
  assert.equal(await page.locator('#coverageSearchResults button').count(), 0);
  await page.evaluate(() => {
    window.coverageFixture.open();
    window.coverageFixture.close();
    window.coverageFixture.open();
  });
  await page.getByText(generation, { exact:true }).waitFor();
  await page.locator('#coverageSearchResults button').waitFor();
  assert.equal(await page.locator('#coverageQuery').inputValue(), postalCode);
  assert.deepEqual(rosterReads.at(-1), [postalCode, generation]);
  assert.equal(searchReads, 2);
  assert.deepEqual(viewportReads.at(-1), viewport);

  generation = 'live-refresh';
  await page.evaluate(() => window.coverageFixture.invalidate());
  await page.getByText(generation, { exact:true }).waitFor();
  assert.deepEqual(rosterReads.at(-1), [postalCode, generation]);

  await page.locator('#postalLayer').selectOption('operations');
  await page.locator('#postalOperationsSummary').getByText('운영이력 원장 기준 2026-11-23',{exact:true}).waitFor();
  assert.equal(await page.locator('#postalLegendArchive').isVisible(),false);
  assert.equal(await page.locator('#postalLegendOperations').isVisible(),true);
  assert.match(await page.locator('#postalMapSource').innerText(),/운영이력 11\/23 기준/);
  for (const value of ['7','30','60','90']) {
    await page.locator('#coverageDays').selectOption(value);
    await page.locator('#postalOperationsSummary').getByText(new RegExp('^'+value+'일 · .*2026-11-23$')).waitFor();
    await page.locator('#postalOperationsDetail').getByRole('button',{name:'검증 매장 · S123'}).waitFor();
    assert.deepEqual(operationsReads.findLast(([,area])=>area),[Number(value),postalCode]);
  }
  assert.equal(await page.locator('#postalArchive').isVisible(),false);
  await page.locator('#postalLayer').selectOption('dispatch-density');
  await page.locator('#postalLegendDispatch').getByText('배차 밀도 높음').waitFor();
  assert.equal(await page.locator('#postalLegendOperations').isVisible(),false);
  for (const value of ['7','30','60','90']) {
    await page.locator('#coverageDays').selectOption(value);
    await page.locator('#postalOperationsSummary').getByText(new RegExp('^'+value+'일 · .*2026-11-25$')).waitFor();
    await page.locator('#postalOperationsDetail').getByText(/좌표 연결 배차 4건 · 200건\/km²/).waitFor();
    assert.deepEqual(dispatchReads.findLast(([,area])=>area),[Number(value),postalCode,'d'.repeat(64)]);
  }
  await page.evaluate(() => {
    window.coverageFixture.close();
    window.coverageFixture.open();
  });
  assert.equal(await page.locator('#postalLayer').inputValue(),'dispatch-density');
  assert.equal(await page.locator('#coverageDays').inputValue(),'90');
  await page.locator('#postalOperationsDetail').getByText(/좌표 연결 배차 4건/).waitFor();
  assert.match(await page.locator('#postalMapSource').innerText(),/배차집계 11\/25 기준/);
  await page.locator('#postalLayer').selectOption('archive');
  await page.locator('#postalPeriod').getByText(/2026-11-07/).waitFor();
  await page.getByText(generation, { exact:true }).waitFor();

  generation = 'no-observations';
  observedDays = 0;
  await page.evaluate(() => window.coverageFixture.invalidate());
  await page.locator('#coverageMapMessage').getByText('선택 범위의 배송 자료 미확인',{exact:true}).waitFor();
  assert.match(await page.locator('#postalMapSource').innerText(),/배송집계 11\/07 기준 · 90일 중 0일 자료 확인/);
  await page.evaluate(() => {
    window.coverageFixture.close();
    window.coverageFixture.disposeMap();
    window.coverageFixture.open();
  });
  await page.locator('#shadowCoverage[data-postal-view]').waitFor();
  assert.equal(await page.locator('#coverageQuery').inputValue(), '');
  assert.equal(await page.locator('#coverageDetail').getAttribute('data-postal-code'), null);
  assert.equal(await page.locator('#postalAreaTitle').textContent(), '');
  assert.equal(await page.locator('#coverageSearchResults button').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Postal tab restores the selected area from the current generation and clears it on disposal.');
} finally {
  await browser.close();
}
