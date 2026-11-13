import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';
import {createStageVerificationApp} from '../src/stageVerificationEntry.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageScope.js';

const key = 'stage-fixture-key';
const token = 'stage-fixture-budget-token';
const password = 'synthetic-staff-password';
const at = Date.parse('2026-11-14T02:30:00Z');
const sha = createHash('sha256').update(key).digest('hex');
const approved = {
  schema:1,
  roadBudget:{
    environment:'STAGE', accountHash:sha, scope:'CUMULATIVE_APPROVED_ACCOUNT',
    policy:'FREE_ONLY', providerPaidDisabled:true, servicePermissionVerified:true,
    approvalId:'stage-test-approval', verifiedAt:'2026-11-14T02:00:00Z',
    expiresAt:'2026-11-14T03:00:00Z', limit:1, used:0, monthlyFreeRemainingAtApproval:20,
    approvedApis:['directions'], providerDailyUsedAtApproval:{directions:3},
    apis:{directions:{freeRemainingAtApproval:20,used:0},waypoints:{freeRemainingAtApproval:0,used:0}}
  }
};
const draft = {
  mode:'MANUAL_WAYPOINTS', requestId:1,
  origin:{id:'center',lat:37,lng:127},
  waypoints:[{id:'visit',order:1,lat:37.01,lng:127.01}],
  destination:{id:'end',lat:37.02,lng:127.02}
};

async function fixture(t, options = {}) {
  let session, revision = 1, budget = structuredClone(options.ledger ?? approved);
  let budgetWrites = 0, providerCalls = 0;
  const file = (bytes, sha) => bytes ? Response.json({
    encoding:'base64', size:bytes.length, content:bytes.toString('base64'), sha
  }) : new Response(null,{status:404});
  const env = {
    RENDER_EXTERNAL_URL:STAGE_ORIGIN, RENDER_SERVICE_ID:STAGE_SERVICE,
    MAP_STAFF_ID:'stage-fixture', MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash(password),
    MAP_STAFF_SESSION_SECRET:'s'.repeat(48), GITHUB_TOKEN:'stage-fixture-session-token',
    GITHUB_CACHE_REPO:'mingu0702-droid/freshon-cache', OPSMAP_MANUAL_PIN_GITHUB_BRANCH:'stage/opsmap-manual-pins',
    OPSMAP_STAGE_ROAD_ROUTE_APPROVED:'1', OPSMAP_STAGE_ROAD_ROUTE_ENABLED:'1',
    OPSMAP_STAGE_KAKAO_MOBILITY_REST_API_KEY:key, OPSMAP_STAGE_ROAD_BUDGET_STORE_TOKEN:token,
    ...options.env
  };
  const app = createStageVerificationApp({env, now:()=>at, fetchImpl:async(input, request={})=>{
    const url = new URL(input);
    const isBudget = request.headers.Authorization === 'Bearer '+token;
    if (url.origin === 'https://apis-navi.kakaomobility.com') {
      providerCalls++;
      assert.equal(url.pathname,'/v1/directions');
      assert.equal(url.searchParams.get('waypoints'),'127.01,37.01');
      assert.equal(request.headers.Authorization,'KakaoAK '+key);
      assert.equal(budget.roadBudget.used,1,'reserve before dispatch');
      if(options.providerHttp) return new Response(null,{status:options.providerHttp});
      return Response.json({routes:[{result_code:0,summary:{distance:2400,duration:310},sections:[
        {distance:1200,duration:150,roads:[{vertexes:[127,37,127.01,37.01]}]},
        {distance:1200,duration:160,roads:[{vertexes:[127.01,37.01,127.02,37.02]}]}
      ]}]});
    }
    assert.equal(url.origin,'https://api.github.com');
    assert.equal(request.redirect,'error');
    if (url.pathname.endsWith('/freshon-cache')) {
      return Response.json({private:true,permissions:{push:!isBudget || options.budgetWriteAllowed!==false}});
    }
    const branch = 'stage/opsmap-manual-pins';
    const update = request.method === 'PUT' ? JSON.parse(request.body) : null;
    assert.equal(update?.branch ?? url.searchParams.get('ref'),branch);
    if (isBudget) {
      assert.match(url.pathname,/\/contents\/opsmap-stage\/road-budget-v1\.json$/);
      if(options.missing) return new Response(null,{status:404});
      if (update) {
        budgetWrites++;
        assert.equal(update.sha,String(revision).padStart(40,'0'));
        if(options.conflict) return new Response(null,{status:409});
        budget = JSON.parse(Buffer.from(update.content,'base64'));
        revision++;
        return Response.json({});
      }
      return file(Buffer.from(JSON.stringify(budget)),String(revision).padStart(40,'0'));
    }
    assert.match(url.pathname,/\/contents\/opsmap-stage\/staff-sessions-v1\.json$/);
    if (update) {
      session = Buffer.from(update.content,'base64');
      return Response.json({});
    }
    return file(session,'c'.repeat(40));
  }});
  const server = app.listen(0,'127.0.0.1');
  t.after(()=>{server.closeAllConnections();server.close();});
  await new Promise(resolve=>server.once('listening',resolve));
  const url = 'http://127.0.0.1:'+server.address().port+'/api/map-phase2b/';
  const headers = {origin:STAGE_ORIGIN,'content-type':'application/json'};
  const request = (suffix, options)=>fetch(url+suffix,options);
  const login = await request('auth/login',{method:'POST',headers,body:JSON.stringify({id:'stage-fixture',password})});
  assert.equal(login.status,200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const config = async()=> (await request('private/road-route/config',{headers:{cookie}})).json().then(p=>p.data);
  const route = ({input=draft, origin=STAGE_ORIGIN, staff=true}={})=>request('private/manual-road-route',{
    method:'POST', headers:{...headers,origin,...(staff?{cookie}:{})},body:JSON.stringify(input)
  });
  return {config,route,counts:()=>({budgetWrites,providerCalls})};
}

test('Stage ignores shared or Production road credentials and a flag without approval',async t=>{
  const f = await fixture(t,{env:{
    OPSMAP_STAGE_ROAD_ROUTE_APPROVED:undefined, OPSMAP_STAGE_KAKAO_MOBILITY_REST_API_KEY:undefined,
    OPSMAP_STAGE_ROAD_BUDGET_STORE_TOKEN:undefined, OPSMAP_ROAD_ROUTE_ENABLED:'1',
    OPSMAP_PRODUCTION_ROAD_ROUTE_ENABLED:'1', KAKAO_MOBILITY_REST_API_KEY:'production-only'
  }});
  const config = await f.config();
  assert.deepEqual(config.blockedReasons,['FEATURE_DISABLED','KEY_MISSING','PERSISTENT_BUDGET_REQUIRED']);
  assert.equal((await f.route()).status,503);
  assert.deepEqual(f.counts(),{budgetWrites:0,providerCalls:0});
});

test('Stage road readiness reads its ledger; staff and same-origin calls reserve before dispatch',async t=>{
  const f = await fixture(t);
  const config = await f.config();
  assert.equal(config.canRequest,true);
  assert.equal(config.budgetBackend,'STAGE_PRIVATE_GITHUB_CAS');
  assert.deepEqual(config.apiRemaining,{directions:20,waypoints:0});
  assert.doesNotMatch(JSON.stringify(config),/stage-fixture-key|stage-fixture-budget-token/);
  assert.equal((await f.route({staff:false})).status,401);
  const crossOrigin = await f.route({origin:'https://synthetic.invalid'});
  assert.equal(crossOrigin.status,401);
  assert.equal((await crossOrigin.json()).error,'STAFF_LOGIN_REQUIRED');
  assert.deepEqual(f.counts(),{budgetWrites:0,providerCalls:0});
  const r = await f.route();
  assert.equal(r.status,200);
  const data = await r.json();
  assert.equal(data.meta.providerHttp,200);
  assert.equal(data.data.distanceMeters,2400);
  assert.equal(data.data.durationSeconds,310);
  assert.equal(data.data.chunks[0].geometry.length,2);
  assert.equal((await f.config()).approvedRemaining,0);
  const other = {...draft,destination:{...draft.destination,lat:37.03}};
  assert.equal((await f.route({input:other})).status,429);
  assert.deepEqual(f.counts(),{budgetWrites:1,providerCalls:1});
});

test('missing ledger, write permission, expired approval and CAS conflicts never dispatch',async t=>{
  const expired = structuredClone(approved);
  expired.roadBudget.expiresAt = '2026-11-14T02:20:00Z';
  for (const [input, reason] of [
    [{missing:true},'ROAD_BUDGET_LEDGER_MISSING'],
    [{budgetWriteAllowed:false},'ROAD_BUDGET_PRIVATE_WRITE_REQUIRED'],
    [{ledger:expired},'ROAD_BUDGET_APPROVAL_EXPIRED'],
    [{conflict:true},null]
  ]) {
    const f = await fixture(t,input);
    assert.equal((await f.config()).budgetError,reason);
    assert.equal((await f.route()).status,429);
    assert.deepEqual(f.counts(),{budgetWrites:input.conflict?1:0,providerCalls:0});
  }
});

test('Kakao permission failure consumes the reserved allowance and cannot trigger an extra call',async t=>{
  const f = await fixture(t,{providerHttp:403});
  const r = await f.route();
  assert.equal(r.status,502);
  assert.deepEqual(await r.json(),{ok:false,error:'PERMISSION_DENIED',providerHttp:403});
  assert.equal((await f.config()).approvedRemaining,0);
  assert.equal((await f.route()).status,429);
  assert.deepEqual(f.counts(),{budgetWrites:1,providerCalls:1});
});
