import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import express from 'express';
import {createStageDailyFixedMasterReader,createStageFixedMasterSource,stageFixedMasterScope,stageFixedMasterStorage,syncStageFixedMaster}
  from '../src/stageFixedMasterSync.js';
import {fixedEnvelope} from '../src/fixedVehicleStore.js';
import {projectFixedVehicles} from '../src/fixedVehicleProjection.js';
import {createFixedVehicleCache} from '../src/opsmap-abc/fixedVehicleCache.js';
import {mountOpsmapScheduledRun,OPSMAP_SCHEDULED_ROUTE} from '../src/opsmapScheduledRun.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../src/stageScope.js';

const sha=(text,length=64)=>createHash(length===64?'sha256':'sha1').update(text).digest('hex');
const codes=['S10001','S10002','S10003'], centers=['011','012','013'], head='fixed-master-daily-v1/head.json';
const origin='APPS_SCRIPT_TIME_TRIGGER', triggerId='2468', executor=sha('fixture-executor'), hmac='fixture-hmac'.repeat(4);
const env={RENDER_SERVICE_ID:STAGE_SERVICE,RENDER_EXTERNAL_URL:STAGE_ORIGIN,OPSMAP_STAGE_FIXED_MASTER_SYNC_APPROVED:'1',
  OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED:'1',OPSMAP_STAGE_SYNC_PUBLISH_APPROVED:'1',OPSMAP_STAGE_SYNC_REMOTE_APPROVED:'1',
  OPSMAP_STAGE_SYNC_TRIGGER_ID:triggerId,OPSMAP_STAGE_SYNC_EXECUTOR_SHA256:executor,OPSMAP_STAGE_SYNC_SCHEDULER_SECRET:hmac,
  OPSMAP_STAGE_SYNC_READ_TOKEN:'fixture-reader',OPSMAP_STAGE_SYNC_WRITE_TOKEN:'fixture-writer'};
const start=Date.parse('2026-11-08T07:00:00Z'), hour=3600000;
function receipt(t) {
  const date=new Date(t+9*hour).toISOString().slice(0,10), issuedAt=new Date(t).toISOString(), slot=Math.floor(t/hour);
  const runId=sha(JSON.stringify([1,origin,triggerId,executor,slot]));
  return {version:1,origin,triggerId,principal:executor,date,issuedAt,slot,runId,
    signature:createHmac('sha256',hmac).update(JSON.stringify([1,origin,triggerId,executor,issuedAt,slot,date,runId])).digest('hex')};
}
const ledger={sha256:sha('ledger'),records:{[codes[0]]:[{point:{}}]}};
const active={expiresAt:Infinity,ledger,generation:sha('verified registry'),
  registry:new Map(codes.map(code=>[code,{hasPoint:true}])),counts:{registered:codes.length}};
const scope=stageFixedMasterScope(active);
const raw=(route='101')=>codes.map((code,i)=>({estCd:code,logCd:centers[i],mainCarSeqNm:i===0?route:'102',
  carSeqMonNm:'용09',carSeqTueNm:'오산신규',carSeqSatNm:'122',carSeqSunNm:'122'}));
function source(route) {
  const data=projectFixedVehicles(raw(route));
  return {data,meta:{readHttp:200,sourceRows:3,uniqueCustomers:data.length,centers:
    centers.map(center=>({center,declaredRows:1,sourceRows:1,pages:1,duplicateCustomerRows:0}))}};
}
function memory() {
  const files=new Map(), reads=new Map();
  return {files,reads,
    async read(name) {
      reads.set(name,(reads.get(name)||0)+1);
      const saved=files.get(name);
      return saved?structuredClone(saved):{value:null,sha:null};
    },
    async write(name,value,previous) {
      if ((files.get(name)?.sha||null)!==previous) throw Object.assign(Error(),{code:'FIXED_STORE_CONFLICT'});
      files.set(name,{value:structuredClone(value),sha:sha(JSON.stringify(value),40)});
    }};
}
const base=() => fixedEnvelope(source('099').data,new Date(start-hour).toISOString());
const reader=baseValue=>({load:async()=>baseValue??null});

test('complete daily projection is scoped, single-flight, and a no-change day verifies without a new object',async ()=>{
  let tick=start, calls=0;
  const store=memory(), baseline=base(), now=()=>tick;
  const doRun=(readMaster)=>syncStageFixedMaster({store,receipt:receipt(tick),now,scope,
    readMaster,loadBaseline:reader(baseline).load});
  let begin, finish;
  const entered=new Promise(r=>{begin=r;}), gate=new Promise(r=>{finish=r;});
  const flight=doRun(async()=>{calls++;begin();await gate;return source('122');});
  await entered;
  assert.equal((await doRun(async()=>assert.fail('duplicate called source'))).state,'BUSY');
  finish();
  const first=await flight;
  assert.equal(stageFixedMasterScope({...active,expiresAt:start}),null);
  assert.equal(first.state,'PUBLISHED');
  assert.equal(first.matchedCount,3);
  assert.equal(first.missingCount,0);
  assert.equal((await doRun(async()=>assert.fail('same day called source'))).state,'ALREADY_VERIFIED');
  assert.equal(calls,1);
  const latest=createStageDailyFixedMasterReader({store,baseline:reader(baseline)});
  const cache=createFixedVehicleCache({readOnly:true,reloadReadOnlyAfterMs:300_000,ttl:26*hour,now,store:latest});
  const initial=await cache.get([codes[0]]);
  assert.equal(initial.data[0].baseVehicle,'122');
  assert.equal(initial.data[0].weekdays.Mon,'용09');
  assert.equal(initial.meta.stale,false);
  const object=[...store.files.keys()].find(name=>name.includes('projection'));
  const reads=store.reads.get(object);
  tick+=6*60_000;
  await cache.get([codes[0]]);
  assert.equal(store.reads.get(object),reads,'routine polling never fetches the projection again');
  tick=start+24*hour;
  const same=await doRun(async()=>source('122'));
  assert.equal(same.state,'VERIFIED_NOOP');
  assert.equal(same.version,first.version);
  assert.equal(store.files.size,2);
  const after=await cache.get([codes[0]]);
  assert.equal(after.meta.checkedAt,new Date(tick).toISOString());
  assert.equal(after.meta.sourceObservedAt,new Date(tick).toISOString());
  assert.equal(after.meta.scheduledRunId,receipt(tick).runId);
  assert.equal(after.meta.registryGeneration,scope.generation);
  assert.equal(after.meta.sourceAsOf,null);
  const lastVerifiedAt=after.meta.scheduledLastSuccessAt;
  const read=store.read;
  store.read=async name=>{
    if (name===head) throw Error('FIXED_STORE_READ');
    return read(name);
  };
  tick+=6*60_000;
  const retained=await cache.get([codes[0]]);
  assert.equal(retained.meta.checkedAt,lastVerifiedAt);
  assert.equal(retained.meta.scheduledLastSuccessAt,lastVerifiedAt);
  assert.equal(retained.meta.lastError,'FIXED_STORE_READ');
  assert.equal(retained.meta.stale,true);
});

test('partial pages, authorization errors and restart preserve the last published generation',async ()=>{
  const store=memory();
  let tick=start;
  const now=()=>tick, baseline=base();
  const doRun=readMaster=>syncStageFixedMaster({store,receipt:receipt(tick),now,scope,readMaster,
    loadBaseline:reader(baseline).load});
  await doRun(async()=>source('122'));
  tick+=24*hour;
  const incomplete=source('202');
  incomplete.meta.centers[1].declaredRows=2;
  await assert.rejects(doRun(async()=>incomplete),/FIXED_MASTER_DAILY_INCOMPLETE/);
  assert.equal((await doRun(async()=>assert.fail('same receipt retried'))).state,'RETRY_HELD');
  tick+=hour;
  await assert.rejects(doRun(async()=>{throw Error('FIXED_MASTER_FORBIDDEN');}),/FIXED_MASTER_FORBIDDEN/);
  tick+=hour;
  assert.equal((await doRun(async()=>assert.fail('auth denied twice'))).state,'RETRY_HELD');
  const restored=createStageDailyFixedMasterReader({store,baseline:reader(baseline)});
  const view=createFixedVehicleCache({readOnly:true,now,store:restored});
  const data=await view.get([codes[0]]);
  assert.equal(data.data[0].baseVehicle,'122');
  assert.equal(data.meta.stale,true);
  assert.equal(data.meta.scheduledLastSuccessAt,new Date(start).toISOString());
  assert.equal(data.meta.sourceObservedAt,new Date(start).toISOString());
  assert.equal(data.meta.lastError,'FIXED_MASTER_FORBIDDEN');
  assert.equal(data.meta.scheduledLastFailureAt,new Date(tick-hour).toISOString());
});

test('a corrupt active object cannot hide a recoverable previous generation after restart',async ()=>{
  const store=memory();
  let tick=start;
  const doRun=route=>syncStageFixedMaster({store,receipt:receipt(tick),now:()=>tick,scope,
    readMaster:async()=>source(route),loadBaseline:reader(base()).load});
  const first=await doRun('122');
  tick+=24*hour;
  const second=await doRun('202');
  const name='fixed-master-daily-v1/projection-'+second.version+'.json';
  store.files.get(name).value.rows[0][1]='999';
  const reopened=createStageDailyFixedMasterReader({store,baseline:reader(null)});
  const cache=createFixedVehicleCache({store:reopened,now:()=>tick,readOnly:true});
  const restored=await cache.get([codes[0]]);
  assert.equal(restored.meta.version,first.version);
  assert.equal(restored.meta.scheduledRunId,null);
  assert.equal(restored.meta.sourceObservedAt,null);
  assert.equal(reopened.status().state,'READ_FAILED');
  assert.equal(store.files.get(head).value.current.version,second.version);
});

test('an unresolved known assignment never overwrites the approved baseline',async ()=>{
  const store=memory(), baseline=base(), result=source();
  result.data[0].baseVehicle='';
  result.data[0].baseVehicleState='UNASSIGNED';
  await assert.rejects(syncStageFixedMaster({store,receipt:receipt(start),now:()=>start,scope,
    readMaster:async()=>result,loadBaseline:reader(baseline).load}),/FIXED_MASTER_DAILY_ASSIGNMENT_GAP/);
  const reopened=createStageDailyFixedMasterReader({store,baseline:reader(baseline)});
  assert.equal((await reopened.load()).version,baseline.version);
  assert.equal(store.files.size,1);
  assert.equal(reopened.status().state,'FAILED');
});

test('the verified registry includes stores without ledger overrides and records actual source absence',async ()=>{
  const store=memory();
  const absentCode='S10004';
  const activeRegistry=new Map([...active.registry,[absentCode,{hasPoint:true}]]);
  const all=stageFixedMasterScope({...active,registry:activeRegistry,counts:{registered:activeRegistry.size}});
  const result=await syncStageFixedMaster({store,receipt:receipt(start),now:()=>start,scope:all,
    async readMaster(requested){
      assert.deepEqual([...requested],[...codes,absentCode]);
      return source();
    },loadBaseline:reader(base()).load});
  assert.equal(result.ledgerCount,4);
  assert.equal(result.matchedCount,3);
  assert.equal(result.missingCount,1);
  const master=createStageDailyFixedMasterReader({store,baseline:reader(null)});
  const cache=createFixedVehicleCache({store:master,now:()=>start,readOnly:true});
  const values=await cache.get([codes[2],absentCode]);
  assert.equal(values.data[0].baseVehicle,'102');
  assert.equal(values.data[1].baseVehicleState,'NOT_IN_MASTER');
  assert.equal(values.data[1].baseVehicle,'');
});

test('a delayed scan has a bounded lease and completion across midnight still counts once that day',async ()=>{
  const store=memory();
  let tick=Date.parse('2026-11-12T14:50:00Z');
  const now=()=>tick;
  const doRun=readMaster=>syncStageFixedMaster({store,receipt:receipt(tick),now,scope,readMaster,loadBaseline:reader(null).load});
  let entered, complete;
  const ready=new Promise(resolve=>{entered=resolve;});
  const hold=new Promise(resolve=>{complete=resolve;});
  const first=doRun(async()=>{entered();await hold;return source();});
  await ready;
  tick+=35*60_000;
  assert.equal((await doRun(()=>assert.fail('the first run still owns the lease'))).state,'BUSY');
  complete();
  assert.equal((await first).state,'PUBLISHED');
  tick+=hour;
  assert.equal((await doRun(()=>assert.fail('a success already completed today'))).state,'ALREADY_VERIFIED');
});

test('the source reads only the scoped FreshOn form with at most one authorized login recovery',async ()=>{
  let calls=0, logins=0;
  const read=createStageFixedMasterSource({env:{...env,FRESHON_COOKIE:'initial',FRESHON_ID:'fixture',
    FRESHON_PASSWORD:'fixture'},login:async()=>{logins++;return {cookie:'renewed'};},
    async fetchImpl(url,options) {
      assert.equal(url,'https://mis.freshon.co.kr/bo/wm/standard/fixedAlctnList');
      assert.equal(options.method,'POST');
      assert.equal(options.redirect,'manual');
      const params=new URLSearchParams(options.body);
      if (++calls===1) {
        assert.equal(options.headers.Cookie,'initial');
        return new Response(null,{status:302,headers:{Location:'/login'}});
      }
      assert.equal(options.headers.Cookie,'renewed');
      const index=centers.indexOf(params.get('logCd'));
      return Response.json({data:[{...raw()[index],totalCnt:1}]});
    }});
  const result=await read(new Set([codes[1]]));
  assert.equal(calls,4);
  assert.equal(logins,1);
  assert.equal(result.meta.uniqueCustomers,3);
  assert.deepEqual(result.data.map(row=>row.customerCode),[codes[1]]);
  assert.throws(()=>createStageFixedMasterSource({env:{...env,FRESHON_BASE_URL:'https://example.invalid'}}),/SOURCE_SCOPE/);
});

test('an unstable final page and an oversized source reply cannot certify a new master',async ()=>{
  let tailReads=0;
  const rows=Array.from({length:1000},(_,i)=>({estCd:'S'+(10001+i),totalCnt:1001,mainCarSeqNm:'122'}));
  const read=createStageFixedMasterSource({env:{...env,FRESHON_COOKIE:'fixture'},async fetchImpl(_url,options){
    const query=new URLSearchParams(options.body);
    assert.equal(query.get('logCd'),'011');
    if (query.get('page')==='0') return Response.json({data:rows});
    return Response.json({data:[{estCd:'S11001',totalCnt:1001,mainCarSeqNm:++tailReads%2?'122':'202'}]});
  }});
  await assert.rejects(read(new Set(codes)),/FIXED_MASTER_SOURCE_CHANGED/);
  assert.equal(tailReads,4);
  let calls=0;
  const oversized=createStageFixedMasterSource({env:{...env,FRESHON_COOKIE:'fixture'},async fetchImpl(){
    calls++;
    return new Response('never consumed',{headers:{'content-length':'9000000'}});
  }});
  await assert.rejects(oversized(new Set(codes)),/FIXED_MASTER_DAILY_PAGE_LIMIT/);
  assert.equal(calls,1);
});

test('private GitHub guard exposes no Production or legacy-file writes',async ()=>{
  const calls=[];
  const readOnly=stageFixedMasterStorage({env,async fetchImpl(url,options){
    calls.push([url,options.method||'GET',options.redirect]);
    if (calls.length===1) return Response.json({private:true});
    return new Response(null,{status:404});
  }});
  assert.equal(typeof readOnly.write,'undefined');
  assert.equal((await readOnly.read(head)).value,null);
  assert.ok(calls[1][0].endsWith('/fixed-master-daily-v1/head.json?ref=stage%2Fopsmap-snapshots'));
  assert.ok(calls.every(x=>x[2]==='error'));
  const writer=stageFixedMasterStorage({env,write:true,async fetchImpl(url,options){
    assert.equal(options.method,undefined);
    assert.ok(!url.includes('/contents/'));
    return Response.json({private:true});
  }});
  await assert.rejects(writer.write('fixed-vehicle-projection-v1.json',{},null),/FIXED_STORE_NETWORK/);
  assert.throws(()=>stageFixedMasterStorage({env:{...env,RENDER_SERVICE_ID:'different'},write:true}),/APPROVAL/);
});

test('the existing Stage receipt route passes only the verified registry scope to a fixed-only child',async t=>{
  const app=express(), logs=[];
  let child, input='', approvedScope=null;
  mountOpsmapScheduledRun(app,{env,now:()=>start,readFixedScope:()=>approvedScope,
    log:value=>logs.push(JSON.parse(value)),launch(exec,args,options) {
      assert.equal(exec,process.execPath);
      assert.deepEqual(args.slice(1),['fixed-scheduled']);
      assert.equal(options.stdio[1],'pipe');
      child=new EventEmitter();
      child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.stdin.on('data',bytes=>{input+=bytes;});
      return child;
    }});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=value=>fetch('http://127.0.0.1:'+server.address().port+OPSMAP_SCHEDULED_ROUTE,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  const signed=receipt(start);
  assert.equal((await post({...signed,signature:sha('bad')})).status,403);
  assert.equal((await post(signed)).status,503);
  assert.equal(child,undefined);
  approvedScope=scope;
  assert.equal((await post(signed)).status,202);
  assert.deepEqual(JSON.parse(input),{receipt:signed,fixedScope:scope});
  child.stdout.write('secret fixture ignored\n'+JSON.stringify({component:'opsmap-fixed-master-sync',state:'PUBLISHED',
    runId:signed.runId,version:sha('version'),private:'ignored'})+'\n');
  child.emit('close',0);
  assert.deepEqual(logs[0],{component:'opsmap-fixed-master-sync',runId:signed.runId,state:'PUBLISHED',version:sha('version'),error:null});
  assert.equal(logs.length,2);
});
