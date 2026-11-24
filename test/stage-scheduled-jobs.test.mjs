import assert from 'node:assert/strict';
import test from 'node:test';
import {createStageScheduledJobs,signStageScheduledTask,stageSyncHeadroom,verifyStageScheduledTask} from '../src/stageScheduledJobs.js';

const start=Date.parse('2026-11-23T21:33:00Z');
const MiB=1024*1024;
const secret='synthetic-schedule-test-secret-00000';
const receipt={date:'2026-11-24',runId:'0'.repeat(64),issuedAt:new Date(start).toISOString()};
const memory=bytes=>({bytes:bytes*MiB,limit:512*MiB,measured:'synthetic'});

function fixture(){
  let value=null,version=0;
  const store={
    async read(file){
      assert.equal(file,'fixed-master-daily-v1/jobs-2026-11-24.json');
      return {value:structuredClone(value),sha:value?version:null};
    },
    async write(file,next,expected){
      assert.equal(file,'fixed-master-daily-v1/jobs-2026-11-24.json');
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
