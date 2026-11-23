// Read-only, allowlisted projection of the current fixed-dispatch master.
// Raw rows never persist; only the separately allowlisted projection may persist.
import crypto from 'node:crypto';
import {normalizeFixedMasterCustomerKey} from './fixedMasterCustomerKey.js';
import {canonicalFixedMasterVehicle, isProjectedFixedMasterVehicle} from './fixedMasterVehicle.js';
import {projectFixedWeekdayValue} from '../public/opsmap/fixed-delivery-weekdays.mjs';
const masterKey = value => !!normalizeFixedMasterCustomerKey(value);
const pagingKeys = new Set(['totalCnt','totalPages','isPaging','sortName','sortOrder','page','size','number','numberOfElements','first','last','empty']);
// Counts only: never include customer identifiers, payload values, or raw rows
// in progress/errors. Unknown rows remain a hard failure, not discarded data.
export function inspectFixedMasterKeys(rows) {
  const counts={rows:rows.length,valid:0,invalid:0,missing:0,nullValue:0,blank:0,nonString:0,numericOnly:0,acceptedNumeric:0,unsupportedNumeric:0,otherFormat:0,nonObject:0,metadataOnly:0,customerFieldsPresent:0,duplicateValid:0};
  const seen=new Set();
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row)){counts.invalid++;counts.nonObject++;continue;}
    const value=row.estCd;
    const numericOnly=typeof value==='string'&&/^\d+$/.test(value.trim());
    if(numericOnly)counts.numericOnly++;
    if(masterKey(value)){counts.valid++;if(numericOnly)counts.acceptedNumeric++;const code=normalizeFixedMasterCustomerKey(value);if(seen.has(code))counts.duplicateValid++;seen.add(code);continue;}
    counts.invalid++;
    if(!Object.hasOwn(row,'estCd'))counts.missing++;
    else if(value==null)counts.nullValue++;
    else if(typeof value!=='string')counts.nonString++;
    else if(!value.trim())counts.blank++;
    else if(numericOnly)counts.unsupportedNumeric++;
    else counts.otherFormat++;
    const keys=Object.keys(row);
    if(keys.length&&keys.every(key=>pagingKeys.has(key)))counts.metadataOnly++;
    if(['estNm','estName','address','mainCarSeqNm','carCd',...['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day=>'carSeq'+day+'Nm')].some(key=>row[key]!=null&&String(row[key]).trim()))counts.customerFieldsPresent++;
  }
  return counts;
}
export function projectFixedVehicles(rows) {
  const result = new Map();
  for (const row of rows) {
    const customerCode = normalizeFixedMasterCustomerKey(row.estCd);
    if (!masterKey(customerCode)) continue;
    const primary = canonicalFixedMasterVehicle(row.mainCarSeqNm);
    const baseVehicle = /^\d+$/.test(primary) ? String(Number(primary)) : isProjectedFixedMasterVehicle(primary) ? primary : '';
    const previous = result.get(customerCode);
    const weekdays = Object.fromEntries(['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day => {
      const key = 'carSeq' + day + 'Nm';
      const value = projectFixedWeekdayValue(row[key], Object.hasOwn(row, key));
      // Separate weekday evidence from the primary route. Duplicate source
      // rows may agree on the primary route and still disagree about a day.
      return [day, previous && previous.weekdays[day] !== value ? '' : value];
    }));
    const baseVehicleGroup=({'011':'osan','012':'yeongnam','013':'honam'})[row.logCd]||'';
    const conflict = previous && (previous.baseVehicleState === 'CONFLICT' || previous.baseVehicle !== baseVehicle || previous.baseVehicleGroup&&baseVehicleGroup&&previous.baseVehicleGroup!==baseVehicleGroup);
    const explicitEmpty = row.mainCarSeqNm === null || typeof row.mainCarSeqNm === 'string' && !primary;
    result.set(customerCode, {customerCode, baseVehicle: conflict ? '' : baseVehicle,
      baseVehicleState: conflict ? 'CONFLICT' : baseVehicle ? 'VERIFIED_MASTER' : 'UNASSIGNED',
      baseVehicleGroup: conflict?'':baseVehicleGroup,
      ...(!conflict && explicitEmpty && (!previous || previous.baseVehicleEmptyVerified) ? {baseVehicleEmptyVerified:true} : {}),
      baseVehicleSource: 'FIXED_DISPATCH_PRIMARY', weekdays});
  }
  return [...result.values()];
}

const pageSize=1000;
const weekdayFields=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day=>'carSeq'+day+'Nm');
const projectedRow=(row,logCd)=>({logCd,...Object.fromEntries(['estCd','mainCarSeqNm',...weekdayFields].map(key=>[key,row[key]]))});
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pageIdentity=rows=>{
  const keys=rows.map(row=>normalizeFixedMasterCustomerKey(row.estCd));
  return {values:digest(rows),order:digest(keys),membership:digest([...keys].sort())};
};

export function createFixedVehicleReader({ensureSession, readJson, extractRows, pageConcurrency=1, verifyLastPage=false,
  strictPageCounts=false, preflightFirstPages=false, onScan, onPage, onPreflight, remainingPageRequests, reserveRescanRequests,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  if(![1,2].includes(pageConcurrency))throw Object.assign(Error('FIXED_MASTER_CONCURRENCY_INVALID'),{code:'FIXED_MASTER_CONCURRENCY_INVALID'});
  let progress=null;
  const reader=async function readFixedVehicleMaster({signal, customerCodes,preflightOnly=false}={}) {
    progress={phase:'SESSION',center:null,page:0,sourceRows:0,retries:0,completedCenters:[],pageConcurrency};
    const failure=(code,http=0,step='READ',kind='UNKNOWN')=>Object.assign(new Error(code),{code,status:Number(http)||0,step,kind});
    try{await ensureSession();}catch(error){throw failure('FIXED_MASTER_SESSION_UNAVAILABLE',error.status);}
    let authRetried=false,firstHttp=200,authReason=null,authEpoch=0,authRecovery=null;
    async function readPage(options,attempt=0){
      signal?.throwIfAborted();
      const requestAuthEpoch=authEpoch;
      try{
        const payload=await readJson('/bo/wm/standard/fixedAlctnList',options);
        if(Number(payload?.status)>=400)throw {status:Number(payload.status)};
        return payload;
      }catch(error){
        if(/^FIXED_MASTER_(?:DAILY_(?:PAGE_LIMIT|RESPONSE_INVALID)|STAGE_SOURCE_SCOPE)$/.test(error.code||''))throw error;
        // Same one-time expired-session recovery as the existing Freshon reader.
        // Reuse existing credentials; never retry a 403 or change permissions.
        // The shared reader maps its own AbortError to 504. Do not report that
        // synthesized value as an upstream HTTP response or expose its message.
        const localTimeout=!error.diagnostic&&error.status===504&&/^Freshon request timed out after \d+s \(/.test(String(error.message||''));
        const network=!error.diagnostic&&!error.status&&['ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'].includes(error.cause?.code||error.code);
        const http=localTimeout||network?0:Number(error.diagnostic?.status)||Number(error.status)||0;
        const loginHtml=error.diagnostic?.type==='html-or-login-response'&&http===200&&/loginProcessing|j_username|name=["']userId["']/i.test(String(error.payload?.raw||''));
        if((http===401||loginHtml)&&requestAuthEpoch===0){
          if(!authRetried){
            authRetried=true;firstHttp=http||null;authReason=loginHtml?'HTML_OR_LOGIN':'HTTP_401';
            authRecovery=Promise.resolve().then(()=>ensureSession(true)).then(()=>{authEpoch=1;});
          }
          try{await authRecovery;}catch(e){throw failure('FIXED_MASTER_SESSION_UNAVAILABLE',e.status);}
          return readPage(options,attempt);
        }
        // Retry only the failed read-only page; successful prior pages remain
        // in memory. No login retries for transient failures or HTTP 403.
        const transient=localTimeout||network||http===429||error.diagnostic?.type==='http-error'&&[500,502,503,504].includes(http);
        if(transient&&attempt<2){progress.retries++;await sleep(1000*(attempt+1));return readPage(options,attempt+1);}
        throw failure(http===401||loginHtml?'FIXED_MASTER_AUTH_REQUIRED':http===403?'FIXED_MASTER_FORBIDDEN':localTimeout?'FIXED_MASTER_LOCAL_TIMEOUT':network?'FIXED_MASTER_NETWORK_FAILED':error.diagnostic?.type==='html-or-login-response'?'FIXED_MASTER_NON_JSON':'FIXED_MASTER_READ_FAILED',http,error.diagnostic?.type==='html-or-login-response'?'PARSE':'READ',localTimeout?'LOCAL_TIMEOUT':network?'NETWORK':error.diagnostic?'UPSTREAM_HTTP':'APPLICATION_STATUS');
      }
    }
    const projected = [], allCustomerKeys=customerCodes ? new Set() : null;
    let sourceRows=0, pagingFieldRows=0;
    const centers=[];
    const centerCodes=['011','012','013'];
    const validateStrictPage=(rows,center)=>{
      if(!Array.isArray(rows)||rows.length>pageSize||rows.some(row=>!row||typeof row!=='object'))
        throw failure('FIXED_MASTER_CONTRACT',200,'PAGE_CONTRACT','SOURCE_CONTRACT');
      if(rows.some(row=>row.logCd!=null&&row.logCd!==center))
        throw failure('FIXED_MASTER_PAGE_CENTER_MISMATCH',200,'PAGE_CENTER','SOURCE_CONTRACT');
      const parseTotal=value=>typeof value==='number'||typeof value==='string'&&/^\d+$/.test(value) ? Number(value) : NaN;
      const count=parseTotal(rows[0]?.totalCnt);
      if(!Number.isSafeInteger(count)||count<0)
        throw failure('FIXED_MASTER_COUNT_INVALID',200,'PAGE_COUNT','SOURCE_CONTRACT');
      for(const row of rows) if(row.totalCnt!=null){
        const other=parseTotal(row.totalCnt);
        if(!Number.isSafeInteger(other)||other<0)
          throw failure('FIXED_MASTER_COUNT_INVALID',200,'PAGE_COUNT','SOURCE_CONTRACT');
        if(other!==count)throw failure('FIXED_MASTER_PAGE_COUNT_INCONSISTENT',200,'PAGE_COUNT','SOURCE_CHANGED');
      }
      return count;
    };
    const pageOptions=(logCd,page)=>({
      method:'POST',timeoutMs:60000,
      headers:{'content-type':'application/x-www-form-urlencoded; charset=UTF-8'},
      body:new URLSearchParams({page:String(page),size:String(pageSize),isPaging:'true',isCount:'true',
        sort:'est_cd,ASC',logCd,estCd:'',estName:'',estNm:'',estGbn:'',startDate:'',endDate:'',
        carCd:'',carNm:'',shipGbn:'1',baecha:''}).toString()
    });
    const firstPages=new Map();
    const pagePlan=rows=>{
      const pages=Math.ceil(rows/pageSize);
      return pages+(verifyLastPage&&pages>1?2:1);
    };
    if (preflightFirstPages || onPreflight || preflightOnly) {
      for (const center of centerCodes) {
        let declaredRows=null;
        try {
          const payload=await readPage(pageOptions(center,0));
          const rows=Array.isArray(payload?.data)?payload.data:extractRows(payload);
          const declared=rows?.[0]?.totalCnt;
          declaredRows=strictPageCounts?validateStrictPage(rows,center):declared==null?null:Number(declared);
          if (!Number.isSafeInteger(declaredRows)||declaredRows<=0||rows.length!==Math.min(pageSize,declaredRows)) {
            throw failure('FIXED_MASTER_COUNT_INVALID',200,'PAGE_COUNT','SOURCE_CONTRACT');
          }
          if (inspectFixedMasterKeys(rows).invalid || (onPreflight||preflightOnly)&&
              !['mainCarSeqNm',...weekdayFields].every(key=>rows.some(row=>Object.hasOwn(row,key)))) {
            throw failure('FIXED_MASTER_DAILY_RESPONSE_INVALID',200,'KEY_CONTRACT','SOURCE_CONTRACT');
          }
          if (!preflightOnly) firstPages.set(center,{data:rows.map(row=>({...projectedRow(row,center),totalCnt:row.totalCnt}))});
          onPreflight?.({center,page:0,state:'VERIFIED',sourceHttp:200,declaredRows,rows:rows.length});
        } catch (error) {
          const code=/^FIXED_MASTER_[A-Z_]+$/.test(error.code||'')?error.code:'FIXED_MASTER_READ_FAILED';
          onPreflight?.({center,page:0,state:'REJECTED',sourceHttp:error.status||null,
            declaredRows:Number.isSafeInteger(declaredRows)?declaredRows:null,error:code});
          throw error;
        }
      }
      if (preflightOnly) return {state:'FIRST_PAGES_VERIFIED',centerCount:centerCodes.length};
      const initialNeed=[...firstPages.values()].reduce((sum,page)=>sum+pagePlan(Number(page.data[0].totalCnt))-1,0);
      if(remainingPageRequests&&remainingPageRequests()<initialNeed){
        progress={...progress,phase:'ERROR',failureCode:'FIXED_MASTER_INITIAL_BUDGET',requiredRequests:initialNeed,
          remainingRequests:remainingPageRequests()};
        throw failure('FIXED_MASTER_INITIAL_BUDGET',0,'PREFLIGHT','SOURCE_LIMIT');
      }
    }
    for (const logCd of centerCodes) {
      let accepted=false;
      for(let scan=0;scan<2&&!accepted;scan++){
      const centerProjection=[],pageHashes=new Set(),centerCustomerKeys=new Set(),duplicateCustomerKeys=new Set(),batch=new Map();
      let centerPagingRows=0,firstPageHash=null,firstReadOptions=null,lastPageHash=null,lastReadOptions=null;
      let complete = false,centerRows=0,expectedRows=null;
      let followupDeclaredRows=null, countChange=null, retryBudget=null;
      const verification=[];
      const reportScan=(state,error)=>onScan?.({center:logCd,scan:scan+1,state,error:error?progress.failureCode:null,
        failedPage:error?(countChange?.page??verification.find(item=>item.state!=='SAME')?.page??progress.page):null,
        sourceHttp:error?.status??null,firstDeclaredRows:expectedRows,followupDeclaredRows,
        acceptedPages:pageHashes.size,acceptedRows:centerRows,countChange,verification,...(retryBudget?{retryBudget}:{})});
      try{
      // Same bounded paging contract as scraper/freshonFixedDispatch.js.
      for (let page = 0; page < 120; page++) {
        progress={...progress,phase:'READ',center:logCd,page,sourceRows:sourceRows+centerRows,scan,expectedRows,complete:false,failureCode:null,failureStep:null};
        // Large existing master offset pages exceed the daily-reader 25s
        // deadline. Keep this read-only master budget separate from collectors.
        const options=pageOptions(logCd,page);
        if(page===0)firstReadOptions=options;
        // Only the existing numbered-page contract is used. A known count may
        // fill one bounded batch; no new batch starts before the old one drains.
        if(!batch.size){
          const declaredPages=expectedRows===null?0:Math.ceil(expectedRows/pageSize);
          const width=pageConcurrency===2&&page>0&&page+1<declaredPages&&page+1<120?2:1;
          for(let offset=0;offset<width;offset++){
            const pageNumber=page+offset,body=new URLSearchParams(options.body);body.set('page',String(pageNumber));
            const firstPage=pageNumber===0?firstPages.get(logCd):null;
            if(firstPage)firstPages.delete(logCd);
            batch.set(pageNumber,firstPage?Promise.resolve({payload:firstPage}):
              readPage({...options,body:body.toString()}).then(payload=>({payload}),error=>({error})));
          }
        }
        const outcome=await batch.get(page);batch.delete(page);
        if(outcome.error)throw outcome.error;
        const payload = outcome.payload;
        // fixedAlctnList's existing master contract is data: Row[]. Master rows
        // inherit paging fields (totalCnt/etc.); the daily-dispatch fallback
        // treats those as paging-only records and can discard real customers.
        const rows = Array.isArray(payload?.data) ? payload.data : extractRows(payload);
        if (!Array.isArray(rows)) throw failure('FIXED_MASTER_CONTRACT');
        if(rows.length>pageSize)throw failure('FIXED_MASTER_PAGE_SIZE_INVALID',200,'PAGE_SIZE','SOURCE_CONTRACT');
        const keyProfile=inspectFixedMasterKeys(rows);
        progress={...progress,readHttp:200,pageRows:rows.length,declaredRows:rows[0]?.totalCnt!=null&&Number.isSafeInteger(Number(rows[0].totalCnt))&&Number(rows[0].totalCnt)>=0?Number(rows[0].totalCnt):null,keyProfile};
        if(keyProfile.invalid){
          progress={...progress,phase:'ERROR',failureStep:'KEY_CONTRACT',failureCode:'FIXED_MASTER_KEY_INVALID',complete:false};
          throw failure('FIXED_MASTER_KEY_INVALID',200,'KEY_CONTRACT','SOURCE_CONTRACT');
        }
        const declared=strictPageCounts&&(rows.length||page===0)?validateStrictPage(rows,logCd):rows[0]?.totalCnt;
        if(declared!=null){
          const count=Number(declared);
          if(!Number.isSafeInteger(count)||count<0)throw failure('FIXED_MASTER_COUNT_INVALID');
          if(page>0)followupDeclaredRows=count;
          if(expectedRows!==null&&expectedRows!==count){
            countChange={phase:'READ',page,expectedRows,declaredRows:count};
            progress={...progress,expectedRows,declaredRows:count,failureStep:'PAGE_COUNT'};
            throw failure('FIXED_MASTER_COUNT_CHANGED',200,'PAGE_COUNT','SOURCE_CHANGED');
          }
          expectedRows=count;
        }
        if(strictPageCounts&&rows.length!==Math.min(pageSize,Math.max(0,expectedRows-page*pageSize))) {
          throw failure('FIXED_MASTER_INCOMPLETE',200,'PAGE_SIZE','SOURCE_CONTRACT');
        }
        // Keep no contact/access/memo values between batches.
        const minimal=rows.map(row=>projectedRow(row,logCd));
        const pageHash=digest(minimal);
        // A repeated full page cannot prove pagination completeness. Source
        // row count is deliberately NOT compared with customerCode unique count.
        if(rows.length&&pageHashes.has(pageHash))throw failure('FIXED_MASTER_PAGE_REPEATED',200,'PAGE_IDENTITY','SOURCE_CHANGED');
        const keys=minimal.map(row=>normalizeFixedMasterCustomerKey(row.estCd));
        // A duplicated row within a page is source data. A key that occurs
        // across offset pages has no proven ordering tie-breaker and could
        // hide a lost customer when rows move during collection.
        if(strictPageCounts&&keys.some(key=>centerCustomerKeys.has(key)))
          throw failure('FIXED_MASTER_PAGE_CUSTOMER_OVERLAP',200,'PAGE_IDENTITY','SOURCE_CHANGED');
        for(const key of keys){if(centerCustomerKeys.has(key))duplicateCustomerKeys.add(key);centerCustomerKeys.add(key);}
        centerRows+=rows.length;
        centerPagingRows+=rows.filter(row=>row&&row.estCd&&(row.totalCnt!=null||row.totalPages!=null||row.isPaging!=null||row.sortName!=null)).length;
        if(rows.length)pageHashes.add(pageHash);
        if(page===0)firstPageHash=pageIdentity(minimal);
        if(rows.length){lastPageHash=page===0?firstPageHash:pageIdentity(minimal);lastReadOptions=options;}
        centerProjection.push(...(customerCodes?minimal.filter(row=>customerCodes.has(normalizeFixedMasterCustomerKey(row.estCd))):minimal));
        onPage?.({center:logCd,scan:scan+1,page,rows:rows.length,declaredRows:expectedRows,acceptedRows:centerRows});
        if (rows.length < pageSize || strictPageCounts&&centerRows===expectedRows) {
          if(expectedRows!==null&&centerRows!==expectedRows)throw failure('FIXED_MASTER_INCOMPLETE');complete = true; break;
        }
      }
      if (!complete) throw failure('FIXED_MASTER_INCOMPLETE');
      if(expectedRows!==null&&(strictPageCounts||centerRows>=pageSize)){
        progress={...progress,phase:'VERIFY',center:logCd,scan};
        const boundaries=[[firstReadOptions,firstPageHash],
          ...(verifyLastPage&&lastReadOptions&&lastReadOptions!==firstReadOptions?[[lastReadOptions,lastPageHash]]:[])];
        async function verifyPage([options,original]) {
          const page=Number(new URLSearchParams(options.body).get('page'));
          let check;
          try {check=await readPage(options);}
          catch(error){verification.push({page,state:'REQUEST_FAILED'});throw error;}
          const rows=Array.isArray(check?.data)?check.data:extractRows(check);
          let raw;
          try{raw=strictPageCounts?validateStrictPage(rows,logCd):rows?.[0]?.totalCnt;}
          catch(error){verification.push({page,state:'REQUEST_FAILED'});throw error;}
          const declaredRows=raw!=null&&Number.isSafeInteger(Number(raw))&&Number(raw)>=0?Number(raw):null;
          const comparison={page,declaredRows,rows:Array.isArray(rows)?rows.length:null,state:'SAME'};
          verification.push(comparison);
          if(declaredRows!==expectedRows){
            comparison.state='COUNT_CHANGED';
            countChange??={phase:'VERIFY',page,expectedRows,declaredRows};
            throw failure('FIXED_MASTER_COUNT_CHANGED',200,'VERIFY_COUNT','SOURCE_CHANGED');
          }
          const actual=pageIdentity(rows.map(row=>projectedRow(row,logCd)));
          if(actual.values!==original.values){
            comparison.state=actual.membership!==original.membership?'CUSTOMERS_CHANGED':actual.order!==original.order?'ORDER_CHANGED':'ASSIGNMENTS_CHANGED';
            throw failure('FIXED_MASTER_SOURCE_CHANGED',200,'VERIFY_PAGE','SOURCE_CHANGED');
          }
        }
        if(strictPageCounts&&pageConcurrency===2){
          const results=await Promise.allSettled(boundaries.map(verifyPage));
          const failed=results.find(result=>result.status==='rejected');
          if(failed)throw failed.reason;
        }else{
          for(const boundary of boundaries)await verifyPage(boundary);
        }
      }
      projected.push(...centerProjection);sourceRows+=centerRows;pagingFieldRows+=centerPagingRows;
      if(allCustomerKeys)for(const key of centerCustomerKeys)allCustomerKeys.add(key);
      centers.push({center:logCd,sourceRows:centerRows,declaredRows:expectedRows,pages:pageHashes.size,scan,firstPageHash:firstPageHash?.values||null,uniqueCustomers:centerCustomerKeys.size,duplicateCustomerRows:centerRows-centerCustomerKeys.size,duplicateCustomers:duplicateCustomerKeys.size});accepted=true;
      progress={...progress,completedCenters:centers.map(({center,sourceRows,declaredRows,pages,scan,uniqueCustomers,duplicateCustomerRows,duplicateCustomers})=>({center,sourceRows,declaredRows,pages,scan,uniqueCustomers,duplicateCustomerRows,duplicateCustomers}))};
      reportScan('VERIFIED');
      }catch(error){
        // Drain at most one remaining read before discarding this failed scan.
        // Outcome promises never reject, so unused failed pages cannot crash Node.
        await Promise.all(batch.values());batch.clear();
        progress={...progress,phase:'ERROR',complete:false,failureCode:/^FIXED_MASTER_[A-Z_]+$/.test(error.code||'')?error.code:'FIXED_MASTER_READ_FAILED'};
        // A scheduled strict scan can retry detected page drift under its
        // existing whole-run quota. The malformed page is never reused.
        const boundaryDrift=['FIXED_MASTER_COUNT_CHANGED','FIXED_MASTER_SOURCE_CHANGED'].includes(error.code);
        const budgetedPageDrift=strictPageCounts&&remainingPageRequests&&expectedRows!==null&&error.kind==='SOURCE_CHANGED';
        if(!(boundaryDrift||budgetedPageDrift)||scan===1){
          reportScan('REJECTED',error);
          throw error;
        }
        // Use the newest declared count to avoid starting a full rescan that
        // cannot fit within the remaining approved source requests.
        const nextRows=countChange?.declaredRows ?? expectedRows;
        const required=Number.isSafeInteger(nextRows)&&nextRows>0?pagePlan(nextRows):null;
        const remainingCenters=[...firstPages.values()].reduce((sum,page)=>sum+pagePlan(Number(page.data[0].totalCnt))-1,0);
        const reserved=required!==null&&(!reserveRescanRequests||reserveRescanRequests(required));
        const remaining=remainingPageRequests?.()??null;
        const canRetry=reserved&&(remaining===null||remaining>=required+remainingCenters);
        retryBudget={rescanRequests:required,remainingCenterRequests:remainingCenters,availableRequests:remaining,canRetry};
        reportScan('REJECTED',error);
        if(!canRetry){
          progress={...progress,failureCode:'FIXED_MASTER_RETRY_BUDGET',retryBudget};
          throw failure('FIXED_MASTER_RETRY_BUDGET',0,'REVALIDATING','SOURCE_LIMIT');
        }
        // Discard only the unstable candidate for this center. The existing
        // persisted projection is never changed by a failed or partial scan.
        progress={...progress,phase:'REVALIDATING',scan:scan+1};await sleep(1000);
      }
      }
    }
    if (!projected.length) throw failure('FIXED_MASTER_EMPTY');
    progress={...progress,phase:'DONE',sourceRows,complete:true};
    const data=projectFixedVehicles(projected),withinCenterDuplicateRows=centers.reduce((sum,center)=>sum+center.duplicateCustomerRows,0);
    const uniqueCustomers=allCustomerKeys?.size ?? data.length;
    return {data,meta:{authRetried,firstHttp,authReason,readHttp:200,sourceRows,pagingFieldRows,retries:progress.retries,centers,pageConcurrency,
      uniqueCustomers,...(allCustomerKeys?{projectedCustomers:data.length}:{}),withinCenterDuplicateRows,
      crossCenterDuplicateOccurrences:centers.reduce((sum,center)=>sum+center.uniqueCustomers,0)-uniqueCustomers,
      conflictingCustomers:data.filter(row=>row.baseVehicleState==='CONFLICT').length,snapshotIsolationVerified:false}};
  };
  reader.getProgress=()=>progress?{...progress}:null;
  return reader;
}
