import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createStageOperationalPhotoExtension} from '../src/opsmapStagePhotos.js';

const api = '/api/map-phase2b/private/delivery-photos';
const code = 'S990001', date = '2026-11-04', deliveryId = '990001';
const query = '?customerCode=' + code + '&date=' + date;
const exact = api + query + '&deliveryId=' + deliveryId;
const task = {id:deliveryId, customer:{erpCode:code}, carrier:{enteringDatedAt:date + 'T00:00:00+09:00'}};
const labels = ['냉장고 문은 잘 닫았나요?', '매장 출입문은 잘 잠궜나요?', '상품을 잘 적치하셨나요? - 매장 문 앞'];
const mediaHost = 'static.chabyulhwa.com';
const payload = (content, totalElements = content.length) => Response.json({data:{content, totalElements, totalPages:totalElements ? 1 : 0}});
const staffSession = () => ({key:'first', expiresAt:Date.now() + 60000, idleExpiresAt:Date.now() + 60000});

async function fixture({enabled = true, cookie = true, sourceStatus, mediaStatus, discovery, attachmentRows, statusByPath = {}, mediaNetworkError = false} = {}) {
  const app = express(), calls = [];
  let staff = true, sourceHttp = sourceStatus;
  const extension = createStageOperationalPhotoExtension({
    env:{...(enabled ? {} : {OPSMAP_STAGE_DELIVERY_PHOTOS_ENABLED:'0'}), ...(cookie ? {OPSMAP_STAGE_DELIVERY_PHOTO_COOKIE:'fixture=session'} : {})},
    defaultDate:() => date,
    fetchImpl:async (input, options) => {
      const url = new URL(input);
      calls.push({origin:url.origin, path:url.pathname});
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      if (url.hostname === mediaHost) {
        assert.equal(options.credentials, 'omit');
        assert.equal(options.headers.Cookie, undefined);
        if (mediaNetworkError) throw Error('upstream private url');
        if (mediaStatus) return new Response(null, {status:mediaStatus});
        return new Response('image fixture', {headers:{'content-type':'image/png'}});
      }
      assert.equal(url.origin, 'https://delivery-bali.chabyulhwa.com');
      assert.equal(options.headers.Cookie, 'fixture=session');
      if (sourceHttp) return new Response(null, {status:sourceHttp});
      if (statusByPath[url.pathname]) return new Response(null, {status:statusByPath[url.pathname]});
      if (url.pathname === '/api/bali/task') {
        assert.equal(url.searchParams.get('customerErpCodeLike'), code);
        assert.equal(url.searchParams.get('pageSize'), '50');
        assert.equal(url.searchParams.get('page'), '0');
        assert.deepEqual(url.searchParams.getAll('enteringDatedAtBetween'), Array(2).fill(date + 'T00:00:00+09:00'));
        return discovery?.() ?? payload([task, {...task, id:'990002', customer:{erpCode:code+'0'}}]);
      }
      if (url.pathname === '/api/bali/task/' + deliveryId) return Response.json({data:task});
      assert.equal(url.pathname, '/api/bali/task/' + deliveryId + '/status-record');
      const images = index => [{url:'https://' + mediaHost + '/' + index + '.png?token=fixture'}];
      return Response.json({data:attachmentRows ?? [
        {id:'1234', taskId:deliveryId, status:'COMPLETED', completeTypeText:'매장문앞',
          taskAttachments:labels.map((typeText, index) => ({typeText, images:images(index)}))}
      ]});
    }
  });
  extension.mount({app,
    requireStaff(req, res, next) {
      if (!staff || req.get('x-staff') !== 'first') return res.status(401).end();
      res.locals.staffSession = staffSession();
      return next();
    },
    isSessionCurrent:(req, key) => staff && req.get('x-staff') === key,
    previewEnabled:() => true
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  return {
    calls, async get(path, staff = 'first') { return fetch(url + path, {headers:{'x-staff':staff}}); },
    setStatus(status) { sourceHttp = status; }, logout() { staff = false; },
    close:() => new Promise(resolve => server.close(resolve))
  };
}

test('Stage scopes task discovery, validates all three categories, and gates session-bound opaque media', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get(api + '/config', 'anonymous')).status, 401);
    const config = await f.get(api + '/config');
    assert.match(config.headers.get('cache-control'), /no-store/);
    assert.deepEqual((await config.json()).data, {
      enabled:true, cookieConfigured:true, sourceSession:false, sourceAuth:'NOT_VERIFIED', metadataConfigured:true
    });
    assert.equal(f.calls.length, 0);
    const discovery = await (await f.get(api + query)).json();
    assert.deepEqual(discovery.data.deliveries.map(row => row.deliveryId), [deliveryId]);
    assert.equal((await (await f.get(api + '/config')).json()).data.sourceAuth, 'VERIFIED');
    const detail = await f.get(exact);
    assert.equal(detail.status, 200);
    const raw = await detail.text();
    assert(!raw.includes('fixture'));
    assert(!raw.includes(mediaHost));
    const [row] = JSON.parse(raw).data.deliveries;
    assert.equal(row.status, 'READY');
    assert.deepEqual(row.photos.map(photo => photo.kind), ['REFRIGERATOR_DOOR', 'ENTRANCE_LOCK', 'FRONT_DOOR_DELIVERY']);
    assert.equal(row.photos[2].recordId, '1234');
    assert.equal(await (await f.get(row.photos[2].thumbnailUrl)).text(), 'image fixture');
    assert.equal(f.calls.length, 6);
    f.logout();
    assert.equal((await f.get(row.photos[2].url)).status, 401);
    assert.equal(f.calls.length, 6);
  } finally { await f.close(); }
});

test('Stage differentiates unavailable config, disabled mode, expiry, empty days and unverified results', async () => {
  for (const [options, status, error] of [
    [{cookie:false}, 502, 'UPSTREAM_AUTH_REQUIRED'],
    [{enabled:false}, 503, 'PHOTO_SOURCE_DISABLED'],
    [{discovery:() => Response.json({data:{content:[]}})}, 503, 'SOURCE_UNAVAILABLE'],
    [{discovery:() => payload([])}, 200, undefined]
  ]) {
    const f = await fixture(options);
    try {
      const result = await f.get(api + query);
      assert.equal(result.status, status);
      const body = await result.json();
      assert.equal(body.error?.code, error);
      if (status === 200) assert.deepEqual(body.data.deliveries, []);
      else assert.equal(body.data, undefined);
      if (options.cookie === false || options.enabled === false) assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  }
  const f = await fixture({sourceStatus:401});
  try {
    const result = await f.get(api + query);
    assert.equal(result.status, 502);
    assert.deepEqual((await result.json()).error, {code:'UPSTREAM_AUTH_REQUIRED', stage:'source-session', sourceHttpStatus:401});
    assert.equal((await (await f.get(api + '/config')).json()).data.sourceAuth, 'AUTH_REQUIRED');
    f.setStatus(null);
    assert.equal((await f.get(exact)).status, 502);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('Stage routes failed auth, task search, detail, attachments and CDN to their actual failure stage', async () => {
  for (const [pathname, url, upstream, code, stage, sourceAuth, expectedCalls] of [
    ['/api/bali/task', api + query, 401, 'UPSTREAM_AUTH_REQUIRED', 'source-session', 'AUTH_REQUIRED', 1],
    ['/api/bali/task', api + query, 503, 'PHOTO_UPSTREAM_UNAVAILABLE', 'source-task-search', 'NOT_VERIFIED', 1],
    ['/api/bali/task/' + deliveryId, exact, 404, 'PHOTO_NOT_FOUND', 'source-task-detail', 'NOT_VERIFIED', 1],
    ['/api/bali/task/' + deliveryId + '/status-record', exact, 503, 'PHOTO_UPSTREAM_UNAVAILABLE', 'source-attachments', 'VERIFIED', 2]
  ]) {
    const f = await fixture({statusByPath:{[pathname]:upstream}});
    try {
      const response = await f.get(url);
      assert.equal(response.status, upstream === 401 ? 502 : upstream);
      assert.deepEqual((await response.json()).error, {code, stage, sourceHttpStatus:upstream});
      assert.equal(f.calls.length, expectedCalls);
      assert.equal((await (await f.get(api + '/config')).json()).data.sourceAuth, sourceAuth);
    } finally { await f.close(); }
  }
  const f = await fixture({mediaNetworkError:true});
  try {
    const {data} = await (await f.get(exact)).json();
    const response = await f.get(data.deliveries[0].photos[0].url);
    assert.equal(response.status, 502);
    assert.deepEqual((await response.json()).error, {code:'PHOTO_LOOKUP_FAILED', stage:'source-media'});
    assert.equal(f.calls.at(-1).origin, 'https://' + mediaHost);
  } finally { await f.close(); }
});

test('Stage media failures preserve safe source HTTP status and remain separate from source session expiry', async () => {
  for (const [upstream, status, code] of [
    [401, 502, 'PHOTO_MEDIA_AUTH_REQUIRED'], [403, 403, 'PHOTO_FORBIDDEN'], [404, 404, 'PHOTO_NOT_FOUND'],
    [502, 502, 'PHOTO_LOOKUP_FAILED'], [503, 503, 'PHOTO_UPSTREAM_UNAVAILABLE']
  ]) {
    const f = await fixture({mediaStatus:upstream});
    try {
      const detail = await (await f.get(exact)).json();
      const result = await f.get(detail.data.deliveries[0].photos[0].url);
      assert.equal(result.status, status);
      assert.deepEqual((await result.json()).error, {code, stage:'source-media', sourceHttpStatus:upstream});
      assert.equal((await (await f.get(api + '/config')).json()).data.sourceAuth, 'VERIFIED');
    } finally { await f.close(); }
  }
});

test('Stage a verified task with no attachments is distinct from a malformed status record', async () => {
  for (const [taskAttachments, status] of [[[], 200], [null, 503]]) {
    const f = await fixture({attachmentRows:[{id:'1234', taskId:deliveryId, taskAttachments}]});
    try {
      const response = await f.get(exact);
      assert.equal(response.status, status);
      const result = await response.json();
      if (status === 200) {
        const [row] = result.data.deliveries;
        assert.equal(row.status, 'EMPTY');
        assert.deepEqual(row.photos, []);
      } else assert.equal(result.error.code, 'PHOTO_ATTACHMENTS_INVALID');
      assert.equal(f.calls.length, 2);
    } finally { await f.close(); }
  }
});
