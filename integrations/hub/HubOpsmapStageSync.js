// Optional Stage handoff from the existing clock trigger. No trigger installation.
function hubOpsmapStageSyncDispatch_(event) {
  const props=PropertiesService.getScriptProperties();
  const raw=props.getProperty('OPSMAP_STAGE_SYNC_DISPATCH_V1');
  if (!raw) return;
  function hex(bytes){return bytes.map(function(n){return ('0'+((n+256)%256).toString(16)).slice(-2);}).join('');}
  function digest(value){return hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value,Utilities.Charset.UTF_8));}
  let runId=null;
  try {
    const settings=JSON.parse(raw);
    if(settings.enabled!==true) return;
    const triggerId=String(event&&event.triggerUid||'');
    const secret=props.getProperty('OPSMAP_STAGE_SYNC_SCHEDULER_SECRET');
    const found=ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()==='hubProductionMapAutoTick';});
    if(!/^\d{1,30}$/.test(triggerId)||settings.triggerId!==triggerId||found.length!==1||found[0].getUniqueId()!==triggerId||
        found[0].getTriggerSource()!==ScriptApp.TriggerSource.CLOCK||!secret||secret.length<32||secret.length>512)throw Error('OPSMAP_SCHEDULE_TRIGGER_SCOPE');
    const account=Session.getEffectiveUser().getEmail().trim().toLowerCase();
    const principal=account?digest(account):null;
    if(!principal||principal!==settings.executorHash)throw Error('OPSMAP_SCHEDULE_EXECUTOR_SCOPE');
    const time=new Date(),issuedAt=time.toISOString(),slot=Math.floor(time.getTime()/3600000);
    const date=Utilities.formatDate(time,'Asia/Seoul','yyyy-MM-dd'),origin='APPS_SCRIPT_TIME_TRIGGER';
    runId=digest(JSON.stringify([1,origin,triggerId,principal,slot]));
    const signature=hex(Utilities.computeHmacSha256Signature(JSON.stringify([1,origin,triggerId,principal,issuedAt,slot,date,runId]),secret,Utilities.Charset.UTF_8));
    const response=UrlFetchApp.fetch('https://freshon-admin-stage-preview-template.onrender.com/internal/opsmap/scheduled-sync',{
      method:'post',contentType:'application/json',payload:JSON.stringify({version:1,origin,triggerId,principal,issuedAt,slot,date,runId,signature}),
      followRedirects:false,muteHttpExceptions:true});
    console.log(JSON.stringify({component:'opsmap-stage-scheduled-dispatch',runId,status:response.getResponseCode(),issuedAt}));
  } catch(error) {
    console.log(JSON.stringify({component:'opsmap-stage-scheduled-dispatch',runId,
      error:/^OPSMAP_SCHEDULE_[A-Z_]+$/.test(error.message||'')?error.message:'OPSMAP_SCHEDULE_DISPATCH_FAILED'}));
  }
}
