const specialRoutes = new Set(['오산신규', '오산보류', '이천신규', '영남신규']);

export function canonicalFixedMasterVehicle(value) {
  const label = String(value ?? '').normalize('NFKC').trim();
  const compact = label.replace(/\s+/g, '');
  if (compact === '보류') return '오산보류';
  if (specialRoutes.has(compact)) return compact;
  const number = compact.match(/^(\d+)(?:호(?:차)?)?$/);
  return number ? number[1] : label;
}

export function isProjectedFixedMasterVehicle(value) {
  return typeof value === 'string' && (/^\d*$/.test(value) || specialRoutes.has(value));
}
