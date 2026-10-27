/**
 * Private Customer projection. Reads existing saved sheets only. No source writes,
 * no collection calls, no public files, no full-sheet scan on a customer click.
 * Uses the existing Hub auto tick; installs no trigger and does not publish map data.
 */
const HUB_CUSTOMER_DETAILS=Object.freeze({pointer:'OPSMAP_CUSTOMER_DETAILS_V1',job:'OPSMAP_CUSTOMER_DETAILS_JOB_V1',summary:'OPSMAP_CUSTOMER_DETAILS_STATUS_V1',folder:'OPSMAP_CUSTOMER_DETAILS_FOLDER_ID',maxStateBytes:16777216,maxBucketBytes:1048576,batchRows:500,maxRunRows:8000});
function hubCustomerDetailFail_(code){throw Object.assign(new Error(code),{code:code});}
function hubCustomerDetailSafeError_(e){return /^CUSTOMER_DETAILS_[A-Z_]+$/.test(String(e&&e.message))?e.message:'CUSTOMER_DETAILS_FAILED';}
function hubCustomerDetailNow_(){return new Date().toISOString();}
function hubCustomerDetailHash_(text){return hubMapPackageHashText_(text);}
function hubCustomerDetailRead_(entry,max){return hubMapPackageReadFile_(entry,max||HUB_CUSTOMER_DETAILS.maxStateBytes);}
function hubCustomerDetailPointer_(){
 const raw=PropertiesService.getScriptProperties().getProperty(HUB_CUSTOMER_DETAILS.pointer);
 if(!raw)return {raw:null,value:null};let value;try{value=JSON.parse(raw);}catch(e){hubCustomerDetailFail_('CUSTOMER_DETAILS_POINTER_INVALID');}
 if(value.schema!==1||!value.current||!Number.isSafeInteger(value.current.version)||value.current.version<1)hubCustomerDetailFail_('CUSTOMER_DETAILS_POINTER_INVALID');
 return {raw:raw,value:value};
}
function hubCustomerDetailMarkers_(ids){
 return ids.map(function(id){const f=DriveApp.getFileById(id);return {id:id,modifiedAt:f.getLastUpdated().getTime()};});
}
function hubCustomerDetailSourceUnchanged_(markers){try{return JSON.stringify(hubCustomerDetailMarkers_(markers.map(function(m){return m.id;})))===JSON.stringify(markers);}catch(e){return false;}}
function hubCustomerDetailFolder_(){
 const id=PropertiesService.getScriptProperties().getProperty(HUB_CUSTOMER_DETAILS.folder);let folder;
 if(id)folder=DriveApp.getFolderById(id);
 else{
  const pointer=hubMapPackagePointer_(false),parents=DriveApp.getFileById(pointer.current.id).getParents();
  if(!parents.hasNext())hubCustomerDetailFail_('CUSTOMER_DETAILS_FOLDER_REQUIRED');folder=parents.next();
 }
 if(folder.getSharingAccess()!==DriveApp.Access.PRIVATE)hubCustomerDetailFail_('CUSTOMER_DETAILS_FOLDER_NOT_PRIVATE');return folder;
}
function hubCustomerDetailWrite_(folder,name,value,max){
 const entry=hubMapPackageCreateFile_(folder,name,value,max||HUB_CUSTOMER_DETAILS.maxStateBytes);
 return entry;
}
function hubCustomerDetailLoadJob_(){
 const id=PropertiesService.getScriptProperties().getProperty(HUB_CUSTOMER_DETAILS.job);if(!id)return null;
 const f=DriveApp.getFileById(id);if(f.getSharingAccess()!==DriveApp.Access.PRIVATE||f.getSize()>HUB_CUSTOMER_DETAILS.maxStateBytes)hubCustomerDetailFail_('CUSTOMER_DETAILS_JOB_INVALID');
 let job;try{job=JSON.parse(f.getBlob().getDataAsString('UTF-8'));}catch(e){hubCustomerDetailFail_('CUSTOMER_DETAILS_JOB_INVALID');}
 if(job.schema!==1||job.id!==id||!['BUILD','VERIFY','DONE','HELD','ERROR'].includes(job.phase))hubCustomerDetailFail_('CUSTOMER_DETAILS_JOB_INVALID');return job;
}
function hubCustomerDetailSaveJob_(job){
 job.updatedAt=hubCustomerDetailNow_();const text=JSON.stringify(job);
 if(hubMapPackageUtf8Size_(text)>HUB_CUSTOMER_DETAILS.maxStateBytes)hubCustomerDetailFail_('CUSTOMER_DETAILS_JOB_LIMIT');
 const f=DriveApp.getFileById(job.id);if(f.getSharingAccess()!==DriveApp.Access.PRIVATE)hubCustomerDetailFail_('CUSTOMER_DETAILS_JOB_NOT_PRIVATE');
 f.setContent(text);if(f.getBlob().getDataAsString('UTF-8')!==text)hubCustomerDetailFail_('CUSTOMER_DETAILS_CHECKPOINT_UNCONFIRMED');
 PropertiesService.getScriptProperties().setProperty(HUB_CUSTOMER_DETAILS.summary,JSON.stringify(hubCustomerDetailSummary_(job)));
}
function hubCustomerDetailSummary_(job){return job?{phase:job.phase,scannedRows:job.scannedRows,sourceIndex:job.sourceIndex,sourceCount:job.sources.length,preparedCustomers:job.phase==='DONE'?job.completedCount:Object.keys(job.records||{}).length,activeCustomers:job.activeCodes.length,changedFields:job.changedFields,conflicts:job.conflicts,version:job.version,updatedAt:job.updatedAt,lastError:job.lastError||null}:null;}
function hubCustomerDetailStatus_(){
 const p=hubCustomerDetailPointer_(),summary=PropertiesService.getScriptProperties().getProperty(HUB_CUSTOMER_DETAILS.summary);let job=null;try{job=summary?JSON.parse(summary):null;}catch(e){hubCustomerDetailFail_('CUSTOMER_DETAILS_STATUS_INVALID');}
 return {data:{prepared:!!p.value,version:p.value?p.value.current.version:null,job:job,automatic:typeof hubMapAutomationStatus_==='function'?hubMapAutomationStatus_().configured:false},cached:false};
}
function hubCustomerDetailScope_(){
 const root=hubMapPackageRoot_();hubMapPackageCheckManifest_(root.manifest);const codes=[];
 root.manifest.chunks.forEach(function(chunk){const rows=hubCustomerDetailRead_(root.public[chunk.key],HUB_MAP_PACKAGES.maxChunk);hubMapPackageCheckPublic_(rows,root.manifest,chunk);rows.forEach(function(row){codes.push(row[0]);});});
 if(new Set(codes).size!==codes.length||codes.length>15000)hubCustomerDetailFail_('CUSTOMER_DETAILS_SCOPE_INVALID');
 return {codes:codes.sort(),version:root.version,startDate:root.manifest.startDate,endDate:root.manifest.endDate};
}
function hubCustomerDetailSources_(){
 const ids=[HUB_DEFAULT_SOURCE_ID];if(typeof HUB_STAFF_DETAIL_ARCHIVE!=='undefined'&&HUB_STAFF_DETAIL_ARCHIVE&&HUB_STAFF_DETAIL_ARCHIVE!==HUB_DEFAULT_SOURCE_ID)ids.push(HUB_STAFF_DETAIL_ARCHIVE);
 const markers=hubCustomerDetailMarkers_(ids),sources=[];
 ids.forEach(function(id){const ss=SpreadsheetApp.openById(id);
  ['customers','daily_routes','delivery_admin_raw'].forEach(function(name){const sheet=ss.getSheetByName(name);if(!sheet||sheet.getLastRow()<2)return;
   const columns=sheet.getLastColumn();if(columns<1||columns>100)hubCustomerDetailFail_('CUSTOMER_DETAILS_SOURCE_SCHEMA');
   const headers=sheet.getRange(1,1,1,columns).getDisplayValues()[0].map(function(v){return String(v).trim();});
   // Raw JSON-only sheets and unrelated legacy formats are not guessed/parsing targets.
   if(!headers.includes('customerCode')||!headers.some(function(h){return ['customerAddress','address','accessMemo','password','accessInfo'].includes(h);}))return;
   if(new Set(headers).size!==headers.length)hubCustomerDetailFail_('CUSTOMER_DETAILS_SOURCE_SCHEMA');
   sources.push({id:id,sheet:name,headers:headers,rows:sheet.getLastRow(),nextRow:2,kind:name==='delivery_admin_raw'?'DELIVERY_STORED':'CUSTOMER'});
  });
 });if(!sources.length)hubCustomerDetailFail_('CUSTOMER_DETAILS_SOURCE_NOT_READY');return {sources:sources,markers:markers};
}
function hubMapCustomerDetailsSyncRequest_(params){
 hubMapHttpValidateOnlyKeys_(params||{},[]);const lock=LockService.getUserLock();if(!lock.tryLock(1000))return {data:{phase:'BUSY'},cached:false};
 try{
  const existing=hubCustomerDetailLoadJob_();if(existing&&['BUILD','VERIFY'].includes(existing.phase))return {data:hubCustomerDetailSummary_(existing),cached:false};
  const scope=hubCustomerDetailScope_(),source=hubCustomerDetailSources_(),before=hubCustomerDetailPointer_();
  if(before.value){const root=hubCustomerDetailRead_(before.value.current,262144);if(root.scopeVersion===scope.version&&JSON.stringify(root.sourceMarkers)===JSON.stringify(source.markers))return {data:{phase:'NOOP',version:root.version},cached:false};}
  const folder=hubCustomerDetailFolder_(),job={schema:1,id:null,phase:'BUILD',createdAt:hubCustomerDetailNow_(),updatedAt:hubCustomerDetailNow_(),sourceIndex:0,scannedRows:0,sources:source.sources,sourceMarkers:source.markers,activeCodes:scope.codes,scopeVersion:scope.version,startDate:scope.startDate,endDate:scope.endDate,basePointer:before.raw,version:before.value?before.value.current.version+1:1,records:{},changedFields:0,conflicts:0,lastError:null,folderId:folder.getId()};
  // Preserve prior verified values; omissions and blank cells never erase them.
  if(before.value){const old=hubCustomerDetailRead_(before.value.current,262144),active=new Set(scope.codes);Object.keys(old.buckets).forEach(function(key){const bucket=hubCustomerDetailRead_(old.buckets[key],HUB_CUSTOMER_DETAILS.maxBucketBytes);Object.keys(bucket).forEach(function(code){if(active.has(code))job.records[code]=bucket[code];});});}
  const file=folder.createFile('customer-detail-job-'+Date.now()+'.json','{}',MimeType.PLAIN_TEXT);job.id=file.getId();hubCustomerDetailSaveJob_(job);
  const props=PropertiesService.getScriptProperties();props.setProperty(HUB_CUSTOMER_DETAILS.job,job.id);if(props.getProperty(HUB_CUSTOMER_DETAILS.job)!==job.id)hubCustomerDetailFail_('CUSTOMER_DETAILS_CHECKPOINT_UNCONFIRMED');
  return {data:hubCustomerDetailSummary_(job),cached:false};
 }finally{lock.releaseLock();}
}
function hubCustomerDetailFinish_(job,deadline){
 if(!hubCustomerDetailSourceUnchanged_(job.sourceMarkers))hubCustomerDetailFail_('CUSTOMER_DETAILS_SOURCE_CHANGED');
 const folder=DriveApp.getFolderById(job.folderId),grouped={};
 Object.keys(job.records).sort().forEach(function(code){const key=hubCustomerDetailHash_(code).slice(0,2);(grouped[key]||(grouped[key]={}))[code]=job.records[code];});
 if(!job.output)job.output={buckets:{},next:0,verifiedCount:0};const keys=Object.keys(grouped).sort();let written=0;
 // Bounded immutable publication preparation; safe to resume after each checkpoint.
 while(job.output.next<keys.length&&Date.now()<deadline&&written<8){
  const key=keys[job.output.next],entry=hubCustomerDetailWrite_(folder,'customer-details-v'+job.version+'-'+key+'.json',grouped[key],HUB_CUSTOMER_DETAILS.maxBucketBytes);
  const bucket=hubCustomerDetailRead_(entry,HUB_CUSTOMER_DETAILS.maxBucketBytes);
  Object.keys(bucket).forEach(function(code){if(hubCustomerDetailHash_(code).slice(0,2)!==key||!job.records[code])hubCustomerDetailFail_('CUSTOMER_DETAILS_BUCKET_MISMATCH');OpsmapCustomerDetailContract.project(bucket[code],{view:'notes'});OpsmapCustomerDetailContract.project(bucket[code],{view:'store'});job.output.verifiedCount++;});
  job.output.buckets[key]=entry;job.output.next++;written++;hubCustomerDetailSaveJob_(job);
 }
 if(job.output.next<keys.length)return hubCustomerDetailSummary_(job);
 const count=Object.keys(job.records).length;if(job.output.verifiedCount!==count)hubCustomerDetailFail_('CUSTOMER_DETAILS_BUCKET_MISMATCH');
 const root={schema:1,version:job.version,buckets:job.output.buckets,customerCount:count,activeCount:job.activeCodes.length,scopeVersion:job.scopeVersion,startDate:job.startDate,endDate:job.endDate,sourceMarkers:job.sourceMarkers,checkedAt:hubCustomerDetailNow_(),sourceCompletenessVerified:false};
 if(!hubCustomerDetailSourceUnchanged_(job.sourceMarkers))hubCustomerDetailFail_('CUSTOMER_DETAILS_SOURCE_CHANGED');
 const entry=hubCustomerDetailWrite_(folder,'customer-details-root-v'+job.version+'.json',root,262144);
 const lock=LockService.getScriptLock();if(!lock.tryLock(1000))return hubCustomerDetailSummary_(job);
 try{const props=PropertiesService.getScriptProperties(),raw=props.getProperty(HUB_CUSTOMER_DETAILS.pointer);if(raw!==job.basePointer)hubCustomerDetailFail_('CUSTOMER_DETAILS_POINTER_CHANGED');
  const old=raw?JSON.parse(raw):null,next=JSON.stringify({schema:1,current:Object.assign({version:job.version},entry),previous:old?old.current:null});props.setProperty(HUB_CUSTOMER_DETAILS.pointer,next);if(props.getProperty(HUB_CUSTOMER_DETAILS.pointer)!==next)hubCustomerDetailFail_('CUSTOMER_DETAILS_PUBLISH_UNCONFIRMED');
 }finally{lock.releaseLock();}
 job.phase='DONE';job.records={};job.completedCount=count;delete job.output;hubCustomerDetailSaveJob_(job);return hubCustomerDetailSummary_(job);
}
function hubMapCustomerDetailsContinue(options){
 options=options||{};const lock=LockService.getUserLock();if(!lock.tryLock(1000))return {phase:'BUSY'};let job;
 try{
  job=hubCustomerDetailLoadJob_();if(!job||!['BUILD','VERIFY'].includes(job.phase))return hubCustomerDetailSummary_(job);
  if(!hubCustomerDetailSourceUnchanged_(job.sourceMarkers))hubCustomerDetailFail_('CUSTOMER_DETAILS_SOURCE_CHANGED');
  const active=new Set(job.activeCodes),deadline=Date.now()+Math.min(180000,Math.max(1000,Number(options.timeBudgetMs)||90000));let processed=0;
  while(job.sourceIndex<job.sources.length&&Date.now()<deadline&&processed<HUB_CUSTOMER_DETAILS.maxRunRows){
   const source=job.sources[job.sourceIndex],sheet=SpreadsheetApp.openById(source.id).getSheetByName(source.sheet);
   if(!sheet||sheet.getLastRow()!==source.rows||JSON.stringify(sheet.getRange(1,1,1,source.headers.length).getDisplayValues()[0].map(String))!==JSON.stringify(source.headers))hubCustomerDetailFail_('CUSTOMER_DETAILS_SOURCE_CHANGED');
   if(source.nextRow>source.rows){job.sourceIndex++;continue;}
   const size=Math.min(HUB_CUSTOMER_DETAILS.batchRows,source.rows-source.nextRow+1),rows=sheet.getRange(source.nextRow,1,size,source.headers.length).getValues();
   if(rows.length!==size)hubCustomerDetailFail_('CUSTOMER_DETAILS_SOURCE_PAGE');
   rows.forEach(function(values){const row={};source.headers.forEach(function(h,i){const value=values[i];row[h]=value instanceof Date?(h==='deliveryDate'?Utilities.formatDate(value,'Asia/Seoul','yyyy-MM-dd'):value.toISOString()):value;});const code=String(row.customerCode||'').trim().toUpperCase();if(!active.has(code))return;row.customerCode=code;
    let date=row.deliveryDate;if(date instanceof Date)date=Utilities.formatDate(date,'Asia/Seoul','yyyy-MM-dd');else if(typeof date==='string')date=date.slice(0,10);
    if(source.sheet!=='customers'&&(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||date<job.startDate||date>Utilities.formatDate(new Date(job.createdAt),'Asia/Seoul','yyyy-MM-dd')))return;
    const marker=job.sourceMarkers.find(function(m){return m.id===source.id;}),input=OpsmapCustomerDetailContract.observation(row,{source:source.kind,sourceVersion:hubCustomerDetailHash_(source.id+':'+marker.modifiedAt),observedAt:job.createdAt,modifiedAt:row.updatedAt||row.modifiedAt,sourceRecordDate:date||null,correctionVerified:row.correctionVerified===true,deleted:row.deleted===true,clearedFields:row.correctionVerified===true&&typeof row.clearedFields==='string'&&row.clearedFields.trim()?JSON.parse(row.clearedFields):[]});
    const merged=OpsmapCustomerDetailContract.merge(job.records[code],input);job.records[code]=merged.record;job.changedFields+=merged.changedFields.length;job.conflicts+=merged.conflicts.length;
   });
   source.nextRow+=size;job.scannedRows+=size;processed+=size;
   if(!hubCustomerDetailSourceUnchanged_(job.sourceMarkers))hubCustomerDetailFail_('CUSTOMER_DETAILS_SOURCE_CHANGED');hubCustomerDetailSaveJob_(job);
  }
  if(job.sourceIndex>=job.sources.length){job.phase='VERIFY';hubCustomerDetailSaveJob_(job);return hubCustomerDetailFinish_(job,deadline);}return hubCustomerDetailSummary_(job);
 }catch(e){if(job){job.phase=/SOURCE_CHANGED|POINTER_CHANGED|PUBLISH_UNCONFIRMED|CHECKPOINT_UNCONFIRMED/.test(e.message)?'HELD':'ERROR';job.lastError=hubCustomerDetailSafeError_(e);try{hubCustomerDetailSaveJob_(job);}catch(ignored){}}return {phase:job?job.phase:'ERROR',lastError:hubCustomerDetailSafeError_(e)};
 }finally{lock.releaseLock();}
}
function hubMapCustomerDetailsAutoStep_(){
 try{
  const job=hubCustomerDetailLoadJob_();if(job&&['BUILD','VERIFY'].includes(job.phase))return hubMapCustomerDetailsContinue({timeBudgetMs:60000});
  // No automatic retry of ambiguous publication/checkpoint effects or source errors.
  if(job&&['HELD','ERROR'].includes(job.phase))return hubCustomerDetailSummary_(job);
  const request=hubMapCustomerDetailsSyncRequest_({});return request.data.phase==='BUILD'?hubMapCustomerDetailsContinue({timeBudgetMs:60000}):request.data;
 }catch(e){return {phase:'ERROR',lastError:hubCustomerDetailSafeError_(e)};}
}
function hubMapCustomerDetailPrepared_(params){
 hubMapHttpValidateOnlyKeys_(params,['customerCode','view','requestedDate']);const code=hubMapHttpCustomerCode_(params.customerCode),view=params.view||'notes';
 if(!['notes','store'].includes(view))hubCustomerDetailFail_('CUSTOMER_DETAILS_VIEW');const date=params.requestedDate?hubMapHttpDate_(params.requestedDate,'requestedDate'):null;
 const pointer=hubCustomerDetailPointer_();if(!pointer.value)hubCustomerDetailFail_('CUSTOMER_DETAILS_NOT_READY');
 const root=hubCustomerDetailRead_(pointer.value.current,262144),key=hubCustomerDetailHash_(code).slice(0,2),entry=root.buckets[key];
 const bucket=entry?hubCustomerDetailRead_(entry,HUB_CUSTOMER_DETAILS.maxBucketBytes):{},record=bucket[code];
 if(!record)hubCustomerDetailFail_('CUSTOMER_DETAILS_CUSTOMER_UNOBSERVED');
 const current=hubCustomerDetailSourceUnchanged_(root.sourceMarkers)?'SOURCE_UNCHANGED':'SOURCE_CHANGED';
 const result=OpsmapCustomerDetailContract.project(record,{view:view,requestedDate:date,currentness:current,version:root.version,checkedAt:root.checkedAt});
 result.cached=false;result.meta.filesRead=entry?2:1;return result;
}
