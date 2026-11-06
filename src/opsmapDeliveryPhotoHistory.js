import {deliveryDate, hasFrontDoorCompletion, validDeliveryId} from './opsmapDeliveryPhotos.js';

const DAY_MS = 86400000, PAGE_SIZE = 50, MAX_PAGES = 4, MAX_DELIVERIES = 8, MAX_PHOTOS = 48;
const newestFirst = (a, b) => b.date.localeCompare(a.date)
  || b.deliveryId.length - a.deliveryId.length || b.deliveryId.localeCompare(a.deliveryId);

export function createDeliveryPhotoHistoryReader({searchFrontDoorTasks, listHistoryRecord, hasSession, now = Date.now}) {
  return async ({customerCode}, {signal} = {}) => {
    // The provider search covers a bounded date range and has no authoritative
    // code-change links. Matching addresses cannot establish a store identity.
    const result = {coverage:'INCOMPLETE', deliveries:[]};
    if (!hasSession()) return result;
    const current = new Date(now() + 9 * 3600000).toISOString().slice(0, 10);
    const startDate = new Date(Date.parse(current) - 364 * DAY_MS).toISOString().slice(0, 10);
    const deadline = AbortSignal.timeout(11000);
    const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const candidates = new Map(), conflicts = new Set();
    for (let page = 0; page < MAX_PAGES && !readSignal.aborted; page++) {
      let payload;
      try { payload = await searchFrontDoorTasks({customerCode, startDate, endDate:current, page}, {signal:readSignal}); }
      catch { break; }
      const batch = payload?.data ?? payload;
      if (payload?.ok === false || payload?.success === false || payload?.error
        || !Array.isArray(batch?.content) || batch.content.length > PAGE_SIZE) break;
      for (const task of batch.content) {
        // The provider's code filter is a substring search. Recheck exact code,
        // task state, date, and source ID before using a result.
        if (task?.customer?.erpCode !== customerCode || !hasFrontDoorCompletion(task) || !validDeliveryId(task.id)) continue;
        const date = deliveryDate(task.carrier?.enteringDatedAt);
        if (!date || date < startDate || date > current) continue;
        const deliveryId = String(task.id);
        if (candidates.has(deliveryId) && candidates.get(deliveryId).date !== date) conflicts.add(deliveryId);
        candidates.set(deliveryId, {customerCode, date, deliveryId});
      }
      if (batch.last === true || batch.content.length < PAGE_SIZE) break;
    }
    const pending = [...candidates.values()].filter(row => !conflicts.has(row.deliveryId)).sort(newestFirst).slice(0, MAX_DELIVERIES);
    const checked = [];
    const verify = async () => {
      while (pending.length && !readSignal.aborted) {
        try {
          const row = await listHistoryRecord(pending.shift(), {signal:readSignal});
          if (row.photos.length) checked.push(row);
        } catch {
          // Keep confirmed records when another task has missing or changed evidence.
        }
      }
    };
    await Promise.all([verify(), verify()]);
    let remaining = MAX_PHOTOS;
    for (const row of checked.sort(newestFirst)) {
      if (!remaining) break;
      const photos = row.photos.slice(0, remaining);
      result.deliveries.push({...row, photos});
      remaining -= photos.length;
    }
    return result;
  };
}
