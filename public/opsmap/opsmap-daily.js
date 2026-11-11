(function (root) {
  "use strict";
  const vehicle = value => String(value ?? '').trim().replace(/호(?:차)?$/, '');
  const visit = (v, code) => vehicle(v) + '|' + String(code ?? '').trim();
  const calendar = time => new Date(time + 9 * 3600000).toISOString().slice(0, 10);
  const dispatch = time => new Date(time + 9 * 3600000 + (new Date(time + 9 * 3600000).getUTCHours() >= 21 ? 86400000 : 0)).toISOString().slice(0, 10);
  const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const archive = meta => meta?.reviewOnly === true && meta.source === 'STAGE_VERIFIED_DELIVERY_ARCHIVE';
  function validate(payload, date) {
    const {meta, data} = payload || {};
    const fail = () => { throw Object.assign(Error('DATED_ASSIGNMENTS_INCOMPLETE'), {code:'DATED_ASSIGNMENTS_INCOMPLETE'}); };
    if (!day(date) || payload?.ok !== true || meta?.date !== date || !Array.isArray(data)
      || data.length > 15000 || (meta.complete !== true && !archive(meta)) || meta.truncated === true || meta.hasMore === true
      || (meta.rowCount !== undefined && meta.rowCount !== data.length) || (!data.length && meta.rowCount !== 0)) fail();
    const seen = new Set();
    for (const row of data) {
      const code = row?.customerCode ?? row?.code;
      const assigned = vehicle(row?.confirmedVehicle ?? row?.vehicle) || '미확인';
      const key = visit(assigned, code);
      if (typeof code !== 'string' || !code.trim() || row.deliveryDate !== date || seen.has(key)
        || row.actualDeliveryEvents!==undefined && (!Array.isArray(row.actualDeliveryEvents)||row.actualDeliveryEvents.length>80)
        || row.confirmedVehicle && row.vehicle && vehicle(row.confirmedVehicle) !== vehicle(row.vehicle)) fail();
      seen.add(key);
    }
    return payload;
  }
  function errorLabel(error) {
    const status = Number(error?.sourceHttp ?? error?.status), code = error?.code || error?.message || '';
    if (status === 401) return '인증 필요 (401)';
    if (status === 403) return '접근 권한 없음 (403)';
    if (status === 429) return '조회 한도 초과 (429)';
    if (status === 504 || /TIMEOUT|DEADLINE/.test(code)) return '조회 시간 초과';
    if (/INCOMPLETE|PARTIAL|^DATED_ASSIGNMENTS_|GENERATION_CHANGED/.test(code)) return '부분 페이지 또는 조회 검증 실패';
    if (/REQUEST_CANCELLED|QUERY_CANCELLED/.test(code) || error?.name === 'AbortError') return '조회 취소';
    if (/AUTH|SESSION_REQUIRED/.test(code)) return '원천 인증 실패';
    if ([500,502,503].includes(status)) return '조회 서버 오류 (' + status + ')';
    return '배송지 조회 실패';
  }
  function projection(rows, filter) {
    const shown = filter === 'ALL' ? rows : rows.filter(row => row.status === filter);
    const completed = rows.filter(row => row.status === 'COMPLETED').length;
    const pending = rows.filter(row => row.status === 'PENDING').length;
    return {shown, completed, pending, unknown:rows.length - completed - pending};
  }
  const kinds = new Set(['DIRECT_HANDOFF','DELIVERY_COMPLETED']);
  function actualPoints(rows) {
    const events = new Map();
    for (const row of rows) {
      const evidence = row.actualDeliveryEvents?.length ? row.actualDeliveryEvents : [row.actualDeliveryEvent];
      for(const e of evidence){
      if (row.status !== 'COMPLETED' || !row.customerCode || !row.vehicle || !Number.isFinite(row.lat) || !Number.isFinite(row.lng)
        || Math.abs(row.lat) > 90 || Math.abs(row.lng) > 180 || row.coordinateStatus === 'CONFLICT'
        || !kinds.has(e?.kind) || e.individual !== true || !e.deliveryId || typeof e.at !== 'string'
        || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(e.at)
        || !day(e.at.slice(0, 10))) continue;
      const time = Date.parse(e.at);
      if (!Number.isFinite(time)) continue;
      const previous = events.get(e.deliveryId);
      if (!previous || time < previous.time || time===previous.time && e.at.localeCompare(previous.at)<0) events.set(e.deliveryId, {row, at:e.at, time});
      }
    }
    return [...events.values()].sort((a,b) => a.time - b.time || a.at.localeCompare(b.at) || visit(a.row.vehicle,a.row.customerCode).localeCompare(visit(b.row.vehicle,b.row.customerCode)));
  }

  const centers = Object.freeze({osan:'1', osanColdStorage:'2', yeongnam:'3', honam:'4'});
  const sourceStates = new Set(['LIVE_VERIFIED', 'STALE_VERIFIED', 'PUBLISHED_VERIFIED']);
  const visitStates = new Set(['OPEN', 'COMPLETED', 'CANCELLED']);
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const rosterError = () => Object.assign(Error('DATED_ASSIGNMENTS_INCOMPLETE'), {code:'DATED_ASSIGNMENTS_INCOMPLETE'});
  function verifyRoster(payload, date, center, selectedVehicle=null) {
    if (payload?.contract !== 'opsmap-dated-delivery-v1' || payload.date !== date || payload.center !== center ||
      payload.sourceId !== centers[center] || payload.vehicle !== selectedVehicle ||
      !sourceStates.has(payload.state) || payload.sourceComplete !== true ||
      payload.currentReadComplete !== (payload.state === 'LIVE_VERIFIED') ||
      typeof payload.scopeComplete !== 'boolean' || typeof payload.confirmedEmpty !== 'boolean' ||
      !Array.isArray(payload.rows) || payload.rows.length > 10000 || payload.count !== payload.rows.length ||
      !Number.isInteger(payload.activeCount) || !digest(payload.sha256) || !digest(payload.source?.sha256) ||
      !Number.isInteger(payload.source.unassigned) || payload.source.unassigned < 0 ||
      (!selectedVehicle && payload.source.uniqueDeliveries !== payload.count) ||
      (payload.state === 'LIVE_VERIFIED' && !iso(payload.lastSuccessAt)) ||
      (payload.confirmedEmpty && (!payload.scopeComplete || !payload.currentReadComplete || payload.count !== 0))) {
      throw rosterError();
    }
    const ids = new Set();
    let activeCount = 0;
    for (const row of payload.rows) {
      if (row?.deliveryDate !== date || !digest(row.deliveryId) || ids.has(row.deliveryId) ||
        typeof row.customerCode !== 'string' || !row.customerCode.trim() || !visitStates.has(row.state) ||
        (row.vehicle !== null && (typeof row.vehicle !== 'string' || !row.vehicle || vehicle(row.vehicle) !== row.vehicle)) ||
        (selectedVehicle && row.vehicle !== selectedVehicle)) throw rosterError();
      ids.add(row.deliveryId);
      if (row.state !== 'CANCELLED') activeCount++;
    }
    if (activeCount !== payload.activeCount) throw rosterError();
    return payload;
  }
  function rosterRows(scopes) {
    const rows = new Map();
    for (const scope of scopes) {
      for (const row of scope.rows) {
        if (row.state === 'CANCELLED') continue;
        if (rows.has(row.deliveryId)) throw rosterError();
        rows.set(row.deliveryId, {...row, dispatchCenterCode:scope.center,
          status:row.state === 'COMPLETED' ? 'COMPLETED' : 'PENDING'});
      }
    }
    return [...rows.values()];
  }
  function sameRosterScope(a, b) {
    return a.date === b.date && a.center === b.center && a.generation === b.generation &&
      a.lastSuccessAt === b.lastSuccessAt && a.source.sha256 === b.source.sha256;
  }
  function chronology(roster, response, selectedVehicle) {
    verifyRoster(response, roster.date, roster.center, selectedVehicle);
    if (!sameRosterScope(roster, response) || !Array.isArray(response.chronology) ||
      !Array.isArray(response.chronologyTies) || response.eventRead?.failed > 0 || response.eventRead?.truncated) throw rosterError();
    const expected = new Map(roster.rows.filter(row => row.vehicle === selectedVehicle).map(row => [row.deliveryId, row]));
    if (expected.size !== response.count) throw rosterError();
    const eligible = new Map(), status = new Map();
    let explicitBulk = 0, verifiedAt17Kst = 0;
    for (const row of response.rows) {
      const prior = expected.get(row.deliveryId);
      if (!prior || prior.customerCode !== row.customerCode || prior.state !== row.state) throw rosterError();
      if (row.state !== 'COMPLETED') continue;
      status.set(row.deliveryId, null);
      if (row.verification === 'BULK_CONFIRMED' && row.bulkProcessed === true) explicitBulk++;
      if (row.verification === 'VERIFIED_INDIVIDUAL' && row.bulkProcessed === false &&
        kinds.has(row.completionType) && iso(row.individualCompletedAt)) {
        eligible.set(row.deliveryId, row.individualCompletedAt);
        status.set(row.deliveryId, row.individualCompletedAt);
        if (new Date(row.individualCompletedAt).getUTCHours() === 8) verifiedAt17Kst++;
      }
    }
    const tied = new Set();
    for (const group of response.chronologyTies) {
      if (!iso(group?.at) || !Array.isArray(group.deliveryIds) || group.deliveryIds.length < 2) throw rosterError();
      for (const id of group.deliveryIds) {
        if (tied.has(id) || eligible.get(id) !== group.at) throw rosterError();
        tied.add(id);
      }
    }
    let previous = '';
    const points = new Map();
    for (const id of response.chronology) {
      const at = eligible.get(id);
      if (!at || tied.has(id) || at <= previous) throw rosterError();
      points.set(id, at);
      previous = at;
    }
    if (points.size + tied.size !== eligible.size) throw rosterError();
    return {points, status, tiedCount:tied.size, explicitBulk, verifiedAt17Kst};
  }
  function rosterPoints(rows, points) {
    const byId = new Map(rows.map(row => [row.deliveryId, row]));
    return [...points].flatMap(([id, at]) => {
      const row = byId.get(id);
      return row?.status === 'COMPLETED' && Number.isFinite(row.lat) && Math.abs(row.lat) <= 90 &&
        Number.isFinite(row.lng) && Math.abs(row.lng) <= 180 && row.coordinateStatus !== 'CONFLICT' ? [{row, at}] : [];
    });
  }
  root.OpsmapDaily = Object.freeze({archive, calendar, day, dispatch, errorLabel, validate, projection, actualPoints, centers, verifyRoster, rosterRows, sameRosterScope, chronology, rosterPoints});
})(globalThis);
