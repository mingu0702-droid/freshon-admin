/** Production map only. Customer and Stage triggers/state are never mutated. */
const HUB_MAP_AUTO=Object.freeze({handler:'hubProductionMapAutoTick',property:'PHASE2B_PRODUCTION_MAP_AUTOMATION_V1'});
function hubMapAutomationLoad_(){
  const text=PropertiesService.getScriptProperties().getProperty(HUB_MAP_AUTO.property);return text?JSON.parse(text):{};
}
function hubMapAutomationStatus_(){
  const s=hubMapAutomationLoad_(),count=ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()===HUB_MAP_AUTO.handler;}).length;
  return {configured:count===1,status:count===0?'NOT_CONFIGURED':count>1?'DUPLICATE_TRIGGER':s.status||'REGISTERED_NOT_RUN',lastCheck:s.lastCheck||null,lastRequest:s.lastRequest||null,lastSuccess:s.lastSuccess||null,lastError:s.lastError||null,generation:s.generation||null};
}
// Explicit operator action only, after a verified real manual publish.
function hubProductionMapAutoInstall(){
  const lock=LockService.getUserLock();if(!lock.tryLock(1000))throw new Error('MODEL_WORKER_BUSY');
  try{
    const p=hubStageModelLoad_(),job=hubMapIncrementalLoad_(),m=hubStageRestoreManifest_(p),restore=hubStageRestoreLoad_('production');
    if(!job||job.phase!=='DONE'||job.publication!=='PUBLISHED'||p.stateId!==job.stateId||p.verifiedFingerprint!==m.fingerprint||p.commitHttp!==200)throw new Error('MODEL_AUTOMATION_MANUAL_PASS_REQUIRED');
    if(restore&&restore.phase==='RESTORE')throw new Error('MODEL_INCREMENTAL_RESTORE_BUSY');
    const found=ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()===HUB_MAP_AUTO.handler;});
    if(found.length>1)throw new Error('MODEL_AUTOMATION_DUPLICATE');
    if(!found.length)ScriptApp.newTrigger(HUB_MAP_AUTO.handler).timeBased().everyHours(1).create();
    console.log(JSON.stringify(hubMapAutomationStatus_()));
  }finally{lock.releaseLock();}
}
function hubProductionMapAutoTick(){
  // Request helper acquires the same user lock as restore/candidate workers.
  // No implicit retry of ERROR, no source collection, no force-resume.
  const s=hubMapAutomationLoad_();s.lastCheck=new Date().toISOString();
  try{
    const r=hubStageRestoreLoad_('production'),job=hubMapIncrementalLoad_(),published=hubStageModelLoad_();
    if(r&&r.phase==='RESTORE'){s.status='WAITING_RESTORE';}
    else if(r&&r.phase==='ERROR'){s.status='ERROR';s.lastError='MODEL_RESTORE_REQUIRES_REVIEW';}
    else if(job&&(job.phase==='ERROR'||job.publication==='ERROR')){s.status='ERROR';s.lastError=job.lastError||'MODEL_INCREMENTAL_REQUIRES_REVIEW';}
    else if(job&&(job.phase!=='DONE'||job.publication==='PENDING')){s.status='RUNNING';s.generation=job.generation;}
    else {
      if(job&&job.origin==='AUTO'&&job.generation===s.requestGeneration&&job.phase==='DONE'&&job.publication==='PUBLISHED'&&published.stateId===job.stateId&&job.commitHttp===200){
        s.lastSuccess=job.updatedAt;s.generation=job.generation;
      }
      const result=hubMapIncrementalRequest_({target:'production'},'AUTO').data;
      s.status=result.phase==='UP_TO_DATE'?'NOOP':result.phase==='BUSY'?'WAITING_WORKER':result.phase==='ERROR'?'ERROR':'REQUESTED';
      if(s.status==='REQUESTED'){s.lastRequest=s.lastCheck;s.generation=result.generation||null;s.requestGeneration=result.generation||null;}
      s.lastError=result.phase==='ERROR'?(result.lastError||'MODEL_INCREMENTAL_FAILED'):null;
    }
  }catch(e){s.status='ERROR';s.lastError=/^MODEL_[A-Z0-9_]+$/.test(String(e.message))?e.message:'MODEL_AUTOMATION_FAILED';}
  PropertiesService.getScriptProperties().setProperty(HUB_MAP_AUTO.property,JSON.stringify(s));
  console.log(JSON.stringify(hubMapAutomationStatus_()));
}
function hubMapCandidateCheckpointSave_(c){
  const props=PropertiesService.getScriptProperties(),own=props.getProperty(HUB_MAP_INCREMENTAL.property),published=props.getProperty(HUB_STAGE_MODEL.property);
  if(c.operation!=='MAP_INCREMENTAL'||c.publishTarget!=='production'||!c.stateId||c.stateId===c.baseStateId||c.stateId===props.getProperty(HUB_MODEL_TARGETS.stage.property)||c.stateId===props.getProperty(HUB_MODEL_TARGETS.production.property))throw new Error('MODEL_CANDIDATE_CHECKPOINT_CONFLICT');
  if(Object.keys(c.shards||{}).some(function(k){return c.shards[k].id===c.stateId;})||published===c.stateId&&c.phase!=='DONE')throw new Error('MODEL_CANDIDATE_CHECKPOINT_CONFLICT');
  // A new private candidate has not yet installed its own pointer. An existing
  // pointer may only belong to a completed predecessor, never an active worker.
  if(own&&own!==c.stateId){const old=hubMapIncrementalLoad_();if(!old||old.phase!=='DONE'||old.publication!=='PUBLISHED')throw new Error('MODEL_CANDIDATE_CHECKPOINT_CONFLICT');}
  if(published!==c.baseStateId&&published!==c.stateId)throw new Error('MODEL_INCREMENTAL_BASE_CHANGED');
  c.updatedAt=new Date().toISOString();const text=JSON.stringify(c),file=DriveApp.getFileById(c.stateId);let error=null;
  try{file.setContent(text);}catch(e){error=hubProductionCheckpointError_(e,'CANDIDATE_WRITE');}
  if(error&&['MODEL_PERMISSION_DENIED','MODEL_QUOTA_LIMIT'].indexOf(error.message)>=0)throw error;
  let actual=null;try{actual=file.getBlob().getDataAsString('UTF-8');}catch(ignored){}
  if(actual===text)return;
  const response=UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(c.stateId)+'?alt=media&candidateRead='+Date.now(),{headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true});
  if(response.getResponseCode()!==200)throw new Error('MODEL_CANDIDATE_READBACK_HTTP_'+response.getResponseCode());
  if(response.getContentText()===text)return;
  if(error)throw error;throw new Error('MODEL_CANDIDATE_CHECKPOINT_MISMATCH');
}
