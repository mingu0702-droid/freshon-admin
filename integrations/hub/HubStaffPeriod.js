/**
 * Stage-only bounded read facade over the existing Customer range/nextToken contract.
 * No collector, spreadsheet mutation, trigger, or index rebuild.
 */
function hubPeriodAssignmentsPage_(params) {
  return hubStaffPeriodPage_(params, false);
}
function hubStaffDriverHistoryPage_(params) {
  try{return hubStaffPeriodPage_(params, true);}catch(error){
    if(error.safeCode)throw error;
    const code=String(error.message||'');
    if(['HISTORY_SOURCE_CHANGED','HISTORY_LOCATOR_CHANGED'].indexOf(code)>=0)hubMapHttpRaise_('PERIOD_SOURCE_CHANGED','Historical source changed.',409,true);
    if(['HISTORY_HEADER_INVALID','HISTORY_DATE_INVALID'].indexOf(code)>=0)hubMapHttpRaise_('PERIOD_ROW_INVALID','Historical source schema is invalid.',422,false);
    if(code==='HISTORY_BATCH_INCOMPLETE')hubMapHttpRaise_('PERIOD_SOURCE_INCOMPLETE','Historical read is incomplete.',409,true);
    hubMapHttpRaise_('HISTORY_SOURCE_ERROR',/^HISTORY_[A-Z_0-9]+$/.test(String(error.message||''))?error.message:'HISTORY_SOURCE_FAILED',502,false);
  }
}
function hubStaffPeriodPage_(params, privateHistory) {
  hubMapHttpValidateOnlyKeys_(params, ['startDate', 'endDate', 'customerCode', 'limit', 'cursor']);
  const start = hubMapHttpDate_(params.startDate, 'startDate'), end = hubMapHttpDate_(params.endDate, 'endDate');
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (days < 0 || days > 89) hubMapHttpRaise_('INVALID_RANGE', 'Range must be 1 to 90 days.', 400, false);
  const code = privateHistory ? hubMapHttpCustomerCode_(params.customerCode) : '';
  if (!privateHistory && params.customerCode) hubMapHttpRaise_('INVALID_PARAMS', 'Customer filter belongs to private history.', 400, false);
  const limit = hubMapHttpLimit_(params.limit, privateHistory ? 200 : 1000, privateHistory ? 200 : 1000);
  let cursor = null;
  if (params.cursor) {
    try {
      // This encoded envelope is longer than the shared 200-character text limit.
      // Keep the exception local to this read-only cursor, not global validation.
      if (typeof params.cursor !== 'string' || params.cursor.length > 3000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(params.cursor)) throw new Error('INVALID_CURSOR');
      cursor = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(params.cursor)).getDataAsString());
      if (cursor.v !== (privateHistory?1:2) || cursor.start !== start || cursor.end !== end || cursor.code !== code || cursor.limit !== limit
          || !cursor.nextToken || !Number.isInteger(cursor.offset) || cursor.offset < 0 || !Number.isInteger(cursor.total)) throw new Error('INVALID_CURSOR');
      if(!privateHistory&&(!Number.isInteger(cursor.emitted)||cursor.emitted<0||cursor.emitted>cursor.offset))throw new Error('INVALID_CURSOR');
    } catch (_) { hubMapHttpRaise_('INVALID_CURSOR', 'Range cursor mismatch.', 400, false); }
  }
  const filters = {startDate: start, endDate: end, limit: limit};
  if (code) filters.customerCode = code;
  if (cursor) filters.nextToken = cursor.nextToken;
  // Bypass HubDataLayer's shared response cache for private contact history.
  let result, historyProfile=null;
  if(privateHistory){
    const source=hubStaffHistorySource_(code,start,end),offset=cursor?cursor.offset:0;
    if(offset>source.rows.length)hubMapHttpRaise_('INVALID_CURSOR','History cursor changed.',400,false);
    const data=source.rows.slice(offset,offset+limit);historyProfile=source.profile;
    result={ok:true,data:data,meta:{total:source.rows.length,returned:data.length,nextToken:offset+data.length<source.rows.length?'CUSTOMER_ROWS':null}};
  }else result=hubPeriodSourcePage_(filters,cursor); // Never cache unredacted source pages.
  hubMapHttpRequireHubOk_(result, 'periodAssignments');
  const rows = hubMapHttpObjects_(result), meta = result.meta || {};
  const total = Number(meta.total), offset = cursor ? cursor.offset : 0, next = meta.nextToken || null;
  if (!Number.isInteger(total) || total < 0 || rows.length > limit || Number(meta.returned) !== rows.length
      || (cursor && cursor.total !== total) || offset + rows.length > total
      || (!next && offset + rows.length !== total) || (next && offset + rows.length >= total)) {
    hubMapHttpRaise_('PERIOD_SOURCE_INCOMPLETE', 'Source changed or page was incomplete.', 502, false);
  }
  const identitySecret = PropertiesService.getScriptProperties().getProperty(HUB_MAP_HTTP_API.SECRET_PROPERTY);
  const identities={};
  // The legacy date index returns the bounding envelope of physical rows. Recovery
  // appends can interleave older dates inside that envelope; filter actual dates.
  // Cursor progress counts ALL source rows, while returned totals count matches.
  const inRange=rows.filter(function(row){
    const date=hubMapHttpDateOrNull_(row.deliveryDate);
    if(!date)hubMapHttpRaise_('PERIOD_ROW_INVALID','Source date is invalid.',502,false);
    return date>=start&&date<=end;
  });
  const data = inRange.map(function(row) {
    const date = hubMapHttpDateOrNull_(row.deliveryDate), customer = String(row.customerCode || '').trim();
    if (!customer || !date || date < start || date > end || (code && code !== customer)) hubMapHttpRaise_('PERIOD_ROW_INVALID', 'Source identity mismatch.', 502, false);
    const vehicle = String(row.confirmedVehicle || row.baseVehicle || '').replace(/호(?:차)?$/, '');
    const name = String(row.driverName || '').trim(), phone = String(row.driverPhone || '').trim();
    const identity = name ? [name, phone || 'UNVERIFIED_VEHICLE_' + vehicle].join('|') : '';
    const driverKey = identity ? (identities[identity]||(identities[identity]=Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(identity, identitySecret)).replace(/=+$/, ''))) : '';
    const record = {customerCode: customer, customerName: row.customerName || '', address: row.customerAddress || '',
      vehicle: vehicle, deliveryDate: date, lastDeliveryDate: date, sourceKey: String(row.hashKey || [date, customer, vehicle].join('|')),
      driverName: name, driverKey: driverKey, driverIdentity: phone ? 'NAME_CONTACT' : 'UNVERIFIED',
      area: row.deliveryArea || '', center: row.center || '', kind: 'ASSIGNED'};
    // daily_routes is an assignment source; it does NOT certify actual visits.
    if (privateHistory) return {customerCode: customer, deliveryDate: date, vehicle: vehicle,
      driverName: name || null, driverPhone: phone || null, kind: 'ASSIGNED', sourceKey: record.sourceKey};
    return record;
  });
  const hasMore = Boolean(next);
  const emitted=privateHistory?offset:(cursor?cursor.emitted:0),matchedTotal=privateHistory?total:(hasMore?null:emitted+data.length);
  return {data: data, cached: false, meta: {contract: privateHistory ? 'staff-driver-history-v1' : 'period-assignments-v2',
    startDate: start, endDate: end, customerCode: code, totalCount: matchedTotal, sourceCount: matchedTotal,
    sourceOffset:offset,sourceReadCount:rows.length,sourceTotal:total,scannedCount:offset+rows.length,
    pageOffset: emitted, count: data.length, pageSize: limit, hasMore: hasMore, complete: !hasMore, truncated: false,
    nextCursor: hasMore ? Utilities.base64EncodeWebSafe(JSON.stringify({v: privateHistory?1:2, start: start, end: end, code: code, limit: limit,
      nextToken: next, offset: offset + rows.length, emitted:emitted+data.length,total: total,fast:meta.fast||null})) : null,
    source: 'Customer.daily_routes assignment history', historyProfile:historyProfile, actualVisitsAvailable: false}};
}
