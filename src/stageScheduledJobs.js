import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const MiB=1024*1024;
const leaseMs=90_000;
const heartbeatMs=25_000;
const retentionMs=3*3600_000;
const dayPattern=/^\d{4}-\d{2}-\d{2}$/;
const hash=/^[a-f0-9]{64}$/;
const kinds=['generation','recent','fixed','national','wms','postal'];
const finished=new Set(['PUBLISHED','VERIFIED_NOOP','ALREADY_VERIFIED','SOURCE_UNAVAILABLE',
  'RECOVERY_CHECKPOINTED','ALREADY_ATTEMPTED','RETRY_HELD','BUSY','FAILED','INTERRUPTED','SKIPPED']);
const kstDay=at=>new Date(at+9*3600_000).toISOString().slice(0,10);
const stateFile=date=>'fixed-master-daily-v1/jobs-'+date+'.json';
const error=code=>Object.assign(Error(code),{code});

const taskStamp=(receipt,kind,secret)=>createHmac('sha256',secret)
  .update('opsmap-stage-jobs-task-v1\0').update(JSON.stringify([receipt,kind])).digest();
export function signStageScheduledTask(receipt,kind,secret) {
  return taskStamp(receipt,kind,secret).toString('hex');
}
export function verifyStageScheduledTask({receipt,scheduledKind,taskProof}={},secret,now=Date.now) {
  const issued=Date.parse(receipt?.issuedAt);
  if(typeof secret!=='string'||secret.length<32||!kinds.includes(scheduledKind)||!hash.test(taskProof||'')||
      !hash.test(receipt?.runId||'')||receipt.date!==kstDay(now())||
      !Number.isFinite(issued)||issued>now()+10*60_000||now()-issued>retentionMs+10*60_000||
      !timingSafeEqual(Buffer.from(taskProof,'hex'),taskStamp(receipt,scheduledKind,secret))) {
    throw error('OPSMAP_JOBS_TASK_AUTH');
  }
  return receipt;
}

export async function stageSyncMemory() {
  const readInt=async file=>{
    try {
      const value=Number((await readFile(file,'utf8')).trim());
      return Number.isSafeInteger(value)&&value>0?value:null;
    } catch {return null;}
  };
  for (const [used,limit] of [
    ['/sys/fs/cgroup/memory.current','/sys/fs/cgroup/memory.max'],
    ['/sys/fs/cgroup/memory/memory.usage_in_bytes','/sys/fs/cgroup/memory/memory.limit_in_bytes']
  ]) {
    const [bytes,max]=await Promise.all([readInt(used),readInt(limit)]);
    if(bytes!==null&&max!==null&&max<=1024*MiB)return {bytes,limit:max,measured:'cgroup'};
  }
  return {bytes:process.memoryUsage.rss(),limit:512*MiB,measured:'web-rss'};
}

export function stageSyncHeadroom({bytes,limit,measured},running=false) {
  if(measured==='web-rss')return false;
  return limit-bytes >= (running?56:180)*MiB;
}

export function createStageScheduledJobs({store,secret,now=Date.now,execute,measure=stageSyncMemory,
  log=console.log,intervalMs=heartbeatMs}={}) {
  if(typeof secret!=='string'||secret.length<32||!store?.read||!store?.write)throw error('OPSMAP_JOBS_CONFIG');
  const stamp=data=>createHmac('sha256',secret).update('opsmap-stage-jobs-v1\0').update(JSON.stringify(data)).digest();
  function verify(value,date) {
    if(!value)return null;
    const {proof,...data}=value;
    if(!hash.test(proof||'')||!timingSafeEqual(Buffer.from(proof,'hex'),stamp(data))||
        data.version!==1||data.receipt?.date!==date||!hash.test(data.receipt.runId||'')||
        !Number.isSafeInteger(data.expiresAt)||!Array.isArray(data.jobs)||!data.jobs.length||
        data.jobs.some((job,index)=>!kinds.includes(job.kind)||
          data.jobs.findIndex(row=>row.kind===job.kind)!==index||
          !['PENDING','RUNNING'].includes(job.state)&&!finished.has(job.state))||
        data.lease&&(!data.jobs.some(job=>job.kind===data.lease.kind&&job.state==='RUNNING')||
          !Number.isSafeInteger(data.lease.until)))throw error('OPSMAP_JOBS_INTEGRITY');
    return data;
  }
  const read=async date=>{
    const {value,sha}=await store.read(stateFile(date));
    return {sha,record:verify(value,date)};
  };
  async function write(record,expected) {
    await store.write(stateFile(record.receipt.date),{...record,proof:stamp(record).toString('hex')},expected);
  }
  const output=(runId,kind,state,fields={})=>log(JSON.stringify({component:'opsmap-stage-jobs',runId,job:kind,state,...fields}));

  async function accept(receipt,plan) {
    const date=receipt?.date;
    if(!dayPattern.test(date||'')||date!==kstDay(now())||!hash.test(receipt.runId||'')||
        !Array.isArray(plan)||!plan.length||new Set(plan).size!==plan.length||plan.some(kind=>!kinds.includes(kind))) {
      throw error('OPSMAP_JOBS_RECEIPT');
    }
    const candidate={version:1,receipt,expiresAt:now()+retentionMs,lease:null,
      jobs:plan.map(kind=>({kind,state:'PENDING'}))};
    let existing=await read(date);
    if(!existing.record){
      try {await write(candidate,existing.sha);}
      catch(problem) {if(problem.code!=='FIXED_STORE_CONFLICT')throw problem;}
      existing=await read(date);
    }
    if(existing.record?.receipt.runId!==receipt.runId)throw error('OPSMAP_JOBS_RECEIPT_CONFLICT');
  }

  async function reserve(date) {
    const {record,sha}=await read(date);
    if(!record||record.expiresAt<=now())return {done:true};
    const oldLease=record.lease;
    if(oldLease?.until>now())return {nextAt:oldLease.until+1000};
    if(oldLease){
      const old=record.jobs.find(job=>job.kind===oldLease.kind);
      old.state='INTERRUPTED';
      old.error='OPSMAP_JOBS_WORKER_LOST';
      record.lease=null;
      await write(record,sha);
      output(record.receipt.runId,old.kind,old.state);
      return {nextAt:now()};
    }
    const next=record.jobs.find(job=>job.state==='PENDING');
    if(!next)return {done:true};
    const memory=await measure();
    if(!stageSyncHeadroom(memory)){
      output(record.receipt.runId,next.kind,'WAITING_MEMORY',{...memory});
      return {nextAt:now()+60_000};
    }
    const lease={id:randomUUID(),kind:next.kind,until:now()+leaseMs};
    record.lease=lease;
    next.state='RUNNING';
    await write(record,sha);
    const saved=(await read(date)).record;
    if(saved?.lease?.id!==lease.id)throw error('OPSMAP_JOBS_RESERVATION_READBACK');
    return {lease,receipt:record.receipt,memory};
  }

  async function drain(date=kstDay(now())) {
    if(date!==kstDay(now()))return {done:true};
    let reservation;
    try {reservation=await reserve(date);}
    catch(problem) {if(problem.code==='FIXED_STORE_CONFLICT')return {nextAt:now()+1000};throw problem;}
    if(!reservation.lease)return reservation;
    const {receipt,lease,memory}=reservation;
    const controller=new AbortController();
    let heartbeat=null,alive=true,renewing=Promise.resolve();
    output(receipt.runId,lease.kind,'RUNNING',memory);
    async function mutate(change) {
      const {record,sha}=await read(date);
      if(record?.lease?.id!==lease.id||record.lease.until<=now())throw error('OPSMAP_JOBS_LEASE_LOST');
      change(record);
      await write(record,sha);
    }
    const lose=()=>controller.abort(error('OPSMAP_JOBS_LEASE_LOST'));
    function renew() {
      if(!alive)return;
      renewing=(async()=>{
        try {
          const memory=await measure();
          if(!stageSyncHeadroom(memory,true)){
            output(receipt.runId,lease.kind,'MEMORY_GUARD',memory);
            controller.abort(error('OPSMAP_JOBS_MEMORY_GUARD'));
            return;
          }
          await mutate(record=>{record.lease.until=now()+leaseMs;});
        } catch {lose();}
        finally {if(alive&&!controller.signal.aborted){heartbeat=setTimeout(renew,intervalMs);heartbeat.unref?.();}}
      })();
    }
    heartbeat=setTimeout(renew,intervalMs);
    heartbeat.unref?.();
    const memoryWatch=setInterval(async()=>{
      if(!alive||controller.signal.aborted)return;
      try{
        const usage=await measure();
        if(alive&&!stageSyncHeadroom(usage,true)){
          output(receipt.runId,lease.kind,'MEMORY_GUARD',usage);
          controller.abort(error('OPSMAP_JOBS_MEMORY_GUARD'));
        }
      }catch{/* The heartbeat still verifies the lease. */}
    },2000);
    memoryWatch.unref?.();
    let result;
    try {result=await execute({receipt,kind:lease.kind,signal:controller.signal});}
    catch(problem){result={state:'FAILED',error:problem.code||problem.message};}
    finally {alive=false;clearTimeout(heartbeat);clearInterval(memoryWatch);await renewing;}
    const reason=controller.signal.reason?.code;
    if(reason==='OPSMAP_JOBS_LEASE_LOST')return {nextAt:lease.until+1000};
    const state=reason?'INTERRUPTED':finished.has(result?.state)?result.state:'FAILED';
    const rawError=reason||result?.error;
    const failure=/^[A-Z][A-Z0-9_]{2,95}$/.test(rawError||'')?rawError:null;
    await mutate(record=>{
      const job=record.jobs.find(value=>value.kind===lease.kind);
      Object.assign(job,{state,error:failure,finishedAt:now()});
      record.lease=null;
    });
    const saved=(await read(date)).record;
    if(saved?.jobs.find(job=>job.kind===lease.kind)?.state!==state)throw error('OPSMAP_JOBS_RESULT_READBACK');
    output(receipt.runId,lease.kind,state,{error:failure});
    return {nextAt:now()};
  }

  return {accept,drain};
}
