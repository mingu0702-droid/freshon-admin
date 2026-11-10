(function (root) {
  'use strict';
  const failure = code => Object.assign(new Error(code), { code });
  // Search identity is separate from the unchanged X/Y cells and address hash.
  function addressQueries(address, variants) {
    const normalized = String(address || '').normalize('NFKC').replace(/\s+/g, ' ').trim()
      .replace(/(동|읍|면|리|대로|로|길)(\d+(?:-\d+)?)(?=\s|\(|\[|$)/g, '$1 $2');
    const choices = variants(normalized);
    const primary = choices[choices.length - 1] || '';
    if(!/(?:대로|로|길|동|읍|면|리|가)\s+(?:(?:산|지하)\s*)?\d+(?:-\d+)?$/.test(primary))return [];
    let query = primary;
    // Official search aliases only; the original address and its identity are untouched.
    // https://www.incheon.go.kr/IC01070101 (2026-07-01 administrative reorganization)
    const districtHints=[['제물포구','송림동','동구'],['영종구','운남동','중구'],['검단구','당하동','서구']];
    for(const [current,dong,previous] of districtHints){
      if(new RegExp('(?:^|[\\s(,])'+dong+'(?=[\\s),]|$)').test(normalized))query=query.replace(new RegExp('^인천(?:광역시|시)?\\s+'+current+'(?=\\s)'), '인천광역시 '+previous);
    }
    // https://www.hscity.go.kr/manse/index.do ; https://www.hscity.go.kr/www/user/bbs/BD_selectBbs.do?q_bbsCode=1051&q_bbscttSn=20260506132845387
    query=query.replace(/^((?:경기도|경기)\s+화성시)\s+(?:만세구|효행구|병점구|동탄구)\s+/, '$1 ');
    // Law 21446 (2026-07-01), Jeonnam Education Office official copy:
    // https://www.jne.go.kr/upload/open/na/bbs_297/ntt_5170418/doc_3519ab36-5a2c-41ed-a852-2eb33fc1588f1773a1213b74675.pdf
    query=query.replace(/^전남광주통합특별시\s+(?=(?:순천시|광양시|강진군)\s)/,'전라남도 ');
    if(/(?:^|[\s(,])용봉동(?=[\s),]|$)/.test(normalized))query=query.replace(/^전남광주통합특별시\s+북구(?=\s)/,'광주광역시 북구');
    return [...new Set([primary,query])];
  }
  function addressQuery(address, variants) { return addressQueries(address,variants)[0] || ''; }
  function stopsExternal(error) {
    return /^(?:KAKAO_|GEOCODE_(?:DAILY_LIMIT|AUTOMATICALLY_BLOCKED|LEDGER_|DURABLE_|SESSION_|ORIGIN_)|GEOCODING_DISABLED|TARGET_APP_)/.test(error?.code || '');
  }
  function outcome(error) { return error?.code === 'GEOCODE_DAILY_LIMIT' ? 'LIMIT' : ['GEOCODE_AUTOMATICALLY_BLOCKED','NEW_AREA_ROW_TIMEOUT','REQUEST_TIMEOUT','GEOCODER_TIMEOUT'].includes(error?.code)||/^GEOCODER_(?:MULTIPLE_CANDIDATES|RESULT_TRUNCATED|ADDRESS_MISMATCH)$/.test(error?.code||'') ? 'DEFERRED' : 'FAILED'; }
  function lookup(geocoder, query, { signal, mode, timeout = geocoder?.serverProxy?45000:7000 } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const finish = (error, rows) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(rows);
      };
      const abort = () => finish(Object.assign(failure('CANCELLED'), { name: 'AbortError', silent: true }));
      if (signal?.aborted) return abort();
      if (!geocoder?.addressSearch) return finish(failure('GEOCODER_UNAVAILABLE'));
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(failure('GEOCODER_TIMEOUT')), timeout);
      try {
        geocoder.addressSearch(query, (rows, status, meta) => {
          const problem=code=>Object.assign(failure(code),{status:meta?.status??meta?.httpStatus,httpStatus:meta?.httpStatus??meta?.status,providerHttp:Number.isInteger(meta?.providerHttp)?meta.providerHttp:null});
          if (status === 'ZERO_RESULT') {
            if (mode==='official' && meta?.resolution?.kind==='MANUAL') return finish(null,{rows:[],resolution:meta.resolution});
            const reasons={MULTIPLE_CANDIDATES:'GEOCODER_MULTIPLE_CANDIDATES',TRUNCATED:'GEOCODER_RESULT_TRUNCATED',ADDRESS_OR_COORDINATE_MISMATCH:'GEOCODER_ADDRESS_MISMATCH',INVALID_RESPONSE:'GEOCODER_INVALID_RESPONSE'};
            return reasons[meta?.resolution?.kind]?finish(problem(reasons[meta.resolution.kind])):finish(null, Object.defineProperty([], 'zeroResult', { value:true }));
          }
          if (status !== 'OK' || !Array.isArray(rows)) return finish(problem(/^[A-Z_]+$/.test(meta?.code || '')?meta.code:/^GEOCODE_(?:DAILY_LIMIT|SESSION_EXPIRED|ORIGIN_REJECTED|AUTOMATICALLY_BLOCKED)$/.test(status)?status:'GEOCODER_FAILED'));
          const valid = row => row && row.x != null && row.y != null && String(row.x).trim() !== '' && String(row.y).trim() !== ''
            && Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y)) && Math.abs(Number(row.x)) <= 180 && Math.abs(Number(row.y)) <= 90;
          if (!rows.every(valid)) return finish(failure('GEOCODER_INVALID_COORDINATES'));
          finish(null, mode?{rows,resolution:meta?.resolution}:rows);
        }, { signal, mode });
      } catch { finish(failure('GEOCODER_FAILED')); }
    });
  }
  function message(error) {
    return ({ GEOCODE_DAILY_LIMIT: '일일 주소 조회 한도 대기', GEOCODE_AUTOMATICALLY_BLOCKED: '주소 조회 차단 · 보류',
      NEW_AREA_ROW_TIMEOUT: '주소 응답 지연 · 다시 조회 필요', REQUEST_TIMEOUT: '고객 주소 응답 지연 · 다시 조회 필요',
      GEOCODE_QUERY_INVALID: '주소·상호 검색어를 확인해 주세요',
      GEOCODING_DISABLED:'외부 주소 검색 비활성',TARGET_APP_FREE_QUOTA_UNVERIFIED:'외부 주소 검색 무료 한도 미확인',
      TARGET_APP_KEYWORD_FREE_QUOTA_UNVERIFIED:'외부 상호 검색 무료 한도 미확인',DIAGNOSTIC_REQUIRED:'외부 주소 검색 연결 미확인',
      GEOCODE_DURABLE_LEDGER_REQUIRED:'외부 검색 사용 원장 미연결',GEOCODE_RETRY_COOLDOWN:'외부 검색 응답 대기 · 잠시 후 재시도', GEOCODER_UNAVAILABLE: '주소 조회 서비스 미연결', GEOCODER_TIMEOUT: '주소 조회 시간 초과',
      GEOCODER_FAILED: '주소 조회 오류', GEOCODER_INVALID_COORDINATES: '주소 좌표 응답 오류',
      GEOCODE_SESSION_EXPIRED:'직원 인증이 만료되었습니다',GEOCODE_ORIGIN_REJECTED:'주소 조회 권한 확인 필요',
      GEOCODER_MULTIPLE_CANDIDATES:'주소 후보 복수 · 선택 필요',GEOCODER_RESULT_TRUNCATED:'주소 범위 확인 필요',
      GEOCODER_ADDRESS_MISMATCH:'원본 주소와 위치 불일치',GEOCODER_INVALID_RESPONSE:'주소 응답 형식 확인 필요' })[error?.code] || '주소 조회 실패';
  }
  function singleStoredLocation(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    const first=rows[0];
    if (!rows.every(row=>typeof row.lat==='number'&&typeof row.lng==='number'&&Number.isFinite(row.lat)&&Number.isFinite(row.lng)&&row.lat===first.lat&&row.lng===first.lng)) return {candidates:rows};
    return {...first,coordinateReferenceCustomers:[...new Set(rows.map(row=>row.customerCode).filter(Boolean))]};
  }
  const flights = new Map(), retained = new Map(), temporary = new Map();
  let addressEpoch = 0;
  const addressKey = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
  function remember(cache,key,value) {
    if (cache.size >= 64) cache.delete(cache.keys().next().value);
    cache.set(key,value);
  }
  function stageAddress(query,generation) {
    if (root.location?.origin !== 'https://freshon-admin-stage-preview-template.onrender.com') return Promise.resolve(null);
    const variants = /^\d{19}$/.test(query) ? [query] : addressQueries(query,root.Phase2bUi.addressVariants);
    if (!variants.length) return Promise.resolve(null);
    const key = JSON.stringify([generation,...variants.map(addressKey)]);
    if (retained.has(key)) return Promise.resolve(retained.get(key));
    if (!flights.has(key)) {
      const epoch = addressEpoch;
      const task = fetch('/api/map-phase2b/private/stage-address-evidence',{
        method:'POST', credentials:'same-origin', cache:'no-store', signal:AbortSignal.timeout(10000),
        headers:{'Content-Type':'application/json'},body:JSON.stringify({generation,rows:[variants],includeCustomers:true})
      }).then(async response=>{
        const payload=await response.json().catch(()=>null);
        if(!response.ok)throw Object.assign(failure(payload?.error||'STAGE_BATCH_UNAVAILABLE'),{status:response.status});
        if(epoch!==addressEpoch)return null;
        if(payload?.generation!==generation||payload.data?.length!==1)throw failure('STAGE_BATCH_UNAVAILABLE');
        const [result]=payload.data;
        if(generation&&['STORED','OFFICIAL'].includes(result.status)&&result.point)remember(retained,key,result);
        return result;
      }).finally(()=>{if(flights.get(key)===task)flights.delete(key);});
      flights.set(key,task);
    }
    return flights.get(key);
  }
  function rememberTemporary(query,point) {
    if(point?.coordinateSource==='MAP_CLICK_TEMPORARY' && Number.isFinite(point.lat)&&Number.isFinite(point.lng)) {
      remember(temporary,addressKey(query),{lat:point.lat,lng:point.lng,coordinateSource:point.coordinateSource});
    }
  }
  root.addEventListener?.('map-staff-signed-out',()=>{addressEpoch++;retained.clear();flights.clear();temporary.clear();});
  root.NewAreaRequests = { lookup, message, addressQuery, addressQueries, stopsExternal, outcome, singleStoredLocation,
    stageAddress, rememberTemporary, temporaryPoint:query=>temporary.get(addressKey(query)) };
})(typeof window === 'object' ? window : globalThis);

