import {createHash} from 'node:crypto';
import {isDay} from './shadowCoverage/coverageFiles.js';

const SHA = /^[a-f0-9]{64}$/;
const CODE = /^[A-Z]\d{1,20}$/;
const SCOPE = 'STAGE_VERIFIED_DELIVERY_ARCHIVE';
const VEHICLES = ['101','122','202'];

export function readStageArchivedDelivery(bytes, expectedHash) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 96 * 1024 || !SHA.test(expectedHash || '') ||
      createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw Error('STAGE_ARCHIVE_DELIVERY_DIGEST');
  const {source,observedAt,days} = JSON.parse(bytes);
  if (source !== 'DELIVERY_ARCHIVE_COMPLETION_OBSERVATIONS' || !Number.isFinite(Date.parse(observedAt)) ||
      !Array.isArray(days) || !days.length || days.length > 3) throw Error('STAGE_ARCHIVE_DELIVERY_SCOPE');
  const byDate = new Map();
  for (const {date,sourceRows,visits} of days) {
    if (!isDay(date) || byDate.has(date) || date > observedAt.slice(0,10) ||
        !Number.isSafeInteger(sourceRows) || !Array.isArray(visits) || !visits.length ||
        visits.length > 600 || visits.length > sourceRows) throw Error('STAGE_ARCHIVE_DELIVERY_DAY');
    const seen = new Set();
    for (const row of visits) {
      if (!Array.isArray(row) || row.length !== 4 || !SHA.test(row[0]) || seen.has(row[0]) ||
          !CODE.test(row[1]) || !VEHICLES.includes(row[2]) ||
          row[3] !== null && !SHA.test(row[3])) throw Error('STAGE_ARCHIVE_DELIVERY_ROW');
      seen.add(row[0]);
    }
    byDate.set(date,{sourceRows,visits});
  }
  const latest = [...byDate.keys()].sort().at(-1);
  return (requestedDate, registry) => {
    const date = requestedDate === 'latest' ? latest : requestedDate;
    const day = byDate.get(date);
    if (!day) return null;
    const stops = new Map();
    for (const [,customerCode,vehicle,addressHash] of day.visits) {
      const store = registry.get(customerCode), key = vehicle+'|'+customerCode;
      const located = store?.hasPoint && addressHash !== null && addressHash === store.matchHash;
      const existing = stops.get(key);
      stops.set(key,{
        customerCode, customerName:store?.name || customerCode, vehicle, deliveryDate:date, lastDeliveryDate:date,
        status:'COMPLETED', order:null,
        lat:located && existing?.lat !== null ? store.lat : null,
        lng:located && existing?.lng !== null ? store.lng : null
      });
    }
    const data = [...stops.values()];
    return {ok:true,data,meta:{
      date,source:SCOPE,reviewOnly:true,complete:false,sourceComplete:false,observedAt,
      rowCount:data.length,observedVisitCount:day.visits.length,sourceDayRows:day.sourceRows,vehicles:[...VEHICLES]
    },error:null};
  };
}
