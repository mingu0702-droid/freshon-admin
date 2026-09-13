import { publicMapValue } from './phase2bSecurity.js';

export function validatePeriod(startDate, endDate) {
  const valid = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(date).toISOString().slice(0, 10) === date;
  if (!valid(startDate) || !valid(endDate)) throw new Error('INVALID_PERIOD');
  const days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000;
  if (days < 0 || days > 89) throw new Error('INVALID_PERIOD');
  return { startDate, endDate };
}
export function checkPeriodPage(payload, job, { privateHistory = false, pageSize = 1000 } = {}) {
  const meta = payload?.meta, data = payload?.data;
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
export function groupPeriodRows(rows) {
  const grouped = new Map();
  for (const raw of rows) {
    const row = publicMapValue(raw);
    const key = row.customerCode;
    let store = grouped.get(key);
    const history = { deliveryDate: row.deliveryDate, vehicle: row.vehicle, driverName: row.driverName || '',
      driverKey: row.driverKey || '', driverIdentity: row.driverIdentity || 'UNVERIFIED', kind: row.kind || 'ASSIGNED' };
    if (!store) { store = { ...row, history: [] }; delete store.sourceKey; grouped.set(key, store); }
    if (row.deliveryDate > store.lastDeliveryDate) Object.assign(store, { ...row, history: store.history });
    store.history.push(history);
  }
  for (const store of grouped.values()) { store.history.sort((a,b) => b.deliveryDate.localeCompare(a.deliveryDate)); delete store.sourceKey; }
  return [...grouped.values()];
}

// One bounded background read at a time; no date×vehicle fan-out. Only redacted
// rows in memory. A restart discards the job safely; no source checkpoint/reset.
export function createPeriodJobs({ loadPage, schedule = setTimeout, now = Date.now }) {
  const jobs = new Map();
  let active = null, timer = null;
  function status(job) {
    return { startDate: job.startDate, endDate: job.endDate, phase: job.phase, count: job.count, totalCount: job.total,
      progress: job.phase === 'DONE' ? 100 : job.total ? Math.floor(job.count / job.total * 100) : 0,
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
      if (Number(payload.meta?.totalCount) > 250000 || job.pages >= 250) throw new Error('PERIOD_CAPACITY_LIMIT');
      // Validate on separate sets first, so a failed batch cannot corrupt resume.
      const check = { ...job, keys: new Set(job.keys), cursors: new Set(job.cursors) };
      const rows = checkPeriodPage(payload, check);
      Object.assign(job, { keys: check.keys, cursors: check.cursors, total: check.total, count: check.count, cursor: check.cursor });
      job.rows.push(...rows.map(publicMapValue)); job.pages++; job.failures = 0;
      if (payload.meta.complete) {
        job.data = groupPeriodRows(job.rows); job.rows = []; job.keys.clear(); job.cursors.clear(); job.phase = 'DONE';
      } else job.phase = 'WAITING';
      job.error = null;
    } catch (error) {
      const code = /^PERIOD_/.test(error.message || '') ? error.message : 'PERIOD_SOURCE_UNAVAILABLE';
      job.failures = job.lastError === code ? job.failures + 1 : 1; job.lastError = code;
      job.phase = job.failures >= 3 || code === 'PERIOD_CAPACITY_LIMIT' ? 'ERROR' : 'WAITING'; job.error = code;
    } finally { job.updatedAt = new Date(now()).toISOString(); active = null; resume(); }
  }
  return {
    read(startDate, endDate) {
      validatePeriod(startDate, endDate);
      const key = startDate + ':' + endDate;
      let job = jobs.get(key);
      if (job && job.phase === 'DONE' && now() - job.createdAt > 10 * 60 * 1000) { jobs.delete(key); job = null; }
      if (!job) {
        // Avoid unauthenticated range requests exhausting RAM or upstream quota.
        const running = [...jobs.values()].some(item => ['RUNNING','WAITING'].includes(item.phase));
        if (running) return { ok: false, data: null, meta: { phase: 'BUSY', complete: false }, error: 'PERIOD_BUSY' };
        if (jobs.size >= 2) jobs.delete(jobs.keys().next().value);
        job = { startDate, endDate, phase: 'WAITING', count: 0, total: null, rows: [], data: null, cursor: null,
          keys: new Set(), cursors: new Set(), pages: 0, failures: 0, createdAt: now(), updatedAt: new Date(now()).toISOString() };
        jobs.set(key, job); resume();
      }
      return { ok: job.phase !== 'ERROR', data: job.phase === 'DONE' ? job.data : null, meta: status(job), error: job.error || null };
    }
  };
}

export async function readStaffDriverHistory({ customerCode, startDate, endDate }, loadPage) {
  validatePeriod(startDate, endDate);
  const job = { customerCode, startDate, endDate, count: 0, total: null, keys: new Set(), cursors: new Set() }, result = [];
  for (let page = 0; page < 5; page++) {
    const payload = await loadPage({ customerCode, startDate, endDate, limit: 200, ...(job.cursor ? { cursor: job.cursor } : {}) });
    const rows = checkPeriodPage(payload, job, { privateHistory: true, pageSize: 200 });
    for (const row of rows) result.push({ deliveryDate: row.deliveryDate, vehicle: row.vehicle || null, driverName: row.driverName || null,
      driverPhone: row.driverPhone || null, kind: row.kind === 'COMPLETED' ? 'COMPLETED' : 'ASSIGNED' });
    if (payload.meta.complete) return result.sort((a,b) => b.deliveryDate.localeCompare(a.deliveryDate));
  }
  throw new Error('PERIOD_HISTORY_INCOMPLETE');
}
