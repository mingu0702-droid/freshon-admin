/** Private, separate evidence only. No source-sheet/model/shard mutation. */
function hubProductionCoordinateEnvelope_(rows,checkedAt){
  const seen={},keys=['customerCode','group','lat','lng','address','source','checkedAt'];
  if(!Array.isArray(rows)||rows.length>200||!Number.isFinite(Date.parse(checkedAt)))throw new Error('MODEL_COORD_CONTRACT');
  rows.forEach(function(row){
    if(Object.keys(row).some(function(k){return keys.indexOf(k)<0;})||!/^[A-Z]\d+$/.test(row.customerCode)||seen[row.customerCode]||['yeongnam','honam'].indexOf(row.group)<0||!hubProductionCoordinateValid_(row)||['STORED_MATCH','KAKAO_EXACT_ADDRESS'].indexOf(row.source)<0||!Number.isFinite(Date.parse(row.checkedAt))||hubProductionCoordinateAddress_(row.address)!==row.address)throw new Error('MODEL_COORD_CONTRACT');
    seen[row.customerCode]=true;
  });
  const body={schema:1,checkedAt:checkedAt,rows:rows};return {schema:1,checkedAt:checkedAt,rows:rows,hash:hubStageModelHash_(body)};
}
function hubProductionCoordinateLoad_(){
  const id=PropertiesService.getScriptProperties().getProperty(HUB_PRODUCTION_COORDINATES.property);
  if(!id)return null;
  const file=DriveApp.getFileById(id);if(file.getSharingAccess()!==DriveApp.Access.PRIVATE)throw new Error('MODEL_COORD_STORAGE_NOT_PRIVATE');
  const value=JSON.parse(file.getBlob().getDataAsString('UTF-8'));
  const expected=hubProductionCoordinateEnvelope_(value.rows,value.checkedAt);
  if(JSON.stringify(value)!==JSON.stringify(expected))throw new Error('MODEL_COORD_HASH');return value;
}
function hubProductionCoordinateRead_(params){
  hubMapHttpValidateOnlyKeys_(params,[]);
  const value=hubProductionCoordinateLoad_();
  if(!value)throw new Error('MODEL_COORD_NOT_READY');return {data:value,cached:false};
}
function hubProductionCoordinateKakaoChoice_(body,address){
  if(!body||!Array.isArray(body.documents)||body.meta&&body.meta.is_end===false)return {status:'KAKAO_INCOMPLETE'};
  const query=hubProductionCoordinateNormalize_(address),matches=body.documents.filter(function(d){
    return [d.address_name,d.road_address&&d.road_address.address_name,d.address&&d.address.address_name].some(function(s){return s&&hubProductionCoordinateNormalize_(s)===query;});
  });
  if(matches.length!==1)return {status:matches.length?'KAKAO_AMBIGUOUS':'KAKAO_ADDRESS_MISMATCH'};
  const point={lat:Number(matches[0].y),lng:Number(matches[0].x)};
  return hubProductionCoordinateValid_(point)?{status:'KAKAO_EXACT_ADDRESS',point:point}:{status:'KAKAO_COORDINATE_INVALID'};
}
function hubProductionCoordinateGeocode_(address,key){
  if(!address||hubProductionCoordinateAddress_(address)!==address)throw new Error('MODEL_COORD_ADDRESS_UNSAFE');
  const response=UrlFetchApp.fetch('https://dapi.kakao.com/v2/local/search/address.json?query='+encodeURIComponent(address),{headers:{Authorization:'KakaoAK '+key},muteHttpExceptions:true});
  const http=response.getResponseCode();if(http===401||http===403)throw new Error('MODEL_COORD_KAKAO_HTTP_'+http);if(http!==200)return {status:'KAKAO_HTTP_'+http};
  let body;try{body=JSON.parse(response.getContentText());}catch(ignored){return {status:'KAKAO_JSON_INVALID'};}
  return hubProductionCoordinateKakaoChoice_(body,address);
}
// Approved bounded operator action. Saves only independently verified points;
// unresolved/ambiguous addresses remain review-needed, not invented locations.
function hubProductionCoordinateRepair(){
  const lock=LockService.getUserLock();if(!lock.tryLock(1000))throw new Error('MODEL_WORKER_BUSY');
  try{
    const restore=hubStageRestoreLoad_('production'),job=hubMapIncrementalLoad_();
    if(restore&&restore.phase!=='DONE'||job&&job.phase!=='DONE')throw new Error('MODEL_COORD_WORKER_BUSY');
    const scope=hubProductionCoordinateCandidates_(),deadline=Date.now()+210000,stored=hubProductionCoordinateStored_(scope.targets,deadline);
    const props=PropertiesService.getScriptProperties(),priorId=props.getProperty(HUB_PRODUCTION_COORDINATES.property),old=hubProductionCoordinateLoad_(),byCode={},counts={},key=setting_('KAKAO_REST_API_KEY');
    (old&&old.rows||[]).forEach(function(r){byCode[r.customerCode]=r;});
    let requests=0,verified=0;const checkedAt=new Date().toISOString();
    scope.targets.forEach(function(target){
      if(Date.now()>deadline||requests>=80){counts.DEFERRED=(counts.DEFERRED||0)+1;return;}
      const evidence=stored.rows[target.customerCode],choice=hubProductionCoordinateStoredChoice_(evidence);
      let result=choice,address=choice.address||choice.point&&choice.point.address||'';
      if(choice.status==='ADDRESS_ONLY'){
        const previous=byCode[target.customerCode];
        if(previous&&hubProductionCoordinateNormalize_(previous.address)===hubProductionCoordinateNormalize_(address)){counts.PREVIOUS_VERIFIED=(counts.PREVIOUS_VERIFIED||0)+1;return;}
        if(key){requests++;result=hubProductionCoordinateGeocode_(address,key);}else result={status:'KAKAO_NOT_CONFIGURED'};
      }
      counts[result.status]=(counts[result.status]||0)+1;
      if(result.status==='STORED_MATCH'||result.status==='KAKAO_EXACT_ADDRESS'){
        byCode[target.customerCode]={customerCode:target.customerCode,group:target.group,lat:result.point.lat,lng:result.point.lng,address:address,source:result.status,checkedAt:checkedAt};verified++;
      }
    });
    if(verified){
      const rows=Object.keys(byCode).sort().map(function(code){return byCode[code];}),value=hubProductionCoordinateEnvelope_(rows,checkedAt);
      const published=hubStageModelLoad_();if(published.generation!==scope.generation)throw new Error('MODEL_COORD_GENERATION_CHANGED');
      const folder=DriveApp.getFolderById(published.folderId);if(folder.getSharingAccess()!==DriveApp.Access.PRIVATE)throw new Error('MODEL_COORD_STORAGE_NOT_PRIVATE');
      const text=JSON.stringify(value),file=folder.createFile('production-coordinate-evidence-'+Date.now()+'.json',text,MimeType.PLAIN_TEXT);
      if(file.getSharingAccess()!==DriveApp.Access.PRIVATE||file.getBlob().getDataAsString('UTF-8')!==text)throw new Error('MODEL_COORD_SAVE_VERIFY');
      if(props.getProperty(HUB_PRODUCTION_COORDINATES.property)!==priorId)throw new Error('MODEL_COORD_POINTER_CONFLICT');
      props.setProperty(HUB_PRODUCTION_COORDINATES.property,file.getId());
      if(hubProductionCoordinateLoad_().hash!==value.hash)throw new Error('MODEL_COORD_READBACK');
    }
    console.log(JSON.stringify({scope:'PUBLISHED_PERIOD_MISSING_COORDINATES_ONLY',generation:scope.generation,groups:scope.groups,targets:scope.targets.length,counts:counts,verified:verified,geocodingRequests:requests,sourceWrites:0,shardWrites:0}));
  }catch(e){console.log(JSON.stringify({code:/^MODEL_[A-Z0-9_]+$/.test(String(e.message))?e.message:'MODEL_COORD_REPAIR_FAILED',sourceWrites:0,shardWrites:0}));}
  finally{lock.releaseLock();}
}
