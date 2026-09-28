/** Production checkpoint only. Never mutates Stage, sources or shard files. */
function hubProductionCheckpointError_(error,step){
  const raw=String(error&&error.message||'');
  const code=/^MODEL_[A-Z0-9_]+$/.test(raw)?raw:
    /permission|authoriz|access denied|권한/i.test(raw)?'MODEL_PERMISSION_DENIED':
    /too many times|quota|할당량/i.test(raw)?'MODEL_QUOTA_LIMIT':
    /service error.*Drive|internal error|일시적인/i.test(raw)?'MODEL_DRIVE_SERVICE_ERROR':
    /timed? ?out|timeout|시간 초과/i.test(raw)?'MODEL_NETWORK_TIMEOUT':'MODEL_'+step+'_FAILED';
  return Object.assign(new Error(code),{step:step,http:Number(error&&error.http)||null});
}
function hubProductionCheckpointWrite_(r,expected){
  const props=PropertiesService.getScriptProperties();
  if(r.target!=='production'||r.stateId!==props.getProperty(HUB_MODEL_TARGETS.production.property)||r.stateId===props.getProperty(HUB_MODEL_TARGETS.stage.property)||r.stateId===props.getProperty(HUB_STAGE_MODEL.property))throw new Error('MODEL_RESTORE_TARGET_CONFLICT');
  let file;
  try{file=DriveApp.getFileById(r.stateId);}catch(e){throw hubProductionCheckpointError_(e,'CHECKPOINT_FILE_ACCESS');}
  let writeError=null;
  try{file.setContent(expected);}catch(e){writeError=hubProductionCheckpointError_(e,'CHECKPOINT_WRITE');}
  if(writeError&&['MODEL_PERMISSION_DENIED','MODEL_QUOTA_LIMIT'].indexOf(writeError.message)>=0)throw writeError;
  // Do not mutate r or serialize again during read-back. A write exception may
  // have occurred after commit, so the same frozen bytes are always checked.
  let actual=null;
  try{actual=file.getBlob().getDataAsString('UTF-8');}catch(ignored){}
  if(actual===expected){if(writeError)hubProductionRestoreAudit_(r,'CHECKPOINT_VERIFY','MODEL_WRITE_ACK_LOST_VERIFIED',null);return;}
  for(let attempt=0;attempt<2;attempt++){
    Utilities.sleep(250*(attempt+1));
    try{actual=DriveApp.getFileById(r.stateId).getBlob().getDataAsString('UTF-8');}catch(ignored){}
    if(actual===expected){hubProductionRestoreAudit_(r,'CHECKPOINT_VERIFY','MODEL_CHECKPOINT_READBACK_RECOVERED',null);return;}
  }
  let fresh;
  try{fresh=hubProductionRestoreFreshText_(r);}catch(e){throw hubProductionCheckpointError_(e,'CHECKPOINT_READBACK');}
  if(fresh===expected){hubProductionRestoreAudit_(r,'CHECKPOINT_VERIFY','MODEL_CHECKPOINT_DRIVEAPP_STALE_CONFIRMED',200);return;}
  if(writeError)throw writeError;
  let saved,wanted;
  try{saved=JSON.parse(fresh);wanted=JSON.parse(expected);}catch(e){throw new Error('MODEL_CHECKPOINT_JSON_INVALID');}
  throw Object.assign(new Error(saved.generation!==wanted.generation||saved.sendAt!==wanted.sendAt||saved.phase!==wanted.phase?'MODEL_CHECKPOINT_CONFLICT':'MODEL_CHECKPOINT_SERIALIZATION_MISMATCH'),{step:'CHECKPOINT_VERIFY',http:200});
}
function hubProductionCheckpointSave_(r){
  r.status=r.phase;r.updatedAt=new Date().toISOString();r.recoveryStep='CHECKPOINT_SAVE';
  let expected;
  try{expected=JSON.stringify(r);}catch(e){throw hubProductionCheckpointError_(e,'CHECKPOINT_SERIALIZE');}
  return hubProductionCheckpointWrite_(r,expected);
}
// Approved exact-state write/read test. No ERROR reset, transfer or trigger.
function hubProductionCheckpointVerifyCurrent(){
  const lock=LockService.getUserLock();if(!lock.tryLock(1000))throw new Error('MODEL_WORKER_BUSY');
  let r;
  try{
    r=hubStageRestoreLoad_('production');
    if(!r||r.generation!==1789933588775||r.phase!=='ERROR'||r.sendAt!==45||r.verified!==45||r.lastError!=='MODEL_CHECKPOINT_SAVE_FAILED')throw new Error('MODEL_CHECKPOINT_BASELINE_CHANGED');
    const before=hubProductionRestoreFreshText_(r);
    if(before!==JSON.stringify(r))throw new Error('MODEL_CHECKPOINT_CONFLICT');
    const published=hubStageModelLoad_(),folder=DriveApp.getFolderById(published.folderId);
    const backup=folder.createFile('production-checkpoint-before-storage-verify-'+Date.now()+'.json',before,MimeType.PLAIN_TEXT);
    if(backup.getBlob().getDataAsString('UTF-8')!==before)throw new Error('MODEL_BACKUP_VERIFY');
    if(hubProductionRestoreFreshText_(r)!==before)throw new Error('MODEL_CHECKPOINT_CHANGED');
    hubProductionCheckpointWrite_(r,before);
    hubProductionRestoreAudit_(r,'CHECKPOINT_VERIFY','MODEL_CHECKPOINT_EXACT_WRITE_PASS',200);
  }catch(e){const safe=hubProductionCheckpointError_(e,e.step||'CHECKPOINT_PRECHECK');hubProductionRestoreAudit_(r,safe.step,safe.message,safe.http);}
  finally{lock.releaseLock();}
}
// One approved repair of the observed ERROR45. Receiver does not expose pending
// receipts: reuse identical immutable files, never rescan or regenerate data.
function hubProductionCheckpointResumeApproved(){
  const lock=LockService.getUserLock();if(!lock.tryLock(1000))throw new Error('MODEL_WORKER_BUSY');
  let r;
  try{
    r=hubStageRestoreLoad_('production');if(!r)throw new Error('MODEL_CHECKPOINT_MISSING');
    const live=hubProductionRestoreStatus_();
    if(live.ready&&live.generation===r.generation){hubProductionRestoreAudit_(r,'READBACK','MODEL_ALREADY_COMMITTED',200);return;}
    if(r.phase==='RESTORE'){hubProductionRestoreAudit_(r,'PRECHECK','MODEL_ALREADY_RUNNING',null);return;}
    if(r.generation!==1789933588775||r.phase!=='ERROR'||r.sendAt!==45||r.verified!==45||r.lastError!=='MODEL_CHECKPOINT_SAVE_FAILED'||r.authHalt||r.frozenStorageRepair)throw new Error('MODEL_CHECKPOINT_BASELINE_CHANGED');
    if(PropertiesService.getScriptProperties().getProperty('PHASE2B_PRODUCTION_RESTORE_HALT_V2'))throw new Error('MODEL_RESTORE_HALT_REQUIRES_DIAGNOSIS');
    if(live.generation&&live.generation!==r.generation)throw new Error('MODEL_GENERATION_CONFLICT');
    const job=typeof hubMapIncrementalLoad_==='function'?hubMapIncrementalLoad_():null;
    if(job&&job.phase!=='DONE'&&job.phase!=='ERROR')throw new Error('MODEL_INCREMENTAL_BUSY');
    const before=hubProductionRestoreFreshText_(r),b=hubProductionRestoreBaseline_(JSON.parse(JSON.stringify(r))),deadline=Date.now()+240000;
    if(before!==JSON.stringify(r))throw new Error('MODEL_CHECKPOINT_CONFLICT');
    b.manifest.keys.forEach(function(key){
      if(Date.now()>deadline)throw new Error('MODEL_PREFLIGHT_TIME_LIMIT');
      const e=b.published.shards[key],rows=JSON.parse(DriveApp.getFileById(e.id).getBlob().getDataAsString('UTF-8'));
      if(!Array.isArray(rows)||rows.length!==e.count||hubStageModelHash_(rows)!==e.hash)throw new Error('MODEL_RESTORE_SHARD_CHANGED');
    });
    if(hubProductionRestoreFreshText_(r)!==before)throw new Error('MODEL_CHECKPOINT_CHANGED');
    const backup=DriveApp.getFolderById(b.published.folderId).createFile('production-restore-before-frozen-save-'+Date.now()+'.json',before,MimeType.PLAIN_TEXT);
    if(backup.getBlob().getDataAsString('UTF-8')!==before)throw new Error('MODEL_BACKUP_VERIFY');
    if(hubProductionRestoreFreshText_(r)!==before)throw new Error('MODEL_CHECKPOINT_CHANGED');
    // Prove the replacement writer before changing any progress/state fields.
    hubProductionCheckpointWrite_(r,before);
    r.frozenStorageRepair=true;r.frozenStorageBackupId=backup.getId();r.recoveryReason='FROZEN_WRITE_VERIFIED_PENDING_RECEIPTS_UNAVAILABLE';
    r.phase='RESTORE';r.sendAt=0;r.verified=0;r.begun=false;r.errors=0;r.lastError='';r.commitHttp=null;r.retryAfter=0;r.totalRetries=0;r.retryAtCount=0;
    hubProductionCheckpointSave_(r);hubProductionRestoreSchedule_(r);
    hubProductionRestoreAudit_(r,'CHECKPOINT_VERIFY','MODEL_EXISTING_FILES_RETRANSFER',200);
  }catch(e){const safe=hubProductionCheckpointError_(e,e.step||'PRECHECK');hubProductionRestoreAudit_(r,safe.step,safe.message,safe.http);}
  finally{lock.releaseLock();}
}
// The observed global ReferenceError happened before the continuation handler,
// so its consumed trigger can remain listed. Re-arm only this stalled restore;
// keep every checkpoint byte/cursor and let the existing worker send normally.
function hubProductionCheckpointRearmInterrupted(){
  const lock=LockService.getUserLock();if(!lock.tryLock(1000))throw new Error('MODEL_WORKER_BUSY');
  let r;
  try{
    r=hubStageRestoreLoad_('production');
    if(!r||r.target!=='production'||r.generation!==1789933588775||r.phase!=='RESTORE'||!r.frozenStorageRepair||r.authHalt||r.sendAt!==r.verified)throw new Error('MODEL_REARM_BASELINE_CHANGED');
    if(PropertiesService.getScriptProperties().getProperty('PHASE2B_PRODUCTION_RESTORE_HALT_V2'))throw new Error('MODEL_RESTORE_HALTED');
    if(!Number.isFinite(Date.parse(r.updatedAt))||Date.now()-Date.parse(r.updatedAt)<300000){hubProductionRestoreAudit_(r,'PRECHECK','MODEL_RECENT_PROGRESS_WAIT',null);return;}
    const before=hubProductionRestoreFreshText_(r);if(before!==JSON.stringify(r))throw new Error('MODEL_CHECKPOINT_CHANGED');
    hubProductionRestoreBaseline_(JSON.parse(JSON.stringify(r)));
    if(hubProductionRestoreFreshText_(r)!==before)throw new Error('MODEL_CHECKPOINT_CHANGED');
    hubProductionRestoreSchedule_(r);
    hubProductionRestoreAudit_(r,'CONTINUATION','MODEL_STALLED_CONTINUATION_REARMED',null);
  }catch(e){const safe=hubProductionCheckpointError_(e,e.step||'REARM_PRECHECK');hubProductionRestoreAudit_(r,safe.step,safe.message,safe.http);}
  finally{lock.releaseLock();}
}
