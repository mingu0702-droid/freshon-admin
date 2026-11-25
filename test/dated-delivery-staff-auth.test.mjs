import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';
import {createRoadRouteService} from '../src/opsmap-abc/roadRouteService.js';
import {createProductionStaffSessionStore} from '../src/opsmap-abc/staffSessionStore.js';
import {PRIMARY_ORIGIN,PRIMARY_SERVICE} from '../src/stageScope.js';
import {createStageVerificationApp} from '../src/stageVerificationEntry.js';

const path='/api/map-phase2b/private/dated-delivery';
const oldDate='2026-05-15', newerDate='2026-05-16';
const password='fixture-only-dated-staff';

test('Production roster verifies the durable session before reading and before returning the response', {timeout:12000}, async t=>{
  const proof=JSON.stringify({schema:1,destination:PRIMARY_ORIGIN,operationsArchive:'1'.repeat(40),
    wmsArchive:'2'.repeat(40),legacySnapshotArchive:'3'.repeat(40),legacyAuthArchive:'4'.repeat(40),
    legacyPinsArchive:'5'.repeat(40),stagePinsArchive:'6'.repeat(40),legacyRegistryVerified:true,
    legacyRegistryUnconfirmed:0,legacyFixedUnconfirmed:0,stagePinsUnconfirmed:0,legacyRegistryChecked:1,legacyFixedChecked:1});
  const config={RENDER_SERVICE_ID:PRIMARY_SERVICE,RENDER_EXTERNAL_URL:PRIMARY_ORIGIN,
    OPSMAP_PRIMARY_CUTOVER_APPROVED:'1',OPSMAP_PRIMARY_ARCHIVE_READ_APPROVED:'1',
    OPSMAP_PRIMARY_ARCHIVE_READ_TOKEN:'fixture-archive-only',OPSMAP_PRIMARY_PRESERVATION_JSON:proof,
    OPSMAP_PRIMARY_PRESERVATION_SHA256:createHash('sha256').update(proof).digest('hex'),
    OPSMAP_STAGE_DELIVERY_DATED_ENABLED:'1',OPSMAP_STAGE_DELIVERY_DATED_COOKIE:'synthetic=fixture',
    MAP_STAFF_ID:'fixture-staff',MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash(password),
    MAP_STAFF_SESSION_SECRET:'s'.repeat(43),OPSMAP_PRODUCTION_SESSION_ENABLED:'1',
    GITHUB_CACHE_REPO:'mingu0702-droid/freshon-cache',GITHUB_TOKEN:'fixture-auth-only',
    OPSMAP_MANUAL_PIN_GITHUB_BRANCH:'production/opsmap-auth'};
  let sealed=null,durableUnavailable=false,durableReads=0,sourceReads=0,checksAtSource=0,held=null;
  const now=()=>Date.parse('2026-05-17T09:00:00Z');

  async function fetchImpl(input,options={}) {
    const url=new URL(input);
    if(url.hostname==='delivery-bali.chabyulhwa.com') {
      assert.equal(url.pathname,'/api/bali/task');
      const date=url.searchParams.get('enteringDatedAtBetween').slice(0,10);
      sourceReads++;
      checksAtSource=durableReads;
      if(held) {held.started.resolve();await held.release.promise;}
      return Response.json({content:[{id:1,enteringDatedAt:date,customer:{erpCode:'S1',name:'fixture customer'},
        carrier:{fixedNo:'101'},status:'COMPLETED'}],totalElements:1,totalPages:1});
    }
    assert.equal(url.hostname,'api.github.com');
    if(options.method==='PUT') {
      assert.match(url.pathname,/opsmap-production\/staff-sessions-v1\.json$/);
      sealed=JSON.parse(options.body).content;
      return Response.json({ok:true});
    }
    durableReads++;
    await delay(35);
    if(durableUnavailable)return new Response(null,{status:503});
    if(url.pathname.endsWith('/freshon-cache'))return Response.json({private:true,permissions:{push:true}});
    assert.match(url.pathname,/opsmap-production\/staff-sessions-v1\.json$/);
    return sealed?Response.json({sha:'a'.repeat(40),encoding:'base64',content:sealed,
      size:Buffer.from(sealed,'base64').length}):new Response(null,{status:404});
  }

  async function start(env=config) {
    const app=createStageVerificationApp({env,now,fetchImpl,readHub:async()=>assert.fail('unexpected Hub request'),
      primaryServices:{sessions:createProductionStaffSessionStore({env,fetchImpl,now}),
        roadRouteService:createRoadRouteService({env:{}})}});
    const server=app.listen(0,'127.0.0.1');
    t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
    await new Promise(resolve=>server.once('listening',resolve));
    return 'http://127.0.0.1:'+server.address().port;
  }

  async function login(origin) {
    const response=await fetch(origin+'/api/map-phase2b/auth/login',{method:'POST',
      headers:{origin:PRIMARY_ORIGIN,'content-type':'application/json'},body:JSON.stringify({id:config.MAP_STAFF_ID,password})});
    assert.equal(response.status,200);
    return response.headers.get('set-cookie').split(';')[0];
  }

  const origin=await start();
  assert.equal((await fetch(origin+path+'?date='+newerDate)).status,401);
  assert.equal(durableReads,0);
  assert.equal(sourceReads,0);
  const cookie=await login(origin);
  durableReads=0;
  const started=performance.now();
  const response=await fetch(origin+path+'?date='+newerDate,{headers:{cookie}});
  assert.equal(response.status,200);
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.equal((await response.json()).rows.length,1);
  t.diagnostic(JSON.stringify({durableGitHubGets:durableReads,getsBeforeSource:checksAtSource,
    elapsedMs:Math.round(performance.now()-started)}));
  assert.equal(checksAtSource,2);
  assert.equal(durableReads,4);

  // Simulate external revocation while a source request is held. The process
  // still has the admitted session in memory, so only a durable check can fail it.
  held={started:Promise.withResolvers(),release:Promise.withResolvers()};
  const flight=fetch(origin+path+'?date='+oldDate,{headers:{cookie}});
  await held.started.promise;
  const ledger=JSON.parse(Buffer.from(sealed,'base64').toString('utf8'));
  sealed=Buffer.from(JSON.stringify({...ledger,sessions:{}})).toString('base64');
  held.release.resolve();
  const rejected=await flight;
  held=null;
  assert.equal(rejected.status,401);
  assert.deepEqual(await rejected.json(),{error:'STAFF_LOGIN_REQUIRED'});

  const nextCookie=await login(origin);
  const restarted=await start();
  assert.equal((await fetch(restarted+path+'?date='+newerDate,{headers:{cookie:nextCookie}})).status,200);

  held={started:Promise.withResolvers(),release:Promise.withResolvers()};
  const unavailable=fetch(restarted+path+'?date='+oldDate,{headers:{cookie:nextCookie}});
  await held.started.promise;
  durableUnavailable=true;
  held.release.resolve();
  const blocked=await unavailable;
  held=null;
  durableUnavailable=false;
  assert.equal(blocked.status,503);
  assert.deepEqual(await blocked.json(),{error:'STAFF_SESSION_STORE_UNAVAILABLE'});

  const changed=await start({...config,MAP_STAFF_SESSION_SECRET:'x'.repeat(43)});
  const beforeChanged=sourceReads;
  assert.equal((await fetch(changed+path+'?date='+newerDate,{headers:{cookie:nextCookie}})).status,401);
  assert.equal(sourceReads,beforeChanged);
  const logout=await fetch(origin+'/api/map-phase2b/auth/logout',{method:'POST',headers:{cookie:nextCookie,origin:PRIMARY_ORIGIN}});
  assert.equal(logout.status,200);
  assert.equal((await fetch(restarted+path+'?date='+newerDate,{headers:{cookie:nextCookie}})).status,401);
});
