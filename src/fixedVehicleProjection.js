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

export function createFixedVehicleReader({ensureSession, readJson, extractRows, sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  let progress=null;
  const reader=async function readFixedVehicleMaster() {
    progress={phase:'SESSION',center:null,page:0,sourceRows:0,retries:0};
    const failure=(code,http=0,step='READ',kind='UNKNOWN')=>Object.assign(new Error(code),{code,status:Number(http)||0,step,kind});
    try{await ensureSession();}catch(error){throw failure('FIXED_MASTER_SESSION_UNAVAILABLE',error.status);}
    let authRetried=false,firstHttp=200,authReason=null;
    async function readPage(options,attempt=0){
      try{
        const payload=await readJson('/bo/wm/standard/fixedAlctnList',options);
        if(Number(payload?.status)>=400)throw {status:Number(payload.status)};
        return payload;
      }catch(error){
        // Same one-time expired-session recovery as the existing Freshon reader.
        // Reuse existing credentials; never retry a 403 or change permissions.
        // The shared reader maps its own AbortError to 504. Do not report that
        // synthesized value as an upstream HTTP response or expose its message.
        const localTimeout=!error.diagnostic&&error.status===504&&/^Freshon request timed out after \d+s \(/.test(String(error.message||''));
        const network=!error.diagnostic&&!error.status&&['ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(error.cause?.code||error.code);
        const http=localTimeout||network?0:Number(error.diagnostic?.status)||Number(error.status)||0;
        const loginHtml=error.diagnostic?.type==='html-or-login-response'&&http===200&&/loginProcessing|j_username|name=["']userId["']/i.test(String(error.payload?.raw||''));
        if((http===401||loginHtml)&&!authRetried){
          authRetried=true;
          firstHttp=http||null;
          authReason=loginHtml?'HTML_OR_LOGIN':'HTTP_401';
          try{await ensureSession(true);}catch(e){throw failure('FIXED_MASTER_SESSION_UNAVAILABLE',e.status);}
          return readPage(options,attempt);
        }
        // Retry only the failed read-only page; successful prior pages remain
        // in memory. No login retries for transient failures or HTTP 403.
        const transient=localTimeout||network||http===429||error.diagnostic?.type==='http-error'&&[500,502,503,504].includes(http);
        if(transient&&attempt<2){progress.retries++;await sleep(1000*(attempt+1));return readPage(options,attempt+1);}
        throw failure(http===401||loginHtml?'FIXED_MASTER_AUTH_REQUIRED':http===403?'FIXED_MASTER_FORBIDDEN':localTimeout?'FIXED_MASTER_LOCAL_TIMEOUT':network?'FIXED_MASTER_NETWORK_FAILED':error.diagnostic?.type==='html-or-login-response'?'FIXED_MASTER_NON_JSON':'FIXED_MASTER_READ_FAILED',http,error.diagnostic?.type==='html-or-login-response'?'PARSE':'READ',localTimeout?'LOCAL_TIMEOUT':network?'NETWORK':error.diagnostic?'UPSTREAM_HTTP':'APPLICATION_STATUS');
      }
    }
    const projected = [];
    let sourceRows=0, pagingFieldRows=0;
    for (const logCd of ['011', '012', '013']) {
      let complete = false;
      // Same bounded paging contract as scraper/freshonFixedDispatch.js.
      for (let page = 0; page < 120; page++) {
        progress={...progress,phase:'READ',center:logCd,page,sourceRows};
        const body = new URLSearchParams({page: String(page), size: '1000', isPaging: 'true', isCount: 'true',
          sort: 'est_cd,ASC', logCd, estCd: '', estName: '', estNm: '', estGbn: '', startDate: '', endDate: '',
          carCd: '', carNm: '', shipGbn: '1', baecha: ''});
        // Large existing master offset pages exceed the daily-reader 25s
        // deadline. Keep this read-only master budget separate from collectors.
        const payload = await readPage({method: 'POST',timeoutMs:60000,
          headers: {'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'}, body: body.toString()});
        // fixedAlctnList's existing master contract is data: Row[]. Master rows
        // inherit paging fields (totalCnt/etc.); the daily-dispatch fallback
        // treats those as paging-only records and can discard real customers.
        const rows = Array.isArray(payload?.data) ? payload.data : extractRows(payload);
        if (!Array.isArray(rows)) throw failure('FIXED_MASTER_CONTRACT');
        sourceRows+=rows.length;
        pagingFieldRows+=rows.filter(row=>row&&row.estCd&&(row.totalCnt!=null||row.totalPages!=null||row.isPaging!=null||row.sortName!=null)).length;
        // Keep no contact/access/memo values between batches.
        projected.push(...rows.map(row => ({logCd,...Object.fromEntries(['estCd','mainCarSeqNm',
          ...['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day=>'carSeq'+day+'Nm')].map(key=>[key,row[key]]))})));
        if (rows.length < 1000) { complete = true; break; }
      }
      if (!complete) throw failure('FIXED_MASTER_INCOMPLETE');
    }
    if (!projected.length) throw failure('FIXED_MASTER_EMPTY');
    progress={...progress,phase:'DONE',sourceRows};
    return {data: projectFixedVehicles(projected),meta:{authRetried,firstHttp,authReason,readHttp:200,sourceRows,pagingFieldRows,retries:progress.retries}};
  };
  reader.getProgress=()=>progress?{...progress}:null;
  return reader;
}
