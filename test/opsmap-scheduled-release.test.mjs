import assert from 'node:assert/strict';
import {createHash, createHmac, randomBytes} from 'node:crypto';
import {EventEmitter, once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';
import express from 'express';
import {createStaffPasswordHash} from '../src/opsmap-abc/mapStaffAuth.js';
import {coordinateAddressHash} from '../src/opsmap-abc/opsmapAutoCoordinates.js';
import {createOpsmapDataSync} from '../src/opsmapDataSync.js';
import {reviseFixedCoordinateLedger} from '../src/fixedStoreCoordinates.js';
import {createOpsmapDurableGeneration, stageOpsmapDurableStorage} from '../src/opsmapDurableGeneration.js';
import {mountOpsmapScheduledRun, OPSMAP_SCHEDULED_ROUTE, publishOpsmapScheduledRun, verifyOpsmapScheduleReceipt} from '../src/opsmapScheduledRun.js';
import {syncDigest, syncSha256} from '../src/opsmapSyncGeneration.js';
import {archiveAddressHash} from '../src/stageArchivedDelivery.js';
import {createStageDatedDeliveryReader} from '../src/stageDatedDelivery.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from '../src/stageScope.js';
import {createStageVerificationApp} from '../src/stageVerificationEntry.js';
import {opsmapDispatchDate} from '../src/snapshotRefreshEvidence.js';
import {createShadowCoverageStore} from '../src/shadowCoverage/store.js';
import {completeSyncObservation,SYNC_DELIVERY_SOURCES} from '../src/opsmapSyncPolicy.js';
import {collectOpsmapVehicleDelivery,opsmapVehicleDeliveryPage,readOpsmapVehicleDelivery} from '../src/opsmapVehicleDeliveryEvidence.js';
import {archivedDatedDispatch,DATED_DELIVERY_CONTRACT,packDatedEvent,deliveryCompletion} from '../src/datedDeliveryContract.js';

const date='2026-11-11', previousDate='2026-11-10', oldDate='2026-07-01';
const clockStart=Date.parse(date+'T02:00:00+09:00');
const owner='fixture@example.test', triggerId='845142167671';
const principal=syncSha256(owner), secret='test-scheduler-signing-secret-do-not-reuse';
const stage={RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN};
const clock={secret,scheduleId:triggerId,executorHash:principal};
const key=randomBytes(32);
const storageEnv={...stage,OPSMAP_STAGE_SYNC_REMOTE_APPROVED:'1',OPSMAP_STAGE_SYNC_PUBLISH_APPROVED:'1',
  OPSMAP_STAGE_SYNC_WRITE_TOKEN:'fixture-writer',OPSMAP_STAGE_SYNC_READ_TOKEN:'fixture-reader',OPSMAP_SHADOW_ARCHIVE_KEY_B64:key.toString('base64')};
const code='T99111', address='경기도 오산시 검증로 91';
const ledgerBody={schema:'opsmap-fixed-store-coordinates-v1',revision:0,records:{}};
const ledger={...ledgerBody,sha256:syncDigest(ledgerBody)};

function signed(at) {
  const slot=Math.floor(at/3600000), issuedAt=new Date(at).toISOString(), origin='APPS_SCRIPT_TIME_TRIGGER';
  const day=new Date(at+9*3600000).toISOString().slice(0,10);
  const runId=syncDigest([1,origin,triggerId,principal,slot]);
  const signature=createHmac('sha256',secret).update(JSON.stringify([1,origin,triggerId,principal,issuedAt,slot,day,runId])).digest('hex');
  return {version:1,origin,triggerId,principal,issuedAt,slot,date:day,runId,signature};
}

async function listen(t,app) {
  const server=app.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return 'http://127.0.0.1:'+server.address().port;
}

function github() {
  const files=new Map(), calls=[];
  let reject;
  async function fetchImpl(input,options={}) {
    const url=new URL(input),method=options.method || 'GET';
    const root='/repos/mingu0702-droid/freshon-cache';
    assert.equal(url.origin,'https://api.github.com');
    if(url.pathname===root)return Response.json({private:true,permissions:{push:true}});
    assert(url.pathname.startsWith(root+'/contents/'));
    const folder=url.pathname.slice((root+'/contents/').length), name=folder.split('/').at(-1);
    const branch=method==='GET'?url.searchParams.get('ref'):JSON.parse(options.body).branch;
    const object=branch+'/'+folder;
    calls.push({method,name});
    const current=files.get(object);
    if(method==='GET') {
      return current?Response.json({sha:current.sha,size:current.data.length,encoding:'base64',content:current.data.toString('base64')}):
        new Response(null,{status:404});
    }
    const incoming=JSON.parse(options.body);
    if(incoming.sha!==current?.sha)return new Response(null,{status:409});
    if(reject?.(name))return new Response(null,{status:503});
    const data=Buffer.from(incoming.content,'base64');
    files.set(object,{sha:createHash('sha1').update(data).digest('hex'),data});
    return Response.json({});
  }
  return {files,calls,fetchImpl,deny:fn=>{reject=fn;}};
}

function observation(day,status='OPEN') {
  const rows=day===previousDate?[]:[[syncSha256(day),code,'122','osan',coordinateAddressHash(address),status]];
  return {date:day,sourceRows:rows.length,unidentified:0,proof:'VERIFIED_COMPLETE_DAY',proofHash:syncDigest(rows),
    completeCenters:['osan','yeongnam','honam'],tasks:rows,
    visits:status==='COMPLETED'?[[rows[0][0],code,'122','osan',archiveAddressHash(address)]]:[]};
}

async function seedFor(root) {
  const directory=path.join(root,'seed'), observed=path.join(directory,'observed-days');
  await fs.mkdir(observed,{recursive:true,mode:0o700});
  const catalog=JSON.stringify({stores:[{code,name:'격리 매장',address,center:'osan',registered:true,
    lat:37.15,lng:127.06,matchHash:archiveAddressHash(address)}]});
  const source=JSON.stringify({start:'2026-08-12',end:'2026-11-09',observedAt:'2026-11-10T00:00:00Z',
    sourceWrites:0,sources:{current:{stable:true},archive:{stable:true}},days:1,completedUnique:1,stores:{union:1}});
  await fs.writeFile(path.join(directory,'stores.private.json'),catalog);
  await fs.writeFile(path.join(directory,'source-import.safe.json'),source);
  for(const day of [oldDate,'2026-11-09']) {
    await fs.writeFile(path.join(observed,day+'.json'),JSON.stringify({date:day,sourceRows:1,unidentified:0,
      proof:'OBSERVED_ARCHIVE_CURRENT',visits:[[syncSha256(day),code,'122','osan',archiveAddressHash(address)]]}));
  }
  return {directory,catalogSha256:syncSha256(catalog),sourceSha256:syncSha256(source)};
}

test('existing Apps Script clock signs the Stage request and rejects manual, duplicate or wrong-account dispatch',async()=>{
  const requests=[];
  const time=clockStart;
  let event={triggerUid:triggerId}, activeOwner=owner, count=1;
  const trigger={getHandlerFunction:()=> 'hubProductionMapAutoTick',getUniqueId:()=>triggerId,getTriggerSource:()=> 'CLOCK'};
  const settings=JSON.stringify({enabled:true,triggerId,executorHash:principal});
  const context={Date:class extends Date{constructor(){super(time);}},
    PropertiesService:{getScriptProperties:()=>({getProperty:name=>name.endsWith('_V1')?settings:secret})},
    ScriptApp:{getProjectTriggers:()=>Array(count).fill(trigger),TriggerSource:{CLOCK:'CLOCK'}},
    Session:{getEffectiveUser:()=>({getEmail:()=>activeOwner})},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},
      computeDigest:(_,value)=>[...Buffer.from(syncSha256(value),'hex')],
      computeHmacSha256Signature:(value,key)=>[...createHmac('sha256',key).update(value).digest()],
      formatDate:()=>date},
    UrlFetchApp:{fetch(url,opts){requests.push({url,opts});return {getResponseCode:()=>202};}},console:{log(){}}};
  vm.createContext(context);
  vm.runInContext(await fs.readFile(new URL('../integrations/hub/HubOpsmapStageSync.js',import.meta.url),'utf8'),context);
  const dispatch=()=>context.hubOpsmapStageSyncDispatch_(event);
  event=null;dispatch();
  event={triggerUid:triggerId};count=2;dispatch();
  count=1;activeOwner='other@example.test';dispatch();
  assert.equal(requests.length,0);
  activeOwner=owner;dispatch();
  const [{url,opts}]=requests;
  assert.equal(url,STAGE_ORIGIN+OPSMAP_SCHEDULED_ROUTE);
  assert.equal(opts.followRedirects,false);
  const value=JSON.parse(opts.payload);
  assert.deepEqual(value,signed(time));
  const now=()=>time;
  assert.equal(verifyOpsmapScheduleReceipt(value,{...clock,now}).runId,value.runId);
  assert.throws(()=>verifyOpsmapScheduleReceipt(value,{...clock,now:()=>time+11*60000}),/RECEIPT/);
  assert.throws(()=>verifyOpsmapScheduleReceipt({...value,signature:'1'.repeat(64)},{...clock,now}),/SIGNATURE/);
});

test('Stage scheduler endpoint passes a valid receipt once and drops raw child diagnostics',async t=>{
  const app=express(),logs=[];
  const env={...storageEnv,OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED:'1',
    OPSMAP_STAGE_SYNC_JOB_SETTINGS_FILE:path.join(os.tmpdir(),'fixture-settings.json'),
    OPSMAP_STAGE_SYNC_TRIGGER_ID:triggerId,OPSMAP_STAGE_SYNC_EXECUTOR_SHA256:principal,OPSMAP_STAGE_SYNC_SCHEDULER_SECRET:secret};
  let child,input='';
  mountOpsmapScheduledRun(app,{env,now:()=>clockStart,log:value=>logs.push(JSON.parse(value)),launch(exec,args){
    assert.equal(exec,process.execPath);
    assert.deepEqual(args.slice(1),['scheduled',env.OPSMAP_STAGE_SYNC_JOB_SETTINGS_FILE]);
    child=new EventEmitter();
    child.stdin=new PassThrough();
    child.stderr=new PassThrough();
    child.stdin.on('data',bytes=>{input+=bytes;});
    return child;
  }});
  const base=await listen(t,app);
  const post=value=>fetch(base+OPSMAP_SCHEDULED_ROUTE,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  const receipt=signed(clockStart);
  assert.equal((await post({...receipt,principal:'2'.repeat(64)})).status,403);
  assert.equal((await post(receipt)).status,202);
  assert.deepEqual(JSON.parse(input),receipt);
  assert.equal((await post(receipt)).status,409);
  child.stderr.write('mock sensitive stack text');
  child.emit('close',1);
  assert.deepEqual(logs,[{component:'opsmap-scheduled-run',runId:receipt.runId,exitCode:1,error:'OPSMAP_SYNC_FAILED'}]);
});

test('publication CAS, source retry, restart, archive laziness, and one run ID across authenticated Stage snapshot and H3',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'opsmap-scheduled-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let spool=path.join(root,'spool');
  await fs.mkdir(spool,{mode:0o700});
  const seed=await seedFor(root), api=github();
  let tick=clockStart, status='OPEN', readFailure=false;
  const now=()=>tick;
  const writer=createOpsmapDurableGeneration({...stageOpsmapDurableStorage({env:storageEnv,write:true,fetchImpl:api.fetchImpl}),now,tempRoot:root});
  const reader=()=>createOpsmapDurableGeneration({...stageOpsmapDurableStorage({env:storageEnv,fetchImpl:api.fetchImpl}),now,tempRoot:root});
  const activeRegistry={complete:true,version:syncSha256('fixture-registry'),rows:[{customerCode:code,customerName:'격리 매장',
    basicAddress:address,lifecycle:'ACTIVE'}]};
  const work=record=>createOpsmapDataSync({directory:spool,seed,now,includeOfficialRegions:false,readLedger:async()=>ledger,
    readRegistry:async()=>{record?.('customerRegistry');return activeRegistry;},
    completeCoordinates:async({stores,ledger})=>({stores,ledger}),readMissingDay:writer.readDay,
    async readDay(day){
      if(readFailure){
        const error=Object.assign(Error('DELIVERY_SOURCE_FORBIDDEN'),{date:day,center:'honam'});
        record?.('delivery:4',day,error);
        throw error;
      }
      record?.('delivery:4',day);
      const source=observation(day,day===date?status:'OPEN');
      const event=deliveryCompletion({status,individualCompletion:true,completedAt:date+'T01:00:00+09:00'},
        {date:day,customerCode:code,vehicle:'122'});
      const dispatch={contract:DATED_DELIVERY_CONTRACT,sources:[['1',1,source.sourceRows,0]],events:source.tasks.map(()=>packDatedEvent('1',event))};
      return {...source,completeSources:['1'],dispatch,proofHash:syncDigest([day,source.tasks,source.visits,dispatch])};
    }});
  const receipt=()=>verifyOpsmapScheduleReceipt(signed(tick),{...clock,now});
  const run=()=>publishOpsmapScheduledRun({createWorker:work,durable:writer,receipt:receipt()});
  const initial=await run();
  assert.equal(initial.state,'PUBLISHED');
  assert.equal((await run()).state,'NOOP');
  const baseline=await writer.read();
  assert.equal(baseline.snapshot.sourceRunId,initial.runId);
  assert.equal(baseline.index.asOf,date);
  const dayRead=await writer.readDay(previousDate);
  assert.equal(dayRead.sourceRows,0);
  assert.equal(dayRead.completeCenters.length,3);
  assert.equal(await writer.readDay('2026-08-16'),null);
  assert([...api.files.values()].every(({data})=>!data.toString().includes(address)));
  assert.throws(()=>stageOpsmapDurableStorage({env:{...storageEnv,OPSMAP_STAGE_SYNC_REMOTE_APPROVED:'0'}}),/APPROVAL/);
  tick+=3600000;
  const reservations=await Promise.all([writer.reserve(receipt()),writer.reserve(receipt())]);
  assert.deepEqual(reservations.map(x=>x.state).sort(),['BUSY','STARTED']);
  const leased=reservations.find(x=>x.run);
  await writer.fail(leased.run,Error('FIXTURE_INTERRUPTED'));
  readFailure=true;
  await assert.rejects(run(),/DELIVERY_SOURCE_FORBIDDEN/);
  const failure=await writer.readStatus();
  assert.equal(failure.lastFailure.failedCenter,'honam');
  assert.equal(failure.sources['delivery:4'].error,'DELIVERY_SOURCE_FORBIDDEN');
  assert(failure.sources['delivery:4'].lastSuccessAt);
  assert.equal((await writer.read()).index.sha256,baseline.index.sha256);
  readFailure=false;
  status='COMPLETED';
  api.deny(name=>name.startsWith('release-'));
  await assert.rejects(run(),/FIXED_STORE_WRITE/);
  assert.equal((await reader().read()).index.sha256,baseline.index.sha256);
  api.deny(null);
  const replacement=await run();
  assert.equal(replacement.state,'PUBLISHED');
  assert.equal(replacement.revision,2);
  assert.notEqual(replacement.generation,baseline.index.sha256);
  const restarted=reader();
  const fetchedAt=api.calls.length;
  const {generation:restored,status:restoredStatus}=await restarted.readWithStatus();
  assert.equal(api.calls.slice(fetchedAt).filter(({name})=>name==='head-v1.json').length,1);
  assert.equal(restored.index.sha256,replacement.generation);
  assert.equal(restoredStatus.generation,replacement.generation);
  assert.equal(restored.snapshot.sourceRunId,replacement.runId);
  assert.equal(restored.ledger.sha256,ledger.sha256);
  assert.equal(restored.vehicleDelivery.generation,replacement.generation);
  assert(api.calls.slice(fetchedAt).every(({name})=>!name.startsWith('day-')));
  const restoredEvents=archivedDatedDispatch(await restarted.readDay(date,restored),{center:'osan',vehicle:'122',generation:replacement.generation});
  assert.equal(restoredEvents.state,'PUBLISHED_VERIFIED');
  assert.deepEqual(restoredEvents.chronology,[syncSha256(date)]);
  assert.equal(restoredEvents.rows[0].individualCompletedAt,'2026-11-10T16:00:00.000Z');
  const firstRead=api.calls.length;
  const parallel=await Promise.all(Array.from({length:12},()=>restarted.readDay(oldDate,restored)));
  assert(parallel.every(day=>day.visits.length===1));
  parallel[0].visits.length=0;
  assert.equal((await restarted.readDay(oldDate,restored)).visits.length,1);
  assert.equal(api.calls.slice(firstRead).filter(({name})=>name.startsWith('day-')).length,1);
  assert(api.calls.at(-1).name.startsWith('day-'));
  spool=path.join(root,'spool-after-restart');
  await fs.mkdir(spool,{mode:0o700});
  await writer.restoreSpool(spool);
  const restoredWorker=await work();
  assert.equal((await restoredWorker.read()).index.sha256,replacement.generation);
  assert.equal((await restoredWorker.readDay(oldDate)).visits.length,1);
  tick+=3600000;
  const unchanged=await run();
  assert.equal(unchanged.state,'VERIFIED_NOOP');
  assert.equal(unchanged.generation,replacement.generation);
  assert.equal((await writer.readStatus()).run.sourceReadComplete,true);

  const password='stage-scheduler-fixture';
  const env={...storageEnv,OPSMAP_STAGE_SYNC_READ_APPROVED:'1',GITHUB_TOKEN:'fixture',
    GITHUB_CACHE_REPO:'mingu0702-droid/freshon-cache',OPSMAP_MANUAL_PIN_GITHUB_BRANCH:'stage/opsmap-manual-pins',
    MAP_STAFF_ID:'fixture',MAP_STAFF_PASSWORD_HASH:await createStaffPasswordHash(password),
    MAP_STAFF_SESSION_SECRET:randomBytes(32).toString('base64url')};
  let release, headRequests=0, headOffline=false;
  const delayedHead=new Promise(resolve=>{release=resolve;});
  const createStage=async()=>{
    const app=createStageVerificationApp({env,now,snapshotWaitMs:100,async fetchImpl(input, options){
      const pathname=new URL(input).pathname;
      if(pathname.endsWith('/map-snapshot-v1.json'))return new Response(null,{status:503});
      if(pathname.endsWith('/head-v1.json')){
        headRequests++;
        await delayedHead;
        if(headOffline)return new Response(null,{status:503});
      }
      return api.fetchImpl(input,options);
    },async readHub(){throw Error('HUB_FORBIDDEN');}});
    const base=(await listen(t,app))+'/opsmap/api/map-phase2b';
    app.emit('opsmap-stage-listening');
    return base;
  };
  const base=await createStage();
  assert.equal((await fetch(base+'/preview/snapshot')).status,401);
  assert.equal((await fetch(base+'/private/stage-vehicle-delivery-evidence?generation='+replacement.generation)).status,401);
  const login=await fetch(base+'/auth/login',{method:'POST',headers:{Origin:STAGE_ORIGIN,'Content-Type':'application/json'},
    body:JSON.stringify({id:'fixture',password})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const request=(root,suffix)=>fetch(root+suffix,{headers:{cookie,'sec-fetch-site':'same-origin'}});
  const pending=await request(base,'/preview/snapshot');
  assert.equal(pending.status,503);
  assert.equal(pending.headers.get('retry-after'),'2');
  assert.deepEqual(await pending.json(),{error:'PHASE2B_SNAPSHOT_RESTORING',recovery:'RESTORING'});
  assert.equal(headRequests,1);
  release();
  const waitForSnapshot=async root=>{
    for(let attempt=0;attempt<40;attempt++){
      const response=await request(root,'/preview/snapshot');
      if(response.status===200)return response.json();
      assert.equal(response.status,503);
      assert.deepEqual(await response.json(),{error:'PHASE2B_SNAPSHOT_RESTORING',recovery:'RESTORING'});
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.fail('Snapshot did not recover after the fixture was released');
  };
  const get=async suffix=>{
    const response=await fetch(base+suffix,{headers:{cookie,'sec-fetch-site':'same-origin'}});
    assert.equal(response.status,200,suffix);
    return response.json();
  };
  const copies=await Promise.all(Array.from({length:4},()=>waitForSnapshot(base)));
  const [snapshot]=copies;
  assert(copies.every(value=>value.meta.sourceGeneration===replacement.generation && value.data.length===1));
  assert.equal(snapshot.meta.sourceGeneration,replacement.generation);
  assert.equal(snapshot.meta.sourceRunId,replacement.runId);
  assert.equal(snapshot.data[0].confirmedVehicle,'122');
  for(const days of [30,60,90]){
    const coverage=await get('/private/shadow-coverage/view?days='+days+'&box=126.9,37.1,127.2,37.3');
    assert.equal(coverage.data.generation,replacement.generation);
    assert.equal(coverage.data.sourceRunId,replacement.runId);
  }
  const evidence=await get('/private/stage-sync-evidence');
  assert.equal(evidence.scheduled.sourceRunId,replacement.runId);
  assert.equal(evidence.scheduled.run.runId,unchanged.runId);
  assert.equal(evidence.scheduled.lastFailure.code,'FIXED_STORE_WRITE');
  assert.equal(evidence.sources['delivery:4'].error,null);
  assert(evidence.sources['delivery:4'].lastFailureAt);
  assert(evidence.sources.customerRegistry.lastSuccessAt);
  assert.equal(evidence.coverage.registered,1);
  assert.equal(evidence.coverage.located,1);
  const deliveries=await get('/private/stage-vehicle-delivery-evidence?vehicle=122&limit=1&generation='+replacement.generation);
  assert.equal(deliveries.sourceRunId,replacement.runId);
  assert.equal(deliveries.rows[0].actualVehicle,'122');
  assert.equal(deliveries.rows[0].customerCode,code);
  assert.equal(deliveries.nextOffset,null);
  assert.deepEqual(deliveries.fixedRows,[]);
  const outside=await get('/private/stage-vehicle-delivery-evidence?box=128,37,129,38&generation='+replacement.generation);
  assert.deepEqual(outside.rows,[]);
  const stale=await fetch(base+'/private/stage-vehicle-delivery-evidence?generation='+baseline.index.sha256,{headers:{cookie}});
  assert.equal(stale.status,409);

  headOffline=true;
  const cold=await createStage();
  const failed=await request(cold,'/preview/snapshot');
  assert.equal(failed.status,503);
  assert.deepEqual(await failed.json(),{error:'PHASE2B_SNAPSHOT_UNAVAILABLE',recovery:'UNAVAILABLE'});
  assert.equal((await get('/preview/snapshot')).meta.sourceGeneration,replacement.generation);
  headOffline=false;
  const restart=await createStage();
  const recovered=await waitForSnapshot(restart);
  assert.equal(recovered.meta.sourceGeneration,replacement.generation);

  const head=[...api.files].find(([name])=>name.endsWith('/head-v1.json'));
  const {current}=JSON.parse(head[1].data);
  const bad=[...api.files].find(([name])=>name.endsWith('/release-'+current.blob+'.json'));
  bad[1].data=Buffer.from('{}');
  assert.equal((await reader().read()).index.sha256,baseline.index.sha256);
});

test('Delivery restartable login uses existing account only with explicit date-read approval',async()=>{
  const env={...stage,OPSMAP_STAGE_DELIVERY_DATED_ENABLED:'1',OPSMAP_STAGE_DELIVERY_PHOTO_USE_EXISTING_ADMIN:'1',
    DELIVERY_ADMIN_ID:'fixture-user',DELIVERY_ADMIN_PASSWORD:'fixture-password'};
  assert.equal(createStageDatedDeliveryReader({env}).configured,false);
  const calls=[];
  let wrongCenter=false;
  const read=createStageDatedDeliveryReader({env:{...env,OPSMAP_STAGE_DELIVERY_DATED_REUSE_APPROVED:'1'},
    syncCenters:SYNC_DELIVERY_SOURCES,async fetchImpl(url,options){
      assert.equal(url.origin,'https://delivery-bali.chabyulhwa.com');
      calls.push(url.pathname);
      if(url.pathname==='/api/auth/login'){
        assert.equal(options.method,'POST');
        return Response.json({token:'fixture-token'});
      }
      assert.equal(options.method,'GET');
      if(wrongCenter&&url.searchParams.get('logisticsCenterId')==='3') {
        return Response.json({content:[{id:1,customer:{erpCode:code},carrier:{enteringDatedAt:date,logisticsCenterId:1}}],
          totalElements:1,totalPages:1});
      }
      return Response.json({content:[],totalElements:0,totalPages:0});
    }});
  const result=await read.readObservation(date);
  assert.deepEqual(result.completeCenters,['osan','yeongnam','honam']);
  assert.deepEqual(result.completeSources,['1','2','3','4']);
  assert.equal(completeSyncObservation(result,undefined,['1','2','3','4']),true);
  assert.equal(completeSyncObservation({...result,completeSources:['1','3','4']},undefined,['1','2','3','4']),false);
  assert.equal(result.sourceRows,0);
  assert.equal(calls.filter(item=>item==='/api/auth/login').length,1);
  assert.equal(calls.filter(item=>item==='/api/bali/task').length,4);
  wrongCenter=true;
  await assert.rejects(read.readObservation(date),{code:'DELIVERY_SOURCE_SCOPE',date,center:'yeongnam',sourceId:'3'});
});

test('route evidence separates trucks and same-building customer codes and keeps missing scope unverified',()=>{
  const addressHash=archiveAddressHash(address), second='T99112', end='2026-11-11';
  const start='2026-08-14', dates=['2026-11-09','2026-11-11'];
  const observedDates={all:dates,osan:dates,yeongnam:[],honam:[]};
  const collector=collectOpsmapVehicleDelivery(end,new Map([[code,addressHash],[second,addressHash]]));
  const rows=(vehicle)=>[[syncSha256(vehicle),code,vehicle,'osan',addressHash]];
  collector.add({date:dates[0],visits:rows('101')});
  collector.add({date:dates[1],visits:[...rows('122'),[syncSha256(second),second,'122','osan',addressHash],
    [syncSha256('stale'),code,'202','osan',syncSha256('different-address')]]});
  const generation=syncSha256('delivery-fixture');
  const registry=new Map([code,second].map(k=>[k,{hasPoint:true,lat:37.15,lng:127.06}]));
  const actual=readOpsmapVehicleDelivery(JSON.stringify(collector.finish(generation,observedDates)),{
    generation,registry,window:{start,end,observedDates}
  });
  const {rows:page,completeSources,total}=opsmapVehicleDeliveryPage(actual,registry);
  assert.equal(total,3);
  assert.deepEqual(page.map(row=>[row.customerCode,row.actualVehicle,row.deliveryDates,row.deliveryWeekdays]),
    [[code,'101',[dates[0]],[1]],[code,'122',[dates[1]],[3]],[second,'122',[dates[1]],[3]]]);
  assert.deepEqual(completeSources,{'1':[],'2':[],'3':[],'4':[]});
});

test('scheduled Delivery retries a transient server failure once and records a permission failure without retry',async()=>{
  let calls=0,forbidden=false;
  const records=[];
  const delivery=createStageDatedDeliveryReader({
    env:{...stage,OPSMAP_STAGE_DELIVERY_DATED_ENABLED:'1',OPSMAP_STAGE_DELIVERY_DATED_COOKIE:'fixture'},
    recordSource:(key,day,error)=>records.push([key,day,error?.code||null]),
    async fetchImpl(){
      calls++;
      if(forbidden)return new Response(null,{status:403});
      if(calls===1)return new Response(null,{status:503});
      return Response.json({content:[],totalElements:0,totalPages:1});
    }
  });
  assert.equal((await delivery.readObservation(date)).sourceRows,0);
  assert.equal(calls,2);
  forbidden=true;
  await assert.rejects(delivery.readObservation(date),{code:'DELIVERY_SOURCE_FORBIDDEN'});
  assert.equal(calls,3);
  assert.deepEqual(records,[['delivery:1',date,null],['delivery:1',date,'DELIVERY_SOURCE_FORBIDDEN']]);
});

test('21:00 loads the next dispatch, midnight replaces drafts, and a failed source keeps the last generation',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'opsmap-dispatch-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const spool=path.join(root,'spool'), tomorrow='2026-11-12';
  await fs.mkdir(spool,{mode:0o700});
  const seed=await seedFor(root);
  const newCode='T99112', newAddress='경기도 오산시 검증로 92', movedAddress='경기도 오산시 검증로 93';
  let tick=Date.parse(date+'T20:59:59.999+09:00'), registryNew=false, fail=false;
  const queried=[];
  const now=()=>tick;
  const row=(customerCode,basicAddress)=>({customerCode,customerName:'격리 매장',basicAddress,lifecycle:'ACTIVE'});
  const verifiedPoints=[{customerCode:code,address:movedAddress,lat:37.15},{customerCode:newCode,address:newAddress,lat:37.16}];
  const updatedLedger=reviseFixedCoordinateLedger(ledger,{expectedRevision:0,updatedAt:date+'T12:00:00Z',rows:verifiedPoints.map(point=>({
    customerCode:point.customerCode,addressHash:coordinateAddressHash(point.address),lat:point.lat,lng:127.06,
    coordinateSource:'BUILDING_VERIFIED',coordinateAccuracy:'BUILDING',evidenceSource:'OFFICIAL_ADDRESS_DATA',
    evidenceSha256:'a'.repeat(64),observedAt:date+'T10:00:00Z',verifiedAt:date+'T12:00:00Z',measurementKind:'BUILDING_LOCATION'
  }))});
  const worker=await createOpsmapDataSync({directory:spool,seed,now,includeOfficialRegions:false,readLedger:async()=>ledger,
    async readRegistry(){
      const rows=registryNew?[row(code,movedAddress),row(newCode,newAddress)]:[row(code,address)];
      return {complete:true,version:syncDigest(rows),rows};
    },
    completeCoordinates:async input=>({stores:input.stores,ledger:registryNew?updatedLedger:input.ledger}),
    async readDay(day) {
      queried.push(day);
      if (fail && day===tomorrow) throw Error('DELIVERY_SOURCE_FORBIDDEN');
      if(day!==tomorrow)return observation(day);
      const base=observation(day);
      const isActual=Date.parse(tomorrow+'T00:00:00+09:00')<=tick;
      const id=syncSha256(isActual?'reassigned-at-midnight':'planned-stop');
      const tasks=[[id,newCode,'202','osan',coordinateAddressHash(newAddress),isActual?'COMPLETED':'OPEN']];
      return {...base,tasks,proofHash:syncDigest(tasks),
        visits:isActual?[[id,newCode,'202','osan',archiveAddressHash(newAddress)]]:[]};
    }});
  const run=()=>worker.sync({scheduledRun:verifyOpsmapScheduleReceipt(signed(tick),{...clock,now})});
  assert.equal(opsmapDispatchDate(tick),date);
  await run();
  assert.deepEqual(queried,[previousDate,date]);
  registryNew=true;
  tick++;
  assert.equal(opsmapDispatchDate(tick),tomorrow);
  fail=true;
  const prior=await worker.read();
  await assert.rejects(run(),/DELIVERY_SOURCE_FORBIDDEN/);
  assert.equal((await worker.read()).index.sha256,prior.index.sha256);
  fail=false;
  await run();
  const evening=await worker.read();
  assert.deepEqual(evening.state.plannedDates,[tomorrow]);
  assert.equal(evening.index.asOf,date);
  assert.equal(evening.ledger.sha256,updatedLedger.sha256);
  assert.equal(evening.snapshot.rows.find(row=>row.customerCode===newCode).lat,37.16);
  assert.equal(evening.snapshot.rows.find(row=>row.customerCode===code).originalAddressHash,coordinateAddressHash(movedAddress));
  assert.equal((await worker.readDay(tomorrow)).planningOnly,true);
  assert.equal((await worker.readDay(tomorrow)).visits.length,0);
  tick=Date.parse(tomorrow+'T00:00:00+09:00');
  assert.equal(opsmapDispatchDate(tick),tomorrow);
  await run();
  const midnight=await worker.read();
  const day=await worker.readDay(tomorrow);
  assert.equal(midnight.state.plannedDates,undefined);
  assert.equal(midnight.index.asOf,tomorrow);
  assert.equal(day.visits.length,1);
  assert.equal(day.visits[0][2],'202');
  const coverage=createShadowCoverageStore({directory:midnight.coverage});
  for(const days of [30,60,90]) {
    const {index,window}=await coverage.readPeriod(days);
    assert.equal(index.sha256,midnight.snapshot.sourceGeneration);
    assert.equal(window.end,tomorrow);
    assert.equal(window.completed,2);
  }
});
