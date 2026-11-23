import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const sdk = await readFile(new URL('./fixtures/shadow-coverage-kakao.js', import.meta.url), 'utf8');
const origin = 'http://127.0.0.1:44711';
const postalCode = '06241';
const errors = [];
const rosterReads = [];
let generation = 'before-switch';
let searchReads = 0;
const period = { days:90, start:'2026-08-10', end:'2026-11-07' };
const location = [37.497, 127.029];
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
    if (endpoint === 'recent-operations') {
      return route.fulfill({json:{
        ok:true,days:90,startDate:'2026-08-26',endDate:'2026-11-23',publishedThrough:'2026-11-23',
        centers:Object.fromEntries(['osan','yeongnam','honam'].map(center=>[center,{confirmedDays:[],calendar:[]}]))
      }});
    }
    let data;
    if (endpoint === 'view') {
      data = {
        period, generation, completeness:{ observed:76, missing:[], sourceMissing:[], centerObserved:{}, unverified:[] },
        summary:{ recorded:1 }, source:{ label:'fixture', url:'#' }, candidates:[], tiles:[], tones:[], badges:[],
      };
    } else if (endpoint === 'search') {
      searchReads++;
      data = [{ id:postalCode, name:postalCode, kind:'area', location }];
    } else if (endpoint === 'stores') {
      rosterReads.push([url.searchParams.get('area'), url.searchParams.get('generation')]);
      data = {
        area:postalCode, name:generation, period, filteredCount:0, offset:0, next:null, rows:[], totals:{},
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
  assert.match(await page.locator('#postalPeriod').innerText(),/지도 색상·구역 집계 기준.*2026-11-07/);
  await page.locator('#recentOperationWindow summary').click();
  await page.getByText(/운영이력 원장 기준 2026-11-23/).waitFor();
  assert.match(await page.locator('#postalPeriod').innerText(),/2026-11-07/);
  await page.locator('#coverageQuery').fill(postalCode);
  await page.locator('#coverageQuery').press('Enter');
  await page.getByText(generation, { exact:true }).waitFor();

  await page.evaluate(() => window.coverageFixture.close());
  assert.equal(await page.locator('#coverageQuery').inputValue(), '');
  assert.equal(await page.locator('#coverageDetail').getAttribute('data-postal-code'), null);
  assert.equal(await page.locator('#postalStoreList').innerText(), '');

  generation = 'after-switch';
  await page.evaluate(() => {
    window.coverageFixture.open();
    window.coverageFixture.close();
    window.coverageFixture.open();
  });
  await page.getByText(generation, { exact:true }).waitFor();
  assert.equal(await page.locator('#coverageQuery').inputValue(), postalCode);
  assert.deepEqual(rosterReads.at(-1), [postalCode, generation]);
  assert.equal(searchReads, 1);

  await page.evaluate(() => {
    window.coverageFixture.close();
    window.coverageFixture.disposeMap();
    window.coverageFixture.open();
  });
  await page.locator('#shadowCoverage[data-postal-view]').waitFor();
  assert.equal(await page.locator('#coverageQuery').inputValue(), '');
  assert.equal(await page.locator('#coverageDetail').getAttribute('data-postal-code'), null);
  assert.deepEqual(errors, []);
  console.log('Postal tab restores the selected area from the current generation and clears it on disposal.');
} finally {
  await browser.close();
}
