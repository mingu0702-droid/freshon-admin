/** Published lookup restore: strictly isolated destinations; never rebuild sources. */
const HUB_MODEL_TARGETS=Object.freeze({
  stage:Object.freeze({property:'PHASE2B_STAGE_RESTORE_V1',handler:'hubStageReadModelRestoreContinue',file:'restore-checkpoint.json',
    endpointProperty:'HUB_MODEL_STAGE_ENDPOINT',secretProperty:'HUB_MAP_API_HMAC_SECRET',host:'freshon-admin-stage-preview-template.onrender.com'}),
  production:Object.freeze({property:'PHASE2B_PRODUCTION_RESTORE_V1',handler:'hubProductionReadModelRestoreContinue',file:'restore-production-checkpoint.json',
    endpointProperty:'HUB_MODEL_PRODUCTION_ENDPOINT',secretProperty:'HUB_MODEL_PRODUCTION_HMAC_SECRET',host:'freshon-admin-1.onrender.com'})
});
function hubReadModelTarget_(target){
  if(target!=='stage'&&target!=='production')throw new Error('MODEL_TARGET_INVALID');
  const c=HUB_MODEL_TARGETS[target],p=PropertiesService.getScriptProperties(),endpoint=p.getProperty(c.endpointProperty)||'';
  // Configurable endpoint, fixed authorized host/path. No arbitrary callback/SSRF.
  if(endpoint!=='https://'+c.host+'/internal/stage-read-model')throw new Error('MODEL_TARGET_ENDPOINT_INVALID');
  return Object.assign({target:target,endpoint:endpoint},c);
}
function hubReadModelRestoreConfigurationStatus(){
  const p=PropertiesService.getScriptProperties(),out={};
  ['stage','production'].forEach(function(target){const c=HUB_MODEL_TARGETS[target];
    out[target]={endpointPresent:!!p.getProperty(c.endpointProperty),secretPresent:!!p.getProperty(c.secretProperty)};
    try{hubReadModelTarget_(target);out[target].endpointValid=true;}catch(e){out[target].endpointValid=false;}
  });console.log(JSON.stringify(out));return out;
}
// Operator-approved non-secret configuration only; never writes credentials.
function hubReadModelConfigureRestoreTargets(){
  const p=PropertiesService.getScriptProperties();
  ['stage','production'].forEach(function(target){const c=HUB_MODEL_TARGETS[target],expected='https://'+c.host+'/internal/stage-read-model',saved=p.getProperty(c.endpointProperty);
    if(saved&&saved!==expected)throw new Error('MODEL_TARGET_CONFIGURATION_CONFLICT');
  });
  ['stage','production'].forEach(function(target){const c=HUB_MODEL_TARGETS[target];if(!p.getProperty(c.endpointProperty))p.setProperty(c.endpointProperty,'https://'+c.host+'/internal/stage-read-model');});
  return hubReadModelRestoreConfigurationStatus();
}
function hubReadModelRestoreStatus(){
  const out={};
  ['stage','production'].forEach(function(target){const r=hubStageRestoreLoad_(target);
    out[target]=r?{status:r.phase,sendAt:r.sendAt,lastError:r.lastError||'',generation:r.generation,updatedAt:r.updatedAt,
      verified:r.verified,commitHttp:r.commitHttp||null,totals:r.totals}:{status:'NONE'};
  });console.log(JSON.stringify(out));return out;
}
function hubReadModelRestoreSave_(r){r.status=r.phase;hubStageModelSave_(r);}

const HUB_STAGE_RESTORE=Object.freeze({property:'PHASE2B_STAGE_RESTORE_V1',handler:'hubStageReadModelRestoreContinue'});
function hubStageReadModelRestorePublished(){const r=hubStageModelRequest_({});console.log(JSON.stringify(r.data));return r;}
function hubStageRestoreManifest_(s){
  const keys=Object.keys(s&&s.shards||{}).sort(),ids={},totals={historyFiles:0,historyRows:0,periodFiles:0,periodRows:0};
  if(!s||s.phase!=='DONE'||hubStageModelAuthHalted_(s)||!Number.isSafeInteger(s.generation)||s.generation<1||!keys.length||keys.length>180||s.sendAt!==keys.length)
    throw new Error('MODEL_RESTORE_NOT_PUBLISHED');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s.startDate)||!/^\d{4}-\d{2}-\d{2}$/.test(s.endDate)||Date.parse(s.endDate)<Date.parse(s.startDate)||Date.parse(s.endDate)-Date.parse(s.startDate)>89*86400000)
    throw new Error('MODEL_RESTORE_RANGE');
  keys.forEach(function(k){const e=s.shards[k],parts=k.split(':'),kind=parts[0],date=parts[1];
    if(!/^(history|period):\d{4}-\d{2}-\d{2}$/.test(k)||date<s.startDate||date>s.endDate||!e||!e.id||ids[e.id]||!Number.isSafeInteger(e.count)||e.count<1||e.count>8000||!/^[a-f0-9]{64}$/.test(e.hash))throw new Error('MODEL_RESTORE_MANIFEST');
    ids[e.id]=true;totals[kind+'Files']++;totals[kind+'Rows']+=e.count;
  });
  return{keys:keys,totals:totals,fingerprint:hubStageModelHash_({generation:s.generation,startDate:s.startDate,endDate:s.endDate,shards:s.shards})};
}
function hubStageRestoreLoad_(target){const id=PropertiesService.getScriptProperties().getProperty(HUB_MODEL_TARGETS[target||'stage'].property);return id?JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8')):null;}
function hubStageRestoreSchedule_(replace,target){
  const c=HUB_MODEL_TARGETS[target||'stage'];
  if(replace)hubStageRestoreUnschedule_(target);
  if(!ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()===c.handler;}))ScriptApp.newTrigger(c.handler).timeBased().after(60000).create();
}
function hubStageRestoreUnschedule_(target){const c=HUB_MODEL_TARGETS[target||'stage'];ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()===c.handler;}).forEach(function(t){ScriptApp.deleteTrigger(t);});}
// Called while the existing Hub user lock is held.
function hubStageModelRestoreRequest_(published,target){
  target=target||'stage';const c=hubReadModelTarget_(target),m=hubStageRestoreManifest_(published);
  if(!PropertiesService.getScriptProperties().getProperty(c.secretProperty))throw new Error('MODEL_AUTH_MISSING');
  if(target==='production'&&(published.generation!==1789933588775||m.keys.length!==156
    ||m.totals.historyFiles!==78||m.totals.periodFiles!==78||m.totals.historyRows!==120035||m.totals.periodRows!==147689))
    throw new Error('MODEL_RESTORE_APPROVED_BASELINE');
  const props=PropertiesService.getScriptProperties(),ownId=props.getProperty(c.property),otherId=props.getProperty(HUB_MODEL_TARGETS[target==='stage'?'production':'stage'].property);
  if(ownId&&(ownId===otherId||ownId===published.stateId||m.keys.some(function(k){return published.shards[k].id===ownId;})))throw new Error('MODEL_RESTORE_TARGET_CONFLICT');
  let r=hubStageRestoreLoad_(target);
  if(r&&r.stateId!==ownId)throw new Error('MODEL_RESTORE_TARGET_CONFLICT');
  if(r&&r.target&&r.target!==target)throw new Error('MODEL_RESTORE_TARGET_CONFLICT');
  if(r&&r.phase==='ERROR')return{data:{phase:'ERROR',operation:'RESTORE',generation:r.generation,error:r.lastError,continuation:'NONE'},cached:false};
  if(r&&r.phase==='RESTORE'){
    if(r.generation!==published.generation||r.fingerprint!==m.fingerprint)throw new Error('MODEL_RESTORE_CONFLICT');
    hubStageRestoreSchedule_(false,target);return{data:{phase:'RESTORE',generation:r.generation,sendAt:r.sendAt,continuation:'ACTIVE'},cached:false};
  }
  const id=r?r.stateId:DriveApp.getFolderById(published.folderId).createFile(c.file,'{}',MimeType.PLAIN_TEXT).getId();
  r={v:1,target:target,endpoint:c.endpoint,stateId:id,publishedStateId:published.stateId,generation:published.generation,phase:'RESTORE',fingerprint:m.fingerprint,
    startDate:published.startDate,endDate:published.endDate,sendAt:0,begun:false,verified:0,errors:0,lastError:'',totals:m.totals};
  hubReadModelRestoreSave_(r);PropertiesService.getScriptProperties().setProperty(c.property,id);hubStageRestoreSchedule_(false,target);
  return{data:{phase:'RESTORE',generation:r.generation,sendAt:0,shards:m.keys.length,continuation:'ACTIVE'},cached:false};
}
function hubStageReadModelRestoreContinue(){return hubReadModelRestoreContinue_('stage');}
function hubProductionReadModelRestoreContinue(){return hubReadModelRestoreContinue_('production');}
function hubReadModelRestoreContinue_(target){
  const lock=LockService.getUserLock();
  if(!lock.tryLock(1000)){
    // Another target may own the existing Hub lock. Replace only this target's
    // consumed one-shot continuation; never leave a busy target stranded.
    const waiting=hubStageRestoreLoad_(target);
    if(waiting&&waiting.phase==='RESTORE'&&(!waiting.target||waiting.target===target))hubStageRestoreSchedule_(true,target);
    return;
  }
  let r;
  try{
    hubStageRestoreUnschedule_(target);const loaded=hubStageRestoreLoad_(target);if(!loaded||loaded.phase!=='RESTORE')return;
    const c=hubReadModelTarget_(target);
    const props=PropertiesService.getScriptProperties(),other=HUB_MODEL_TARGETS[target==='stage'?'production':'stage'];
    if(loaded.stateId!==props.getProperty(c.property)||loaded.stateId===props.getProperty(other.property)||loaded.stateId===loaded.publishedStateId||(loaded.target&&loaded.target!==target))throw new Error('MODEL_RESTORE_TARGET_CONFLICT');
    r=loaded;
    if(r.endpoint&&r.endpoint!==c.endpoint)throw new Error('MODEL_RESTORE_TARGET_CONFLICT');
    const published=JSON.parse(DriveApp.getFileById(r.publishedStateId).getBlob().getDataAsString('UTF-8')),m=hubStageRestoreManifest_(published);
    if(r.fingerprint!==m.fingerprint||r.generation!==published.generation||!Number.isInteger(r.sendAt)||r.sendAt<0||r.sendAt>m.keys.length||r.verified!==r.sendAt)throw new Error('MODEL_RESTORE_CONFLICT');
    const deadline=Date.now()+240000;hubStageRestoreSchedule_(false,target);
    if(!r.begun){r.firstHttp=hubStageModelSend_({type:'begin',generation:r.generation},target);r.begun=true;hubReadModelRestoreSave_(r);}
    while(r.sendAt<m.keys.length&&Date.now()<deadline){
      const key=m.keys[r.sendAt],e=published.shards[key],rows=JSON.parse(DriveApp.getFileById(e.id).getBlob().getDataAsString('UTF-8'));
      if(!Array.isArray(rows)||rows.length!==e.count||hubStageModelHash_(rows)!==e.hash)throw new Error('MODEL_RESTORE_SHARD_CHANGED');
      const http=hubStageModelSend_({type:'shard',generation:r.generation,kind:key.split(':')[0],date:key.split(':')[1],hash:e.hash,rows:rows},target);
      if(http!==200)throw new Error('MODEL_RESTORE_ACK');
      if(!r.unicodeVerified&&/[가-힣]/.test(JSON.stringify(rows)))r.unicodeVerified=true;
      r.sendAt++;r.verified++;hubReadModelRestoreSave_(r);
    }
    if(r.sendAt===m.keys.length){
      const current=JSON.parse(DriveApp.getFileById(r.publishedStateId).getBlob().getDataAsString('UTF-8'));
      if(hubStageRestoreManifest_(current).fingerprint!==r.fingerprint)throw new Error('MODEL_RESTORE_CONFLICT');
      r.commitHttp=hubStageModelSend_({type:'commit',generation:r.generation,startDate:r.startDate,endDate:r.endDate,
        manifest:m.keys.map(function(k){return{key:k,hash:published.shards[k].hash,count:published.shards[k].count};})},target);
      r.phase='DONE';r.errors=0;r.lastError='';hubReadModelRestoreSave_(r);
      console.log(JSON.stringify({operation:'RESTORE',phase:'DONE',generation:r.generation,verified:r.verified,commitHttp:r.commitHttp,totals:r.totals}));
    }
  }catch(e){
    if(r&&r.phase==='RESTORE'){
      r.errors=(r.errors||0)+1;r.lastError=/^MODEL_[A-Z0-9_]+$/.test(String(e.message))?e.message:'MODEL_RESTORE_FAILED';
      if(e.modelAuthFatal||/MODEL_STAGE_HTTP_(401|403)$/.test(r.lastError)){r.authHalt=true;r.phase='ERROR';}
      else if(!/^MODEL_STAGE_HTTP_5\d\d$/.test(r.lastError)||r.errors>=3)r.phase='ERROR';
      hubReadModelRestoreSave_(r);
    }
  }finally{
    if(r&&r.phase==='RESTORE')hubStageRestoreSchedule_(true,target);else hubStageRestoreUnschedule_(target);lock.releaseLock();
  }
}
