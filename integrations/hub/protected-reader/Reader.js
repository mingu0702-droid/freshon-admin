// Standalone, selected-customer read adapter. Sources and secret are Script Properties.
// HTTP validation/HMAC and the row-locator implementation are copied from verified v64/R7.
var protectedReaderProfile_;
function doGet(){return hubMapHttpJson_(hubMapHttpFailure_('UNAUTHORIZED','Authentication is required.',false,'',Date.now(),401));}
function doPost(e){
  const started=Date.now();let request=null;
  protectedReaderProfile_={openMs:0,lookupMs:0,rowReadMs:0,normalizeMs:0,metadataHit:false,sourceRowReads:0,candidateReads:0,readStartedAt:started};
  try{
    request=hubMapHttpParseRequest_(e);hubMapHttpValidateEnvelope_(request);
    const lock=LockService.getScriptLock();if(!lock.tryLock(1000))hubMapHttpRaise_('RATE_LIMITED','Please retry later.',429,true);
    try{hubMapHttpAuthenticate_(request);hubMapHttpRateLimit_();}finally{lock.releaseLock();}
    if(request.action!=='customerDetail'&&request.action!=='staffCustomerDetail'&&request.action!=='customerSearch'&&request.action!=='customerRegistry')hubMapHttpRaise_('INVALID_ACTION','This read action is not supported.',404,false);
    let result;
    if(request.action==='customerRegistry'){hubMapHttpValidateOnlyKeys_(request.params,['afterVersion','cursor','limit']);result={data:protectedReaderRegistry_(request.params),cached:false};}
    else if(request.action==='customerSearch'){hubMapHttpValidateOnlyKeys_(request.params,['q','limit']);result={data:protectedReaderSearch_(request.params),cached:false};}
    else if(request.action==='customerDetail'){hubMapHttpValidateOnlyKeys_(request.params,['customerCode','date']);result=hubMapHttpHandleCustomerDetail_(request.params);}
    else{
      hubMapHttpValidateOnlyKeys_(request.params,['customerCode','date']);
      const code=hubMapHttpCustomerCode_(request.params.customerCode),date=hubMapHttpDate_(request.params.date,'date');
      const row=getDailyRoutes({customerCode:code,startDate:date,endDate:date,limit:1}).data[0];
      result={data:row,cached:false};
    }
    return hubMapHttpJson_(hubMapHttpSuccess_(result.data,request.requestId,started,false,200,{detailProfile:protectedReaderProfile_,sourceBasis:request.params.date?'DATED_CUSTOMER_LOOKUP':'CURRENT_CUSTOMER_LOOKUP',detailDate:request.params.date||null,privateCache:'NONE'}));
  }catch(error){
    const safe=hubMapHttpSafeError_(error);
    const response=hubMapHttpFailure_(safe.code,safe.message,safe.retryable,request&&request.requestId||'',started,safe.httpStatus);
    response.meta.sourceErrorCode=/^[A-Z][A-Z0-9_]{2,80}$/.test(String(error.message||''))?error.message:error.name==='ReferenceError'?'READ_DEPENDENCY_REFERENCE_ERROR':'READ_SOURCE_EXECUTION_ERROR';
    response.meta.detailProfile=protectedReaderProfile_;return hubMapHttpJson_(response);
  }finally{protectedReaderProfile_=null;}
}
function protectedReaderSource_(archive,dateFilter){
  const id=PropertiesService.getScriptProperties().getProperty(archive?'PROTECTED_ARCHIVE_ID':'PROTECTED_CUSTOMER_ID');
  if(!id)hubMapHttpRaise_('INTERNAL_ERROR','Read source is not configured.',503,false);
  const at=Date.now(),book=protectedReaderReadOnlyBook_(id,dateFilter);protectedReaderProfile_.openMs+=Date.now()-at;return book;
}
function protectedReaderObject_(headers,values){
  const row={};headers.forEach(function(h,i){row[String(h)]=values[i];});return row;
}
function protectedReaderProjection_(row){
  return {customerCode:String(row.customerCode||'').trim().toUpperCase(),customerName:String(row.customerName||''),customerAddress:String(row.customerAddress||''),detailAddress:String(row.detailAddress||''),accessMemo:String(row.accessMemo||''),confirmedVehicle:String(row.confirmedVehicle||''),baseVehicle:String(row.baseVehicle||''),deliveryDate:hubStaffHistoryDate_(row.deliveryDate),deliveryPattern:String(row.deliveryPattern||row.deliveryPatternText||'')};
}
function getCustomers(params){
  const code=hubMapHttpCustomerCode_(params.customerCode),book=protectedReaderSource_(false),sheet=book.getSheetByName('customers');
  if(!sheet)hubMapHttpRaise_('INTERNAL_ERROR','Customer source is unavailable.',503,false);
  const last=sheet.getLastRow(),columns=sheet.getLastColumn(),headers=sheet.getRange(1,1,1,columns).getValues()[0],column=headers.indexOf('customerCode')+1;
  if(!column||headers.indexOf('updatedAt')<0||columns>128)hubMapHttpRaise_('INTERNAL_ERROR','Customer source contract is invalid.',502,false);
  if(last<2)return {ok:true,data:[]};
  const at=Date.now(),matches=sheet.getRange(2,column,last-1,1).createTextFinder(code).matchEntireCell(true).useRegularExpression(false).findAll();
  protectedReaderProfile_.lookupMs+=Date.now()-at;if(matches.length>100)hubMapHttpRaise_('QUERY_LIMIT_EXCEEDED','Customer source needs review.',409,false);
  const rows=matches.map(function(cell){const begin=Date.now(),row=protectedReaderObject_(headers,sheet.getRange(cell.getRow(),1,1,columns).getValues()[0]);protectedReaderProfile_.rowReadMs+=Date.now()-begin;protectedReaderProfile_.sourceRowReads++;if(String(row.customerCode||'').trim().toUpperCase()!==code)hubMapHttpRaise_('INTERNAL_ERROR','Customer identity changed.',409,false);const t=new Date(row.updatedAt).getTime();if(!isFinite(t))hubMapHttpRaise_('INTERNAL_ERROR','Customer revision is unconfirmed.',409,false);return {row:row,time:t};});
  if(!rows.length)return {ok:true,data:[]};const newest=Math.max.apply(null,rows.map(function(r){return r.time;})),selected=rows.filter(function(r){return r.time===newest;});
  const value=protectedReaderProjection_(selected[0].row),signature=JSON.stringify(value);
  if(selected.some(function(r){return JSON.stringify(protectedReaderProjection_(r.row))!==signature;}))hubMapHttpRaise_('INTERNAL_ERROR','Customer source has conflicting current values.',409,false);
  return {ok:true,data:[value]};
}
function getDailyRoutes(params){
  const code=hubMapHttpCustomerCode_(params.customerCode),date=hubMapHttpDate_(params.startDate,'date');
  if(params.endDate!==date||params.limit!==1)hubMapHttpRaise_('INVALID_PARAMS','An exact date and customer are required.',400,false);
  for(let archive=0;archive<2;archive++){
    const book=protectedReaderSource_(archive===1,date),sheet=book.getSheetByName('daily_routes');if(!sheet||sheet.getLastRow()<2)continue;
    const row=hubStaffDetailRow_(sheet,code,date,protectedReaderProfile_);if(!row)continue;
    const value=protectedReaderProjection_(row);if(value.customerCode!==code||value.deliveryDate!==date)hubMapHttpRaise_('INTERNAL_ERROR','Selected customer or date did not match.',409,false);
    return {ok:true,data:[value]};
  }
  hubMapHttpRaise_('NOT_FOUND','Customer was not found on the requested date.',404,false);
}
