import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
import {createOperationalPhotoExtension} from '../src/opsmapOperationalPhotos.js';

const customerCode = 'S990001', path = '/api/map-phase2b/private/delivery-photos/history';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5N0AAAAASUVORK5CYII=', 'base64');
const label = '상품을 잘 적치하셨나요? - 매장 문 앞';
const deliveryDay = daysAgo => new Date(Date.now() + 9 * 3600000 - daysAgo * 86400000).toISOString().slice(0, 10);
const task = (id, daysAgo, code = customerCode) => ({id, status:'COMPLETED', statusText:'배송완료',
  completeType:'FRONT_DOOR', completeTypeText:'매장문앞', customer:{erpCode:code},
  carrier:{enteringDatedAt:deliveryDay(daysAgo) + 'T00:00:00+09:00'}});
const attachment = (typeText, name) => ({typeText, images:[{url:`https://static.chabyulhwa.com/${name}.png?secret=private`}]});

async function fixture({upstreamSession = true, prepareHistorySession = false} = {}) {
  const app = express(), expiresAt = Date.now() + 60000;
  let active = true, mutate = false, imageReads = 0, sessionPreparations = 0;
  const requests = [];
  const rows = [task('10', 3), task('200', 1), task('201', 1), task('300', 2),
    task('400', 1, 'S9900010'), {...task('500', 1), status:'BEFORE'}, {...task('600', 1), completeType:'BASIC'}];
  const requireStaff = (req, res, next) => {
    if (!active || !['first', 'second'].includes(req.get('x-staff'))) return res.status(401).end();
    res.locals.staffSession = {key:req.get('x-staff'), expiresAt, idleExpiresAt:expiresAt};
    return next();
  };
  createOperationalPhotoExtension({enabled:true, prepareHistorySession, hasMemorySession:() => upstreamSession,
    prepareSession:() => { sessionPreparations++; upstreamSession=true; },
    rawRequest:async (resource, options) => {
      requests.push(resource);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      if (resource.startsWith('/api/bali/task?')) {
        const query = new URL(resource, 'https://example.test').searchParams;
        assert.equal(query.get('customerErpCodeLike'), customerCode);
        assert.equal(query.get('statusIn'), 'COMPLETED');
        assert.equal(query.get('completeTypeIn'), 'FRONT_DOOR');
        assert.equal(query.get('page'), '0');
        assert.equal(query.get('pageSize'), '50');
        assert.equal(query.getAll('enteringDatedAtBetween').length, 2);
        return Response.json({content:rows, last:true});
      }
      const id = resource.split('/')[4], row = rows.find(item => item.id === id);
      if (!resource.endsWith('/status-record')) return Response.json({data:id === '300' ? task(id, 2, 'S990002') : row});
      const genuine = attachment(label, 'delivery-' + id);
      const base = {id:'11' + id, taskId:id, status:'COMPLETED', completeTypeText:'매장문앞'};
      return Response.json({data:[
        {...base, id:'999' + id, status:'BEFORE', taskAttachments:[genuine]},
        {...base, id:'888' + id, completeTypeText:'매장안', taskAttachments:[genuine]},
        {...base, ...(mutate ? {status:'FAILED'} : {}), taskAttachments:[attachment('매장 출입문은 잘 잠궜나요?', 'lock'),
          attachment('냉장고 문은 잘 닫았나요?', 'fridge'), attachment(label + ' ', 'near-label'), ...(id === '200' ? [] : [genuine])]}
      ]});
    },
    imageFetch:async (url, options) => {
      imageReads++;
      assert.match(url, /^https:\/\/static\.chabyulhwa\.com\/delivery-(201|10)\.png\?/);
      assert.equal(options.credentials, 'omit');
      return new Response(png, {headers:{'content-type':'image/png'}});
    }
  }).mount({app, requireStaff, isSessionCurrent:(req, key) => active && req.get('x-staff') === key, previewEnabled:() => true});
  app.get('/api/map-phase2b/auth/session', requireStaff, (_q, r) => r.json({authenticated:true, expiresAt, idleExpiresAt:expiresAt}));
  app.use(express.static(fileURLToPath(new URL('../public/opsmap', import.meta.url))));
  app.get('/', (_q, r) => r.type('html').send(`<meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/opsmap-delivery-photos.css">
    <section id="detailSection" class="open"><div id="detail"><div class="detailBody"></div></div></section>
    <script>window.MapUiLocalBridge={state:{selected:{customerCode:'${customerCode}',lastDeliveryDate:'2000-02-01'},selectedDate:'2000-01-01',mode:'DATE_ROUTE'}}</script>
    <script src="/opsmap-delivery-photos.js"></script>`));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  return {origin, requests, imageReads:() => imageReads, sessionPreparations:() => sessionPreparations,
    request:(resource, staff = 'first') => fetch(origin + resource, {headers:{'x-staff':staff}}),
    mutate:() => { mutate = true; }, logout:() => { active = false; }, close:() => new Promise(resolve => server.close(resolve))};
}

test('history checks customer, date, task state, attachment label, and source record again when opening media', async () => {
  const f = await fixture();
  try {
    const search = path + '?customerCode=' + customerCode;
    assert.equal((await f.request(search, 'anonymous')).status, 401);
    assert.equal((await f.request(search + '&date=' + deliveryDay(1))).status, 400);
    assert.equal(f.requests.length, 0);
    const response = await f.request(search), payload = await response.json();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(payload.data.coverage, 'INCOMPLETE');
    const deliveries = payload.data.deliveries;
    assert.deepEqual(deliveries.map(row => [row.date, row.deliveryId, row.photos.map(photo => [photo.kind, photo.recordId])]), [
      [deliveryDay(1), '201', [['FRONT_DOOR_DELIVERY', '11201']]],
      [deliveryDay(3), '10', [['FRONT_DOOR_DELIVERY', '1110']]]
    ]);
    assert(!f.requests.some(resource => /\/(?:400|500|600)(?:\/|$)|\/300\/status-record/.test(resource)));
    assert(!JSON.stringify(payload).includes('secret='));
    assert(!JSON.stringify(payload).includes('chabyulhwa'));
    const media = deliveries[0].photos[0].url;
    assert.equal((await f.request(media, 'second')).status, 404);
    const image = await f.request(media);
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    assert.equal(f.imageReads(), 1);
    f.mutate();
    assert.equal((await f.request(media)).status, 404);
    assert.equal(f.imageReads(), 1);
    f.logout();
    assert.equal((await f.request(media)).status, 401);
  } finally { await f.close(); }
});

test('a missing upstream session returns its safe error without logging in or reading the source', async () => {
  const f = await fixture({upstreamSession:false});
  try {
    const response = await f.request(path + '?customerCode=' + customerCode);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {ok:false, error:{code:'UPSTREAM_AUTH_REQUIRED', stage:'source-session'}});
    assert.equal(f.requests.length, 0);
    assert.equal(f.sessionPreparations(), 0);
  } finally { await f.close(); }
});

test('the Production history option prepares the existing source only after staff and query validation', async () => {
  const f = await fixture({upstreamSession:false, prepareHistorySession:true});
  const query = path + '?customerCode=' + customerCode;
  try {
    assert.equal((await f.request(query, 'anonymous')).status, 401);
    assert.equal((await f.request(query + '&date=2026-11-01')).status, 400);
    assert.equal(f.sessionPreparations(), 0);
    assert.equal(f.requests.length, 0);
    const response = await f.request(query);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.deliveries.length, 2);
    assert.equal(f.sessionPreparations(), 1);
  } finally { await f.close(); }
});

test('map selection opens photo history independent of the date filter and shows original record IDs in the viewer', async () => {
  const f = await fixture();
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    for (const width of [1366, 390]) {
      const page = await browser.newPage({viewport:{width, height:850}, extraHTTPHeaders:{'x-staff':'first'}});
      await page.route('**/*', route => new URL(route.request().url()).origin === f.origin ? route.continue() : route.abort());
      try {
        await page.goto(f.origin);
        const awaited = page.waitForRequest(request => request.url().includes('/history?'));
        await page.getByRole('button', {name:'과거 사진 조회'}).click();
        assert.equal(new URL((await awaited).url()).search, '?customerCode=' + customerCode);
        await page.getByText('과거 기록 확인 필요', {exact:true}).waitFor();
        const records = page.getByRole('button', {name:/원본 기록 ID/});
        assert.deepEqual(await records.allTextContents(), ['원본 기록 ID 11201 · 사진 확대', '원본 기록 ID 1110 · 사진 확대']);
        const before = f.imageReads();
        await page.getByRole('button', {name:'썸네일 표시'}).first().click();
        await page.getByRole('img', {name:'매장 문 앞 납품 사진 썸네일'}).waitFor();
        assert.equal(f.imageReads(), before + 1);
        await records.first().click();
        await page.getByRole('img', {name:'매장 문 앞 납품 사진 확대 사진'}).waitFor();
        assert.equal(f.imageReads(), before + 1);
        assert.match(await page.getByRole('dialog').innerText(), new RegExp(deliveryDay(1) + ' · 배송 ID 201 · 원본 기록 ID 11201'));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.getByRole('dialog').isVisible(), false);
        await records.last().click();
        await page.getByRole('img', {name:'매장 문 앞 납품 사진 확대 사진'}).waitFor();
        assert.equal(f.imageReads(), before + 2);
        await page.keyboard.press('Escape');
        await records.last().click();
        await page.getByRole('img', {name:'매장 문 앞 납품 사진 확대 사진'}).waitFor();
        assert.equal(f.imageReads(), before + 3);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await f.close(); }
});
