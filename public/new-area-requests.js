(function (root) {
  'use strict';
  const failure = code => Object.assign(new Error(code), { code });
  function lookup(geocoder, query, { signal, timeout = 7000 } = {}) {
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
        geocoder.addressSearch(query, (rows, status) => {
          if (status === 'ZERO_RESULT') return finish(null, []);
          if (status !== 'OK' || !Array.isArray(rows)) return finish(failure('GEOCODER_FAILED'));
          const valid = row => row && row.x != null && row.y != null && String(row.x).trim() !== '' && String(row.y).trim() !== ''
            && Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y)) && Math.abs(Number(row.x)) <= 180 && Math.abs(Number(row.y)) <= 90;
          if (!rows.every(valid)) return finish(failure('GEOCODER_INVALID_COORDINATES'));
          finish(null, rows);
        });
      } catch { finish(failure('GEOCODER_FAILED')); }
    });
  }
  function message(error) {
    return ({ GEOCODER_UNAVAILABLE: '주소 조회 서비스 미연결', GEOCODER_TIMEOUT: '주소 조회 시간 초과',
      GEOCODER_FAILED: '주소 조회 오류', GEOCODER_INVALID_COORDINATES: '주소 좌표 응답 오류' })[error?.code] || '주소 조회 실패';
  }
  root.NewAreaRequests = { lookup, message };
})(typeof window === 'object' ? window : globalThis);

