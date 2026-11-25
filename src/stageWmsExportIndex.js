import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {createPrivateGithubJsonStore} from './fixedVehicleStore.js';
import {opsmapArchiveSite,opsmapArchiveWriteApproved} from './stageScope.js';

export const WMS_ARCHIVE_REPO='mingu0702-droid/freshon-cache';
export const WMS_ARCHIVE_DIR='opsmap-stage/wms-dispatch-v1';
export const FRESHON_JSON_WMS_FORMAT='FRESHON_JSON_V1';
export const WMS_OFFICIAL_ROUND_FORMAT='WMS_GAS_PAIRED_V1';
const branch='stage/opsmap-wms-exports', indexFile='release-index-v1.json';
const entryLimit=5000, indexByteLimit=1024*1024;
const entryFile=/^release-\d{4}-\d{2}-\d{2}-[a-f0-9]{64}\.json$/;
const sha40=/^[a-f0-9]{40}$/, sha64=/^[a-f0-9]{64}$/;
export const stageWmsError=code=>Object.assign(Error(code),{code});
export const isStageWmsDay=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
export function stageWmsArchiveKey(env){
  const encoded=env.OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_KEY_B64||'';
  const key=Buffer.from(encoded,'base64');
  return key.length===32&&key.toString('base64')===encoded?key:null;
}

function serializeEntries(entries){
  if(!Array.isArray(entries)||entries.length>entryLimit)throw stageWmsError('WMS_EXPORT_RELEASE_INDEX_INVALID');
  let last='';
  return entries.map(entry=>{
    const {date,warehouse,sha256,observedAt,format}=entry||{};
    if(!isStageWmsDay(date)||date<=last||warehouse!=='011'||!sha64.test(sha256||'')||
        (format!==undefined&&format!==FRESHON_JSON_WMS_FORMAT&&format!==WMS_OFFICIAL_ROUND_FORMAT)||typeof observedAt!=='string'||observedAt.length>35||!Number.isFinite(Date.parse(observedAt))){
      throw stageWmsError('WMS_EXPORT_RELEASE_INDEX_INVALID');
    }
    last=date;
    return [date,warehouse,sha256,observedAt,...(format?[format]:[])];
  });
}

function mac(body,key){
  return createHmac('sha256',key).update('opsmap-stage-wms-release-index-v1\0').update(JSON.stringify(body)).digest();
}

export function sealStageWmsExportIndex(entries,key){
  const sorted=[...entries].sort((a,b)=>a.date.localeCompare(b.date));
  const fields=serializeEntries(sorted);
  return {schema:1,entries:sorted,tag:mac(fields,key).toString('hex')};
}
function readIndex(value,key){
  if(value===null)return [];
  if(value?.schema!==1||!sha64.test(value.tag||''))throw stageWmsError('WMS_EXPORT_RELEASE_INDEX_INVALID');
  const fields=serializeEntries(value.entries);
  if(!timingSafeEqual(Buffer.from(value.tag,'hex'),mac(fields,key)))throw stageWmsError('WMS_EXPORT_RELEASE_INDEX_INVALID');
  return fields.map(([date,warehouse,sha256,observedAt,format])=>({date,warehouse,sha256,observedAt,...(format?{format}:{})}));
}
export function stageWmsReleaseFile({date,warehouse,sha256,observedAt,format}){
  const [fields]=serializeEntries([{date,warehouse,sha256,observedAt,format}]);
  // JSON content is immutable and observation time belongs to the signed
  // index. An interrupted or concurrent publish reuses the same archive file.
  const identity=format?[date,warehouse,sha256,format]:fields;
  return 'release-'+date+'-'+createHash('sha256').update(JSON.stringify(identity)).digest('hex')+'.json';
}
export const stageWmsReleaseEnabled=env=>
  Boolean(opsmapArchiveSite(env))&&
  env.OPSMAP_STAGE_WMS_DISPATCH_EXPORT_APPROVED==='1'&&sha40.test(env.OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_REF||'');

export function createStageWmsReleaseStore({env=process.env,fetchImpl=fetch,write=false}={}){
  if(!stageWmsReleaseEnabled(env))return null;
  if(write&&(!opsmapArchiveWriteApproved(env)||env.OPSMAP_STAGE_WMS_DISPATCH_EXPORT_PUBLISH_APPROVED!=='1'))return null;
  const key=stageWmsArchiveKey(env);
  const token=write?(env.OPSMAP_STAGE_WMS_DISPATCH_EXPORT_ARCHIVE_WRITE_TOKEN||env.OPSMAP_STAGE_SYNC_WRITE_TOKEN):
    (env.OPSMAP_SHADOW_GITHUB_READ_TOKEN||env.OPSMAP_SNAPSHOT_STORE_TOKEN);
  if(!key||!token)return null;
  const root='https://api.github.com/repos/'+WMS_ARCHIVE_REPO;
  const prefix=root+'/contents/'+WMS_ARCHIVE_DIR+'/';
  const api=createPrivateGithubJsonStore({
    env:{GITHUB_CACHE_REPO:WMS_ARCHIVE_REPO,GITHUB_CACHE_DIR:WMS_ARCHIVE_DIR,GITHUB_CACHE_BRANCH:branch,GITHUB_TOKEN:token},
    fetchImpl(input,options){
      const url=new URL(input),address=url.origin+url.pathname,method=options.method||'GET';
      const name=address.startsWith(prefix)?address.slice(prefix.length):'';
      const scoped=name===indexFile||entryFile.test(name);
      const allowedRead=method==='GET'&&(address===root&&!url.search||
        scoped&&url.searchParams.size===1&&url.searchParams.get('ref')===branch);
      const allowedWrite=write&&method==='PUT'&&scoped&&!url.search&&JSON.parse(options.body).branch===branch;
      if((!allowedRead&&!allowedWrite)||url.username||url.password||url.hash)throw stageWmsError('WMS_EXPORT_RELEASE_SCOPE');
      const signal=!write&&name===indexFile?AbortSignal.any([options.signal,AbortSignal.timeout(3000)]):options.signal;
      return fetchImpl(input,{...options,signal,redirect:'error'});
    }
  });
  return {
    async readIndex(){
      if(!write)return {entries:readIndex(await api.readRaw(indexFile,indexByteLimit),key)};
      const {sha,value}=await api.read(indexFile);
      if(value!==null&&!sha40.test(sha||''))throw stageWmsError('WMS_EXPORT_RELEASE_INDEX_INVALID');
      return {sha,entries:readIndex(value,key)};
    },
    readArchive:(entry,maxBytes)=>api.readRaw(stageWmsReleaseFile(entry),maxBytes),
    ...(write?{
      createArchive:(entry,archive)=>api.write(stageWmsReleaseFile(entry),archive,null),
      writeIndex:(entries,sha)=>api.write(indexFile,sealStageWmsExportIndex(entries,key),sha),
    }:{}),
  };
}
