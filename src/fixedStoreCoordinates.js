import {createHash} from 'node:crypto';
import {coordinateAddressHash} from './opsmap-abc/opsmapAutoCoordinates.js';

export const FIXED_COORDINATE_FILE = 'fixed-store-coordinates-v1.json';
const SCHEMA = 'opsmap-fixed-store-coordinates-v1';
const HASH = /^[a-f0-9]{64}$/;
const CODE = /^[A-Z]\d{1,20}$/;
const sources = new Set(['CUSTOMER_ORIGINAL','CUSTOMER_GPS_CACHE','CUSTOMER_GPS_BUILD','CUSTOMER_MAP_BUILD',
  'HUB_ORIGINAL','ARCHIVE_MAP','HISTORICAL_GPS','MANUAL_STORE','SNAPSHOT']);
const accuracy = {RAW_GPS:'UNVERIFIED', MANUAL_PIN:'MANUAL', DELIVERY_RECORDED:'UNVERIFIED'};
const measurement = {RAW_GPS:'DELIVERY_COMPLETION_GPS', MANUAL_PIN:'DIRECT_SITE_MEASUREMENT', DELIVERY_RECORDED:'DELIVERY_COMPLETION_GPS'};
const verifiedSources = {
  DELIVERY_COMPLETION_GPS:new Set(['CUSTOMER_GPS_CACHE','CUSTOMER_GPS_BUILD','HISTORICAL_GPS']),
  DIRECT_SITE_MEASUREMENT:new Set(['MANUAL_STORE'])
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const keys = (value, required) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === required.length && required.every(key => Object.hasOwn(value,key));

export function hasFixedCoordinatePoint(row) {
  const lat = row?.lat ?? row?.latitude, lng = row?.lng ?? row?.longitude;
  const numeric = value => typeof value === 'number' || typeof value === 'string' && !!value.trim();
  return numeric(lat) && numeric(lng) && Number(lat) >= 33 && Number(lat) <= 39.5 && Number(lng) >= 124 && Number(lng) <= 132;
}

function checkPoint(row, code) {
  const fields = ['customerCode','addressHash','lat','lng','coordinateSource','coordinateAccuracy','evidenceSource','evidenceSha256','observedAt'];
  const legacy = keys(row,fields);
  if (!(legacy || keys(row,[...fields,'verifiedAt','measurementKind'])) ||
      row.customerCode !== code || !CODE.test(code) || !HASH.test(row.addressHash) || !HASH.test(row.evidenceSha256) ||
      typeof row.lat !== 'number' || typeof row.lng !== 'number' || !hasFixedCoordinatePoint(row) ||
      !Object.hasOwn(accuracy,row.coordinateSource) || accuracy[row.coordinateSource] !== row.coordinateAccuracy ||
      !sources.has(row.evidenceSource) || !validTime(row.observedAt) ||
      !legacy && (!validTime(row.verifiedAt) || Date.parse(row.verifiedAt) < Date.parse(row.observedAt) ||
        row.measurementKind !== measurement[row.coordinateSource] ||
        !verifiedSources[row.measurementKind].has(row.evidenceSource))) throw Error('FIXED_COORDINATE_EVIDENCE');
  return row;
}

export function validateFixedCoordinateLedger(value) {
  if (!keys(value,['schema','revision','records','sha256']) || value.schema !== SCHEMA || !Number.isSafeInteger(value.revision) ||
      value.revision < 0 || !value.records || typeof value.records !== 'object' || Array.isArray(value.records)) throw Error('FIXED_COORDINATE_SCHEMA');
  const {sha256,...body} = value;
  if (digest(body) !== sha256 || Object.keys(value.records).length > 10_000) throw Error('FIXED_COORDINATE_HASH');
  let events = 0;
  for (const [code, history] of Object.entries(value.records)) {
    if (!CODE.test(code) || !Array.isArray(history) || !history.length || (events += history.length) > 30_000) throw Error('FIXED_COORDINATE_HISTORY');
    const prior = new Map();
    let previous;
    for (const event of history) {
      if (!keys(event,['revision','updatedAt','rollbackOf','point']) || !Number.isSafeInteger(event.revision) ||
          event.revision <= (previous?.revision || 0) || event.revision > value.revision || !validTime(event.updatedAt) ||
          previous && Date.parse(event.updatedAt) < Date.parse(previous.updatedAt)) throw Error('FIXED_COORDINATE_REVISION');
      if (event.point !== null) checkPoint(event.point,code);
      if (event.rollbackOf === null ? event.point === null :
          !Number.isSafeInteger(event.rollbackOf) || event.rollbackOf < 0 ||
          event.rollbackOf !== 0 && !prior.has(event.rollbackOf) ||
          digest(event.point) !== digest(event.rollbackOf === 0 ? null : prior.get(event.rollbackOf).point)) throw Error('FIXED_COORDINATE_ROLLBACK');
      prior.set(event.revision,event);
      previous = event;
    }
  }
  return value;
}
