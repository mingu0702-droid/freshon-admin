import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {prepareAdminBoundaries,pointInGeometry} from '../public/opsmap/admin-boundaries.mjs';
const bundled=fileURLToPath(new URL('../integrations/official-boundaries/sgis-adm-20250630-nationwide/',import.meta.url));
const manifestHash='36e2325be7867461450314b0f3071e11f3e67dce556879b5d5846fa7649a6e2a';
const overviewBundled=fileURLToPath(new URL('../integrations/official-boundaries/sgis-adm-20250630-overview/',import.meta.url));
const overviewHash='2193450655b521a1c0315ab1330e5910f9aa4069aad3d81ddf176afc553b188d';
const unzip=promisify(gunzip);
const featuresMarker=Buffer.from(',"features":[');
const geometryMarker=Buffer.from(',"geometry":');
const multiPolygonMarker=Buffer.from('{"type":"MultiPolygon","coordinates":[');
const polygonSeparator=Buffer.from(']]],[[[');
const largeGeometryBytes=4*1024*1024;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const validPoint=p=>p&&Object.keys(p).every(k=>['lat','lng'].includes(k))&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&p.lat>=33&&p.lat<=39.5&&p.lng>=124&&p.lng<=132;
function* polygonParts(raw,start,end){
 const limit=end-2;
 if(raw[limit]!==93||raw[limit+1]!==125)throw Error('ADMIN_BOUNDARIES_INVALID');
 for(let offset=start+multiPolygonMarker.length;offset<limit;){
  const separator=raw.indexOf(polygonSeparator,offset),stop=separator>=0&&separator<limit?separator+3:limit;
  yield JSON.parse(raw.toString('latin1',offset,stop));
  offset=stop+1;
 }
}
export function validateBoundaryQuery(body){
 if(!body||Object.keys(body).some(k=>!['points','geometry','detail'].includes(k))||body.geometry!==undefined&&typeof body.geometry!=='boolean'||body.detail!==undefined&&!['detail','overview'].includes(body.detail)||!Array.isArray(body.points)||body.points.length>15000||!body.points.every(validPoint)||Buffer.byteLength(JSON.stringify(body))>1024*1024)throw Object.assign(Error('ADMIN_BOUNDARIES_QUERY_INVALID'),{status:400});
 return body.points;
}
// The manifest alone is indexed at first query. Only counties touching requested points are decoded.
export function createOfficialAdminBoundaryQuery({directory=bundled,overviewDirectory=overviewBundled,readFile=fs.readFile,expectedManifestHash=manifestHash,expectedOverviewHash=overviewHash,maxCacheBytes=1024*1024,maxGeometryBytes=16*1024*1024}={}){
 let pending,overviewPending,tail=Promise.resolve(),queued=0;const cache=new Map(),pointMatches=new Map();let cacheBytes=0;
 async function loadIndex(){
  if(!pending)pending=(async()=>{
   const bytes=await readFile(path.join(directory,'manifest.json'));
   if(bytes.length>2*1024*1024||hash(bytes)!==expectedManifestHash)throw Error('ADMIN_BOUNDARIES_INVALID');
   const manifest=JSON.parse(bytes.toString('utf8'));
   const {metadata:m,entries,shards,verification:v}=manifest;
   prepareAdminBoundaries({type:'FeatureCollection',metadata:{...m,coverage:'QUERY'},features:[]});
   if(manifest.schema!=='SGIS_ADMIN_SHARDS_V1'||m.coverage!=='NATIONWIDE'||m.partialCoverage!==false||!v?.allSourceRecordsConverted||!v.originalRingTopologyRetained||manifest.featureCount!==entries?.length||v.dbfRecords!==entries.length||v.shpRecords!==entries.length||v.shxRecords!==entries.length||new Set(entries.map(e=>e.code)).size!==entries.length)throw Error('ADMIN_BOUNDARIES_INVALID');
   const files=new Map(shards.map(s=>[s.file,{...s,entries:[]}]));
   if(shards.reduce((n,s)=>n+s.featureCount,0)!==entries.length||!['shp','shx','dbf','prj','cpg'].every(ext=>manifest.sourceFiles.some(f=>f.name.endsWith('.'+ext)&&/^[a-f0-9]{64}$/.test(f.sha256))))throw Error('ADMIN_BOUNDARIES_INVALID');
   const cells=new Map();
   for(const e of entries){
    if(!/^\d{8}$/.test(e.code)||!/^\d{5}(?:-\d{2})?\.geojson\.gz$/.test(e.shard)||e.shard.slice(0,5)!==e.code.slice(0,5)||!files.has(e.shard)||!Array.isArray(e.bbox)||e.bbox.length!==4||!e.bbox.every(Number.isFinite)||e.bbox[0]<124||e.bbox[1]<33||e.bbox[2]>132||e.bbox[3]>39.5||e.bbox[0]>e.bbox[2]||e.bbox[1]>e.bbox[3])throw Error('ADMIN_BOUNDARIES_INVALID');
    files.get(e.shard).entries.push(e);
    for(let x=Math.floor(e.bbox[0]*10);x<=Math.floor(e.bbox[2]*10);x++)for(let y=Math.floor(e.bbox[1]*10);y<=Math.floor(e.bbox[3]*10);y++){const key=x+':'+y;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(e);}
   }
   return {manifest,files,cells,directory,role:'detail'};
  })().catch(error=>{pending=null;throw error;});
  return pending;
 }
 async function loadOverview(index){
  if(!overviewPending)overviewPending=(async()=>{
   const bytes=await readFile(path.join(overviewDirectory,'manifest.json'));
   if(bytes.length>2*1024*1024||hash(bytes)!==expectedOverviewHash)throw Error('ADMIN_BOUNDARIES_INVALID');
   const manifest=JSON.parse(bytes.toString('utf8')),v=manifest.verification;
   if(manifest.schema!=='SGIS_ADMIN_RENDER_SHARDS_V1'||manifest.sourceManifestSha256!==expectedManifestHash||manifest.metadata.geometryRole!=='DISPLAY_ONLY'||manifest.metadata.displayDetail!=='overview'||manifest.toleranceMeters!==75||manifest.featureCount!==index.manifest.featureCount||manifest.entries.length!==index.manifest.entries.length||!v.allFeaturePolygonAndHoleCountsPreserved||!v.noIntroducedTriangleRings||v.polygonCount!==index.manifest.verification.polygonCount||v.holeCount!==index.manifest.verification.holeCount)throw Error('ADMIN_BOUNDARIES_INVALID');
   const originals=new Map(index.manifest.entries.map(e=>[e.code,e]));
   if(manifest.entries.some(e=>!originals.has(e.code)||e.shard!==originals.get(e.code).shard)||new Set(manifest.entries.map(e=>e.code)).size!==manifest.featureCount||manifest.shards.reduce((n,s)=>n+s.featureCount,0)!==manifest.featureCount)throw Error('ADMIN_BOUNDARIES_INVALID');
   const files=new Map(manifest.shards.map(s=>[s.file,{...s,entries:[]}]));
   for(const entry of manifest.entries)files.get(entry.shard).entries.push(entry);
   return {manifest,files,directory:overviewDirectory,role:'overview'};
  })().catch(error=>{overviewPending=null;throw error;});
  return overviewPending;
 }
 async function loadFeatures(file,index,codes,onLargePolygon){
  const features=new Map(),missing=new Set();
  for(const code of codes){
   const key=index.role+':'+code,hit=cache.get(key);
   if(!hit){missing.add(code);continue;}
   cache.delete(key);cache.set(key,hit);features.set(code,hit.feature);
  }
  if(!missing.size)return features;
  const proof=index.files.get(file),bytes=await readFile(path.join(index.directory,file));
  if(bytes.length!==proof.gzipBytes||bytes.length>16*1024*1024||hash(bytes)!==proof.sha256)throw Error('ADMIN_BOUNDARIES_INVALID');
  const raw=await unzip(bytes,{maxOutputLength:proof.jsonBytes});
  const headerEnd=raw.indexOf(featuresMarker);
  if(raw.length!==proof.jsonBytes||headerEnd<0||proof.entries.length!==proof.featureCount)throw Error('ADMIN_BOUNDARIES_INVALID');
  const header=JSON.parse(raw.toString('utf8',0,headerEnd)+'}');
  const decoded=[];
  let decodedCount=0;
  let start=headerEnd+featuresMarker.length;
  // The pinned manifests record each compact UTF-8 feature's length in shard order.
  for(const entry of proof.entries){
   const end=start+entry.jsonBytes;
   if(!Number.isSafeInteger(entry.jsonBytes)||entry.jsonBytes<=0||raw[start]!==123||raw[end-1]!==125||(raw[end]!==44&&raw[end]!==93))throw Error('ADMIN_BOUNDARIES_INVALID');
   if(missing.has(entry.code)){
    const geometryStart=raw.indexOf(geometryMarker,start);
    if(geometryStart<0||geometryStart>=end)throw Error('ADMIN_BOUNDARIES_INVALID');
    // The geometry is ASCII. Decode Korean names separately to avoid a large UTF-16 geometry string.
    const feature=JSON.parse(raw.toString('utf8',start,geometryStart)+'}');
    if(feature.properties?.adm_cd!==entry.code)throw Error('ADMIN_BOUNDARIES_INVALID');
    const coordinatesStart=geometryStart+geometryMarker.length;
    if(entry.jsonBytes>largeGeometryBytes&&raw.subarray(coordinatesStart,coordinatesStart+multiPolygonMarker.length).equals(multiPolygonMarker)){
     // Decode complex coastal features one island at a time. Join-only callers need no full feature.
     const parts=polygonParts(raw,coordinatesStart,end-1);
     if(onLargePolygon){
      for(const coordinates of parts){
       const polygon={...feature,geometry:{type:'Polygon',coordinates}};
       const [prepared]=prepareAdminBoundaries({...header,features:[polygon]}).features;
       onLargePolygon(entry.code,prepared);
      }
     }else{
      feature.geometry={type:'MultiPolygon',coordinates:[...parts]};
      decoded.push({feature,entry});
     }
    }else{
     feature.geometry=JSON.parse(raw.toString('latin1',coordinatesStart,end-1));
     decoded.push({feature,entry});
    }
    decodedCount++;
   }
   start=end+1;
  }
  if(start!==raw.length-1||raw[start-1]!==93||raw[start]!==125||decodedCount!==missing.size||header.metadata?.coverage!=='REGIONAL'||(index.role==='overview'&&header.metadata.geometryRole!=='DISPLAY_ONLY'))throw Error('ADMIN_BOUNDARIES_INVALID');
  if(decoded.length)prepareAdminBoundaries({...header,features:decoded.map(({feature})=>feature)});
  for(const {entry,feature} of decoded){
   features.set(entry.code,feature);
   if(entry.jsonBytes>maxCacheBytes)continue;
   while(cache.size&&cacheBytes+entry.jsonBytes>maxCacheBytes){const old=cache.keys().next().value;cacheBytes-=cache.get(old).bytes;cache.delete(old);}
   cache.set(index.role+':'+entry.code,{feature,bytes:entry.jsonBytes});cacheBytes+=entry.jsonBytes;
  }
  return features;
 }
 async function query(points,{geometry=true,detail='detail'}={}){
  validateBoundaryQuery({points});const index=await loadIndex(),byShard=new Map(),matches=new Set(),selected=new Map();
  const joins=points.map((p,index)=>({index,adminCodes:pointMatches.get(p.lat+','+p.lng)?.slice()||[]})),uncached=[];
  for(let i=0;i<points.length;i++){
   if(pointMatches.has(points[i].lat+','+points[i].lng))continue;uncached.push(i);
   const p=points[i],candidates=index.cells.get(Math.floor(p.lng*10)+':'+Math.floor(p.lat*10))||[];
   for(const e of candidates){const b=e.bbox;if(p.lng<b[0]||p.lng>b[2]||p.lat<b[1]||p.lat>b[3])continue;if(!byShard.has(e.shard))byShard.set(e.shard,new Map());const codes=byShard.get(e.shard);if(!codes.has(e.code))codes.set(e.code,[]);codes.get(e.code).push(i);}
  }
  for(const [file,codes] of byShard){
   const largeMatches=new Map();
   const features=await loadFeatures(file,index,codes.keys(),(code,{feature,bbox})=>{
    if(!largeMatches.has(code))largeMatches.set(code,new Set());
    const matched=largeMatches.get(code);
    for(const i of codes.get(code)){
     const p=points[i];
     if(!matched.has(i)&&p.lng>=bbox[0]&&p.lng<=bbox[2]&&p.lat>=bbox[1]&&p.lat<=bbox[3]&&pointInGeometry([p.lng,p.lat],feature.geometry))matched.add(i);
    }
   });
   for(const [code,indices] of codes){
    const feature=features.get(code),matched=largeMatches.get(code);
    if(!feature&&!matched)throw Error('ADMIN_BOUNDARIES_INVALID');
    for(const i of indices){
     const p=points[i];
     if(matched?matched.has(i):pointInGeometry([p.lng,p.lat],feature.geometry))joins[i].adminCodes.push(code);
    }
   }
  }
  for(const i of uncached){const p=points[i];while(pointMatches.size>=15000)pointMatches.delete(pointMatches.keys().next().value);pointMatches.set(p.lat+','+p.lng,joins[i].adminCodes.slice());}
  for(const join of joins)if(join.adminCodes.length)matches.add(join.index);
  const renderIndex=geometry&&detail==='overview'?await loadOverview(index):index;
  if(geometry){
   const entries=new Map(renderIndex.manifest.entries.map(e=>[e.code,e])),files=new Map();let selectedBytes=0;
   for(const code of new Set(joins.flatMap(j=>j.adminCodes))){const entry=entries.get(code);if(!entry)throw Error('ADMIN_BOUNDARIES_INVALID');selectedBytes+=entry.jsonBytes;if(!Number.isSafeInteger(selectedBytes)||selectedBytes>maxGeometryBytes)throw Object.assign(Error('ADMIN_BOUNDARIES_QUERY_TOO_WIDE'),{status:413});if(!files.has(entry.shard))files.set(entry.shard,[]);files.get(entry.shard).push(code);}
   for(const [file,codes] of files){const features=await loadFeatures(file,renderIndex,codes);for(const code of codes){if(!features.has(code))throw Error('ADMIN_BOUNDARIES_INVALID');selected.set(code,features.get(code));}}
  }
  return {type:'FeatureCollection',metadata:{...renderIndex.manifest.metadata,coverage:'QUERY',sourceCoverage:'NATIONWIDE',partialCoverage:false,sourceFeatureCount:index.manifest.featureCount,queryPointCount:points.length,matchedPointCount:matches.size,unmatchedPointCount:points.length-matches.size,geometryIncluded:geometry,displayDetail:geometry?detail:null,pointJoinGeometry:'FULL_RESOLUTION'},matches:joins,...(geometry&&detail==='overview'?{queryPoints:points}:{}),features:[...selected.values()].sort((a,b)=>a.properties.adm_cd.localeCompare(b.properties.adm_cd))};
 }
 return (points,options={})=>{
  validateBoundaryQuery({points,...options});
  if(queued>=3)return Promise.reject(Object.assign(Error('ADMIN_BOUNDARIES_BUSY'),{status:503}));
  queued++;const result=tail.then(()=>query(points,options));tail=result.catch(()=>{}).finally(()=>{queued--;});return result;
 };
}
