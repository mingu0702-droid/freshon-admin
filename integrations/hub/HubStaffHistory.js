/** Read-only historical contact lookup. Cache ONLY source row positions. */
function hubStaffHistorySource_(code, start, end) {
  const profile={lookupMs:0,readMs:0,sourceRows:0,metadataHits:0,openMs:0,headerMs:0,selectMs:0,discoverMs:0,normalizeMs:0,selectionHit:false,headerHits:0}, rows=[];
  const cache=CacheService.getScriptCache(),opened={};
  function open(id){if(opened[id])return opened[id];const at=Date.now(),sheet=SpreadsheetApp.openById(id).getSheetByName('daily_routes');profile.openMs+=Date.now()-at;if(!sheet)throw new Error('HISTORY_SOURCE_MISSING');return opened[id]=sheet;}
  // Reuse the existing retention/date-bounded source selection; no archive-wide
  // history lookup when the requested dates are wholly in Current.
  const current=open(HUB_DEFAULT_SOURCE_ID),currentLast=current.getLastRow();
  const selectionKey=hubDataCacheKey_('staff_history_source_v2',{start:start,end:end,id:HUB_DEFAULT_SOURCE_ID,sheet:current.getSheetId(),last:currentLast,columns:current.getLastColumn()});
  const selectAt=Date.now();let source=cache.get(selectionKey);
  if(/^(Current|Archive|Archive\+Current)$/.test(source||''))profile.selectionHit=true;
  else{const selection=CustomerDataApi.getDailyRoutes({startDate:start,endDate:end,limit:1});
    if(!selection||!selection.ok)throw new Error('HISTORY_SOURCE_SELECTION_FAILED');
    source=String(selection.meta&&selection.meta.source||'');
    if(/^(Current|Archive|Archive\+Current)$/.test(source))cache.put(selectionKey,source,60);
  }
  profile.selectMs=Date.now()-selectAt;profile.source=source;
  if(!/^(Current|Archive|Archive\+Current)$/.test(source))throw new Error('HISTORY_SOURCE_SELECTION_INVALID');
  const ids=[];if(source.indexOf('Current')>=0)ids.push(HUB_DEFAULT_SOURCE_ID);if(source.indexOf('Archive')>=0)ids.push(HUB_STAFF_DETAIL_ARCHIVE);
  ids.forEach(function(id){
    const at=Date.now(),sheet=open(id);
    if(!sheet)throw new Error('HISTORY_SOURCE_MISSING');
    const last=sheet.getLastRow(),columns=sheet.getLastColumn();
    if(last<2)return;
    if(columns<1||columns>128)throw new Error('HISTORY_HEADER_INVALID');
    const headerAt=Date.now(),headerKey=hubDataCacheKey_('staff_history_header_v2',{id:id,sheet:sheet.getSheetId(),last:last,columns:columns});
    let headers=null;try{headers=JSON.parse(cache.get(headerKey)||'null');}catch(ignored){}
    if(!Array.isArray(headers)||headers.length!==columns){headers=sheet.getRange(1,1,1,columns).getValues()[0].map(String);cache.put(headerKey,JSON.stringify(headers),60);}else profile.headerHits++;
    profile.headerMs+=Date.now()-headerAt;
    const required=['deliveryDate','customerCode','confirmedVehicle','baseVehicle','driverName','driverPhone'];
    if(required.some(function(k){return headers.indexOf(k)<0;}))throw new Error('HISTORY_HEADER_INVALID');
    const key=hubDataCacheKey_('staff_history_positions_v1',{id:id,sheet:sheet.getSheetId(),last:last,columns:columns,code:code});
    let positions=null;
    try{positions=JSON.parse(cache.get(key)||'null');}catch(ignored){}
    if(!Array.isArray(positions)||positions.some(function(n){return!Number.isInteger(n)||n<2||n>last;})){
      const discoverAt=Date.now();positions=sheet.getRange(2,headers.indexOf('customerCode')+1,last-1,1).createTextFinder(code)
        .matchEntireCell(true).useRegularExpression(false).findAll().map(function(cell){return cell.getRow();});
      if(positions.length>2000)throw new Error('HISTORY_CUSTOMER_CAPACITY');
      cache.put(key,JSON.stringify(positions),300);
      profile.discoverMs+=Date.now()-discoverAt;
    }else profile.metadataHits++;
    profile.lookupMs+=Date.now()-at;
    if(!positions.length)return;
    const requested=required.concat(headers.indexOf('hashKey')<0?[]:['hashKey']);
    const readAt=Date.now();
    // A single Sheets read batches sparse customer rows, avoiding N reads per visit.
    // Only the historical columns above are requested; memo/owner contacts never read.
    const objects=hubStaffHistoryBatchRead_(id,sheet.getSheetId(),headers,positions,requested);
    profile.readMs+=Date.now()-readAt;profile.sourceRows+=objects.length;
    if(sheet.getLastRow()!==last){cache.remove(key);cache.remove(selectionKey);throw new Error('HISTORY_SOURCE_CHANGED');}
    objects.forEach(function(row){
      if(String(row.customerCode||'').trim()!==code){cache.remove(key);throw new Error('HISTORY_LOCATOR_CHANGED');}
      const date=hubStaffHistoryDate_(row.deliveryDate);row.deliveryDate=date;
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('HISTORY_DATE_INVALID');
      if(date>=start&&date<=end)rows.push(row);
    });
  });
  const normalizeAt=Date.now(),seen=new Set(),unique=rows.filter(function(row){
    const key=JSON.stringify([hubStaffDetailDate_(row.deliveryDate),String(row.customerCode),String(row.confirmedVehicle||row.baseVehicle||''),String(row.driverName||''),String(row.driverPhone||'')]);
    if(seen.has(key))return false;seen.add(key);return true;
  });
  unique.sort(function(a,b){return hubStaffDetailDate_(b.deliveryDate).localeCompare(hubStaffDetailDate_(a.deliveryDate));});
  profile.normalizeMs=Date.now()-normalizeAt;
  return {rows:unique,profile:profile};
}
function hubStaffHistoryDate_(value){
  if(typeof value==='number'&&Number.isFinite(value)&&value>=20000&&value<80000)return new Date(Date.UTC(1899,11,30)+Math.floor(value)*86400000).toISOString().slice(0,10);
  if(Object.prototype.toString.call(value)==='[object Date]')return Utilities.formatDate(value,'Asia/Seoul','yyyy-MM-dd');
  const text=String(value||'').trim();let m=text.match(/^(\d{4})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})(?:\.|\s|T|$)/);
  if(!m){const us=text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/);if(us)m=[us[0],us[3],us[1],us[2]];}
  if(!m)return null;
  const date=[m[1],('0'+m[2]).slice(-2),('0'+m[3]).slice(-2)].join('-');
  return new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]))).toISOString().slice(0,10)===date?date:null;
}
function hubStaffHistoryBatchRead_(id,sheetId,headers,positions,requested) {
  const result=[];
  for(let offset=0;offset<positions.length;offset+=200){
    const batch=positions.slice(offset,offset+200),filters=[];
    // Coalesce adjacent requested columns, but never bridge a non-allowlisted column.
    const columns=requested.map(function(k){return headers.indexOf(k);}).sort(function(a,b){return a-b;}),groups=[];
    columns.forEach(function(c){const last=groups[groups.length-1];if(last&&last.end===c)last.end=c+1;else groups.push({start:c,end:c+1});});
    batch.forEach(function(row){groups.forEach(function(g){filters.push({gridRange:{sheetId:sheetId,startRowIndex:row-1,endRowIndex:row,startColumnIndex:g.start,endColumnIndex:g.end}});});});
    const response=UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'+id+'/values:batchGetByDataFilter',{
      method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true,
      payload:JSON.stringify({dataFilters:filters,majorDimension:'ROWS',valueRenderOption:'FORMATTED_VALUE'})
    });
    if(response.getResponseCode()!==200)throw new Error('HISTORY_SHEETS_HTTP_'+response.getResponseCode());
    let body;try{body=JSON.parse(response.getContentText());}catch(ignored){throw new Error('HISTORY_SHEETS_INVALID_JSON');}
    if(!Array.isArray(body.valueRanges)||body.valueRanges.length!==filters.length)throw new Error('HISTORY_BATCH_INCOMPLETE');
    function signature(grid){return [grid.sheetId||0,grid.startRowIndex||0,grid.endRowIndex,grid.startColumnIndex||0,grid.endColumnIndex].join(':');}
    const byRow={},matched=new Set(),expected=new Set(filters.map(function(f){return signature(f.gridRange);}));
    body.valueRanges.forEach(function(item){
      if(!item.dataFilters||item.dataFilters.length!==1)throw new Error('HISTORY_BATCH_FILTER_INVALID');
      const grid=item.dataFilters[0].gridRange,key=signature(grid);
      if(!expected.has(key)||matched.has(key))throw new Error('HISTORY_BATCH_FILTER_INVALID');
      matched.add(key);
      const row=byRow[grid.startRowIndex]||(byRow[grid.startRowIndex]={}),values=item.valueRange&&item.valueRange.values||[];
      if(values.length>1)throw new Error('HISTORY_BATCH_RANGE_INVALID');
      for(let c=grid.startColumnIndex;c<grid.endColumnIndex;c++)row[headers[c]]=values[0]&&values[0][c-grid.startColumnIndex]||'';
    });
    batch.forEach(function(row){if(!byRow[row-1])throw new Error('HISTORY_BATCH_INCOMPLETE');result.push(byRow[row-1]);});
  }
  return result;
}
