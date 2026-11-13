import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedRead, datesFor, parseCoverageIndex, readPackedCoverageFile } from '../../src/shadowCoverage/coverageFiles.js';
import { createFreshonCompletedDeliveryWindows } from '../../src/shadowCoverage/freshonCompletedDeliveries.js';
import { coordinateAddressHash } from '../../src/opsmap-abc/opsmapAutoCoordinates.js';
import { validateOpsmapSyncDay } from '../../src/opsmapSyncGeneration.js';

const generation = 'afa2699571a45ef38300a2c4477b18e27b29e235dd24c3f252983d3c110b5014';
const stateHash = '9f9453ebe1c175a5f780cdeecb566ec2c679318c915968982a489e2322f1e9f8';
const statusHash = '8d8ff1ebb24eb95d0fb9902138b3bd813e087249baa0e6552060ee5c961e43f5';
const codePattern = /^[A-Z]\d{1,20}$/;
const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');

async function readPrivateLocation(value) {
  if (!path.isAbsolute(value || '')) throw Error('PRIVATE_INPUT_PATH_REQUIRED');
  const resolved = await realpath(value);
  const relative = path.relative(await realpath(root), resolved);
  if (!relative || !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw Error('PRIVATE_INPUT_OUTSIDE_REPO_REQUIRED');
  return resolved;
}

async function verifiedBytes(file, expected, limit) {
  const bytes = await boundedRead(file, limit);
  if (hash(bytes) !== expected) throw Error('PROTOTYPE_INPUT_HASH_MISMATCH');
  return bytes;
}

function seenStatus(row, label) {
  return row.fixedObservations.some(item => item.vehicle === label) ||
    row.transitions.some(item => item.vehicle === label || item.fromVehicle === label);
}

export async function readSource({ snapshotRoot, statusFile }) {
  const [directory, packed] = await Promise.all([readPrivateLocation(snapshotRoot), readPrivateLocation(statusFile)]);
  const state = JSON.parse(await boundedRead(path.join(directory, 'published/000000000006.json'), 12 * 1024));
  const { sha256, ...sealed } = state;
  if (sha256 !== stateHash || hash(JSON.stringify(sealed)) !== sha256 || state.generation !== generation ||
      !/^[a-f0-9-]{36}$/.test(state.id)) throw Error('PROTOTYPE_GENERATION_MISMATCH');
  const folder = path.join(directory, 'generations', state.id);
  const index = parseCoverageIndex(await verifiedBytes(path.join(folder, 'coverage/coverage-index.json'), state.indexSha256, 16 * 1024));
  if (index.sha256 !== generation || index.kind !== 'OBSERVED') throw Error('PROTOTYPE_INDEX_MISMATCH');
  const windowRef = index.windows[90];
  const window = JSON.parse(await verifiedBytes(path.join(folder, 'coverage', windowRef.sha256 + '.json'), windowRef.sha256, windowRef.bytes));
  const { stores } = JSON.parse(await verifiedBytes(path.join(folder, 'input/stores.private.json'), state.catalogSha256, 5 * 1024 * 1024));
  const statusBytes = await readPackedCoverageFile(packed, 8 * 1024 * 1024);
  if (hash(statusBytes) !== statusHash) throw Error('PROTOTYPE_STATUS_HASH_MISMATCH');
  const status = JSON.parse(statusBytes);
  const dates = datesFor(index.asOf, 90);
  const known = [...Object.keys(state.dates)].sort();
  const missing = dates.filter(date => !Object.hasOwn(state.dates, date));
  if (status.generation !== generation || status.asOf !== index.asOf || status.stores.length !== stores.length ||
      JSON.stringify(known) !== JSON.stringify(window.observedDates.all) ||
      JSON.stringify(known) !== JSON.stringify(status.deliveryObservedDates) ||
      JSON.stringify(missing) !== JSON.stringify(status.deliveryUnknownDates) ||
      known.length + missing.length !== dates.length) throw Error('PROTOTYPE_EVIDENCE_WINDOW_MISMATCH');

  const byCode = new Map();
  for (const store of stores) {
    if (!codePattern.test(store.code) || byCode.has(store.code) || !store.registered ||
        !Number.isFinite(store.lat) || !Number.isFinite(store.lng)) throw Error('PROTOTYPE_STORE_CONTRACT');
    byCode.set(store.code, { code: store.code, lat: store.lat, lng: store.lng, center: store.center, visits: 0,
      latest: null, matchHash: store.matchHash, addressHash: coordinateAddressHash(store.address) });
  }
  const statusByCode = new Map();
  for (const row of status.stores) {
    if (!byCode.has(row.code) || byCode.get(row.code).addressHash !== row.addressHash || statusByCode.has(row.code)) {
      throw Error('PROTOTYPE_STATUS_BINDING');
    }
    statusByCode.set(row.code, row);
  }
  const states = createFreshonCompletedDeliveryWindows(status, statusByCode, seenStatus)(90);
  const blocked = new Set(Object.values(window.unplacedCodes).flat());
  const observedCenters = new Set(Object.entries(window.recorded)
    .filter(([center, count]) => count > window.unplaced[center]).map(([center]) => center));
  const identities = new Set();
  let unplaced = 0, bound = 0;
  for (const date of known) {
    const file = path.join(folder, 'input/observed-days', date + '.json');
    const day = validateOpsmapSyncDay(JSON.parse(await verifiedBytes(file, state.dates[date], 3 * 1024 * 1024)), date);
    for (const [id, code, , , addressHash] of day.visits) {
      if (identities.has(id)) throw Error('PROTOTYPE_DUPLICATE_DELIVERY_ID');
      identities.add(id);
      const record = byCode.get(code);
      if (!record?.matchHash || record.matchHash !== addressHash) { unplaced++; continue; }
      record.visits++;
      record.latest = date;
      bound++;
    }
  }
  const expectedUnplaced = Object.values(window.unplaced).reduce((n, count) => n + count, 0);
  if (identities.size !== window.completed || unplaced !== expectedUnplaced || bound + unplaced !== identities.size) {
    throw Error('PROTOTYPE_TOTAL_MISMATCH');
  }
  const records = [...byCode.values()].map(({ addressHash, matchHash, ...record }) => {
    const flags = states.byCode.get(record.code);
    return { ...record, newActive: flags?.newActive === true, newUnknown: flags?.historicalNew && flags.newActive === null || false,
      held: flags?.held === true, candidateEligible: window.unidentified === 0 &&
        observedCenters.has(record.center) && !blocked.has(record.code) };
  });
  return { records, meta: { generation, dateStart: dates[0], dateEnd: index.asOf,
    observedAt: index.sourceObservedAt, observedDays: known.length, totalDays: dates.length, missingDates: missing,
    verifiedCompleteDays: dates.length - window.missing.length - window.unverified.all.length,
    centerDays: Object.fromEntries(Object.entries(window.observedDates).map(([key, value]) => [key, value.length])),
    stores: byCode.size, completed: identities.size, bound, unplaced, unplacedStores: blocked.size,
    sourceRowsWithoutIdentity: window.unidentified, newActive: states.summary.confirmedNewActive,
    newUnknown: states.summary.newUnknown, held: states.summary.held } };
}
