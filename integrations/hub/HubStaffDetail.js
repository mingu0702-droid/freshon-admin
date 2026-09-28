/** Private one-customer read. No Customer/Archive writes or memo cache. */
const HUB_STAFF_DETAIL_ARCHIVE = '1qsDxyjlNNUeT990VxrsfWfiBC6Q2h_7u2DL8E-Z6Xwg';
// Editor-only bounded diagnostic. Discard private data; log only timings/code.
function hubProductionPrivateDetailDiagnostic(){
  ['S99731','S222538'].forEach(function(code){
    const started=Date.now();
    try{
      const result=hubStaffCustomerDetail_({customerCode:code,date:'2026-09-19'}),p=result.meta.detailProfile;
      console.log(JSON.stringify({component:'private-source-diagnostic',customerCode:code,date:'2026-09-19',status:'FOUND',durationMs:Date.now()-started,openMs:p.openMs,lookupMs:p.lookupMs,rowReadMs:p.rowReadMs,sourceRowReads:p.sourceRowReads,metadataHit:p.metadataHit,candidateReads:p.candidateReads}));
    }catch(e){console.log(JSON.stringify({component:'private-source-diagnostic',customerCode:code,date:'2026-09-19',status:'ERROR',durationMs:Date.now()-started,code:/^[A-Z_]+$/.test(e.safeCode||'')?e.safeCode:'PRIVATE_LOOKUP_FAILED'}));}
  });
}
function hubStaffCustomerDetail_(params) {
  hubMapHttpValidateOnlyKeys_(params, ['customerCode','date']);
  const code=hubMapHttpCustomerCode_(params.customerCode),date=hubMapHttpDate_(params.date,'date');
  const profile={openMs:0,lookupMs:0,rowReadMs:0,normalizeMs:0,metadataHit:false,sourceRowReads:0,candidateReads:0};
  const sources=[{id:HUB_DEFAULT_SOURCE_ID,name:'Customer.daily_routes'},{id:HUB_STAFF_DETAIL_ARCHIVE,name:'Archive.daily_routes'}];
  for(let i=0;i<sources.length;i++){
    const started=Date.now(),ss=SpreadsheetApp.openById(sources[i].id),sheet=ss.getSheetByName('daily_routes');
    profile.openMs+=Date.now()-started;if(!sheet||sheet.getLastRow()<2)continue;
    const row=hubStaffDetailRow_(sheet,code,date,profile);if(!row)continue;
    const normalizeAt=Date.now(),data={customerCode:code,customerName:String(row.customerName||''),customerAddress:String(row.customerAddress||''),accessMemo:String(row.accessMemo||''),confirmedVehicle:String(row.confirmedVehicle||'')};
    profile.normalizeMs+=Date.now()-normalizeAt;
    return {data:data,cached:false,meta:{detailProfile:profile,source:sources[i].name,privateCache:'NONE'}};
  }
  hubMapHttpRaise_('NOT_FOUND','Customer was not found on the requested date.',404,false);
}
function hubStaffDetailDate_(value){
  return Object.prototype.toString.call(value)==='[object Date]'?Utilities.formatDate(value,'Asia/Seoul','yyyy-MM-dd'):String(value||'').trim().slice(0,10);
}
function hubStaffDetailRow_(sheet,code,date,profile){
  const lookupAt=Date.now(),last=sheet.getLastRow(),columns=sheet.getLastColumn();
  if(columns<1||columns>128)throw new Error('PRIVATE_SOURCE_HEADER_INVALID');
  const headers=sheet.getRange(1,1,1,columns).getValues()[0],codeColumn=headers.indexOf('customerCode')+1,dateColumn=headers.indexOf('deliveryDate')+1;
  if(!codeColumn||!dateColumn||headers.indexOf('accessMemo')<0)throw new Error('PRIVATE_SOURCE_HEADER_INVALID');
  const key=['staff_row_v2',sheet.getParent().getId(),sheet.getSheetId(),columns,date,code].join('|');
  const cache=CacheService.getScriptCache();let cached=null;
  try{cached=JSON.parse(cache.get(key)||'null');}catch(ignored){}
  function read(rowNumber){
    const at=Date.now(),values=sheet.getRange(rowNumber,1,1,columns).getValues()[0];
    profile.rowReadMs+=Date.now()-at;profile.sourceRowReads++;
    // Always validate fresh source values, including after Current/Archive moves.
    if(String(values[codeColumn-1]||'').trim()!==code||hubStaffDetailDate_(values[dateColumn-1])!==date)return null;
    const obj={};headers.forEach(function(header,index){obj[String(header)]=values[index];});return obj;
  }
  if(cached&&Number.isInteger(cached.row)&&cached.row>=2&&cached.row<=last){
    const row=read(cached.row);if(row){profile.metadataHit=true;profile.lookupMs+=Math.max(0,Date.now()-lookupAt-profile.rowReadMs);return row;}cache.remove(key);
  }
  const candidates=sheet.getRange(2,codeColumn,last-1,1).createTextFinder(code).matchEntireCell(true).useRegularExpression(false).findAll().map(function(cell){return cell.getRow();}).sort(function(a,b){return b-a;});
  if(candidates.length>100)throw new Error('PRIVATE_LOOKUP_AMBIGUOUS');
  // One bounded request for key/date only; do not perform up to 100 RPCs.
  const selected=candidates.length?hubStaffHistoryBatchRead_(sheet.getParent().getId(),sheet.getSheetId(),headers,candidates,['deliveryDate','customerCode']):[];
  if(selected.length!==candidates.length)throw new Error('PRIVATE_LOOKUP_INCOMPLETE');
  profile.candidateReads=(profile.candidateReads||0)+(candidates.length?1:0);
  profile.lookupMs+=Math.max(0,Date.now()-lookupAt-profile.rowReadMs);
  for(let i=0;i<candidates.length;i++){
    if(String(selected[i].customerCode||'').trim()!==code||hubStaffHistoryDate_(selected[i].deliveryDate)!==date)continue;
    const row=read(candidates[i]);if(row){cache.put(key,JSON.stringify({row:candidates[i]}),600);return row;}
  }
  return null;
}
