// A dated assignment must never fall back to a rolling vehicle relationship.
// Source identities are compared only when supplied by the upstream contract.
// Absence is never rewritten into a fabricated version or currentness proof.
function pageSourceIdentity(meta = {}) {
  const identity = {};
  for (const key of ['sourceVersion', 'sourceDriveVersion', 'driveVersion', 'generation']) {
    const value = meta[key];
    if (value !== undefined && value !== null && value !== '') {
      if (key === 'generation' ? !(typeof value === 'string' && value.length <= 128 || Number.isSafeInteger(value)) : typeof value !== 'string' || value.length > 128) throw new Error('DATED_ASSIGNMENTS_SOURCE_IDENTITY_INVALID');
      identity[key] = value;
    }
  }
  return Object.keys(identity).length ? JSON.stringify(identity) : null;
}
function observeSourceIdentity(meta, observed) {
  const identity = pageSourceIdentity(meta);
  if (observed.seen && identity !== observed.identity) throw new Error('DATED_ASSIGNMENTS_SOURCE_VERSION_CHANGED');
  observed.seen = true; observed.identity = identity;
}
export async function readPaginatedDatedAssignments(date, loadPage, { pageSize = 1000, maxPages = 50 } = {}) {
  const rows = [], pages = [], cursors = new Set(), sourceKeys = new Set();
  let cursor = null, total = null;
  const sourceIdentity = { seen: false, identity: null };
  for (let page = 0; page < maxPages; page++) {
    const payload = await loadPage({ date, limit: pageSize, ...(cursor ? { cursor } : {}) });
    const meta = payload?.meta;
    if (payload?.ok !== true || !Array.isArray(payload.data) || !meta || meta.contract !== "dated-assignments-v1" || meta.date !== date) throw new Error("DATED_ASSIGNMENTS_INVALID_PAGE");
    if (!Number.isInteger(meta.totalCount) || meta.totalCount < 0 || meta.sourceCount !== meta.totalCount || (total !== null && total !== meta.totalCount)) throw new Error("DATED_ASSIGNMENTS_TOTAL_CHANGED");
    observeSourceIdentity(meta, sourceIdentity);
    total = meta.totalCount;
    if (meta.pageOffset !== rows.length || meta.count !== payload.data.length || meta.count > pageSize || meta.pageSize !== pageSize || meta.truncated !== false) throw new Error("DATED_ASSIGNMENTS_PAGE_GAP");
    if (typeof meta.hasMore !== "boolean" || meta.complete !== !meta.hasMore || (meta.hasMore ? typeof meta.nextCursor !== "string" || !meta.nextCursor : meta.nextCursor !== null)) throw new Error("DATED_ASSIGNMENTS_CURSOR_INVALID");
    if (meta.hasMore && (cursors.has(meta.nextCursor) || meta.nextCursor === cursor)) throw new Error("DATED_ASSIGNMENTS_CURSOR_REPEATED");
    for (const row of payload.data) {
      if (row.deliveryDate !== date || !row.customerCode || !row.sourceKey) throw new Error("DATED_ASSIGNMENTS_ROW_INVALID");
      if (sourceKeys.has(row.sourceKey)) throw new Error("DATED_ASSIGNMENTS_DUPLICATE_SOURCE_ROW");
      sourceKeys.add(row.sourceKey); rows.push(row);
    }
    if (rows.length > total || (meta.hasMore && rows.length >= total)) throw new Error("DATED_ASSIGNMENTS_COUNT_MISMATCH");
    pages.push({ offset: meta.pageOffset, count: meta.count });
    if (!meta.hasMore) {
      if (rows.length !== total) throw new Error("DATED_ASSIGNMENTS_COUNT_MISMATCH");
      // Dedupe by the actual assignment identity, retaining source order and
      // unassigned/unlocated customers. No rolling vehicle or coordinate filter.
      const unique = new Map();
      for (const row of rows) {
        const vehicle = String(row.confirmedVehicle || row.vehicle || "").replace(/호(?:차)?$/, "");
        const key = `${row.customerCode}|${vehicle}`;
        if (!unique.has(key)) unique.set(key, { ...row, vehicle });
      }
      const data = [...unique.values()];
      return { ok: true, data, meta: { date, source: "Hub datedAssignments pagination", sourceCount: total,
        rawCount: rows.length, rowCount: data.length, duplicateCount: rows.length - data.length, pages,
        missingCoordinate: data.filter(row => row.lat == null || row.lng == null).length,
        sourceIdentityConsistent: sourceIdentity.identity !== null,
        sourceIdentity: sourceIdentity.identity ? JSON.parse(sourceIdentity.identity) : null,
        complete: true, truncated: false, hasMore: false }, error: null };
    }
    cursors.add(meta.nextCursor); cursor = meta.nextCursor;
  }
  throw new Error("DATED_ASSIGNMENTS_PAGE_LIMIT");
}

export function assertDatedAssignmentSource(payload, date, { sourceIdentity = { seen: false, identity: null }, limit = 2000, allowCapped = false } = {}) {
  if (payload?.ok === false || !Array.isArray(payload?.data)) throw new Error("DATED_ASSIGNMENTS_UNAVAILABLE");
  const meta = payload.meta || {};
  if (date && meta.date && meta.date !== date) throw new Error('DATED_ASSIGNMENTS_DATE_MISMATCH');
  if (meta.truncated === true || meta.partial === true || meta.complete === false && meta.hasMore !== true || meta.hasMore === true && payload.data.length < limit) throw new Error('DATED_ASSIGNMENTS_SOURCE_TRUNCATED');
  if (meta.returnedCount !== undefined && meta.returnedCount !== payload.data.length || meta.returned !== undefined && meta.returned !== payload.data.length) throw new Error('DATED_ASSIGNMENTS_COUNT_MISMATCH');
  observeSourceIdentity(meta, sourceIdentity);
  // Hub applies its source limit before the geographic filter. Splitting a tile
  // cannot recover that missing source page, so never report it as complete.
  // HubDataLayer.MAX_LIMIT is 1000 even when mapBounds requests limit=2000.
  if (Number(payload.meta?.sourceCount) >= 1000) throw new Error("DATED_ASSIGNMENTS_SOURCE_TRUNCATED");
  if (!allowCapped && payload.data.length >= limit) throw new Error('DATED_ASSIGNMENTS_TRUNCATED');
  return payload.data;
}

export async function readDatedAssignments(date, bounds, loadTile, depth = 0, sourceIdentity = { seen: false, identity: null }) {
  const payload = await loadTile({ mode: "DATE_ROUTE", date, vehicle: "", bounds, limit: 2000 });
  assertDatedAssignmentSource(payload, date, { sourceIdentity, allowCapped: true });
  if (payload.data.length >= 2000) {
    if (depth >= 8) throw new Error("DATED_ASSIGNMENTS_TRUNCATED");
    const axis = bounds.north - bounds.south >= bounds.east - bounds.west ? "lat" : "lng";
    const mid = axis === "lat" ? (bounds.north + bounds.south) / 2 : (bounds.east + bounds.west) / 2;
    const halves = axis === "lat" ? [{ ...bounds, north: mid }, { ...bounds, south: mid }] : [{ ...bounds, east: mid }, { ...bounds, west: mid }];
    // Sequential subdivisions bound Hub concurrency and avoid dropping capped tiles.
    const rows = [];
    for (const half of halves) rows.push(...await readDatedAssignments(date, half, loadTile, depth + 1, sourceIdentity));
    return uniqueAssignments(rows, date);
  }
  return uniqueAssignments(payload.data, date);
}

export function uniqueAssignments(rows, date) {
  const unique = new Map();
  for (const row of rows) {
    const actual = String(row.deliveryDate || row.lastDeliveryDate || "").slice(0, 10);
    if (actual && actual !== date) throw new Error("DATED_ASSIGNMENTS_DATE_MISMATCH");
    const code = String(row.customerCode || row.code || "").trim();
    const vehicle = String(row.vehicle || row.confirmedVehicle || "").replace(/호(?:차)?$/, "");
    if (code && (vehicle || actual === date)) unique.set(`${vehicle}|${code}`, { ...row, customerCode: code, vehicle, deliveryDate: date, lastDeliveryDate: date });
  }
  return [...unique.values()];
}
