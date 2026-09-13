/** Reuse the legacy date-bound envelope once, then read only required columns. */
function hubPeriodSourcePage_(filters,cursor){
  if(cursor&&cursor.fast)return hubPeriodReadBounded_(cursor.fast,cursor.offset,filters.limit);
  const result=CustomerDataApi.getDailyRoutes(filters);
  if(!result||!result.ok||cursor||!result.meta||result.meta.source!=='Current'||!result.meta.nextToken)return result;
  const count=Number(result.meta.returned),total=Number(result.meta.total);
  let token;try{token=JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(result.meta.nextToken)).getDataAsString());}catch(ignored){return result;}
  if(token.sourceIndex!==0||!Number.isInteger(token.row)||count!==filters.limit||!Number.isInteger(total))return result;
  const sheet=SpreadsheetApp.openById(HUB_DEFAULT_SOURCE_ID).getSheetByName('daily_routes'),first=token.row-count,last=sheet.getLastRow();
  if(first<2||first+total-1>last)return result;
  result.meta.fast={first:first,total:total,last:last,sheetId:sheet.getSheetId()};
  return result;
}
function hubPeriodReadBounded_(bounds,offset,limit){
  const sheet=SpreadsheetApp.openById(HUB_DEFAULT_SOURCE_ID).getSheetByName('daily_routes');
  if(!sheet||sheet.getSheetId()!==bounds.sheetId||sheet.getLastRow()!==bounds.last)hubMapHttpRaise_('PERIOD_SOURCE_INCOMPLETE','Source row positions changed.',502,false);
  if(!Number.isInteger(bounds.first)||bounds.first<2||!Number.isInteger(bounds.total)||bounds.total<0||bounds.first+bounds.total-1>bounds.last||offset<0||offset>=bounds.total)hubMapHttpRaise_('INVALID_CURSOR','Invalid bounded source cursor.',400,false);
  const count=Math.min(limit,bounds.total-offset),start=bounds.first+offset,columns=sheet.getLastColumn();
  if(columns<1||columns>128)throw new Error('PERIOD_HEADER_INVALID');
  const headers=sheet.getRange(1,1,1,columns).getValues()[0].map(String);
  const names=['deliveryDate','confirmedVehicle','baseVehicle','driverName','driverPhone','deliveryArea','customerCode','customerName','customerAddress','hashKey'];
  if(names.some(function(k){return headers.indexOf(k)<0;}))throw new Error('PERIOD_HEADER_INVALID');
  const indexes=names.map(function(k){return headers.indexOf(k);}).sort(function(a,b){return a-b;}),groups=[];
  indexes.forEach(function(c){const g=groups[groups.length-1];if(g&&g.end===c)g.end=c+1;else groups.push({start:c,end:c+1});});
  const filters=groups.map(function(g){return{gridRange:{sheetId:bounds.sheetId,startRowIndex:start-1,endRowIndex:start+count-1,startColumnIndex:g.start,endColumnIndex:g.end}};});
  const response=UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'+HUB_DEFAULT_SOURCE_ID+'/values:batchGetByDataFilter',{
    method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true,
    payload:JSON.stringify({dataFilters:filters,majorDimension:'ROWS',valueRenderOption:'FORMATTED_VALUE'})});
  if(response.getResponseCode()!==200)hubMapHttpRaise_('PERIOD_SOURCE_INCOMPLETE','Bounded Sheets read failed.',502,false);
  let body;try{body=JSON.parse(response.getContentText());}catch(ignored){hubMapHttpRaise_('PERIOD_SOURCE_INCOMPLETE','Bounded Sheets JSON invalid.',502,false);}
  if(!body||!Array.isArray(body.valueRanges)||body.valueRanges.length!==groups.length)hubMapHttpRaise_('PERIOD_SOURCE_INCOMPLETE','Bounded Sheets ranges incomplete.',502,false);
  const rows=Array.from({length:count},function(){return{};}),seen=new Set();
  body.valueRanges.forEach(function(item){
    const grid=item.dataFilters&&item.dataFilters.length===1&&item.dataFilters[0].gridRange;
    const group=grid&&groups.find(function(g){return(g.start===(grid.startColumnIndex||0))&&g.end===grid.endColumnIndex;});
    if(!group||grid.sheetId!==bounds.sheetId||grid.startRowIndex!==start-1||grid.endRowIndex!==start+count-1||seen.has(group.start))throw new Error('PERIOD_RANGE_INVALID');
    seen.add(group.start);const values=item.valueRange&&item.valueRange.values||[];
    if(values.length>count)throw new Error('PERIOD_RANGE_INVALID');
    for(let i=0;i<count;i++)for(let c=group.start;c<group.end;c++)rows[i][headers[c]]=values[i]&&values[i][c-group.start]||'';
  });
  rows.forEach(function(row){row.deliveryDate=hubStaffHistoryDate_(row.deliveryDate);});
  return{ok:true,data:rows,meta:{total:bounds.total,returned:rows.length,nextToken:offset+rows.length<bounds.total?'BOUNDED_ROWS':null,fast:bounds,source:'Current'}};
}
