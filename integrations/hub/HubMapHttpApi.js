/**
 * Read-only HTTP facade for the operations map.
 * This file does not write spreadsheet data and never exposes raw Hub responses.
 */
const HUB_MAP_HTTP_API = Object.freeze({
  VERSION: 'map-phase2-v1',
  SOURCE: 'hub',
  SERVICE: 'hub-map-api',
  SECRET_PROPERTY: 'HUB_MAP_API_HMAC_SECRET',
  MAX_REQUEST_BYTES: 32768,
  MAX_STRING_LENGTH: 200,
  MAX_SEARCH_LIMIT: 50,
  MAX_ROUTE_LIMIT: 500,
  MAX_MAP_LIMIT: 500,
  MAX_BOUNDS_LAT_SPAN: 5,
  MAX_BOUNDS_LNG_SPAN: 5,
  MAX_CLOCK_SKEW_MS: 300000,
  NONCE_TTL_SECONDS: 600,
  RATE_LIMIT_PER_MINUTE: 120,
  CACHE_MAX_CHARS: 90000,
  SEARCH_EXACT_TTL_SECONDS: 300,
  SEARCH_TEXT_TTL_SECONDS: 90,
  ROUTE_TTL_SECONDS: 60,
  MAP_TTL_SECONDS: 120,
  MAP_PAGE_SIZE: 1000,
  MAP_MAX_PAGES: 20,
  MAP_MAX_SCANNED_ROWS: 10000,
  SOFT_DEADLINE_MS: 240000
});

/**
 * Public, unauthenticated liveness check. It never reads operational data.
 */
function doGet(e) {
  const startedAt = Date.now();
  const action = String(e && e.parameter && e.parameter.action || 'health');
  if (action !== 'health') {
    return hubMapHttpJson_(hubMapHttpFailure_(
      'INVALID_ACTION',
      'Only health is allowed for GET requests.',
      false,
      '',
      startedAt,
      404
    ));
  }
  return hubMapHttpJson_(hubMapHttpSuccess_(
    {service: HUB_MAP_HTTP_API.SERVICE, status: 'UP'},
    '',
    startedAt,
    false,
    200
  ));
}

/**
 * Authenticated JSON endpoint. Only explicitly registered read actions run.
 */
function doPost(e) {
  const startedAt = Date.now();
  let requestId = '';
  let action = '';
  try {
    const request = hubMapHttpParseRequest_(e);
    requestId = request.requestId;
    action = request.action;
    hubMapHttpValidateEnvelope_(request);
    hubMapHttpAuthenticate_(request);
    hubMapHttpRateLimit_();
    const handlers = {
      health: hubMapHttpHandleHealth_,
      customerSearch: hubMapHttpHandleCustomerSearch_,
      customerDetail: hubMapHttpHandleCustomerDetail_,
      routeStops: hubMapHttpHandleRouteStops_,
      mapBounds: hubMapHttpHandleMapBoundsDispatch_,
      unifiedSearch: hubMapPhase2BHandleUnifiedSearch_,
      nearestVehicles: hubMapPhase2BHandleNearestVehicles_,
      routePlan: hubMapPhase2BHandleRoutePlan_,
      datedAssignments: hubDatedAssignmentsPage_,
      periodAssignments: hubPeriodAssignmentsPage_,
      staffDriverHistory: hubStaffDriverHistoryPage_,
      stageReadModelRequest: hubStageModelRequest_,
      mapModelStatus: hubMapIncrementalStatus_,
      mapModelIncrementalRequest: hubMapIncrementalRequest_,
      mapBaseVehicles: hubMapBaseVehicleProjection_,
      staffCustomerDetail: hubStaffCustomerDetail_
    };
    const handler = handlers[action];
    if (!handler) hubMapHttpRaise_('INVALID_ACTION', 'The requested action is not available.', 404, false);
    const handled = handler(request.params, {startedAt: startedAt, requestId: requestId});
    const response = hubMapHttpSuccess_(
      handled.data,
      requestId,
      startedAt,
      handled.cached === true,
      200,
      handled.meta
    );
    hubMapHttpAudit_(requestId, action, response);
    return hubMapHttpJson_(response);
  } catch (error) {
    const safe = hubMapHttpSafeError_(error);
    const response = hubMapHttpFailure_(
      safe.code,
      safe.message,
      safe.retryable,
      requestId,
      startedAt,
      safe.httpStatus
    );
    hubMapHttpAudit_(requestId, action, response);
    return hubMapHttpJson_(response);
  }
}

function hubMapHttpHandleHealth_() {
  return {data: {service: HUB_MAP_HTTP_API.SERVICE, status: 'UP'}, cached: false};
}

function hubMapHttpHandleCustomerSearch_(params) {
  const startedAt = Date.now();
  hubMapHttpValidateOnlyKeys_(params, ['q', 'date', 'center', 'limit', 'cursor']);
  const q = hubMapHttpRequiredText_(params.q, 'q', 1, 100);
  const limit = hubMapHttpLimit_(params.limit, 20, HUB_MAP_HTTP_API.MAX_SEARCH_LIMIT);
  const exact = hubMapHttpLooksLikeCustomerCode_(q);
  const normalizedQ = exact ? q.toUpperCase() : q.toLowerCase();
  const cacheKey = hubMapHttpActionCacheKey_('customerSearch', {
    q: normalizedQ,
    date: params.date || '',
    center: params.center || '',
    limit: limit,
    cursor: params.cursor || ''
  });
  const cached = hubMapHttpCacheRead_(cacheKey);
  if (cached) return hubMapHttpCachedHandled_(cached, Date.now() - startedAt);

  const request = {limit: exact ? 1 : limit};
  if (exact) request.customerCode = q;
  else request.customerName = q;
  if (params.date != null && params.date !== '') {
    const date = hubMapHttpDate_(params.date, 'date');
    request.startDate = date;
    request.endDate = date;
  }
  if (params.center != null && params.center !== '') request.center = hubMapHttpText_(params.center, 'center', 100);
  if (params.cursor != null && params.cursor !== '') request.nextToken = hubMapHttpText_(params.cursor, 'cursor', 200);

  const response = getCustomers(request);
  hubMapHttpRequireHubOk_(response, 'customerSearch');
  const rows = hubMapHttpObjects_(response).slice(0, limit).map(hubMapHttpCustomerSummary_);
  const handled = {
    data: rows,
    cached: Boolean(response.meta && response.meta.cacheHit),
    meta: Object.assign(hubMapHttpPageMeta_(response, rows.length, limit), {
      upstreamCalls: 1,
      exactLookup: exact,
      upstreamDurationMs: Number(response.meta && response.meta.totalDurationMs || 0)
    })
  };
  hubMapHttpCacheWrite_(cacheKey, handled, exact ? HUB_MAP_HTTP_API.SEARCH_EXACT_TTL_SECONDS : HUB_MAP_HTTP_API.SEARCH_TEXT_TTL_SECONDS);
  return handled;
}

function hubMapHttpHandleCustomerDetail_(params) {
  hubMapHttpValidateOnlyKeys_(params, ['customerCode', 'date']);
  const customerCode = hubMapHttpCustomerCode_(params.customerCode);
  let date = '';
  if (params.date != null && params.date !== '') date = hubMapHttpDate_(params.date, 'date');
  const response = hubGetMapMarkerDetail(customerCode, date);
  hubMapHttpRequireHubOk_(response, 'customerDetail');
  const row = response.data || {};
  if (!row.customerName && !row.customerAddress && !row.confirmedVehicle) {
    hubMapHttpRaise_('NOT_FOUND', 'Customer was not found.', 404, false);
  }
  return {
    data: {
      customerCode: String(row.customerCode || customerCode),
      customerName: hubMapHttpNullableText_(row.customerName),
      customerAddress: hubMapHttpNullableText_(row.customerAddress),
      detailAddress: hubMapHttpNullableText_(row.detailAddress),
      accessMemo: hubMapHttpNullableText_(row.accessMemo),
      confirmedVehicle: hubMapHttpNullableText_(row.confirmedVehicle),
      driverName: hubMapHttpNullableText_(row.driverName),
      driverPhone: hubMapHttpNullableText_(row.driverPhone),
      area: hubMapHttpNullableText_(row.area),
      center: hubMapHttpNullableText_(row.center)
    },
    cached: false
  };
}

function hubMapHttpHandleRouteStops_(params) {
  const startedAt = Date.now();
  hubMapHttpValidateOnlyKeys_(params, ['date', 'vehicle', 'center', 'limit', 'cursor']);
  const date = hubMapHttpDate_(params.date, 'date');
  const vehicle = hubMapHttpVehicle_(params.vehicle);
  const limit = hubMapHttpLimit_(params.limit, 100, HUB_MAP_HTTP_API.MAX_ROUTE_LIMIT);
  const cacheKey = hubMapHttpActionCacheKey_('routeStops', {
    date: date,
    vehicle: vehicle,
    center: params.center || '',
    limit: limit,
    cursor: params.cursor || ''
  });
  const cached = hubMapHttpCacheRead_(cacheKey);
  if (cached) return hubMapHttpCachedHandled_(cached, Date.now() - startedAt);
  const request = {startDate: date, endDate: date, vehicle: vehicle, limit: limit};
  if (params.center != null && params.center !== '') request.center = hubMapHttpText_(params.center, 'center', 100);
  if (params.cursor != null && params.cursor !== '') request.nextToken = hubMapHttpText_(params.cursor, 'cursor', 200);
  const response = getDailyRoutes(request);
  hubMapHttpRequireHubOk_(response, 'routeStops');
  const rows = hubMapHttpObjects_(response).slice(0, limit).map(hubMapHttpRouteStop_);
  const handled = {
    data: rows,
    cached: Boolean(response.meta && response.meta.cacheHit),
    meta: Object.assign(hubMapHttpPageMeta_(response, rows.length, limit), {
      upstreamCalls: 1,
      nullStopOrderCount: rows.filter(function (row) { return row.sequence == null; }).length,
      upstreamDurationMs: Number(response.meta && response.meta.totalDurationMs || 0)
    })
  };
  hubMapHttpCacheWrite_(cacheKey, handled, HUB_MAP_HTTP_API.ROUTE_TTL_SECONDS);
  return handled;
}

function hubMapHttpHandleMapBoundsDispatch_(params, context) {
  if (params && params.mode) return hubMapPhase2BHandleMapBounds_(params, context);
  return hubMapHttpHandleMapBounds_(params, context);
}

function hubMapHttpHandleMapBounds_(params, context) {
  const startedAt = Date.now();
  hubMapHttpValidateOnlyKeys_(params, ['date', 'center', 'area', 'vehicle', 'bounds', 'limit', 'cursor']);
  const date = hubMapHttpDate_(params.date, 'date');
  const bounds = hubMapHttpBounds_(params.bounds);
  const limit = hubMapHttpLimit_(params.limit, 200, HUB_MAP_HTTP_API.MAX_MAP_LIMIT);
  const normalizedParams = {
    date: date,
    center: params.center || '',
    area: params.area || '',
    vehicle: params.vehicle ? hubMapHttpVehicle_(params.vehicle) : '',
    bounds: hubMapHttpNormalizedBounds_(bounds),
    limit: limit
  };
  const cacheKey = hubMapHttpActionCacheKey_('mapBounds', normalizedParams);
  const cached = hubMapHttpCacheRead_(cacheKey);
  if (cached) return hubMapHttpCachedHandled_(cached, Date.now() - startedAt);

  const request = {startDate: date, endDate: date, limit: HUB_MAP_HTTP_API.MAP_PAGE_SIZE};
  ['center', 'area', 'vehicle'].forEach(function (key) {
    if (normalizedParams[key]) request[key] = normalizedParams[key];
  });
  if (params.cursor != null && params.cursor !== '') request.nextToken = hubMapHttpText_(params.cursor, 'cursor', 200);

  const deadline = Number(context && context.startedAt || startedAt) + HUB_MAP_HTTP_API.SOFT_DEADLINE_MS;
  const seenCursors = {};
  const seenRows = {};
  const matched = [];
  let scannedCount = 0;
  let upstreamCalls = 0;
  let sourceTotal = 0;
  let nextToken = request.nextToken || '';

  do {
    if (Date.now() >= deadline) hubMapHttpRaise_('UPSTREAM_TIMEOUT', 'Map query reached the safe execution deadline.', 504, true);
    if (upstreamCalls >= HUB_MAP_HTTP_API.MAP_MAX_PAGES) hubMapHttpRaise_('QUERY_LIMIT_EXCEEDED', 'Map query exceeded the page limit.', 422, false);
    if (nextToken) {
      if (seenCursors[nextToken]) hubMapHttpRaise_('QUERY_LIMIT_EXCEEDED', 'Map query returned a repeated cursor.', 502, true);
      seenCursors[nextToken] = true;
      request.nextToken = nextToken;
    } else {
      delete request.nextToken;
    }

    // getMapData performs a full map-cache join for every page. Daily routes already
    // expose coordinates, so paging that source avoids the repeated expensive join.
    const response = getDailyRoutes(request);
    upstreamCalls++;
    hubMapHttpRequireHubOk_(response, 'mapBounds');
    sourceTotal = Math.max(sourceTotal, Number(response.meta && response.meta.total || 0));
    const pageRows = hubMapHttpObjects_(response);
    scannedCount += pageRows.length;
    if (scannedCount > HUB_MAP_HTTP_API.MAP_MAX_SCANNED_ROWS) {
      hubMapHttpRaise_('QUERY_LIMIT_EXCEEDED', 'Map query exceeded the row limit.', 422, false);
    }
    pageRows.forEach(function (row) {
      const coordinate = hubMapHttpCoordinate_(row);
      if (!coordinate || !hubMapHttpWithinBounds_(coordinate, bounds)) return;
      const markerRow = Object.assign({}, row, {latitude: coordinate.latitude, longitude: coordinate.longitude});
      const key = [
        String(row.customerCode || ''),
        String(row.confirmedVehicle || ''),
        coordinate.latitude,
        coordinate.longitude
      ].join('|');
      if (seenRows[key]) return;
      seenRows[key] = true;
      matched.push(hubMapHttpMapMarker_(markerRow));
    });
    nextToken = String(response.meta && response.meta.nextToken || '');
  } while (nextToken);

  const rows = matched.slice(0, limit);
  const handled = {
    data: rows,
    cached: false,
    meta: {
      total: sourceTotal,
      returned: rows.length,
      nextCursor: null,
      limit: limit,
      boundsApplied: true,
      boundsScope: 'ALL_PAGES',
      scannedCount: scannedCount,
      matchedCount: matched.length,
      returnedCount: rows.length,
      hasMore: matched.length > rows.length,
      upstreamCalls: upstreamCalls,
      queryDurationMs: Date.now() - startedAt
    }
  };
  hubMapHttpCacheWrite_(cacheKey, handled, HUB_MAP_HTTP_API.MAP_TTL_SECONDS);
  return handled;
}

function hubMapHttpParseRequest_(e) {
  const contents = String(e && e.postData && e.postData.contents || '');
  const contentLength = Number(e && e.postData && e.postData.length || contents.length);
  if (!contents) hubMapHttpRaise_('INVALID_REQUEST', 'JSON request body is required.', 400, false);
  if (contentLength > HUB_MAP_HTTP_API.MAX_REQUEST_BYTES || contents.length > HUB_MAP_HTTP_API.MAX_REQUEST_BYTES) {
    hubMapHttpRaise_('INVALID_REQUEST', 'Request body is too large.', 413, false);
  }
  try {
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('OBJECT_REQUIRED');
    return parsed;
  } catch (error) {
    hubMapHttpRaise_('INVALID_REQUEST', 'Request body must be valid JSON.', 400, false);
  }
}

function hubMapHttpValidateEnvelope_(request) {
  hubMapHttpValidateOnlyKeys_(request, ['version', 'action', 'requestId', 'params', 'auth']);
  if (request.version !== HUB_MAP_HTTP_API.VERSION) {
    hubMapHttpRaise_('INVALID_VERSION', 'Unsupported API version.', 400, false);
  }
  const action = hubMapHttpRequiredText_(request.action, 'action', 1, 40);
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(action)) {
    hubMapHttpRaise_('INVALID_ACTION', 'action has an invalid format.', 404, false);
  }
  const requestId = hubMapHttpRequiredText_(request.requestId, 'requestId', 8, 100);
  if (!/^[A-Za-z0-9._:-]+$/.test(requestId)) {
    hubMapHttpRaise_('INVALID_REQUEST', 'requestId has an invalid format.', 400, false);
  }
  if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) {
    hubMapHttpRaise_('INVALID_PARAMS', 'params must be an object.', 400, false);
  }
}

function hubMapHttpAuthenticate_(request, secretOverride) {
  const auth = request.auth;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    hubMapHttpRaise_('UNAUTHORIZED', 'Authentication is required.', 401, false);
  }
  hubMapHttpValidateOnlyKeys_(auth, ['timestamp', 'nonce', 'signature']);
  const timestamp = hubMapHttpRequiredText_(auth.timestamp, 'auth.timestamp', 10, 40);
  const nonce = hubMapHttpRequiredText_(auth.nonce, 'auth.nonce', 16, 100);
  const signature = hubMapHttpRequiredText_(auth.signature, 'auth.signature', 32, 200);
  if (!/^[A-Za-z0-9_-]+$/.test(nonce) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
    hubMapHttpRaise_('UNAUTHORIZED', 'Authentication is invalid.', 401, false);
  }
  const timestampMs = hubMapHttpTimestampMs_(timestamp);
  if (!isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > HUB_MAP_HTTP_API.MAX_CLOCK_SKEW_MS) {
    hubMapHttpRaise_('UNAUTHORIZED', 'Authentication timestamp is invalid or expired.', 401, false);
  }
  const secret = String(secretOverride || PropertiesService.getScriptProperties().getProperty(HUB_MAP_HTTP_API.SECRET_PROPERTY) || '');
  if (secret.length < 32) hubMapHttpRaise_('INTERNAL_ERROR', 'API authentication is not configured.', 500, false);
  const canonical = hubMapHttpCanonical_(request);
  const expected = hubMapHttpHmac_(canonical, secret);
  if (!hubMapHttpConstantTimeEqual_(signature, expected)) {
    hubMapHttpRaise_('UNAUTHORIZED', 'Authentication is invalid.', 401, false);
  }
  const nonceKey = 'hub_map_nonce_' + hubMapHttpDigest_(nonce);
  const cache = CacheService.getScriptCache();
  if (cache.get(nonceKey)) hubMapHttpRaise_('UNAUTHORIZED', 'Authentication nonce was already used.', 401, false);
  cache.put(nonceKey, '1', HUB_MAP_HTTP_API.NONCE_TTL_SECONDS);
}

function hubMapHttpRateLimit_() {
  const cache = CacheService.getScriptCache();
  const bucket = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHHmm');
  const key = 'hub_map_rate_' + bucket;
  const current = Number(cache.get(key) || 0);
  if (current >= HUB_MAP_HTTP_API.RATE_LIMIT_PER_MINUTE) {
    hubMapHttpRaise_('RATE_LIMITED', 'Request rate limit exceeded.', 429, true);
  }
  cache.put(key, String(current + 1), 70);
}

function hubMapHttpCanonical_(request) {
  return [
    request.version,
    request.action,
    request.requestId,
    String(request.auth && request.auth.timestamp || ''),
    String(request.auth && request.auth.nonce || ''),
    hubMapHttpStableStringify_(request.params || {})
  ].join('\n');
}

function hubMapHttpStableStringify_(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(hubMapHttpStableStringify_).join(',') + ']';
  return '{' + Object.keys(value).sort().map(function (key) {
    return JSON.stringify(key) + ':' + hubMapHttpStableStringify_(value[key]);
  }).join(',') + '}';
}

function hubMapHttpHmac_(canonical, secret) {
  const bytes = Utilities.computeHmacSha256Signature(
    canonical,
    secret,
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function hubMapHttpDigest_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value));
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '').slice(0, 44);
}

function hubMapHttpConstantTimeEqual_(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    mismatch |= (a.charCodeAt(i % Math.max(1, a.length)) || 0) ^
      (b.charCodeAt(i % Math.max(1, b.length)) || 0);
  }
  return mismatch === 0;
}

function hubMapHttpTimestampMs_(value) {
  if (/^\d{13}$/.test(value)) return Number(value);
  if (/^\d{10}$/.test(value)) return Number(value) * 1000;
  return Date.parse(value);
}

function hubMapHttpCustomerSummary_(row) {
  return {
    customerCode: String(row.customerCode || ''),
    customerName: hubMapHttpNullableText_(row.customerName),
    customerAddress: hubMapHttpNullableText_(row.customerAddress || row.address),
    latitude: hubMapHttpNumberOrNull_(row.latitude || row.lat),
    longitude: hubMapHttpNumberOrNull_(row.longitude || row.lng),
    center: hubMapHttpNullableText_(row.center || row.logisticsCenterName),
    updatedAt: hubMapHttpIsoOrNull_(row.updatedAt)
  };
}

function hubMapHttpRouteStop_(row) {
  return {
    deliveryDate: hubMapHttpDateOrNull_(row.deliveryDate),
    sequence: hubMapHttpNumberOrNull_(hubMapHttpFirstDefined_([
      row.stopOrder,
      row.sequence,
      row.routeOrder,
      row.arrivalOrder,
      row.savedOrder
    ])),
    customerCode: String(row.customerCode || ''),
    customerName: hubMapHttpNullableText_(row.customerName),
    customerAddress: hubMapHttpNullableText_(row.customerAddress || row.address),
    detailAddress: hubMapHttpNullableText_(row.detailAddress),
    confirmedVehicle: hubMapHttpNullableText_(row.confirmedVehicle),
    baseVehicle: hubMapHttpNullableText_(row.baseVehicle),
    truckTon: hubMapHttpNumberOrNull_(row.truckTon),
    driverName: hubMapHttpNullableText_(row.driverName),
    deliveryArea: hubMapHttpNullableText_(row.deliveryArea || row.area),
    salesAmount: hubMapHttpNumberOrNull_(hubMapHttpFirstValue_(row.salesAmount, row.dailyAmount)),
    deliveryCount: hubMapHttpNumberOrNull_(row.deliveryCount),
    latitude: hubMapHttpNumberOrNull_(row.latitude || row.lat),
    longitude: hubMapHttpNumberOrNull_(row.longitude || row.lng)
  };
}

function hubMapHttpMapMarker_(row) {
  return {
    customerCode: String(row.customerCode || ''),
    vehicle: hubMapHttpNullableText_(row.confirmedVehicle),
    lat: hubMapHttpNumberOrNull_(row.latitude),
    lng: hubMapHttpNumberOrNull_(row.longitude),
    label: hubMapHttpNullableText_(row.customerName),
    center: hubMapHttpNullableText_(row.center),
    area: hubMapHttpNullableText_(row.area),
    updatedAt: null,
    schemaVersion: HUB_MAP_HTTP_API.VERSION
  };
}

function hubMapHttpVehicle_(value) {
  let vehicle = hubMapHttpRequiredText_(value, 'vehicle', 1, 30).replace(/\s+/g, '');
  vehicle = vehicle.replace(/호차$/, '').replace(/호$/, '');
  if (!vehicle || !/^[0-9A-Za-z가-힣_-]+$/.test(vehicle) || vehicle.indexOf('\uFFFD') >= 0) {
    hubMapHttpRaise_('INVALID_PARAMS', 'vehicle has an invalid format.', 400, false);
  }
  return vehicle;
}

function hubMapHttpFirstDefined_(values) {
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== undefined && values[i] !== null && values[i] !== '') return values[i];
  }
  return null;
}

function hubMapHttpNormalizedBounds_(bounds) {
  return {
    south: Number(bounds.south.toFixed(5)),
    west: Number(bounds.west.toFixed(5)),
    north: Number(bounds.north.toFixed(5)),
    east: Number(bounds.east.toFixed(5))
  };
}

function hubMapHttpCoordinate_(row) {
  let latitude = hubMapHttpNumberOrNull_(hubMapHttpFirstDefined_([row.latitude, row.lat]));
  let longitude = hubMapHttpNumberOrNull_(hubMapHttpFirstDefined_([row.longitude, row.lng]));
  if (latitude == null || longitude == null) return null;
  if ((latitude < 30 || latitude > 40) && longitude >= 30 && longitude <= 40 && latitude >= 120 && latitude <= 135) {
    const swap = latitude;
    latitude = longitude;
    longitude = swap;
  }
  if (latitude < 30 || latitude > 40 || longitude < 120 || longitude > 135) return null;
  return {latitude: latitude, longitude: longitude};
}

function hubMapHttpWithinBounds_(coordinate, bounds) {
  const latitudeOk = coordinate.latitude >= bounds.south && coordinate.latitude <= bounds.north;
  const longitudeOk = bounds.west <= bounds.east
    ? coordinate.longitude >= bounds.west && coordinate.longitude <= bounds.east
    : (coordinate.longitude >= bounds.west || coordinate.longitude <= bounds.east);
  return latitudeOk && longitudeOk;
}

function hubMapHttpActionCacheKey_(action, params) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    HUB_MAP_HTTP_API.VERSION + '|' + action + '|' + hubMapHttpStableStringify_(params || {}),
    Utilities.Charset.UTF_8
  );
  return 'hub_map_http_' + action + '_' + Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '').slice(0, 40);
}

function hubMapHttpCacheRead_(key) {
  try {
    const value = CacheService.getScriptCache().get(key);
    if (!value) return null;
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

function hubMapHttpCacheWrite_(key, handled, ttlSeconds) {
  try {
    const serialized = JSON.stringify(handled);
    if (serialized.length > HUB_MAP_HTTP_API.CACHE_MAX_CHARS) return false;
    CacheService.getScriptCache().put(key, serialized, ttlSeconds);
    return true;
  } catch (error) {
    return false;
  }
}

function hubMapHttpCachedHandled_(cached, lookupDurationMs) {
  return {
    data: cached.data,
    cached: true,
    meta: Object.assign({}, cached.meta || {}, {
      cacheHit: true,
      cacheLookupDurationMs: lookupDurationMs,
      upstreamCalls: 0
    })
  };
}

function hubMapHttpPageMeta_(response, returned, limit) {
  return {
    total: Number(response.meta && response.meta.total || 0),
    returned: returned,
    nextCursor: hubMapHttpNullableText_(response.meta && response.meta.nextToken),
    limit: limit
  };
}

function hubMapHttpObjects_(response) {
  const data = response && response.data;
  if (Array.isArray(data)) return data.filter(hubMapHttpIsObject_);
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.items)) return data.items.filter(hubMapHttpIsObject_);
  if (Array.isArray(data.rows) && Array.isArray(data.headers)) {
    return data.rows.map(function (row) {
      if (hubMapHttpIsObject_(row)) return row;
      const object = {};
      data.headers.forEach(function (header, index) { object[String(header)] = row[index]; });
      return object;
    });
  }
  if (Array.isArray(data.rows)) return data.rows.filter(hubMapHttpIsObject_);
  return [];
}

function hubMapHttpIsObject_(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hubMapHttpRequireHubOk_(response, action) {
  if (response && response.ok === true) return;
  const message = String(response && response.error || action + ' failed');
  if (/timeout|timed out|시간 초과/i.test(message)) {
    hubMapHttpRaise_('TIMEOUT', 'Upstream request timed out.', 504, true);
  }
  hubMapHttpRaise_('INTERNAL_ERROR', 'Upstream request failed.', 500, true);
}

function hubMapHttpBounds_(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    hubMapHttpRaise_('INVALID_PARAMS', 'bounds must be an object.', 400, false);
  }
  hubMapHttpValidateOnlyKeys_(value, ['south', 'west', 'north', 'east']);
  const south = hubMapHttpFinite_(value.south, 'bounds.south', -90, 90);
  const north = hubMapHttpFinite_(value.north, 'bounds.north', -90, 90);
  const west = hubMapHttpFinite_(value.west, 'bounds.west', -180, 180);
  const east = hubMapHttpFinite_(value.east, 'bounds.east', -180, 180);
  if (north <= south || east <= west) {
    hubMapHttpRaise_('INVALID_PARAMS', 'bounds order is invalid.', 400, false);
  }
  if (north - south > HUB_MAP_HTTP_API.MAX_BOUNDS_LAT_SPAN ||
      east - west > HUB_MAP_HTTP_API.MAX_BOUNDS_LNG_SPAN) {
    hubMapHttpRaise_('INVALID_PARAMS', 'bounds exceeds the allowed area.', 400, false);
  }
  return {south: south, west: west, north: north, east: east};
}

function hubMapHttpLimit_(value, fallback, maximum) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    hubMapHttpRaise_('INVALID_PARAMS', 'limit is outside the allowed range.', 400, false);
  }
  return number;
}

function hubMapHttpDate_(value, field) {
  const text = hubMapHttpRequiredText_(value, field, 10, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    hubMapHttpRaise_('INVALID_PARAMS', field + ' must use YYYY-MM-DD.', 400, false);
  }
  const parts = text.split('-').map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] - 1 || date.getUTCDate() !== parts[2]) {
    hubMapHttpRaise_('INVALID_PARAMS', field + ' is not a valid date.', 400, false);
  }
  return text;
}

function hubMapHttpCustomerCode_(value) {
  const code = hubMapHttpRequiredText_(value, 'customerCode', 1, 40);
  if (!/^[A-Za-z0-9_-]+$/.test(code)) {
    hubMapHttpRaise_('INVALID_PARAMS', 'customerCode has an invalid format.', 400, false);
  }
  return code;
}

function hubMapHttpLooksLikeCustomerCode_(value) {
  return /^[A-Za-z]\d{3,}$/.test(String(value || ''));
}

function hubMapHttpText_(value, field, maximum) {
  if (typeof value !== 'string') hubMapHttpRaise_('INVALID_PARAMS', field + ' must be a string.', 400, false);
  const text = value.trim();
  if (text.length > Math.min(maximum, HUB_MAP_HTTP_API.MAX_STRING_LENGTH)) {
    hubMapHttpRaise_('INVALID_PARAMS', field + ' is too long.', 400, false);
  }
  return text;
}

function hubMapHttpRequiredText_(value, field, minimum, maximum) {
  const text = hubMapHttpText_(value, field, maximum);
  if (text.length < minimum) hubMapHttpRaise_('INVALID_PARAMS', field + ' is required.', 400, false);
  return text;
}

function hubMapHttpFinite_(value, field, minimum, maximum) {
  const number = Number(value);
  if (!isFinite(number) || number < minimum || number > maximum) {
    hubMapHttpRaise_('INVALID_PARAMS', field + ' is outside the allowed range.', 400, false);
  }
  return number;
}

function hubMapHttpValidateOnlyKeys_(object, allowed) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    hubMapHttpRaise_('INVALID_PARAMS', 'An object was expected.', 400, false);
  }
  const unexpected = Object.keys(object).filter(function (key) { return allowed.indexOf(key) < 0; });
  if (unexpected.length) hubMapHttpRaise_('INVALID_PARAMS', 'Request contains unsupported fields.', 400, false);
}

function hubMapHttpNullableText_(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function hubMapHttpNumberOrNull_(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return isFinite(number) ? number : null;
}

function hubMapHttpFirstValue_(primary, fallback) {
  return primary == null || primary === '' ? fallback : primary;
}

function hubMapHttpDateOrNull_(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Utilities.formatDate(value, 'UTC', 'yyyy-MM-dd');
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function hubMapHttpIsoOrNull_(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function hubMapHttpSuccess_(data, requestId, startedAt, cached, httpStatus, extraMeta) {
  return {
    ok: true,
    data: data,
    meta: Object.assign({
      source: HUB_MAP_HTTP_API.SOURCE,
      requestId: requestId || '',
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      cached: cached === true,
      version: HUB_MAP_HTTP_API.VERSION,
      httpStatus: httpStatus || 200
    }, extraMeta || {}),
    error: null
  };
}

function hubMapHttpFailure_(code, message, retryable, requestId, startedAt, httpStatus) {
  return {
    ok: false,
    data: null,
    meta: {
      source: HUB_MAP_HTTP_API.SOURCE,
      requestId: requestId || '',
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      cached: false,
      version: HUB_MAP_HTTP_API.VERSION,
      httpStatus: httpStatus || 500
    },
    error: {
      code: code || 'INTERNAL_ERROR',
      message: message || 'An internal error occurred.',
      retryable: retryable === true
    }
  };
}

function hubMapHttpRaise_(code, message, httpStatus, retryable) {
  const error = new Error(message);
  error.safeCode = code;
  error.safeHttpStatus = httpStatus;
  error.safeRetryable = retryable === true;
  throw error;
}

function hubMapHttpSafeError_(error) {
  if (!error || !error.safeCode) {
    return {code: 'INTERNAL_ERROR', message: 'An internal error occurred.', httpStatus: 500, retryable: false};
  }
  const code = String(error.safeCode);
  const allowed = [
    'INVALID_REQUEST', 'INVALID_VERSION', 'INVALID_ACTION', 'INVALID_PARAMS',
    'UNAUTHORIZED', 'NOT_FOUND', 'RATE_LIMITED', 'TIMEOUT', 'UPSTREAM_TIMEOUT',
    'QUERY_LIMIT_EXCEEDED', 'INTERNAL_ERROR', 'INVALID_CURSOR',
    'DATED_SOURCE_COUNT_MISMATCH', 'DATED_SOURCE_DATE_MISMATCH', 'DATED_SOURCE_IDENTITY_MISSING'
    ,'PERIOD_ROW_INVALID','PERIOD_SOURCE_INCOMPLETE','PERIOD_SOURCE_CHANGED','HISTORY_SOURCE_ERROR'
  ];
  if (allowed.indexOf(code) < 0) {
    return {code: 'INTERNAL_ERROR', message: 'An internal error occurred.', httpStatus: 500, retryable: false};
  }
  return {
    code: code,
    message: String(error && error.message || 'An internal error occurred.'),
    httpStatus: Number(error && error.safeHttpStatus || 500),
    retryable: Boolean(error && error.safeRetryable)
  };
}

function hubMapHttpJson_(response) {
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

function hubMapHttpAudit_(requestId, action, response) {
  console.log(JSON.stringify({
    requestId: String(requestId || '').slice(0, 100),
    action: String(action || '').slice(0, 40),
    ok: response.ok === true,
    errorCode: response.error && response.error.code || null,
    durationMs: response.meta && response.meta.durationMs || 0
  }));
}

/**
 * Local/Apps Script contract tests. This test does not call Customer APIs.
 */
function testHubMapHttpContract() {
  const startedAt = Date.now();
  const success = hubMapHttpSuccess_({service: HUB_MAP_HTTP_API.SERVICE}, 'test-request-01', startedAt, false, 200);
  const failure = hubMapHttpFailure_('INVALID_ACTION', 'invalid', false, 'test-request-02', startedAt, 404);
  const invalidBounds = hubMapHttpCaptureError_(function () {
    hubMapHttpBounds_({south: 30, west: 120, north: 40, east: 130});
  });
  const invalidDate = hubMapHttpCaptureError_(function () { hubMapHttpDate_('2026-02-30', 'date'); });
  const invalidLimit = hubMapHttpCaptureError_(function () {
    hubMapHttpLimit_(501, 100, HUB_MAP_HTTP_API.MAX_MAP_LIMIT);
  });
  const result = {
    ok: success.ok === true &&
      success.error === null &&
      failure.ok === false &&
      failure.error.code === 'INVALID_ACTION' &&
      invalidBounds === 'INVALID_PARAMS' &&
      invalidDate === 'INVALID_PARAMS' &&
      invalidLimit === 'INVALID_PARAMS',
    success: success,
    failure: failure,
    checks: {
      invalidBounds: invalidBounds,
      invalidDate: invalidDate,
      invalidLimit: invalidLimit
    }
  };
  console.log(JSON.stringify(result));
  return result;
}

function testHubMapHttpAuth() {
  const secret = 'local-test-secret-value-that-is-at-least-32-characters';
  const request = {
    version: HUB_MAP_HTTP_API.VERSION,
    action: 'health',
    requestId: 'auth-test-request-01',
    params: {},
    auth: {
      timestamp: String(Date.now()),
      nonce: 'nonce_for_auth_test_0001',
      signature: ''
    }
  };
  request.auth.signature = hubMapHttpHmac_(hubMapHttpCanonical_(request), secret);
  let valid = true;
  try { hubMapHttpAuthenticate_(request, secret); } catch (error) { valid = false; }
  const replay = hubMapHttpCaptureError_(function () { hubMapHttpAuthenticate_(request, secret); });
  const bad = JSON.parse(JSON.stringify(request));
  bad.auth.nonce = 'nonce_for_auth_test_0002';
  bad.auth.signature = 'invalid_signature_value_000000000000';
  const rejected = hubMapHttpCaptureError_(function () { hubMapHttpAuthenticate_(bad, secret); });
  const result = {ok: valid && replay === 'UNAUTHORIZED' && rejected === 'UNAUTHORIZED', valid: valid, replay: replay, rejected: rejected};
  console.log(JSON.stringify(result));
  return result;
}

function hubMapHttpCaptureError_(fn) {
  try {
    fn();
    return '';
  } catch (error) {
    return String(error && error.safeCode || 'INTERNAL_ERROR');
  }
}
