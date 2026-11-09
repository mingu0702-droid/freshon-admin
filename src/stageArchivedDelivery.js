import {createHash} from 'node:crypto';
import {isDay} from './shadowCoverage/coverageFiles.js';

const SHA = /^[a-f0-9]{64}$/;
const CODE = /^[A-Z]\d{1,20}$/;
const SCOPE = 'STAGE_VERIFIED_DELIVERY_ARCHIVE';
const VEHICLES = ['101','122','202'];

// The retained completion export already binds addresses with this normalization.
export function archiveAddressHash(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const address = value.normalize('NFKC').trim().toLowerCase()
    .replace(/서울특별시|서울시/g,'서울').replace(/경기도/g,'경기')
    .replace(/(인천|대전|광주|울산|대구|부산)광역시/g,'$1')
    .replace(/강원특별자치도|강원도/g,'강원').replace(/전북특별자치도|전라북도/g,'전북')
    .replace(/충청([북남])도/g,'충$1').replace(/경상([북남])도/g,'경$1').replace(/전라남도/g,'전남')
    .replace(/\s/g,'');
  return createHash('sha256').update(address).digest('hex');
}

export function readStageArchivedDelivery(bytes, expectedHash) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 96 * 1024 || !SHA.test(expectedHash || '') ||
      createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw Error('STAGE_ARCHIVE_DELIVERY_DIGEST');
  const {source,observedAt,days} = JSON.parse(bytes);
  const legacy = source === 'DELIVERY_ARCHIVE_COMPLETION_OBSERVATIONS';
  if ((!legacy && source !== 'VERIFIED_DATED_SOURCES') || !Number.isFinite(Date.parse(observedAt)) ||
      !Array.isArray(days) || !days.length || days.length > 3) throw Error('STAGE_ARCHIVE_DELIVERY_SCOPE');
  const byDate = new Map();
  for (const {date,kind = legacy ? 'ARCHIVE_COMPLETED' : null,sourceRows,visits} of days) {
    if (!isDay(date) || byDate.has(date) || date > observedAt.slice(0,10) ||
        !['ARCHIVE_COMPLETED','CUSTOMER_DAILY_ROUTES'].includes(kind) ||
        !Number.isSafeInteger(sourceRows) || !Array.isArray(visits) || !visits.length ||
        visits.length > 600 || visits.length > sourceRows) throw Error('STAGE_ARCHIVE_DELIVERY_DAY');
    const seen = new Set();
    for (const row of visits) {
      if (!Array.isArray(row) || row.length !== 4 || !SHA.test(row[0]) || seen.has(row[0]) ||
          !CODE.test(row[1]) || !VEHICLES.includes(row[2]) ||
          row[3] !== null && !SHA.test(row[3])) throw Error('STAGE_ARCHIVE_DELIVERY_ROW');
      seen.add(row[0]);
    }
    byDate.set(date,{kind,sourceRows,visits});
  }
  const latest = [...byDate.keys()].sort().at(-1);
  return (requestedDate, registry) => {
    const date = requestedDate === 'latest' ? latest : requestedDate;
    const day = byDate.get(date);
    if (!day) return null;
    const completed = day.kind === 'ARCHIVE_COMPLETED';
    const stops = new Map();
    for (const [,customerCode,vehicle,addressHash] of day.visits) {
      const store = registry.get(customerCode), key = vehicle+'|'+customerCode;
      const retainedHash = completed ? store?.matchHash || archiveAddressHash(store?.address) : store?.addressHash;
      const located = store?.hasPoint && addressHash !== null && addressHash === retainedHash;
      const existing = stops.get(key);
      stops.set(key,{
        customerCode, customerName:store?.name || customerCode, vehicle, deliveryDate:date, lastDeliveryDate:date,
        status:completed?'COMPLETED':'UNCONFIRMED', order:null,
        coordinateStatus:located&&existing?.lat!==null?'CONFIRMED':'MISSING',
        lat:located && existing?.lat !== null ? store.lat : null,
        lng:located && existing?.lng !== null ? store.lng : null
      });
    }
    const data = [...stops.values()];
    return {ok:true,data,meta:{
      date,source:SCOPE,recordKind:day.kind,reviewOnly:true,complete:false,sourceComplete:false,observedAt,
      rowCount:data.length,observedVisitCount:day.visits.length,sourceDayRows:day.sourceRows,vehicles:[...VEHICLES]
    },error:null};
  };
}
