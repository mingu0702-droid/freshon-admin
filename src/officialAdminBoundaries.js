import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {prepareAdminBoundaries} from '../public/admin-boundaries.mjs';
const unzip=promisify(gunzip);
const bundled=fileURLToPath(new URL('../integrations/official-boundaries/sgis-adm-20250630-subset.geojson.gz',import.meta.url));
// Only a vetted official geometry subset is bundled. No nationwide startup load.
export function createOfficialAdminBoundaryReader({file=bundled,readFile=fs.readFile}={}){
 let pending;
 return async()=>{
  if(!pending)pending=(async()=>{
   const bytes=await readFile(file),proof=JSON.parse(await readFile(file+'.sourceproof.json','utf8'));
   if(bytes.length>8*1024*1024||crypto.createHash('sha256').update(bytes).digest('hex')!==proof.sha256)throw Error('ADMIN_BOUNDARIES_INVALID');
   const raw=path.extname(file)==='.gz'?await unzip(bytes,{maxOutputLength:64*1024*1024}):bytes;
   const data=JSON.parse(raw.toString('utf8'));prepareAdminBoundaries(data);
   if(data.metadata.coverage!=='SUBSET'||data.features.length!==proof.featureCount)throw Error('ADMIN_BOUNDARIES_INVALID');
   return data;
  })().catch(error=>{pending=null;throw error;});
  return pending;
 };
}
export function mountOfficialAdminBoundaries({app,requireStaff,readBoundaries=createOfficialAdminBoundaryReader()}){
 app.get('/api/map-phase2b/private/admin-boundaries',requireStaff,async(req,res)=>{
  res.set('Cache-Control','private, no-store');
  try{const data=await readBoundaries();return requireStaff(req,res,()=>res.json({ok:true,data}));}
  catch{return res.status(503).json({ok:false,error:'ADMIN_BOUNDARIES_UNAVAILABLE'});}
 });
}
