import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { coordinateAddressHash } from './opsmap-abc/opsmapAutoCoordinates.js';
import { createPrivateGithubJsonStore } from './fixedVehicleStore.js';
import { STAGE_ORIGIN, STAGE_SERVICE } from './stageScope.js';
import {createStageWmsReleaseStore,isStageWmsDay,stageWmsArchiveKey,WMS_ARCHIVE_REPO,WMS_ARCHIVE_DIR} from './stageWmsExportIndex.js';

const source = 'WMS_CONFIRMED_DISPATCH_EXPORT';
const require = createRequire(import.meta.url);
const required = ['입고요청일','확정호차','고객','매출금액','배송건수','고객주소'];
const dayKey = /^\d{4}-\d{2}-\d{2}$/;
const codeKey = /^[A-Z]\d{1,20}$/;
const maxWorkbookBytes = 4 * 1024 * 1024;
const maxArchiveBytes = Math.ceil(maxWorkbookBytes / 3) * 4 + 256;
const scopeError = code => Object.assign(Error(code),{code});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveBinding = (date, {warehouse,sha256,observedAt}) =>
  Buffer.from(['opsmap-stage-wms-dispatch-v1', date, warehouse, sha256, observedAt].join('\n'));
const text = value => String(value ?? '').trim();
const won = value => /^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text(value)) && Number.isSafeInteger(Number(text(value).replace(/,/g,'')))
  ? Number(text(value).replace(/,/g,'')) : null;

function add(a,b) {
  const result = a+b;
  if (!Number.isSafeInteger(result)) throw scopeError('WMS_EXPORT_AMOUNT_OVERFLOW');
  return result;
}

export function parseOpsmapWmsDispatchExport(bytes,{date,observedAt}={}) {
  if (!dayKey.test(date||'') || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date ||
      !Number.isFinite(Date.parse(observedAt)) || !bytes?.length || bytes.length>maxWorkbookBytes) throw scopeError('WMS_EXPORT_SCOPE');
  const XLSX = require('xlsx');
  const workbook = XLSX.read(bytes,{type:'buffer',sheetRows:12001,cellFormula:false,cellText:false});
  if (workbook.SheetNames.length!==1) throw scopeError('WMS_EXPORT_SHEET_COUNT');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{header:1,defval:'',blankrows:false});
  const headers = rows.shift()?.map(text) ?? [];
  if (rows.length>=12000 || required.some(key=>headers.filter(value=>value===key).length!==1)) throw scopeError('WMS_EXPORT_HEADERS');
  const [day,route,customer,amount,deliveryCount,address] = required.map(key=>headers.indexOf(key));
  const name=headers.indexOf('고객명'), allocation=headers.indexOf('기준호차');
  const vehicles = new Map();
  let open = null, grand = null;
  for (const values of rows) {
    const stamp=text(values[day]), label=text(values[route]), code=text(values[customer]).toUpperCase();
    const sales=won(values[amount]), count=won(values[deliveryCount]);
    if (grand) throw scopeError('WMS_EXPORT_TRAILING_ROWS');
    if (stamp==='합계' || stamp==='' && (label==='소계' || label==='' && open?.vehicle==='미배정' && !code)) {
      if (sales===null || count===null || count<0 || code) throw scopeError('WMS_EXPORT_SUBTOTAL');
      if (stamp==='합계') {
        if (open || label || !vehicles.size) throw scopeError('WMS_EXPORT_TOTAL');
        grand={sales,count};
      } else {
        if (!open || count!==open.deliveryCount) throw scopeError('WMS_EXPORT_SUBTOTAL');
        vehicles.set(open.vehicle,{...open,amount:sales});
        open=null;
      }
      continue;
    }
    if (stamp.replace(/[.\-]/g,'')!==date.replace(/-/g,'')) throw scopeError('WMS_EXPORT_DATE_MISMATCH');
    const vehicle=label||'미배정';
    if ((label && !/^[0-9가-힣 -]{1,24}$/.test(label)) || !codeKey.test(code) || sales===null || count===null || count<1) {
      throw scopeError('WMS_EXPORT_INVALID_DETAIL');
    }
    if (!open) {
      if (vehicles.has(vehicle)) throw scopeError('WMS_EXPORT_DUPLICATE_ROUTE');
      open={vehicle,deliveryCount:0,details:new Map(),detailTotal:0};
    }
    if (vehicle!==open.vehicle) throw scopeError('WMS_EXPORT_DUPLICATE_DETAIL');
    const addressHash=coordinateAddressHash(values[address]);
    const originalName=text(values[name]);
    const customerName=originalName.length<=200&&!/[\x00-\x1f]/.test(originalName)?originalName:'';
    const originalAllocation=text(values[allocation]);
    const splitKey=/^[0-9가-힣 -]{1,24}$/.test(originalAllocation)?originalAllocation:'';
    const previous=open.details.get(code);
    if (previous) {
      if (vehicle==='미배정'||!addressHash||addressHash!==previous.addressHash||!customerName||
          customerName!==previous.customerName||!splitKey||previous.splits.has('')||previous.splits.has(splitKey)) {
        throw scopeError('WMS_EXPORT_DUPLICATE_DETAIL');
      }
      previous.splits.add(splitKey);
      previous.amount=add(previous.amount,sales);
    } else open.details.set(code,{customerCode:code,amount:sales,addressHash,customerName,splits:new Set([splitKey])});
    open.deliveryCount=add(open.deliveryCount,count);
    open.detailTotal=add(open.detailTotal,sales);
  }
  if (!grand || open || [...vehicles.values()].reduce((sum,row)=>add(sum,row.amount),0)!==grand.sales ||
      [...vehicles.values()].reduce((sum,row)=>add(sum,row.deliveryCount),0)!==grand.count) throw scopeError('WMS_EXPORT_TOTAL_MISMATCH');
  return {date,center:'osan',source,observedAt:new Date(observedAt).toISOString(),
    total:grand.sales,deliveryCount:grand.count,vehicles:[...vehicles.values()].map(row=>({
      vehicle:row.vehicle,amount:row.amount,deliveryCount:row.deliveryCount,details:[...row.details.values()].map(
        ({customerCode,amount,addressHash,customerName})=>({customerCode,amount,addressHash,...(customerName?{customerName}:{})})),
      detailTotal:row.detailTotal,difference:add(row.amount,-row.detailTotal),
    }))};
}

export function projectOpsmapWmsDispatch(exported, registry, postcodes=new Map()) {
  const rows = [];
  const vehicles = exported.vehicles.map(({vehicle,amount,details,detailTotal,difference})=>{
    let unmatched=0;
    const detailRows=[];
    for (const row of details) {
      const known=registry?.get(row.customerCode);
      const matched=Boolean(known?.center==='osan' && row.addressHash && row.addressHash===known.addressHash);
      if (!matched) unmatched++;
      if (vehicle!=='미배정') {
        const located=matched && known.hasPoint===true && Number.isFinite(known.lat) && Number.isFinite(known.lng);
        rows.push({customerCode:row.customerCode,vehicle,customerName:row.customerName||(matched?known.name:row.customerCode),
          postalCode:matched?postcodes.get(row.customerCode)??null:null,
          lat:located?known.lat:null,lng:located?known.lng:null,coordinateVerified:located,registryMatched:matched});
        detailRows.push({customerCode:row.customerCode,amount:row.amount});
      }
    }
    return {vehicle,amount,routeCode:null,detailState:vehicle==='미배정'?'UNAVAILABLE':'VERIFIED',
      detailTotal,difference,unmatched,detailRows};
  });
  return {date:exported.date,center:exported.center,source:exported.source,
    route:{state:'VERIFIED',observedAt:exported.observedAt,source:exported.source,rows,
      unassigned:exported.vehicles.find(row=>row.vehicle==='미배정')?.deliveryCount??0},
    amounts:{date:exported.date,state:'VERIFIED',observedAt:exported.observedAt,source:exported.source,vehicles}};
}

export function sealOpsmapWmsDispatchExport(bytes, {date,observedAt,key}) {
  const verified = parseOpsmapWmsDispatchExport(bytes,{date,observedAt});
  const manifest = {warehouse:'011',sha256:digest(bytes),observedAt:verified.observedAt};
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(archiveBinding(date,manifest));
  const ciphertext = Buffer.concat([cipher.update(bytes),cipher.final()]);
  return {manifest,archive:{schema:1,nonce:nonce.toString('hex'),tag:cipher.getAuthTag().toString('hex'),
    ciphertext:ciphertext.toString('base64')}};
}

function unpackArchive(value,date,expected,key) {
  if (value===null) throw scopeError('WMS_EXPORT_ARCHIVE_NOT_FOUND');
  if (value?.schema!==1 || !/^[0-9a-f]{24}$/.test(value.nonce) || !/^[0-9a-f]{32}$/.test(value.tag) ||
      typeof value.ciphertext!=='string' || !/^[A-Za-z0-9+/]+=*$/.test(value.ciphertext)) {
    throw scopeError('WMS_EXPORT_ARCHIVE_FORMAT');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm',key,Buffer.from(value.nonce,'hex'));
    decipher.setAAD(archiveBinding(date,expected));
    decipher.setAuthTag(Buffer.from(value.tag,'hex'));
    const bytes = Buffer.concat([decipher.update(Buffer.from(value.ciphertext,'base64')),decipher.final()]);
    if (!bytes.length || bytes.length>maxWorkbookBytes) throw Error('Invalid workbook size');
    return bytes;
  } catch { throw scopeError('WMS_EXPORT_ARCHIVE_INTEGRITY'); }
}

function createArchiveReader(env, fetchImpl) {
  const ref = env.OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_REF;
  const key = stageWmsArchiveKey(env);
  const token = env.OPSMAP_SHADOW_GITHUB_READ_TOKEN || env.OPSMAP_SNAPSHOT_STORE_TOKEN;
  const configuration={refValid:/^[a-f0-9]{40}$/.test(ref),keyValid:Boolean(key),
    tokenPresent:Boolean(token)};
  const configFailure=!configuration.refValid?'WMS_EXPORT_ARCHIVE_REF_INVALID':
    !configuration.keyValid?'WMS_EXPORT_ARCHIVE_KEY_INVALID':!configuration.tokenPresent?'WMS_EXPORT_ARCHIVE_TOKEN_MISSING':null;
  const store = !configFailure && createPrivateGithubJsonStore({
    env:{GITHUB_CACHE_REPO:WMS_ARCHIVE_REPO,GITHUB_CACHE_BRANCH:ref,GITHUB_CACHE_DIR:WMS_ARCHIVE_DIR,GITHUB_TOKEN:token},
    fetchImpl:(url,options)=>fetchImpl(url,{...options,method:'GET',redirect:'error'}),
  });
  const read = async (date, expected) => {
    if (configFailure) throw scopeError(configFailure);
    let value;
    try { value = await store.readRaw(date+'.json',maxArchiveBytes); }
    catch (error) {
      const code = {FIXED_STORE_PERMISSION:'WMS_EXPORT_ARCHIVE_PERMISSION',
        FIXED_STORE_NOT_PRIVATE:'WMS_EXPORT_ARCHIVE_PERMISSION',FIXED_STORE_INVALID:'WMS_EXPORT_ARCHIVE_FORMAT'}[error?.code];
      throw scopeError(code || 'WMS_EXPORT_ARCHIVE_READ');
    }
    return unpackArchive(value,date,expected,key);
  };
  return {read,configuration};
}

export function createStageWmsDispatchExportReader({env=process.env,readSecret=readFile,fetchImpl=fetch}={}) {
  const serviceVerified=env.RENDER_SERVICE_ID===STAGE_SERVICE && env.RENDER_EXTERNAL_URL===STAGE_ORIGIN;
  const approved=env.OPSMAP_STAGE_WMS_DISPATCH_EXPORT_APPROVED==='1';
  let manifest;
  if (serviceVerified && approved) {
    try {
      const parsed=JSON.parse(env.OPSMAP_STAGE_WMS_DISPATCH_EXPORTS_JSON);
      if (parsed && typeof parsed==='object' && !Array.isArray(parsed)) manifest=parsed;
    } catch { /* An unrecognized manifest has no approved files. */ }
  }
  const archive = manifest && env.OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_REF!==undefined
    ? createArchiveReader(env,fetchImpl) : null;
  const configurationFailure=date=>{
    if (!serviceVerified || !approved) return 'WMS_EXPORT_APPROVAL_MISSING';
    if (!manifest) return 'WMS_EXPORT_MANIFEST_INVALID';
    if (!dayKey.test(date||'') || !Object.hasOwn(manifest,date)) return 'WMS_EXPORT_DATE_NOT_APPROVED';
    const expected=manifest[date];
    if (expected?.warehouse!=='011') return 'WMS_EXPORT_WAREHOUSE_INVALID';
    if (!/^[a-f0-9]{64}$/.test(expected.sha256||'') || !Number.isFinite(Date.parse(expected.observedAt))) {
      return 'WMS_EXPORT_MANIFEST_ENTRY_INVALID';
    }
    return null;
  };
  const releaseStore = archive?.configuration.refValid&&archive.configuration.keyValid&&archive.configuration.tokenPresent
    ? createStageWmsReleaseStore({env,fetchImpl}) : null;
  const releaseKey = releaseStore ? stageWmsArchiveKey(env) : null;
  let indexRead,indexCache=null;
  async function releases(){
    if(!releaseStore)return [];
    if(indexCache?.until>Date.now())return indexCache.entries;
    if(!indexRead)indexRead=releaseStore.readIndex().then(({entries})=>{
      indexCache={until:Date.now()+30_000,entries};
      return entries;
    }).catch(error=>{
      if(error.code==='WMS_EXPORT_RELEASE_INDEX_INVALID')throw error;
      throw scopeError('WMS_EXPORT_RELEASE_INDEX_UNAVAILABLE');
    }).finally(()=>{indexRead=null;});
    return indexRead;
  }
  function verifyWorkbook(date,bytes) {
    const failure=configurationFailure(date);
    if (failure) throw scopeError(failure);
    return verifyManifestWorkbook(date,bytes,manifest[date]);
  }
  const jobs = new Map();
  const read=async date=>{
    const failure=configurationFailure(date);
    let entry;
    if(failure){
      if(failure!=='WMS_EXPORT_DATE_NOT_APPROVED'||!releaseStore||!isStageWmsDay(date))return null;
      entry=(await releases()).find(value=>value.date===date);
      if(!entry)return null;
    }
    const expected=entry||manifest[date];
    const cacheKey=entry?[date,entry.sha256,entry.observedAt].join('|'):date;
    if (!jobs.has(cacheKey)) {
      if (jobs.size>=4) jobs.delete(jobs.keys().next().value);
      const task=Promise.resolve().then(async()=>{
        let bytes;
        if(entry){
          let value;
          try {value=await releaseStore.readArchive(entry,maxArchiveBytes);}
          catch {throw scopeError('WMS_EXPORT_ARCHIVE_READ');}
          bytes=unpackArchive(value,date,entry,releaseKey);
        }else if (archive) bytes=await archive.read(date,expected);
        else {
          let encoded;
          try { encoded=(await readSecret('/etc/secrets/opsmap-wms-dispatch-'+date+'.xlsx.b64','utf8')).trim(); }
          catch { throw scopeError('WMS_EXPORT_SECRET_FILE_READ'); }
          if (encoded.length>5_600_000 || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) throw scopeError('WMS_EXPORT_ENCODING');
          bytes=Buffer.from(encoded,'base64');
        }
        return verifyManifestWorkbook(date,bytes,expected);
      }).catch(error=>{
        if(jobs.get(cacheKey)===task)jobs.delete(cacheKey);
        throw error;
      });
      jobs.set(cacheKey,task);
    }
    return jobs.get(cacheKey);
  };
  read.dates=Object.keys(manifest??{}).filter(date=>dayKey.test(date));
  read.verifyWorkbook=verifyWorkbook;
  read.availableDates=async()=>{
    const list=await releases().catch(()=>[]);
    return [...new Set([...read.dates,...list.map(entry=>entry.date)])];
  };
  read.hasVerifiedSource=date=>read.dates.includes(date)||indexCache?.entries.some(entry=>entry.date===date);
  read.configurationFailure=configurationFailure;
  read.configuration={serviceVerified,approved,manifestValid:Boolean(manifest),archive:archive?.configuration??null,
    dates:Object.fromEntries(read.dates.map(date=>[date,configurationFailure(date)??'VERIFIED']))};
  return read;
}


function verifyManifestWorkbook(date,bytes,manifest) {
  if (!bytes?.length || bytes.length>maxWorkbookBytes || digest(bytes)!==manifest.sha256) {
    throw scopeError('WMS_EXPORT_DIGEST');
  }
  try {return parseOpsmapWmsDispatchExport(bytes,{date,observedAt:manifest.observedAt});}
  catch (error) {
    throw scopeError(error?.code==='WMS_EXPORT_DATE_MISMATCH'?error.code:'WMS_EXPORT_WORKBOOK_INVALID');
  }
}

export async function publishStageWmsDispatchExport({bytes,date,observedAt,sha256,env=process.env,fetchImpl=fetch}={}){
  if(!isStageWmsDay(date))throw scopeError('WMS_EXPORT_SCOPE');
  const key=stageWmsArchiveKey(env);
  const archive=createStageWmsReleaseStore({env,fetchImpl,write:true});
  if(!archive||!key)throw scopeError('WMS_EXPORT_RELEASE_CONFIGURATION');
  let legacy;
  try {legacy=JSON.parse(env.OPSMAP_STAGE_WMS_DISPATCH_EXPORTS_JSON);}
  catch {throw scopeError('WMS_EXPORT_MANIFEST_INVALID');}
  if(!legacy||Array.isArray(legacy)||typeof legacy!=='object')throw scopeError('WMS_EXPORT_MANIFEST_INVALID');
  if(Object.hasOwn(legacy,date))throw scopeError('WMS_EXPORT_RELEASE_LEGACY_DATE');
  verifyManifestWorkbook(date,bytes,{sha256,observedAt});
  // Prove the operator's key opens an already approved pinned export before the
  // first release write. A newly generated or mistyped key cannot fork the archive.
  const probe=Object.keys(legacy).filter(isStageWmsDay).sort().at(-1);
  const pinned=legacy[probe];
  if(pinned?.warehouse!=='011'||!/^[a-f0-9]{64}$/.test(pinned.sha256||'')||
      !Number.isFinite(Date.parse(pinned.observedAt)))throw scopeError('WMS_EXPORT_MANIFEST_ENTRY_INVALID');
  const writer=env.OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_WRITE_TOKEN||env.OPSMAP_STAGE_SYNC_WRITE_TOKEN;
  const checkedArchive=createArchiveReader({...env,OPSMAP_SHADOW_GITHUB_READ_TOKEN:writer},fetchImpl);
  verifyManifestWorkbook(probe,await checkedArchive.read(probe,pinned),pinned);
  const dateEntry={date,warehouse:'011',sha256,observedAt};
  const verifyStored=async entry=>{
    const value=await archive.readArchive(entry,maxArchiveBytes);
    return verifyManifestWorkbook(date,unpackArchive(value,date,entry,key),entry);
  };
  for(let attempt=0;attempt<3;attempt++){
    const {sha,entries}=await archive.readIndex();
    const existing=entries.find(entry=>entry.date===date);
    if(existing){
      if(existing.sha256!==sha256)throw scopeError('WMS_EXPORT_RELEASE_DATE_CONFLICT');
      await verifyStored(existing);
      return {state:'VERIFIED_NOOP',date,sha256};
    }
    if(attempt===0){
      const {archive:sealed}=sealOpsmapWmsDispatchExport(bytes,{date,observedAt,key});
      try {await archive.createArchive(dateEntry,sealed);}
      catch(error){if(error.code!=='FIXED_STORE_CONFLICT')throw error;}
      await verifyStored(dateEntry);
    }
    try {await archive.writeIndex([...entries,dateEntry],sha);}
    catch(error){
      if(error.code==='FIXED_STORE_CONFLICT')continue;
      throw error;
    }
    const saved=(await archive.readIndex()).entries.find(entry=>entry.date===date);
    if(saved?.sha256!==sha256||saved.observedAt!==observedAt)throw scopeError('WMS_EXPORT_RELEASE_READBACK');
    await verifyStored(saved);
    return {state:'PUBLISHED',date,sha256};
  }
  throw scopeError('WMS_EXPORT_RELEASE_INDEX_BUSY');
}
