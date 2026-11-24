import assert from 'node:assert/strict';
import test from 'node:test';
import {createStageScheduledJobs,signStageScheduledTask,stageSyncHeadroom,verifyStageScheduledTask,stageWmsNightDate,stageWmsNightWindow} from '../src/stageScheduledJobs.js';

const start=Date.parse('2026-11-23T21:33:00Z');
const MiB=1024*1024;
const secret='synthetic-schedule-test-secret-00000';
const receipt={date:'2026-11-24',runId:'0'.repeat(64),issuedAt:new Date(start).toISOString()};
const memory=bytes=>({bytes:bytes*MiB,limit:512*MiB,measured:'synthetic'});

function fixture(fileName='fixed-master-daily-v1/jobs-2026-11-24.json'){
  let value=null,version=0;
  const store={
    async read(file){
      assert.equal(file,fileName);
      return {value:structuredClone(value),sha:value?version:null};
    },
    async write(file,next,expected){
      assert.equal(file,fileName);
      if(expected!==(value?version:null))throw Object.assign(Error('CAS conflict'),{code:'FIXED_STORE_CONFLICT'});
      version++;
      value=structuredClone(next);
    }
  };
  return {store,inspect:()=>value,tamper:()=>{value.jobs[0].state='PUBLISHED';}};
}

test('checkpoint acceptance survives restart and resumes pending jobs without replaying a spent source budget',async()=>{
  const {store,inspect}=fixture();
  let clock=start,releaseInterrupted;
  const opened=[];
  let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const setup={store,secret,now:()=>clock,measure:async()=>memory(272),log(){}};
  const first=createStageScheduledJobs({...setup,async execute({kind}){
    opened.push(kind);
    if(kind==='fixed'){
      entered();
      await new Promise(resolve=>{releaseInterrupted=resolve;});
    }
    return {state:'PUBLISHED'};
  }});
  const duplicate=createStageScheduledJobs({...setup,execute:()=>assert.fail('unclaimed duplicate')});
  const plan=['recent','fixed','national','wms'];
  await Promise.all([first.accept(receipt,plan),duplicate.accept(receipt,plan)]);
  await duplicate.accept(receipt,['recent']);
  await first.drain();
  const abandoned=first.drain();
  await started;
  await assert.rejects(duplicate.accept({...receipt,runId:'1'.repeat(64)},['fixed']),/CONFLICT/);
  assert.equal(inspect().jobs[1].state,'RUNNING');
  assert.ok((await duplicate.drain()).nextAt>clock);
  clock+=91_000;
  const resumed=createStageScheduledJobs({...setup,async execute({kind}){
    opened.push(kind);
    return {state:'VERIFIED_NOOP'};
  }});
  await resumed.drain();
  await resumed.drain();
  await resumed.drain();
  assert.deepEqual(opened,['recent','fixed','national','wms']);
  assert.deepEqual(inspect().jobs.map(job=>job.state),['PUBLISHED','INTERRUPTED','VERIFIED_NOOP','VERIFIED_NOOP']);
  assert.deepEqual(await resumed.drain(),{done:true});
  releaseInterrupted();
  await assert.rejects(abandoned,/LEASE_LOST/);
  assert.equal(inspect().jobs[1].state,'INTERRUPTED');
});

test('high cgroup memory defers the pending job before any source runs and the meter uses total headroom',async()=>{
  const {store,inspect}=fixture();
  let bytes=350,executed=0;
  const jobs=createStageScheduledJobs({store,secret,now:()=>start,measure:async()=>memory(bytes),log(){},
    async execute(){executed++;return {state:'PUBLISHED'};}});
  assert.equal(stageSyncHeadroom(memory(350)),false);
  assert.equal(stageSyncHeadroom({...memory(200),measured:'web-rss'}),false);
  assert.equal(stageSyncHeadroom(memory(450),true),true);
  assert.equal(stageSyncHeadroom(memory(470),true),false);
  await jobs.accept(receipt,['recent']);
  assert.ok((await jobs.drain()).nextAt>start);
  assert.equal(executed,0);
  assert.equal(inspect().jobs[0].state,'PENDING');
  bytes=296;
  await jobs.drain();
  assert.equal(executed,1);
  assert.equal(inspect().jobs[0].state,'PUBLISHED');
});

test('scheduled job records combined memory at start, sampled peak and end without any extra source call',async()=>{
  const {store,inspect}=fixture();
  let releaseJob;
  const sampled=new Promise(resolve=>{releaseJob=resolve;});
  const readings=[280,410,262];
  const logs=[];
  let calls=0;
  const jobs=createStageScheduledJobs({store,secret,now:()=>start,intervalMs:1,
    async measure(){
      const value=readings.shift();
      if(value===410)releaseJob();
      return memory(value);
    },
    log(value){logs.push(JSON.parse(value));},
    async execute(){
      calls++;
      const deadline=setTimeout(()=>releaseJob(),1000);
      try {await sampled;} finally {clearTimeout(deadline);}
      return {state:'VERIFIED_NOOP'};
    }});
  await jobs.accept(receipt,['wms']);
  await jobs.drain();
  const job=inspect().jobs[0];
  assert.equal(job.state,'VERIFIED_NOOP');
  assert.equal(calls,1);
  assert.deepEqual(job.memory,{measured:'synthetic',limitBytes:512*MiB,startBytes:280*MiB,
    peakSampledBytes:410*MiB,endBytes:262*MiB,samples:3,sampleIntervalMs:2000});
  assert.deepEqual(logs.at(-1).memory,job.memory);
});

test('private checkpoint mutation and task kind or receipt tampering fail closed',async()=>{
  const {store,tamper}=fixture();
  const jobs=createStageScheduledJobs({store,secret,now:()=>start,log(){},execute:()=>assert.fail()});
  await jobs.accept(receipt,['recent']);
  tamper();
  await assert.rejects(jobs.drain(),/INTEGRITY/);
  const task={receipt,scheduledKind:'recent',taskProof:signStageScheduledTask(receipt,'recent',secret)};
  assert.deepEqual(verifyStageScheduledTask(task,secret,()=>start+60*60_000),receipt);
  assert.throws(()=>verifyStageScheduledTask({...task,scheduledKind:'fixed'},secret,()=>start),/TASK_AUTH/);
  assert.throws(()=>verifyStageScheduledTask(task,secret,()=>start+4*60*60_000),/TASK_AUTH/);
});

test('one existing evening tick queues the next day at 21:10 and a second receipt cannot restart it',async()=>{
  const {store,inspect}=fixture('fixed-master-daily-v1/jobs-wms-night-2026-11-24.json');
  let time=Date.parse('2026-11-24T20:34:00+09:00'),calls=0;
  const first={...receipt,issuedAt:new Date(time).toISOString()};
  const at=(text)=>Date.parse('2026-11-24T'+text+'+09:00');
  const opt={night:true};
  const setup={store,secret,now:()=>time,measure:async()=>memory(272),log(){}};
  const jobs=createStageScheduledJobs({...setup,execute:()=>assert.fail('before close+10 minutes')});
  assert.equal(await jobs.accept(first,['wms-night'],opt),first.runId);
  assert.deepEqual(await jobs.drain(undefined,opt),{nextAt:at('21:10:00')});
  time=at('21:09:59');
  assert.deepEqual(await jobs.drain(undefined,opt),{nextAt:at('21:10:00')});
  assert.equal(inspect().jobs[0].state,'PENDING');
  time=at('21:10:00');
  const reopened=createStageScheduledJobs({...setup,async execute({receipt,kind}){
    assert.equal(kind,'wms-night');
    assert.equal(stageWmsNightDate(receipt,time),'2026-11-25');
    const task={receipt,scheduledKind:kind,taskProof:signStageScheduledTask(receipt,kind,secret)};
    assert.deepEqual(verifyStageScheduledTask(task,secret,()=>time),first);
    calls++;
    return {state:'VERIFIED_NOOP'};
  }});
  await reopened.drain(undefined,opt);
  time=at('21:35:00');
  const second={...first,runId:'1'.repeat(64),issuedAt:new Date(time).toISOString()};
  assert.equal(await reopened.accept(second,['wms-night'],opt),first.runId);
  assert.deepEqual(await reopened.drain(undefined,opt),{done:true});
  assert.equal(calls,1);
  assert.equal(inspect().jobs[0].state,'VERIFIED_NOOP');
});

test('lack of space can miss the night slot without a daytime catchup',async()=>{
  const {store,inspect}=fixture('fixed-master-daily-v1/jobs-wms-night-2026-11-24.json');
  let time=Date.parse('2026-11-24T21:54:00+09:00');
  const opt={night:true};
  const tick={...receipt,issuedAt:new Date(time).toISOString()};
  const jobs=createStageScheduledJobs({store,secret,now:()=>time,measure:async()=>memory(350),log(){},
    execute:()=>assert.fail('must not run')});
  await assert.rejects(()=>jobs.accept(tick,['wms-night','recent'],opt),/OPSMAP_JOBS_RECEIPT/);
  await jobs.accept(tick,['wms-night'],opt);
  assert.ok((await jobs.drain(undefined,opt)).nextAt>time);
  time=Date.parse('2026-11-24T22:00:00+09:00');
  assert.deepEqual(await jobs.drain(undefined,opt),{done:true});
  assert.equal(inspect().jobs[0].error,'WMS_NIGHT_WINDOW_MISSED');
  time=Date.parse('2026-11-25T06:13:00+09:00');
  assert.throws(()=>stageWmsNightDate(tick,time),/WMS_NIGHT_WINDOW_MISSED/);
  assert.equal(stageWmsNightWindow({...receipt,issuedAt:'2026-11-24T10:00:00+09:00'}),null);
  assert.equal(stageWmsNightWindow({...receipt,date:'2026-11-30',issuedAt:'2026-11-30T21:11:00+09:00'}).date,'2026-12-01');
});
