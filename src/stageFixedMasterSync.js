import {createHash} from 'node:crypto';
import {createFixedVehicleReader} from './fixedVehicleProjection.js';
import {createPrivateGithubJsonStore, fixedEnvelope, validateFixedEnvelope} from './fixedVehicleStore.js';
import {createFixedVehicleFileStore} from './opsmap-abc/fixedVehicleStore.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from './stageScope.js';

const MIS = 'https://mis.freshon.co.kr', fixedPath = '/bo/wm/standard/fixedAlctnList';
const repo = 'mingu0702-droid/freshon-cache', branch = 'stage/opsmap-snapshots';
const prefix = 'fixed-master-daily-v1/', headFile = prefix + 'head.json';
const baselineFile = 'fixed-vehicle-projection-v1.json';
const maxSourcePageBytes = 8 * 1024 * 1024;
const objectFile = ref => prefix + 'projection-' + ref.version + '.json';
const centers = ['011', '012', '013'];
const hash = /^[a-f0-9]{64}$/;
const safeCode = /^(?:FIXED_(?:MASTER|STORE)_[A-Z_]{1,70})$/;
const noRetry = new Set(['FIXED_MASTER_SESSION_UNAVAILABLE','FIXED_MASTER_AUTH_REQUIRED','FIXED_MASTER_FORBIDDEN']);
const nowISO = t => new Date(t).toISOString();
const validTime = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) && nowISO(Date.parse(v)) === v;
const kstDay = t => nowISO(t + 9 * 3600000).slice(0,10);
const day = /^\d{4}-\d{2}-\d{2}$/;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(Error(code), {code});
const failureCode = e => safeCode.test(e?.code || e?.message || '') ? e.code || e.message : 'FIXED_MASTER_DAILY_FAILED';
const validRef = ref => ref && hash.test(ref.version) && hash.test(ref.rowsHash) && hash.test(ref.ledgerSha256) &&
  validTime(ref.checkedAt) && Number.isSafeInteger(ref.count) && ref.count > 0 && ref.count <= 10_000;
const minute = 60_000;
const customerCode = /^[A-Z]\d{1,20}$/;

export const FIXED_MASTER_DAILY_TTL = 26 * 3600000;
export const FIXED_MASTER_WORKER_LIMIT = 45 * minute;
export const FIXED_MASTER_SCOPE_INPUT_LIMIT = 256 * 1024;
export const stageFixedMasterSyncEnabled = env => env.RENDER_SERVICE_ID === STAGE_SERVICE &&
  env.RENDER_EXTERNAL_URL === STAGE_ORIGIN && env.OPSMAP_STAGE_FIXED_MASTER_SYNC_APPROVED === '1';

function validateFixedMasterScope(scope) {
  const {generation, ledgerSha256, codes} = scope || {};
  if (!hash.test(generation || '') || !hash.test(ledgerSha256 || '') || !Array.isArray(codes) ||
      !codes.length || codes.length > 10_000 || codes.some(code => typeof code !== 'string' || !customerCode.test(code)) ||
      new Set(codes).size !== codes.length) throw fail('FIXED_MASTER_DAILY_SCOPE');
  return {generation, ledgerSha256, codes};
}

export function stageFixedMasterScope(active) {
  if (active?.expiresAt !== Infinity || !(active.registry instanceof Map) ||
      active.registry.size !== active.counts?.registered) return null;
  return validateFixedMasterScope({generation:active.generation, ledgerSha256:active.ledger?.sha256,
    codes:[...active.registry.keys()]});
}

export function stageFixedMasterStorage({env=process.env, fetchImpl=fetch, write=false}={}) {
  if (!stageFixedMasterSyncEnabled(env) || env.OPSMAP_STAGE_SYNC_REMOTE_APPROVED !== '1' ||
      write && env.OPSMAP_STAGE_SYNC_PUBLISH_APPROVED !== '1') throw fail('FIXED_STORE_STAGE_APPROVAL');
  const token = write ? env.OPSMAP_STAGE_SYNC_WRITE_TOKEN ||
    (env.OPSMAP_STAGE_SYNC_USE_SNAPSHOT_WRITER === '1' && env.OPSMAP_SNAPSHOT_STORE_TOKEN)
    : env.OPSMAP_STAGE_SYNC_READ_TOKEN || env.OPSMAP_SNAPSHOT_STORE_TOKEN || env.OPSMAP_SHADOW_GITHUB_READ_TOKEN;
  if (!token) throw fail('FIXED_STORE_STAGE_CREDENTIALS');
  const root = 'https://api.github.com/repos/' + repo, contents = root + '/contents/opsmap-stage/';
  function scopedFetch(input, options={}) {
    const url=new URL(input), endpoint=url.origin+url.pathname, method=options.method || 'GET';
    const file=endpoint.startsWith(contents) ? endpoint.slice(contents.length) : '';
    const dailyFile = file===headFile || /^fixed-master-daily-v1\/projection-[a-f0-9]{64}\.json$/.test(file);
    const read = method==='GET' && ((dailyFile || file===baselineFile) && url.searchParams.size===1 &&
      url.searchParams.get('ref')===branch || !url.search && (endpoint===root ||
      endpoint.startsWith(root+'/git/blobs/') && /^[a-f0-9]{40}$/.test(endpoint.split('/').at(-1))));
    const put = method==='PUT' && write && dailyFile && !url.search && JSON.parse(options.body).branch===branch;
    if ((!read && !put) || url.username || url.password || url.hash) throw fail('FIXED_STORE_STAGE_SCOPE');
    return fetchImpl(input,{...options,redirect:'error'});
  }
  const api=createPrivateGithubJsonStore({env:{GITHUB_CACHE_REPO:repo,GITHUB_CACHE_BRANCH:branch,
    GITHUB_CACHE_DIR:'opsmap-stage',GITHUB_TOKEN:token},fetchImpl:scopedFetch});
  return {read:api.read,...(write?{write:api.write}:{}),
    async loadBaseline(){return (await api.read(baselineFile)).value;}};
}

async function readHead(store) {
  const {value,sha}=await store.read(headFile);
  if (!value && !sha) return {head:{schema:1, current:null, previous:null, attempt:null, lastSuccess:null, lastFailure:null},sha:null};
  const a=value?.attempt,s=value?.lastSuccess,f=value?.lastFailure;
  if (!/^[a-f0-9]{40}$/.test(sha || '') || value?.schema!==1 ||
      value.current!==null&&!validRef(value.current) || value.previous!==null&&(!validRef(value.previous)||!value.current) ||
      a!==null&&(!hash.test(a?.runId || '')||!day.test(a.date)||![1,2].includes(a.count)||!validTime(a.startedAt)||
        !['RUNNING','VERIFIED','FAILED'].includes(a.state)) ||
      value.current!==null && (a===null || s===null) ||
      s!==null&&(!value.current||!validTime(s?.at)||!day.test(s.date)||s.version!==value.current.version||!hash.test(s.runId)) ||
      f!==null&&(!validTime(f?.at)||!safeCode.test(f.code)||!hash.test(f.runId))) throw fail('FIXED_STORE_DAILY_HEAD');
  return {head:value,sha};
}

async function verifiedObject(store, ref) {
  const {value}=await store.read(objectFile(ref));
  const envelope=validateFixedEnvelope(value,{materialize:false}).envelope;
  if (envelope.version!==ref.version || envelope.checkedAt!==ref.checkedAt || envelope.count!==ref.count ||
      digest(envelope.rows)!==ref.rowsHash) throw fail('FIXED_STORE_DAILY_OBJECT');
  return envelope;
}

function verifyProjection(result, scope, baseline, observedAt) {
  const {data,meta}=result || {};
  if (!Array.isArray(data) || meta?.readHttp!==200 ||
      meta.centers?.length!==centers.length || !Number.isSafeInteger(meta.sourceRows) ||
      meta.centers.some((item,i)=>item.center!==centers[i] || !Number.isSafeInteger(item.declaredRows) ||
        item.declaredRows<1 || item.declaredRows!==item.sourceRows || item.pages!==Math.ceil(item.sourceRows/1000)) ||
      meta.centers.reduce((n,c)=>n+c.sourceRows,0)!==meta.sourceRows ||
      !Number.isSafeInteger(meta.uniqueCustomers) || meta.uniqueCustomers>meta.sourceRows ||
      (meta.projectedCustomers ?? meta.uniqueCustomers)!==data.length || meta.uniqueCustomers<data.length ||
      new Set(data.map(row=>row.customerCode)).size!==data.length) {
    throw fail('FIXED_MASTER_DAILY_INCOMPLETE');
  }
  const rows=data.filter(row=>scope.has(row.customerCode)), byCode=new Map(rows.map(row=>[row.customerCode,row]));
  if (rows.some(row=>row.baseVehicleState==='CONFLICT') || baseline?.rows.some(row=>{
    if (!scope.has(row[0]) || row[3]!=='VERIFIED_MASTER') return false;
    const incoming=byCode.get(row[0]);
    return !incoming || incoming.baseVehicleState!=='VERIFIED_MASTER'&&incoming.baseVehicleEmptyVerified!==true;
  })) throw fail('FIXED_MASTER_DAILY_ASSIGNMENT_GAP');
  const coverage={ledgerCount:scope.size, matchedCount:rows.length, missingCount:scope.size-rows.length, sourceRows:meta.sourceRows,
    centers:meta.centers.map(({center,sourceRows,pages,duplicateCustomerRows})=>({center,sourceRows,pages,
      duplicateCustomerRows:Number.isSafeInteger(duplicateCustomerRows)?duplicateCustomerRows:null}))};
  return {envelope:fixedEnvelope(rows,observedAt),coverage};
}

// Only the existing signed Stage scheduler calls this. The reservation and
// verified pointer share a CAS; a late process cannot publish over a new run.
export async function syncStageFixedMaster({store, receipt, scope: input, readMaster, loadBaseline, now=Date.now}) {
  if (!hash.test(receipt?.runId || '') || receipt.date!==kstDay(now())) throw fail('FIXED_MASTER_DAILY_RECEIPT');
  const scope=validateFixedMasterScope(input), codes=new Set(scope.codes);
  const {head,sha}=await readHead(store);
  const old=head.attempt, sameDay=old?.date===receipt.date, runId=receipt.runId;
  const today=head.lastSuccess?.date===receipt.date ||
    validTime(head.lastSuccess?.at)&&kstDay(Date.parse(head.lastSuccess.at))===receipt.date;
  if (today) return {state:'ALREADY_VERIFIED',runId};
  if (old?.state==='RUNNING' && now()-Date.parse(old.startedAt)<FIXED_MASTER_WORKER_LIMIT+5*minute) return {state:'BUSY',runId};
  if (old?.runId===runId || sameDay && (old.count>=2 || old.state==='FAILED'&&noRetry.has(head.lastFailure?.code))) {
    return {state:'RETRY_HELD',runId};
  }
  const attempt={runId,date:receipt.date,count:sameDay?old.count+1:1,startedAt:nowISO(now()),state:'RUNNING'};
  try {await store.write(headFile,{...head,attempt},sha);}
  catch (e) {if (e.code==='FIXED_STORE_CONFLICT') return {state:'BUSY',runId};throw e;}
  async function finish(fields) {
    const current=await readHead(store);
    if (current.head.attempt?.runId!==runId || current.head.attempt.state!=='RUNNING') throw fail('FIXED_STORE_DAILY_SUPERSEDED');
    await store.write(headFile,{...current.head,...fields},current.sha);
  }
  try {
    const saved=head.current ? await verifiedObject(store,head.current) : null;
    const fallback=loadBaseline ? await Promise.resolve().then(loadBaseline).catch(error=>{if(!saved)throw error;return null;}) : null;
    const approved=fallback ? validateFixedEnvelope(fallback,{materialize:false}).envelope : null;
    const baseline=approved && (!saved || approved.checkedAt>saved.checkedAt) ? approved : saved;
    let result;
    try {
      result=await readMaster(codes);
    } catch (error) {
      if (error.name==='TimeoutError') throw fail('FIXED_MASTER_DAILY_TIMEOUT');
      throw error;
    }
    const sourceObservedAt=nowISO(now());
    const {envelope,coverage}=verifyProjection(result,codes,baseline,sourceObservedAt);
    if (baseline && Date.parse(envelope.checkedAt)<=Date.parse(baseline.checkedAt)) throw fail('FIXED_STORE_DAILY_SUPERSEDED');
    const rowsHash=digest(envelope.rows);
    const unchanged=head.current?.rowsHash===rowsHash;
    const current=unchanged ? {...head.current,ledgerSha256:scope.ledgerSha256} : {version:envelope.version,
      checkedAt:envelope.checkedAt,rowsHash,ledgerSha256:scope.ledgerSha256,count:envelope.count};
    if (!unchanged) {
      const file=objectFile(current), present=await store.read(file);
      if (!present.value) {
        try {await store.write(file,envelope,null);}
        catch (e) {if (e.code!=='FIXED_STORE_CONFLICT') throw e;}
      }
      await verifiedObject(store,current);
    }
    const at=nowISO(now());
    await finish({current,previous:unchanged?head.previous:head.current,attempt:{...attempt,state:'VERIFIED'},
      lastSuccess:{runId,date:receipt.date,at,version:current.version,
        coverage:{...coverage,sourceObservedAt,registryGeneration:scope.generation}}});
    return {state:unchanged?'VERIFIED_NOOP':'PUBLISHED',runId,version:current.version,checkedAt:at,...coverage};
  } catch (error) {
    const code=failureCode(error);
    await finish({attempt:{...attempt,state:'FAILED'},lastFailure:{runId,at:nowISO(now()),code}}).catch(()=>{});
    throw fail(code);
  }
}

export function createStageDailyFixedMasterReader({store, baseline}) {
  let cached=null, baselineValue, info=null;
  async function loadBaseline() {
    if (baselineValue===undefined) {
      const value=await baseline.load();
      baselineValue=value ? validateFixedEnvelope(value,{materialize:false}).envelope : null;
    }
    return baselineValue;
  }
  return {
    status:()=>info,
    async load() {
      let head;
      try {
        ({head}=await readHead(store));
        if (head.current) {
          const initial=await loadBaseline().catch(()=>null);
          if (initial && initial.checkedAt>(head.lastSuccess.coverage?.sourceObservedAt||head.lastSuccess.at)) {
            info={state:'APPROVED_BASELINE',lastError:head.attempt.state==='FAILED'?head.lastFailure?.code||null:null,
              lastFailureAt:head.lastFailure?.at||null};
            return initial;
          }
          if (cached?.version!==head.current.version) cached=await verifiedObject(store,head.current);
          const success=head.lastSuccess;
          info={state:head.attempt.state,version:cached.version,lastSuccessAt:success.at,runId:success.runId,
            sourceObservedAt:validTime(success.coverage?.sourceObservedAt)?success.coverage.sourceObservedAt:null,
            registryGeneration:hash.test(success.coverage?.registryGeneration || '')?success.coverage.registryGeneration:null,
            lastFailureAt:head.lastFailure?.at || null,lastError:head.attempt.state==='FAILED'?head.lastFailure?.code || null:null};
          return cached;
        }
        info={state:head.attempt?.state||'NOT_PUBLISHED',lastError:head.lastFailure?.code||null,
          lastFailureAt:head.lastFailure?.at||null};
      } catch (e) {
        info={state:'READ_FAILED',lastError:failureCode(e)};
        if (cached) return cached;
        if (head?.previous) {
          cached=await verifiedObject(store,head.previous).catch(()=>null);
          if (cached) return cached;
        }
      }
      return loadBaseline();
    }
  };
}

export function createStageFixedMasterSource({env=process.env, fetchImpl=fetch, login}={}) {
  if (!stageFixedMasterSyncEnabled(env) || env.FRESHON_BASE_URL && new URL(env.FRESHON_BASE_URL).origin!==MIS) {
    throw fail('FIXED_MASTER_STAGE_SOURCE_SCOPE');
  }
  // The verified three-center read took 33 minutes at the existing sequential page rate.
  const limit=AbortSignal.timeout(FIXED_MASTER_WORKER_LIMIT-5*minute);
  let cookie=env.FRESHON_COOKIE || '', attemptedLogin=false, calls=0;
  const reader=createFixedVehicleReader({
    verifyLastPage:true,
    async ensureSession(force) {
      limit.throwIfAborted();
      if (!force && cookie) return;
      if (attemptedLogin || !env.FRESHON_ID || !env.FRESHON_PASSWORD) throw fail('FIXED_MASTER_AUTH_REQUIRED');
      attemptedLogin=true;
      const approvedLogin=login || (async ()=>{
        const {config}=await import('./config.js');
        if (new URL(config.freshonBaseUrl).origin!==MIS) throw fail('FIXED_MASTER_STAGE_SOURCE_SCOPE');
        return (await import('./scraper/freshonDailyRoute.js')).loginFreshonSession();
      });
      const result=await approvedLogin();
      if (!result.cookie || result.cookie===cookie) throw fail('FIXED_MASTER_AUTH_REQUIRED');
      cookie=result.cookie;
    },
    async readJson(pathname,options) {
      if (pathname!==fixedPath || options.method!=='POST' || ++calls>120) throw fail('FIXED_MASTER_STAGE_SOURCE_SCOPE');
      const pageDeadline=AbortSignal.timeout(options.timeoutMs);
      let response;
      try {
        response=await fetchImpl(MIS+fixedPath,{method:'POST',redirect:'manual',body:options.body,
          signal:AbortSignal.any([limit,pageDeadline]),
          headers:{...options.headers,Accept:'application/json, text/plain, */*','X-Requested-With':'XMLHttpRequest',
            Origin:MIS,Referer:MIS+'/bo/main',Cookie:cookie}});
      } catch(error) {
        if(pageDeadline.aborted && !limit.aborted) throw Object.assign(Error('Freshon request timed out after 60s (fixed master)'),{status:504});
        throw error;
      }
      const reject=status=>{throw Object.assign(fail('FIXED_MASTER_READ_FAILED'),{status,diagnostic:{type:'http-error',status}});};
      if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
        await response.body?.cancel().catch(()=>{});
        reject(response.status>=300 && response.status<400 || response.ok ? 401 : response.status);
      }
      if (Number(response.headers.get('content-length'))>maxSourcePageBytes || !response.body) {
        await response.body?.cancel().catch(()=>{});
        throw fail('FIXED_MASTER_DAILY_PAGE_LIMIT');
      }
      const chunks=[];
      let bytes=0;
      for await (const chunk of response.body) {
        bytes+=chunk.length;
        if(bytes>maxSourcePageBytes) throw fail('FIXED_MASTER_DAILY_PAGE_LIMIT');
        chunks.push(chunk);
      }
      let json;
      try {json=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));}
      catch {throw fail('FIXED_MASTER_DAILY_RESPONSE_INVALID');}
      if (!Array.isArray(json?.data)) reject(502);
      return json;
    },
    extractRows:value=>value?.data
  });
  return codes => reader({signal:limit,customerCodes:codes});
}

export function stageFixedMasterBaseline({env,store}) {
  return env.OPSMAP_STAGE_FIXED_MASTER_FILE ?
    createFixedVehicleFileStore({env:{...env,OPSMAP_STAGE_VERIFY_ONLY:'1'}}) :
    {load:()=>store.loadBaseline()};
}
