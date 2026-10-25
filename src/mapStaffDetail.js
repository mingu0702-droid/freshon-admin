import { parseLocationMessage, sanitizeLocationMessage } from './phase2bLocationDetail.js';

const safeText = value => {
  if (typeof value !== 'string') return null;
  const clean = sanitizeLocationMessage(value);
  return clean && clean === value.trim() && clean.length <= 2000 ? clean : null;
};

// Selected Customer row only. Location text is not a public map/cache payload.
export function staffStoreDetail(source, { customerCode, date }) {
  if (String(source?.customerCode || '').trim().toUpperCase() !== customerCode) throw Error('HUB_INVALID_DETAIL_CONTRACT');
  const location = value => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || value.length > 500 || /[\r\n]|비밀번호|비번|출입|도어락|보안키|password|token|secret|(?:01[016789])[- ]?\d{3,4}[- ]?\d{4}/i.test(value)) return null;
    return value.trim() || null;
  };
  return { customerCode, customerName: location(source.customerName),
    address: location(source.customerAddress || source.address),
    detailAddress: location(source.detailAddress || source.addressDetail),
    detailDate: date, source: 'Customer → Hub customerDetail',
    locationState: location(source.customerAddress || source.address) ? 'SOURCE_ROW' : 'UNCONFIRMED',
    businessCoverageVerified: false };
}

// Existing Hub accessMemo may combine sources. Only explicit operational section
// labels are parsed; ambiguous prose and rawMemo never leave the server.
export function staffCustomerDetail(source, { customerCode, date }) {
  const parsed = parseLocationMessage(source.accessMemo || '');
  const accessInfo = safeText(source.accessInfo) || safeText(parsed.accessInfo);
  const password = typeof source.password === 'string' && /^[A-Za-z0-9#*/_-]{2,100}$/.test(source.password)
    ? source.password : parsed.password || null;
  const specialRemark = safeText(source.specialRemark) || safeText(parsed.specialRemark);
  const deliveryPattern = safeText(source.deliveryPattern || source.deliveryPatternText) || null;
  return { customerCode, memoDate: date, accessInfo, password, specialRemark, deliveryPattern,
    memoState: accessInfo || password || specialRemark ? 'REGISTERED' : source.accessMemo ? 'NEEDS_CONFIRMATION' : 'UNREGISTERED',
    source: 'Customer → Hub staffCustomerDetail (one source row; no sensitive cache)' };
}
