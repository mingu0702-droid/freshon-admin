/** One approved Production restore recovery. Never writes sources, shards or published pointer. */
function hubProductionRestoreCode_(error,step){
  const message=String(error&&error.message||'');
  if(/^MODEL_[A-Z0-9_]+$/.test(message))return message;
  if(/permission|authoriz|access denied|권한/i.test(message))return 'MODEL_PERMISSION_DENIED';
  if(/too many times|quota|할당량/i.test(message))return 'MODEL_QUOTA_LIMIT';
  if(/timed? ?out|timeout|시간 초과/i.test(message))return 'MODEL_NETWORK_TIMEOUT';
  if(/address unavailable|dns|resolve host|name resolution/i.test(message))return 'MODEL_NETWORK_ADDRESS_UNAVAILABLE';
  if(/network|connection|socket|service unavailable|internal error|일시적인/i.test(message))return 'MODEL_TRANSIENT_SERVICE';
  if(step==='SHARD_PARSE'||step==='MANIFEST_PARSE')return 'MODEL_JSON_INVALID';
  return 'MODEL_'+step+'_FAILED';
}
function hubProductionRestoreAudit_(r,step,code,http){
  const audit={target:'production',generation:r&&r.generation||null,worker:r&&r.worker||(r&&r.recoveryVersion===1?'PRODUCTION_RESTORE_V1':'LEGACY_UNRECORDED'),sendAt:r&&r.sendAt||0,verified:r&&r.verified||0,step:step,failedStep:r&&r.failedStep||null,http:Number(http)||null,code:code,at:new Date().toISOString()};
  console.log(JSON.stringify(audit));return audit;
}
function hubProductionRestoreOp_(r,step,fn){
  r.recoveryStep=step;
  try{return fn();}catch(error){
    const safe=new Error(hubProductionRestoreCode_(error,step));safe.http=error.http||null;safe.step=step;throw safe;
  }
}
function hubProductionRestoreStatus_(){
  const endpoint=hubReadModelTarget_('production').endpoint.replace('/internal/stage-read-model','/api/map-phase2b/preview/period-status');
  const response=UrlFetchApp.fetch(endpoint,{muteHttpExceptions:true,followRedirects:false});
  const http=response.getResponseCode();if(http!==200)throw Object.assign(new Error('MODEL_STATUS_HTTP_'+http),{http:http});
  try{return JSON.parse(response.getContentText());}catch(ignored){throw new Error('MODEL_STATUS_JSON');}
}
function hubProductionRestoreSend_(r,message){
  const destination=hubReadModelTarget_('production'),secret=PropertiesService.getScriptProperties().getProperty(destination.secretProperty);
  if(!secret||secret.length<32)throw new Error('MODEL_AUTH_MISSING');
  const body={timestamp:String(Date.now()),nonce:Utilities.getUuid().replace(/-/g,''),message:message},text=JSON.stringify(body);
  const response=hubProductionRestoreOp_(r,message.type==='commit'?'COMMIT':'PRODUCTION_SEND',function(){
    return UrlFetchApp.fetch(destination.endpoint,{method:'post',contentType:'application/json',payload:text,headers:{'x-stage-model-signature':hubStageModelSignature_(text,secret)},muteHttpExceptions:true,followRedirects:false});
  });
  const http=response.getResponseCode();if(http!==200)throw Object.assign(new Error('MODEL_STAGE_HTTP_'+http),{http:http,step:r.recoveryStep});
  hubProductionRestoreOp_(r,'ACK_CHECK',function(){
    let ack;try{ack=JSON.parse(response.getContentText());}catch(ignored){throw new Error('MODEL_ACK_JSON');}
    if(!ack||ack.ok!==true)throw new Error('MODEL_ACK_INVALID');
  });return http;
}
function hubProductionRestoreSave_(r){
  try{return hubProductionRestoreOp_(r,'CHECKPOINT_SAVE',function(){return hubReadModelRestoreSave_(r);});}
  catch(error){
    if(error.message==='MODEL_CHECKPOINT_VERIFY'){
      // The write has already happened. Never rewrite or advance on an ACK alone:
      // obtain a fresh Drive handle and require the exact serialized checkpoint.
      const savedStep=r.recoveryStep,expected=JSON.stringify(r);
      for(let attempt=0;attempt<3;attempt++){
        Utilities.sleep(250*(attempt+1));
        const actual=hubProductionRestoreOp_(r,'CHECKPOINT_READ',function(){return DriveApp.getFileById(r.stateId).getBlob().getDataAsString('UTF-8');});
        r.recoveryStep=savedStep;
        if(actual===expected){r.recoveryStep='CHECKPOINT_SAVE';hubProductionRestoreAudit_(r,'CHECKPOINT_SAVE','MODEL_CHECKPOINT_READBACK_RECOVERED',null);return;}
      }
      // Independent media GET avoids a potentially stale DriveApp service object.
      // Acceptance still requires byte-for-byte equality with the intended write.
      const fresh=hubProductionRestoreFreshText_(r);
      if(fresh===expected){r.recoveryStep='CHECKPOINT_SAVE';hubProductionRestoreAudit_(r,'CHECKPOINT_SAVE','MODEL_CHECKPOINT_DRIVEAPP_STALE_CONFIRMED',200);return;}
      let parsed;try{parsed=JSON.parse(fresh);}catch(ignored){throw Object.assign(new Error('MODEL_CHECKPOINT_JSON_INVALID'),{step:'CHECKPOINT_READ'});}
      const conflict=parsed.generation!==r.generation||parsed.sendAt!==r.sendAt||parsed.phase!==r.phase;
      throw Object.assign(new Error(conflict?'MODEL_CHECKPOINT_CONFLICT':'MODEL_CHECKPOINT_SERIALIZATION_MISMATCH'),{step:'CHECKPOINT_SAVE',http:200});
    }
    if(r.phase==='DONE')r.phase='RESTORE';throw error;
  }
}
function hubProductionRestoreSchedule_(r){
  hubStageRestoreUnschedule_('production');
  if(r&&r.phase==='RESTORE')ScriptApp.newTrigger(HUB_MODEL_TARGETS.production.handler).timeBased().after(Math.max(60000,(r.retryAfter||0)-Date.now())).create();
}
function hubProductionRestoreBaseline_(r){
  const props=PropertiesService.getScriptProperties(),id=props.getProperty(HUB_STAGE_MODEL.property);
  const published=hubProductionRestoreOp_(r,'MANIFEST_READ',function(){return hubStageModelLoad_();});
  const manifest=hubProductionRestoreOp_(r,'HASH_COUNT',function(){return hubStageRestoreManifest_(published);});
  if(!published||published.generation!==1789933588775||manifest.keys.length!==156||manifest.totals.historyRows!==120035||manifest.totals.periodRows!==147689||manifest.totals.historyFiles!==78||manifest.totals.periodFiles!==78)throw new Error('MODEL_RECOVERY_BASELINE');
  if(r.publishedStateId!==id||r.generation!==published.generation||r.fingerprint!==manifest.fingerprint)throw new Error('MODEL_RESTORE_CONFLICT');
  if(r.stateId!==props.getProperty(HUB_MODEL_TARGETS.production.property)||r.stateId===id||r.stateId===props.getProperty(HUB_MODEL_TARGETS.stage.property)||r.target!=='production')throw new Error('MODEL_RESTORE_TARGET_CONFLICT');
  return {published:published,manifest:manifest};
}
// Editor-only entry point. Current receiver API cannot prove pending shard receipts.
// Therefore use approved option B: same immutable files, same generation, no source scan.
function hubProductionRestoreRecoverApproved(){
  const lock=LockService.getUserLock();if(!lock.tryLock(30000)){hubProductionRestoreAudit_(null,'LOCK','MODEL_WORKER_BUSY',null);return;}
  let r;
  try{
    r=hubStageRestoreLoad_('production');if(!r)throw new Error('MODEL_CHECKPOINT_MISSING');
    const before=JSON.stringify(r),baseline=hubProductionRestoreBaseline_(r),live=hubProductionRestoreStatus_();
    if(live.ready&&live.generation===r.generation&&live.historyRows===120035&&live.periodRows===147689){hubProductionRestoreAudit_(r,'READBACK','MODEL_ALREADY_COMMITTED',200);return;}
    if(live.generation&&live.generation!==r.generation)throw new Error('MODEL_GENERATION_CONFLICT');
    if(r.recoveryVersion===1){if(r.phase==='RESTORE')hubProductionRestoreSchedule_(r);hubProductionRestoreAudit_(r,'CHECKPOINT_READ','MODEL_RECOVERY_ALREADY_REQUESTED',null);return;}
    if(r.phase!=='ERROR'||r.lastError!=='MODEL_RESTORE_FAILED'||r.sendAt!==14||r.verified!==14||r.authHalt)throw new Error('MODEL_RECOVERY_NOT_APPROVED');
    if(typeof hubMapIncrementalLoad_==='function'){const job=hubMapIncrementalLoad_();if(job&&job.phase!=='DONE'&&job.phase!=='ERROR')throw new Error('MODEL_INCREMENTAL_BUSY');}
    const file=DriveApp.getFolderById(baseline.published.folderId).createFile('production-restore-before-recovery-'+Date.now()+'.json',before,MimeType.PLAIN_TEXT);
    if(file.getBlob().getDataAsString('UTF-8')!==before)throw new Error('MODEL_BACKUP_VERIFY');
    if(JSON.stringify(hubStageRestoreLoad_('production'))!==before)throw new Error('MODEL_CHECKPOINT_CHANGED');
    hubProductionRestoreBaseline_(r);
    r.recoveryBackupId=file.getId();r.recoveryReason='PENDING_RECEIPTS_NOT_EXPOSED';r.recoveryVersion=1;r.recoveryStartedAt=new Date().toISOString();
    r.phase='RESTORE';r.sendAt=0;r.verified=0;r.begun=false;r.errors=0;r.lastError='';r.commitHttp=null;r.retryAfter=0;r.totalRetries=0;
    hubProductionRestoreSave_(r);hubProductionRestoreSchedule_(r);hubProductionRestoreAudit_(r,'CHECKPOINT_SAVE','MODEL_EXISTING_FILES_RETRANSFER',null);
  }catch(error){hubProductionRestoreAudit_(r,error.step||'PRECHECK',hubProductionRestoreCode_(error,error.step||'PRECHECK'),error.http);}
  finally{lock.releaseLock();}
}
function hubProductionRestoreWorker_(){
  const lock=LockService.getUserLock();if(!lock.tryLock(1000)){const waiting=hubStageRestoreLoad_('production');if(waiting&&waiting.phase==='RESTORE'&&!waiting.authHalt)hubProductionRestoreSchedule_(waiting);return;}
  let r;
  try{
    const loaded=hubStageRestoreLoad_('production');if(!loaded||loaded.phase!=='RESTORE'||loaded.authHalt)return;
    const props=PropertiesService.getScriptProperties();
    if(loaded.target!=='production'||loaded.stateId!==props.getProperty(HUB_MODEL_TARGETS.production.property)||loaded.stateId===props.getProperty(HUB_MODEL_TARGETS.stage.property)||loaded.stateId===props.getProperty(HUB_STAGE_MODEL.property))throw new Error('MODEL_RESTORE_TARGET_CONFLICT');
    r=loaded;r.worker='PRODUCTION_RESTORE_V2';
    const halt=PropertiesService.getScriptProperties().getProperty('PHASE2B_PRODUCTION_RESTORE_HALT_V2');
    if(halt&&JSON.parse(halt).generation===r.generation){hubProductionRestoreAudit_(r,'HALT','MODEL_FAILURE_PERSISTENCE_HALTED',null);return;}
    if(r.retryAfter>Date.now())return;
    hubStageRestoreUnschedule_('production');
    const b=hubProductionRestoreBaseline_(r),p=b.published,m=b.manifest,deadline=Date.now()+210000;
    r.recoveryVersion=1;r.worker='PRODUCTION_RESTORE_V2';
    if(r.verified!==r.sendAt||!Number.isInteger(r.sendAt)||r.sendAt<0||r.sendAt>156)throw new Error('MODEL_RESTORE_CONFLICT');
    hubProductionRestoreSchedule_(r); // crash safety; lock prevents simultaneous workers
    const live=hubProductionRestoreOp_(r,'RECEIVER_STATUS',hubProductionRestoreStatus_);
    if(live.ready&&live.generation===r.generation){
      if(live.historyRows!==120035||live.periodRows!==147689||live.startDate!==p.startDate||live.endDate!==p.endDate)throw new Error('MODEL_READBACK_MISMATCH');
      r.sendAt=156;r.verified=156;r.phase='DONE';r.lastError='';r.completionEvidence='RECEIVER_ALREADY_COMMITTED';hubProductionRestoreSave_(r);return;
    }
    if(live.generation&&live.generation!==r.generation)throw new Error('MODEL_GENERATION_CONFLICT');
    if(!r.begun){r.firstHttp=hubProductionRestoreSend_(r,{type:'begin',generation:r.generation});r.begun=true;hubProductionRestoreSave_(r);hubProductionRestoreAudit_(r,'BEGIN','MODEL_BEGIN_ACK',r.firstHttp);}
    while(r.sendAt<m.keys.length&&Date.now()<deadline){
      const key=m.keys[r.sendAt],entry=p.shards[key];
      const text=hubProductionRestoreOp_(r,'SHARD_READ',function(){return DriveApp.getFileById(entry.id).getBlob().getDataAsString('UTF-8');});
      const rows=hubProductionRestoreOp_(r,'SHARD_PARSE',function(){return JSON.parse(text);});
      hubProductionRestoreOp_(r,'HASH_COUNT',function(){if(!Array.isArray(rows)||rows.length!==entry.count||hubStageModelHash_(rows)!==entry.hash)throw new Error('MODEL_RESTORE_SHARD_CHANGED');});
      const http=hubProductionRestoreSend_(r,{type:'shard',generation:r.generation,kind:key.split(':')[0],date:key.split(':')[1],hash:entry.hash,rows:rows});
      r.sendAt++;r.verified++;r.retryAtCount=0;r.retryAfter=0;r.lastError='';hubProductionRestoreSave_(r);
      hubProductionRestoreAudit_(r,'CHECKPOINT_SAVE','MODEL_SHARD_ACK',http);
    }
    if(r.sendAt===156){
      hubProductionRestoreBaseline_(r);
      r.commitHttp=hubProductionRestoreSend_(r,{type:'commit',generation:r.generation,startDate:r.startDate,endDate:r.endDate,manifest:m.keys.map(function(key){return{key:key,count:p.shards[key].count,hash:p.shards[key].hash};})});
      const after=hubProductionRestoreOp_(r,'READBACK',hubProductionRestoreStatus_);
      if(!after.ready||after.generation!==r.generation||after.historyRows!==120035||after.periodRows!==147689||after.startDate!==r.startDate||after.endDate!==r.endDate)throw new Error('MODEL_READBACK_MISMATCH');
      r.phase='DONE';r.errors=0;r.lastError='';hubProductionRestoreSave_(r);hubProductionRestoreAudit_(r,'COMMIT','MODEL_COMMITTED',200);
    }
  }catch(error){
    const step=error.step||r&&r.recoveryStep||'CHECKPOINT_READ',code=hubProductionRestoreCode_(error,step);
    if(r)r.failedStep=step;
    const audit=hubProductionRestoreAudit_(r,step,code,error.http);
    if(r&&r.phase==='RESTORE'){
      r.lastFailure=audit;if(!r.firstFailure)r.firstFailure=audit;r.lastError=code;r.errors=(r.errors||0)+1;
      const retry=/^MODEL_(NETWORK_TIMEOUT|NETWORK_ADDRESS_UNAVAILABLE|TRANSIENT_SERVICE|(STAGE|STATUS)_HTTP_429|(STAGE|STATUS)_HTTP_5\d\d)$/.test(code);
      r.retryAtCount=(r.retryAtCount||0)+1;r.totalRetries=(r.totalRetries||0)+1;
      if(!retry||r.retryAtCount>=3||r.totalRetries>6)r.phase='ERROR';
      else r.retryAfter=Date.now()+Math.min(240000,60000*Math.pow(2,r.retryAtCount-1));
      if(/HTTP_(401|403)$/.test(code)||code==='MODEL_PERMISSION_DENIED'||code==='MODEL_AUTH_MISSING')r.authHalt=true;
      try{hubProductionRestoreSave_(r);}catch(saveError){
        // Do not replace the original failure when persisting that failure fails.
        r.phase='ERROR';r.failedStep=step;r.lastFailure=audit;
        PropertiesService.getScriptProperties().setProperty('PHASE2B_PRODUCTION_RESTORE_HALT_V2',JSON.stringify(audit));
        hubProductionRestoreAudit_(r,step,code,error.http);
        hubProductionRestoreAudit_(r,'ERROR_CHECKPOINT_SAVE',hubProductionRestoreCode_(saveError,'CHECKPOINT_SAVE'),saveError.http);
      }
    }
  }finally{
    try{hubProductionRestoreSchedule_(r);}catch(error){hubProductionRestoreAudit_(r,'CONTINUATION',hubProductionRestoreCode_(error,'CONTINUATION'),null);}
    finally{lock.releaseLock();}
  }
}

function hubProductionRestoreRecoveryStatus(){
  let r;
  try{r=hubStageRestoreLoad_('production');
    if(r&&r.lastFailure)console.log(JSON.stringify(r.lastFailure));
    return hubProductionRestoreAudit_(r,r&&r.phase||'NONE',r&&r.lastError||'MODEL_STATUS_OK',r&&r.commitHttp);
  }catch(error){return hubProductionRestoreAudit_(r,'CHECKPOINT_READ',hubProductionRestoreCode_(error,'CHECKPOINT_READ'),null);}
}

// Read-only preflight: existing files only. No source scan, no Stage ingest.
function hubProductionRestoreColdStartDiagnostic(){
  let r;
  try{
    r=hubStageRestoreLoad_('production');if(!r)throw new Error('MODEL_CHECKPOINT_MISSING');
    const before=JSON.stringify(r),b=hubProductionRestoreBaseline_(r);
    if(hubProductionRestoreFreshText_(r)!==before)throw new Error('MODEL_CHECKPOINT_CONFLICT');
    b.manifest.keys.forEach(function(key){const e=b.published.shards[key];
      const text=hubProductionRestoreOp_(r,'SHARD_READ',function(){return DriveApp.getFileById(e.id).getBlob().getDataAsString('UTF-8');});
      const rows=hubProductionRestoreOp_(r,'SHARD_PARSE',function(){return JSON.parse(text);});
      hubProductionRestoreOp_(r,'HASH_COUNT',function(){if(!Array.isArray(rows)||rows.length!==e.count||hubStageModelHash_(rows)!==e.hash)throw new Error('MODEL_RESTORE_SHARD_CHANGED');});
    });
    hubProductionRestoreAudit_(r,'PREFLIGHT','MODEL_156_SHARDS_VERIFIED',null);
  }catch(error){hubProductionRestoreAudit_(r,error.step||'CHECKPOINT_READ',hubProductionRestoreCode_(error,error.step||'CHECKPOINT_READ'),error.http);}
}

// One approved cold-start repair, after final server deployment. No generic ERROR reset.
function hubProductionRestoreColdStartRecoverApproved(){
  const lock=LockService.getUserLock();if(!lock.tryLock(30000)){hubProductionRestoreAudit_(null,'LOCK','MODEL_WORKER_BUSY',null);return;}
  let r;
  try{
    r=hubStageRestoreLoad_('production');if(!r)throw new Error('MODEL_CHECKPOINT_MISSING');
    const before=JSON.stringify(r),b=hubProductionRestoreBaseline_(r),live=hubProductionRestoreStatus_();
    if(live.ready&&live.generation===r.generation){hubProductionRestoreAudit_(r,'READBACK','MODEL_ALREADY_COMMITTED',200);return;}
    if(r.phase==='RESTORE'){hubProductionRestoreAudit_(r,'READBACK','MODEL_ALREADY_RUNNING',null);return;}
    if(r.phase!=='ERROR'||r.lastError!=='MODEL_RESTORE_FAILED'||r.sendAt!==60||r.verified!==60||r.authHalt||r.coldStartRepair)throw new Error('MODEL_RECOVERY_NOT_APPROVED');
    if(live.generation&&live.generation!==r.generation)throw new Error('MODEL_GENERATION_CONFLICT');
    if(typeof hubMapIncrementalLoad_==='function'){const job=hubMapIncrementalLoad_();if(job&&job.phase!=='DONE'&&job.phase!=='ERROR')throw new Error('MODEL_INCREMENTAL_BUSY');}
    b.manifest.keys.forEach(function(key){const e=b.published.shards[key];
      const text=hubProductionRestoreOp_(r,'SHARD_READ',function(){return DriveApp.getFileById(e.id).getBlob().getDataAsString('UTF-8');});
      const rows=hubProductionRestoreOp_(r,'SHARD_PARSE',function(){return JSON.parse(text);});
      hubProductionRestoreOp_(r,'HASH_COUNT',function(){if(!Array.isArray(rows)||rows.length!==e.count||hubStageModelHash_(rows)!==e.hash)throw new Error('MODEL_RESTORE_SHARD_CHANGED');});
    });
    if(hubProductionRestoreFreshText_(r)!==before)throw new Error('MODEL_CHECKPOINT_CHANGED');
    const backup=DriveApp.getFolderById(b.published.folderId).createFile('production-restore-before-coldstart-'+Date.now()+'.json',before,MimeType.PLAIN_TEXT);
    if(backup.getBlob().getDataAsString('UTF-8')!==before)throw new Error('MODEL_BACKUP_VERIFY');
    if(hubProductionRestoreFreshText_(r)!==before)throw new Error('MODEL_CHECKPOINT_CHANGED');
    r.coldStartBackupId=backup.getId();r.coldStartRepair=true;r.recoveryVersion=1;r.worker='PRODUCTION_RESTORE_V2';
    r.recoveryReason='LEGACY_WORKER_CONFIRMED_RECEIPTS_NOT_EXPOSED_AFTER_DEPLOY';
    r.legacyFailure={sendAt:60,code:r.lastError,failedStep:'UNKNOWN_LEGACY'};
    r.phase='RESTORE';r.sendAt=0;r.verified=0;r.begun=false;r.errors=0;r.lastError='';r.commitHttp=null;r.retryAfter=0;r.totalRetries=0;r.retryAtCount=0;
    hubProductionRestoreSave_(r);hubProductionRestoreSchedule_(r);hubProductionRestoreAudit_(r,'CHECKPOINT_SAVE','MODEL_EXISTING_FILES_RETRANSFER',null);
  }catch(error){hubProductionRestoreAudit_(r,error.step||'PRECHECK',hubProductionRestoreCode_(error,error.step||'PRECHECK'),error.http);}
  finally{lock.releaseLock();}
}

// Same Hub OAuth scopes, read-only media request for the Production checkpoint.
// No connector, permission change, file write, shard read, or token logging.
function hubProductionRestoreFreshText_(r){
  const props=PropertiesService.getScriptProperties();
  if(!r||r.target!=='production'||r.stateId!==props.getProperty(HUB_MODEL_TARGETS.production.property)||r.stateId===props.getProperty(HUB_MODEL_TARGETS.stage.property)||r.stateId===props.getProperty(HUB_STAGE_MODEL.property))throw new Error('MODEL_RESTORE_TARGET_CONFLICT');
  const response=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(r.stateId)+'?alt=media&recoveryRead='+Date.now(),{
    headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken(),'Cache-Control':'no-cache'},muteHttpExceptions:true,followRedirects:false
  });
  const http=response.getResponseCode();if(http!==200)throw Object.assign(new Error('MODEL_CHECKPOINT_HTTP_'+http),{http:http,step:'CHECKPOINT_READ'});
  return response.getContentText();
}
function hubProductionRestoreStorageReadDiagnostic(){
  let r;
  try{
    r=hubStageRestoreLoad_('production');
    if(!r||r.generation!==1789933588775||r.phase!=='ERROR'||r.sendAt!==82||r.lastError!=='MODEL_CHECKPOINT_VERIFY')throw new Error('MODEL_RECOVERY_NOT_APPROVED');
    const fresh=hubProductionRestoreFreshText_(r),existing=JSON.stringify(r);
    const parsed=JSON.parse(fresh);
    const same=fresh===existing;
    if(parsed.generation!==r.generation||parsed.sendAt!==r.sendAt||parsed.phase!==r.phase)throw new Error('MODEL_CHECKPOINT_CONFLICT');
    hubProductionRestoreAudit_(r,'CHECKPOINT_READ',same?'MODEL_CHECKPOINT_FRESH_READ_MATCH':'MODEL_CHECKPOINT_SERIALIZATION_MISMATCH',200);
  }catch(error){hubProductionRestoreAudit_(r,error.step||'CHECKPOINT_READ',hubProductionRestoreCode_(error,'CHECKPOINT_READ'),error.http);}
}

// Scoped retry after independent readback validation. No general ERROR reset.
function hubProductionRestoreFreshReadRecoveryApproved(){
  const lock=LockService.getUserLock();if(!lock.tryLock(30000)){hubProductionRestoreAudit_(null,'LOCK','MODEL_WORKER_BUSY',null);return;}
  let r;
  try{
    r=hubStageRestoreLoad_('production');const before=JSON.stringify(r);
    if(!r||r.recoveryVersion!==1||!r.recoveryCheckpointRetry||r.recoveryFreshReadRetry||r.phase!=='ERROR'||r.sendAt!==82||r.verified!==82||r.lastError!=='MODEL_CHECKPOINT_VERIFY'||r.authHalt||r.lastFailure.step!=='CHECKPOINT_SAVE')throw new Error('MODEL_RECOVERY_NOT_APPROVED');
    const b=hubProductionRestoreBaseline_(r),live=hubProductionRestoreStatus_();
    if(live.ready&&live.generation===r.generation){hubProductionRestoreAudit_(r,'READBACK','MODEL_ALREADY_COMMITTED',200);return;}
    if(live.generation&&live.generation!==r.generation)throw new Error('MODEL_GENERATION_CONFLICT');
    if(hubProductionRestoreFreshText_(r)!==before)throw new Error('MODEL_CHECKPOINT_CHANGED');
    const backup=DriveApp.getFolderById(b.published.folderId).createFile('production-restore-before-fresh-read-'+Date.now()+'.json',before,MimeType.PLAIN_TEXT);
    if(backup.getBlob().getDataAsString('UTF-8')!==before)throw new Error('MODEL_BACKUP_VERIFY');
    if(hubProductionRestoreFreshText_(r)!==before)throw new Error('MODEL_CHECKPOINT_CHANGED');
    r.recoveryFreshReadBackupId=backup.getId();r.recoveryFreshReadRetry=true;r.recoveryReason='FRESH_READ_VERIFICATION_PENDING_RECEIPTS_NOT_EXPOSED';
    r.phase='RESTORE';r.sendAt=0;r.verified=0;r.begun=false;r.errors=0;r.lastError='';r.commitHttp=null;r.retryAfter=0;r.totalRetries=0;r.retryAtCount=0;
    hubProductionRestoreSave_(r);hubProductionRestoreSchedule_(r);hubProductionRestoreAudit_(r,'CHECKPOINT_SAVE','MODEL_EXISTING_FILES_RETRANSFER',null);
  }catch(error){hubProductionRestoreAudit_(r,error.step||'PRECHECK',hubProductionRestoreCode_(error,error.step||'PRECHECK'),error.http);}
  finally{lock.releaseLock();}
}

// One further approved recovery, only for the observed checkpoint readback fault.
// Receiver does not expose pending receipts: retain files but restart transfer.
function hubProductionRestoreRetryCheckpointApproved(){
  const lock=LockService.getUserLock();if(!lock.tryLock(30000)){hubProductionRestoreAudit_(null,'LOCK','MODEL_WORKER_BUSY',null);return;}
  let r;
  try{
    r=hubStageRestoreLoad_('production');const before=JSON.stringify(r);
    if(!r||r.recoveryVersion!==1||r.recoveryCheckpointRetry||r.phase!=='ERROR'||r.lastError!=='MODEL_CHECKPOINT_VERIFY'||r.sendAt!==88||r.verified!==88||r.authHalt||r.lastFailure.step!=='CHECKPOINT_SAVE')throw new Error('MODEL_RECOVERY_NOT_APPROVED');
    const b=hubProductionRestoreBaseline_(r),live=hubProductionRestoreStatus_();
    if(live.ready&&live.generation===r.generation){hubProductionRestoreAudit_(r,'READBACK','MODEL_ALREADY_COMMITTED',200);return;}
    if(live.generation&&live.generation!==r.generation)throw new Error('MODEL_GENERATION_CONFLICT');
    const backup=DriveApp.getFolderById(b.published.folderId).createFile('production-restore-before-recovery-checkpoint-'+Date.now()+'.json',before,MimeType.PLAIN_TEXT);
    if(backup.getBlob().getDataAsString('UTF-8')!==before)throw new Error('MODEL_BACKUP_VERIFY');
    if(JSON.stringify(hubStageRestoreLoad_('production'))!==before)throw new Error('MODEL_CHECKPOINT_CHANGED');
    r.recoveryCheckpointBackupId=backup.getId();r.recoveryCheckpointRetry=true;r.recoveryReason='CHECKPOINT_READBACK_FIXED_PENDING_RECEIPTS_NOT_EXPOSED';
    r.phase='RESTORE';r.sendAt=0;r.verified=0;r.begun=false;r.errors=0;r.lastError='';r.commitHttp=null;r.retryAfter=0;r.totalRetries=0;r.retryAtCount=0;
    hubProductionRestoreSave_(r);hubProductionRestoreSchedule_(r);hubProductionRestoreAudit_(r,'CHECKPOINT_SAVE','MODEL_EXISTING_FILES_RETRANSFER',null);
  }catch(error){hubProductionRestoreAudit_(r,error.step||'PRECHECK',hubProductionRestoreCode_(error,error.step||'PRECHECK'),error.http);}
  finally{lock.releaseLock();}
}
