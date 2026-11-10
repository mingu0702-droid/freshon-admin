import {coordinateAddressHash} from './opsmap-abc/opsmapAutoCoordinates.js';
import {approvedFixedAddressSource, officialAddressKey} from './opsmapOfficialAddressLookup.js';

const PNU = /^[0-9]{10}[12](?!0000)[0-9]{8}$/;
const legalParcel = value => typeof value === 'string' && PNU.test(value);
export const REPRESENTATIVE_POLICY = 'address-representative-v2';
export const representativeTypes = Object.freeze({
  ADDRESS: {coordinateSource:'ADDRESS_REPRESENTATIVE', coordinateAccuracy:'ADDRESS_APPROXIMATE', measurementKind:'ADDRESS_LOCATION'},
  BUILDING: {coordinateSource:'BUILDING_VERIFIED', coordinateAccuracy:'BUILDING', measurementKind:'BUILDING_LOCATION'},
  PARCEL: {coordinateSource:'PARCEL_REPRESENTATIVE', coordinateAccuracy:'PARCEL', measurementKind:'PARCEL_LOCATION'},
  CAMPUS: {coordinateSource:'CAMPUS_REPRESENTATIVE', coordinateAccuracy:'CAMPUS', measurementKind:'CAMPUS_LOCATION'}
});

export function validRepresentative(point) {
  const value = point?.representative;
  if (!value || !Object.hasOwn(representativeTypes, value.kind)) return false;
  const type = representativeTypes[value.kind];
  if (point.coordinateSource !== type.coordinateSource || point.coordinateAccuracy !== type.coordinateAccuracy ||
      point.measurementKind !== type.measurementKind || !approvedFixedAddressSource(point.evidenceSource, point.sourceDataset) ||
      value.policy !== REPRESENTATIVE_POLICY || !officialAddressKey(value.normalizedAddress) ||
      /[\u0000-\u001f]|비밀번호|보안키|공동현관|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/i.test(value.normalizedAddress) ||
      value.normalizedAddressHash !== coordinateAddressHash(value.normalizedAddress)) return false;
  const fields = ['kind','identifier','normalizedAddress','normalizedAddressHash','license','sourceCrs','policy'];
  if (value.kind === 'PARCEL') {
    fields.push('sourceParcel');
    const current = String(value.identifier).slice(4);
    if (point.evidenceSource !== 'OFFICIAL_PARCEL_DATA' || value.license !== 'CC-BY-2.0-KR' ||
        value.sourceCrs !== 'EPSG:5186' || !String(value.identifier).startsWith('PNU:') ||
        !legalParcel(current) || !legalParcel(value.sourceParcel) || value.sourceParcel.slice(10) !== current.slice(10)) return false;
  } else if (value.kind === 'CAMPUS') {
    fields.push('parcelIds','officialReference');
    if (point.evidenceSource !== 'OPEN_ADDRESS_DATA' || value.license !== 'ODbL-1.0' ||
        value.sourceCrs !== 'EPSG:4326' || !/^OSM:(?:way|relation):[1-9]\d{0,15}$/.test(value.identifier || '') ||
        !Array.isArray(value.parcelIds) || !value.parcelIds.length || value.parcelIds.length > 100 ||
        !value.parcelIds.every(legalParcel) || new Set(value.parcelIds).size !== value.parcelIds.length ||
        !/^https:\/\/[^\s<>]{1,300}$/.test(value.officialReference || '')) return false;
  } else {
    if (point.evidenceSource !== 'OFFICIAL_ADDRESS_DATA' || value.license !== 'PUBLIC_DATA_UNRESTRICTED' ||
        value.sourceCrs !== 'EPSG:4326' || !(/^PNU:/.test(value.identifier) && legalParcel(value.identifier.slice(4)) ||
          /^BUILDING:(?!0{25}$)\d{25}$/.test(value.identifier || ''))) return false;
  }
  return Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value,key));
}
