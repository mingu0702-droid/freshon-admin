/**
 * Stage-only bounded read facade over the existing Customer range/nextToken contract.
 * No collector, spreadsheet mutation, trigger, or index rebuild.
 */
function hubPeriodAssignmentsPage_(params) {
  return hubStaffPeriodPage_(params, false);
}
function hubStaffDriverHistoryPage_(params) {
  return hubStaffPeriodPage_(params, true);
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
      cursor = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(hubMapHttpText_(params.cursor, 'cursor', 3000))).getDataAsString());
      if (cursor.v !== 1 || cursor.start !== start || cursor.end !== end || cursor.code !== code || cursor.limit !== limit
          || !cursor.nextToken || !Number.isInteger(cursor.offset) || cursor.offset < 0 || !Number.isInteger(cursor.total)) throw new Error('INVALID_CURSOR');
    } catch (_) { hubMapHttpRaise_('INVALID_CURSOR', 'Range cursor mismatch.', 400, false); }
  }
  const filters = {startDate: start, endDate: end, limit: limit};
  if (code) filters.customerCode = code;
  if (cursor) filters.nextToken = cursor.nextToken;
  // Bypass HubDataLayer's shared response cache for private contact history.
  const result = privateHistory ? CustomerDataApi.getDailyRoutes(filters) : getDailyRoutes(filters);
  hubMapHttpRequireHubOk_(result, 'periodAssignments');
  const rows = hubMapHttpObjects_(result), meta = result.meta || {};
  const total = Number(meta.total), offset = cursor ? cursor.offset : 0, next = meta.nextToken || null;
  if (!Number.isInteger(total) || total < 0 || rows.length > limit || Number(meta.returned) !== rows.length
      || (cursor && cursor.total !== total) || offset + rows.length > total
      || (!next && offset + rows.length !== total) || (next && offset + rows.length >= total)) {
    hubMapHttpRaise_('PERIOD_SOURCE_INCOMPLETE', 'Source changed or page was incomplete.', 502, false);
  }
  const identitySecret = PropertiesService.getScriptProperties().getProperty(HUB_MAP_HTTP_API.SECRET_PROPERTY);
  const data = rows.map(function(row) {
    const date = hubMapHttpDateOrNull_(row.deliveryDate), customer = String(row.customerCode || '').trim();
    if (!customer || !date || date < start || date > end || (code && code !== customer)) hubMapHttpRaise_('PERIOD_ROW_INVALID', 'Source identity mismatch.', 502, false);
    const vehicle = String(row.confirmedVehicle || row.baseVehicle || '').replace(/호(?:차)?$/, '');
    const name = String(row.driverName || '').trim(), phone = String(row.driverPhone || '').trim();
    const identity = name ? [name, phone || 'UNVERIFIED_VEHICLE_' + vehicle].join('|') : '';
    const driverKey = identity ? Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(identity, identitySecret)).replace(/=+$/, '') : '';
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
  return {data: data, cached: false, meta: {contract: privateHistory ? 'staff-driver-history-v1' : 'period-assignments-v1',
    startDate: start, endDate: end, customerCode: code, totalCount: total, sourceCount: total,
    pageOffset: offset, count: data.length, pageSize: limit, hasMore: hasMore, complete: !hasMore, truncated: false,
    nextCursor: hasMore ? Utilities.base64EncodeWebSafe(JSON.stringify({v: 1, start: start, end: end, code: code, limit: limit,
      nextToken: next, offset: offset + rows.length, total: total})) : null,
    source: 'Customer.daily_routes assignment history', actualVisitsAvailable: false}};
}
