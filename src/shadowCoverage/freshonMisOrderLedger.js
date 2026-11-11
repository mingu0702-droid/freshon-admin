import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { boundedRead, datesFor, isDay, privateCoverageDirectory } from './coverageFiles.js';

const sha256 = /^[a-f0-9]{64}$/;
const customerCode = /^[A-Z]\d{1,20}$/;
const orderStates = new Set(['VALID', 'CANCELLED', 'UNVERIFIED']);

// Build a pinned input from normalized pages of the same MIS revision. A failed
// read may contribute observations, but only a verified full read adds coverage.
export function prepareFreshonMisOrderLedger({ generation, asOf, sourceRevision, reads }) {
  const [start] = datesFor(asOf, 90);
  const coverage = new Map();
  const orders = [];
  for (const read of reads) {
    const code = read.customerCode;
    if (!customerCode.test(code ?? '') || !isDay(read.start) || read.start < start || read.start > asOf ||
        read.end !== asOf || !Array.isArray(read.pages)) throw Error('FRESHON_MIS_ORDER_READ_SCOPE');
    const pages = [...read.pages].sort((a, b) => a.number - b.number);
    const { pageSize, totalRows } = pages[0] ?? {};
    const usableCounts = Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 5000 &&
      Number.isSafeInteger(totalRows) && totalRows >= 0 && totalRows <= 150000;
    let complete = read.allStatuses === true && usableCounts && pages.length === Math.max(1, Math.ceil(totalRows / pageSize));
    const ids = new Set();
    for (const [index, page] of pages.entries()) {
      if (page.httpStatus !== 200 || page.sourceRevision !== sourceRevision || !Array.isArray(page.orders)) {
        complete = false;
        continue;
      }
      if (page.number !== index + 1 || page.pageSize !== pageSize || page.totalRows !== totalRows ||
          page.orders.length !== Math.min(pageSize, totalRows - index * pageSize)) complete = false;
      for (const entry of page.orders) {
        if (entry?.[1] !== code || !isDay(entry[2]) || entry[2] < read.start || entry[2] > asOf) {
          throw Error('FRESHON_MIS_ORDER_READ_ROW');
        }
        if (ids.has(entry[0])) complete = false;
        ids.add(entry[0]);
        orders.push(entry);
      }
    }
    if (complete && ids.size === totalRows && (!coverage.has(code) || read.start < coverage.get(code).start)) {
      coverage.set(code, { customerCode: code, start: read.start, end: asOf, scope: 'VERIFIED_COMPLETE_ALL_STATUSES' });
    }
  }
  const payload = { schema: 1, source: 'FRESHON_MIS_ORDER_LEDGER', generation, asOf, start, sourceRevision,
    orders, coverage: [...coverage.values()] };
  createFreshonMisOrderLookup(payload, { generation, asOf });
  return payload;
}

export function createFreshonMisOrderLookup(payload, { generation, asOf }) {
  const [start] = datesFor(asOf, 90);
  if (typeof generation !== 'string' || !sha256.test(generation) ||
      payload?.schema !== 1 || payload.source !== 'FRESHON_MIS_ORDER_LEDGER' ||
      payload.generation !== generation || payload.asOf !== asOf || payload.start !== start ||
      typeof payload.sourceRevision !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(payload.sourceRevision) ||
      !Array.isArray(payload.orders) || payload.orders.length > 150000 ||
      !Array.isArray(payload.coverage) || payload.coverage.length > 15000) {
    throw Error('FRESHON_MIS_ORDER_SCOPE');
  }

  const completeFrom = new Map();
  // Only a successful, exhaustive MIS read of all statuses may certify absence.
  for (const item of payload.coverage) {
    if (typeof item?.customerCode !== 'string' || !customerCode.test(item.customerCode) ||
        !isDay(item.start) || item.start < start || item.start > asOf || item.end !== asOf ||
        item.scope !== 'VERIFIED_COMPLETE_ALL_STATUSES' || completeFrom.has(item.customerCode)) {
      throw Error('FRESHON_MIS_ORDER_COVERAGE');
    }
    completeFrom.set(item.customerCode, item.start);
  }

  const byCustomer = new Map();
  const identities = new Map();
  for (const entry of payload.orders) {
    if (!Array.isArray(entry) || entry.length !== 4) throw Error('FRESHON_MIS_ORDER_ROW');
    const [id, code, date, state] = entry;
    if (typeof id !== 'string' || !sha256.test(id) || typeof code !== 'string' || !customerCode.test(code) ||
        !isDay(date) || date < start || date > asOf || !orderStates.has(state)) throw Error('FRESHON_MIS_ORDER_ROW');
    const previous = identities.get(id);
    if (previous) {
      if (previous[1] !== code || previous[2] !== date || previous[3] !== state) throw Error('FRESHON_MIS_ORDER_CONFLICT');
      continue;
    }
    identities.set(id, entry);
    const rows = byCustomer.get(code) || [];
    rows.push({ date, state });
    byCustomer.set(code, rows);
  }

  return (code, from) => {
    const rows = (byCustomer.get(code) || []).filter(row => row.date >= from);
    const validByDate = new Map();
    let valid = 0;
    let cancelled = 0;
    let unverified = false;
    for (const { date, state } of rows) {
      if (state === 'VALID') {
        validByDate.set(date, (validByDate.get(date) || 0) + 1);
        valid++;
      } else if (state === 'CANCELLED') cancelled++;
      else unverified = true;
    }
    const complete = completeFrom.has(code) && completeFrom.get(code) <= from && !unverified;
    const dates = [...validByDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
    const lastObservedValidOrderDate = dates.at(-1)?.date ?? null;
    const state = !complete ? 'UNKNOWN' : valid ? 'CONFIRMED_VALID' : cancelled ? 'CONFIRMED_CANCELLED_ONLY' : 'CONFIRMED_ZERO';
    return { state, complete, validOrderCount: complete ? valid : null,
      lastOrderDate: complete ? lastObservedValidOrderDate : null, dates: complete ? dates : [],
      observedValidOrderCount: valid, lastObservedValidOrderDate };
  };
}

export async function readFreshonMisOrderLookup({ file, expectedSha256, appRoot, generation, asOf }) {
  if (!path.isAbsolute(file || '') || typeof expectedSha256 !== 'string' || !sha256.test(expectedSha256)) {
    throw Error('FRESHON_MIS_ORDER_FILE_CONFIG');
  }
  const resolved = await realpath(file);
  await privateCoverageDirectory(path.dirname(resolved), appRoot);
  const bytes = await boundedRead(resolved, 24 * 1024 * 1024);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw Error('FRESHON_MIS_ORDER_FILE_DIGEST');
  return createFreshonMisOrderLookup(JSON.parse(bytes), { generation, asOf });
}
