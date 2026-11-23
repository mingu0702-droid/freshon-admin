import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as decompress } from 'node:zlib';
import { fixedDeliveryWeekdays } from '../../public/opsmap/fixed-delivery-weekdays.mjs';
import { boundedRead, isDay, postalCompleteCenters, privateCoverageDirectory } from './coverageFiles.js';
import { canonicalFixedMasterVehicle, isProjectedFixedMasterVehicle } from '../fixedMasterVehicle.js';

export const POSTAL_STORE_PAGE = 12;
export const POSTAL_HISTORY_PAGE = 12;
export const POSTAL_STORE_FILTERS = ['all', 'confirmed', 'candidate', 'unknown', 'new', 'held'];
const centers = ['osan', 'yeongnam', 'honam', 'unknown'];
const codes = /^[A-Z]\d{1,20}$/;
const digest = /^[a-f0-9]{64}$/;
const vehiclePattern = /^(?:[용척]?\d{1,4}(?:-\d{1,3})?|오산신규|오산보류|보류)$/;
const sensitive = /[\u0000-\u001f]|비밀번호|보안키|공동현관|bearer\s|(?:01[016789]|0[2-6][1-5]?)[ )-]*\d{3,4}[- ]?\d{4}/i;
const maxRawHistory = 2 * 1024 * 1024;
const gunzip = promisify(decompress);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const centerIn = (center, i) => center === 'all' || center === centers[i];
const norm = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s·]/g, '');
const safeText = (value, max) => typeof value === 'string' && value.length <= max && !sensitive.test(value) ? value : null;
const safeVehicle = value => typeof value === 'string' && vehiclePattern.test(value) ? value : null;
const bad = () => { throw Error('POSTAL_DETAILS_INTEGRITY'); };

function validateIndex(value, opened, releaseSha) {
  const { manifest, release } = opened;
  if (value?.schema !== 'opsmap-postal-details-v1' || value.generation !== release.generation || value.release !== releaseSha ||
      value.boundary !== release.boundary || value.asOf !== release.asOf || value.sourceObservedAt !== release.sourceObservedAt ||
      !Array.isArray(value.parts) || value.parts.length > release.stores.length ||
      !Array.isArray(value.names) || !value.names.length || value.names.length > 1000 ||
      !value.names.every(name => typeof name === 'string' && name.length <= 120 && !sensitive.test(name)) ||
      !Array.isArray(value.zones) || value.zones.length !== manifest.count || value.orders !== 'NOT_CONNECTED' ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 128 * 1024 * 1024) bad();
  const unique = new Set();
  const areaNames = new Map();
  for (const [id, index] of value.zones) {
    if (!Number.isInteger(id) || id < 1000 || id > 99999 || areaNames.has(id) ||
        !Number.isInteger(index) || index < 0 || index >= value.names.length) bad();
    areaNames.set(id, value.names[index] || null);
  }
  const parts = new Map();
  let offset = 0, total = 0;
  for (const [code, cursor, bytes, raw, hash, count, recent] of value.parts) {
    if (!codes.test(code) || !opened.codes.has(code) || unique.has(code) || cursor !== offset ||
        !Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxRawHistory || !Number.isSafeInteger(raw) ||
        raw < 1 || raw > maxRawHistory || !digest.test(hash) || !Number.isSafeInteger(count) || count < 1 || count > 12000 ||
        !Array.isArray(recent) || recent.length > 4 || recent.some(([i,day,cars]) =>
          !Number.isInteger(i)||i<0||i>3||!isDay(day)||day>release.asOf||!Array.isArray(cars)||cars.length>200)) bad();
    unique.add(code);
    parts.set(code, { offset, bytes, raw, hash, count, recent });
    offset += bytes;
    total += count;
  }
  const linked = days => release.periods[days].rows.reduce((sum, [,src]) => sum + src.reduce((n, [,count]) => n + count, 0), 0);
  if (offset !== value.bytes || total !== linked(90) || JSON.stringify(value.footprints) !==
      JSON.stringify([30,60,90].map(days => [days, linked(days)]))) bad();
  return { areaNames, parts, bytes:value.bytes };
}

function deliveryTotals(records, center, start) {
  if (!records) return { visits:0, latest:null };
  let visits = 0, latest = null;
  for (const [origin, count, date] of records) {
    if (!centerIn(center, origin) || date < start) continue;
    visits += count;
    if (!latest || date > latest) latest = date;
  }
  return { visits, latest };
}

function collectArea(opened, catalog, area, days, center, source) {
  const period = opened.release.periods[days];
  const registered = new Map();
  const selected = [];
  const blocked = new Set(period.unavailableCodes.flatMap((set, i) => centerIn(center,i) ? set : []));
  const states = new Map(period.states);
  const completeCenters = postalCompleteCenters(period, days);
  for (const row of catalog) {
    const item = opened.codes.get(row.code);
    if (!item || item.area !== area) continue;
    if (item.registered && centerIn(center,item.center)) registered.set(row.code,row);
    selected.push([row,item]);
  }
  const visits = new Map(period.rows.filter(([code]) => opened.codes.get(code)?.area === area));
  return selected.flatMap(([row,item]) => {
    const result = deliveryTotals(visits.get(row.code), center, period.start);
    const isRegistered = registered.has(row.code);
    if (!isRegistered && !result.visits) return [];
    const eligible = area !== null && isRegistered && completeCenters.has(centers[item.center]) && !blocked.has(row.code);
    const flags = isRegistered ? states.get(row.code) ?? 0 : 0;
    const recent = source.parts.get(row.code)?.recent || [];
    const confirmedVehicles = [...new Set(recent.filter(([i,day])=>centerIn(center,i)&&day===result.latest)
      .flatMap(([, , cars])=>cars.map(safeVehicle).filter(Boolean)))].sort();
    return [{ code:row.code, name:safeText(row.name,180) ?? row.code, address:safeText(row.address,450),
      registered:isRegistered, location:[row.lat,row.lng].every(Number.isFinite) ? [row.lat,row.lng] : null,
      assignmentPending:item.reviewArea !== undefined,
      deliveryObservation:result.visits > 0 ? 'OBSERVED' : eligible ? 'CANDIDATE' : 'UNVERIFIED',
      observedDeliveryCount:result.visits, lastObservedDeliveryDate:result.latest, confirmedVehicles,
      newStore:flags & 1 ? 'OBSERVED' : flags & 2 ? 'UNVERIFIED' : flags & 8 ? 'VERIFIED_ZERO' : null,
      heldHistory:!!(flags & 4), operationStatus:null, orderCount:null, recentOrderDate:null }];
  }).sort((a,b) => Number(b.registered)-Number(a.registered) || a.name.localeCompare(b.name,'ko') || a.code.localeCompare(b.code));
}

function totals(items) {
  const tally = { registered:0, delivered:0, visits:0, newActive:0, newUnknown:0, newZero:0, held:0, candidates:0, unknown:0 };
  for (const row of items) {
    tally.registered += Number(row.registered);
    tally.delivered += Number(row.deliveryObservation === 'OBSERVED');
    tally.visits += row.observedDeliveryCount;
    tally.newActive += Number(row.newStore === 'OBSERVED');
    tally.newUnknown += Number(row.newStore === 'UNVERIFIED');
    tally.newZero += Number(row.newStore === 'VERIFIED_ZERO');
    tally.held += Number(row.heldHistory);
    tally.candidates += Number(row.deliveryObservation === 'CANDIDATE');
    tally.unknown += Number(row.deliveryObservation === 'UNVERIFIED');
  }
  return tally;
}

function passes(row, filter, search) {
  if (search && ![row.code,row.name,row.address].some(value => norm(value).includes(search))) return false;
  switch (filter) {
    case 'confirmed': return row.deliveryObservation === 'OBSERVED';
    case 'candidate': return row.deliveryObservation === 'CANDIDATE';
    case 'unknown': return row.deliveryObservation === 'UNVERIFIED';
    case 'new': return row.newStore !== null;
    case 'held': return row.heldHistory;
    default: return true;
  }
}

async function fixedRows(readFixed, rows) {
  const codeList = rows.map(row => row.code);
  let result;
  if (readFixed && codeList.length) {
    try { result = await readFixed(codeList); }
    catch { result = null; }
  }
  const meta = result?.meta ?? {};
  const lookup = new Map(Array.isArray(result?.data) ? result.data.map(row => [row.customerCode,row]) : []);
  const source = { state: result?.ok ? (meta.stale ? 'LAST_VERIFIED_RETAINED' : 'VERIFIED')
    : codeList.length ? 'UNAVAILABLE' : 'NOT_REQUESTED',
    checkedAt: Number.isFinite(Date.parse(meta.checkedAt)) ? meta.checkedAt : null };
  return { source, rows:rows.map(row => {
    const master = lookup.get(row.code);
    const schedule = master ? fixedDeliveryWeekdays(master,{source:meta}) : null;
    const vehicle = canonicalFixedMasterVehicle(master?.baseVehicle);
    return { ...row, baseVehicle:isProjectedFixedMasterVehicle(vehicle) && vehicle.length <= 16 ? vehicle || null : null,
      fixedState:master?.baseVehicleState || null,
      fixedWeekdays:schedule?.days ?? [], fixedWeekdayState:schedule?.status ?? 'UNKNOWN' };
  }) };
}

export function createPostalDetailsReader({ directory, indexSha256, appRoot, releaseSha256, readFixed, now = Date.now }) {
  let index, opening;
  const pending = new Map();
  async function load(opened) {
    if (index) return index;
    if (!opening) opening = (async () => {
      if (!directory || !digest.test(indexSha256 || '')) throw Error('POSTAL_DETAILS_UNCONFIGURED');
      const root = await privateCoverageDirectory(directory,appRoot);
      const bytes = await boundedRead(join(root,'details-index.json.gz'),1024*1024);
      if (sha256(bytes) !== indexSha256) bad();
      const value = JSON.parse(await gunzip(bytes,{maxOutputLength:8*1024*1024}));
      const parsed = validateIndex(value,opened,releaseSha256);
      const file = join(root,'customer-history.bin');
      const fs = await stat(file);
      if (!fs.isFile() || fs.size !== parsed.bytes) bad();
      return index = { ...parsed,file };
    })().finally(() => { opening = null; });
    return opening;
  }
  async function events(index, code) {
    const part = index.parts.get(code);
    if (!part) return [];
    if (pending.has(code)) return pending.get(code);
    if (pending.size >= 8) throw Error('POSTAL_READ_BUSY');
    const work = (async () => {
      const handle = await open(index.file,'r');
      const bytes = Buffer.alloc(part.bytes);
      try {
        for (let position = 0; position < bytes.length;) {
          const { bytesRead } = await handle.read(bytes,position,bytes.length-position,part.offset+position);
          if (!bytesRead) bad();
          position += bytesRead;
        }
      } finally { await handle.close(); }
      if (sha256(bytes) !== part.hash) bad();
      const raw = await gunzip(bytes,{maxOutputLength:part.raw});
      if (raw.length !== part.raw) bad();
      const payload = JSON.parse(raw);
      if (payload.code !== code || !Array.isArray(payload.rows) || payload.rows.length !== part.count) bad();
      return payload.rows;
    })().finally(() => pending.delete(code));
    pending.set(code,work);
    return work;
  }
  const orderSource = { state:'NOT_CONNECTED', observedAt:null };
  return {
    async roster({ opened, catalog, days, center, area, q, filter, offset }) {
      const source = await load(opened);
      if (area !== null && !source.areaNames.has(area)) throw Error('POSTAL_QUERY_INVALID');
      const items = collectArea(opened,catalog,area,days,center,source);
      const list = items.filter(row => passes(row,filter,norm(q)));
      const page = list.slice(offset,offset+POSTAL_STORE_PAGE);
      const fixed = await fixedRows(readFixed,page);
      const proof = opened.release.periods[days];
      return {
        area: area === null ? null : String(area).padStart(5,'0'), name:area === null ? '우편번호 미매칭' : source.areaNames.get(area),
        generation:opened.release.generation, period:{ days, start:proof.start, end:proof.end }, center,
        source:{ observedAt:opened.release.sourceObservedAt, queriedAt:new Date(now()).toISOString(), orders:orderSource,
          completeDays:days-opened.scope.completeness.sourceMissing.length-opened.scope.completeness.unverified.length,
          missingDates:opened.scope.completeness.missing, unverifiedDates:opened.scope.completeness.unverified,
          deliveryObservationDays:opened.scope.completeness.observed, fixed:fixed.source },
        totals:{ ...totals(items), records:items.length }, filteredCount:list.length, offset, limit:POSTAL_STORE_PAGE,
        next:offset+page.length < list.length && page.length ? offset+page.length : null, stores:fixed.rows,
      };
    },
    async history({ opened, days, center, area, code, offset }) {
      const source = await load(opened);
      const store = opened.codes.get(code);
      const proof = opened.release.periods[days];
      const advertised = deliveryTotals(proof.rows.find(([id])=>id===code)?.[1],center,proof.start).visits;
      if (!store || store.area !== area || !(store.registered && centerIn(center,store.center)) && !advertised) throw Error('POSTAL_QUERY_INVALID');
      const rows = (await events(source,code)).filter(([,date,origin])=>date>=proof.start&&date<=proof.end&&centerIn(center,origin));
      if (rows.length !== advertised) bad();
      const selected = rows.slice(offset,offset+POSTAL_HISTORY_PAGE);
      const delivery = selected.map(([key, date, origin, vehicle, scheduled, actual]) => ({
        deliveryId:null, archivedKey:digest.test(key)?key.slice(0,16):null,
        observedDate:date, scheduledDate:isDay(scheduled)?scheduled:null, actualDate:isDay(actual)?actual:null,
        confirmedVehicle:safeVehicle(vehicle), center:centers[origin], status:'OBSERVED_COMPLETED',
      }));
      return { code, source:{ observedAt:opened.release.sourceObservedAt, queriedAt:new Date(now()).toISOString(), orders:orderSource },
        orderNumber:null, orderDate:null, orderDeliveryState:null, orders:null,
        filteredCount:rows.length, offset, limit:POSTAL_HISTORY_PAGE,
        next:offset+selected.length < rows.length && selected.length ? offset+selected.length : null, deliveries:delivery };
    },
  };
}
