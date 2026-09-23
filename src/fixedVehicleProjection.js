// Read-only, allowlisted projection of the current fixed-dispatch master.
// No persistence, collector, Customer write, or historical assignment mutation.
export function projectFixedVehicles(rows) {
  const result = new Map();
  for (const row of rows) {
    const customerCode = String(row.estCd || '').trim().toUpperCase();
    if (!/^[A-Z]\d+$/.test(customerCode)) continue;
    const primary = String(row.mainCarSeqNm || '').trim().replace(/호$/, '');
    const baseVehicle = /^\d+$/.test(primary) ? String(Number(primary)) : '';
    const weekdays = Object.fromEntries(['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day => {
      const v = String(row['carSeq' + day + 'Nm'] || '').trim().replace(/호$/, '');
      return [day, /^\d+$/.test(v) ? String(Number(v)) : ''];
    }));
    const baseVehicleGroup=({'011':'osan','012':'yeongnam','013':'honam'})[row.logCd]||'';
    const previous = result.get(customerCode);
    const conflict = previous && (previous.baseVehicleState === 'CONFLICT' || previous.baseVehicle !== baseVehicle || previous.baseVehicleGroup&&baseVehicleGroup&&previous.baseVehicleGroup!==baseVehicleGroup);
    result.set(customerCode, {customerCode, baseVehicle: conflict ? '' : baseVehicle,
      baseVehicleState: conflict ? 'CONFLICT' : baseVehicle ? 'VERIFIED_MASTER' : 'UNASSIGNED',
      baseVehicleGroup: conflict?'':baseVehicleGroup,
      baseVehicleSource: 'FIXED_DISPATCH_PRIMARY', weekdays});
  }
  return [...result.values()];
}

export function createFixedVehicleReader({ensureSession, readJson, extractRows}) {
  return async function readFixedVehicleMaster() {
    await ensureSession();
    const projected = [];
    for (const logCd of ['011', '012', '013']) {
      let complete = false;
      for (let page = 0; page < 20; page++) {
        const body = new URLSearchParams({page: String(page), size: '1000', isPaging: 'true', isCount: 'true',
          sort: 'est_cd,ASC', logCd, estCd: '', estName: '', estNm: '', estGbn: '', startDate: '', endDate: '',
          carCd: '', carNm: '', shipGbn: '1', baecha: ''});
        const payload = await readJson('/bo/wm/standard/fixedAlctnList', {method: 'POST',
          headers: {'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'}, body: body.toString()});
        const rows = extractRows(payload);
        if (!Array.isArray(rows)) throw new Error('FIXED_MASTER_CONTRACT');
        // Keep no contact/access/memo values between batches.
        projected.push(...rows.map(row => ({logCd,...Object.fromEntries(['estCd','mainCarSeqNm',
          ...['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day=>'carSeq'+day+'Nm')].map(key=>[key,row[key]]))})));
        if (rows.length < 1000) { complete = true; break; }
      }
      if (!complete) throw new Error('FIXED_MASTER_INCOMPLETE');
    }
    if (!projected.length) throw new Error('FIXED_MASTER_EMPTY');
    return {data: projectFixedVehicles(projected)};
  };
}
