/** Bounded Production coordinate supplement; never mutates a source sheet. */
const HUB_PRODUCTION_COORDINATES=Object.freeze({property:'PHASE2B_PRODUCTION_COORDINATES_V1',maxCustomers:200});
function hubProductionCoordinateValid_(r){return Number(r.lat)>=33&&Number(r.lat)<=39.5&&Number(r.lng)>=124&&Number(r.lng)<=132;}
function hubProductionCoordinateAddress_(s){
  const value=String(s||'').trim();
  if(!value||value.length>200||/[\r\n]|비밀번호|출입|공동현관|연락처|01[016789][- ]?\d{3,4}[- ]?\d{4}/.test(value))return '';
  return value;
}
function hubProductionCoordinateNormalize_(s){return String(s||'').replace(/\([^)]*\)/g,'').replace(/^경상남도/,'경남').replace(/^경상북도/,'경북').replace(/^전라남도/,'전남').replace(/^전라북도|^전북특별자치도/,'전북').replace(/광역시|특별시/g,'').replace(/\s+/g,'').trim();}
function hubProductionCoordinateCandidates_(){
  const published=hubStageModelLoad_();hubStageRestoreManifest_(published);
  const root='https://freshon-admin-1.onrender.com',r=UrlFetchApp.fetch(root+'/api/map-phase2b/preview/period?startDate='+published.startDate+'&endDate='+published.endDate,{muteHttpExceptions:true});
  if(r.getResponseCode()!==200)throw new Error('MODEL_COORD_PERIOD_NOT_READY');
  const p=JSON.parse(r.getContentText());if(!Array.isArray(p.data)||!p.meta||!p.meta.complete)throw new Error('MODEL_COORD_PERIOD_CONTRACT');
  const codes=p.data.map(function(row){return row.customerCode;});
  if(codes.length>10000||codes.some(function(c){return !/^[A-Z]\d+$/.test(c);}))throw new Error('MODEL_COORD_SCOPE');
  const b=UrlFetchApp.fetch(root+'/api/map-phase2b/preview/base-vehicles',{method:'post',contentType:'application/json',payload:JSON.stringify({customerCodes:codes}),muteHttpExceptions:true});
  if(b.getResponseCode()!==200)throw new Error('MODEL_COORD_MASTER_NOT_READY');
  const base=JSON.parse(b.getContentText()),byCode={};if(!Array.isArray(base.data)||!base.meta||!base.meta.version)throw new Error('MODEL_COORD_MASTER_CONTRACT');
  base.data.forEach(function(row){byCode[row.customerCode]=row;});
  const groups={yeongnam:{periodCustomers:0,withCoordinates:0},honam:{periodCustomers:0,withCoordinates:0}},targets=[];
  p.data.forEach(function(row){const group=byCode[row.customerCode]&&byCode[row.customerCode].baseVehicleGroup;if(!groups[group])return;groups[group].periodCustomers++;
    if(hubProductionCoordinateValid_(row))groups[group].withCoordinates++;else targets.push({customerCode:row.customerCode,group:group});
  });
  if(targets.length>HUB_PRODUCTION_COORDINATES.maxCustomers)throw new Error('MODEL_COORD_SCOPE_REVIEW_REQUIRED');
  return {generation:published.generation,startDate:published.startDate,endDate:published.endDate,masterVersion:base.meta.version,masterStale:!!base.meta.stale,groups:groups,targets:targets};
}
function hubProductionCoordinateStored_(targets,deadline){
  const result={},sources=[],codes=targets.map(function(r){result[r.customerCode]={points:[],addresses:[]};return r.customerCode;});
  if(!codes.length)return {rows:result,sources:sources};
  const current=SpreadsheetApp.openById(HUB_DEFAULT_SOURCE_ID),archive=SpreadsheetApp.openById(HUB_STAFF_DETAIL_ARCHIVE),hub=SpreadsheetApp.getActive();
  const sheets=[{sheet:current.getSheetByName('customers'),source:'CURRENT_CUSTOMERS'},
    {sheet:current.getSheetByName('map_coordinate_cache_v2'),source:'CURRENT_COORDINATE_CACHE'},
    {sheet:hub&&hub.getSheetByName('hub_customers'),source:'HUB_CUSTOMERS'},
    {sheet:hub&&hub.getSheetByName('customer_index'),source:'HUB_CUSTOMER_INDEX'}];
  archive.getSheets().filter(function(sh){return /^(map_store_base_v1|map_.*cache.*|map_base.*|.*coordinate.*)$/.test(sh.getName())&&!/_build$/.test(sh.getName());}).forEach(function(sh){sheets.push({sheet:sh,source:'ARCHIVE_MAP_CACHE'});});
  sheets.forEach(function(entry){
    if(Date.now()>deadline)throw new Error('MODEL_COORD_TIME_LIMIT');
    const sh=entry.sheet;if(!sh||sh.getLastRow()<2)return;
    const width=sh.getLastColumn();if(width>128)return;
    const headers=sh.getRange(1,1,1,width).getValues()[0].map(String),col=headers.indexOf('customerCode');if(col<0)return;
    const fields=['customerCode','lat','lng','customerAddress','address','latestAddress'].filter(function(k){return headers.indexOf(k)>=0;});
    const positions=sh.getRange(2,col+1,sh.getLastRow()-1,1).createTextFinder('^('+codes.join('|')+')$').matchEntireCell(true).useRegularExpression(true).findAll().map(function(cell){return cell.getRow();});
    if(positions.length>4000)throw new Error('MODEL_COORD_SOURCE_SCOPE');
    const rows=hubStaffHistoryBatchRead_(sh.getParent().getId(),sh.getSheetId(),headers,positions,fields);sources.push({source:entry.source,matchedRows:rows.length});
    rows.forEach(function(row){const v=result[row.customerCode];if(!v)throw new Error('MODEL_COORD_SOURCE_CHANGED');const address=hubProductionCoordinateAddress_(row.customerAddress||row.address||row.latestAddress);
      if(address)v.addresses.push(address);
      if(hubProductionCoordinateValid_(row))v.points.push({lat:Number(row.lat),lng:Number(row.lng),source:entry.source,address:address});
    });
  });
  return {rows:result,sources:sources};
}
function hubProductionCoordinateStoredChoice_(row){
  const points=row.points||[],addresses=[...new Set((row.addresses||[]).map(hubProductionCoordinateNormalize_))];
  if(points.length){const p=points[0];if(points.some(function(q){return Math.abs(q.lat-p.lat)>0.00001||Math.abs(q.lng-p.lng)>0.00001;}))return {status:'STORED_COORDINATE_CONFLICT'};return {status:'STORED_MATCH',point:p};}
  if(addresses.length!==1)return {status:addresses.length?'ADDRESS_CONFLICT':'ADDRESS_MISSING'};
  return {status:'ADDRESS_ONLY',address:row.addresses[0]};
}
// Read only: no geocoding request, candidate, property, trigger or file writes.
function hubProductionCoordinateAudit(){
  const scope=hubProductionCoordinateCandidates_(),stored=hubProductionCoordinateStored_(scope.targets,Date.now()+220000),counts={};
  scope.targets.forEach(function(t){const c=hubProductionCoordinateStoredChoice_(stored.rows[t.customerCode]);counts[c.status]=(counts[c.status]||0)+1;});
  console.log(JSON.stringify({generation:scope.generation,scope:'PUBLISHED_PERIOD_CUSTOMERS_NOT_ALL_CENTER_CUSTOMERS',groups:scope.groups,targets:scope.targets.length,masterStale:scope.masterStale,sources:stored.sources,counts:counts,kakaoConfigured:!!setting_('KAKAO_REST_API_KEY'),sourceWrites:0,geocodingRequests:0}));
}
function hubProductionCoordinateSourceSchema(){
  const books=[{id:HUB_DEFAULT_SOURCE_ID,source:'CUSTOMER'},{id:HUB_STAFF_DETAIL_ARCHIVE,source:'ARCHIVE'},{id:SpreadsheetApp.getActive().getId(),source:'HUB'}];
  const result=[];books.forEach(function(book){SpreadsheetApp.openById(book.id).getSheets().filter(function(sh){return /customer|map|daily_routes|delivery_admin_raw/i.test(sh.getName());}).forEach(function(sh){
    const width=sh.getLastColumn();if(!width||width>128)return;
    result.push({source:book.source,sheet:sh.getName(),rows:sh.getLastRow(),headers:sh.getRange(1,1,1,width).getValues()[0].map(String)});
  });});console.log(JSON.stringify({sourceSchema:result}));
}
