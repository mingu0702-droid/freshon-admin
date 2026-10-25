// Local source adapters only. No route, credentials, source write, or publication.
import { createHash } from 'node:crypto';
import { isDay, validActualVehicle } from '../public/hybrid-map-contract.mjs';

const fail = code => { throw Error(code); };
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeText = (value, max) => typeof value === 'string' && value.length <= max
  && !/[\r\n\x00-\x1f]|비밀번호|출입번호|도어락|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/.test(value);
const codeValid = value => typeof value === 'string' && /^[A-Z]\d+$/.test(value);
function utf8Bytes(value) {
  let count = 0;
  for (const char of value) { const code = char.codePointAt(0); count += code <= 127 ? 1 : code <= 2047 ? 2 : code <= 65535 ? 3 : 4; }
  return count;
}
function coordinates(lat, lng) {
  if (lat === '' || lat === undefined) lat = null;
  if (lng === '' || lng === undefined) lng = null;
  if (lat === null && lng === null) return [null, null];
  if (typeof lat === 'string') lat = Number(lat);
  if (typeof lng === 'string') lng = Number(lng);
  if (!Number.isFinite(lat) || lat < 33 || lat > 39.5 || !Number.isFinite(lng) || lng < 124 || lng > 132) fail('SOURCE_COORDINATE_INVALID');
  return [lat, lng];
}
function masterTime(value) {
  if (typeof value !== 'string') fail('MASTER_TIME_INVALID');
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match || !isDay(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59) fail('MASTER_TIME_INVALID');
  return `${match[1]}T${match[2].padStart(2, '0')}:${match[3]}:${match[4]}+09:00`;
}
function publicMetadata(row, addressField, retainUnavailable = false) {
  if (!row || !codeValid(row.customerCode)) fail('MASTER_ROW_INVALID');
  const address = addressField === 'customerAddress' && typeof row.customerAddress === 'string'
    && (row.detailAddress === undefined || typeof row.detailAddress === 'string')
    ? [row.customerAddress, row.detailAddress || ''].map(value => value.trim()).filter(Boolean).join(' ') : row[addressField];
  const nameSafe = safeText(row.customerName, 200), addressSafe = safeText(address, 250)
    && (addressField !== 'customerAddress' || row.detailAddress === undefined || typeof row.detailAddress === 'string');
  let point;
  try { point = coordinates(row.lat, row.lng); } catch (error) { if (!retainUnavailable) throw error; }
  if (!nameSafe || !addressSafe || !point) {
    if (!retainUnavailable) fail('MASTER_ROW_INVALID');
    return { customerCode: row.customerCode, customerName: nameSafe ? row.customerName : row.customerCode,
      address: addressSafe ? address : '', lat: null, lng: null, metadataIssue: 'PUBLIC_METADATA_REVIEW_REQUIRED' };
  }
  return { customerCode: row.customerCode, customerName: row.customerName, address, lat: point[0], lng: point[1] };
}

// Membership is independent of the history window. Duplicate master snapshots
// are resolved by their recorded KST update time, never by delivery presence.
// ALL_KNOWN_STORES deliberately does not claim authoritative membership/currentness.
export function buildAllKnownStoreRegistry({ masterRows, baseRows = [], historyRows = [], today }) {
  if (!isDay(today) || !Array.isArray(masterRows) || masterRows.length > 50000 || !Array.isArray(baseRows)
      || baseRows.length > 15000 || !Array.isArray(historyRows) || historyRows.length > 250000) fail('MASTER_INPUT_INVALID');
  const master = new Map(), base = new Map();
  for (const raw of masterRows) {
    const row = { ...publicMetadata(raw, 'customerAddress', true), metadataUpdatedAt: masterTime(raw.updatedAt) };
    if (row.metadataUpdatedAt.slice(0, 10) > today) fail('MASTER_TIME_INVALID');
    const prior = master.get(row.customerCode);
    if (prior && prior.metadataUpdatedAt === row.metadataUpdatedAt && JSON.stringify(prior) !== JSON.stringify(row)) fail('MASTER_LATEST_CONFLICT');
    if (!prior || prior.metadataUpdatedAt < row.metadataUpdatedAt) master.set(row.customerCode, row);
  }
  for (const raw of baseRows) {
    const row = publicMetadata(raw, 'latestAddress', true);
    if (base.has(row.customerCode)) fail('BASE_DUPLICATE');
    base.set(row.customerCode, row);
  }
  const start = new Date(Date.parse(today) - 89 * 86400000).toISOString().slice(0, 10);
  const histories = new Map(), seen = new Set();
  for (const raw of historyRows) {
    if (!raw || !isDay(raw.deliveryDate) || raw.deliveryDate > today || !codeValid(raw.customerCode) || !validActualVehicle(raw.confirmedVehicle)) fail('REGISTRY_HISTORY_INVALID');
    if (raw.deliveryDate < start) continue;
    const key = [raw.deliveryDate, raw.customerCode, raw.confirmedVehicle].join('|');
    if (seen.has(key)) fail('REGISTRY_HISTORY_DUPLICATE');
    if (!master.has(raw.customerCode) && !base.has(raw.customerCode)) fail('REGISTRY_STORE_MISSING');
    seen.add(key);
    const list = histories.get(raw.customerCode) || [];
    list.push({ deliveryDate: raw.deliveryDate, confirmedVehicle: raw.confirmedVehicle });
    histories.set(raw.customerCode, list);
  }
  const keys = [...new Set([...master.keys(), ...base.keys()])].sort();
  if (keys.length > 15000) fail('REGISTRY_CAPACITY');
  const stores = keys.map(key => {
    let row = master.get(key) || base.get(key);
    const prior = base.get(key), history = histories.get(key) || [];
    if (master.has(key) && row.lat === null && !row.metadataIssue && prior && !prior.metadataIssue
      && prior.lat !== null && prior.address === row.address) row = { ...row, lat: prior.lat, lng: prior.lng, coordinateSource: 'MATCHING_EXISTING_BASE' };
    else if (master.has(key) && row.lat === null && !row.metadataIssue && prior && !prior.metadataIssue
      && prior.lat !== null && prior.address !== row.address) row = { ...row, coordinateState: 'ADDRESS_SOURCE_CHANGED' };
    return Object.freeze({ ...row, membershipSource: master.has(key) ? base.has(key) ? 'MASTER_AND_BASE' : 'MASTER' : 'BASE_ONLY',
      metadataSource: master.has(key) ? 'MASTER_LATEST_ROW' : 'EXISTING_BASE', history: Object.freeze(history.map(Object.freeze)),
      recentHistoryStatus: history.length ? 'RECORDED_ASSIGNMENT' : 'UNCONFIRMED', orderAbsenceConfirmed: false });
  });
  return Object.freeze({ scope: 'ALL_KNOWN_STORES', membershipComplete: false, startDate: start, endDate: today,
    masterUniqueCount: master.size, baseUniqueCount: base.size, count: stores.length, stores: Object.freeze(stores), hash: sha(stores) });
}

export const DAILY_ROUTE_COLUMNS = Object.freeze(['deliveryDate','confirmedVehicle','baseVehicle','truckTon','driverName','driverPhone',
  'deliveryArea','customerCode','customerName','salesAmount','deliveryCount','customerAddress','detailAddress','accessMemo','createdAt','updatedAt','hashKey']);

// A content hash of a bounded read is useful evidence, but cannot prove that an
// unobserved row elsewhere in the Current sheet does not belong to this date.
export function inspectCurrentDayRows({ date, rows }) {
  if (!isDay(date) || !Array.isArray(rows) || rows.length > 20000) fail('CURRENT_DAY_INPUT_INVALID');
  const seen = new Set();
  const safe = rows.map(raw => {
    if (!raw || raw.deliveryDate !== date || !codeValid(raw.customerCode) || !validActualVehicle(raw.confirmedVehicle)) fail('CURRENT_DAY_ROW_INVALID');
    const key = [date, raw.customerCode, raw.confirmedVehicle].join('|');
    if (raw.sourceKey !== key || seen.has(key)) fail('CURRENT_DAY_IDENTITY_INVALID');
    seen.add(key);
    return Object.freeze({ deliveryDate: date, customerCode: raw.customerCode, confirmedVehicle: raw.confirmedVehicle, sourceKey: key });
  });
  return Object.freeze({ date, count: safe.length, contentHash: sha(safe), rows: Object.freeze(safe), coverageComplete: false });
}

// Version must originate in native Drive metadata, not modifiedTime, row count,
// or a digest invented by this adapter. A trusted date locator must cover ALL
// rows of this date; its provider and persistence are not implemented here.
export function createCurrentDaySourceProvider({ sourceId, sheetId, readSnapshot }) {
  if (typeof sourceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sourceId) || !Number.isSafeInteger(sheetId) || sheetId < 0 || typeof readSnapshot !== 'function') fail('CURRENT_SOURCE_CONFIG_INVALID');
  const validated = new WeakSet();
  async function capture(date) {
    if (!isDay(date)) fail('CURRENT_DAY_INPUT_INVALID');
    const snapshot = await readSnapshot({ date, sourceId, sheetId, sourceScope: 'CURRENT_ONLY', maxRows: 20000 });
    if (!snapshot || snapshot.sourceId !== sourceId || snapshot.sheetId !== sheetId || snapshot.sourceScope !== 'CURRENT_ONLY'
      || JSON.stringify(snapshot.headers) !== JSON.stringify(DAILY_ROUTE_COLUMNS)) fail('CURRENT_SOURCE_CONTRACT');
    const proof = snapshot.revisionProof;
    if (!proof || proof.kind !== 'NATIVE_DRIVE_VERSION' || typeof proof.before !== 'string' || !/^[1-9]\d{0,31}$/.test(proof.before)) fail('CURRENT_SOURCE_REVISION_UNAVAILABLE');
    if (proof.after !== proof.before) fail('CURRENT_SOURCE_MOVED');
    if (snapshot.locator?.date !== date || snapshot.locator.scope !== 'ALL_MATCHING_CURRENT_ROWS' || snapshot.locator.complete !== true
      || snapshot.locator.sourceVersion !== proof.before || !Number.isSafeInteger(snapshot.locator.count) || snapshot.locator.count !== snapshot.rows?.length) fail('CURRENT_DATE_LOCATOR_UNVERIFIED');
    const inspection = inspectCurrentDayRows({ date, rows: snapshot.rows });
    let bytes = 2;
    const rows = snapshot.rows.map(raw => {
      const clean = { ...publicMetadata({ ...raw, customerName: raw.customerName || '', address: raw.address || '' }, 'address'),
        deliveryDate: date, confirmedVehicle: raw.confirmedVehicle, sourceKey: raw.sourceKey };
      bytes += utf8Bytes(JSON.stringify(clean)) + 1;
      if (bytes > 4 * 1048576) fail('CURRENT_SNAPSHOT_BYTE_LIMIT');
      return Object.freeze(clean);
    });
    const revision = sha({ sourceId, sheetId, date, nativeVersion: proof.before, rows });
    const value = Object.freeze({ date, sourceRevision: revision, nativeVersion: proof.before, count: inspection.count, rows: Object.freeze(rows) });
    validated.add(value);
    return value;
  }
  function page(snapshot, { date, limit = 300, cursor }) {
    if (!snapshot || !validated.has(snapshot) || snapshot.date !== date || !Number.isInteger(limit) || limit < 1 || limit > 300) fail('CURRENT_SNAPSHOT_UNAVAILABLE');
    let offset = 0;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length > 128) fail('CURRENT_CURSOR_INVALID');
      const match = /^c_([a-f0-9]{64})_(\d{1,3})_(\d{1,5})$/.exec(cursor);
      if (!match || match[1] !== snapshot.sourceRevision || +match[2] !== limit || +match[3] < 1 || +match[3] % limit !== 0) fail('CURRENT_CURSOR_INVALID');
      offset = +match[3];
    }
    if (offset >= snapshot.count && offset !== 0) fail('CURRENT_CURSOR_INVALID');
    const data = snapshot.rows.slice(offset, offset + limit), end = offset + data.length, hasMore = end < snapshot.count;
    const response = { ok: true, data, meta: { contract: 'dated-assignments-v1', date, sourceScope: 'CURRENT_ONLY', sourceRevision: snapshot.sourceRevision,
      sourceCount: snapshot.count, totalCount: snapshot.count, count: data.length, pageOffset: offset, pageSize: limit,
      hasMore, complete: !hasMore, truncated: false, nextCursor: hasMore ? `c_${snapshot.sourceRevision}_${limit}_${end}` : null } };
    if (utf8Bytes(JSON.stringify(response)) > 262144) fail('CURRENT_PAGE_BYTE_LIMIT');
    return response;
  }
  function asIndexSource(snapshot) {
    if (!snapshot || !validated.has(snapshot)) fail('CURRENT_SNAPSHOT_UNAVAILABLE');
    const check = q => { if (q.date !== snapshot.date || q.sourceScope !== 'CURRENT_ONLY') fail('CURRENT_SOURCE_CONTRACT'); };
    return {
      readSourceRevision: async q => { check(q); return snapshot.sourceRevision; },
      readSourcePage: async q => { check(q); return page(snapshot, q); }
    };
  }
  return { capture, page, asIndexSource };
}
