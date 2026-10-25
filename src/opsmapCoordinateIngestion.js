// Explicit adapters only: callers supply collected rows and private candidate storage.
import { open, mkdir, rename, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCoordinateState, coordinateAddressHash, runIncremental } from './opsmapAutoCoordinates.js';

export function createMemoryCoordinateStore(initial = createCoordinateState()) {
  let current = structuredClone(initial), queue = Promise.resolve();
  return {
    transaction(work) {
      const task = queue.catch(() => {}).then(async () => {
        const state = structuredClone(current);
        const checkpoint = async next => { current = structuredClone(next); };
        return work(state, checkpoint);
      });
      queue = task; return task;
    },
    snapshot: () => structuredClone(current)
  };
}

/** Single local/worker private candidate file, mode 0600. A lock collision fails
 * closed; a stale lock needs operator recovery and never steals an active lease. */
export function createFileCoordinateStore({ filePath, maxBytes = 16 * 1024 * 1024 } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024) throw Error('COORDINATE_STORAGE_INVALID');
  const lockPath = filePath + '.lock';
  return { async transaction(work) {
    try { await mkdir(lockPath, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw Error('COORDINATE_STORAGE_BUSY'); throw Error('COORDINATE_STORAGE_UNAVAILABLE'); }
    try {
      let state;
      try {
        const handle = await open(filePath, 'r');
        try {
          if ((await handle.stat()).size > maxBytes) throw Error('COORDINATE_STORAGE_TOO_LARGE');
          state = JSON.parse(await handle.readFile('utf8'));
        } finally { await handle.close(); }
      } catch (error) { if (error.code === 'ENOENT') state = createCoordinateState(); else throw error; }
      const checkpoint = async next => {
        const text = JSON.stringify(next);
        if (Buffer.byteLength(text) > maxBytes) throw Error('COORDINATE_STORAGE_TOO_LARGE');
        const tempPath = filePath + '.' + randomUUID() + '.tmp';
        let handle;
        try {
          handle = await open(tempPath, 'wx', 0o600); await handle.writeFile(text); await handle.sync(); await handle.close(); handle = null;
          await rename(tempPath, filePath);
        } finally { if (handle) await handle.close(); await unlink(tempPath).catch(() => {}); }
      };
      return await work(state, checkpoint);
    } finally { await rmdir(lockPath); }
  } };
}

export function createCoordinateIngestion({ store, verifiedCoordinates = [], addressCoordinateCache = [], geocoder, policy = {}, now = Date.now } = {}) {
  if (!store || typeof store.transaction !== 'function') throw Error('COORDINATE_STORE_REQUIRED');
  async function ingest(events) {
    const evidence = typeof verifiedCoordinates === 'function' ? await verifiedCoordinates() : verifiedCoordinates;
    const cache = typeof addressCoordinateCache === 'function' ? await addressCoordinateCache() : addressCoordinateCache;
    return store.transaction(async (state, checkpoint) => {
      // Hash/point-only proof of the previous tuple; never retain raw addresses.
      const incomingCodes = new Set(events.map(row => row.customerCode));
      const previousCoordinates = Object.fromEntries(Object.entries(state.customers || {})
        .filter(([code, row]) => incomingCodes.has(code) && row.status === 'READY').map(([code, row]) => [code, { ...row }]));
      const resolved = await runIncremental({ events, verifiedCoordinates: evidence, addressCoordinateCache: cache, state, checkpoint, geocoder, policy, now });
      return { ...resolved, previousCoordinates };
    });
  }
  return {
    ingest,
    // Call after freshonImportDailyDispatchForDateRender_ succeeds, with its result.rows.
    // No inference of closure from a store missing from one day's delivery list.
    afterDailyCollection(result) {
      if (!result || !Array.isArray(result.rows) || Number(result.failed) > 0) throw Error('COORDINATE_COLLECTION_INCOMPLETE');
      return ingest(result.rows);
    },
    // Hub's current minimal period shards have no address: never geocode those by code alone.
    beforeMapIncremental({ collectionComplete, events, rows }) {
      if (collectionComplete !== true || !Array.isArray(events) || !Array.isArray(rows)) throw Error('COORDINATE_INCREMENTAL_INCOMPLETE');
      return ingest(events).then(result => ({ ...result, rows: applyCoordinateCandidates(rows, result) }));
    }
  };
}

/** Revokes a stale coordinate for a known changed/closed address in the candidate
 * projection. This returns new rows and never writes B's manual evidence or sources. */
export function applyCoordinateCandidates(rows, result) {
  const customers = result?.state?.customers || {};
  return rows.map(row => {
    const record = customers[row.customerCode];
    if (!record) return { ...row };
    const address = row.customerAddress ?? row.address;
    const hash = coordinateAddressHash(address);
    if (record.status === 'INACTIVE') return { ...row, lat: null, lng: null, hasCoordinate: false, geocodeStatus: 'INACTIVE', coordinateSource: null };
    // Address-free Hub shards and an address mismatch are never proof of a match.
    if (!hash || hash !== record.addressHash || record.status !== 'READY') return { ...row, lat: null, lng: null, hasCoordinate: false, geocodeStatus: 'REVIEW_REQUIRED', coordinateSource: null };
    return { ...row, lat: record.lat, lng: record.lng, hasCoordinate: true, geocodeStatus: 'OK', coordinateSource: record.source };
  });
}
