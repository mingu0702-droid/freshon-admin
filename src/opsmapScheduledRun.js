import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {syncDigest,syncHash} from './opsmapSyncGeneration.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from './stageScope.js';
import {FIXED_MASTER_WORKER_LIMIT, stageFixedMasterStorage, stageFixedMasterSyncEnabled} from './stageFixedMasterSync.js';
import {NATIONAL_REGISTRY_WORKER_LIMIT, stageNationalRegistryEnabled} from './stageNationalRegistry.js';
import {stageRecentOperationsSyncEnabled} from './stageRecentOperations.js';

export const OPSMAP_SCHEDULED_ROUTE='/internal/opsmap/scheduled-sync';
const maxDelay=10*60_000;
const HOUR=3_600_000;
const maxRuntime=18*60_000;
const kstDate=ms=>new Date(ms+9*HOUR).toISOString().slice(0,10);
const jobFile=fileURLToPath(new URL('../scripts/run-opsmap-data-sync.mjs',import.meta.url));
const sourceKeys=new Set(['customerRegistry','delivery:1','delivery:2','delivery:3','delivery:4']);
const fixedCenters=['011','012','013'];
const boundedCount=(value,max=120_000)=>Number.isSafeInteger(value)&&value>=0&&value<=max?value:null;
const fixedError=value=>/^FIXED_(?:MASTER|STORE)_[A-Z_]{1,70}$/.test(value||'')?value:null;
const recentOrderStates=new Set(['VERIFIED','ALREADY_OBSERVED','AUTH_UNAVAILABLE','HTTP_REJECTED','READ_FAILED',
  'BUDGET_EXHAUSTED','RESPONSE_INVALID','SOURCE_EMPTY','COUNT_UNVERIFIED','ROW_DATE_MISMATCH','ROW_CENTER_MISMATCH',
  'ROW_NOT_CONFIRMED','ROW_CUSTOMER_INVALID','ROW_ORDER_KEY_INVALID','ROW_DUPLICATE','ROW_QUANTITY_INVALID']);
const receiptFields=({version,origin,triggerId,principal,issuedAt,slot,date,runId})=>
  [version,origin,triggerId,principal,issuedAt,slot,date,runId];
const signReceipt=(value,secret,domain='')=>createHmac('sha256',secret)
  .update(domain).update(JSON.stringify(receiptFields(value))).digest();
const queueDomain='opsmap-stage-private-dispatch-v1\0';

function fixedScanSummary(value) {
  if (!fixedCenters.includes(value.center) || ![1,2].includes(value.scan) || !['VERIFIED','REJECTED'].includes(value.state)) return null;
  const change=value.countChange;
  const planned=value.retryBudget;
  const retryBudget=planned&&typeof planned.canRetry==='boolean'?{
    rescanRequests:boundedCount(planned.rescanRequests,240),remainingCenterRequests:boundedCount(planned.remainingCenterRequests,240),
    availableRequests:boundedCount(planned.availableRequests,240),canRetry:planned.canRetry
  }:null;
  const verification=Array.isArray(value.verification)?value.verification.slice(0,2).flatMap(page=>{
    if (!page || !['SAME','COUNT_CHANGED','CUSTOMERS_CHANGED','ORDER_CHANGED','ASSIGNMENTS_CHANGED','REQUEST_FAILED'].includes(page.state)) return [];
    return [{page:boundedCount(page.page,119),declaredRows:boundedCount(page.declaredRows),rows:boundedCount(page.rows,1000),state:page.state}];
  }):[];
  return {center:value.center,scan:value.scan,state:value.state,error:fixedError(value.error),
    firstDeclaredRows:boundedCount(value.firstDeclaredRows),followupDeclaredRows:boundedCount(value.followupDeclaredRows),
    acceptedPages:boundedCount(value.acceptedPages,120),acceptedRows:boundedCount(value.acceptedRows),
    failedPage:boundedCount(value.failedPage,119),sourceHttp:Number.isSafeInteger(value.sourceHttp)&&value.sourceHttp>=100&&value.sourceHttp<=599?value.sourceHttp:null,
    countChange:change&&['READ','VERIFY'].includes(change.phase)?{phase:change.phase,page:boundedCount(change.page,119),
      expectedRows:boundedCount(change.expectedRows),declaredRows:boundedCount(change.declaredRows)}:null,verification,
    ...(retryBudget?{retryBudget}:{})};
}

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
  const expected=signReceipt(value,secret);
  if (!timingSafeEqual(Buffer.from(signature,'hex'),expected)) throw Error('OPSMAP_SCHEDULE_SIGNATURE');
  return {version,origin,triggerId,principal,issuedAt,slot,date,runId};
}

export function opsmapScheduleConfig(env) {
  return {secret:env.OPSMAP_STAGE_SYNC_SCHEDULER_SECRET,scheduleId:env.OPSMAP_STAGE_SYNC_TRIGGER_ID,
    executorHash:env.OPSMAP_STAGE_SYNC_EXECUTOR_SHA256};
}

export const independentStageSync = env => stageFixedMasterSyncEnabled(env) &&
  env.OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED==='1' &&
  env.OPSMAP_STAGE_SYNC_EXECUTION_OWNER==='independent';

function dispatchFile(date) {
  return 'fixed-master-daily-v1/dispatch-'+date+'.json';
}

function verifyQueuedReceipt(value,config) {
  const {stamp,claim,...receipt}=value || {};
  const {secret}=config;
  if (typeof secret!=='string'||!syncHash(stamp)||claim!==undefined&&
      (!/^[a-f0-9-]{36}$/.test(claim?.id||'')||!Number.isFinite(Date.parse(claim?.at)))||
      !timingSafeEqual(Buffer.from(stamp,'hex'),signReceipt(receipt,secret,queueDomain)))
    throw Error('OPSMAP_SCHEDULE_DISPATCH_SIGNATURE');
  return verifyOpsmapScheduleReceipt({...receipt,signature:signReceipt(receipt,secret).toString('hex')},config);
}

export async function claimQueuedOpsmapSchedule({store,config,prepare=()=>null,now=Date.now}) {
  const date=kstDate(now());
  const file=dispatchFile(date);
  const {value,sha}=await store.read(file);
  if (!value) return null;
  const options={...config,now};
  const receipt=verifyQueuedReceipt(value,options);
  if (receipt.date!==date) throw Error('OPSMAP_SCHEDULE_RECEIPT');
  if (value.claim) return null;
  const input=await prepare(receipt);
  verifyQueuedReceipt(value,options);
  const claim={id:randomUUID(),at:new Date(now()).toISOString()};
  try {await store.write(file,{...value,claim},sha);}
  catch (error) {
    const recorded=(await store.read(file)).value;
    if (!recorded?.claim) throw error;
    if (recorded.claim.id!==claim.id) return null;
  }
  const recorded=(await store.read(file)).value;
  if (recorded?.claim?.id!==claim.id || verifyQueuedReceipt(recorded,options).runId!==receipt.runId)
    throw Error('OPSMAP_SCHEDULE_DISPATCH_READBACK');
  return {receipt,input};
}

async function enqueueOpsmapSchedule(store, receipt, config) {
  const file=dispatchFile(receipt.date);
  const confirm=async()=>{
    const {value}=await store.read(file);
    if (!value) return false;
    const recorded=verifyQueuedReceipt(value,config);
    if (recorded.runId!==receipt.runId) throw Error('OPSMAP_SCHEDULE_DISPATCH_CONFLICT');
    return true;
  };
  if (await confirm()) return;
  const value={...receipt,stamp:signReceipt(receipt,config.secret,queueDomain).toString('hex')};
  try {await store.write(file,value,null);}
  catch (error) {
    // A competing request, or a lost write acknowledgement, may have queued this run.
    if (await confirm()) return;
    throw error;
  }
  if (!await confirm()) throw Error('OPSMAP_SCHEDULE_DISPATCH_READBACK');
}

export function mountOpsmapScheduledRun(app,{env=process.env,launch=spawn,now=Date.now,log=console.log,readFixedScope,readNationalScope,
  openDispatchStore=()=>stageFixedMasterStorage({env,write:true})}={}) {
  const settings=env.OPSMAP_STAGE_SYNC_JOB_SETTINGS_FILE;
  const fullJob=path.isAbsolute(settings || '');
  const independent=independentStageSync(env);
  const nationalJob=stageNationalRegistryEnabled(env);
  const fixedJob=stageFixedMasterSyncEnabled(env) && typeof readFixedScope==='function';
  const recentJob=stageRecentOperationsSyncEnabled(env);
  const scopedRegistry=nationalJob && typeof readNationalScope==='function';
  const sourceJobs=nationalJob||fixedJob||recentJob;
  if (env.RENDER_SERVICE_ID!==STAGE_SERVICE||env.RENDER_EXTERNAL_URL!==STAGE_ORIGIN||
      env.OPSMAP_STAGE_SYNC_SCHEDULER_APPROVED!=='1'||env.OPSMAP_STAGE_SYNC_PUBLISH_APPROVED!=='1'||
      env.OPSMAP_STAGE_SYNC_REMOTE_APPROVED!=='1'||
      !fullJob&&!sourceJobs&&!independent) return;
  let child, starting=false;
  app.post(OPSMAP_SCHEDULED_ROUTE,express.json({limit:'2kb',inflate:false}), async (req,res)=>{
    res.set('Cache-Control','no-store');
    let receipt;
    const config={...opsmapScheduleConfig(env),now};
    try {receipt=verifyOpsmapScheduleReceipt(req.body,config);}
    catch {return res.status(403).json({error:'OPSMAP_SCHEDULE_REJECTED'});}
    if (independent) {
      try {await enqueueOpsmapSchedule(openDispatchStore(),receipt,config);}
      catch {return res.status(503).json({error:'OPSMAP_SCHEDULE_DISPATCH_UNCONFIRMED'});}
      log(JSON.stringify({component:'opsmap-scheduled-dispatch',state:'QUEUED',runId:receipt.runId}));
      return res.status(202).json({state:'QUEUED',runId:receipt.runId});
    }
    if (child || starting) return res.status(409).json({error:'OPSMAP_SCHEDULE_BUSY'});
    let scope=null,registryScope=null;
    if (fixedJob || scopedRegistry) {
      starting=true;
      try {
        [scope,registryScope]=await Promise.all([
          fixedJob?Promise.resolve().then(readFixedScope).catch(()=>null):null,
          scopedRegistry?Promise.resolve().then(readNationalScope).catch(()=>null):null
        ]);
      }
      finally {starting=false;}
      if (fixedJob && !scope && !fullJob && !nationalJob && !recentJob)
        return res.status(503).json({error:'FIXED_MASTER_DAILY_SCOPE_UNAVAILABLE'});
    }
    let processHandle;
    const args=fullJob ? [jobFile,'scheduled',settings] : [jobFile,'fixed-scheduled'];
    try {processHandle=launch(process.execPath,args,{env,stdio:['pipe',sourceJobs?'pipe':'ignore','pipe'],windowsHide:true});}
    catch {return res.status(503).json({error:'OPSMAP_SCHEDULE_LAUNCH'});}
    child=processHandle;
    let diagnostic='',timedOut=false;
    // The child emits aggregate evidence only. Never forward raw output.
    if (sourceJobs && processHandle.stdout) {
      let line='', discarded=false;
      processHandle.stdout.on('data',chunk=>{
        for (const c of String(chunk)) {
          if (c!=='\n') {if (!discarded) {line+=c;if(line.length>1024)discarded=true;} continue;}
          try {
            const value=!discarded&&JSON.parse(line);
            if(value?.component==='opsmap-fixed-master-pages' && value.runId===receipt.runId) {
              const scan=fixedScanSummary(value);
              if(scan)log(JSON.stringify({component:value.component,runId:receipt.runId,...scan}));
            }
            if(value?.component==='opsmap-fixed-master-page-progress' && value.runId===receipt.runId &&
               fixedCenters.includes(value.center) && [1,2].includes(value.scan) &&
               boundedCount(value.page,119)!==null && boundedCount(value.rows,1000)!==null) {
              log(JSON.stringify({component:value.component,runId:receipt.runId,center:value.center,scan:value.scan,
                page:value.page,rows:value.rows,declaredRows:boundedCount(value.declaredRows),
                acceptedRows:boundedCount(value.acceptedRows)}));
            }
            if(value?.component==='opsmap-fixed-master-sync' && value.runId===receipt.runId &&
               ['PUBLISHED','VERIFIED_NOOP','ALREADY_VERIFIED','BUSY','RETRY_HELD','FAILED'].includes(value.state)) {
              log(JSON.stringify({component:value.component,runId:receipt.runId,state:value.state,
                version:syncHash(value.version)?value.version:null,
                checkedAt:Number.isFinite(Date.parse(value.checkedAt))?value.checkedAt:null,
                matchedCount:boundedCount(value.matchedCount),error:fixedError(value.error)}));
            }
            if(value?.component==='opsmap-national-registry-sync' && value.runId===receipt.runId &&
               ['PUBLISHED','VERIFIED_NOOP','ALREADY_VERIFIED','BUSY','ALREADY_ATTEMPTED','FAILED'].includes(value.state)) {
              log(JSON.stringify({component:value.component,runId:receipt.runId,state:value.state,
                count:Number.isSafeInteger(value.count)?value.count:null,
                checkedAt:Number.isFinite(Date.parse(value.checkedAt))?value.checkedAt:null,
                matchedByCenter:value.matchedByCenter?Object.fromEntries(['osan','yeongnam','honam'].map(center=>[center,
                  Number.isSafeInteger(value.matchedByCenter[center])?value.matchedByCenter[center]:null])):null,
                error:/^(?:NATIONAL_REGISTRY|FIXED_STORE)_[A-Z_]+$/.test(value.error||'')?value.error:null}));
            }
            if(value?.component==='opsmap-recent-operations-sync' && value.runId===receipt.runId &&
               ['PUBLISHED','VERIFIED_NOOP','SOURCE_UNAVAILABLE','BUSY','FAILED'].includes(value.state)) {
              log(JSON.stringify({component:value.component,runId:receipt.runId,state:value.state,
                endDate:/^\d{4}-\d{2}-\d{2}$/.test(value.endDate||'')?value.endDate:null,
                error:/^(?:RECENT_OPERATIONS|FIXED_STORE)_[A-Z_]+$/.test(value.error||'')?value.error:null}));
            }
            if(value?.component==='opsmap-recent-orders-source' && value.runId===receipt.runId &&
               /^\d{4}-\d{2}-\d{2}$/.test(value.date||'') && ['osan','yeongnam','honam'].includes(value.centerKey) &&
               recentOrderStates.has(value.state)) {
              log(JSON.stringify({component:value.component,runId:receipt.runId,date:value.date,
                centerKey:value.centerKey,state:value.state}));
            }
          } catch {/* Ignore unrelated stdout and malformed lines. */}
          line='';discarded=false;
        }
      });
    }
    processHandle.stderr.on('data',chunk=>{if(diagnostic.length<100) diagnostic=(diagnostic+chunk).slice(0,100);});
    const timeout=setTimeout(()=>{timedOut=true;processHandle.kill();},(fullJob?maxRuntime:0)+
      (fixedJob?FIXED_MASTER_WORKER_LIMIT:0)+(nationalJob?NATIONAL_REGISTRY_WORKER_LIMIT:0)+
      (recentJob?3*60_000:0));
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
    processHandle.stdin.end(JSON.stringify(fixedJob||scopedRegistry?{receipt:req.body,fixedScope:scope,
      ...(scopedRegistry?{registryScope}:{})}:req.body));
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
