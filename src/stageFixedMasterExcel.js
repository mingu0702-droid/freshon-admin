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
const fail=code=>Object.assign(Error(code),{code});
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
  const [status,piped]=await Promise.all([closed,pipeline(input,child.stdin,{signal}).then(()=>true,()=>false)]);
  if(status!==0||!piped){
    const code=stderr.match(/^FIXED_MASTER_EXCEL_[A-Z_]+$/m)?.[0]||'FIXED_MASTER_EXCEL_PARSE';
    throw fail(code);
  }
  try {return JSON.parse(Buffer.concat(chunks,length).toString('utf8'));}
  catch {throw fail('FIXED_MASTER_EXCEL_PARSE');}
}

export function fixedMasterExcelRaw([estCd,...values],logCd) {
  return {estCd,logCd,...Object.fromEntries(fields.map((field,i)=>[field,values[i]]))};
}

export function projectFixedMasterExcel(raw) {
  const rows=projectFixedVehicles(raw);
  if (rows.some(row=>row.baseVehicleState==='CONFLICT' ||
      row.baseVehicleState==='UNASSIGNED' && row.baseVehicleEmptyVerified!==true ||
      Object.values(row.weekdays).some(value=>!value))) throw fail('FIXED_MASTER_EXCEL_FIELD');
  return rows;
}

export function createStageFixedMasterExcelSource({env=process.env,fetchImpl=fetch,
  login=()=>loginFreshonOverHttp({origin,userId:env.FRESHON_ID,password:env.FRESHON_PASSWORD}),
  parseExcel=readFixedMasterExcel,now=Date.now,onCenter}={}) {
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
      const response=await fetchImpl(endpoint,{method:'POST',redirect:'manual',body:form,signal,headers:{
        Cookie:cookie,Origin:origin,Referer:origin+'/bo/main','X-Requested-With':'XMLHttpRequest',
        Accept:excel?'*/*':'application/json','Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'
      }});
      const html=response.headers.get('content-type')?.includes('text/html');
      const redirect=response.status>=300&&response.status<400;
      if(response.status===200&&!html&&response.body)return {response,signal};
      await response.body?.cancel().catch(()=>{});
      if(response.status===401||redirect||html&&response.status===200) {
        if(!attemptedLogin){cookie='';return request(center,excel);}
        throw fail('FIXED_MASTER_AUTH_REQUIRED');
      }
      if(response.status===403) throw fail('FIXED_MASTER_FORBIDDEN');
      throw fail('FIXED_MASTER_EXCEL_HTTP');
    }
    async function readCount(center){
      const {response}=await request(center,false);
      let bytes=0;
      const chunks=[];
      for await(const chunk of response.body){
        bytes+=chunk.length;
        if(bytes>MiB) throw fail('FIXED_MASTER_EXCEL_COUNT');
        chunks.push(chunk);
      }
      let json;
      try {json=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));}
      catch {throw fail('FIXED_MASTER_EXCEL_COUNT');}
      const row=json?.data?.[0],count=Number(row?.totalCnt);
      if(Number(json?.status)!==200||!Array.isArray(json.data)||json.data.length!==1||row?.logCd!==center||
          !normalizeFixedMasterCustomerKey(row.estCd)||!Number.isSafeInteger(count)||count<1||count>120_000||
          fields.some(field=>!Object.hasOwn(row,field))) throw fail('FIXED_MASTER_EXCEL_COUNT');
      return {count,first:projectFixedVehicles([row])[0]};
    }
    const seen=new Set(), raw=[], evidence=[];
    for(const center of centers){
      const before=await readCount(center);
      const {response,signal}=await request(center,true);
      if(Number(response.headers.get('content-length'))>64*MiB){
        await response.body.cancel().catch(()=>{});
        throw fail('FIXED_MASTER_EXCEL_DOWNLOAD_LIMIT');
      }
      const observedAt=new Date(now()).toISOString();
      const {sha256,codes:keys,selected,first}=await parseExcel(Readable.fromWeb(response.body),{
        codes,declaredRows:before.count,signal
      });
      const after=await readCount(center);
      const firstRow=projectFixedVehicles([fixedMasterExcelRaw(first,center)])[0];
      if(before.count!==after.count || JSON.stringify(firstRow)!==JSON.stringify(before.first) ||
          JSON.stringify(firstRow)!==JSON.stringify(after.first)) throw fail('FIXED_MASTER_EXCEL_CENTER_DRIFT');
      for(const key of keys){
        if(seen.has(key)) throw fail('FIXED_MASTER_EXCEL_CUSTOMER_KEY');
        seen.add(key);
      }
      if(keys.length!==before.count)throw fail('FIXED_MASTER_EXCEL_ROW_COUNT');
      raw.push(...selected.map(row=>fixedMasterExcelRaw(row,center)));
      const item={center,sourceRows:keys.length,declaredRows:before.count,duplicateCustomerRows:0,
        sha256,observedAt};
      evidence.push(item);
      onCenter?.(item);
    }
    const data=projectFixedMasterExcel(raw);
    return {data,meta:{source:FIXED_MASTER_EXCEL_SOURCE,baselineVersion:baseline.version,
      sourceRows:seen.size,uniqueCustomers:seen.size,projectedCustomers:data.length,centers:evidence}};
  };
}
