const HUB_MAP_HTTP_API=Object.freeze({VERSION:'map-phase2-v1',SOURCE:'hub-protected-reader',SERVICE:'hub-protected-reader',SECRET_PROPERTY:'HUB_MAP_API_HMAC_SECRET',MAX_REQUEST_BYTES:32768,MAX_STRING_LENGTH:200,MAX_CLOCK_SKEW_MS:300000,NONCE_TTL_SECONDS:600,RATE_LIMIT_PER_MINUTE:120});
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

function hubMapHttpRaise_(code, message, httpStatus, retryable) {
  const error = new Error(message);
  error.safeCode = code;
  error.safeHttpStatus = httpStatus;
  error.safeRetryable = retryable === true;
  throw error;
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

function hubMapHttpValidateOnlyKeys_(object, allowed) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    hubMapHttpRaise_('INVALID_PARAMS', 'An object was expected.', 400, false);
  }
  const unexpected = Object.keys(object).filter(function (key) { return allowed.indexOf(key) < 0; });
  if (unexpected.length) hubMapHttpRaise_('INVALID_PARAMS', 'Request contains unsupported fields.', 400, false);
}

function hubMapHttpRequiredText_(value, field, minimum, maximum) {
  const text = hubMapHttpText_(value, field, maximum);
  if (text.length < minimum) hubMapHttpRaise_('INVALID_PARAMS', field + ' is required.', 400, false);
  return text;
}

function hubMapHttpText_(value, field, maximum) {
  if (typeof value !== 'string') hubMapHttpRaise_('INVALID_PARAMS', field + ' must be a string.', 400, false);
  const text = value.trim();
  if (text.length > Math.min(maximum, HUB_MAP_HTTP_API.MAX_STRING_LENGTH)) {
    hubMapHttpRaise_('INVALID_PARAMS', field + ' is too long.', 400, false);
  }
  return text;
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

function hubMapHttpTimestampMs_(value) {
  if (/^\d{13}$/.test(value)) return Number(value);
  if (/^\d{10}$/.test(value)) return Number(value) * 1000;
  return Date.parse(value);
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

function hubMapHttpDigest_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value));
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '').slice(0, 44);
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

function hubMapHttpCustomerCode_(value) {
  const code = hubMapHttpRequiredText_(value, 'customerCode', 1, 40);
  if (!/^[A-Za-z0-9_-]+$/.test(code)) {
    hubMapHttpRaise_('INVALID_PARAMS', 'customerCode has an invalid format.', 400, false);
  }
  return code;
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

function hubMapHttpRequireHubOk_(response, action) {
  if (response && response.ok === true) return;
  const message = String(response && response.error || action + ' failed');
  if (/timeout|timed out|시간 초과/i.test(message)) {
    hubMapHttpRaise_('TIMEOUT', 'Upstream request timed out.', 504, true);
  }
  hubMapHttpRaise_('INTERNAL_ERROR', 'Upstream request failed.', 500, true);
}

function hubMapHttpNullableText_(value) {
  if (value == null || value === '') return null;
  return String(value);
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

function hubStaffHistoryBatchRead_(id,sheetId,headers,positions,requested) {
  const result=[];
  for(let offset=0;offset<positions.length;offset+=200){
    const batch=positions.slice(offset,offset+200),filters=[];
    // Coalesce adjacent requested columns, but never bridge a non-allowlisted column.
    const columns=requested.map(function(k){return headers.indexOf(k);}).sort(function(a,b){return a-b;}),groups=[];
    columns.forEach(function(c){const last=groups[groups.length-1];if(last&&last.end===c)last.end=c+1;else groups.push({start:c,end:c+1});});
    batch.forEach(function(row){groups.forEach(function(g){filters.push({gridRange:{sheetId:sheetId,startRowIndex:row-1,endRowIndex:row,startColumnIndex:g.start,endColumnIndex:g.end}});});});
    // GET batchGet supports spreadsheets.readonly; POST data-filter reads do not.
    // Translate only exact key ranges, verify returned A1 identities, retain v64 checks.
    const body=protectedReaderBatchKeys_(id,sheetId,filters);
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

function hubStaffHistoryDate_(value){
  if(typeof value==='number'&&Number.isFinite(value)&&value>=20000&&value<80000)return new Date(Date.UTC(1899,11,30)+Math.floor(value)*86400000).toISOString().slice(0,10);
  if(Object.prototype.toString.call(value)==='[object Date]')return Utilities.formatDate(value,'Asia/Seoul','yyyy-MM-dd');
  const text=String(value||'').trim();let m=text.match(/^(\d{4})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})(?:\.|\s|T|$)/);
  if(!m){const us=text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/);if(us)m=[us[0],us[3],us[1],us[2]];}
  if(!m)return null;
  const date=[m[1],('0'+m[2]).slice(-2),('0'+m[3]).slice(-2)].join('-');
  return new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]))).toISOString().slice(0,10)===date?date:null;
}

function hubStaffDetailDate_(value){
  return Object.prototype.toString.call(value)==='[object Date]'?Utilities.formatDate(value,'Asia/Seoul','yyyy-MM-dd'):String(value||'').trim().slice(0,10);
}

function hubDataCacheKey_(method, request) {
  const sorted = Object.keys(request || {}).sort().reduce(function (out, key) { out[key] = request[key]; return out; }, {});
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, method + '|' + JSON.stringify(sorted));
  return 'hub_api_' + Utilities.base64EncodeWebSafe(bytes).replace(/=+$/,'').slice(0, 40);
}
// Candidate only: replace this exact function in the verified Hub v64 HubSearch module.
// Do not add a second global definition or install this file as a new module.
function hubSearchObjects_(response) {
  // Reuse v64's existing decoder; both table rows and object responses are valid.
  if (typeof hubMapHttpObjects_ === 'function') return hubMapHttpObjects_(response);
  const data = response && response.data || {};
  const headers = Array.isArray(data.headers) ? data.headers : [];
  return (Array.isArray(data.rows) ? data.rows : []).map(function (row) {
    const out = {};
    headers.forEach(function (header, index) { out[String(header)] = row[index]; });
    return out;
  });
}

// Candidate only: replace the two exact functions in verified v64 modules.
// Do not install a duplicate global definition or change collectors/triggers.
function hubGetMapMarkerDetail(customerCode, deliveryDate) {
  const code = String(customerCode || '').trim().toUpperCase();
  if (!code) return {ok:false,error:'CUSTOMER_CODE_REQUIRED'};
  const filters = {customerCode:code,limit:1};
  if (deliveryDate) { filters.startDate=deliveryDate; filters.endDate=deliveryDate; }
  function selected(response, source) {
    if (!response || response.ok !== true) {
      return {error:source + (/timeout|timed out/i.test(String(response && response.error || '')) ? '_TIMEOUT' : '_FAILED')};
    }
    const data=response.data;
    if (!Array.isArray(data) && !(data && (Array.isArray(data.rows) || Array.isArray(data.items)))) return {error:source+'_CONTRACT'};
    const rows=hubSearchObjects_(response);
    const matches=rows.filter(function(row){return String(row && row.customerCode || '').trim().toUpperCase()===code;});
    if (rows.length && !matches.length) return {error:source+'_IDENTITY_MISMATCH'};
    if (matches.length>1) return {error:source+'_CONFLICT'};
    return {row:matches[0]||{}};
  }
  // A current Customer lookup must not depend on all-history delivery queries.
  // Dated lookups preserve the existing route-first filters and field precedence.
  let route={};
  if (deliveryDate) {
    const result=selected(getDailyRoutes(filters),'ROUTE_SOURCE');
    if (result.error) return {ok:false,error:result.error};
    route=result.row;
  }
  const result=deliveryDate?{row:{}}:selected(getCustomers(filters),'CUSTOMER_SOURCE');
  if (result.error) return {ok:false,error:result.error};
  const customer=result.row;
  return {ok:true,data:{customerCode:code,customerName:route.customerName||customer.customerName||'',customerAddress:route.customerAddress||customer.customerAddress||'',detailAddress:route.detailAddress||customer.detailAddress||'',accessMemo:route.accessMemo||customer.accessMemo||'',confirmedVehicle:route.confirmedVehicle||'',driverName:route.driverName||'',driverPhone:route.driverPhone||'',area:route.deliveryArea||'',center:route.center||''},error:''};
}

function hubMapHttpHandleCustomerDetail_(params) {
  hubMapHttpValidateOnlyKeys_(params, ['customerCode', 'date']);
  const customerCode = hubMapHttpCustomerCode_(params.customerCode);
  let date = '';
  if (params.date != null && params.date !== '') date = hubMapHttpDate_(params.date, 'date');
  const response = hubGetMapMarkerDetail(customerCode, date);
  hubMapHttpRequireHubOk_(response, 'customerDetail');
  const row = response.data || {};
  if (String(row.customerCode || '').trim().toUpperCase() !== customerCode) {
    hubMapHttpRaise_('INTERNAL_ERROR', 'Customer identity did not match.', 502, false);
  }
  if (!row.customerName && !row.customerAddress && !row.confirmedVehicle) {
    hubMapHttpRaise_('NOT_FOUND', 'Customer was not found.', 404, false);
  }
  return {
    data: {
      customerCode: String(row.customerCode),
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
