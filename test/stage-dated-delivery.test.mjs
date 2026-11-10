import assert from 'node:assert/strict';
import test from 'node:test';
import {createStageDatedDeliveryReader} from '../src/stageDatedDelivery.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from '../src/stageAbValidation.js';
import {createStageVerificationApp} from '../src/stageVerificationEntry.js';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';

const date = '2026-05-16';
const env = {RENDER_EXTERNAL_URL:STAGE_ORIGIN, RENDER_SERVICE_ID:STAGE_SERVICE,
  OPSMAP_STAGE_DELIVERY_DATED_ENABLED:'1', OPSMAP_STAGE_DELIVERY_DATED_COOKIE:'synthetic=fixture'};
const tasks = Array.from({length:301}, (_, i) => ({id:i + 1, enteringDatedAt:`${date}T00:00:00+09:00`,
  customer:{erpCode:`S${i+1}`, name:'fixture'}, carrier:{fixedNo:['101호','122','202'][i%3]}, status:'COMPLETED'}));
const response = (content, totalElements = tasks.length, totalPages = 2) => Response.json({content,totalElements,totalPages});

test('the opt-in reader checks exact Stage identity, authorization and date before any outbound request', async () => {
  const noFetch = () => assert.fail('unexpected provider request');
  for (const blocked of [{...env, OPSMAP_STAGE_DELIVERY_DATED_ENABLED:'0'}, {...env, RENDER_SERVICE_ID:'wrong'},
    {...env, RENDER_EXTERNAL_URL:'https://freshon-admin-1.onrender.com'}]) {
    await assert.rejects(createStageDatedDeliveryReader({env:blocked,fetchImpl:noFetch})(date), {code:'DELIVERY_SOURCE_READ_ONLY'});
  }
  const noCookie = {...env, OPSMAP_STAGE_DELIVERY_DATED_COOKIE:undefined, OPSMAP_STAGE_DELIVERY_PHOTO_COOKIE:'synthetic=not-for-this-purpose'};
  await assert.rejects(createStageDatedDeliveryReader({env:noCookie,fetchImpl:noFetch})(date), {code:'DELIVERY_SOURCE_SESSION_REQUIRED'});
  await assert.rejects(createStageDatedDeliveryReader({env,fetchImpl:noFetch})('2026-02-30'), {code:'DELIVERY_SOURCE_DATE_INVALID'});
});

test('the authorized reader returns the exact old date with 101, 122 and 202 across bounded pages', async () => {
  const pages = [];
  const read = createStageDatedDeliveryReader({env, fetchImpl(url, options) {
    assert.equal(url.origin, 'https://delivery-bali.chabyulhwa.com');
    assert.equal(url.pathname, '/api/bali/task');
    assert.equal(url.searchParams.get('logisticsCenterId'), '1');
    assert.equal(url.searchParams.get('pageSize'), '300');
    assert.deepEqual(url.searchParams.getAll('enteringDatedAtBetween'), Array(2).fill(date + 'T00:00:00+09:00'));
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Cookie, env.OPSMAP_STAGE_DELIVERY_DATED_COOKIE);
    const index = Number(url.searchParams.get('page'));
    pages.push(index);
    return response(tasks.slice(index*300, (index+1)*300));
  }});
  const value = await read(date);
  assert.deepEqual(pages, [0,1]);
  assert.equal(value.sourceObservation.complete, true);
  assert.equal(value.sourceObservation.dateVerified, true);
  assert.equal(value.sourceObservation.responseRows, 301);
  assert.deepEqual(value.vehicles.map(({vehicle,stops}) => [vehicle,stops.length]), [['101',101],['122',100],['202',100]]);
  assert.equal(value.vehicles[0].stops[0].appRecorded, true);
});

test('authentication failures, partial pages and wrong dates never become verified results', async () => {
  const read = fetchImpl => createStageDatedDeliveryReader({env,fetchImpl})(date);
  await assert.rejects(read(() => new Response('login', {status:401})), {code:'DELIVERY_SOURCE_AUTH_REQUIRED',diagnostic:{status:401}});
  await assert.rejects(read(() => new Response('forbidden', {status:403})), {code:'DELIVERY_SOURCE_FORBIDDEN',diagnostic:{status:403}});
  await assert.rejects(read(() => response(tasks.slice(0,1))), {code:'DELIVERY_SOURCE_INCOMPLETE'});
  await assert.rejects(read(() => response([{...tasks[0], enteringDatedAt:'2026-05-15'}],1,1)), {code:'DELIVERY_SOURCE_IDENTITY_UNVERIFIED'});
});

test('Stage assignments and current status share the same authenticated source without a Hub read', async t => {
  const password = 'fixture-only-dated-read';
  let sessionContent;
  let providerReads = 0;
  const app = createStageVerificationApp({env:{...env, MAP_STAFF_ID:'fixture-staff', MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash(password),
    MAP_STAFF_SESSION_SECRET:'s'.repeat(43), GITHUB_CACHE_REPO:'mingu0702-droid/freshon-cache', GITHUB_TOKEN:'fixture-only',
    OPSMAP_MANUAL_PIN_GITHUB_BRANCH:'stage/opsmap-manual-pins'}, readHub:async () => assert.fail('unexpected Hub read'),
    async fetchImpl(input, options) {
      const url = new URL(input);
      if (url.hostname === 'delivery-bali.chabyulhwa.com') {
        assert.equal(options.method, 'GET');
        assert.equal(url.searchParams.get('logisticsCenterId'), '1');
        providerReads++;
        return response(tasks.slice(0,3), 3, 1);
      }
      assert.equal(url.hostname, 'api.github.com');
      if (url.pathname.endsWith('/freshon-cache')) return Response.json({private:true, permissions:{push:true}});
      assert.ok(url.pathname.endsWith('/staff-sessions-v1.json'));
      if (options.method === 'PUT') {
        sessionContent = JSON.parse(options.body).content;
        return Response.json({ok:true});
      }
      return sessionContent ? Response.json({sha:'b'.repeat(40), encoding:'base64', size:Buffer.from(sessionContent,'base64').length, content:sessionContent})
        : new Response(null,{status:404});
    }});
  const server = app.listen(0,'127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = `${origin}/api/map-phase2b/preview`;
  assert.equal((await fetch(`${api}/assignments?date=${date}`)).status,401);
  assert.equal(providerReads,0);
  const login = await fetch(`${origin}/api/map-phase2b/auth/login`, {method:'POST', headers:{origin:STAGE_ORIGIN,'content-type':'application/json'},
    body:JSON.stringify({id:'fixture-staff',password})});
  assert.equal(login.status,200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const dated=origin+'/api/map-phase2b/private/dated-delivery';
  assert.equal((await fetch(`${dated}?date=${date}`)).status,401);
  const [assignments, todayStatus, contract] = await Promise.all([...['assignments','today-status'].map(path => fetch(`${api}/${path}?date=${date}`,{headers:{cookie}})),
    fetch(`${dated}?date=${date}&vehicle=122`,{headers:{cookie}})]);
  assert.deepEqual([assignments.status,todayStatus.status,contract.status],[200,200,200]);
  assert.match(contract.headers.get('cache-control'),/\bno-store\b/);
  assert.match(contract.headers.get('vary'),/\bCookie\b/i);
  const delivery=await contract.json();
  assert.equal(delivery.count,1);
  assert.equal(delivery.source.rawRows,3);
  assert.equal(delivery.rows[0].customerCode,'S2');
  assert.equal(delivery.rows[0].individualCompletedAt,null);
  assert.deepEqual(delivery.chronology,[]);
  const centerUnavailable=await fetch(`${dated}?date=${date}&center=yeongnam`,{headers:{cookie}});
  assert.equal(centerUnavailable.status,503);
  assert.equal((await centerUnavailable.json()).rows,null);
  const payload = await assignments.json();
  assert.equal(payload.meta.complete,true);
  assert.equal(payload.meta.date,date);
  assert.deepEqual(payload.data.map(row => row.vehicle), ['101','122','202']);
  const status = await todayStatus.json();
  assert.deepEqual(status.data.vehicles.map(group => [group.vehicle,group.totalStops]), [['101',1],['122',1],['202',1]]);
  assert.equal(providerReads,1);
});
