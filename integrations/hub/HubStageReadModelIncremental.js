/** Five-date candidate helpers. Existing published shards remain immutable. */
const HUB_STAGE_INCREMENTAL=Object.freeze({start:'2026-06-22',end:'2026-09-19',dates:['2026-09-15','2026-09-16','2026-09-17','2026-09-18','2026-09-19']});
function hubStageIncrementalKey_(kind,r){return kind==='history'?r.customerCode+'|'+r.deliveryId:JSON.stringify([r.customerCode,r.vehicle,r.driverKey]);}
function hubStageIncrementalRow_(kind,r){
  const d=hubStaffHistoryDate_(r.deliveryDate),code=String(r.customerCode||'').trim();
  if(!d)throw new Error('DATE_INVALID');if(!/^[A-Z]\d+$/.test(code))throw new Error('KEY_MISSING');
  const vehicle=String(r.confirmedVehicle||(kind==='period'?r.baseVehicle:'')||'').replace(/호(?:차)?$/,'');let row;
  if(kind==='history'){
    if(!r.deliveryId||!r.rawHash)throw new Error('KEY_MISSING');
    row={deliveryDate:d,customerCode:code,deliveryId:String(r.deliveryId),vehicle:vehicle,driverName:String(r.driverName||''),driverPhone:String(r.driverPhone||''),
      kind:r.deliveryStatus==='COMPLETED'?'COMPLETED':'ASSIGNED',sourceVersion:String(r.rawHash),updatedAt:String(r.updatedAt||'')};
  }else{
    const identity=r.driverName?[r.driverName,r.driverPhone||'UNVERIFIED_VEHICLE_'+vehicle].join('|'):'',secret=PropertiesService.getScriptProperties().getProperty(HUB_MAP_HTTP_API.SECRET_PROPERTY);
    // Driver identity is an EXISTING compatibility contract, not transport HMAC.
    const driverKey=identity?Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(identity,secret,Utilities.Charset.US_ASCII)).replace(/=+$/,''):'';
    row={deliveryDate:d,customerCode:code,vehicle:vehicle,driverName:String(r.driverName||''),driverKey:driverKey,driverIdentity:r.driverPhone?'NAME_CONTACT':'UNVERIFIED'};
  }
  if(Object.keys(row).some(function(k){return typeof row[k]!=='string'||row[k].length>300;}))throw new Error('MALFORMED');
  return row;
}
function hubStageIncrementalMerge_(kind,date,sources){
  if(HUB_STAGE_INCREMENTAL.dates.indexOf(date)<0||['history','period'].indexOf(kind)<0)throw new Error('MODEL_INCREMENTAL_RANGE');
  const byKey={},stats={sourceRows:0,currentRows:0,archiveRows:0,generatedRows:0,dedupe:0,malformed:0,keyMissing:0,conflicts:0};
  sources.forEach(function(source){
    if(['Current','Archive'].indexOf(source.name)<0)throw new Error('MODEL_INCREMENTAL_SOURCE');
    source.rows.forEach(function(raw){stats.sourceRows++;stats[source.name==='Current'?'currentRows':'archiveRows']++;
      let row;try{row=hubStageIncrementalRow_(kind,raw);if(row.deliveryDate!==date)throw new Error('DATE_INVALID');}
      catch(e){stats[e.message==='KEY_MISSING'?'keyMissing':'malformed']++;return;}
      const k=hubStageIncrementalKey_(kind,row),prior=byKey[k];
      if(prior){stats.dedupe++;
        if(kind==='history'&&prior.sourceVersion!==row.sourceVersion){
          const same=['deliveryDate','customerCode','deliveryId','vehicle','driverName','driverPhone','kind'].every(function(field){return prior[field]===row[field];});
          if(!same){const a=hubStageModelUpdated_(prior.updatedAt),b=hubStageModelUpdated_(row.updatedAt);if(!a||!b||a===b){stats.conflicts++;return;}if(a>b)return;}
        }
      }
      byKey[k]=row;
    });
  });
  const rows=Object.keys(byKey).sort().map(function(k){return byKey[k];});stats.generatedRows=rows.length;
  return{rows:rows,stats:stats,hash:hubStageModelHash_(rows),pass:!stats.malformed&&!stats.keyMissing&&!stats.conflicts&&rows.length>0&&rows.length<=8000};
}
function hubStageIncrementalManifest_(published,additions){
  hubStageRestoreManifest_(published);const shards={},excluded=[];
  Object.keys(published.shards).sort().forEach(function(k){const d=k.split(':')[1];if(d>=HUB_STAGE_INCREMENTAL.start&&d<'2026-09-15')shards[k]=JSON.parse(JSON.stringify(published.shards[k]));else excluded.push(k);});
  HUB_STAGE_INCREMENTAL.dates.forEach(function(date){['history','period'].forEach(function(kind){const k=kind+':'+date,e=additions[k];if(!e||shards[k])throw new Error('MODEL_INCREMENTAL_INCOMPLETE');shards[k]=JSON.parse(JSON.stringify(e));});});
  if(Object.keys(additions).length!==10)throw new Error('MODEL_INCREMENTAL_INCOMPLETE');
  const model={phase:'DONE',generation:published.generation+1,startDate:HUB_STAGE_INCREMENTAL.start,endDate:HUB_STAGE_INCREMENTAL.end,sendAt:Object.keys(shards).length,shards:shards};
  const manifest=hubStageRestoreManifest_(model);
  ['history','period'].forEach(function(kind){const dates=manifest.keys.filter(function(k){return k.indexOf(kind+':')===0;}).map(function(k){return k.split(':')[1];});
    if(dates[0]!==HUB_STAGE_INCREMENTAL.start||dates[dates.length-1]!==HUB_STAGE_INCREMENTAL.end)throw new Error('MODEL_INCREMENTAL_BOUNDARY');
  });
  return{shards:shards,totals:manifest.totals,reused:manifest.keys.length-10,added:10,excluded:excluded};
}
function hubStageIncrementalDatePattern_(date){
  if(HUB_STAGE_INCREMENTAL.dates.indexOf(date)<0)throw new Error('MODEL_INCREMENTAL_RANGE');
  const day=date.slice(-2);return'^(2026[-./]\\s*0?9[-./]\\s*'+day+'(?:\\.|\\s.*|T.*)?|0?9/'+day+'/2026(?:\\s.*)?)$';
}
function hubStageIncrementalReadDate_(id,kind,date,deadline){
  const sheet=SpreadsheetApp.openById(id).getSheetByName(kind==='history'?'delivery_admin_raw':'daily_routes');
  if(!sheet)throw new Error('MODEL_INCREMENTAL_SOURCE_MISSING');
  const last=sheet.getLastRow(),width=sheet.getLastColumn();if(width<1||width>64)throw new Error('MODEL_INCREMENTAL_HEADER');
  const headers=sheet.getRange(1,1,1,width).getValues()[0].map(String),dateCol=headers.indexOf('deliveryDate');
  const wanted=kind==='history'?['deliveryDate','customerCode','deliveryId','confirmedVehicle','driverName','driverPhone','deliveryStatus','rawHash','updatedAt']:['deliveryDate','customerCode','confirmedVehicle','baseVehicle','driverName','driverPhone'];
  if(dateCol<0||wanted.some(function(k){return headers.indexOf(k)<0;}))throw new Error('MODEL_INCREMENTAL_HEADER');
  if(last<2)return[];
  // Search only the date column server-side. Physical row numbers are temporary
  // locators for this read, NEVER a durable append cursor or logical identity.
  function locate(){return sheet.getRange(2,dateCol+1,last-1,1).createTextFinder(hubStageIncrementalDatePattern_(date)).useRegularExpression(true).matchEntireCell(true).findAll().map(function(c){return c.getRow();}).sort(function(a,b){return a-b;});}
  const positions=locate(),rows=[];if(positions.length>16000)throw new Error('MODEL_INCREMENTAL_DATE_CAPACITY');
  for(let at=0;at<positions.length;){
    if(Date.now()>deadline)throw new Error('MODEL_INCREMENTAL_TIME_LIMIT');
    const start=positions[at];let count=1;while(at+count<positions.length&&count<1000&&positions[at+count]===start+count)count++;
    const batch=hubStageModelReadColumns_({id:id},sheet,headers,start,count,wanted);
    if(batch.some(function(r){return hubStaffHistoryDate_(r.deliveryDate)!==date;}))throw new Error('MODEL_INCREMENTAL_LOCATION_CHANGED');
    Array.prototype.push.apply(rows,batch);at+=count;
  }
  if(sheet.getLastRow()!==last||JSON.stringify(locate())!==JSON.stringify(positions))throw new Error('MODEL_INCREMENTAL_LOCATION_CHANGED');
  return rows;
}
function hubStageIncrementalReadPair_(kind,date,deadline){
  const sources=[{name:'Archive',id:HUB_STAFF_DETAIL_ARCHIVE},{name:'Current',id:HUB_DEFAULT_SOURCE_ID}];
  return hubStageIncrementalMerge_(kind,date,sources.map(function(s){return{name:s.name,rows:hubStageIncrementalReadDate_(s.id,kind,date,deadline)};}));
}
function hubStageIncrementalStableDate_(date,deadline){
  const first={history:hubStageIncrementalReadPair_('history',date,deadline),period:hubStageIncrementalReadPair_('period',date,deadline)};
  const second={history:hubStageIncrementalReadPair_('history',date,deadline),period:hubStageIncrementalReadPair_('period',date,deadline)};
  ['history','period'].forEach(function(k){
    if(!first[k].pass||!second[k].pass)throw new Error('MODEL_INCREMENTAL_DATA_INVALID');
    if(first[k].hash!==second[k].hash||JSON.stringify(first[k].stats)!==JSON.stringify(second[k].stats))throw new Error('MODEL_INCREMENTAL_SOURCE_CHANGED');
  });return second;
}
function hubStageIncrementalCompletionEvidence_(rows,date,result){
  const freshon=[],delivery=[],priorByRun={};
  rows.forEach(function(r){
    if(r[1]==='DATE_FETCHED'&&r[2]==='OK'){
      const match=String(r[3]||'').match(/^(\d{4}-\d{2}-\d{2}) \/ (?:Render )?HTTP 200 \/ rows=(\d+)$/);
      if(match&&match[1]===date)freshon.push(Number(match[2]));
    }
    if(r[3]!=='delivery_admin'||r[4]!=='collect_day_done'||r[8]!=='DONE')return;
    const run=String(r[0]||''),total={fetched:Number(r[10])||0,inserted:Number(r[11])||0,updated:Number(r[12])||0,skipped:Number(r[13])||0,error:Number(r[14])||0},prev=priorByRun[run]||{fetched:0,inserted:0,updated:0,skipped:0,error:0};
    priorByRun[run]=total;
    if(hubStaffHistoryDate_(r[6])!==date||hubStaffHistoryDate_(r[7])!==date)return;
    const delta={};Object.keys(total).forEach(function(k){delta[k]=total[k]-prev[k];});
    if(Object.keys(delta).some(function(k){return delta[k]<0;}))return;
    delivery.push(delta);
  });
  const freshonPass=freshon.some(function(n){return n===result.period.stats.sourceRows;}),deliveryPass=delivery.some(function(d){return d.error===0&&d.fetched>0&&d.inserted+d.updated===result.history.stats.generatedRows&&d.fetched===d.inserted+d.updated+d.skipped;});
  return{freshon: freshonPass?'COLLECTOR_HTTP200_STORED_COUNT_MATCH':'UNCONFIRMED',delivery:deliveryPass?'COLLECTOR_DONE_STORED_COUNT_MATCH':'UNCONFIRMED',freshonPass:freshonPass,deliveryPass:deliveryPass,pass:freshonPass&&deliveryPass};
}
function hubStageIncrementalReadCompletion_(date,result){
  const sh=SpreadsheetApp.openById(HUB_DEFAULT_SOURCE_ID).getSheetByName('sync_log');if(!sh)throw new Error('MODEL_INCREMENTAL_COMPLETION_LOG');
  const rows=[],last=sh.getLastRow();for(let start=2;start<=last;start+=1000){const batch=sh.getRange(start,1,Math.min(1000,last-start+1),15).getValues();Array.prototype.push.apply(rows,batch);}
  return hubStageIncrementalCompletionEvidence_(rows,date,result);
}
function hubStageIncrementalCoordinateCounts_(result){
  const sh=SpreadsheetApp.openById(HUB_DEFAULT_SOURCE_ID).getSheetByName('map_coordinate_cache_v2');
  if(!sh)return{status:'UNCONFIRMED'};
  const headers=sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(String),cols=['customerCode','lat','lng'].map(function(k){return headers.indexOf(k);});
  if(cols.some(function(c){return c<0;}))throw new Error('MODEL_INCREMENTAL_COORDINATE_HEADER');
  const valid={};for(let start=2;start<=sh.getLastRow();start+=1000){
    const count=Math.min(1000,sh.getLastRow()-start+1),values=cols.map(function(c){return sh.getRange(start,c+1,count,1).getValues();});
    for(let n=0;n<count;n++){const lat=Number(values[1][n][0]),lng=Number(values[2][n][0]);if(lat>=33&&lat<=39.5&&lng>=124&&lng<=132)valid[String(values[0][n][0]).trim()]=true;}
  }
  const out={status:'CACHE_CHECKED'};['history','period'].forEach(function(kind){const codes={};result[kind].rows.forEach(function(r){codes[r.customerCode]=true;});out[kind]={uniqueCustomers:Object.keys(codes).length,missingCustomers:Object.keys(codes).filter(function(c){return !valid[c];}).length,missingRows:result[kind].rows.filter(function(r){return !valid[r.customerCode];}).length};});return out;
}
// One date per editor execution; only non-sensitive audit metadata is persisted.
// No candidate generation, shard write, source write, trigger or Stage request.
function hubStageReadModelIncrementalAuditNext(){
  const lock=LockService.getUserLock();if(!lock.tryLock(1000))throw new Error('MODEL_INCREMENTAL_BUSY');
  try{
    const original=hubStageModelLoad_(),restored=hubStageRestoreLoad_(),m=hubStageRestoreManifest_(original);
    if(original.generation!==1789401132459||!restored||restored.phase!=='DONE'||restored.generation!==original.generation||restored.fingerprint!==m.fingerprint||restored.commitHttp!==200)throw new Error('MODEL_INCREMENTAL_RESTORE_REQUIRED');
    const p=PropertiesService.getScriptProperties(),key='PHASE2B_INCREMENTAL_AUDIT_20260919',previous=p.getProperty(key)||'',audit=previous?JSON.parse(previous):{generation:original.generation,fingerprint:m.fingerprint,dates:{}};
    if(audit.generation!==original.generation||audit.fingerprint!==m.fingerprint)throw new Error('MODEL_INCREMENTAL_BASE_CHANGED');
    const date=HUB_STAGE_INCREMENTAL.dates.find(function(d){return !audit.dates[d];});if(!date){console.log(JSON.stringify({phase:'DRY_RUN_COMPLETE',dates:audit.dates}));return;}
    const result=hubStageIncrementalStableDate_(date,Date.now()+270000);
    const completion=hubStageIncrementalReadCompletion_(date,result);
    const coordinates=hubStageIncrementalCoordinateCounts_(result);
    audit.dates[date]={history:{stats:result.history.stats,hash:result.history.hash},period:{stats:result.period.stats,hash:result.period.hash},sourceCoverage:'STORED_ROWS_RECONCILED',collectionCompleteness:completion,coordinates:coordinates};
    if((p.getProperty(key)||'')!==previous||hubStageRestoreManifest_(hubStageModelLoad_()).fingerprint!==m.fingerprint)throw new Error('MODEL_INCREMENTAL_BASE_CHANGED');
    p.setProperty(key,JSON.stringify(audit));
    console.log(JSON.stringify({phase:completion.pass?'DRY_RUN_DATE_PASS':'DRY_RUN_COMPLETENESS_UNCONFIRMED',date:date,history:result.history.stats,period:result.period.stats,completion:completion,coordinates:coordinates,stableReads:2,candidateCreated:false}));
  }finally{lock.releaseLock();}
}
