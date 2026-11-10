import {createHash} from 'node:crypto';
import {isDay} from './shadowCoverage/coverageFiles.js';

const DAY = 86400000;
const VEHICLE = /^(?:[용척]?\d{1,4})(?:-\d{1,3})?$/;
const FIXED = /^[\p{L}\p{N}_-]{1,64}$/u;
const SHA = /^[a-f0-9]{64}$/;
const textVehicle = value => typeof value === 'string' && VEHICLE.test(value);
const CENTERS = new Set(['osan','yeongnam','honam','unknown']);

export function addObservedVehicleDays(groups, date, visits, matchesAddress) {
  const bit = 1 << new Date(date).getUTCDay();
  for (const [,code,vehicle,center,addressHash] of visits) {
    if (!textVehicle(vehicle) || !CENTERS.has(center) || !addressHash || !matchesAddress(code,addressHash)) continue;
    const key = code+'|'+vehicle+'|'+center;
    const previous = groups.get(key);
    if (previous) previous[3] |= bit;
    else groups.set(key,[code,vehicle,center,bit]);
  }
}

// Older generations have the same verified day objects but no per-vehicle
// projection. Read each object once per generation, with bounded concurrency.
export function createLegacyNearbyVehicleReader({waitMs=3500, now=Date.now}={}) {
  const cache = new WeakMap();
  return async function readVehicleDays(prepared) {
    if (prepared.nearby.vehicleDays) return {vehicleStatus:'READY',vehicleDays:prepared.nearby.vehicleDays};
    if (!prepared.readNearbyDay) return {vehicleStatus:'UNAVAILABLE'};
    let work = cache.get(prepared);
    if (!work || work.retryAt <= now()) {
      const dates = prepared.nearby.observedDates, groups = new Map();
      let cursor=0, failed=false;
      work={retryAt:Infinity};
      work.pending=Promise.all(Array.from({length:Math.min(4,dates.length)},async()=>{
        while (!failed && cursor<dates.length) {
          const date=dates[cursor++];
          try {
            const day=await prepared.readNearbyDay(date);
            if (day?.date!==date || day.planningOnly || !Array.isArray(day.visits)) throw Error('NEARBY_DAY_UNVERIFIED');
            addObservedVehicleDays(groups,date,day.visits,(code,hash)=>{
              const store=prepared.registry.get(code);
              return store?.hasPoint && store.matchHash===hash;
            });
          } catch {failed=true;}
        }
      })).then(()=>{
        if (!failed) return work.ready={vehicleStatus:'READY',vehicleDays:[...groups.values()]};
        work.retryAt=now()+30_000;
        return {vehicleStatus:'UNAVAILABLE'};
      });
      cache.set(prepared,work);
    }
    if (work.ready) return work.ready;
    let timeout;
    try {
      return await Promise.race([work.pending,new Promise(resolve=>{
        timeout=setTimeout(()=>resolve({vehicleStatus:'LOADING'}),waitMs);
        timeout.unref?.();
      })]);
    } finally {clearTimeout(timeout);}
  };
}

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
  const observedByCenter=Object.fromEntries([...CENTERS].filter(center=>center!=='unknown').map(center=>{
    const observed=window.observedDates[center];
    if(observed===undefined)return [center,null];
    if(!Array.isArray(observed)||new Set(observed).size!==observed.length||observed.some(date=>!dates.has(date))) {
      throw Error('STAGE_NEARBY_CENTER_SCOPE');
    }
    return [center,observed.length];
  }));
  return {source, generation, start, end, observedDates, observedDays:dates.size, unknownDays:90-dates.size, observedByCenter, rows};
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
