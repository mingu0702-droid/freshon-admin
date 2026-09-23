/** Production-only stored-data candidate. No collector or source-sheet writes. */
const HUB_MAP_INCREMENTAL=Object.freeze({property:'PHASE2B_PRODUCTION_INCREMENTAL_V1',handler:'hubMapIncrementalContinue',maxDates:7});
function hubMapIncrementalLoad_(){const id=PropertiesService.getScriptProperties().getProperty(HUB_MAP_INCREMENTAL.property);return id?JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8')):null;}
function hubMapIncrementalSummary_(c){return c?{phase:c.phase,publication:c.publication||null,generation:c.generation,baseGeneration:c.baseGeneration,startDate:c.startDate,endDate:c.endDate,buildAt:c.buildAt,verifyAt:c.verifyAt,sendAt:c.sendAt,shards:Object.keys(c.shards).length,totals:c.totals||null,days:c.days,lastError:c.lastError||'',firstHttp:c.firstHttp||null,commitHttp:c.commitHttp||null,updatedAt:c.updatedAt}:null;}
function hubMapReadOnlyStatus(){const r=hubMapIncrementalStatus_({});console.log(JSON.stringify(r.data));return r;}
function hubMapRequestProductionIncrement(){const r=hubMapIncrementalRequest_({target:'production'});console.log(JSON.stringify(r.data));return r;}
function hubMapIncrementalStatus_(params){
  hubMapHttpValidateOnlyKeys_(params,[]);const p=hubStageModelLoad_(),c=hubMapIncrementalLoad_();
  return {data:{customer:hubMapCollectionStatus_(),published:p?{generation:p.generation,startDate:p.startDate,endDate:p.endDate,status:p.phase}:null,
    job:hubMapIncrementalSummary_(c),coverage:hubMapIncrementalCoverage_(p),automatic:'NOT_CONFIGURED',continuation:ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()===HUB_MAP_INCREMENTAL.handler;})?'ACTIVE':'NONE'},cached:false};
}
function hubMapIncrementalCoverage_(p){
  const result={generation:p&&p.generation,history:[],period:[],proof:'NO_GENERATION_MATCHED_COMPLETION_EVIDENCE'};
  if(!p||p.operation!=='MAP_INCREMENTAL'||p.commitHttp!==200||p.verifiedFingerprint!==hubStageRestoreManifest_(p).fingerprint)return result;
  ['history','period'].forEach(function(kind){Object.keys(p.days||{}).forEach(function(date){const d=p.days[date][kind],shard=p.shards[kind+':'+date];
    if(d&&shard&&d.collectionCompleteness==='VERIFIED'&&d.hash===shard.hash&&d.stats.generatedRows===shard.count)result[kind].push(date);
  });});
  result.proof='GENERATION_SHARD_HASH_AND_COLLECTION_LOG_MATCH';return result;
}
function hubMapIncrementalPlan_(base,target){
  const m=hubStageRestoreManifest_(base);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(target)||new Date(target).toISOString().slice(0,10)!==target)throw new Error('MODEL_INCREMENTAL_DATE');
  const count=(Date.parse(target)-Date.parse(base.endDate))/86400000;
  if(count<1||count>HUB_MAP_INCREMENTAL.maxDates)throw new Error('MODEL_INCREMENTAL_BOUNDED_RANGE');
  const start=new Date(Date.parse(target)-89*86400000).toISOString().slice(0,10),dates=[],shards={};
  for(let i=1;i<=count;i++)dates.push(new Date(Date.parse(base.endDate)+i*86400000).toISOString().slice(0,10));
  m.keys.forEach(function(key){if(key.split(':')[1]>=start)shards[key]=JSON.parse(JSON.stringify(base.shards[key]));});
  return {startDate:start,endDate:target,dates:dates,shards:shards,baseFingerprint:m.fingerprint};
}
function hubMapIncrementalLive_(){
  const url=hubReadModelTarget_('production').endpoint.replace('/internal/stage-read-model','/api/map-phase2b/preview/period-status');
  const r=UrlFetchApp.fetch(url,{muteHttpExceptions:true,followRedirects:false});
  if(r.getResponseCode()!==200)throw new Error('MODEL_INCREMENTAL_STATUS_HTTP');
  try{return JSON.parse(r.getContentText());}catch(e){throw new Error('MODEL_INCREMENTAL_STATUS_JSON');}
}
function hubMapIncrementalBase_(c){
  const base=hubStageModelLoad_();
  if(!base||base.stateId!==c.baseStateId||base.generation!==c.baseGeneration||hubStageRestoreManifest_(base).fingerprint!==c.baseFingerprint)throw new Error('MODEL_INCREMENTAL_BASE_CHANGED');
  return base;
}
function hubMapIncrementalSchedule_(active){
  ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()===HUB_MAP_INCREMENTAL.handler;}).forEach(function(t){ScriptApp.deleteTrigger(t);});
  if(active)ScriptApp.newTrigger(HUB_MAP_INCREMENTAL.handler).timeBased().after(60000).create();
}
function hubMapIncrementalRequest_(params){
  hubMapHttpValidateOnlyKeys_(params,['target']);if(params.target!=='production')throw new Error('MODEL_TARGET_INVALID');
  const lock=LockService.getUserLock();if(!lock.tryLock(1000))return {data:{phase:'BUSY'},cached:false};
  try{
    const c=hubMapIncrementalLoad_();
    if(c&&c.phase==='DONE'&&c.publication==='PENDING'){hubMapIncrementalSchedule_(true);return {data:hubMapIncrementalSummary_(c),cached:false};}
    if(c&&(c.phase!=='DONE'||c.publication==='ERROR'))return {data:hubMapIncrementalSummary_(c),cached:false}; // No implicit error reset.
    const source=hubMapCollectionStatus_(),base=hubStageModelLoad_();hubStageRestoreManifest_(base);
    if(!source.freshon||!source.delivery)throw new Error('MODEL_INCREMENTAL_COMPLETION_UNCONFIRMED');
    const target=source.freshon<source.delivery?source.freshon:source.delivery;
    if(target<=base.endDate)return {data:{phase:'UP_TO_DATE',generation:base.generation,endDate:base.endDate},cached:false};
    const live=hubMapIncrementalLive_(),restore=hubStageRestoreLoad_('production');
    if(!live.ready||live.generation!==base.generation||restore&&restore.phase==='RESTORE')throw new Error('MODEL_INCREMENTAL_RESTORE_BUSY');
    const plan=hubMapIncrementalPlan_(base,target),folder=DriveApp.createFolder('Production_Map_Incremental_'+target);
    if(folder.getSharingAccess()!==DriveApp.Access.PRIVATE)throw new Error('MODEL_STORAGE_NOT_PRIVATE');
    const file=folder.createFile('incremental-checkpoint.json','{}',MimeType.PLAIN_TEXT);
    const next={operation:'MAP_INCREMENTAL',publishTarget:'production',phase:'BUILD',generation:Math.max(Date.now(),base.generation+1),baseGeneration:base.generation,baseStateId:base.stateId,
      stateId:file.getId(),folderId:folder.getId(),...plan,buildAt:0,verifyAt:0,sendAt:0,days:{},errors:0,lastError:''};
    hubMapIncrementalBase_(next);hubStageModelSave_(next);PropertiesService.getScriptProperties().setProperty(HUB_MAP_INCREMENTAL.property,next.stateId);
    hubMapIncrementalSchedule_(true);return {data:hubMapIncrementalSummary_(next),cached:false};
  }finally{lock.releaseLock();}
}
function hubMapIncrementalReadDate_(id,kind,date,deadline){
  const sh=SpreadsheetApp.openById(id).getSheetByName(kind==='history'?'delivery_admin_raw':'daily_routes');if(!sh)throw new Error('MODEL_INCREMENTAL_SOURCE_MISSING');
  const last=sh.getLastRow(),width=sh.getLastColumn();if(width<1||width>64)throw new Error('MODEL_INCREMENTAL_HEADER');
  const headers=sh.getRange(1,1,1,width).getValues()[0].map(String),col=headers.indexOf('deliveryDate');
  if(col<0)throw new Error('MODEL_INCREMENTAL_HEADER');if(last<2)return [];
  const parts=date.split('-').map(Number),pattern='^('+parts[0]+'[-./]\\s*0?'+parts[1]+'[-./]\\s*0?'+parts[2]+'(?:\\.|\\s.*|T.*)?|0?'+parts[1]+'/0?'+parts[2]+'/'+parts[0]+'(?:\\s.*)?)$';
  function locate(){return sh.getRange(2,col+1,last-1,1).createTextFinder(pattern).useRegularExpression(true).matchEntireCell(true).findAll().map(function(r){return r.getRow();}).sort(function(a,b){return a-b;});}
  const positions=locate(),rows=[],wanted=kind==='history'?['deliveryDate','customerCode','deliveryId','confirmedVehicle','driverName','driverPhone','deliveryStatus','rawHash','updatedAt']:['deliveryDate','customerCode','confirmedVehicle','baseVehicle','driverName','driverPhone'];
  if(positions.length>16000)throw new Error('MODEL_INCREMENTAL_DATE_CAPACITY');
  for(let at=0;at<positions.length;){
    if(Date.now()>deadline)throw new Error('MODEL_INCREMENTAL_TIME_LIMIT');
    let count=1;while(at+count<positions.length&&count<1000&&positions[at+count]===positions[at]+count)count++;
    const batch=hubStageModelReadColumns_({id:id},sh,headers,positions[at],count,wanted);
    if(batch.some(function(r){return hubStaffHistoryDate_(r.deliveryDate)!==date;}))throw new Error('MODEL_INCREMENTAL_LOCATION_CHANGED');
    Array.prototype.push.apply(rows,batch);at+=count;
  }
  if(sh.getLastRow()!==last||sh.getLastColumn()!==width||JSON.stringify(locate())!==JSON.stringify(positions))throw new Error('MODEL_INCREMENTAL_LOCATION_CHANGED');
  return rows;
}
function hubMapIncrementalMerge_(kind,date,sources){
  const byKey={},stats={sourceRows:0,currentRows:0,archiveRows:0,generatedRows:0,dedupe:0,malformed:0,keyMissing:0,conflicts:0};
  sources.forEach(function(source){source.rows.forEach(function(raw){
    stats.sourceRows++;stats[source.name==='Current'?'currentRows':'archiveRows']++;
    const row=hubStageIncrementalRow_(kind,raw);if(row.deliveryDate!==date)throw new Error('MODEL_INCREMENTAL_DATE');
    const key=hubStageIncrementalKey_(kind,row),old=byKey[key];
    if(old){stats.dedupe++;if(JSON.stringify(old)!==JSON.stringify(row))throw new Error('MODEL_INCREMENTAL_KEY_CONFLICT');}
    byKey[key]=row;
  });});
  const rows=Object.keys(byKey).sort().map(function(k){return byKey[k];});stats.generatedRows=rows.length;
  if(rows.length>8000)throw new Error('MODEL_INCREMENTAL_DATE_CAPACITY');
  return {rows:rows,stats:stats,hash:hubStageModelHash_(rows)};
}
function hubMapIncrementalStable_(kind,date,deadline){
  function read(){return hubMapIncrementalMerge_(kind,date,[{name:'Archive',rows:hubMapIncrementalReadDate_(HUB_STAFF_DETAIL_ARCHIVE,kind,date,deadline)},{name:'Current',rows:hubMapIncrementalReadDate_(HUB_DEFAULT_SOURCE_ID,kind,date,deadline)}]);}
  const a=read(),b=read();if(a.hash!==b.hash||JSON.stringify(a.stats)!==JSON.stringify(b.stats))throw new Error('MODEL_INCREMENTAL_SOURCE_CHANGED');return b;
}
function hubMapIncrementalShard_(key,e){
  const rows=JSON.parse(DriveApp.getFileById(e.id).getBlob().getDataAsString('UTF-8')),parts=key.split(':'),seen={};
  if(!Array.isArray(rows)||rows.length!==e.count||hubStageModelHash_(rows)!==e.hash)throw new Error('MODEL_INCREMENTAL_HASH_COUNT');
  rows.forEach(function(row){const id=hubStageIncrementalKey_(parts[0],row);if(row.deliveryDate!==parts[1]||seen[id])throw new Error('MODEL_INCREMENTAL_SHARD_ROWS');seen[id]=true;});return rows;
}
function hubMapIncrementalManifest_(c){return hubStageRestoreManifest_({...c,phase:'DONE',sendAt:Object.keys(c.shards).length});}
function hubMapIncrementalBuild_(c,deadline){
  const date=c.dates[Math.floor(c.buildAt/2)],kind=c.buildAt%2?'period':'history',key=kind+':'+date,result=hubMapIncrementalStable_(kind,date,deadline);
  if(result.rows.length){
    const folder=DriveApp.getFolderById(c.folderId),files=folder.getFilesByName(key+'.json');let file;
    if(files.hasNext()){file=files.next();if(files.hasNext())throw new Error('MODEL_INCREMENTAL_DUPLICATE_FILE');}else file=folder.createFile(key+'.json',JSON.stringify(result.rows),MimeType.PLAIN_TEXT);
    const e={id:file.getId(),count:result.rows.length,hash:result.hash};hubMapIncrementalShard_(key,e);c.shards[key]=e;
  }
  (c.days[date]||(c.days[date]={}))[kind]={stats:result.stats,hash:result.hash,collectionCompleteness:'UNCONFIRMED'};c.buildAt++;
  if(c.buildAt===c.dates.length*2){
    const end=c.days[c.endDate];if(!end.history.stats.generatedRows||!end.period.stats.generatedRows)throw new Error('MODEL_INCREMENTAL_TARGET_NOT_STORED');
    const m=hubMapIncrementalManifest_(c);c.totals=m.totals;c.phase='VERIFY';
  }
  hubStageModelSave_(c);
}
function hubMapIncrementalVerifyCompletion_(c){
  c.dates.forEach(function(date){
    const result=c.days[date],proof=hubStageIncrementalReadCompletion_(date,result);
    result.history.collectionCompleteness=proof.deliveryPass?'VERIFIED':'UNCONFIRMED';
    result.period.collectionCompleteness=proof.freshonPass?'VERIFIED':'UNCONFIRMED';
    // An empty intervening day remains explicitly unconfirmed, never "no business".
    if(date===c.endDate&&!proof.pass)throw new Error('MODEL_INCREMENTAL_COMPLETION_UNCONFIRMED');
  });
}
function hubMapIncrementalPublish_(c){
  if(c.phase!=='DONE'||c.commitHttp!==200||c.verifiedFingerprint!==hubMapIncrementalManifest_(c).fingerprint)throw new Error('MODEL_INCREMENTAL_NOT_VERIFIED');
  const props=PropertiesService.getScriptProperties(),current=props.getProperty(HUB_STAGE_MODEL.property);
  if(current!==c.stateId){hubMapIncrementalBase_(c);props.setProperty(HUB_STAGE_MODEL.property,c.stateId);}
  if(props.getProperty(HUB_STAGE_MODEL.property)!==c.stateId)throw new Error('MODEL_INCREMENTAL_POINTER_READBACK');
  c.publication='PUBLISHED';hubStageModelSave_(c);
}
function hubMapIncrementalCommit_(c,m){
  if(c.sendAt!==m.keys.length||c.verifyAt!==m.keys.length||c.verifiedFingerprint!==m.fingerprint)throw new Error('MODEL_INCREMENTAL_NOT_VERIFIED');
  hubMapIncrementalBase_(c);const live=hubMapIncrementalLive_();
  if(live.generation!==c.generation){
    if(!live.ready||live.generation!==c.baseGeneration)throw new Error('MODEL_INCREMENTAL_LIVE_CHANGED');
    c.commitHttp=hubStageModelSend_({type:'commit',generation:c.generation,startDate:c.startDate,endDate:c.endDate,manifest:m.keys.map(function(k){return{key:k,count:c.shards[k].count,hash:c.shards[k].hash};})},'production');
  }
  const after=hubMapIncrementalLive_();
  if(!after.ready||after.generation!==c.generation||after.historyRows!==m.totals.historyRows||after.periodRows!==m.totals.periodRows||after.startDate!==c.startDate||after.endDate!==c.endDate)throw new Error('MODEL_INCREMENTAL_READBACK');
  hubMapIncrementalBase_(c);c.commitHttp=200;c.phase='DONE';c.publication='PENDING';c.lastError='';hubStageModelSave_(c);
  hubMapIncrementalPublish_(c);
}
function hubMapIncrementalContinue(){
  const lock=LockService.getUserLock();if(!lock.tryLock(1000)){const waiting=hubMapIncrementalLoad_();if(waiting&&(waiting.publication==='PENDING'||['DONE','ERROR'].indexOf(waiting.phase)<0))hubMapIncrementalSchedule_(true);return;}
  let c;
  try{
    hubMapIncrementalSchedule_(false);c=hubMapIncrementalLoad_();if(!c||c.phase==='ERROR')return;
    if(c.phase==='DONE'){if(c.publication==='PENDING')hubMapIncrementalPublish_(c);return;}
    hubMapIncrementalBase_(c);hubMapIncrementalSchedule_(true);const deadline=Date.now()+225000;
    if(c.phase==='BUILD'){hubMapIncrementalBuild_(c,deadline);return;}
    const m=hubMapIncrementalManifest_(c);
    if(c.phase==='VERIFY'){
      while(c.verifyAt<m.keys.length&&Date.now()<deadline){const key=m.keys[c.verifyAt];hubMapIncrementalShard_(key,c.shards[key]);c.verifyAt++;hubStageModelSave_(c);}
      if(c.verifyAt===m.keys.length){hubMapIncrementalVerifyCompletion_(c);c.verifiedFingerprint=m.fingerprint;c.phase='SEND';hubStageModelSave_(c);}return;
    }
    if(c.phase!=='SEND'||c.verifiedFingerprint!==m.fingerprint)throw new Error('MODEL_INCREMENTAL_PHASE');
    const live=hubMapIncrementalLive_();if(live.ready&&live.generation===c.generation){hubMapIncrementalCommit_(c,m);return;}
    if(!live.ready||live.generation!==c.baseGeneration)throw new Error('MODEL_INCREMENTAL_LIVE_CHANGED');
    if(!c.begun){c.firstHttp=hubStageModelSend_({type:'begin',generation:c.generation},'production');c.begun=true;hubStageModelSave_(c);}
    while(c.sendAt<m.keys.length&&Date.now()<deadline){const key=m.keys[c.sendAt],e=c.shards[key],rows=hubMapIncrementalShard_(key,e);hubStageModelSend_({type:'shard',generation:c.generation,kind:key.split(':')[0],date:key.split(':')[1],hash:e.hash,rows:rows},'production');c.sendAt++;hubStageModelSave_(c);}
    if(c.sendAt===m.keys.length)hubMapIncrementalCommit_(c,m);
  }catch(e){if(c){c.errors=(c.errors||0)+1;c.lastError=/^MODEL_[A-Z0-9_]+$/.test(String(e.message))?e.message:'MODEL_INCREMENTAL_FAILED';
    if(c.phase==='DONE'){c.publication=c.errors>=3?'ERROR':'PENDING';}
    else if(e.modelAuthFatal||/HTTP_(401|403)$/.test(c.lastError)){c.authHaltGeneration=c.generation;c.phase='ERROR';}
    else if(!/^MODEL_STAGE_HTTP_5\d\d$/.test(c.lastError)||c.errors>=3)c.phase='ERROR';hubStageModelSave_(c);}}
  finally{hubMapIncrementalSchedule_(!!c&&(c.publication==='PENDING'||c.phase!=='DONE'&&c.phase!=='ERROR'));if(c)console.log(JSON.stringify(hubMapIncrementalSummary_(c)));lock.releaseLock();}
}
