import {createCipheriv,createDecipheriv,createHash,hkdfSync,randomBytes} from 'node:crypto';
import {promisify} from 'node:util';
import {gzip,gunzip} from 'node:zlib';
import {createPrivateGithubJsonStore} from './fixedVehicleStore.js';
import {datesFor,isDay} from './shadowCoverage/coverageFiles.js';
import {opsmapArchiveSite,opsmapArchiveWriteApproved} from './stageScope.js';

export const nightDispatchCenters=Object.freeze(['osan','yeongnam','honam']);
export const nightDispatchBaselineFrom='2026-08-28';
export const nightDispatchBaselineEnd='2026-11-25';
const baselineFile='recent-operations-v1/night-dispatch-baseline-2026-11-25.json';
const checkpointFile='recent-operations-v1/night-dispatch-checkpoint.json';
const stamp=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const hash=/^[a-f0-9]{64}$/;
const zip=promisify(gzip),unzip=promisify(gunzip);
const dayMs=86_400_000;
const fail=(code='ARCHIVE_INVALID')=>Object.assign(Error('NIGHT_DISPATCH_'+code),{code:'NIGHT_DISPATCH_'+code});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const archiveFile=date=>'recent-operations-v1/night-dispatch-'+date+'.json';
const context=Buffer.from('opsmap-night-dispatch-v1');
const maxPack=4*1024*1024;
const maxDayPack=256*1024;
const minRoute=/^[0-9A-Za-z가-힣 _().·/-]{1,24}$/u;
const scopeKey=({date,centerKey})=>date+':'+centerKey;
const untracked={through:nightDispatchBaselineEnd,pending:[]};
const recoverScopeLimit=2;

function normalizeCheckpoint(value){
  const {through,pending}=value??{};
  if(value?.version!==1||!isDay(through)||through<nightDispatchBaselineEnd||
      !Array.isArray(pending)||pending.length>90*nightDispatchCenters.length)throw fail('CHECKPOINT_INVALID');
  const start=datesFor(through,90)[0],seen=new Set();
  const entries=pending.map(({date,centerKey,attemptedOn})=>{
    const scope={date,centerKey,attemptedOn};
    const key=scopeKey(scope);
    if(!isDay(date)||date<=nightDispatchBaselineEnd||date<start||date>through||
        !nightDispatchCenters.includes(centerKey)||seen.has(key)||
        attemptedOn!==null&&(!isDay(attemptedOn)||attemptedOn<date||attemptedOn>through))throw fail('CHECKPOINT_INVALID');
    seen.add(key);
    return scope;
  }).sort((a,b)=>scopeKey(a).localeCompare(scopeKey(b)));
  return {version:1,through,pending:entries};
}

export function nightDispatchRow({customerCode,vehicles}={}) {
  if(typeof customerCode!=='string'||!/^[A-Z]\d{1,20}$/.test(customerCode)||
      !Array.isArray(vehicles)||!vehicles.length||vehicles.length>30||
      vehicles.some((v,i)=>typeof v!=='string'||!minRoute.test(v)||!/[0-9A-Za-z가-힣]/u.test(v)||
        v.trim()!==v||v==='합계'||v==='소계'||i>0&&v<=vehicles[i-1]))throw fail();
  return [customerCode,vehicles];
}

function normalizeScope(scope,date,baseline=false){
  const {date:observedDate,centerKey,state,observedAt,sourceSha256,detail,rows}=scope??{};
  if(observedDate!==date||!nightDispatchCenters.includes(centerKey)||!hash.test(sourceSha256??'')||
      !['VERIFIED','ZERO_VERIFIED'].includes(state)||
      observedAt===null&&!baseline||observedAt!==null&&(!stamp.test(observedAt??'')||!Number.isFinite(Date.parse(observedAt)))||
      !Number.isInteger(detail)||detail<0||detail>=3000||!Array.isArray(rows)||rows.length>detail||
      (state==='ZERO_VERIFIED')!==(detail===0)||state==='VERIFIED'&&!rows.length)throw fail();
  let prior='';
  const canonical=rows.map(row=>{
    const checked=Array.isArray(row)&&row.length===2
      ?nightDispatchRow({customerCode:row[0],vehicles:row[1]}):nightDispatchRow(row);
    if(checked[0]<=prior)throw fail();
    prior=checked[0];
    return checked;
  });
  return {date,centerKey,state,observedAt,sourceSha256,detail,rows:canonical};
}

function normalizeArchive(value,date){
  if(value?.version!==1||value.date!==date||!Array.isArray(value.scopes))throw fail();
  const baseline=date===nightDispatchBaselineEnd;
  const expected=3*((Date.parse(nightDispatchBaselineEnd)-Date.parse(nightDispatchBaselineFrom))/dayMs+1);
  if(baseline ? value.scopes.length!==expected : value.scopes.length<1||value.scopes.length>3)throw fail();
  const seen=new Set();
  const scopes=value.scopes.map(row=>{
    const day=baseline?row.date:date;
    if(!isDay(day)||baseline&&(day<nightDispatchBaselineFrom||day>date))throw fail();
    const verified=normalizeScope(row,day,baseline);
    const key=day+':'+row.centerKey;
    if(seen.has(key))throw fail();
    seen.add(key);
    return verified;
  }).sort((a,b)=>a.date.localeCompare(b.date)||a.centerKey.localeCompare(b.centerKey));
  return {version:1,date,scopes};
}

async function encode(archive,key,file,limit){
  const bytes=Buffer.from(JSON.stringify(archive));
  const nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from(file));
  const packed=Buffer.concat([nonce,cipher.update(await zip(bytes)),cipher.final(),cipher.getAuthTag()]).toString('base64');
  if(packed.length>limit-256)throw fail('ARCHIVE_SIZE');
  return {sha256:digest(bytes),packed};
}

async function decode(value,key,file,date,limit){
  try{
    if(!hash.test(value?.sha256??'')||typeof value.packed!=='string'||value.packed.length>limit-256)throw fail();
    const packed=Buffer.from(value.packed,'base64');
    if(packed.length<29||packed.toString('base64')!==value.packed)throw fail();
    const decipher=createDecipheriv('aes-256-gcm',key,packed.subarray(0,12));
    decipher.setAAD(Buffer.from(file));
    decipher.setAuthTag(packed.subarray(-16));
    const bytes=await unzip(Buffer.concat([decipher.update(packed.subarray(12,-16)),decipher.final()]),
      {maxOutputLength:date===nightDispatchBaselineEnd?24*1024*1024:1024*1024});
    if(digest(bytes)!==value.sha256)throw fail();
    return normalizeArchive(JSON.parse(bytes),date);
  }catch{throw fail();}
}

export function createStageNightDispatchArchive({env=process.env,fetchImpl=fetch,write=false,now=Date.now}={}){
  if(opsmapArchiveSite(env)!=='primary'||env.OPSMAP_STAGE_RECENT_OPERATIONS_SYNC_APPROVED!=='1'||
      write&&!opsmapArchiveWriteApproved(env))return null;
  const repo='mingu0702-droid/freshon-cache',branch='stage/opsmap-snapshots',prefix='opsmap-stage';
  const root='https://api.github.com/repos/'+repo;
  const token=env.OPSMAP_PRIMARY_ARCHIVE_READ_TOKEN,writer=env.OPSMAP_PRIMARY_ARCHIVE_WRITE_TOKEN;
  const encoded=env.OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64;
  if(!token||write&&(!writer||writer===token)||!/^[A-Za-z0-9+/]{43}=$/.test(encoded||''))return null;
  const key=Buffer.from(hkdfSync('sha256',Buffer.from(encoded,'base64'),context,Buffer.from('asset-encryption'),32));
  const client=writable=>createPrivateGithubJsonStore({now,env:{GITHUB_CACHE_REPO:repo,GITHUB_CACHE_BRANCH:branch,
    GITHUB_CACHE_DIR:prefix,GITHUB_TOKEN:writable?writer:token},fetchImpl:(input,options={})=>{
    const url=new URL(input),method=options.method||'GET',path=url.origin+url.pathname;
    const file=path.startsWith(root+'/contents/'+prefix+'/') ? path.slice((root+'/contents/'+prefix+'/').length):'';
    const allowed=file===baselineFile||file===checkpointFile||/^recent-operations-v1\/night-dispatch-\d{4}-\d{2}-\d{2}\.json$/.test(file)&&
      file>archiveFile(nightDispatchBaselineEnd);
    if(url.username||url.password||url.hash||!(method==='GET'&&(path===root&&!url.search||
        allowed&&url.searchParams.size===1&&url.searchParams.get('ref')===branch||
        path.startsWith(root+'/git/blobs/')&&/^[a-f0-9]{40}$/.test(path.split('/').at(-1))&&!url.search)||
        writable&&method==='PUT'&&allowed&&!url.search&&JSON.parse(options.body).branch===branch))throw fail('ARCHIVE_SCOPE');
    return fetchImpl(input,{...options,redirect:'error'});
  }});
  const read=client(false), updater=write?client(true):null;
  let bootstrap;
  function readBaseline(){
    bootstrap??=read.readRaw(baselineFile,maxPack).then(value=>{
      if(!value){bootstrap=null;return null;}
      return decode(value,key,baselineFile,nightDispatchBaselineEnd,maxPack);
    }).catch(error=>{bootstrap=null;throw error;});
    return bootstrap;
  }
  function checkDate(date){
    if(!isDay(date)||date>=new Date(now()+9*3_600_000).toISOString().slice(0,10))throw fail('ARCHIVE_SCOPE');
  }
  async function get(date){
    checkDate(date);
    if(date<nightDispatchBaselineFrom)return [];
    if(date<=nightDispatchBaselineEnd)return (await readBaseline())?.scopes.filter(scope=>scope.date===date)??[];
    const file=archiveFile(date),value=await read.readRaw(file,maxDayPack);
    return value?(await decode(value,key,file,date,maxDayPack)).scopes:[];
  }
  return {readDay:get,...(write?{
    async readCheckpoint(){
      const {value,sha}=await read.read(checkpointFile);
      const checkpoint=value===null?null:normalizeCheckpoint(value);
      if(checkpoint)checkDate(checkpoint.through);
      return {checkpoint,sha};
    },
    async saveCheckpoint(through,pending,sha){
      checkDate(through);
      const next=normalizeCheckpoint({version:1,through,pending});
      await updater.write(checkpointFile,next,sha);
      const saved=await read.readRaw(checkpointFile,64*1024);
      if(!saved||JSON.stringify(normalizeCheckpoint(saved))!==JSON.stringify(next))throw fail('CHECKPOINT_READBACK');
    },
    async saveDay(date,additions){
      checkDate(date);
      if(date<=nightDispatchBaselineEnd)throw fail('ARCHIVE_SCOPE');
      const file=archiveFile(date),{value,sha}=await read.read(file);
      const previous=value?(await decode(value,key,file,date,maxDayPack)).scopes:[];
      const byCenter=new Map(previous.map(item=>[item.centerKey,item]));
      for(const item of additions)if(!byCenter.has(item.centerKey))byCenter.set(item.centerKey,normalizeScope(item,date));
      if(byCenter.size===previous.length)return previous;
      const next=normalizeArchive({version:1,date,scopes:[...byCenter.values()]},date);
      await updater.write(file,await encode(next,key,file,maxDayPack),sha);
      const saved=await get(date);
      if(JSON.stringify(saved)!==JSON.stringify(next.scopes))throw fail('ARCHIVE_READBACK');
      return saved;
    },
    async storeBaseline(scopes){
      checkDate(nightDispatchBaselineEnd);
      const next=normalizeArchive({version:1,date:nightDispatchBaselineEnd,scopes},nightDispatchBaselineEnd);
      const existing=await readBaseline();
      if(existing){
        if(JSON.stringify(existing)!==JSON.stringify(next))throw fail('ARCHIVE_ALREADY_EXISTS');
        return {state:'REUSED',scopes:next.scopes.length};
      }
      const value=await encode(next,key,baselineFile,maxPack);
      await updater.write(baselineFile,value,null);
      bootstrap=null;
      const saved=await readBaseline();
      if(JSON.stringify(saved)!==JSON.stringify(next))throw fail('ARCHIVE_READBACK');
      return {state:'PUBLISHED',scopes:next.scopes.length,sha256:value.sha256,bytes:value.packed.length};
    }
  }:{})};
}

export function nightDispatchOperations(scopes){
  return scopes.map(({date,centerKey,rows})=>{
    const confirmed=rows.filter(([,vehicles])=>vehicles.some(vehicle=>vehicle!=='미배정'))
      .map(([customerCode])=>({customerCode,evidence:'dispatch_confirmed'}));
    return {date,centerKey,source:'wms_dispatch',coverage:confirmed.length?'partial':'complete',rows:confirmed};
  });
}

export async function collectStageNightDispatch({date,archive,read,onCenter=()=>{},centerKeys=nightDispatchCenters,
  latestDate=date}){
  if(!isDay(date)||!isDay(latestDate)||date>latestDate||!archive?.readDay||!archive?.saveDay||typeof read!=='function'||
      centerKeys.some(center=>!nightDispatchCenters.includes(center)))throw fail('ARCHIVE_SCOPE');
  if(date<=nightDispatchBaselineEnd)return [];
  const before=await archive.readDay(date);
  const savedCenters=new Set(before.map(row=>row.centerKey));
  const fetched=[];
  const neighbors=new Map();
  async function readNeighbor(centerKey){
    for(const offset of [1,-1,2,-2,3,-3,4,-4]){
      const day=new Date(Date.parse(date)-offset*dayMs).toISOString().slice(0,10);
      // Never send a corroborating FreshOn range that reaches the sealed 90-day baseline.
      if(day<=nightDispatchBaselineEnd||day>latestDate)continue;
      if(!neighbors.has(day))neighbors.set(day,await archive.readDay(day));
      const scope=neighbors.get(day).find(item=>item.centerKey===centerKey&&item.state==='VERIFIED');
      if(scope)return {date:day,centerKey,detail:scope.detail};
    }
    return null;
  }
  for(const centerKey of centerKeys){
    if(savedCenters.has(centerKey))continue;
    if(read.hasCapacity?.()===false){
      onCenter({date,centerKey,state:'DEFERRED_BUDGET'});
      continue;
    }
    try{
      const row=await read(date,centerKey,{neighbor:()=>readNeighbor(centerKey)});
      if(row&&row.centerKey!==centerKey)throw fail();
      if(row)fetched.push(normalizeScope(row,date));
      else onCenter({date,centerKey,state:'SOURCE_UNCONFIRMED'});
    }catch(error){
      const code=error?.code??error?.message;
      onCenter({date,centerKey,state:'SOURCE_UNAVAILABLE',
        error:/^(?:FRESHON_NIGHT_DISPATCH|NIGHT_DISPATCH|FIXED_STORE)_[A-Z_]+$/.test(code??'')?code:'NIGHT_DISPATCH_READ_FAILED'});
    }
  }
  const current=fetched.length?await archive.saveDay(date,fetched):before;
  for(const {centerKey,state,rows,detail} of current){
    const vehicleSet=new Set(rows.flatMap(([,vehicles])=>vehicles.filter(vehicle=>vehicle!=='미배정')));
    onCenter({date,centerKey,state: savedCenters.has(centerKey)?'ALREADY_ARCHIVED':state,
      kind:state,customers:rows.length,vehicles:vehicleSet.size,detail});
  }
  return current;
}

export async function collectStageNightDispatchRun({date,archive,read,onCenter=()=>{}}){
  if(!isDay(date)||!archive?.readCheckpoint||!archive?.saveCheckpoint||typeof read!=='function')throw fail('ARCHIVE_SCOPE');
  if(date<=nightDispatchBaselineEnd)return {scopes:[]};
  const {checkpoint,sha}=await archive.readCheckpoint();
  const {through,pending}=checkpoint??untracked;
  if(through>date)throw fail('CHECKPOINT_INVALID');
  const window=datesFor(date,90);
  const remaining=new Map(pending.filter(scope=>scope.date>=window[0]).map(scope=>[scopeKey(scope),scope]));
  for(const missingDate of window.filter(day=>day>through)){
    for(const centerKey of nightDispatchCenters){
      const scope={date:missingDate,centerKey,attemptedOn:null};
      remaining.set(scopeKey(scope),scope);
    }
  }
  const scopes=[];
  async function collect(target,requested){
    const attempted=[];
    const accept=async(day,center,options)=>{
      attempted.push(scopeKey({date:day,centerKey:center}));
      return read(day,center,options);
    };
    accept.hasCapacity=read.hasCapacity;
    try{
      const saved=await collectStageNightDispatch({date:target,archive,read:accept,onCenter,
        centerKeys:requested,latestDate:date});
      for(const scope of saved){
        const key=scopeKey(scope);
        if(target===date||remaining.has(key))scopes.push(scope);
        remaining.delete(key);
      }
    }catch(error){
      logUnavailable(onCenter,target,error);
    }
    for(const key of attempted){
      const scope=remaining.get(key);
      if(scope)scope.attemptedOn=date;
    }
    return attempted.length;
  }
  const eligible=scope=>scope.attemptedOn!==date;
  await collect(date,[...remaining.values()].filter(scope=>scope.date===date&&eligible(scope)).map(scope=>scope.centerKey));
  const historical=[...remaining.values()].filter(scope=>scope.date<date&&eligible(scope))
    .sort((a,b)=>(a.attemptedOn??'').localeCompare(b.attemptedOn??'')||scopeKey(a).localeCompare(scopeKey(b)));
  let recoveryAttempts=0;
  const examinedDates=new Set();
  for(const {date:target,centerKey} of historical){
    if(recoveryAttempts>=recoverScopeLimit||read.hasCapacity?.()===false)break;
    if(!remaining.has(scopeKey({date:target,centerKey}))||
        !examinedDates.has(target)&&examinedDates.size>=recoverScopeLimit)continue;
    examinedDates.add(target);
    recoveryAttempts+=await collect(target,[centerKey]);
  }
  const pendingScopes=[...remaining.values()].sort((a,b)=>scopeKey(a).localeCompare(scopeKey(b)));
  return {scopes,saveProgress:async()=>{
    // Only clear successful scopes after the public-facing projection was round-tripped.
    if(through!==date||JSON.stringify(pending)!==JSON.stringify(pendingScopes)){
      try{await archive.saveCheckpoint(date,pendingScopes,sha);}
      catch(error){logUnavailable(onCenter,date,error,'CHECKPOINT_UNAVAILABLE');return;}
    }
    onCenter({date,state:'CHECKPOINT',pendingScopes:pendingScopes.length});
  }};
}

function logUnavailable(onCenter,date,error,state='ARCHIVE_UNAVAILABLE'){
  const code=error?.code??error?.message;
  onCenter({date,state,error:/^(?:NIGHT_DISPATCH|FIXED_STORE)_[A-Z_]+$/.test(code??'')?code:'NIGHT_DISPATCH_UNAVAILABLE'});
}

