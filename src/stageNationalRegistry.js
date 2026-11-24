import {createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {gzip, gunzip} from 'node:zlib';
import {customerRegistryAddressHash} from './customerRegistry.js';
import {createPrivateGithubJsonStore} from './fixedVehicleStore.js';
import {opsmapArchiveSite,opsmapArchiveWriteApproved} from './stageScope.js';
import {SYNC_CENTERS} from './opsmapSyncPolicy.js';

const repository = 'mingu0702-droid/freshon-cache';
const branch = 'stage/opsmap-snapshots';
const freshonOrigin = 'https://mis.freshon.co.kr';
const registrationPath = '/bo/sm/standard/ciList';
const centerCodes = Object.freeze({osan:'011',yeongnam:'012',honam:'013'});
const centerNames = Object.freeze({osan:'오산물류센터',yeongnam:'영남센터',honam:'호남센터'});
const directory = 'stage-national-registry-v1';
const headName = directory + '/head.json';
const dataName = version => directory + '/registry-' + version + '.json';
const binding = Buffer.from('opsmap-stage/' + directory);
const limit = 30_000;
const scanLimit = 120_000;
const maxClearBytes = 12 * 1024 * 1024;
const maxSealedBytes = 4 * 1024 * 1024;
const dayMs = 24 * 60 * 60_000;
const leaseMs = 50 * 60_000;
const sha = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const customerCode = value => typeof value === 'string' && /^[A-Z]\d{1,20}$/.test(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const kstDay = stamp => new Date(stamp+9*3600000).toISOString().slice(0,10);
const zip = promisify(gzip), unzip = promisify(gunzip);
const failure = code => Object.assign(Error(code), {code});
const privateText = /[\x00-\x1f\x7f]|(?:\+?82[- ]?)?01[016789][-. ]?\d{3,4}[-. ]?\d{4}|비밀번호|비번|보안키|출입코드|공동현관|도어락|패스워드|password|passcode|bearer\s|https?:\/\//i;
const validText = (value,max) => typeof value === 'string' && value.length <= max && !privateText.test(value.normalize('NFKC'));
const stage = env => Boolean(opsmapArchiveSite(env));
export const NATIONAL_REGISTRY_WORKER_LIMIT = 45 * 60_000;
export const stageNationalRegistryEnabled = env => stage(env) && env.OPSMAP_STAGE_NATIONAL_REGISTRY_APPROVED === '1';

export function stageNationalRegistryScope(active) {
  if (active?.expiresAt!==Infinity || !(active.registry instanceof Map) ||
      active.registry.size!==active.counts?.registered) return null;
  return [...active.registry.values()].filter(row=>SYNC_CENTERS.includes(row.center))
    .map(row=>[row.code,row.center,customerRegistryAddressHash(row.address)]);
}

export async function readApprovedOsanRegistryRecoveryManifest({env=process.env,
  readManifest=()=>readFile('/etc/secrets/opsmap-osan-registry-recovery-v1.json','utf8')}={}) {
  const approved=env.OPSMAP_OSAN_REGISTRY_RECOVERY_SHA256;
  if(approved===undefined)return null;
  const denied=()=>failure('NATIONAL_REGISTRY_RECOVERY_SCOPE');
  if(!stageNationalRegistryEnabled(env)||!hash(approved))throw denied();
  let manifest;
  try{
    const raw=await readManifest();
    if(typeof raw!=='string'||Buffer.byteLength(raw)>64*1024||sha(raw)!==approved)throw denied();
    manifest=JSON.parse(raw);
  }catch{throw denied();}
  const expectedCount=manifest?.approval==='FRESHON_OSAN_RECOVERY_20261125'?374:
    manifest?.approval==='FRESHON_OSAN_CUTOVER_20261125'?398:0;
  if(manifest?.schema!==1||!expectedCount||!Array.isArray(manifest.rows)||manifest.rows.length!==expectedCount||
    manifest.rows.some(row=>!Array.isArray(row)||row.length!==2||!customerCode(row[0])||!hash(row[1]))||
    new Set(manifest.rows.map(row=>row[0])).size!==expectedCount)throw denied();
  const held=manifest.held;
  if(held!==undefined&&(!customerCode(held?.customerCode)||!hash(held.legacyVersion)||
    held.state!=='SOURCE_INACTIVE_UNCONFIRMED'||manifest.rows.some(([code])=>code===held.customerCode)))throw denied();
  return manifest;
}

export async function readApprovedOsanRegistryRecovery({env=process.env, readRegistry, readManifest}={}) {
  const manifest=await readApprovedOsanRegistryRecoveryManifest({env,readManifest});
  if(!manifest)return [];
  const denied=()=>failure('NATIONAL_REGISTRY_RECOVERY_SCOPE');
  if(typeof readRegistry!=='function')throw denied();
  const published=await readRegistry();
  if(!hash(published?.ref?.version)||!Array.isArray(published.rows))throw denied();
  const current=new Map(published.rows.map(row=>[row.customerCode,row]));
  if(manifest.rows.some(([code])=>!current.has(code)))throw denied();
  return manifest.rows.flatMap(([code,addressHash])=>{
    const row=current.get(code);
    return row.lifecycle==='ACTIVE'&&row.centerGroup==='osan'&&row.addressHash===addressHash
      ?[[code,'osan',addressHash]]:[];
  });
}

export function scopedNationalRegistryMembership(base, regional, approvedRecovery=[]) {
  if (!Array.isArray(base) || !base.length || !Array.isArray(regional) || base.length+regional.length>limit)
    throw failure('NATIONAL_REGISTRY_SCOPE_UNAVAILABLE');
  const membership=new Map();
  for (const [code,center,addressHash] of [
    ...base,...regional.map(row=>[row.customerCode,row.centerGroup,customerRegistryAddressHash(row.basicAddress)])
  ]) {
    if (!customerCode(code) || !SYNC_CENTERS.includes(center) || !hash(addressHash) || membership.has(code))
      throw failure('NATIONAL_REGISTRY_SCOPE_UNAVAILABLE');
    membership.set(code,{center,addressHash});
  }
  if(!Array.isArray(approvedRecovery))throw failure('NATIONAL_REGISTRY_RECOVERY_SCOPE');
  for(const [code,center,addressHash] of approvedRecovery){
    if(!customerCode(code)||center!=='osan'||!hash(addressHash))throw failure('NATIONAL_REGISTRY_RECOVERY_SCOPE');
    if(!membership.has(code))membership.set(code,{center,addressHash});
  }
  if(membership.size>limit||new Set([...membership.values()].map(row=>row.center)).size!==SYNC_CENTERS.length)
    throw failure('NATIONAL_REGISTRY_SCOPE_UNAVAILABLE');
  return membership;
}

function rowOf(value, withPoint=false) {
  const {customerCode:code, customerName, basicAddress, centerGroup, lifecycle, sourceUpdatedAt='', verifiedLocation} = value || {};
  if (!customerCode(code) || !SYNC_CENTERS.includes(centerGroup) || !['ACTIVE','DELETED'].includes(lifecycle) ||
      !validText(customerName,200) || !validText(basicAddress,500) || lifecycle==='ACTIVE'&&!customerName.trim() ||
      sourceUpdatedAt!=='' && !time(sourceUpdatedAt)) throw failure('NATIONAL_REGISTRY_ROW_INVALID');
  const addressHash = customerRegistryAddressHash(basicAddress);
  if (value.addressHash!==undefined && value.addressHash!==addressHash) throw failure('NATIONAL_REGISTRY_ADDRESS_HASH');
  if (withPoint && verifiedLocation !== undefined &&
      (lifecycle!=='ACTIVE' || !verifiedLocation || verifiedLocation.addressHash!==addressHash ||
      !Number.isFinite(verifiedLocation.lat) || !Number.isFinite(verifiedLocation.lng) ||
      verifiedLocation.lat<33 || verifiedLocation.lat>39.5 || verifiedLocation.lng<124 || verifiedLocation.lng>132 ||
      !['BUILDING','PARCEL','ADDRESS'].includes(verifiedLocation.kind))) throw failure('NATIONAL_REGISTRY_POINT_INVALID');
  return {customerCode:code,customerName,basicAddress,centerGroup,lifecycle,addressHash,sourceUpdatedAt,
    ...(withPoint&&verifiedLocation?{verifiedLocation:{addressHash,lat:verifiedLocation.lat,lng:verifiedLocation.lng,kind:verifiedLocation.kind}}:{})};
}

function normalizeRows(input, withPoint=false) {
  if (!Array.isArray(input) || input.length>limit) throw failure('NATIONAL_REGISTRY_ROWS_INVALID');
  const rows = input.map(row=>rowOf(row,withPoint)).sort((a,b)=>a.customerCode.localeCompare(b.customerCode,'en'));
  if (new Set(rows.map(row=>row.customerCode)).size!==rows.length) throw failure('NATIONAL_REGISTRY_DUPLICATE_CUSTOMER');
  return rows;
}

export async function collectStageNationalRegistry(readCenter) {
  const rows=[], counts={};
  for (const center of SYNC_CENTERS) {
    const response=await readCenter(center);
    if (response?.center!==center || response.complete!==true || !Array.isArray(response.rows) ||
        !Number.isSafeInteger(response.total) || response.total<1 || response.rows.length!==response.total ||
        response.rows.some(row=>row?.centerGroup!==center)) throw failure('NATIONAL_REGISTRY_CENTER_INCOMPLETE');
    counts[center]=response.total;
    rows.push(...response.rows);
  }
  return {rows:normalizeRows(rows),counts};
}

export function createStageNationalRegistrationSource({env=process.env,fetchImpl=fetch,login,membership}={}) {
  if (!stageNationalRegistryEnabled(env) || (env.FRESHON_BASE_URL && new URL(env.FRESHON_BASE_URL).origin!==freshonOrigin))
    throw failure('NATIONAL_REGISTRY_SOURCE_APPROVAL');
  let contract;
  try {contract=JSON.parse(env.OPSMAP_STAGE_NATIONAL_REGISTRY_CONTRACT_JSON||'null');} catch { /* Use only a verified response contract. */ }
  const field = value => typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(value)&&
    !['constructor','prototype','__proto__'].includes(value);
  if (!contract || !['GET','POST'].includes(contract.method) || !['FULL','PAGED'].includes(contract.mode) ||
      !(contract.rowsKey === null || field(contract.rowsKey)) || !field(contract.totalField) ||
      !['BODY','FIRST_ROW'].includes(contract.totalLocation) || !field(contract.addressField) ||
      !field(contract.centerField) || !field(contract.activeField) || contract.updatedAtField!=null&&!field(contract.updatedAtField))
    throw failure('NATIONAL_REGISTRY_SOURCE_CONTRACT');
  let cookie=String(env.FRESHON_COOKIE||''), loginAttempted=false;
  const budget=AbortSignal.timeout(membership?NATIONAL_REGISTRY_WORKER_LIMIT-3*60_000:10*60_000);
  async function ensureSession(force=false) {
    if (!force && cookie) return;
    if (loginAttempted || !env.FRESHON_ID || !env.FRESHON_PASSWORD) throw failure('NATIONAL_REGISTRY_AUTH_REQUIRED');
    loginAttempted=true;
    const authenticate=login || (async()=>{
      const {config}=await import('./config.js');
      if(new URL(config.freshonBaseUrl).origin!==freshonOrigin)throw failure('NATIONAL_REGISTRY_SOURCE_SCOPE');
      return (await import('./scraper/freshonDailyRoute.js')).loginFreshonSession();
    });
    const result=await authenticate();
    if (!result?.cookie || result.cookie===cookie) throw failure('NATIONAL_REGISTRY_AUTH_REQUIRED');
    cookie=result.cookie;
  }
  const readField=(value,key)=>value&&Object.hasOwn(value,key)?value[key]:undefined;
  async function readPage(center,status,page) {
    await ensureSession();
    const params=new URLSearchParams({logCd:centerCodes[center],useYn:status,sort:membership?'est_cd,ASC':'ASC',page:String(page),
      size:contract.mode==='PAGED'?'1000':'100',isPaging:contract.mode==='PAGED'?'true':'false',isCount:'true'});
    const url=new URL(registrationPath,freshonOrigin);
    const headers={Cookie:cookie,Accept:'application/json, text/plain, */*','X-Requested-With':'XMLHttpRequest',
      Origin:freshonOrigin,Referer:freshonOrigin+'/bo/main'};
    if (contract.method==='GET') url.search=params;
    else headers['Content-Type']='application/x-www-form-urlencoded; charset=UTF-8';
    for (let attempt=0;attempt<3;attempt++) {
      headers.Cookie=cookie;
      const response=await fetchImpl(url,{method:contract.method,headers,redirect:'manual',
        ...(contract.method==='POST'?{body:params.toString()}:{}),signal:AbortSignal.any([budget,AbortSignal.timeout(60_000)])});
      const loginPage=response.status===401 || response.status>=300&&response.status<400 ||
        response.headers.get('content-type')?.includes('text/html');
      if (loginPage && !loginAttempted) {
        await response.body?.cancel().catch(()=>{});
        await ensureSession(true);
        continue;
      }
      if (!response.ok || loginPage) {
        await response.body?.cancel().catch(()=>{});
        if ([429,500,502,503,504].includes(response.status) && attempt<2) {
          await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
          continue;
        }
        throw failure(loginPage?'NATIONAL_REGISTRY_AUTH_REQUIRED':response.status===403?'NATIONAL_REGISTRY_FORBIDDEN':'NATIONAL_REGISTRY_SOURCE_HTTP');
      }
      if (!response.body || Number(response.headers.get('content-length'))>maxClearBytes) throw failure('NATIONAL_REGISTRY_SOURCE_SIZE');
      const chunks=[];
      let bytes=0;
      for await (const chunk of response.body) {
        bytes+=chunk.length;
        if (bytes>maxClearBytes) throw failure('NATIONAL_REGISTRY_SOURCE_SIZE');
        chunks.push(chunk);
      }
      let result;
      try {result=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));} catch {throw failure('NATIONAL_REGISTRY_SOURCE_CONTRACT');}
      const rows=contract.rowsKey===null?result:readField(result,contract.rowsKey);
      const declared=readField(contract.totalLocation==='BODY'?result:rows?.[0],contract.totalField);
      const total=typeof declared==='number'||typeof declared==='string'&&/^\d+$/.test(declared)?Number(declared):null;
      if (!Array.isArray(rows) || !Number.isSafeInteger(total) || total<0 || total>(membership?scanLimit:limit))
        throw failure('NATIONAL_REGISTRY_SOURCE_CONTRACT');
      return {rows,total};
    }
    throw failure('NATIONAL_REGISTRY_SOURCE_HTTP');
  }
  return async center => {
    if (!Object.hasOwn(centerCodes,center)) throw failure('NATIONAL_REGISTRY_SOURCE_SCOPE');
    const sourceCenter=contract.centerField==='logCdName'?centerNames[center]:centerCodes[center];
    const rows=[];
    let total=0;
    for (const status of (membership?['Y']:['Y','N'])) {
      let expected=null, collected=0;
      const pageHashes=new Set(), captured=new Set();
      for (let page=0;page<Math.ceil((membership?scanLimit:limit)/1000);page++) {
        const response=await readPage(center,status,page);
        expected??=response.total;
        if (response.total!==expected || contract.mode==='PAGED'&&response.rows.length>1000 ||
            collected+response.rows.length>expected || !response.rows.length&&collected<expected)
          throw failure('NATIONAL_REGISTRY_CENTER_INCOMPLETE');
        if (membership) {
          const size=Math.min(1000,expected-collected);
          const pageHash=sha(JSON.stringify(response.rows.map(row=>readField(row,'estCd'))));
          if (contract.mode==='PAGED' && response.rows.length!==size || pageHashes.has(pageHash))
            throw failure('NATIONAL_REGISTRY_CENTER_INCOMPLETE');
          pageHashes.add(pageHash);
        }
        for (const row of response.rows) {
          if (String(readField(row,contract.centerField))!==sourceCenter || readField(row,contract.activeField)!==status)
            throw failure('NATIONAL_REGISTRY_SOURCE_SCOPE');
          const address=readField(row,contract.addressField);
          const code=readField(row,'estCd');
          if (membership) {
            const approved=membership.get(code);
            if (approved?.center!==center) continue;
            if (captured.has(code)) throw failure('NATIONAL_REGISTRY_DUPLICATE_CUSTOMER');
            captured.add(code);
            // Keep the verified point and its matching address until an address change is reviewed.
            if (typeof address!=='string' || customerRegistryAddressHash(address)!==approved.addressHash) continue;
          }
          if (status==='Y' && typeof address!=='string') throw failure('NATIONAL_REGISTRY_SOURCE_CONTRACT');
          rows.push(rowOf({customerCode:code,customerName:readField(row,'estName')??'',
            basicAddress:address??'',centerGroup:center,lifecycle:status==='Y'?'ACTIVE':'DELETED',
            sourceUpdatedAt:contract.updatedAtField?readField(row,contract.updatedAtField)??'':''}));
        }
        collected+=response.rows.length;
        if (collected===expected) break;
        if (contract.mode==='FULL') throw failure('NATIONAL_REGISTRY_CENTER_INCOMPLETE');
      }
      if (collected!==expected) throw failure('NATIONAL_REGISTRY_CENTER_INCOMPLETE');
      total+=collected;
    }
    return {center,rows,total:membership?rows.length:total,complete:true};
  };
}

export function mergeStageNationalRegistry(previous, incoming, official=[]) {
  const current=new Map(normalizeRows(previous,true).map(row=>[row.customerCode,row]));
  const points=new Map(official.filter(row=>row.verifiedLocation).map(row=>[row.customerCode,row]));
  for (const row of normalizeRows(incoming)) {
    const existing=current.get(row.customerCode);
    if (existing?.sourceUpdatedAt && row.sourceUpdatedAt && Date.parse(row.sourceUpdatedAt)<Date.parse(existing.sourceUpdatedAt)) continue;
    if (row.lifecycle==='ACTIVE') {
      const known=[existing,points.get(row.customerCode)].find(value=>
        value?.verifiedLocation && value.centerGroup===row.centerGroup && value.addressHash===row.addressHash);
      if (known) row.verifiedLocation=known.verifiedLocation;
    }
    current.set(row.customerCode,row);
  }
  return normalizeRows([...current.values()],true);
}

export function createStageNationalRegistryStorage({env=process.env, fetchImpl=fetch, now=Date.now, write=false}={}) {
  if (!stageNationalRegistryEnabled(env) || env.OPSMAP_STAGE_SYNC_REMOTE_APPROVED!=='1' ||
      write && (!opsmapArchiveWriteApproved(env)||env.OPSMAP_STAGE_SYNC_PUBLISH_APPROVED!=='1')) return null;
  const encoded=env.OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64;
  const token=write ? env.OPSMAP_STAGE_SYNC_WRITE_TOKEN ||
    (env.OPSMAP_STAGE_SYNC_USE_SNAPSHOT_WRITER==='1'&&env.OPSMAP_SNAPSHOT_STORE_TOKEN) :
    env.OPSMAP_STAGE_SYNC_READ_TOKEN || env.OPSMAP_SNAPSHOT_STORE_TOKEN || env.OPSMAP_SHADOW_GITHUB_READ_TOKEN;
  if (!token || !/^[A-Za-z0-9+/]{43}=$/.test(encoded||'')) return null;
  const root='https://api.github.com/repos/'+repository;
  const store=createPrivateGithubJsonStore({now,
    env:{GITHUB_CACHE_REPO:repository,GITHUB_TOKEN:token,GITHUB_CACHE_BRANCH:branch,GITHUB_CACHE_DIR:'opsmap-stage'},
    fetchImpl(input,options={}) {
      const url=new URL(input), method=options.method||'GET';
      const endpoint=url.origin+url.pathname, base=root+'/contents/opsmap-stage/';
      const name=endpoint.startsWith(base)?endpoint.slice(base.length):'';
      const allowedName=name===headName || /^stage-national-registry-v1\/registry-[a-f0-9]{64}\.json$/.test(name);
      const read=method==='GET'&&(allowedName&&url.searchParams.size===1&&url.searchParams.get('ref')===branch || endpoint===root&&!url.search);
      const update=write&&method==='PUT'&&allowedName&&!url.search&&JSON.parse(options.body||'{}').branch===branch;
      if ((!read&&!update) || url.username || url.password || url.hash) throw failure('NATIONAL_REGISTRY_STORAGE_SCOPE');
      return fetchImpl(input,{...options,redirect:'error'});
    }});
  const key=Buffer.from(hkdfSync('sha256',Buffer.from(encoded,'base64'),binding,Buffer.from('asset-encryption'),32));
  return {key,readHead:()=>store.read(headName),readObject:version=>store.readRaw(dataName(version),maxSealedBytes),
    ...(write?{writeHead:(next,etag)=>store.write(headName,next,etag),writeObject:(version,value)=>store.write(dataName(version),value,null)}:{})};
}

async function encode(rows,key) {
  const bytes=Buffer.from(JSON.stringify(rows));
  if (bytes.length>maxClearBytes) throw failure('NATIONAL_REGISTRY_STORAGE_SIZE');
  const version=sha(bytes), nonce=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(binding);
  const packed=Buffer.concat([nonce,cipher.update(await zip(bytes)),cipher.final(),cipher.getAuthTag()]).toString('base64');
  if (Buffer.byteLength(packed)>maxSealedBytes-1024) throw failure('NATIONAL_REGISTRY_STORAGE_SIZE');
  return {version,packed};
}

async function decode(store, ref) {
  const saved=await store.readObject(ref.version);
  if (saved?.version!==ref.version || typeof saved.packed!=='string' || saved.packed.length>maxSealedBytes)
    throw failure('NATIONAL_REGISTRY_STORAGE_OBJECT');
  const packed=Buffer.from(saved.packed,'base64');
  if (packed.length<29) throw failure('NATIONAL_REGISTRY_STORAGE_OBJECT');
  const decipher=createDecipheriv('aes-256-gcm',store.key,packed.subarray(0,12));
  decipher.setAAD(binding);
  decipher.setAuthTag(packed.subarray(-16));
  const bytes=await unzip(Buffer.concat([decipher.update(packed.subarray(12,-16)),decipher.final()]),{maxOutputLength:maxClearBytes});
  if (sha(bytes)!==ref.version) throw failure('NATIONAL_REGISTRY_STORAGE_INTEGRITY');
  const rows=normalizeRows(JSON.parse(bytes.toString('utf8')),true);
  if (ref.count!==undefined&&rows.length!==ref.count) throw failure('NATIONAL_REGISTRY_STORAGE_COUNT');
  return rows;
}

// The encrypted immutable object's SHA authenticates an exact previous version.
export async function readStageNationalRegistryRows(store,version) {
  if(!store||!hash(version))throw failure('NATIONAL_REGISTRY_STORAGE_OBJECT');
  return decode(store,{version});
}

async function readHead(store) {
  const {value,sha:etag}=await store.readHead();
  if (!value&&!etag) return {head:{schema:1,current:null,previous:null,attempt:null,lastSuccessAt:null,lastError:null},etag:null};
  const goodRef=ref=>hash(ref?.version)&&Number.isSafeInteger(ref.count)&&ref.count>=1&&ref.count<=limit&&time(ref.checkedAt);
  if (value?.schema!==1 || !/^[a-f0-9]{40}$/.test(etag||'') ||
      value.current!==null&&!goodRef(value.current) || value.previous!==null&&!goodRef(value.previous) ||
      value.lastSuccessAt!==null&&!time(value.lastSuccessAt) || value.attempt!==null&&
      (!hash(value.attempt?.id) || !time(value.attempt?.at) || !['RUNNING','FAILED','VERIFIED'].includes(value.attempt?.state)))
    throw failure('NATIONAL_REGISTRY_STORAGE_HEAD');
  return {head:value,etag};
}

export function createStageNationalRegistryReader({store,now=Date.now,log=()=>{}}={}) {
  if (!store) return null;
  let saved,pending,checkAt=0;
  const reportReadFailure=error=>log({state:'READ_FAILED',error:/^(?:NATIONAL_REGISTRY|FIXED_STORE)_[A-Z_]+$/.test(error?.code||'')?
    error.code:'NATIONAL_REGISTRY_STORAGE_READ_FAILED',usingPrevious:!!saved});
  return {read() {
    if (now()<checkAt) return Promise.resolve(saved);
    pending ??= (async()=>{
      try {
        const {head}=await readHead(store);
        if (!head.current) return saved;
        if (saved?.ref.version===head.current.version && saved.ref.checkedAt===head.current.checkedAt) return saved;
        try {
          saved={ref:head.current,rows:await decode(store,head.current),lastSuccessAt:head.lastSuccessAt};
          log({state:'VERIFIED',version:saved.ref.version,count:saved.rows.length,checkedAt:saved.ref.checkedAt});
        }
        catch(error) {
          if (!saved&&head.previous) saved={ref:head.previous,rows:await decode(store,head.previous),lastSuccessAt:null};
          reportReadFailure(error);
        }
        return saved;
      } catch(error) {reportReadFailure(error);return saved;}
      finally {checkAt=now()+60_000;}
    })().finally(()=>{pending=null;});
    return pending;
  }};
}

export async function syncStageNationalRegistry({store,receipt,readCenter,readOfficial,now=Date.now}) {
  if (!store?.writeHead || !hash(receipt?.runId) || receipt.date!==kstDay(now())) throw failure('NATIONAL_REGISTRY_RECEIPT');
  const {head,etag}=await readHead(store);
  if (head.lastSuccessAt && kstDay(Date.parse(head.lastSuccessAt))===receipt.date) return {state:'ALREADY_VERIFIED'};
  if (head.attempt?.state==='RUNNING' && now()-Date.parse(head.attempt.at)<leaseMs) return {state:'BUSY'};
  if (head.attempt?.id===receipt.runId && now()-Date.parse(head.attempt.at)<dayMs) return {state:'ALREADY_ATTEMPTED'};
  const attempt={id:receipt.runId,at:new Date(now()).toISOString(),state:'RUNNING'};
  try {await store.writeHead({...head,attempt},etag);}
  catch(error) {if(error.code==='FIXED_STORE_CONFLICT') return {state:'BUSY'};throw error;}
  async function finish(next) {
    const {head:latest,etag}=await readHead(store);
    if (latest.attempt?.id!==attempt.id || latest.attempt.state!=='RUNNING') throw failure('NATIONAL_REGISTRY_SUPERSEDED');
    await store.writeHead({...latest,...next},etag);
  }
  try {
    const observed=await collectStageNationalRegistry(readCenter);
    const official=await readOfficial?.() || [];
    const previous=head.current ? await decode(store,head.current) : official;
    const rows=mergeStageNationalRegistry(previous,observed.rows,official);
    const candidate=await encode(rows,store.key), checkedAt=new Date(now()).toISOString();
    const current={version:candidate.version,count:rows.length,checkedAt};
    const unchanged=head.current?.version===current.version;
    if (!unchanged) {
      try {await store.writeObject(current.version,candidate);}
      catch(error) {if (error.code!=='FIXED_STORE_CONFLICT') throw error;}
      await decode(store,current);
    }
    await finish({current,previous:unchanged?head.previous:head.current,
      attempt:{...attempt,state:'VERIFIED'},lastSuccessAt:checkedAt,lastError:null});
    const committed=(await readHead(store)).head;
    if (committed.current?.version!==current.version || committed.attempt?.id!==receipt.runId ||
        committed.lastSuccessAt!==checkedAt) throw failure('NATIONAL_REGISTRY_STORAGE_READBACK');
    return {state:unchanged?'VERIFIED_NOOP':'PUBLISHED',version:current.version,count:rows.length,checkedAt,counts:observed.counts,
      activeCodes:rows.filter(row=>row.lifecycle==='ACTIVE').map(row=>row.customerCode),
      retiredCodes:rows.filter(row=>row.lifecycle==='DELETED').map(row=>row.customerCode)};
  } catch(error) {
    const lastError=/^(?:NATIONAL_REGISTRY|FIXED_STORE)_[A-Z_]+$/.test(error?.code||'')?error.code:'NATIONAL_REGISTRY_SOURCE_FAILED';
    await finish({attempt:{...attempt,state:'FAILED'},lastError}).catch(()=>{});
    throw failure(lastError);
  }
}
