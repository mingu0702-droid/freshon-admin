import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';
import {createStageVerificationApp} from '../src/stageVerificationEntry.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageScope.js';
import '../public/opsmap/road-route-ui.js';

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
  let session;
  const shared = options.shared ?? { revision:1,budget:structuredClone(options.ledger ?? approved) };
  let budgetReads = 0, budgetWrites = 0, providerCalls = 0;
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
    const isBudget = request.headers.Authorization === 'Bearer '+token || url.pathname.endsWith('/road-budget-v1.json');
    if (url.origin === 'https://apis-navi.kakaomobility.com') {
      providerCalls++;
      assert.equal(url.pathname,'/v1/directions');
      if(options.shared)assert.equal(url.searchParams.get('waypoints').split('|').length,2);
      else assert.equal(url.searchParams.get('waypoints'),'127.01,37.01');
      assert.equal(request.headers.Authorization,'KakaoAK '+key);
      assert.equal(shared.budget.roadBudget.used,options.shared ? options.expectedUsed : 1,'reserve before dispatch');
      if(options.providerHttp) return new Response(null,{status:options.providerHttp});
      const points=[url.searchParams.get('origin'),...url.searchParams.get('waypoints').split('|'),url.searchParams.get('destination')].map(value=>value.split(',').map(Number));
      const sections=points.slice(1).map((point,index)=>({distance:1200,duration:index===0?150:160,roads:[{vertexes:[...points[index],...point]}]}));
      return Response.json({routes:[{result_code:0,summary:{distance:1200*sections.length,duration:150+160*(sections.length-1)},sections}]});
    }
    assert.equal(url.origin,'https://api.github.com');
    assert.equal(request.redirect,'error');
    if (url.pathname.endsWith('/freshon-cache')) {
      return Response.json({private:true,permissions:{push:!isBudget || options.budgetWriteAllowed!==false}});
    }
    const branch = isBudget&&options.shared ? 'production/opsmap-auth' : 'stage/opsmap-manual-pins';
    const update = request.method === 'PUT' ? JSON.parse(request.body) : null;
    assert.equal(update?.branch ?? url.searchParams.get('ref'),branch);
    if (isBudget) {
      assert.equal(url.pathname.endsWith(options.shared?'/opsmap-production/road-budget-v1.json':'/opsmap-stage/road-budget-v1.json'),true);
      if (!update) budgetReads++;
      if(options.missing) return new Response(null,{status:404});
      if (update) {
        budgetWrites++;
        assert.equal(update.sha,String(shared.revision).padStart(40,'0'));
        if(options.shared)assert.equal(update.message,'Reserve approved Stage Directions test call');
        if(options.conflict) return new Response(null,{status:409});
        shared.budget = JSON.parse(Buffer.from(update.content,'base64'));
        shared.revision++;
        return Response.json({});
      }
      return file(Buffer.from(JSON.stringify(shared.budget)),String(shared.revision).padStart(40,'0'));
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
  const configResponse = (staff=true)=>request('private/road-route/config',{headers:staff?{cookie}:{}});
  const config = async()=> (await configResponse()).json().then(p=>p.data);
  const route = ({input=draft, origin=STAGE_ORIGIN, staff=true,clicked=false,recorded=false}={})=>request(recorded?'private/road-route':'private/manual-road-route',{
    method:'POST', headers:{...headers,origin,...(staff?{cookie}:{}),...(clicked?{'X-Opsmap-Manual-Route':'1'}:{})},body:JSON.stringify(input)
  });
  return {config,configResponse,route,budgetReads:()=>budgetReads,counts:()=>({budgetWrites,providerCalls})};
}

test('Stage ignores shared or Production road credentials and a flag without approval',async t=>{
  const f = await fixture(t,{env:{
    OPSMAP_STAGE_ROAD_ROUTE_APPROVED:undefined, OPSMAP_STAGE_KAKAO_MOBILITY_REST_API_KEY:undefined,
    OPSMAP_STAGE_ROAD_BUDGET_STORE_TOKEN:undefined, OPSMAP_ROAD_ROUTE_ENABLED:'1',
    OPSMAP_PRODUCTION_ROAD_ROUTE_ENABLED:'1', KAKAO_MOBILITY_REST_API_KEY:'production-only'
  }});
  const config = await f.config();
  assert.deepEqual(config.blockedReasons,['FEATURE_DISABLED','KEY_MISSING','PERSISTENT_BUDGET_REQUIRED']);
  assert.equal(config.stage.requested,true);
  assert.equal(config.stage.approved,false);
  assert.equal(config.stage.approvalConfigured,false);
  assert.equal(config.stage.ignoredSharedSwitch,true);
  assert.equal(config.stage.budgetTokenConfigured,false);
  const lines = globalThis.RoadRouteUi.describeReadiness(config);
  assert(lines.includes('실행 스위치 ON'));
  assert(lines.includes('기능 OFF'));
  assert(lines.includes('Stage 사용 승인 누락'));
  assert(lines.includes('Stage API 키 누락'));
  assert.equal((await f.route()).status,503);
  assert.deepEqual(f.counts(),{budgetWrites:0,providerCalls:0});
});

test('shared Directions trial reuses the existing Stage key and reserves only two manual calls across restarts',async t=>{
  const shared={revision:1,budget:structuredClone(approved)};
  const budget=shared.budget.roadBudget;
  delete budget.environment;
  budget.used=budget.apis.directions.used=4;
  budget.limit=12;
  const grant={approvalId:budget.approvalId,startUsed:budget.used,startsAt:at-60000,expiresAt:at+60000};
  const env={
    OPSMAP_STAGE_ROAD_SHARED_TRIAL:JSON.stringify(grant),
    KAKAO_REST_API_KEY:key,
    OPSMAP_STAGE_KAKAO_MOBILITY_REST_API_KEY:undefined,
    OPSMAP_STAGE_ROAD_BUDGET_STORE_TOKEN:undefined
  };
  const routeDraft={...draft,waypoints:[...draft.waypoints,{id:'visit-2',order:2,lat:37.02,lng:127.02}],destination:{id:'end',lat:37.03,lng:127.03}};
  const f=await fixture(t,{env,shared,expectedUsed:5});
  const config=await f.config();
  assert.equal(config.budgetBackend,'STAGE_SHARED_DIRECTIONS_TRIAL');
  assert.deepEqual(config.apiRemaining,{directions:2,waypoints:0});
  assert.equal((await f.route({input:routeDraft})).status,403);
  assert.equal((await f.route({input:routeDraft,clicked:true,recorded:true})).status,403);
  assert.equal((await f.route({input:draft,clicked:true})).status,400);
  assert.deepEqual(f.counts(),{budgetWrites:0,providerCalls:0});
  const first=await f.route({input:routeDraft,clicked:true});
  assert.equal(first.status,200);
  const result=await first.json();
  assert.equal(result.data.manualOnly,true);
  assert.equal(result.data.distanceMeters,3600);
  assert.equal(result.data.durationSeconds,470);
  assert.equal(result.data.chunks[0].geometry.length,3);
  assert.deepEqual(f.counts(),{budgetWrites:1,providerCalls:1});
  const restarted=await fixture(t,{env,shared,expectedUsed:6});
  assert.equal((await restarted.config()).approvedRemaining,1);
  const revised={...routeDraft,waypoints:[routeDraft.waypoints[0],{...routeDraft.waypoints[1],lat:37.021}]};
  assert.equal((await restarted.route({input:revised,clicked:true})).status,200);
  assert.equal((await restarted.config()).approvedRemaining,0);
  assert.equal((await restarted.route({input:routeDraft,clicked:true})).status,429);
  assert.equal(shared.budget.roadBudget.used,6);
  assert.equal(shared.budget.roadBudget.apis.waypoints.used,0);
  assert.deepEqual(restarted.counts(),{budgetWrites:1,providerCalls:1});
});

test('shared trial fails closed if the approval, account or trial time is wrong',async t=>{
  for(const [adjustGrant,stageKey,reason] of [
    [grant=>({...grant,approvalId:'different-approval'}),key,'ROAD_BUDGET_TRIAL_APPROVAL_CHANGED'],
    [grant=>({...grant,expiresAt:at-1}),key,'ROAD_BUDGET_TRIAL_WINDOW'],
    [grant=>grant,'other-synthetic-key','ROAD_BUDGET_ACCOUNT_MISMATCH']
  ]){
    const shared={revision:1,budget:structuredClone(approved)};
    const grant=adjustGrant({approvalId:approved.roadBudget.approvalId,startUsed:0,startsAt:at-60000,expiresAt:at+60000});
    const f=await fixture(t,{shared,env:{
      OPSMAP_STAGE_ROAD_SHARED_TRIAL:JSON.stringify(grant),
      OPSMAP_STAGE_KAKAO_MOBILITY_REST_API_KEY:stageKey
    }});
    assert.equal((await f.config()).budgetError,reason);
    assert.deepEqual(f.counts(),{budgetWrites:0,providerCalls:0});
  }
});

test('an intervening Production debit consumes part of the shared two-call window',async t=>{
  const shared={revision:1,budget:structuredClone(approved)};
  const budget=shared.budget.roadBudget;
  delete budget.environment;
  budget.used=budget.apis.directions.used=4;
  budget.limit=12;
  const grant={approvalId:budget.approvalId,startUsed:budget.used,startsAt:at-60000,expiresAt:at+60000};
  const f=await fixture(t,{shared,expectedUsed:6,env:{OPSMAP_STAGE_ROAD_SHARED_TRIAL:JSON.stringify(grant)}});
  assert.equal((await f.config()).approvedRemaining,2);
  budget.used++;
  budget.apis.directions.used++;
  shared.revision++;
  assert.equal((await f.config()).approvedRemaining,1);
  const routeDraft={...draft,waypoints:[...draft.waypoints,{id:'visit-2',order:2,lat:37.02,lng:127.02}],destination:{id:'end',lat:37.03,lng:127.03}};
  assert.equal((await f.route({input:routeDraft,clicked:true})).status,200);
  assert.equal((await f.config()).approvedRemaining,0);
  assert.deepEqual(f.counts(),{budgetWrites:1,providerCalls:1});
});

test('Stage road readiness reads its ledger; staff and same-origin calls reserve before dispatch',async t=>{
  const f = await fixture(t);
  assert.equal(f.budgetReads(),1,'startup checks the ledger before the staff diagnostic is opened');
  assert.deepEqual(f.counts(),{budgetWrites:0,providerCalls:0});
  assert.equal((await f.configResponse(false)).status,401);
  const response=await f.configResponse();
  assert.match(response.headers.get('cache-control'),/no-store/);
  await response.body.cancel();
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
  assert(globalThis.RoadRouteUi.describeReadiness(await f.config()).includes('승인 잔량 부족'));
  const other = {...draft,destination:{...draft.destination,lat:37.03}};
  assert.equal((await f.route({input:other})).status,429);
  assert.deepEqual(f.counts(),{budgetWrites:1,providerCalls:1});
});

test('the same approved settings survive a restart while the recorded deploy SHA changes',async t=>{
  const first = await fixture(t,{env:{RENDER_GIT_COMMIT:'a'.repeat(40)}});
  const restarted = await fixture(t,{env:{RENDER_GIT_COMMIT:'b'.repeat(40)}});
  const a=await first.config(),b=await restarted.config();
  assert.equal(a.stage.deployment,'a'.repeat(40));
  assert.equal(b.stage.deployment,'b'.repeat(40));
  const {deployment:oldDeployment,...oldSettings}=a.stage;
  const {deployment:newDeployment,...newSettings}=b.stage;
  assert.deepEqual(oldSettings,newSettings);
  assert(a.enabled&&b.enabled&&a.budgetVerified&&b.budgetVerified);
  assert.deepEqual(first.counts(),{budgetWrites:0,providerCalls:0});
  assert.deepEqual(restarted.counts(),{budgetWrites:0,providerCalls:0});
  const disabled = await fixture(t,{env:{OPSMAP_STAGE_ROAD_ROUTE_ENABLED:'0'}});
  const off=await disabled.config();
  assert(!off.enabled&&off.stage.switchConfigured&&!off.stage.requested&&off.stage.approved);
  assert(globalThis.RoadRouteUi.describeReadiness(off).includes('실행 스위치 OFF'));
  const invalid=await fixture(t,{env:{OPSMAP_STAGE_ROAD_ROUTE_ENABLED:'true',OPSMAP_STAGE_ROAD_ROUTE_APPROVED:'true'}});
  const invalidConfig=await invalid.config();
  assert(!invalidConfig.enabled&&invalidConfig.stage.switchConfigured&&invalidConfig.stage.approvalConfigured);
  const lines=globalThis.RoadRouteUi.describeReadiness(invalidConfig);
  assert(lines.includes('실행 스위치 형식 불일치'));
  assert(lines.includes('Stage 승인 설정 형식 불일치'));
});

test('missing ledger, write permission, expired approval and CAS conflicts never dispatch',async t=>{
  const expired = structuredClone(approved);
  expired.roadBudget.expiresAt = '2026-11-14T02:20:00Z';
  const wrongAccount = structuredClone(approved);
  wrongAccount.roadBudget.accountHash = '9'.repeat(64);
  for (const [input, reason] of [
    [{missing:true},'ROAD_BUDGET_LEDGER_MISSING'],
    [{budgetWriteAllowed:false},'ROAD_BUDGET_PRIVATE_WRITE_REQUIRED'],
    [{ledger:expired},'ROAD_BUDGET_APPROVAL_EXPIRED'],
    [{ledger:wrongAccount},'ROAD_BUDGET_ACCOUNT_MISMATCH'],
    [{conflict:true},null]
  ]) {
    const f = await fixture(t,input);
    const config=await f.config();
    assert.equal(config.budgetError,reason);
    if(input.missing) assert(globalThis.RoadRouteUi.describeReadiness(config).includes('사용량 원장 누락'));
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
