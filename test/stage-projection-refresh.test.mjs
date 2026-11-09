import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {createStageVerificationApp} from '../src/stageVerificationEntry.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from '../src/stageAbValidation.js';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';
import {createFixedVehicleCache} from '../src/opsmap-abc/fixedVehicleCache.js';
import {fixedEnvelope} from '../src/opsmap-abc/fixedVehicleStore.js';
import {snapshotProjection} from '../src/productionSnapshotStore.js';

const row = vehicle => ({customerCode:'S100', baseVehicle:vehicle, baseVehicleGroup:'osan', baseVehicleState:'VERIFIED_MASTER'});

test('Stage fixed master reloads once per interval and retains verified data on regression', async () => {
  let time = Date.parse('2026-10-01T00:00:00Z'), reads = 0;
  const first = fixedEnvelope([row('101')], new Date(time).toISOString());
  const second = fixedEnvelope([row('122')], new Date(time + 1000).toISOString());
  let stored = first;
  const cache = createFixedVehicleCache({
    readOnly:true, reloadReadOnlyAfterMs:60_000, now:() => time,
    store:{load:async () => {reads++; return stored;}}
  });
  const vehicle = async () => (await cache.get(['S100'])).data[0].baseVehicle;
  assert.equal(await vehicle(), '101');
  stored = second;
  assert.equal(await vehicle(), '101');
  time += 60_000;
  assert.deepEqual(await Promise.all([vehicle(), vehicle()]), ['122','122']);
  assert.equal(reads, 2);
  time += 60_000;
  stored = first;
  const result = await cache.get(['S100']);
  assert.equal(result.meta.lastError, 'FIXED_STORE_SOURCE_REGRESSION');
  assert.equal(result.data[0].baseVehicle, '122');
  assert.equal(reads, 3);
});

test('Stage snapshot refreshes validated revisions and retains data after failure or rollback', async () => {
  const name = 'map-snapshot-v1.json';
  let time = Date.parse('2026-10-01T00:00:00Z'), reads = 0, session;
  const fixture = (revision, date) => snapshotProjection({
    version:'phase2b-map-snapshot-v1', rows:[{...row('101'), lastDeliveryDate:date}]
  }, {revision, now:() => time});
  const first = fixture(1,'2026-09-01'), second = fixture(2,'2026-09-03');
  let stored = first;
  const files = value => {
    const bytes = Buffer.from(JSON.stringify(value));
    return Response.json({sha:'a'.repeat(40),encoding:'base64',size:bytes.length,content:bytes.toString('base64')});
  };
  const env = {
    RENDER_SERVICE_ID:STAGE_SERVICE, RENDER_EXTERNAL_URL:STAGE_ORIGIN,
    OPSMAP_SNAPSHOT_STORE_ENABLED:'1', OPSMAP_SNAPSHOT_STORE_REPO:'mingu0702-droid/freshon-cache',
    OPSMAP_SNAPSHOT_STORE_BRANCH:'stage/opsmap-snapshots', GITHUB_TOKEN:'fixture',
    GITHUB_CACHE_REPO:'mingu0702-droid/freshon-cache', OPSMAP_MANUAL_PIN_GITHUB_BRANCH:'stage/opsmap-manual-pins',
    MAP_STAFF_ID:'fixture', MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash('local-test-password'),
    MAP_STAFF_SESSION_SECRET:'local-stage-fixture-secret-not-a-production-secret'
  };
  const app = createStageVerificationApp({env, now:() => time, fetchImpl:async (url, options) => {
    const file = new URL(url).pathname.split('/').at(-1);
    if (file === 'freshon-cache') return Response.json({private:true,permissions:{push:true}});
    if (file === 'staff-sessions-v1.json') {
      if (options.method === 'PUT') {
        session = JSON.parse(Buffer.from(JSON.parse(options.body).content,'base64'));
        return Response.json({});
      }
      return session ? files(session) : new Response(null,{status:404});
    }
    if (file === name) {
      assert.equal(options.method, undefined);
      reads++;
      return stored ? files({schema:1,current:stored,previous:null}) : new Response(null,{status:503});
    }
    return new Response(null,{status:404});
  }});
  const server = app.listen(0,'127.0.0.1');
  await once(server,'listening');
  const root = 'http://127.0.0.1:'+server.address().port+'/opsmap/api/map-phase2b';
  try {
    const login = await fetch(root+'/auth/login',{method:'POST',headers:{Origin:STAGE_ORIGIN,'Content-Type':'application/json'},
      body:JSON.stringify({id:'fixture',password:'local-test-password'})});
    assert.equal(login.status,200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const current = async () => {
      const response = await fetch(root+'/preview/snapshot',{headers:{cookie,'sec-fetch-site':'same-origin'}});
      assert.equal(response.status,200);
      return (await response.json()).data[0].lastDeliveryDate;
    };
    assert.equal(await current(),'2026-09-01');
    stored = second;
    assert.equal(await current(),'2026-09-01');
    time += 60_000;
    assert.deepEqual(await Promise.all([current(),current()]),['2026-09-03','2026-09-03']);
    time += 60_000;
    stored = null;
    assert.equal(await current(),'2026-09-03');
    time += 60_000;
    stored = first;
    assert.equal(await current(),'2026-09-03');
    assert.equal(reads,4);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
