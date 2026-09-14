/** Stage read-only Delivery task history. No writes, triggers or response cache. */
function hubDeliveryHistorySource_(code,start,end) {
  const rows=[], profile={readMs:0,lookupMs:0,sourceRows:0}, seen={};
  [HUB_DEFAULT_SOURCE_ID,HUB_STAFF_DETAIL_ARCHIVE].forEach(function(id){
    const at=Date.now(), file=DriveApp.getFileById(id), version=file.getLastUpdated().getTime();
    const sheet=SpreadsheetApp.openById(id).getSheetByName('delivery_admin_raw');
    if(!sheet){if(id===HUB_DEFAULT_SOURCE_ID)throw new Error('HISTORY_SOURCE_MISSING');return;}
    const last=sheet.getLastRow(), width=sheet.getLastColumn();
    if(width<1||width>128)throw new Error('HISTORY_HEADER_INVALID');
    const headers=sheet.getRange(1,1,1,width).getValues()[0].map(String);
    const wanted=['sourceSystem','deliveryDate','deliveryId','customerCode','confirmedVehicle','driverName','driverPhone','deliveryStatus','importKey','rawHash'];
    if(wanted.some(function(k){return headers.indexOf(k)<0;}))throw new Error('HISTORY_HEADER_INVALID');
    if(last<2)return;
    // Server-side exact column search, never a whole RAW download. Positions are
    // intentionally NOT cached while collection/archive can move physical rows.
    const positions=sheet.getRange(2,headers.indexOf('customerCode')+1,last-1,1).createTextFinder(code)
      .matchEntireCell(true).useRegularExpression(false).findAll().map(function(cell){return cell.getRow();});
    if(positions.length>2000)throw new Error('HISTORY_CUSTOMER_CAPACITY');
    profile.lookupMs+=Date.now()-at;
    const readAt=Date.now(), values=hubStaffHistoryBatchRead_(id,sheet.getSheetId(),headers,positions,wanted);
    profile.readMs+=Date.now()-readAt;profile.sourceRows+=values.length;
    if(sheet.getLastRow()!==last||DriveApp.getFileById(id).getLastUpdated().getTime()!==version)throw new Error('HISTORY_SOURCE_CHANGED');
    values.forEach(function(row){
      const date=hubStaffHistoryDate_(row.deliveryDate), task=String(row.deliveryId||'').trim();
      if(String(row.customerCode||'').trim()!==code)throw new Error('HISTORY_LOCATOR_CHANGED');
      if(!date)throw new Error('HISTORY_DATE_INVALID');
      if(date<start||date>end)return;
      if(row.sourceSystem!=='delivery_admin'||!task||String(row.importKey)!==['delivery_admin',date,task].join('|')||!row.rawHash)throw new Error('HISTORY_BATCH_INCOMPLETE');
      const identity=JSON.stringify([code,date,task]);
      if(seen[identity]){if(seen[identity]!==String(row.rawHash))throw new Error('HISTORY_SOURCE_CHANGED');return;}
      seen[identity]=String(row.rawHash);
      rows.push({customerCode:code,deliveryDate:date,deliveryId:task,confirmedVehicle:String(row.confirmedVehicle||''),
        driverName:String(row.driverName||''),driverPhone:String(row.driverPhone||''),
        deliveryStatus:String(row.deliveryStatus||''),hashKey:identity});
    });
  });
  rows.sort(function(a,b){return b.deliveryDate.localeCompare(a.deliveryDate)||a.deliveryId.localeCompare(b.deliveryId);});
  return {rows:rows,profile:profile};
}
