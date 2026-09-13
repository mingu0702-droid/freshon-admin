import { parseLocationMessage, sanitizeLocationMessage } from './phase2bLocationDetail.js';

const safeText = value => {
  if (typeof value !== 'string') return null;
  const clean = sanitizeLocationMessage(value);
  return clean && clean === value.trim() && clean.length <= 2000 ? clean : null;
};

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
    source: 'Customer → Hub customerDetail (explicit operational fields only)' };
}
