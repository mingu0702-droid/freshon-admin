/**
 * Stage-only read facade. Reuses HubDataLayer -> CustomerDataApi nextToken.
 * No data/trigger/index writes; deployed as a separate immutable web app version.
 */
function hubDatedAssignmentsPage_(params) {
  hubMapHttpValidateOnlyKeys_(params, ['date', 'limit', 'cursor']);
  const date = hubMapHttpDate_(params.date, 'date');
  const limit = hubMapHttpLimit_(params.limit, 1000, 1000);
  let cursor = null;
  if (params.cursor) {
    try {
      const text = hubMapHttpText_(params.cursor, 'cursor', 2000);
      cursor = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(text)).getDataAsString());
      if (cursor.v !== 1 || cursor.date !== date || cursor.limit !== limit || !cursor.nextToken ||
          !Number.isInteger(cursor.offset) || cursor.offset < 0 || !Number.isInteger(cursor.total) || cursor.total < 0) throw new Error('INVALID_CURSOR');
    } catch (error) { hubMapHttpRaise_('INVALID_CURSOR', 'Cursor does not match the requested date/page size.', 400, false); }
  }
  const request = {startDate: date, endDate: date, limit: limit};
  if (cursor) request.nextToken = cursor.nextToken;
  const source = getDailyRoutes(request);
  hubMapHttpRequireHubOk_(source, 'datedAssignments');
  const rows = hubMapHttpObjects_(source);
  const total = Number(source.meta && source.meta.total);
  const offset = cursor ? cursor.offset : 0;
  const nextToken = source.meta && source.meta.nextToken || null;
  if (!Number.isInteger(total) || total < 0 || rows.length > limit ||
      Number(source.meta.returned) !== rows.length || (cursor && cursor.total !== total) ||
      offset + rows.length > total || (!nextToken && offset + rows.length !== total) ||
      (nextToken && offset + rows.length >= total)) {
    hubMapHttpRaise_('DATED_SOURCE_COUNT_MISMATCH', 'Source count changed or a source page was incomplete.', 502, false);
  }
  const coords = rows.length ? hubMapPhase2BCoordinateMap_(rows.map(function (row) { return row.customerCode; })) : {};
  const data = rows.map(function (row) {
    const rowDate = hubMapHttpDateOrNull_(row.deliveryDate);
    if (rowDate !== date) hubMapHttpRaise_('DATED_SOURCE_DATE_MISMATCH', 'Source returned a different delivery date.', 502, false);
    const code = String(row.customerCode || '').trim();
    const vehicle = String(row.confirmedVehicle || row.baseVehicle || '').trim();
    if (!code) hubMapHttpRaise_('DATED_SOURCE_IDENTITY_MISSING', 'Source customer identity is missing.', 502, false);
    const point = coords[code] || {};
    const lat = hubMapPhase2BNumber_(row.latitude || row.lat || point.lat);
    const lng = hubMapPhase2BNumber_(row.longitude || row.lng || point.lng);
    const located = hubMapPhase2BValidCoordinate_(lat, lng);
    return {customerCode: code, customerName: row.customerName || '', vehicle: vehicle,
      confirmedVehicle: vehicle, deliveryDate: date, lastDeliveryDate: date,
      sourceKey: String(row.hashKey || [date, code, vehicle].join('|')),
      address: row.customerAddress || row.address || '', deliveryArea: row.deliveryArea || '',
      lat: located ? lat : null, lng: located ? lng : null};
  });
  const hasMore = Boolean(nextToken);
  const nextCursor = hasMore ? Utilities.base64EncodeWebSafe(JSON.stringify({v: 1, date: date, limit: limit,
    nextToken: nextToken, offset: offset + rows.length, total: total})) : null;
  return {data: data, cached: false, meta: {contract: 'dated-assignments-v1', date: date,
    source: 'HubDataLayer.getDailyRoutes -> CustomerDataApi.daily_routes',
    sourceCount: total, totalCount: total, pageOffset: offset, count: data.length,
    pageSize: limit, hasMore: hasMore, nextCursor: nextCursor, complete: !hasMore, truncated: false,
    missingCoordinate: data.filter(function (row) { return row.lat == null || row.lng == null; }).length,
    sourceRangeTotal: total, sourceNextToken: nextToken ? 'PRESENT' : 'NONE'}};
}
