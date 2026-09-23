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
    const failure=(code,http=0)=>Object.assign(new Error(code),{code,status:Number(http)||0});
    try{await ensureSession();}catch(error){throw failure('FIXED_MASTER_SESSION_UNAVAILABLE',error.status);}
    let authRetried=false,firstHttp=200,authReason=null;
    async function readPage(options){
      try{
        const payload=await readJson('/bo/wm/standard/fixedAlctnList',options);
        if(payload?.status&&Number(payload.status)!==200)throw {status:Number(payload.status)};
        return payload;
      }catch(error){
        // Same one-time expired-session recovery as the existing Freshon reader.
        // Reuse existing credentials; never retry a 403 or change permissions.
        if(Number(error.status)===401&&!authRetried){
          authRetried=true;
          firstHttp=Number(error.diagnostic?.status)||Number(error.status)||null;
          authReason=error.diagnostic?.type==='html-or-login-response'?'HTML_OR_LOGIN':'HTTP_401';
          try{await ensureSession(true);}catch(e){throw failure('FIXED_MASTER_SESSION_UNAVAILABLE',e.status);}
          return readPage(options);
        }
        throw failure(Number(error.status)===401?'FIXED_MASTER_AUTH_REQUIRED':Number(error.status)===403?'FIXED_MASTER_FORBIDDEN':'FIXED_MASTER_READ_FAILED',error.status);
      }
    }
    const projected = [];
    for (const logCd of ['011', '012', '013']) {
      let complete = false;
      for (let page = 0; page < 20; page++) {
        const body = new URLSearchParams({page: String(page), size: '1000', isPaging: 'true', isCount: 'true',
          sort: 'est_cd,ASC', logCd, estCd: '', estName: '', estNm: '', estGbn: '', startDate: '', endDate: '',
          carCd: '', carNm: '', shipGbn: '1', baecha: ''});
        const payload = await readPage({method: 'POST',timeoutMs:25000,
          headers: {'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'}, body: body.toString()});
        const rows = extractRows(payload);
        if (!Array.isArray(rows)) throw failure('FIXED_MASTER_CONTRACT');
        // Keep no contact/access/memo values between batches.
        projected.push(...rows.map(row => ({logCd,...Object.fromEntries(['estCd','mainCarSeqNm',
          ...['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day=>'carSeq'+day+'Nm')].map(key=>[key,row[key]]))})));
        if (rows.length < 1000) { complete = true; break; }
      }
      if (!complete) throw failure('FIXED_MASTER_INCOMPLETE');
    }
    if (!projected.length) throw failure('FIXED_MASTER_EMPTY');
    return {data: projectFixedVehicles(projected),meta:{authRetried,firstHttp,authReason,readHttp:200}};
  };
}
