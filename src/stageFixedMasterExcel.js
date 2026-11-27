import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {normalizeFixedMasterCustomerKey} from './fixedMasterCustomerKey.js';
import {projectFixedVehicles} from './fixedVehicleProjection.js';
import {FIXED_MASTER_EXCEL_SOURCE,stageFixedMasterSyncEnabled} from './stageFixedMasterSync.js';
import {loginFreshonOverHttp} from './scraper/freshonHttpSession.js';
import {FRESHON_NIGHT_DISPATCH} from './opsmapSyncPolicy.js';

const origin='https://mis.freshon.co.kr';
const endpoint=origin+'/bo/wm/standard/fixedAlctnList';
const helper=fileURLToPath(new URL('../scripts/read-fixed-master-excel.py',import.meta.url));
const centers=['011','012','013'];
const weekdays=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day=>'carSeq'+day+'Nm');
const fields=['mainCarSeqNm',...weekdays];
const MiB=1024*1024;
const transientHttp=new Set([408,429,500,502,503,504]);
const transientStream=e=>e?.name==='TimeoutError' || e?.name==='AbortError' ||
  ['ECONNRESET','ETIMEDOUT','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']
    .includes(e?.cause?.code??e?.code);
const worksheetColumns=Object.fromEntries([...'ACDEFGHIJ'].map((column,index)=>[column,['estCd',...fields][index]]));
const fail=(code,fixedDiagnostic)=>Object.assign(Error(code),{code,...(fixedDiagnostic?{fixedDiagnostic}:{})});
const day=now=>new Date(now+9*3600_000).toISOString().slice(0,10);

export async function readFixedMasterExcel(workbook,{codes,declaredRows,sha256,signal,
  python=process.platform==='win32'?'python':'python3'}={}) {
  const {PATH,Path,SystemRoot,SYSTEMROOT,TMP,TEMP,TMPDIR,USERPROFILE,HOME}=process.env;
  const child=spawn(python,['-X','utf8','-B',helper,String(process.pid)],{
    env:{PATH,Path,SystemRoot,SYSTEMROOT,TMP,TEMP,TMPDIR,USERPROFILE,HOME},
    stdio:['pipe','pipe','pipe'],windowsHide:true,signal
  });
  let stderr='',length=0;
  const chunks=[];
  child.stderr.on('data',chunk=>{if (stderr.length<4096) stderr+=chunk.toString();});
  child.stdout.on('data',chunk=>{
    length+=chunk.length;
    if(length>16*MiB) child.kill();
    else chunks.push(chunk);
  });
  const closed=new Promise(resolve=>{
    child.once('error',()=>resolve(null));
    child.once('close',resolve);
  });
  const input=Readable.from((async function*(){
    yield Buffer.from(JSON.stringify({codes:[...codes],declaredRows,sha256})+'\n');
    yield* workbook;
  })(),{objectMode:false});
  const [status,pipeError]=await Promise.all([closed,pipeline(input,child.stdin,{signal}).then(()=>null,error=>error)]);
  if(status!==0||pipeError){
    const detail=stderr.match(/^(FIXED_MASTER_EXCEL_[A-Z_]+) ([1-9][0-9]{0,6}) ([ACDEFGHIJ]) ([A-Z_]+)$/m);
    if(detail)throw fail(detail[1],{row:Number(detail[2]),field:worksheetColumns[detail[3]],reason:detail[4]});
    const code=stderr.match(/^FIXED_MASTER_EXCEL_[A-Z_]+$/m)?.[0];
    if(code)throw fail(code);
    if(transientStream(pipeError))throw fail('FIXED_MASTER_EXCEL_TRANSIENT',{reason:'BODY_INTERRUPTED'});
    throw fail('FIXED_MASTER_EXCEL_PARSE',{reason:'WORKBOOK_PARSE_FAILED'});
  }
  try {return JSON.parse(Buffer.concat(chunks,length).toString('utf8'));}
  catch {throw fail('FIXED_MASTER_EXCEL_PARSE');}
}

export function fixedMasterExcelRaw([estCd,...values],logCd) {
  return {estCd,logCd,...Object.fromEntries(fields.map((field,i)=>[field,values[i]]))};
}

export function projectFixedMasterExcel(raw,locations) {
  const rows=projectFixedVehicles(raw);
  for(const row of rows){
    let field='mainCarSeqNm', reason;
    if(row.baseVehicleState==='CONFLICT')reason='CONFLICT';
    else if(row.baseVehicleState==='UNASSIGNED' && row.baseVehicleEmptyVerified!==true)reason='UNVERIFIED_EMPTY';
    else{
      const invalidDay=Object.keys(row.weekdays).find(day=>!row.weekdays[day]);
      if(invalidDay){field='carSeq'+invalidDay+'Nm';reason='INVALID_FORMAT';}
    }
    if(reason)throw fail('FIXED_MASTER_EXCEL_FIELD',{...locations?.get(row.customerCode),field,reason});
  }
  return rows;
}

export function createStageFixedMasterExcelSource({env=process.env,fetchImpl=fetch,
  login=()=>loginFreshonOverHttp({origin,userId:env.FRESHON_ID,password:env.FRESHON_PASSWORD}),
  parseExcel=readFixedMasterExcel,now=Date.now,onCenter,onRetry}={}) {
  if(!stageFixedMasterSyncEnabled(env)||env.FRESHON_BASE_URL&&new URL(env.FRESHON_BASE_URL).origin!==origin) {
    throw fail('FIXED_MASTER_STAGE_SOURCE_SCOPE');
  }
  return async (codes,baseline)=>{
    if(!baseline?.version) throw fail('FIXED_MASTER_EXCEL_BASELINE');
    const timeout=AbortSignal.timeout(15*60_000);
    let cookie=env.FRESHON_COOKIE||'',attemptedLogin=false;
    async function ensureSession(){
      if(cookie) return;
      if(attemptedLogin||!env.FRESHON_ID||!env.FRESHON_PASSWORD) throw fail('FIXED_MASTER_AUTH_REQUIRED');
      attemptedLogin=true;
      const result=await login();
      if(!result?.cookie) throw fail('FIXED_MASTER_AUTH_REQUIRED');
      cookie=result.cookie;
    }
    async function request(center,excel){
      await ensureSession();
      const observedOn=day(now());
      const form=new URLSearchParams({
        page:'0',isCount:'true',isPaging:excel?'false':'true',size:excel?'1000':'1',sort:'est_cd,ASC',
        excelFileNm:'고정배차정보 내역_'+observedOn.replaceAll('-',''),logCd:center,estCd:'',estName:'',estNm:'',
        estGbn:'',startDate:'',endDate:'',carCd:'',carNm:'',shipGbn:'1',baecha:FRESHON_NIGHT_DISPATCH,
        ...(excel?{sortYn:'',excelExcute:'true'}:{})
      });
      const signal=AbortSignal.any([timeout,AbortSignal.timeout(excel?5*60_000:30_000)]);
      let response;
      try{
        response=await fetchImpl(endpoint,{method:'POST',redirect:'manual',body:form,signal,headers:{
          Cookie:cookie,Origin:origin,Referer:origin+'/bo/main','X-Requested-With':'XMLHttpRequest',
          Accept:excel?'*/*':'application/json','Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'
        }});
      }catch(error){
        if(error instanceof TypeError||transientStream(error))throw fail('FIXED_MASTER_EXCEL_TRANSIENT',{reason:'REQUEST_INTERRUPTED'});
        throw error;
      }
      const html=response.headers.get('content-type')?.includes('text/html');
      const redirect=response.status>=300&&response.status<400;
      if(response.status===200&&!html&&response.body)return {response,signal};
      await response.body?.cancel().catch(()=>{});
      if(response.status===401||redirect||html&&response.status===200) {
        if(!attemptedLogin){cookie='';return request(center,excel);}
        throw fail('FIXED_MASTER_AUTH_REQUIRED');
      }
      if(response.status===403) throw fail('FIXED_MASTER_FORBIDDEN');
      if(transientHttp.has(response.status))throw fail('FIXED_MASTER_EXCEL_TRANSIENT',{reason:'TRANSIENT_HTTP',status:response.status});
      throw fail('FIXED_MASTER_EXCEL_HTTP');
    }
    async function readCount(center){
      const {response}=await request(center,false);
      let bytes=0;
      const chunks=[];
      try{
        for await(const chunk of response.body){
          bytes+=chunk.length;
          if(bytes>MiB) throw fail('FIXED_MASTER_EXCEL_COUNT',{field:'totalCnt',reason:'COUNT_RESPONSE_SIZE'});
          chunks.push(chunk);
        }
      }catch(error){
        if(transientStream(error))throw fail('FIXED_MASTER_EXCEL_TRANSIENT',{field:'totalCnt',reason:'BODY_INTERRUPTED'});
        throw error;
      }
      let json;
      try {json=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));}
      catch {throw fail('FIXED_MASTER_EXCEL_COUNT',{field:'totalCnt',reason:'COUNT_RESPONSE_JSON'});}
      const row=json?.data?.[0],count=Number(row?.totalCnt);
      if(Number(json?.status)!==200||!Array.isArray(json.data)||json.data.length!==1||
          !Number.isSafeInteger(count)||count<1||count>120_000)
        throw fail('FIXED_MASTER_EXCEL_COUNT',{field:'totalCnt',reason:'COUNT_RESPONSE_FORMAT'});
      if(row.logCd!==center)throw fail('FIXED_MASTER_EXCEL_COUNT',{field:'logCd',reason:'CENTER_MISMATCH'});
      if(!normalizeFixedMasterCustomerKey(row.estCd))throw fail('FIXED_MASTER_EXCEL_COUNT',{field:'estCd',reason:'INVALID_FORMAT'});
      const missing=fields.find(field=>!Object.hasOwn(row,field));
      if(missing)throw fail('FIXED_MASTER_EXCEL_COUNT',{field:missing,reason:'MISSING_FIELD'});
      return {count,first:projectFixedVehicles([row])[0]};
    }
    async function readCenter(center){
      const before=await readCount(center);
      const {response,signal}=await request(center,true);
      if(Number(response.headers.get('content-length'))>64*MiB){
        await response.body.cancel().catch(()=>{});
        throw fail('FIXED_MASTER_EXCEL_DOWNLOAD_LIMIT',{reason:'DOWNLOAD_SIZE'});
      }
      const observedAt=new Date(now()).toISOString();
      const {sha256,codes:keys,selected,first}=await parseExcel(Readable.fromWeb(response.body),{
        codes,declaredRows:before.count,signal
      });
      const after=await readCount(center);
      const firstRow=projectFixedVehicles([fixedMasterExcelRaw(first,center)])[0];
      if(before.count!==after.count)throw fail('FIXED_MASTER_EXCEL_CENTER_DRIFT',{field:'totalCnt',reason:'COUNT_CHANGED'});
      if(JSON.stringify(firstRow)!==JSON.stringify(before.first)||JSON.stringify(firstRow)!==JSON.stringify(after.first)){
        throw fail('FIXED_MASTER_EXCEL_CENTER_DRIFT',{row:2,reason:'FIRST_ROW_CHANGED'});
      }
      if(keys.length!==before.count)throw fail('FIXED_MASTER_EXCEL_ROW_COUNT',{field:'totalCnt',reason:'DECLARED_COUNT_MISMATCH'});
      return {sha256,keys,selected,observedAt};
    }
    async function readCenterWithRetry(center){
      for(let attempt=1;;attempt++){
        try{return await readCenter(center);}
        catch(error){
          const fixedDiagnostic={...error.fixedDiagnostic,center};
          const recoverable=error.code==='FIXED_MASTER_EXCEL_TRANSIENT'||error.code==='FIXED_MASTER_EXCEL_CENTER_DRIFT'||
            error.code==='FIXED_MASTER_EXCEL_ROW_COUNT'&&fixedDiagnostic.reason==='DECLARED_COUNT_MISMATCH';
          if(attempt!==1||timeout.aborted||!recoverable)throw Object.assign(error,{fixedDiagnostic});
          onRetry?.({code:error.code,...fixedDiagnostic});
        }
      }
    }
    const seen=new Set(), raw=[], evidence=[], locations=new Map();
    for(const center of centers){
      const {sha256,keys,selected,observedAt}=await readCenterWithRetry(center);
      for(const [index,key] of keys.entries()){
        if(seen.has(key))throw fail('FIXED_MASTER_EXCEL_CUSTOMER_KEY',{center,row:index+2,field:'estCd',reason:'DUPLICATE'});
        if(codes.has(key))locations.set(key,{center,row:index+2});
        seen.add(key);
      }
      for(const row of selected)raw.push(fixedMasterExcelRaw(row,center));
      const item={center,sourceRows:keys.length,declaredRows:keys.length,duplicateCustomerRows:0,
        sha256,observedAt};
      evidence.push(item);
      onCenter?.(item);
    }
    const data=projectFixedMasterExcel(raw,locations);
    return {data,locations,meta:{source:FIXED_MASTER_EXCEL_SOURCE,baselineVersion:baseline.version,
      sourceRows:seen.size,uniqueCustomers:seen.size,projectedCustomers:data.length,centers:evidence}};
  };
}
