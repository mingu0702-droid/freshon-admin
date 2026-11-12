const specialRoutes = new Set(['오산신규', '오산보류', '이천신규', '영남신규', '호남신규']);
const namedRoute = /^(?:용|척)\d{1,5}$/;

export function canonicalFixedMasterVehicle(value) {
  const label = String(value ?? '').normalize('NFKC').trim();
  const compact = label.replace(/\s+/g, '');
  if (compact === '보류') return '오산보류';
  if (specialRoutes.has(compact)) return compact;
  const code = compact.replace(/호(?:차)?$/, '');
  return /^\d+$/.test(code) || namedRoute.test(code) ? code : label;
}

export function isProjectedFixedMasterVehicle(value) {
  return typeof value === 'string' && (/^\d*$/.test(value) || namedRoute.test(value) || specialRoutes.has(value));
}
