import {createHash} from 'node:crypto';
import {isDay} from './shadowCoverage/coverageFiles.js';

const DAY = 86400000;
const VEHICLE = /^(?:[용척]?\d{1,4})(?:-\d{1,3})?$/;
const FIXED = /^[\p{L}\p{N}_-]{1,64}$/u;
const SHA = /^[a-f0-9]{64}$/;
const textVehicle = value => typeof value === 'string' && VEHICLE.test(value);

export function readStageNearbyEvidence(bytes, {expected, generation, registry, window}) {
  if (!bytes?.length || bytes.length > 384 * 1024 || !SHA.test(expected) ||
      createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('STAGE_NEARBY_DIGEST');
  const {source, generation:version, start, end, observedDates, rows} = JSON.parse(bytes);
  if (source !== 'STAGE_ARCHIVE_ADDRESS_BOUND' || version !== generation || !isDay(start) || !isDay(end) ||
      Date.parse(end) - Date.parse(start) !== 89 * DAY || window.start !== start || window.end !== end ||
      !Array.isArray(observedDates) || !observedDates.length || observedDates.length > 90 ||
      JSON.stringify(observedDates) !== JSON.stringify(window.observedDates?.all) ||
      !Array.isArray(rows) || rows.length > registry.size) throw Error('STAGE_NEARBY_SCOPE');
  const dates = new Set(observedDates), codes = new Set();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 4) throw Error('STAGE_NEARBY_ROW');
    const [code, date, vehicle, days] = row;
    if (!registry.get(code)?.hasPoint || codes.has(code) || !dates.has(date) ||
        (vehicle !== '' && !textVehicle(vehicle)) || !Number.isInteger(days) ||
        days < 1 || days > 127 || !(days & (1 << new Date(date).getUTCDay()))) throw Error('STAGE_NEARBY_ROW');
    codes.add(code);
  }
  return {source, generation, start, end, observedDays:dates.size, unknownDays:90-dates.size, rows};
}

export function stageNearbyResponse(evidence, fixed) {
  const version = fixed?.meta?.version;
  const checkedAt = fixed?.meta?.checkedAt;
  const masterVerified = fixed?.ok === true && fixed.meta?.basis === 'FIXED_DISPATCH_PRIMARY' &&
    SHA.test(version || '') && Number.isFinite(Date.parse(checkedAt)) && Array.isArray(fixed.data);
  const fixedRows = masterVerified ? fixed.data.filter(row => row.baseVehicleState === 'VERIFIED_MASTER' &&
    row.baseVehicleSource === 'FIXED_DISPATCH_PRIMARY' && row.baseVehicleVersion === version &&
    typeof row.baseVehicle === 'string' && FIXED.test(row.baseVehicle)).map(row => [row.customerCode, row.baseVehicle]) : [];
  return {...evidence, fixedRows, fixedCheckedAt:fixedRows.length ? checkedAt : null};
}
