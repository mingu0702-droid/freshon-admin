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
  function deliveryEvidence(value,{date,center,vehicle,generation}) {
    if(value?.contract!=='opsmap-dated-delivery-v1'||value.date!==date||value.center!==center||value.vehicle!==vehicle||
      value.sourceComplete!==true||!['LIVE_VERIFIED','STALE_VERIFIED','PUBLISHED_VERIFIED'].includes(value.state)||
      value.generation&&generation&&value.generation!==generation||!Array.isArray(value.rows)||!Array.isArray(value.chronology)||
      !Array.isArray(value.chronologyTies)||value.count!==value.rows.length||value.rows.length>10000)return null;
    const chronological=new Set(value.chronology), byCustomer=new Map(), seen=new Set();
    for(const tie of value.chronologyTies){
      if(!Array.isArray(tie?.deliveryIds)||tie.deliveryIds.some(id=>chronological.has(id)))return null;
    }
    for(const row of value.rows){
      if(row.deliveryDate!==date||row.vehicle!==vehicle||!row.customerCode||!row.deliveryId||seen.has(row.deliveryId)||
        !['OPEN','COMPLETED','CANCELLED'].includes(row.state))return null;
      seen.add(row.deliveryId);
      if(row.state==='CANCELLED')continue;
      const group=byCustomer.get(row.customerCode)||{completed:0,open:0,events:[]};
      group[row.state==='COMPLETED'?'completed':'open']++;
      if(row.state==='COMPLETED'&&row.verification==='VERIFIED_INDIVIDUAL'&&row.bulkProcessed===false&&
        chronological.has(row.deliveryId)&&kinds.has(row.completionType)&&Number.isFinite(Date.parse(row.individualCompletedAt))) {
        group.events.push({kind:row.completionType,at:row.individualCompletedAt,individual:true,deliveryId:row.deliveryId});
      }
      byCustomer.set(row.customerCode,group);
    }
    if([...chronological].some(id=>!seen.has(id)))return null;
    return {byCustomer,state:value.state,error:value.error||null};
  }
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
  root.OpsmapDaily = Object.freeze({archive, calendar, day, dispatch, errorLabel, validate, projection, actualPoints, deliveryEvidence});
})(globalThis);
