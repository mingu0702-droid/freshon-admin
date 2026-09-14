import { publicMapValue } from './phase2bSecurity.js';
import { mapReadFailure } from './mapReadFailure.js';

export function validatePeriod(startDate, endDate) {
  const valid = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(date).toISOString().slice(0, 10) === date;
  if (!valid(startDate) || !valid(endDate)) throw new Error('INVALID_PERIOD');
  const days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000;
  if (days < 0 || days > 89) throw new Error('INVALID_PERIOD');
  return { startDate, endDate };
}
export function checkPeriodPage(payload, job, { privateHistory = false, pageSize = 1000 } = {}) {
  const meta = payload?.meta, data = payload?.data;
  if (!privateHistory && meta?.contract === 'period-assignments-v2') return checkBoundedPeriodPage(payload,job,pageSize);
  if (!payload?.ok || !Array.isArray(data) || !meta || meta.contract !== (privateHistory ? 'staff-driver-history-v1' : 'period-assignments-v1')
    || meta.startDate !== job.startDate || meta.endDate !== job.endDate || meta.truncated !== false
    || meta.pageSize !== pageSize || meta.pageOffset !== job.count || meta.count !== data.length || data.length > pageSize
    || !Number.isInteger(meta.totalCount) || meta.totalCount < 0 || meta.totalCount !== meta.sourceCount
    || (job.total !== null && job.total !== meta.totalCount) || typeof meta.hasMore !== 'boolean'
    || meta.complete !== !meta.hasMore || job.count + data.length > meta.totalCount
    || (meta.hasMore ? !data.length || typeof meta.nextCursor !== 'string' || !meta.nextCursor || job.cursors.has(meta.nextCursor) || job.count + data.length >= meta.totalCount
      : meta.nextCursor !== null || job.count + data.length !== meta.totalCount)) throw new Error('PERIOD_PAGE_INCOMPLETE');
  for (const row of data) {
    if (!row.sourceKey || !row.customerCode || row.deliveryDate < job.startDate || row.deliveryDate > job.endDate
      || (privateHistory && row.customerCode !== job.customerCode) || job.keys.has(row.sourceKey)) throw new Error('PERIOD_ROW_INVALID');
    job.keys.add(row.sourceKey);
  }
  job.total = meta.totalCount; job.count += data.length; job.cursor = meta.nextCursor;
  if (meta.nextCursor) job.cursors.add(meta.nextCursor);
  return data;
}
function checkBoundedPeriodPage(payload, job, pageSize) {
  const {meta:m,data}=payload;
  const sourceOffset=job.scannedCount||0;
  if(!payload.ok||!Array.isArray(data)||m.startDate!==job.startDate||m.endDate!==job.endDate||m.truncated!==false
    ||m.pageSize!==pageSize||m.pageOffset!==job.count||m.count!==data.length||data.length>pageSize
    ||!Number.isInteger(m.sourceTotal)||m.sourceTotal<0||(job.sourceTotal!=null&&job.sourceTotal!==m.sourceTotal)
    ||m.sourceOffset!==sourceOffset||!Number.isInteger(m.sourceReadCount)||m.sourceReadCount<0||m.sourceReadCount>pageSize
    ||m.sourceReadCount<data.length||m.scannedCount!==sourceOffset+m.sourceReadCount||m.scannedCount>m.sourceTotal
    ||typeof m.hasMore!=='boolean'||m.complete!==!m.hasMore||m.totalCount!==m.sourceCount
    ||(m.hasMore?m.totalCount!==null||m.sourceReadCount===0||m.scannedCount>=m.sourceTotal||typeof m.nextCursor!=='string'||!m.nextCursor||job.cursors.has(m.nextCursor)
      :m.nextCursor!==null||m.scannedCount!==m.sourceTotal||m.totalCount!==job.count+data.length))throw new Error('PERIOD_PAGE_INCOMPLETE');
  for(const row of data){
    if(!row.sourceKey||!row.customerCode||!/^\d{4}-\d{2}-\d{2}$/.test(row.deliveryDate)||row.deliveryDate<job.startDate||row.deliveryDate>job.endDate)throw new Error('PERIOD_ROW_INVALID');
  }
  job.count+=data.length;job.total=m.totalCount;job.cursor=m.nextCursor;job.scannedCount=m.scannedCount;job.sourceTotal=m.sourceTotal;
  if(m.nextCursor)job.cursors.add(m.nextCursor);
  return data;
}
export function groupPeriodRows(rows) {
  const grouped = new Map(), seen=new Set();
  for (const raw of rows) {
    const row = publicMapValue(raw);
    const key = row.customerCode;
    const identity=JSON.stringify([key,row.deliveryDate,row.vehicle,row.driverKey||row.driverName||'',row.kind||'ASSIGNED']);
    if(seen.has(identity))continue;seen.add(identity);
    let store = grouped.get(key);
    const history = { deliveryDate: row.deliveryDate, vehicle: row.vehicle, driverName: row.driverName || '',
      driverKey: row.driverKey || '', driverIdentity: row.driverIdentity || 'UNVERIFIED', kind: row.kind || 'ASSIGNED' };
    if (!store) { store = { ...row, history: [] }; delete store.sourceKey; grouped.set(key, store); }
    if (row.deliveryDate > (store.lastDeliveryDate||store.deliveryDate)) Object.assign(store, { ...row, lastDeliveryDate:row.deliveryDate,history: store.history });
    store.history.push(history);
  }
  for (const store of grouped.values()) { store.history.sort((a,b) => b.deliveryDate.localeCompare(a.deliveryDate)); delete store.sourceKey; }
  return [...grouped.values()];
}
export function selectPeriodStores(rows,{vehicle='',driverKey=''}={}){
  if(vehicle&&driverKey)throw new Error('INVALID_PERIOD_FILTER');
  if(!vehicle&&!driverKey)return rows;
  return rows.flatMap(row=>{
    const history=(row.history||[]).filter(h=>vehicle?h.vehicle===vehicle:h.driverKey===driverKey);
    if(!history.length)return [];
    const latest=history.reduce((a,b)=>a.deliveryDate>=b.deliveryDate?a:b);
    return [{...row,...latest,lastDeliveryDate:latest.deliveryDate,history:row.history}];
  });
}

// One bounded background read at a time; no date×vehicle fan-out. Only redacted
// rows in memory. A restart discards the job safely; no source checkpoint/reset.
export function createPeriodJobs({ loadPage, schedule = setTimeout, now = Date.now }) {
  const jobs = new Map();
  let active = null, timer = null;
  function status(job) {
    return { startDate: job.startDate, endDate: job.endDate, phase: job.phase, count: job.count, totalCount: job.total,
      progress: job.phase === 'DONE' ? 100 : job.sourceTotal ? Math.floor(job.scannedCount/job.sourceTotal*100) : job.total ? Math.floor(job.count / job.total * 100) : 0,
      scannedCount:job.scannedCount||0,sourceTotal:job.sourceTotal??null,sourceRestarts:job.sourceRestarts||0,
      complete: job.phase === 'DONE', truncated: false, error: job.error || null, updatedAt: job.updatedAt,
      actualVisitsAvailable: false, source: 'Customer.daily_routes assignment history' };
  }
  function resume() {
    if (timer || active) return;
    const next = [...jobs.values()].find(job => job.phase === 'WAITING');
    if (!next) return;
    timer = schedule(() => { timer = null; void step(next); }, 1000);
    timer?.unref?.();
  }
  async function step(job) {
    if (active || job.phase !== 'WAITING') return;
    active = job; job.phase = 'RUNNING';
    try {
      const payload = await loadPage({ startDate: job.startDate, endDate: job.endDate, limit: 1000, ...(job.cursor ? {cursor:job.cursor} : {}) });
      if (Number(payload.meta?.sourceTotal??payload.meta?.totalCount) > 250000 || job.pages >= 250) throw new Error('PERIOD_CAPACITY_LIMIT');
      // Validate on separate sets first, so a failed batch cannot corrupt resume.
      const check = { ...job, keys: new Set(job.keys), cursors: new Set(job.cursors) };
      const rows = checkPeriodPage(payload, check);
      Object.assign(job, { keys: check.keys, cursors: check.cursors, total: check.total, count: check.count, cursor: check.cursor,scannedCount:check.scannedCount,sourceTotal:check.sourceTotal });
      job.rows.push(...rows.map(publicMapValue)); job.pages++; job.failures = 0;
      if (payload.meta.complete) {
        job.data = groupPeriodRows(job.rows); job.rows = []; job.keys.clear(); job.cursors.clear(); job.phase = 'DONE';job.completedAt=now();
      } else job.phase = 'WAITING';
      job.error = null;
    } catch (error) {
      if(error.message==='HUB_PERIOD_SOURCE_CHANGED'){
        job.sourceRestarts=(job.sourceRestarts||0)+1;
        // Invalidate ONLY this in-memory read job. Never touch collection checkpoints.
        Object.assign(job,{count:0,total:null,rows:[],data:null,cursor:null,keys:new Set(),cursors:new Set(),pages:0,scannedCount:0,sourceTotal:null,failures:0});
        job.phase=job.sourceRestarts>=3?'ERROR':'WAITING';job.error='PERIOD_SOURCE_CHANGED';
        return;
      }
      const code = /^PERIOD_/.test(error.message || '') ? error.message : mapReadFailure(error,'PERIOD').code;
      job.failures = job.lastError === code ? job.failures + 1 : 1; job.lastError = code;
      job.phase = job.failures >= 3 || code === 'PERIOD_CAPACITY_LIMIT' ? 'ERROR' : 'WAITING'; job.error = code;
    } finally { job.updatedAt = new Date(now()).toISOString(); active = null; resume(); }
  }
  return {
    read(startDate, endDate, {retry=false}={}) {
      validatePeriod(startDate, endDate);
      const key = startDate + ':' + endDate;
      let job = jobs.get(key);
      if (job && job.phase === 'DONE' && now() - job.completedAt > 10 * 60 * 1000) { jobs.delete(key); job = null; }
      if(job?.phase==='ERROR'&&retry){job.phase='WAITING';job.failures=0;job.error=null;resume();}
      if (!job) {
        // Avoid unauthenticated range requests exhausting RAM or upstream quota.
        const running = [...jobs.values()].some(item => ['RUNNING','WAITING'].includes(item.phase));
        if (running) return { ok: true, data: null, meta: { phase: 'BUSY', complete: false }, error: null };
        if (jobs.size >= 2) jobs.delete(jobs.keys().next().value);
        job = { startDate, endDate, phase: 'WAITING', count: 0, total: null, rows: [], data: null, cursor: null,
          keys: new Set(), cursors: new Set(), pages: 0, failures: 0, createdAt: now(), updatedAt: new Date(now()).toISOString() };
        jobs.set(key, job); resume();
      }
      return { ok: job.phase !== 'ERROR', data: job.phase === 'DONE' ? job.data : null, meta: status(job), error: job.phase === 'ERROR' ? job.error : null };
    }
  };
}

export async function readStaffDriverHistory({ customerCode, startDate, endDate }, loadPage) {
  validatePeriod(startDate, endDate);
  const job = { customerCode, startDate, endDate, count: 0, total: null, keys: new Set(), cursors: new Set() }, result = [];
  for (let page = 0; page < 20; page++) {
    const payload = await loadPage({ customerCode, startDate, endDate, limit: 200, ...(job.cursor ? { cursor: job.cursor } : {}) });
    const rows = checkPeriodPage(payload, job, { privateHistory: true, pageSize: 200 });
    for (const row of rows) result.push({ deliveryDate: row.deliveryDate, vehicle: row.vehicle || null, driverName: row.driverName || null,
      driverPhone: row.driverPhone || null, kind: row.kind === 'COMPLETED' ? 'COMPLETED' : 'ASSIGNED' });
    if (payload.meta.complete) return result.sort((a,b) => b.deliveryDate.localeCompare(a.deliveryDate));
  }
  throw new Error('PERIOD_HISTORY_INCOMPLETE');
}
