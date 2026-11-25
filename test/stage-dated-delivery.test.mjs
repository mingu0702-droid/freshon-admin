import assert from 'node:assert/strict';
import test from 'node:test';
import {createStageDatedDeliveryReader} from '../src/stageDatedDelivery.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from '../src/stageAbValidation.js';
import {createStageVerificationApp} from '../src/stageVerificationEntry.js';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';
import {deliveryCompletion,deliveryTaskId,packDatedEvent} from '../src/datedDeliveryContract.js';

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
  assert(value.vehicles.every(({stops})=>stops.every(stop=>!Object.hasOwn(stop,'sequence')&&!Object.hasOwn(stop,'order'))));
});

test('authentication failures, partial pages and wrong dates never become verified results', async () => {
  const read = fetchImpl => createStageDatedDeliveryReader({env,fetchImpl})(date);
  await assert.rejects(read(() => new Response('login', {status:401})), {
    code:'DELIVERY_SOURCE_AUTH_REQUIRED',diagnostic:{status:401,sourceHttp:401,stage:'source-session',attempts:1}
  });
  await assert.rejects(read(() => new Response('forbidden', {status:403})), {
    code:'DELIVERY_SOURCE_FORBIDDEN',diagnostic:{status:403,sourceHttp:403,stage:'source-task-search',attempts:1}
  });
  await assert.rejects(read(() => response(tasks.slice(0,1))), {code:'DELIVERY_SOURCE_INCOMPLETE'});
  await assert.rejects(read(() => response([{...tasks[0], enteringDatedAt:'2026-05-15'}],1,1)), {code:'DELIVERY_SOURCE_IDENTITY_UNVERIFIED'});
});

test('one staff roster deadline includes the retry and differs from a provider HTTP 504',async t=>{
  let providerCalls=0;
  const upstream=createStageDatedDeliveryReader({env,fetchImpl:()=>{
    providerCalls++;
    return new Response(null,{status:504});
  }});
  await assert.rejects(upstream.readContract(date,'osan',null),{
    code:'DELIVERY_SOURCE_PROVIDER_TIMEOUT',diagnostic:{status:504,sourceHttp:504,stage:'source-task-search',attempts:2}
  });
  assert.equal(providerCalls,2);

  const budget=new AbortController();
  const limits=[];
  t.mock.method(AbortSignal,'timeout',limit=>{limits.push(limit);return budget.signal;});
  let starts=0;
  const internal=createStageDatedDeliveryReader({env,fetchImpl:()=>{
    starts++;
    budget.abort(new DOMException('fixture budget exceeded','TimeoutError'));
    return new Promise(()=>{});
  }});
  await assert.rejects(internal.readContract(date,'osan',null),{
    code:'DELIVERY_SOURCE_TIMEOUT',diagnostic:{status:504,stage:'staff-roster-deadline',attempts:1}
  });
  assert.deepEqual(limits,[14000]);
  assert.equal(starts,1);
});

test('one departing staff reader keeps the shared date while the last departure cancels an obsolete date',async()=>{
  const alternate='2026-05-15';
  const signals=new Map(), replies=new Map(), calls=[];
  const read=createStageDatedDeliveryReader({env,fetchImpl(url,{signal}){
    const day=url.searchParams.get('enteringDatedAtBetween').slice(0,10);
    calls.push(day);signals.set(day,signal);
    return new Promise(resolve=>replies.set(day,resolve));
  }});
  const abandoned=new AbortController(), shared=new AbortController();
  const first=read.readContract(date,'osan',null,{signal:abandoned.signal});
  const sameScope=read.readContract(date,'osan','101',{signal:shared.signal});
  const otherScope=read.readContract(alternate,'osan',null);
  const firstFailed=assert.rejects(first,{code:'DELIVERY_REQUEST_CANCELLED'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[date,alternate]);
  abandoned.abort();
  await firstFailed;
  assert.equal(signals.get(date).aborted,false);
  replies.get(alternate)(response([{...tasks[0],enteringDatedAt:alternate}],1,1));
  assert.equal((await otherScope).date,alternate);
  const sharedFailed=assert.rejects(sameScope,{code:'DELIVERY_REQUEST_CANCELLED'});
  shared.abort();
  await sharedFailed;
  assert.equal(signals.get(date).aborted,true);
  assert.equal(read.readRetained(date),null);
  assert.equal((await read.readContract(alternate,'osan',null)).count,1);
  const reopened=read.readContract(date,'osan',null);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[date,alternate,date]);
  replies.get(date)(response(tasks.slice(0,1),1,1));
  assert.equal((await reopened).count,1);
});

test('staff source failure keeps the last verified roster for that date only',async()=>{
  let clock=Date.parse(date), live=true;
  const read=createStageDatedDeliveryReader({env,now:()=>clock,fetchImpl:()=>live ? response(tasks.slice(0,1),1,1):
    new Response(null,{status:504})});
  const first=await read.readContract(date,'osan',null);
  live=false;
  clock+=61000;
  const saved=await read.readContract(date,'osan',null);
  assert.equal(saved.state,'STALE_VERIFIED');
  assert.equal(saved.error,'DELIVERY_SOURCE_PROVIDER_TIMEOUT');
  assert.equal(saved.sha256,first.sha256);
  assert.equal(saved.currentReadComplete,false);
  await assert.rejects(read.readContract('2026-05-15','osan',null),{code:'DELIVERY_SOURCE_PROVIDER_TIMEOUT'});
});

test('only explicit matching-center delivery positives become partial operating evidence',async()=>{
  const queries=[];
  const recorded=date+'T02:30:00+09:00';
  const row=(id,code,overrides={})=>({id,customer:{erpCode:code},status:'MISSING',
    carrier:{enteringDatedAt:recorded,logisticsCenterId:1,status:'CONFIRMED',confirmDatedAt:recorded},...overrides});
  const matches=[row(1,'S1'),row(2,'S1',{status:'COMPLETED',completeDatedAt:recorded}),
    row(3,'S2',{status:'CANCELLED'}),row(4,'S3',{carrier:{enteringDatedAt:recorded,logisticsCenterId:1,status:'CONFIRMED'}}),
    row(5,'S4')];
  const read=createStageDatedDeliveryReader({env,syncCenters:{osan:'1',yeongnam:'3',honam:'4'},fetchImpl(url){
    const center=url.searchParams.get('logisticsCenterId');
    queries.push(center);
    if(center==='1')return response(matches,matches.length,1);
    if(center==='3')return response([],0,0);
    return new Response('forbidden',{status:403});
  }});
  assert.deepEqual(await read.readRecentOperations(date),[{date,centerKey:'osan',source:'delivery_admin',coverage:'partial',
    rows:[{customerCode:'S1',evidence:'delivery_completed'},{customerCode:'S4',evidence:'dispatch_confirmed'}]}]);
  assert.deepEqual(queries,['1','3','4']);
  assert.deepEqual(await read.readRecentOperations(date,new Set(['osan','honam'])),[]);
  assert.deepEqual(queries,['1','3','4','3']);
});

test('Stage HTTP shares dated source work and cancels a disconnected date without a Hub read', {timeout:5000},async t => {
  const password = 'fixture-only-dated-read';
  const abandonedDate='2026-05-14';
  const archiveDate='2026-05-13';
  const abandonedStarted=Promise.withResolvers(),abandonedStopped=Promise.withResolvers();
  const archiveStarted=Promise.withResolvers(),liveStarted=Promise.withResolvers(),scheduledReady=Promise.withResolvers();
  const archiveTasks=tasks.slice(0,2).map(task=>({...task,enteringDatedAt:archiveDate}));
  const archived={date:archiveDate,tasks:archiveTasks.map((task,index)=>[
    deliveryTaskId(task.id),task.customer.erpCode,['101','122'][index],null,null,'COMPLETED'
  ]),dispatch:{sources:[['1',1,2,0]],events:archiveTasks.map((task,index)=>packDatedEvent('1',
    deliveryCompletion(task,{date:archiveDate,customerCode:task.customer.erpCode,vehicle:['101','122'][index]})))}};
  const generation={registry:new Map(),ledger:{records:{}},index:{asOf:archiveDate,sha256:'a'.repeat(64)},
    state:{revision:1,committedAt:archiveDate+'T03:00:00.000Z'}};
  let sessionContent;
  let providerReads = 0;
  const app = createStageVerificationApp({env:{...env, MAP_STAFF_ID:'fixture-staff', MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash(password),
    MAP_STAFF_SESSION_SECRET:'s'.repeat(43), GITHUB_CACHE_REPO:'mingu0702-droid/freshon-cache', GITHUB_TOKEN:'fixture-only',
    OPSMAP_STAGE_SYNC_READ_APPROVED:'1', OPSMAP_MANUAL_PIN_GITHUB_BRANCH:'stage/opsmap-manual-pins'},
    readHub:async () => assert.fail('unexpected Hub read'),
    openScheduledStore:async()=>({
      read:async()=>generation,
      readStatus:async()=>{scheduledReady.resolve();return null;},
      readDay:async day=>{
        if(day!==archiveDate)return null;
        archiveStarted.resolve();
        await liveStarted.promise;
        return archived;
      }
    }),
    async fetchImpl(input, options) {
      const url = new URL(input);
      if (url.hostname === 'delivery-bali.chabyulhwa.com') {
        assert.equal(options.method, 'GET');
        assert.equal(url.searchParams.get('logisticsCenterId'), '1');
        providerReads++;
        if(url.searchParams.get('enteringDatedAtBetween').startsWith(abandonedDate)){
          options.signal.addEventListener('abort',()=>abandonedStopped.resolve(),{once:true});
          abandonedStarted.resolve();
          return new Promise(()=>{});
        }
        if(url.searchParams.get('enteringDatedAtBetween').startsWith(archiveDate)){
          liveStarted.resolve();
          await archiveStarted.promise;
          return response(archiveTasks.slice(0,1),1,1);
        }
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
  app.emit('opsmap-stage-listening');
  await scheduledReady.promise;
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
  const unavailable=await centerUnavailable.json();
  assert.equal(unavailable.rows,null);
  assert.equal(unavailable.activeCount,null);
  assert.equal(unavailable.sourceId,'3');
  assert.equal(unavailable.lastSuccessAt,null);
  const payload = await assignments.json();
  assert.equal(payload.meta.complete,true);
  assert.equal(payload.meta.date,date);
  assert.deepEqual(payload.data.map(row => row.vehicle), ['101','122','202']);
  const status = await todayStatus.json();
  assert.deepEqual(status.data.vehicles.map(group => [group.vehicle,group.totalStops]), [['101',1],['122',1],['202',1]]);
  assert.equal(providerReads,1);
  const departing=new AbortController();
  const abandoned=assert.rejects(fetch(`${dated}?date=${abandonedDate}`,{headers:{cookie},signal:departing.signal}),{name:'AbortError'});
  await abandonedStarted.promise;
  departing.abort();
  await abandoned;
  await abandonedStopped.promise;
  assert.equal(providerReads,2);
  const retained=await fetch(`${dated}?date=${archiveDate}`,{headers:{cookie},signal:AbortSignal.timeout(1000)});
  assert.equal(retained.status,200);
  assert.match(retained.headers.get('server-timing'),/datedLive;dur=\d+/);
  assert.match(retained.headers.get('server-timing'),/datedArchive;dur=\d+/);
  const retainedRoster=await retained.json();
  assert.equal(retainedRoster.state,'PUBLISHED_VERIFIED');
  assert.equal(retainedRoster.error,'DELIVERY_SOURCE_REGRESSION');
  assert.deepEqual(retainedRoster.rows.map(row=>row.customerCode).sort(),['S1','S2']);
  assert.equal(providerReads,3);
});
