import {createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {gzip, gunzip} from 'node:zlib';
import {createPrivateGithubJsonStore} from './fixedVehicleStore.js';
import {openOpsmapSyncGenerationStore, SYNC_MAX_DAY_BYTES, syncDigest, syncHash, syncSha256, validateOpsmapSyncDay} from './opsmapSyncGeneration.js';
import {boundedRead, isDay, parseCoverageIndex, PERIODS} from './shadowCoverage/coverageFiles.js';
import {STAGE_ORIGIN, STAGE_SERVICE} from './stageScope.js';
import {MAX_VEHICLE_DELIVERY_BYTES,VEHICLE_DELIVERY_FILE} from './opsmapVehicleDeliveryEvidence.js';

const compress = promisify(gzip), decompress = promisify(gunzip);
const HEAD = 'head-v1.json';
const LEASE_MS = 20 * 60_000;
const MAX_RELEASE_BYTES = 14 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const objectName = /^(?:release|day)-[a-f0-9]{64}\.json$/;
const gitSha = /^[a-f0-9]{40}$/;
const metadataFiles = new Map([
  ['snapshot.json',8*1024*1024],['fixed-store-coordinates-v1.json',8*1024*1024],['nearby.json',384*1024],
  ['input/stores.private.json',3*1024*1024],['input/base.private.json',3*1024*1024],
  ['input/source-import.safe.json',32_768],['coverage/coverage-index.json',16_384]
]);

export function stageOpsmapDurableStorage({env = process.env, fetchImpl = fetch, write = false} = {}) {
  if (env.RENDER_SERVICE_ID !== STAGE_SERVICE || env.RENDER_EXTERNAL_URL !== STAGE_ORIGIN ||
      env.OPSMAP_STAGE_SYNC_REMOTE_APPROVED !== '1' || (write && env.OPSMAP_STAGE_SYNC_PUBLISH_APPROVED !== '1')) {
    throw Error('OPSMAP_DURABLE_STAGE_APPROVAL');
  }
  const token = write ? env.OPSMAP_STAGE_SYNC_WRITE_TOKEN || (env.OPSMAP_STAGE_SYNC_USE_SNAPSHOT_WRITER==='1' && env.OPSMAP_SNAPSHOT_STORE_TOKEN)
    : env.OPSMAP_STAGE_SYNC_READ_TOKEN || env.OPSMAP_SNAPSHOT_STORE_TOKEN || env.OPSMAP_SHADOW_GITHUB_READ_TOKEN;
  const key = Buffer.from(env.OPSMAP_SHADOW_ARCHIVE_KEY_B64 || '','base64');
  if (!token || key.length !== 32) throw Error('OPSMAP_DURABLE_STAGE_CREDENTIALS');
  const repo = 'mingu0702-droid/freshon-cache', branch = 'stage/opsmap-snapshots', prefix = 'opsmap-stage/scheduled-generations-v1';
  const base = 'https://api.github.com/repos/'+repo;
  const guard = (input,options={}) => {
    const url = new URL(input);
    const method = options.method || 'GET';
    const plain = url.origin+url.pathname;
    const folder=base+'/contents/'+prefix+'/';
    const name = plain.startsWith(folder) ? plain.slice(folder.length) : null;
    const own = name===HEAD || objectName.test(name || '');
    const get = method==='GET' && (own && url.searchParams.size===1 && url.searchParams.get('ref')===branch ||
      !url.search && (plain===base || plain.startsWith(base+'/git/blobs/') && gitSha.test(plain.split('/').at(-1))));
    const put = method==='PUT' && write && own && !url.search && JSON.parse(options.body).branch===branch;
    if (url.username || url.password || url.hash || (!get && !put)) throw Error('OPSMAP_DURABLE_REPO_SCOPE');
    return fetchImpl(input,{...options,redirect:'error'});
  };
  const store = createPrivateGithubJsonStore({env:{GITHUB_CACHE_REPO:repo,GITHUB_CACHE_BRANCH:branch,GITHUB_CACHE_DIR:prefix,GITHUB_TOKEN:token},fetchImpl:guard});
  return {store:write?store:{read:store.read},key};
}

const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const equalHex = (a,b) => syncHash(a) && syncHash(b) && timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const safeCode = value => /^[A-Z][A-Z_0-9]{1,95}$/.test(value || '') ? value : 'OPSMAP_SYNC_FAILED';
const reference = value => value && Number.isSafeInteger(value.revision) && value.revision>0 && syncHash(value.generation) &&
  syncHash(value.blob) && isDay(value.asOf) && syncHash(value.runId);

function payloadFiles(index,state) {
  const files=new Map([...metadataFiles,...[index.catalog,...PERIODS.map(days=>index.windows[days])]
    .map(ref=>['coverage/'+ref.sha256+'.json',ref.bytes])]);
  if(state.vehicleDeliverySha256)files.set(VEHICLE_DELIVERY_FILE,MAX_VEHICLE_DELIVERY_BYTES);
  return files;
}

async function packGeneration(generation) {
  const files = {};
  let bytes = 0;
  for (const [name,limit] of payloadFiles(generation.index,generation.state)) {
    const data = await boundedRead(path.join(generation.folder,name),limit);
    bytes += data.length;
    if (bytes > MAX_RELEASE_BYTES * 0.7) throw Error('OPSMAP_DURABLE_RELEASE_LIMIT');
    files[name] = data.toString('base64');
  }
  return Buffer.from(JSON.stringify({state:generation.state,files}));
}

export function createOpsmapDurableGeneration({store,key,now=Date.now,tempRoot=tmpdir(),appRoot=process.cwd()} = {}) {
  if (!Buffer.isBuffer(key) || key.length!==32 || typeof store?.read!=='function') throw Error('OPSMAP_DURABLE_CONFIG');
  const kdf = label => Buffer.from(hkdfSync('sha256',key,Buffer.from('opsmap-scheduled-release-v1'),Buffer.from(label),32));
  const encryption = kdf('objects'), signing = kdf('head');
  const mac = value => createHmac('sha256',signing).update(JSON.stringify(value)).digest('hex');
  let cached, restoring;
  const empty = {version:1,current:null,previous:null,run:null,lastSuccess:null,lastFailure:null};

  async function readHead() {
    const {value,sha} = await store.read(HEAD);
    if (!value && !sha) return {head:empty,sha:null};
    if (!gitSha.test(sha || '') || !value) throw Error('OPSMAP_DURABLE_HEAD');
    const {signature,...head} = value;
    if (head.version!==1 || !equalHex(signature,mac(head)) || head.current!==null&&!reference(head.current) ||
        head.previous!==null&&(!reference(head.previous)||head.previous.revision>=head.current?.revision) ||
        head.run!==null&&(!syncHash(head.run.runId)||!isoTime(head.run.startedAt))) throw Error('OPSMAP_DURABLE_HEAD');
    return {head,sha};
  }

  const writeHead = (head,sha) => store.write(HEAD,{...head,signature:mac(head)},sha);

  async function decode(kind,id,value,limit) {
    if (value?.version!==1 || typeof value.ciphertext!=='string' || value.ciphertext.length>Math.ceil(MAX_COMPRESSED_BYTES/3)*4 ||
        !/^[a-f0-9]{24}$/.test(value.nonce || '') || !/^[a-f0-9]{32}$/.test(value.tag || '')) throw Error('OPSMAP_DURABLE_OBJECT');
    const decipher = createDecipheriv('aes-256-gcm',encryption,Buffer.from(value.nonce,'hex'));
    decipher.setAAD(Buffer.from(kind+':'+id));
    decipher.setAuthTag(Buffer.from(value.tag,'hex'));
    const encrypted = Buffer.from(value.ciphertext,'base64');
    const bytes = await decompress(Buffer.concat([decipher.update(encrypted),decipher.final()]),{maxOutputLength:limit});
    if (syncSha256(bytes)!==id) throw Error('OPSMAP_DURABLE_OBJECT_DIGEST');
    return bytes;
  }

  async function readObject(kind,id,limit) {
    if (!syncHash(id)) throw Error('OPSMAP_DURABLE_OBJECT_REF');
    return decode(kind,id,(await store.read(kind+'-'+id+'.json')).value,limit);
  }

  async function putObject(kind,bytes,limit) {
    if (!bytes.length || bytes.length>limit) throw Error('OPSMAP_DURABLE_OBJECT_LIMIT');
    const id=syncSha256(bytes), name=kind+'-'+id+'.json';
    const old=await store.read(name);
    if (old.value) {await decode(kind,id,old.value,limit);return id;}
    const compressed=await compress(bytes,{level:4});
    if (compressed.length>MAX_COMPRESSED_BYTES) throw Error('OPSMAP_DURABLE_OBJECT_LIMIT');
    const nonce=randomBytes(12);
    const cipher=createCipheriv('aes-256-gcm',encryption,nonce);
    cipher.setAAD(Buffer.from(kind+':'+id));
    const encrypted=Buffer.concat([cipher.update(compressed),cipher.final()]);
    try {await store.write(name,{version:1,nonce:nonce.toString('hex'),tag:cipher.getAuthTag().toString('hex'),ciphertext:encrypted.toString('base64')},null);}
    catch(error) {if (error.code!=='FIXED_STORE_CONFLICT') throw error;}
    await readObject(kind,id,limit);
    return id;
  }

  async function restore(ref) {
    const {state,files} = JSON.parse(await readObject('release',ref.blob,MAX_RELEASE_BYTES));
    if (state?.revision!==ref.revision || state.generation!==ref.generation || state.asOf!==ref.asOf ||
        state.runId!==ref.runId || !/^[a-f0-9-]{36}$/.test(state.id || '') || !files) throw Error('OPSMAP_DURABLE_RELEASE');
    const index = parseCoverageIndex(Buffer.from(files['coverage/coverage-index.json'] || '','base64'));
    const expected=payloadFiles(index,state);
    if (Object.keys(files).length!==expected.size) throw Error('OPSMAP_DURABLE_RELEASE_FILES');
    const root=await fs.mkdtemp(path.join(tempRoot,'opsmap-durable-view-'));
    try {
      const folder=path.join(root,'generations',state.id);
      await fs.mkdir(path.join(folder,'input'),{recursive:true,mode:0o700});
      await fs.mkdir(path.join(folder,'coverage'),{mode:0o700});
      for (const [name,limit] of expected) {
        if (typeof files[name]!=='string' || files[name].length>Math.ceil(limit/3)*4) throw Error('OPSMAP_DURABLE_RELEASE_FILES');
        const data=Buffer.from(files[name],'base64');
        if (!data.length||data.length>limit) throw Error('OPSMAP_DURABLE_RELEASE_FILES');
        await fs.writeFile(path.join(folder,name),data,{flag:'wx',mode:0o600});
      }
      await fs.mkdir(path.join(root,'published'),{mode:0o700});
      await fs.writeFile(path.join(root,'published',String(state.revision).padStart(12,'0')+'.json'),JSON.stringify({...state,sha256:syncDigest(state)}),{flag:'wx',mode:0o600});
      const generation=await (await openOpsmapSyncGenerationStore(root,{appRoot})).read();
      if (!generation) throw Error('OPSMAP_DURABLE_RELEASE');
      return {root,generation,ref};
    } catch(error) {await fs.rm(root,{recursive:true,force:true}).catch(()=>{});throw error;}
  }

  async function read() {
    restoring ??= (async()=>{
      const {head}=await readHead();
      if (cached && cached.ref.blob===head.current?.blob) return cached.generation;
      for (const ref of [head.current,head.previous].filter(Boolean)) {
        if (cached?.ref.blob===ref.blob) return cached.generation;
        let next;
        try {next=await restore(ref);}catch{continue;}
        const previous=cached;
        cached=next;
        if(previous) setTimeout(()=>void fs.rm(previous.root,{recursive:true,force:true}).catch(()=>{}),30_000).unref();
        return next.generation;
      }
      if (head.current) throw Error('OPSMAP_DURABLE_NO_VERIFIED_RELEASE');
      return cached?.generation || null;
    })().catch(error=>{if(cached)return cached.generation;throw error;}).finally(()=>{restoring=null;});
    return restoring;
  }

  return {read, async dispose() {
    const previous=cached;
    cached=null;
    if(previous) await fs.rm(previous.root,{recursive:true,force:true});
  }, async readDay(date,generation) {
    if (!isDay(date)) throw Error('OPSMAP_SYNC_DAY');
    const active=generation || await read();
    const id=active?.state.dates[date];
    return id ? validateOpsmapSyncDay(JSON.parse(await readObject('day',id,SYNC_MAX_DAY_BYTES)),date) : null;
  }, async readStatus() {
    const {head}=await readHead();
    return {generation:head.current?.generation || null,run:head.run,lastSuccessAt:head.lastSuccess?.completedAt || null,lastFailure:head.lastFailure};
  }, async restoreSpool(directory) {
    const target=await openOpsmapSyncGenerationStore(directory,{appRoot,writable:true});
    const generation=await read();
    if (!generation) return;
    const local=await target.read();
    if (local?.state.revision>=generation.state.revision) {
      if (local.state.revision===generation.state.revision && local.index.sha256!==generation.index.sha256) {
        throw Error('OPSMAP_DURABLE_SPOOL_CONFLICT');
      }
      return;
    }
    const folder=path.join(target.root,'generations',generation.state.id);
    await fs.mkdir(path.join(folder,'input'),{recursive:true,mode:0o700});
    await fs.mkdir(path.join(folder,'coverage'),{recursive:true,mode:0o700});
    for(const [name,limit] of payloadFiles(generation.index,generation.state)){
      const bytes=await boundedRead(path.join(generation.folder,name),limit);
      const targetFile=path.join(folder,name);
      try {await fs.writeFile(targetFile,bytes,{flag:'wx',mode:0o600});}
      catch(error) {if(error.code!=='EEXIST'||!bytes.equals(await boundedRead(targetFile,limit)))throw error;}
    }
    const {state}=generation;
    const file=path.join(target.root,'published',String(state.revision).padStart(12,'0')+'.json');
    const pending=path.join(target.root,'published','.restore-'+randomUUID());
    try {
      await fs.writeFile(pending,JSON.stringify({...state,sha256:syncDigest(state)}),{flag:'wx',mode:0o600});
      await fs.link(pending,file).catch(error=>{if(error.code!=='EEXIST')throw error;});
    } finally {await fs.unlink(pending).catch(()=>{});}
    if ((await target.read())?.state.revision!==state.revision) throw Error('OPSMAP_DURABLE_SPOOL_RESTORE');
  }, async reserve(receipt) {
    if (!store.write) throw Error('OPSMAP_DURABLE_READ_ONLY');
    const {head,sha}=await readHead();
    if (head.run?.state==='RUNNING' && head.run.leaseUntil>now()) return {state:'BUSY'};
    if (head.lastSuccess?.runId===receipt.runId || head.run?.slot>receipt.slot) return {state:'NOOP'};
    const run={...receipt,state:'RUNNING',owner:randomUUID(),startedAt:new Date(now()).toISOString(),leaseUntil:now()+LEASE_MS};
    try {await writeHead({...head,run},sha);}
    catch(error){if(error.code==='FIXED_STORE_CONFLICT')return {state:'BUSY'};throw error;}
    return {state:'STARTED',run,active:head.current};
  }, async fail(run,error) {
    const {head,sha}=await readHead();
    if (head.run?.owner!==run.owner || head.run.state!=='RUNNING') return;
    const finished={...head.run,state:'FAILED',error:safeCode(error.code || error.message),completedAt:new Date(now()).toISOString(),
      failedDate:isDay(error.date)?error.date:null,failedCenter:['osan','yeongnam','honam'].includes(error.center)?error.center:null,
      failedSourceId:['1','2','3','4'].includes(error.sourceId)?error.sourceId:null};
    await writeHead({...head,run:finished,lastFailure:finished},sha);
  }, async confirmUnchanged(run,generation,observationHash) {
    const {head,sha}=await readHead();
    if(head.run?.owner!==run.owner||head.run.state!=='RUNNING'||head.run.leaseUntil<=now()||!syncHash(observationHash)||
       head.current?.generation!==generation.index.sha256||head.current.revision!==generation.state.revision)throw Error('OPSMAP_DURABLE_LEASE');
    const finished={...head.run,state:'VERIFIED_NOOP',generation:head.current.generation,revision:head.current.revision,observationHash,
      sourceReadComplete:true,observedToday:true,completedAt:new Date(now()).toISOString()};
    await writeHead({...head,run:finished,lastSuccess:finished},sha);
    if ((await readHead()).head.lastSuccess?.owner!==run.owner) throw Error('OPSMAP_DURABLE_HEAD_READBACK');
    return finished;
  }, async commit(run,generation) {
    const {head,sha}=await readHead();
    if (head.run?.owner!==run.owner || head.run.state!=='RUNNING' || head.run.leaseUntil<=now()) throw Error('OPSMAP_DURABLE_LEASE');
    if (generation?.state.runId!==run.runId || generation.state.sourceReadComplete!==true || !syncHash(generation.state.observationHash) ||
        head.current && (generation.state.revision<=head.current.revision || generation.index.asOf<head.current.asOf)) {
      throw Error('OPSMAP_DURABLE_RELEASE_REGRESSION');
    }
    let oldDates={};
    if(head.current){
      const current=await read();
      if(current?.state.revision!==head.current.revision) throw Error('OPSMAP_DURABLE_REPAIR_REQUIRED');
      oldDates=current.state.dates;
    }
    if(Object.keys(oldDates).some(date=>!generation.state.dates[date])) throw Error('OPSMAP_DURABLE_HISTORY_REGRESSION');
    for(const [date,id] of Object.entries(generation.state.dates)){
      if(oldDates[date]===id)continue;
      const data=await boundedRead(path.join(generation.input,'observed-days',date+'.json'),SYNC_MAX_DAY_BYTES);
      if(syncSha256(data)!==id)throw Error('OPSMAP_DURABLE_DAY_DIGEST');
      validateOpsmapSyncDay(JSON.parse(data),date);
      await putObject('day',data,SYNC_MAX_DAY_BYTES);
    }
    const blob=await putObject('release',await packGeneration(generation),MAX_RELEASE_BYTES);
    const current={revision:generation.state.revision,asOf:generation.index.asOf,generation:generation.index.sha256,blob,runId:run.runId};
    const finished={...head.run,state:'PUBLISHED',generation:current.generation,revision:current.revision,
      observationHash:generation.state.observationHash,sourceReadComplete:true,observedToday:true,completedAt:new Date(now()).toISOString()};
    if(run.leaseUntil<=now())throw Error('OPSMAP_DURABLE_LEASE');
    await writeHead({...head,current,previous:head.current,run:finished,lastSuccess:finished},sha);
    const saved=await readHead();
    if(saved.head.current?.blob!==blob)throw Error('OPSMAP_DURABLE_HEAD_READBACK');
    return finished;
  }};
}
