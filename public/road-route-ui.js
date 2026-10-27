(function (root) {
  'use strict';
  const STATES = new Set(['success', 'partial', 'error', 'disabled', 'empty', 'not-applicable']);
  const TERMINAL = new Set(['QUOTA_EXCEEDED', 'AUTHENTICATION_FAILED', 'PERMISSION_DENIED', 'CALL_POLICY_BLOCKED']);
  function createController({ fetchImpl = root.fetch.bind(root), onChange }) {
    let generation = 0, active = null, blocked = null;
    function cancel() { generation++; active?.abort(); active = null; onChange({ state: 'idle' }); }
    async function load({ date, vehicle }) {
      cancel();
      const id = generation, identity = { date, vehicle };
      blocked = null;
      const controller = new AbortController(); active = controller;
      const timer = setTimeout(() => controller.abort('timeout'), 60000);
      onChange({ ...identity, state: 'loading' });
      try {
        const response = await fetchImpl('/api/map-phase2b/private/road-route', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(identity), signal: controller.signal });
        if (id !== generation) return;
        if(!response.ok){const error=await root.KakaoDirectionsAdapter.responseError(response);if(TERMINAL.has(error))blocked=error;onChange({...identity,state:'error',error});return;}
        const payload = await response.json();
        if (id !== generation) return;
        if (!response.ok || payload.ok !== true) {
          const error = root.KakaoDirectionsAdapter?.httpError(response.status)||'ROAD_ROUTE_FAILED';
          if (TERMINAL.has(error)) blocked = error;
          onChange({ ...identity, state: 'error', error });
          return;
        }
        const data = payload.data;
        if (!data || data.date !== date || data.vehicle !== vehicle || !STATES.has(data.state)) throw new Error('INVALID_ROAD_ROUTE_RESPONSE');
        if (controller.signal.aborted) throw new Error('TIMEOUT');
        blocked = [data.error, ...(Array.isArray(data.chunks) ? data.chunks.map(chunk => chunk?.error) : [])].find(code => TERMINAL.has(code)) || null;
        onChange(data);
      } catch (error) {
        if (id !== generation) return;
        onChange({ ...identity, state: 'error', error: controller.signal.aborted ? 'TIMEOUT' : 'ROAD_ROUTE_FAILED' });
      } finally { clearTimeout(timer); if (id === generation) active = null; }
    }
    return { cancel, load };
  }
  function describe(data) {
    const reasons = { FEATURE_DISABLED: '도로경로 API 미연결', KEY_MISSING: '도로경로 API 미연결', CALL_POLICY_UNCONFIRMED: '호출 정책 확인 대기', ORIGIN_UNCONFIRMED: '출발지 좌표 확인 대기',
      STAFF_LOGIN_REQUIRED: '직원 로그인 후 조회 가능', RECORDED_ORDER_REQUIRED: '저장된 착순 확인 필요', STOP_COORDINATES_MISSING: '착지 좌표 누락 · 경로 조회 보류',
      ROUTE_SOURCE_UNVERIFIED: '해당일 착순 근거 확인 필요', ROUTE_IDENTITY_MISMATCH: '해당일 호차 확인 필요', QUOTA_EXCEEDED: '쿼터 초과 · 추가 조회 중단',
      AUTHENTICATION_FAILED: '도로경로 인증 오류 · 추가 조회 중단', PERMISSION_DENIED: '도로경로 권한 오류 · 추가 조회 중단', CALL_POLICY_BLOCKED: '무료 호출 예산 확인 필요',
      PROVIDER_UNAVAILABLE:'도로경로 서버 오류 · 다시 조회해 주세요', TIMEOUT: '도로경로 응답 시간 초과', NO_ROAD_ROUTE: '도로경로를 찾지 못했습니다' };
    if (!data || data.state === 'idle') return '경로 조회 버튼을 누르면 확인된 지점의 도로경로를 조회합니다.';
    if (data.state === 'loading') return '도로경로 조회 중…';
    if (data.state === 'empty') return '해당일 운행 0건 · 도로경로 없음';
    if (data.state === 'disabled') return reasons[data.reason] || '도로경로 API 미연결';
    const failures = [...new Set((data.chunks || []).filter(c => c.state !== 'success').map(c => c.error))];
    const failure = failures.map(code => reasons[code] || '일부 구간 조회 실패').join(' · ');
    if (data.state === 'error') return reasons[data.error] || failure || '도로경로 조회 실패 · 거리와 시간 미확인';
    if (data.state === 'partial') return `일부 도로경로 ${data.coveredLegs}/${data.totalLegs}구간 · 성공 구간 합계${failure ? ' · ' + failure : ''}`;
    return '검증된 출발지 → 저장된 착순 → 마지막 매장 · 현재 교통 기준 예상';
  }
  function metrics(data) {
    const valid = ['success', 'partial'].includes(data?.state);
    return { distance: valid && Number.isFinite(data.distanceMeters) && data.distanceMeters >= 0 ? (data.distanceMeters / 1000).toFixed(1) + ' km' : '—',
      duration: valid && Number.isFinite(data.durationSeconds) && data.durationSeconds >= 0 ? Math.ceil(data.durationSeconds / 60) + '분' : '—' };
  }
  // Join adjacent provider road pieces only when their endpoints exactly
  // meet. Disjoint pieces remain separate: no invented connector segments.
  function roadSegments(data) {
    const out=[];
    for(const chunk of data?.chunks||[]){
      if(chunk.state!=='success')continue;
      let current=null;
      for(const road of chunk.geometry||[]){
        const leg=chunk.startLeg+road.legOffset,points=road.latLngs;
        if(Number.isInteger(data.selectedLeg)&&leg!==data.selectedLeg)continue;
        if(!Array.isArray(points)||points.length<2||!points.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]>=33&&p[0]<=39.5&&p[1]>=124&&p[1]<=132)){current=null;continue;}
        const end=current?.latLngs.at(-1),start=points[0];
        if(current&&current.leg===leg&&current.latLngs.length+points.length<=12000&&end[0]===start[0]&&end[1]===start[1])current.latLngs.push(...points.slice(1));
        else {current={leg,latLngs:points.map(p=>p.slice())};out.push(current);}
      }
    }
    return out;
  }
  function createLayer({ map, leaflet = root.L, kakao = root.kakao }) {
    let lines = [];
    function clear() { lines.forEach(line => leaflet && typeof line.remove === 'function' ? line.remove() : line.setMap(null)); lines = []; }
    function render(data) {
      clear();
      if (!map || data?.source !== 'kakao-directions' || !['success', 'partial'].includes(data.state)) return;
      for (const road of roadSegments(data)) {
        const leg=road.leg,color=data.vehicle&&root.Phase2bUi?.vehicleColor?root.Phase2bUi.vehicleColor(data.vehicle):['#2463eb','#0d9a83','#9a61d3','#c77713'][leg%4];
        if(leaflet&&typeof map.addLayer==='function')lines.push(leaflet.polyline(road.latLngs,{color,weight:5,opacity:.9}).addTo(map).bindTooltip('자동차 도로경로'));
        else if(kakao?.maps?.Polyline){
          const line=new kakao.maps.Polyline({path:road.latLngs.map(p=>new kakao.maps.LatLng(p[0],p[1])),strokeColor:color,strokeWeight:5,strokeOpacity:.9,strokeStyle:'solid'});
          line.setMap(map);lines.push(line);
        }
      }
    }

    return { clear, render };
  }
  root.RoadRouteUi = { createController, describe, metrics, roadSegments, createLayer };
})(typeof window === 'object' ? window : globalThis);

