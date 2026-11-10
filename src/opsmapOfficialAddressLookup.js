import {createHash} from 'node:crypto';

export const OFFICIAL_BUSINESS_SOURCE = 'https://www.data.go.kr/data/15083033/fileData.do';
export const OFFICIAL_BUILDING_SOURCE = 'https://www.data.go.kr/data/15156424/fileData.do';
export const OPEN_BUILDING_SOURCE = 'https://download.geofabrik.de/asia/south-korea.html';
export const OFFICIAL_PARCEL_SOURCE = 'https://www.data.go.kr/data/15045882/fileData.do';
const approvedSources = new Set([OFFICIAL_BUSINESS_SOURCE, OFFICIAL_BUILDING_SOURCE]);
export const approvedOfficialAddressSource = value => approvedSources.has(value);
export const approvedFixedAddressSource = (source,dataset) => source === 'OFFICIAL_ADDRESS_DATA' ? approvedSources.has(dataset) :
  source === 'OPEN_ADDRESS_DATA' ? dataset === OPEN_BUILDING_SOURCE :
    source === 'OFFICIAL_PARCEL_DATA' && dataset === OFFICIAL_PARCEL_SOURCE;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const aliases = new Map(Object.entries({
  서울:'서울특별시', 서울시:'서울특별시', 경기:'경기도', 인천:'인천광역시', 부산:'부산광역시', 대구:'대구광역시',
  대전:'대전광역시', 울산:'울산광역시', 광주:'광주광역시', 세종:'세종특별자치시', 강원:'강원특별자치도',
  강원도:'강원특별자치도', 충남:'충청남도', 충북:'충청북도', 전북:'전북특별자치도', 전라북도:'전북특별자치도',
  전남:'전라남도', 경북:'경상북도', 경남:'경상남도', 제주:'제주특별자치도', 제주도:'제주특별자치도'
}));

export function officialAddressKey(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const normalized = value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
    .replace(/(대로|로)\s+(\d+(?:번)?길)/g, '$1$2');
  const road = /^.*?[가-힣0-9·.]+(?:대로|로|길)\s*(?:지하\s*)?\d+(?:-\d+)?(?=$|[\s,(\[])/;
  const lot = /^.*?[가-힣0-9·.]+(?:동\d+가|동|리|읍|면|가)\s*(?:산\s*)?\d+(?:-\d+)?(?=$|[\s,(\[])/;
  const core = (normalized.match(road) || normalized.match(lot))?.[0];
  if (!core) return null;
  const [province, ...parts] = core.split(' ');
  return [aliases.get(province) || province, ...parts].join('');
}

export function createOfficialAddressLookup(buffer, {sha256: expected, allowMixed = false, allowStored = false} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 512 * 1024 || !digest.test(expected || '') || sha256(buffer) !== expected) {
    throw Error('OFFICIAL_ADDRESS_INDEX_DIGEST');
  }
  let index;
  try { index = JSON.parse(buffer.toString('utf8')); } catch { throw Error('OFFICIAL_ADDRESS_INDEX_JSON'); }
  const mixed = index?.schema === 'opsmap-official-address-index-v2';
  if (!index || Object.keys(index).length !== 5 || (mixed?!allowMixed:index.schema !== 'opsmap-official-address-index-v1') ||
      !approvedSources.has(index.source) || !/^\d{4}-\d{2}-\d{2}$/.test(index.date || '') ||
      !digest.test(index.datasetSha256 || '') || !Array.isArray(index.rows) || !index.rows.length || index.rows.length > 2000) {
    throw Error('OFFICIAL_ADDRESS_INDEX_SCHEMA');
  }
  const rows = new Map();
  const kinds = allowStored ? ['BUILDING','ADDRESS','PARCEL','STORED'] : ['BUILDING','ADDRESS','PARCEL'];
  for (const row of index.rows) {
    if (!row || Object.keys(row).length !== (mixed?5:4) || mixed && !kinds.includes(row.coordinateKind) || !digest.test(row.addressSha256 || '') ||
        !digest.test(row.buildingSha256 || '') || typeof row.lat !== 'number' || typeof row.lng !== 'number' ||
        row.lat < 33 || row.lat > 39.5 || row.lng < 124 || row.lng > 132 || rows.has(row.addressSha256)) {
      throw Error('OFFICIAL_ADDRESS_INDEX_ROW');
    }
    rows.set(row.addressSha256, Object.freeze({lat:row.lat, lng:row.lng, buildingSha256:row.buildingSha256,
      ...(mixed?{coordinateKind:row.coordinateKind}:{})}));
  }
  const find=query=>{const key=officialAddressKey(query);return key?{addressSha256:sha256(key),point:rows.get(sha256(key))}:null;};
  return Object.freeze({lookup(query) {
    const point=find(query)?.point;return point?Object.freeze({lat:point.lat,lng:point.lng,
      ...(point.coordinateKind?{coordinateKind:point.coordinateKind}:{})}):null;
  },resolve(query) {
    const match=find(query);if(!match?.point||mixed)return null;
    return Object.freeze({...match.point,addressSha256:match.addressSha256,evidenceSource:'OFFICIAL_ADDRESS_DATA',
      datasetSha256:index.datasetSha256,indexSha256:expected,datasetDate:index.date,measurementKind:'BUILDING_LOCATION'});
  }});
}

// Postal building identifiers were matched offline. A postal address without a
// verified building position must never be turned into a pin automatically.
export function createOfficialAddressReview(buffer, {sha256: expected} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 256 * 1024 || !digest.test(expected || '') ||
      sha256(buffer) !== expected) throw Error('OFFICIAL_ADDRESS_REVIEW_DIGEST');
  const value = JSON.parse(buffer);
  if (value?.schema !== 'opsmap-official-address-review-v1' || !Array.isArray(value.rows) ||
      !value.rows.length || value.rows.length > 1000) throw Error('OFFICIAL_ADDRESS_REVIEW_SCHEMA');
  const rows = new Map();
  const publicAddress = input => typeof input === 'string' && input.length <= 180 &&
    !/[\r\n\x00-\x1f]/.test(input) && !!officialAddressKey(input);
  for (const {key, road, lot, kind, points} of value.rows) {
    if (!digest.test(key || '') || rows.has(key) || !publicAddress(road) || !publicAddress(lot) ||
        !Array.isArray(points) || !(kind === 'EXACT' && points.length === 1 ||
        kind === 'CHOOSE' && points.length >= 2 && points.length <= 12 ||
        kind === 'MANUAL' && !points.length)) throw Error('OFFICIAL_ADDRESS_REVIEW_ROW');
    const seen = new Set();
    for (const point of points) {
      if (!Array.isArray(point) || point.length !== 2 ||
          !point.every(Number.isFinite) || point[0] < 33 || point[0] > 39.5 || point[1] < 124 || point[1] > 132 ||
          seen.has(point.join(','))) throw Error('OFFICIAL_ADDRESS_REVIEW_POINT');
      seen.add(point.join(','));
    }
    rows.set(key, Object.freeze({kind, road, lot, points:points.map(point => Object.freeze([...point]))}));
  }
  return Object.freeze({lookup(query) {
    const key = officialAddressKey(query);
    return key ? rows.get(sha256(key)) || null : null;
  }});
}

export function createTemporaryOfficialAddressLookup({sha256: expected, now = Date.now} = {}) {
  const ttl = 2 * 60 * 60 * 1000;
  let current;
  return {
    activate(bytes) {
      const lookup = createOfficialAddressLookup(bytes, {sha256:expected,allowMixed:true});
      const expiresAt = now() + ttl;
      const activated = {lookup,expiresAt};
      current = activated;
      setTimeout(() => {if (current === activated) current = null;},ttl).unref();
      return {expiresAt:new Date(expiresAt).toISOString()};
    },
    active() {
      if (current && current.expiresAt <= now()) current = null;
      return current?.lookup || null;
    }
  };
}
