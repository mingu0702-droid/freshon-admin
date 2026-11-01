// LOCAL ONLY. Additional single-function scope; NOT included in the approved three-function package.
// No source write, trigger change, plaintext cache, retry on transport error or timeout increase.
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
  // Reuse the existing history locator cache. It contains row numbers only.
  const positionsKey=hubDataCacheKey_("staff_history_positions_v1",{id:sheet.getParent().getId(),sheet:sheet.getSheetId(),last:last,columns:columns,code:code});
  let positions=null;try{positions=JSON.parse(cache.get(positionsKey)||'null');}catch(ignored){}
  let fromIndex=Array.isArray(positions)&&positions.length<=100&&positions.every(function(n){return Number.isInteger(n)&&n>=2&&n<=last;});
  for(let pass=0;pass<2;pass++){
    if(!fromIndex){
      positions=sheet.getRange(2,codeColumn,last-1,1).createTextFinder(code).matchEntireCell(true).useRegularExpression(false).findAll().map(function(cell){return cell.getRow();});
      if(positions.length>100)throw new Error('HUB_STAFF_DETAIL_LOOKUP_LIMIT');
      try{cache.put(positionsKey,JSON.stringify(positions),300);}catch(ignored){}
    }else profile.candidateIndexHit=true;
    const candidates=positions.slice().sort(function(a,b){return b-a;});
    const selected=candidates.length?hubStaffHistoryBatchRead_(sheet.getParent().getId(),sheet.getSheetId(),headers,candidates,['customerCode','deliveryDate']):[];
    if(selected.length!==candidates.length)throw new Error('HUB_STAFF_DETAIL_KEYS');
    profile.candidateReads=(profile.candidateReads||0)+(candidates.length?1:0);
    for(let i=0;i<candidates.length;i++){
      if(String(selected[i].customerCode||'').trim()!==code||hubStaffHistoryDate_(selected[i].deliveryDate)!==date)continue;
      const row=read(candidates[i]);if(row){
        profile.lookupMs+=Math.max(0,Date.now()-lookupAt-profile.rowReadMs);
        cache.put(key,JSON.stringify({row:candidates[i]}),600);return row;
      }
    }
    // A cached index cannot prove absence after an in-place source edit.
    cache.remove(positionsKey);if(!fromIndex)break;fromIndex=false;
  }
  profile.lookupMs+=Math.max(0,Date.now()-lookupAt-profile.rowReadMs);
  return null;
}
