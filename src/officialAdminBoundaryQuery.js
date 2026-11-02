import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {prepareAdminBoundaries,pointInGeometry} from '../public/opsmap/admin-boundaries.mjs';
const bundled=fileURLToPath(new URL('../integrations/official-boundaries/sgis-adm-20250630-nationwide/',import.meta.url));
const manifestHash='36e2325be7867461450314b0f3071e11f3e67dce556879b5d5846fa7649a6e2a';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const validPoint=p=>p&&Object.keys(p).every(k=>['lat','lng'].includes(k))&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&p.lat>=33&&p.lat<=39.5&&p.lng>=124&&p.lng<=132;
export function validateBoundaryQuery(body){
 if(!body||Object.keys(body).some(k=>!['points','geometry'].includes(k))||body.geometry!==undefined&&typeof body.geometry!=='boolean'||!Array.isArray(body.points)||body.points.length>15000||!body.points.every(validPoint)||Buffer.byteLength(JSON.stringify(body))>1024*1024)throw Object.assign(Error('ADMIN_BOUNDARIES_QUERY_INVALID'),{status:400});
 return body.points;
}
// The manifest alone is indexed at first query. Only counties touching requested points are decoded.
export function createOfficialAdminBoundaryQuery({directory=bundled,readFile=fs.readFile,expectedManifestHash=manifestHash,maxCacheBytes=8*1024*1024,maxGeometryBytes=16*1024*1024}={}){
 let pending,tail=Promise.resolve(),queued=0;const cache=new Map();let cacheBytes=0;
 async function loadIndex(){
  if(!pending)pending=(async()=>{
   const bytes=await readFile(path.join(directory,'manifest.json'));
   if(bytes.length>2*1024*1024||hash(bytes)!==expectedManifestHash)throw Error('ADMIN_BOUNDARIES_INVALID');
   const manifest=JSON.parse(bytes.toString('utf8'));
   const {metadata:m,entries,shards,verification:v}=manifest;
   prepareAdminBoundaries({type:'FeatureCollection',metadata:{...m,coverage:'QUERY'},features:[]});
   if(manifest.schema!=='SGIS_ADMIN_SHARDS_V1'||m.coverage!=='NATIONWIDE'||m.partialCoverage!==false||!v?.allSourceRecordsConverted||!v.originalRingTopologyRetained||manifest.featureCount!==entries?.length||v.dbfRecords!==entries.length||v.shpRecords!==entries.length||v.shxRecords!==entries.length||new Set(entries.map(e=>e.code)).size!==entries.length)throw Error('ADMIN_BOUNDARIES_INVALID');
   const files=new Map(shards.map(s=>[s.file,s]));
   if(shards.reduce((n,s)=>n+s.featureCount,0)!==entries.length||!['shp','shx','dbf','prj','cpg'].every(ext=>manifest.sourceFiles.some(f=>f.name.endsWith('.'+ext)&&/^[a-f0-9]{64}$/.test(f.sha256))))throw Error('ADMIN_BOUNDARIES_INVALID');
   const cells=new Map();
   for(const e of entries){
    if(!/^\d{8}$/.test(e.code)||!/^\d{5}(?:-\d{2})?\.geojson\.gz$/.test(e.shard)||e.shard.slice(0,5)!==e.code.slice(0,5)||!files.has(e.shard)||!Array.isArray(e.bbox)||e.bbox.length!==4||!e.bbox.every(Number.isFinite)||e.bbox[0]<124||e.bbox[1]<33||e.bbox[2]>132||e.bbox[3]>39.5||e.bbox[0]>e.bbox[2]||e.bbox[1]>e.bbox[3])throw Error('ADMIN_BOUNDARIES_INVALID');
    for(let x=Math.floor(e.bbox[0]*10);x<=Math.floor(e.bbox[2]*10);x++)for(let y=Math.floor(e.bbox[1]*10);y<=Math.floor(e.bbox[3]*10);y++){const key=x+':'+y;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(e);}
   }
   return {manifest,files,cells};
  })().catch(error=>{pending=null;throw error;});
  return pending;
 }
 async function loadShard(file,index){
  if(cache.has(file)){const hit=cache.get(file);cache.delete(file);cache.set(file,hit);return hit.features;}
  const proof=index.files.get(file),bytes=await readFile(path.join(directory,file));
  if(bytes.length!==proof.gzipBytes||bytes.length>16*1024*1024||hash(bytes)!==proof.sha256)throw Error('ADMIN_BOUNDARIES_INVALID');
  const raw=gunzipSync(bytes,{maxOutputLength:80*1024*1024});
  if(raw.length!==proof.jsonBytes)throw Error('ADMIN_BOUNDARIES_INVALID');
  const data=JSON.parse(raw.toString('utf8')),prepared=prepareAdminBoundaries(data);
  if(data.features.length!==proof.featureCount||data.metadata.coverage!=='REGIONAL'||data.features.some(f=>f.properties.adm_cd.slice(0,5)!==file.slice(0,5)))throw Error('ADMIN_BOUNDARIES_INVALID');
  const features=new Map(prepared.features.map(e=>[e.code,e.feature]));
  if(raw.length<=maxCacheBytes){while(cache.size&&cacheBytes+raw.length>maxCacheBytes){const old=cache.keys().next().value;cacheBytes-=cache.get(old).bytes;cache.delete(old);}cache.set(file,{features,bytes:raw.length});cacheBytes+=raw.length;}
  return features;
 }
 async function query(points,{geometry=true}={}){
  validateBoundaryQuery({points});const index=await loadIndex(),byShard=new Map(),matches=new Set(),selected=new Map();
  for(let i=0;i<points.length;i++){
   const p=points[i],candidates=index.cells.get(Math.floor(p.lng*10)+':'+Math.floor(p.lat*10))||[];
   for(const e of candidates){const b=e.bbox;if(p.lng<b[0]||p.lng>b[2]||p.lat<b[1]||p.lat>b[3])continue;if(!byShard.has(e.shard))byShard.set(e.shard,new Map());const codes=byShard.get(e.shard);if(!codes.has(e.code))codes.set(e.code,[]);codes.get(e.code).push(i);}
  }
  let selectedBytes=0;const joins=points.map((_,index)=>({index,adminCodes:[]})),sizes=new Map(index.manifest.entries.map(e=>[e.code,e.jsonBytes]));
  for(const [file,codes] of byShard){const features=await loadShard(file,index);for(const [code,indices] of codes){const feature=features.get(code);if(!feature)throw Error('ADMIN_BOUNDARIES_INVALID');for(const i of indices){const p=points[i];if(pointInGeometry([p.lng,p.lat],feature.geometry)){if(geometry&&!selected.has(code)){selectedBytes+=sizes.get(code);if(!Number.isSafeInteger(selectedBytes)||selectedBytes>maxGeometryBytes)throw Object.assign(Error('ADMIN_BOUNDARIES_QUERY_TOO_WIDE'),{status:413});selected.set(code,feature);}matches.add(i);joins[i].adminCodes.push(code);}}}}
  return {type:'FeatureCollection',metadata:{...index.manifest.metadata,coverage:'QUERY',sourceCoverage:'NATIONWIDE',partialCoverage:false,sourceFeatureCount:index.manifest.featureCount,queryPointCount:points.length,matchedPointCount:matches.size,unmatchedPointCount:points.length-matches.size,geometryIncluded:geometry},matches:joins,features:[...selected.values()].sort((a,b)=>a.properties.adm_cd.localeCompare(b.properties.adm_cd))};
 }
 return (points,options={})=>{
  validateBoundaryQuery({points,...options});
  if(queued>=3)return Promise.reject(Object.assign(Error('ADMIN_BOUNDARIES_BUSY'),{status:503}));
  queued++;const result=tail.then(()=>query(points,options));tail=result.catch(()=>{}).finally(()=>{queued--;});return result;
 };
}
