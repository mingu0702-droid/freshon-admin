import {createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes} from 'node:crypto';
import {promisify} from 'node:util';
import {gzip, gunzip} from 'node:zlib';
import {createPrivateGithubJsonStore} from './fixedVehicleStore.js';
import {datesFor, isDay} from './shadowCoverage/coverageFiles.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from './stageScope.js';

export const RECENT_OPERATIONS_ROUTE = '/api/map-phase2b/private/recent-operations';
export const RECENT_OPERATIONS_BASELINE_END = '2026-11-17';
export const recentOperationsCenters = ['osan','yeongnam','honam'];
const reportPeriods = new Set(['7','30','60','90']);
const evidenceOrder = ['order_confirmed','dispatch_confirmed','delivery_completed'];
const sourceEvidence = {
  freshon_orders:['order_confirmed'], wms_dispatch:['dispatch_confirmed'],
  delivery_admin:['delivery_completed','dispatch_confirmed']
};
const binding = Buffer.from('opsmap-stage/recent-operations-v1');
const repository = 'mingu0702-droid/freshon-cache', branch = 'stage/opsmap-snapshots';
const prefix = 'recent-operations-v1/', currentFile = prefix+'current.json';
const seedFile = prefix+'baseline.json';
const codeRevision = /^[a-f0-9]{40}$/;
const maxClearBytes = 32 * 1024 * 1024, maxPackedBytes = 4 * 1024 * 1024;
const maxRetryDates = 7;
const compress = promisify(gzip), decompress = promisify(gunzip);
const customerCode = /^[A-Z]\d{1,20}$/;
const hash = /^[a-f0-9]{64}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const stageScope = env => env.RENDER_SERVICE_ID === STAGE_SERVICE && env.RENDER_EXTERNAL_URL === STAGE_ORIGIN;
const latestClosedDay = at => new Date(at + 9 * 3600000 - 86400000).toISOString().slice(0,10);
const dayKey = ({date,centerKey,source}) => [date,centerKey,source].join(':');
const rejected = () => Error('RECENT_OPERATIONS_EVIDENCE_INVALID');

export const stageRecentOperationsSyncEnabled = env => stageScope(env) &&
  env.OPSMAP_STAGE_RECENT_OPERATIONS_SYNC_APPROVED === '1';

export function normalizeRecentOperations({startDate,endDate,days} = {}) {
  if (!isDay(endDate) || endDate < RECENT_OPERATIONS_BASELINE_END ||
      startDate !== datesFor(endDate,90)[0] || !Array.isArray(days) || days.length > 810) throw rejected();
  const keys = new Set(), normalized = [];
  let rowCount = 0;
  for (const {date,centerKey,source,coverage,rows} of days) {
    const allowedEvidence = sourceEvidence[source];
    const key = dayKey({date,centerKey,source});
    if (!isDay(date) || date < startDate || date > endDate || !recentOperationsCenters.includes(centerKey) ||
        !Object.hasOwn(sourceEvidence,source) || !['partial','complete'].includes(coverage) ||
        source === 'delivery_admin' && coverage === 'complete' || keys.has(key) ||
        !Array.isArray(rows) || rows.length > 30000 || (rowCount += rows.length) > 850000) throw rejected();
    keys.add(key);
    const codes = new Map();
    for (const row of rows) {
      if (typeof row?.customerCode !== 'string' || !customerCode.test(row.customerCode) ||
          !allowedEvidence.includes(row.evidence) || codes.has(row.customerCode)) throw rejected();
      codes.set(row.customerCode,row.evidence);
    }
    normalized.push({date,centerKey,source,coverage,rows:[...codes].sort(([a],[b])=>a.localeCompare(b)).map(
      ([customerCode,evidence])=>({customerCode,evidence}))});
  }
  return {startDate,endDate,days:normalized.sort((a,b)=>dayKey(a).localeCompare(dayKey(b)))};
}

export function projectRecentOperations(ledger,{days,endDate=ledger.endDate,summaryOnly=false}={}) {
  if (days!==undefined && !reportPeriods.has(String(days))) throw rejected();
  const calendar=days===undefined?null:datesFor(endDate,90).slice(-days);
  const startDate=calendar?.[0]??ledger.startDate;
  const centers = Object.fromEntries(recentOperationsCenters.map(center=>[center,{
    confirmedDays:[],observedDates:new Set(),activeCount:0,
    sourceObservedDates:Object.fromEntries(Object.keys(sourceEvidence).map(key=>[key,new Set()])),
    completeOrders:new Set(),completeDispatch:new Set(),
    ...(calendar?{evidenceByDate:new Map()}:{})
  }]));
  const active = new Map();
  for (const {date,centerKey,source,coverage,rows} of ledger.days) {
    if (date<startDate || date>endDate) continue;
    const center=centers[centerKey];
    if (calendar) {
      if (!center.evidenceByDate.has(date)) center.evidenceByDate.set(date,{});
      const kinds=new Set(rows.map(row=>row.evidence));
      center.evidenceByDate.get(date)[source]={coverage,customerCount:rows.length,
        evidence:evidenceOrder.filter(kind=>kinds.has(kind))};
    }
    center.observedDates.add(date);
    center.sourceObservedDates[source].add(date);
    if (coverage==='complete') {
      (source==='freshon_orders'?center.completeOrders:center.completeDispatch).add(date);
    }
    for (const {customerCode,evidence} of rows) {
      const key=centerKey+':'+customerCode;
      const previous=active.get(key);
      if (!previous || previous.date<date || previous.date===date &&
          evidenceOrder.indexOf(evidence)>evidenceOrder.indexOf(previous.evidence)) active.set(key,{customerCode,centerKey,date,evidence});
    }
  }
  for (const {centerKey} of active.values()) centers[centerKey].activeCount++;
  for (const [key,{completeOrders,completeDispatch,observedDates,sourceObservedDates,activeCount,evidenceByDate}] of Object.entries(centers)) {
    centers[key]={activeCount,observedDates:[...observedDates].sort(),
      confirmedDays:[...completeOrders].filter(day=>completeDispatch.has(day)).sort(),
      sourceObservedDates:Object.fromEntries(Object.entries(sourceObservedDates).map(([source,days])=>[source,[...days].sort()]))};
    if (calendar) centers[key].calendar=calendar.map(date=>({
      date,state:completeOrders.has(date)&&completeDispatch.has(date)?'COMPLETE':
        observedDates.has(date)?'PARTIAL':date>ledger.endDate?'NOT_PUBLISHED':'NOT_OBSERVED',
      sources:evidenceByDate.get(date)??{}
    }));
  }
  return {ok:true,startDate,endDate,centers,...(calendar?{days:Number(days),publishedThrough:ledger.endDate}:{}),
    ...(!summaryOnly?{rows:[...active.values()]}:{})};
}

export function mergeRecentOperations(previous, endDate, days) {
  if (endDate < previous.endDate) throw rejected();
  const startDate=datesFor(endDate,90)[0];
  const scoped=normalizeRecentOperations({startDate,endDate,days});
  const retained=new Map(previous.days.filter(day=>day.date>=startDate).map(day=>[dayKey(day),day]));
  for (const day of scoped.days) {
    const key=dayKey(day), existing=retained.get(key);
    if (!existing || day.coverage==='complete') {
      retained.set(key,day);
    } else if (existing.coverage==='partial') {
      const rows=new Map(existing.rows.map(row=>[row.customerCode,row]));
      for (const row of day.rows) {
        if (evidenceOrder.indexOf(row.evidence)>evidenceOrder.indexOf(rows.get(row.customerCode)?.evidence)) rows.set(row.customerCode,row);
      }
      retained.set(key,{...day,rows:[...rows.values()]});
    }
  }
  return normalizeRecentOperations({...scoped,days:[...retained.values()]});
}

export function recentOperationsKey(encoded) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded || '')) throw Error('RECENT_OPERATIONS_KEY');
  return Buffer.from(hkdfSync('sha256',Buffer.from(encoded,'base64'),binding,Buffer.from('asset-encryption'),32));
}

export async function sealRecentOperations(ledger,key) {
  const bytes=Buffer.from(JSON.stringify(normalizeRecentOperations(ledger)));
  if (bytes.length>maxClearBytes) throw rejected();
  const nonce=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(binding);
  const packed=Buffer.concat([nonce,cipher.update(await compress(bytes)),cipher.final(),cipher.getAuthTag()]).toString('base64');
  if (packed.length>maxPackedBytes) throw rejected();
  return {version:sha256(bytes),packed};
}

export async function openRecentOperations(value,key) {
  if (!hash.test(value?.version || '') || typeof value.packed!=='string' ||
      value.packed.length>maxPackedBytes) throw rejected();
  const data=Buffer.from(value.packed,'base64');
  if (data.length<29) throw rejected();
  const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));
  decipher.setAAD(binding);
  decipher.setAuthTag(data.subarray(-16));
  const bytes=await decompress(Buffer.concat([decipher.update(data.subarray(12,-16)),decipher.final()]),{maxOutputLength:maxClearBytes});
  if (sha256(bytes)!==value.version) throw rejected();
  return normalizeRecentOperations(JSON.parse(bytes));
}

export function createStageRecentOperationsSeed({env=process.env,fetchImpl=fetch,manifest,log=()=>{}}={}) {
  if (!stageScope(env) || !manifest) return null;
  const token=env.OPSMAP_SNAPSHOT_STORE_TOKEN || env.GITHUB_TOKEN || env.OPSMAP_SHADOW_GITHUB_READ_TOKEN;
  if (!token || !codeRevision.test(manifest.ref || '') || !hash.test(manifest.sha256 || '') ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes<=0 || manifest.bytes>maxPackedBytes+1024) {
    log({state:'CONFIGURATION_UNAVAILABLE'});
    return null;
  }
  const root='https://api.github.com/repos/'+repository;
  const url=root+'/contents/opsmap-stage/'+seedFile+'?ref='+manifest.ref;
  let repositoryVerified=false;
  return async()=>{
    let state='REPOSITORY_UNAVAILABLE',http;
    try {
      const signal=AbortSignal.timeout(20000);
      const request=(address,accept)=>fetchImpl(address,{method:'GET',redirect:'error',signal,
        headers:{Authorization:'Bearer '+token,Accept:accept,'Accept-Encoding':'identity'}});
      if (!repositoryVerified) {
        const info=await request(root,'application/vnd.github+json');
        http=info.status;
        if (!info.ok) {await info.body?.cancel();throw rejected();}
        if ((await info.json()).private!==true) throw rejected();
        repositoryVerified=true;
      }
      state='DOWNLOAD_UNAVAILABLE';
      const response=await request(url,'application/vnd.github.raw+json');
      http=response.status;
      if (!response.ok || !response.body) {await response.body?.cancel();throw rejected();}
      state='INTEGRITY_REJECTED';
      if (Number(response.headers.get('content-length'))>manifest.bytes) {await response.body.cancel();throw rejected();}
      const chunks=[];
      let size=0;
      for await (const chunk of response.body) {
        size+=chunk.length;
        if (size>manifest.bytes) throw rejected();
        chunks.push(chunk);
      }
      const bytes=Buffer.concat(chunks);
      if (size!==manifest.bytes || sha256(bytes)!==manifest.sha256) throw rejected();
      state='EVIDENCE_REJECTED';
      const ledger=await openRecentOperations(JSON.parse(bytes),recentOperationsKey(env.OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64));
      log({state:'VERIFIED',endDate:ledger.endDate});
      return ledger;
    } catch {
      log({state,http});
      throw Error('RECENT_OPERATIONS_BASELINE_UNAVAILABLE');
    }
  };
}

export function createStageRecentOperationsStore({env=process.env,fetchImpl=fetch,now=Date.now,write=false,withSha=false}={}) {
  if (!stageRecentOperationsSyncEnabled(env) || env.OPSMAP_STAGE_SYNC_REMOTE_APPROVED!=='1' ||
      write && env.OPSMAP_STAGE_SYNC_PUBLISH_APPROVED!=='1') return null;
  const token=write ? env.OPSMAP_STAGE_SYNC_WRITE_TOKEN ||
    (env.OPSMAP_STAGE_SYNC_USE_SNAPSHOT_WRITER==='1'&&env.OPSMAP_SNAPSHOT_STORE_TOKEN) :
    env.OPSMAP_STAGE_SYNC_READ_TOKEN || env.OPSMAP_SNAPSHOT_STORE_TOKEN || env.OPSMAP_SHADOW_GITHUB_READ_TOKEN;
  if (!token) return null;
  let key;
  try {key=recentOperationsKey(env.OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64);}
  catch {return null;}
  const root='https://api.github.com/repos/'+repository, contents=root+'/contents/opsmap-stage/';
  const client=createPrivateGithubJsonStore({now,
    env:{GITHUB_CACHE_REPO:repository,GITHUB_CACHE_BRANCH:branch,GITHUB_CACHE_DIR:'opsmap-stage',GITHUB_TOKEN:token},
    fetchImpl(input,options={}) {
      const url=new URL(input), address=url.origin+url.pathname, method=options.method || 'GET';
      const file=address.startsWith(contents)?address.slice(contents.length):'';
      const daily=file.startsWith(prefix+'day-') && /^day-\d{4}-\d{2}-\d{2}\.json$/.test(file.slice(prefix.length));
      const blob=address.startsWith(root+'/git/blobs/') && codeRevision.test(address.slice((root+'/git/blobs/').length));
      const read=method==='GET' && ((file===currentFile || write&&daily) && url.searchParams.size===1 && url.searchParams.get('ref')===branch ||
        !url.search && (address===root || (write||withSha)&&blob));
      const update=write && method==='PUT' && (file===currentFile || daily) && !url.search &&
        JSON.parse(options.body).branch===branch;
      if ((!read && !update) || url.username || url.password || url.hash) throw Error('RECENT_OPERATIONS_STORAGE_SCOPE');
      return fetchImpl(input,{...options,redirect:'error'});
    }});
  return {
    async read() {
      if (!write && !withSha) {
        const value=await client.readRaw(currentFile,maxPackedBytes+1024);
        return value&&{ledger:await openRecentOperations(value,key)};
      }
      const {value,sha}=await client.read(currentFile);
      return {sha,ledger:value?await openRecentOperations(value,key):null};
    },
    ...(write?{
      async readDay(date) {
        const value=await client.readRaw(prefix+'day-'+date+'.json',maxPackedBytes+1024);
        if (!value) return null;
        const ledger=await openRecentOperations(value,key);
        const envelopeEnd=date<RECENT_OPERATIONS_BASELINE_END?RECENT_OPERATIONS_BASELINE_END:date;
        if (ledger.endDate!==envelopeEnd || ledger.days.some(day=>day.date!==date)) throw rejected();
        return ledger.days;
      },
      async writeDay(date, days) {
        if (!isDay(date) || days.some(day=>day.date!==date)) throw rejected();
        const endDate=date<RECENT_OPERATIONS_BASELINE_END?RECENT_OPERATIONS_BASELINE_END:date;
        const value=await sealRecentOperations({startDate:datesFor(endDate,90)[0],endDate,days},key);
        return client.write(prefix+'day-'+date+'.json',value,null);
      },
      async write(ledger,sha) {await client.write(currentFile,await sealRecentOperations(ledger,key),sha);}
    }:{})
  };
}

export async function syncStageRecentOperations({store,receipt,readSeed,readSource,readLatestDay,retryDates=[],repairDate,now=Date.now}={}) {
  const day=latestClosedDay(now());
  const kstDate=new Date(now()+9*3600000).toISOString().slice(0,10);
  if (!store?.write || !hash.test(receipt?.runId || '') || receipt.date!==kstDate) throw Error('RECENT_OPERATIONS_RECEIPT');
  if (day<RECENT_OPERATIONS_BASELINE_END) throw rejected();
  const current=await store.read();
  const base=current.ledger ?? await readSeed?.();
  if (!base) throw Error('RECENT_OPERATIONS_BASELINE_UNAVAILABLE');
  if (base.endDate>day) throw rejected();
  if (!Array.isArray(retryDates) || retryDates.length>maxRetryDates ||
      retryDates.some(date=>!isDay(date) || date>day)) throw rejected();
  const windowStart=datesFor(day,90)[0];
  if (repairDate!==undefined && (!isDay(repairDate) || repairDate<windowStart || repairDate>day)) throw rejected();
  const dates=new Set([day,...(repairDate?[repairDate]:[]),...retryDates.filter(date=>date>=windowStart)]);
  const days=[];
  let endDate=base.endDate;
  let retriedMissingDay=false;
  for (const date of dates) {
    const savedInput=await (readSource?.(date) ?? store.readDay(date));
    if (savedInput!=null && (!Array.isArray(savedInput) || savedInput.some(row=>row?.date!==date))) throw rejected();
    const previous=base.days.filter(item=>item.date===date);
    const completeRows=new Map(previous.filter(item=>item.coverage==='complete').map(item=>[dayKey(item),item]));
    let input=(savedInput??[]).map(item=>completeRows.get(dayKey(item))??item);
    const latestUnpublished=date===day && date>base.endDate;
    // Retry one explicitly selected historical gap per run. The latest day
    // takes priority, and existing sealed files and published dates are retained.
    const missingPastDay=date<day && !retriedMissingDay && savedInput==null && previous.length===0;
    if (readLatestDay && (latestUnpublished || date===repairDate || missingPastDay && repairDate===undefined)) {
      if (date<day) retriedMissingDay=true;
      const observed=[...previous,...input];
      const deliveryCenters=new Set(observed.filter(row=>row.source==='delivery_admin').map(row=>row.centerKey));
      const orderCenters=new Set(observed.filter(row=>row.source==='freshon_orders').map(row=>row.centerKey));
      if (deliveryCenters.size<recentOperationsCenters.length || orderCenters.size<recentOperationsCenters.length) {
        const additions=await readLatestDay(date,deliveryCenters,orderCenters);
        if (!Array.isArray(additions) || additions.some(row=>!row || row.date!==date ||
          row.source==='delivery_admin'&&deliveryCenters.has(row.centerKey) ||
          row.source==='freshon_orders'&&orderCenters.has(row.centerKey) ||
          row.source!=='delivery_admin'&&row.source!=='freshon_orders')) throw rejected();
        input.push(...additions);
      }
      if (input.length && savedInput==null && previous.length===0 && store.writeDay) {
        let created=true;
        try {await store.writeDay(date,input);}
        catch(error) {if(error.code!=='FIXED_STORE_CONFLICT')throw error;created=false;}
        const persisted=await store.readDay(date);
        const envelopeEnd=date<RECENT_OPERATIONS_BASELINE_END?RECENT_OPERATIONS_BASELINE_END:date;
        const expected=normalizeRecentOperations({startDate:datesFor(envelopeEnd,90)[0],endDate:envelopeEnd,days:input}).days;
        if (!persisted || created && JSON.stringify(persisted)!==JSON.stringify(expected))
          throw Error('RECENT_OPERATIONS_STORAGE_READBACK');
        input=persisted;
      }
    }
    if (!Array.isArray(input) || input.some(row=>row?.date!==date)) throw rejected();
    if (!input.length) continue;
    days.push(...input);
    if (date>endDate) endDate=date;
  }
  if (!days.length) return {state:'SOURCE_UNAVAILABLE',endDate:base.endDate};
  const next=mergeRecentOperations(base,endDate,days);
  if (current.ledger && JSON.stringify(next)===JSON.stringify(base)) return {state:'VERIFIED_NOOP',endDate:base.endDate};
  try {await store.write(next,current.sha);}
  catch(error) {if(error.code==='FIXED_STORE_CONFLICT')return {state:'BUSY',endDate:base.endDate};throw error;}
  const saved=await store.read();
  if (JSON.stringify(saved.ledger)!==JSON.stringify(next)) throw Error('RECENT_OPERATIONS_STORAGE_READBACK');
  return {state:'PUBLISHED',endDate};
}

export async function recoverArchivedOsanDispatch({
  store,readArchive,date,approvedDate,publish=false,now=Date.now
}={}) {
  const closedDay=latestClosedDay(now());
  if (!isDay(date) || date!==approvedDate || date>closedDay ||
      date<datesFor(closedDay,90)[0] || !store?.read || !readArchive || publish&&!store.write) {
    throw Error('RECENT_OPERATIONS_RECOVERY_SCOPE');
  }
  const {ledger:base,sha}=await store.read()??{};
  if (!base || base.endDate>closedDay || date<base.startDate || !codeRevision.test(sha??'')) {
    throw Error('RECENT_OPERATIONS_BASELINE_UNAVAILABLE');
  }
  const archive=await readArchive(date);
  if (archive?.date!==date || archive.center!=='osan' || archive.source!=='WMS_CONFIRMED_DISPATCH_EXPORT' ||
      !Array.isArray(archive.vehicles)) throw rejected();
  const customers=new Set();
  let assignmentCount=0;
  for (const {vehicle,details} of archive.vehicles) {
    if (vehicle==='미배정') continue;
    if (typeof vehicle!=='string' || !/^[0-9가-힣 -]{1,24}$/.test(vehicle) || !Array.isArray(details)) throw rejected();
    for (const {customerCode:code} of details) {
      if (!customerCode.test(code)) throw rejected();
      assignmentCount++;
      customers.add(code);
    }
  }
  if (!customers.size) throw rejected();
  const endDate=date>base.endDate?date:base.endDate;
  const evidence={date,centerKey:'osan',source:'wms_dispatch',coverage:'partial',
    rows:[...customers].map(customerCode=>({customerCode,evidence:'dispatch_confirmed'}))};
  const next=mergeRecentOperations(base,endDate,[evidence]);
  const report={date,centerKey:'osan',source:'wms_dispatch',assignmentCount,customerCount:customers.size,endDate};
  if (JSON.stringify(next)===JSON.stringify(base)) return {state:'VERIFIED_NOOP',...report};
  if (!publish) return {state:'VERIFIED_PREVIEW',...report};
  try {await store.write(next,sha);}
  catch (error) {if(error.code==='FIXED_STORE_CONFLICT')return {state:'BUSY',...report,endDate:base.endDate};throw error;}
  const saved=await store.read();
  if (JSON.stringify(saved?.ledger)!==JSON.stringify(next)) throw Error('RECENT_OPERATIONS_STORAGE_READBACK');
  return {state:'PUBLISHED',...report};
}

export function createRecentOperationsReader({readSeed,store,now=Date.now}={}) {
  let checked=0, reading, saved, seed;
  const projections=new Map();
  const emptyLedger={startDate:datesFor(RECENT_OPERATIONS_BASELINE_END,90)[0],endDate:RECENT_OPERATIONS_BASELINE_END,days:[]};
  return async ({days,summaryOnly=false}={}) => {
    if (now()>=checked) {
      reading ??= (async()=>{
        const current=await store?.read().catch(()=>null);
        if (current?.ledger && current.ledger.endDate<=latestClosedDay(now()) &&
            (!saved || current.ledger.endDate>=saved.endDate) && current.ledger!==saved) {
          saved=current.ledger;
          seed=null;
          projections.clear();
        }
        if (!saved) {
          seed ??= Promise.resolve().then(()=>readSeed?.()).catch(()=>null);
          const ledger=await seed;
          if (ledger) {
            saved=ledger;
            projections.clear();
          } else seed=null;
        }
        checked=now()+60000;
      })().finally(()=>{reading=null;});
      await reading;
    }
    const ledger=saved??emptyLedger;
    const endDate=days===undefined?ledger.endDate:latestClosedDay(now());
    const key=[days,summaryOnly].join(':');
    const cached=projections.get(key);
    if (cached?.endDate===endDate) return cached;
    const report=projectRecentOperations(ledger,{days,endDate,summaryOnly});
    const result=saved?report:{...report,sourceUnavailable:true};
    projections.set(key,result);
    return result;
  };
}

export function mountRecentOperations(app,{requireStaff,read,now=Date.now}) {
  app.get(RECENT_OPERATIONS_ROUTE,requireStaff,async(req,res)=>{
    res.set('Cache-Control','private, no-store').vary('Cookie');
    const {days,summary}=req.query;
    if (Object.keys(req.query).some(key=>key!=='days'&&key!=='summary') ||
        days!==undefined&&!reportPeriods.has(days) || summary!==undefined&&(days===undefined||summary!=='1')) {
      return res.status(400).json({error:'RECENT_OPERATIONS_QUERY'});
    }
    try {
      const result=days===undefined?await read():await read({days:Number(days),summaryOnly:summary==='1'});
      return requireStaff(req,res,()=>res.json({...result,expectedEndDate:latestClosedDay(now())}));
    } catch {
      return res.status(503).json({error:'RECENT_OPERATIONS_UNAVAILABLE'});
    }
  });
}
