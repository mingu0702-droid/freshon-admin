import {createHmac,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {syncDigest,syncHash} from './opsmapSyncGeneration.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from './stageScope.js';

export const OPSMAP_SCHEDULED_ROUTE='/internal/opsmap/scheduled-sync';
const maxDelay=10*60_000;
const HOUR=3_600_000;
const maxRuntime=18*60_000;
const kstDate=ms=>new Date(ms+9*HOUR).toISOString().slice(0,10);
const jobFile=fileURLToPath(new URL('../scripts/run-opsmap-data-sync.mjs',import.meta.url));
const sourceKeys=new Set(['customerRegistry','delivery:1','delivery:2','delivery:3','delivery:4']);

function recordSource(sources,key,date,error) {
  if(!sourceKeys.has(key))return;
  const at=new Date().toISOString();
  const code=error?.code||error?.message;
  const observation={...sources[key],checkedAt:at,checkedDate:/^\d{4}-\d{2}-\d{2}$/.test(date||'')?date:null};
  sources[key]=error?{...observation,lastFailureAt:at,error:/^[A-Z][A-Z_0-9]{1,95}$/.test(code||'')?code:'OPSMAP_SOURCE_FAILED'}:
    {...observation,lastSuccessAt:at,lastSuccessDate:observation.checkedDate,error:null};
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

export function mountOpsmapScheduledRun(app,{env=process.env,launch=spawn,now=Date.now,log=console.log}={}) {
  const settings=env.OPSMAP_STAGE_SYNC_JOB_SETTINGS_FILE;
  if (env.RENDER_SERVICE_ID!==STAGE_SERVICE||env.RENDER_EXTERNAL_URL!==STAGE_ORIGIN||
      env.OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED!=='1'||env.OPSMAP_STAGE_SYNC_PUBLISH_APPROVED!=='1'||
      env.OPSMAP_STAGE_SYNC_REMOTE_APPROVED!=='1'||
      !path.isAbsolute(settings || '')) return;
  let child;
  app.post(OPSMAP_SCHEDULED_ROUTE,express.json({limit:'2kb',inflate:false}), (req,res)=>{
    res.set('Cache-Control','no-store');
    let receipt;
    try {receipt=verifyOpsmapScheduleReceipt(req.body,{...opsmapScheduleConfig(env),now});}
    catch {return res.status(403).json({error:'OPSMAP_SCHEDULE_REJECTED'});}
    if (child) return res.status(409).json({error:'OPSMAP_SCHEDULE_BUSY'});
    let processHandle;
    try {processHandle=launch(process.execPath,[jobFile,'scheduled',settings],{env,stdio:['pipe','ignore','pipe'],windowsHide:true});}
    catch {return res.status(503).json({error:'OPSMAP_SCHEDULE_LAUNCH'});}
    child=processHandle;
    let diagnostic='',timedOut=false;
    processHandle.stderr.on('data',chunk=>{if(diagnostic.length<100) diagnostic=(diagnostic+chunk).slice(0,100);});
    const timeout=setTimeout(()=>{timedOut=true;processHandle.kill();},maxRuntime);
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
    processHandle.stdin.end(JSON.stringify(req.body));
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
