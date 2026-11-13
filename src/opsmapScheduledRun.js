import {createHmac,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {syncDigest,syncHash} from './opsmapSyncGeneration.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from './stageScope.js';
import {FIXED_MASTER_WORKER_LIMIT, stageFixedMasterSyncEnabled} from './stageFixedMasterSync.js';

export const OPSMAP_SCHEDULED_ROUTE='/internal/opsmap/scheduled-sync';
const maxDelay=10*60_000;
const HOUR=3_600_000;
const maxRuntime=18*60_000;
const kstDate=ms=>new Date(ms+9*HOUR).toISOString().slice(0,10);
const jobFile=fileURLToPath(new URL('../scripts/run-opsmap-data-sync.mjs',import.meta.url));
const sourceKeys=new Set(['customerRegistry','delivery:1','delivery:2','delivery:3','delivery:4']);

function recordSource(sources,key,date,error,evidence) {
  if(!sourceKeys.has(key))return;
  const at=new Date().toISOString();
  const code=error?.code||error?.message;
  const observation={...sources[key],checkedAt:at,checkedDate:/^\d{4}-\d{2}-\d{2}$/.test(date||'')?date:null};
  sources[key]=error?{...observation,lastFailureAt:at,error:/^[A-Z][A-Z_0-9]{1,95}$/.test(code||'')?code:'OPSMAP_SOURCE_FAILED'}:
    {...observation,lastSuccessAt:at,lastSuccessDate:observation.checkedDate,error:null,
      ...(evidence?.complete===true?{pages:evidence.pages,sourceRows:evidence.rawRows,uniqueDeliveries:evidence.responseRows,complete:true}:{})};
}

export function verifyOpsmapScheduleReceipt(value,{secret,scheduleId,executorHash,now=Date.now}={}) {
  const {version,origin,triggerId,principal,issuedAt,slot,date,runId,signature}=value || {};
  const time=typeof issuedAt==='string'?Date.parse(issuedAt):NaN;
  if (typeof secret!=='string'||secret.length<32||secret.length>512||!/^\d{1,30}$/.test(scheduleId || '')||
      !syncHash(executorHash)||version!==1||origin!=='APPS_SCRIPT_TIME_TRIGGER'||triggerId!==scheduleId||principal!==executorHash||
      !Number.isFinite(time)||Math.abs(now()-time)>maxDelay||slot!==Math.floor(time/HOUR)||date!==kstDate(time)||
      runId!==syncDigest([version,origin,triggerId,principal,slot])||!syncHash(signature)||Object.keys(value).length!==9) {
    throw Error('OPSMAP_SCHEDULE_RECEIPT');
  }
  const text=JSON.stringify([version,origin,triggerId,principal,issuedAt,slot,date,runId]);
  const expected=createHmac('sha256',secret).update(text).digest();
  if (!timingSafeEqual(Buffer.from(signature,'hex'),expected)) throw Error('OPSMAP_SCHEDULE_SIGNATURE');
  return {version,origin,triggerId,principal,issuedAt,slot,date,runId};
}

export function opsmapScheduleConfig(env) {
  return {secret:env.OPSMAP_STAGE_SYNC_SCHEDULER_SECRET,scheduleId:env.OPSMAP_STAGE_SYNC_TRIGGER_ID,
    executorHash:env.OPSMAP_STAGE_SYNC_EXECUTOR_SHA256};
}

export function mountOpsmapScheduledRun(app,{env=process.env,launch=spawn,now=Date.now,log=console.log,readFixedScope}={}) {
  const settings=env.OPSMAP_STAGE_SYNC_JOB_SETTINGS_FILE;
  const fullJob=path.isAbsolute(settings || '');
  const fixedJob=stageFixedMasterSyncEnabled(env) && typeof readFixedScope==='function';
  if (env.RENDER_SERVICE_ID!==STAGE_SERVICE||env.RENDER_EXTERNAL_URL!==STAGE_ORIGIN||
      env.OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED!=='1'||env.OPSMAP_STAGE_SYNC_PUBLISH_APPROVED!=='1'||
      env.OPSMAP_STAGE_SYNC_REMOTE_APPROVED!=='1'||
      !fullJob&&!fixedJob) return;
  let child;
  app.post(OPSMAP_SCHEDULED_ROUTE,express.json({limit:'2kb',inflate:false}), (req,res)=>{
    res.set('Cache-Control','no-store');
    let receipt;
    try {receipt=verifyOpsmapScheduleReceipt(req.body,{...opsmapScheduleConfig(env),now});}
    catch {return res.status(403).json({error:'OPSMAP_SCHEDULE_REJECTED'});}
    if (child) return res.status(409).json({error:'OPSMAP_SCHEDULE_BUSY'});
    let scope=null;
    if (fixedJob) {
      try {scope=readFixedScope();} catch { /* No verified scope. */ }
      if (!scope && !fullJob) return res.status(503).json({error:'FIXED_MASTER_DAILY_SCOPE_UNAVAILABLE'});
    }
    let processHandle;
    const args=fullJob ? [jobFile,'scheduled',settings] : [jobFile,'fixed-scheduled'];
    try {processHandle=launch(process.execPath,args,{env,stdio:['pipe',fixedJob?'pipe':'ignore','pipe'],windowsHide:true});}
    catch {return res.status(503).json({error:'OPSMAP_SCHEDULE_LAUNCH'});}
    child=processHandle;
    let diagnostic='',timedOut=false;
    // The child emits aggregate evidence only. Never forward raw output.
    if (fixedJob && processHandle.stdout) {
      let line='', discarded=false;
      processHandle.stdout.on('data',chunk=>{
        for (const c of String(chunk)) {
          if (c!=='\n') {if (!discarded) {line+=c;if(line.length>1024)discarded=true;} continue;}
          try {
            const value=!discarded&&JSON.parse(line);
            if(value?.component==='opsmap-fixed-master-sync' && value.runId===receipt.runId &&
               ['PUBLISHED','VERIFIED_NOOP','ALREADY_VERIFIED','BUSY','RETRY_HELD','FAILED'].includes(value.state)) {
              log(JSON.stringify({component:value.component,runId:receipt.runId,state:value.state,
                version:syncHash(value.version)?value.version:null,
                error:/^FIXED_(?:MASTER|STORE)_[A-Z_]{1,70}$/.test(value.error||'')?value.error:null}));
            }
          } catch {/* Ignore unrelated stdout and malformed lines. */}
          line='';discarded=false;
        }
      });
    }
    processHandle.stderr.on('data',chunk=>{if(diagnostic.length<100) diagnostic=(diagnostic+chunk).slice(0,100);});
    const timeout=setTimeout(()=>{timedOut=true;processHandle.kill();},(fullJob?maxRuntime:0)+(fixedJob?FIXED_MASTER_WORKER_LIMIT:0));
    timeout.unref();
    const release=(exitCode,error)=>{
      if(child!==processHandle)return;
      child=null;
      clearTimeout(timeout);
      log(JSON.stringify({component:'opsmap-scheduled-run',runId:receipt.runId,exitCode,
        error:timedOut?'OPSMAP_SCHEDULE_TIMEOUT':error || null}));
    };
    processHandle.once('error',()=>release(null,'OPSMAP_SCHEDULE_LAUNCH'));
    processHandle.once('close',code=>{
      const value=diagnostic.trim();
      release(code,code===0?null:/^[A-Z][A-Z_0-9]{1,95}$/.test(value)?value:'OPSMAP_SYNC_FAILED');
    });
    processHandle.stdin.on('error',()=>{});
    processHandle.stdin.end(JSON.stringify(fixedJob?{receipt:req.body,fixedScope:scope}:req.body));
    return res.status(202).json({state:'ACCEPTED',runId:receipt.runId});
  });
}

export async function publishOpsmapScheduledRun({createWorker,durable,receipt}) {
  const reservation=await durable.reserve(receipt);
  if (reservation.state!=='STARTED') return {state:reservation.state,runId:receipt.runId};
  const {run}=reservation;
  const sources={};
  try {
    const worker=await createWorker((...args)=>recordSource(sources,...args));
    const result=await worker.sync({scheduledRun:run,durableActive:reservation.active});
    if (result.sourceReadComplete!==true) throw Error('OPSMAP_SCHEDULE_SOURCE_INCOMPLETE');
    const generation=await worker.read();
    if (!generation || generation.index.sha256!==result.generation) throw Error('OPSMAP_SCHEDULE_GENERATION');
    return result.state==='NOOP' ? await durable.confirmUnchanged(run,generation,result.observationHash,sources)
      : await durable.commit(run,generation,sources);
  } catch(error) {
    await durable.fail(run,error,sources).catch(()=>{});
    throw error;
  }
}
