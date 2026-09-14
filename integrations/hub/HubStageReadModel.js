/** Isolated Stage lookup. Customer/Archive are read-only; Production handlers untouched.
 * Private Drive folder contains ONLY allowlisted history and public relations.
 * Source rows are never copied wholesale; checkpoint is durable, not Render memory.
 */
const HUB_STAGE_MODEL = Object.freeze({
  property:'PHASE2B_STAGE_READ_MODEL_V1', continuation:'hubStageReadModelContinue', watchdog:'hubStageReadModelWatchdog',
  destination:'https://freshon-admin-stage-preview-template.onrender.com/internal/stage-read-model', batch:1000
});
function hubStageModelHash_(value){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(value)).map(function(n){return('0'+(n&255).toString(16)).slice(-2);}).join('');}
function hubStageModelUpdated_(value){const d=hubStaffHistoryDate_(value);if(!d)return 0;const t=String(value).match(/(?:T|\s)(\d{1,2}):(\d\d)(?::(\d\d))?/);return Date.parse(d)+(t?Number(t[1])*3600000+Number(t[2])*60000+Number(t[3]||0)*1000:0);}
function hubStageModelSave_(s){s.updatedAt=new Date().toISOString();const f=DriveApp.getFileById(s.stateId),text=JSON.stringify(s);f.setContent(text);if(f.getBlob().getDataAsString()!==text)throw new Error('MODEL_CHECKPOINT_VERIFY');}
function hubStageModelLoad_(){const id=PropertiesService.getScriptProperties().getProperty(HUB_STAGE_MODEL.property);return id?JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString()):null;}
function hubStageModelSchedule_(replace){
  // Expired one-shot triggers can remain listed after a lock collision.
  if(replace)ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()===HUB_STAGE_MODEL.continuation;}).forEach(function(t){ScriptApp.deleteTrigger(t);});
  if(!ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()===HUB_STAGE_MODEL.continuation;}))
    ScriptApp.newTrigger(HUB_STAGE_MODEL.continuation).timeBased().after(60000).create();
}
function hubStageModelSend_(message){
  const body={timestamp:String(Date.now()),nonce:Utilities.getUuid().replace(/-/g,''),message:message},text=JSON.stringify(body);
  const secret=PropertiesService.getScriptProperties().getProperty(HUB_MAP_HTTP_API.SECRET_PROPERTY);
  if(!secret)throw new Error('MODEL_AUTH_MISSING');
  const signature=Utilities.computeHmacSha256Signature(text,secret).map(function(n){return('0'+(n&255).toString(16)).slice(-2);}).join('');
  const r=UrlFetchApp.fetch(HUB_STAGE_MODEL.destination,{method:'post',contentType:'application/json',payload:text,headers:{'x-stage-model-signature':signature},muteHttpExceptions:true,followRedirects:false});
  if(r.getResponseCode()!==200)throw new Error('MODEL_STAGE_HTTP_'+r.getResponseCode());
  // ACK only; never log response contents or protected lookup values.
}
function hubStageModelRequest_(params){
  hubMapHttpValidateOnlyKeys_(params,[]);
  // Migration fence only: never overlap an older Stage worker using ScriptLock.
  // Long-running Stage work uses UserLock, separate from Production Hub ScriptLock.
  const fence=LockService.getScriptLock();if(!fence.tryLock(1000))return{data:{phase:'BUSY'},cached:false};
  const lock=LockService.getUserLock();if(!lock.tryLock(1000)){fence.releaseLock();return{data:{phase:'BUSY'},cached:false};}
  try{
    let s=hubStageModelLoad_();
    if(s&&s.workerVersion!==3){
      ScriptApp.getProjectTriggers().filter(function(t){return [HUB_STAGE_MODEL.continuation,HUB_STAGE_MODEL.watchdog].indexOf(t.getHandlerFunction())>=0;}).forEach(function(t){ScriptApp.deleteTrigger(t);});
      s.workerVersion=3;hubStageModelSave_(s);
    }
    if(!s){
      const folder=DriveApp.createFolder('Phase2B_Stage_ReadModel_v1');
      // Newly-created folder inherits only the executing owner's private My Drive.
      if(folder.getSharingAccess()!==DriveApp.Access.PRIVATE)throw new Error('MODEL_STORAGE_NOT_PRIVATE');
      const stateFile=folder.createFile('checkpoint.json','{}',MimeType.PLAIN_TEXT);
      const end=Utilities.formatDate(new Date(),'Asia/Seoul','yyyy-MM-dd'),start=new Date(Date.parse(end)-89*86400000).toISOString().slice(0,10);
      s={v:1,workerVersion:3,stateId:stateFile.getId(),folderId:folder.getId(),phase:'BUILD',startDate:start,endDate:end,generation:Date.now(),source:0,scanned:0,shards:{},sources:[
        {id:HUB_STAFF_DETAIL_ARCHIVE,sheet:'delivery_admin_raw',kind:'history',next:2},
        {id:HUB_DEFAULT_SOURCE_ID,sheet:'delivery_admin_raw',kind:'history',next:2},
        {id:HUB_STAFF_DETAIL_ARCHIVE,sheet:'daily_routes',kind:'period',next:2},
        {id:HUB_DEFAULT_SOURCE_ID,sheet:'daily_routes',kind:'period',next:2}],sendAt:0,errors:0};
      hubStageModelSave_(s);PropertiesService.getScriptProperties().setProperty(HUB_STAGE_MODEL.property,s.stateId);
    }else if(s.phase==='DONE'||s.phase==='SEND'){
      // Rehydrate a new Render process from the published model, never raw scans.
      s.phase='SEND';s.sendAt=0;s.errors=0;hubStageModelSave_(s);
    }
    if(s.phase!=='ERROR')hubStageModelSchedule_();
    if(!ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()===HUB_STAGE_MODEL.watchdog;}))
      ScriptApp.newTrigger(HUB_STAGE_MODEL.watchdog).timeBased().everyMinutes(15).create();
    return{data:{phase:s.phase,scanned:s.scanned,continuation:s.phase==='ERROR'?'NONE':'ACTIVE'},cached:false};
  }finally{lock.releaseLock();fence.releaseLock();}
}
function hubStageModelReadColumns_(source,sheet,headers,start,count,wanted){
  if(count<1||count>HUB_STAGE_MODEL.batch)throw new Error('MODEL_BATCH_LIMIT');
  const filters=wanted.map(function(k){const c=headers.indexOf(k);if(c<0)throw new Error('MODEL_HEADER');return{gridRange:{sheetId:sheet.getSheetId(),startRowIndex:start-1,endRowIndex:start-1+count,startColumnIndex:c,endColumnIndex:c+1}};});
  const r=UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'+source.id+'/values:batchGetByDataFilter',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},payload:JSON.stringify({dataFilters:filters,valueRenderOption:'FORMATTED_VALUE'}),muteHttpExceptions:true});
  if(r.getResponseCode()!==200)throw new Error('MODEL_SOURCE_HTTP_'+r.getResponseCode());
  let body;try{body=JSON.parse(r.getContentText());}catch(ignored){throw new Error('MODEL_SOURCE_JSON');}
  if(!Array.isArray(body.valueRanges)||body.valueRanges.length!==wanted.length)throw new Error('MODEL_SOURCE_INCOMPLETE');
  const rows=Array.from({length:count},function(){return{};}),seen={};
  body.valueRanges.forEach(function(item){
    const g=item.dataFilters&&item.dataFilters[0]&&item.dataFilters[0].gridRange,k=g&&headers[g.startColumnIndex||0],values=item.valueRange&&item.valueRange.values||[];
    if(!g||wanted.indexOf(k)<0||seen[k]||(g.startRowIndex||0)!==start-1||g.endRowIndex!==start-1+count||values.length>count)throw new Error('MODEL_SOURCE_RANGE');
    seen[k]=true;for(let n=0;n<count;n++)rows[n][k]=String(values[n]&&values[n][0]||'');
  });return rows;
}
function hubStageModelBuildBatch_(s){
  const source=s.sources[s.source],sheet=SpreadsheetApp.openById(source.id).getSheetByName(source.sheet);
  if(!sheet)throw new Error('MODEL_SOURCE_MISSING');
  const last=sheet.getLastRow(),width=sheet.getLastColumn();if(width<1||width>64)throw new Error('MODEL_HEADER');
  const headers=sheet.getRange(1,1,1,width).getValues()[0].map(String),h=hubStageModelHash_(headers);
  if(source.headerHash&&source.headerHash!==h)throw new Error('MODEL_HEADER_CHANGED');source.headerHash=h;
  if(source.end===undefined)source.end=last;
  if(last<source.end)throw new Error('MODEL_SOURCE_MOVED');
  const dateCol=headers.indexOf('deliveryDate');if(dateCol<0)throw new Error('MODEL_DATE_HEADER');
  // Detect concurrent retention moving the cursor before reading another batch.
  if(source.tail){const actual=sheet.getRange(source.next-1,1,1,Math.min(width,5)).getDisplayValues()[0];if(hubStageModelHash_(actual)!==source.tail)throw new Error('MODEL_SOURCE_MOVED');}
  if(source.next>source.end){s.source++;return;}
  const scanCount=Math.min(5000,source.end-source.next+1),before=DriveApp.getFileById(source.id).getLastUpdated().getTime();
  const dates=sheet.getRange(source.next,dateCol+1,scanCount,1).getValues().map(function(r){return hubStaffHistoryDate_(r[0]);});
  const inRange=function(d){return d&&d>=s.startDate&&d<=s.endDate;};
  // Skip out-of-window blocks using ONE date column; projected task reads stay <=1000.
  const count=dates.some(inRange)?Math.min(HUB_STAGE_MODEL.batch,scanCount):scanCount;
  let rows=[];
  if(dates.slice(0,count).some(inRange)){
    const wanted=source.kind==='history'?['deliveryDate','customerCode','deliveryId','confirmedVehicle','driverName','driverPhone','deliveryStatus','rawHash','updatedAt']:['deliveryDate','customerCode','confirmedVehicle','baseVehicle','driverName','driverPhone'];
    rows=hubStageModelReadColumns_(source,sheet,headers,source.next,count,wanted);
  }
  const tail=sheet.getRange(source.next+count-1,1,1,Math.min(width,5)).getDisplayValues()[0];
  if(DriveApp.getFileById(source.id).getLastUpdated().getTime()!==before)throw new Error('MODEL_SOURCE_CHANGED');
  const groups={},secret=PropertiesService.getScriptProperties().getProperty(HUB_MAP_HTTP_API.SECRET_PROPERTY);
  rows.forEach(function(r){
    const d=hubStaffHistoryDate_(r.deliveryDate),code=String(r.customerCode||'').trim();if(!d||d<s.startDate||d>s.endDate)return;
    if(!/^[A-Z]\d+$/.test(code))throw new Error('MODEL_CUSTOMER_CODE');
    const vehicle=String(r.confirmedVehicle||(source.kind==='period'?r.baseVehicle:'')||'').replace(/호(?:차)?$/,'');
    let row;
    if(source.kind==='history'){
      if(!r.deliveryId||!r.rawHash)throw new Error('MODEL_TASK_ID');
      row={deliveryDate:d,customerCode:code,deliveryId:r.deliveryId,vehicle:vehicle,driverName:r.driverName,driverPhone:r.driverPhone,kind:r.deliveryStatus==='COMPLETED'?'COMPLETED':'ASSIGNED',sourceVersion:r.rawHash,updatedAt:r.updatedAt};
    }else{
      const identity=r.driverName?[r.driverName,r.driverPhone||'UNVERIFIED_VEHICLE_'+vehicle].join('|'):'';
      row={deliveryDate:d,customerCode:code,vehicle:vehicle,driverName:r.driverName,driverKey:identity?Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(identity,secret)).replace(/=+$/,''):'',driverIdentity:r.driverPhone?'NAME_CONTACT':'UNVERIFIED'};
    }
    (groups[d]||(groups[d]=[])).push(row);
  });
  Object.keys(groups).forEach(function(d){
    const key=source.kind+':'+d,entry=s.shards[key],folder=DriveApp.getFolderById(s.folderId);
    let f=entry?DriveApp.getFileById(entry.id):null;
    // Deterministic filename recovers a write that succeeded before checkpoint ACK.
    if(!f){const matches=folder.getFilesByName(key+'.json');if(matches.hasNext())f=matches.next();}
    const old=f?JSON.parse(f.getBlob().getDataAsString()):[],byKey={};
    function keyOf(r){return source.kind==='history'?r.customerCode+'|'+r.deliveryId:JSON.stringify([r.customerCode,r.vehicle,r.driverKey]);}
    old.forEach(function(r){byKey[keyOf(r)]=r;});
    groups[d].forEach(function(r){const k=keyOf(r),prior=byKey[k];if(prior&&source.kind==='history'&&prior.sourceVersion!==r.sourceVersion){
      const same=['deliveryDate','customerCode','deliveryId','vehicle','driverName','driverPhone','kind'].every(function(k){return prior[k]===r[k];});
      if(!same){const a=hubStageModelUpdated_(prior.updatedAt),b=hubStageModelUpdated_(r.updatedAt);if(!a||!b||a===b)throw new Error('MODEL_TASK_CONFLICT');if(a>b)return;}
    }byKey[k]=r;});
    const data=Object.keys(byKey).sort().map(function(k){return byKey[k];});if(data.length>8000)throw new Error('MODEL_DATE_CAPACITY');
    const text=JSON.stringify(data),digest=hubStageModelHash_(data);if(f)f.setContent(text);else f=folder.createFile(key+'.json',text,MimeType.PLAIN_TEXT);
    if(hubStageModelHash_(JSON.parse(f.getBlob().getDataAsString()))!==digest)throw new Error('MODEL_WRITE_VERIFY');
    s.shards[key]={id:f.getId(),hash:digest,count:data.length};
  });
  source.next+=count;source.tail=hubStageModelHash_(tail);s.scanned+=count;
}
function hubStageReadModelContinue(){
  const lock=LockService.getUserLock();if(!lock.tryLock(1000))return;
  let s;
  try{
    ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()===HUB_STAGE_MODEL.continuation;}).forEach(function(t){ScriptApp.deleteTrigger(t);});
    s=hubStageModelLoad_();if(!s||s.phase==='ERROR'||s.phase==='DONE')return;
    const deadline=Date.now()+240000;hubStageModelSchedule_(); // Survives hard termination.
    while(Date.now()<deadline){
      if(s.phase==='BUILD'){
        if(s.source<s.sources.length){hubStageModelBuildBatch_(s);s.errors=0;hubStageModelSave_(s);
          if(!s.lastStatusAt||Date.now()-s.lastStatusAt>45000){try{hubStageModelSend_({type:'status',phase:'BUILD',scanned:s.scanned,total:s.sources.reduce(function(n,r){return n+(r.end||0);},0)});s.lastStatusAt=Date.now();}catch(ignored){}}
          continue;}
        s.phase='SEND';s.sendAt=0;hubStageModelSave_(s);
      }
      if(s.phase==='SEND'){
        const keys=Object.keys(s.shards).filter(function(k){return k.split(':')[1]>=s.startDate&&k.split(':')[1]<=s.endDate;}).sort();
        if(s.sendAt===0)hubStageModelSend_({type:'begin',generation:s.generation});
        if(s.sendAt<keys.length){const key=keys[s.sendAt],e=s.shards[key],rows=JSON.parse(DriveApp.getFileById(e.id).getBlob().getDataAsString());hubStageModelSend_({type:'shard',generation:s.generation,kind:key.split(':')[0],date:key.split(':')[1],rows:rows,hash:e.hash});s.sendAt++;hubStageModelSave_(s);continue;}
        hubStageModelSend_({type:'commit',generation:s.generation,startDate:s.startDate,endDate:s.endDate,manifest:keys.map(function(k){return{key:k,hash:s.shards[k].hash,count:s.shards[k].count};})});
        s.phase='DONE';s.errors=0;hubStageModelSave_(s);break;
      }
    }
  }catch(e){
    if(s){const code=/^MODEL_[A-Z_0-9]+$/.test(String(e.message))?e.message:'MODEL_OPERATION_FAILED';s.errors=s.lastError===code?(s.errors||0)+1:1;s.lastError=code;if(s.errors>=3||code==='MODEL_TASK_CONFLICT'||code==='MODEL_SOURCE_MOVED')s.phase='ERROR';hubStageModelSave_(s);}
    console.warn('Stage read model maintenance failed; inspect safe checkpoint status.');
  }finally{
    if(s&&(s.phase==='DONE'||s.phase==='ERROR'))ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()===HUB_STAGE_MODEL.continuation;}).forEach(function(t){ScriptApp.deleteTrigger(t);});
    else if(s)hubStageModelSchedule_(true);
    if(s&&s.phase==='ERROR')try{hubStageModelSend_({type:'status',phase:'ERROR',scanned:s.scanned,total:0});}catch(ignored){}
    lock.releaseLock();
  }
}
function hubStageReadModelWatchdog(){
  const lock=LockService.getUserLock();if(!lock.tryLock(1000))return;
  try{
    const s=hubStageModelLoad_();if(!s||s.phase==='ERROR')return;
    if(s.phase==='DONE'){
      // Incremental append cursors are durable. Structural source movement stops
      // safely, rather than silently skipping rows or resetting Customer state.
      const today=Utilities.formatDate(new Date(),'Asia/Seoul','yyyy-MM-dd');let changed=today!==s.endDate;
      s.sources.forEach(function(src){const sh=SpreadsheetApp.openById(src.id).getSheetByName(src.sheet);if(sh.getLastRow()<src.end)throw new Error('MODEL_SOURCE_MOVED');if(sh.getLastRow()>src.end)changed=true;src.end=sh.getLastRow();});
      if(!changed)return;s.endDate=today;s.startDate=new Date(Date.parse(today)-89*86400000).toISOString().slice(0,10);s.phase='BUILD';s.source=0;s.generation=Date.now();s.errors=0;hubStageModelSave_(s);
    }
    hubStageModelSchedule_(Date.now()-Date.parse(s.updatedAt||0)>300000);
  }catch(e){const s=hubStageModelLoad_();if(s){s.phase='ERROR';s.lastError='MODEL_SOURCE_MOVED';hubStageModelSave_(s);}}
  finally{lock.releaseLock();}
}
