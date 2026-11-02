import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {prepareAdminBoundaries} from '../public/opsmap/admin-boundaries.mjs';
import express from 'express';
import compression from 'compression';
import {createOfficialAdminBoundaryQuery,validateBoundaryQuery} from './officialAdminBoundaryQuery.js';
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
export function mountOfficialAdminBoundaries({app,requireStaff,readBoundaries=createOfficialAdminBoundaryReader(),queryBoundaries=createOfficialAdminBoundaryQuery(),origin=process.env.OPSMAP_AUTH_ORIGIN}){
 app.post('/api/map-phase2b/private/admin-boundaries/query',requireStaff,(req,res,next)=>{
  res.set('Cache-Control','private, no-store');
  const supplied=req.get('origin'),site=req.get('sec-fetch-site');
  let expected;try{expected=origin?new URL(origin).origin:new URL(supplied).origin;if(!origin&&new URL(supplied).host!==req.get('host'))throw Error();}catch{return res.status(403).json({ok:false,error:'ORIGIN_REJECTED'});}
  if(supplied!==expected||site&&!['same-origin','none'].includes(site))return res.status(403).json({ok:false,error:'ORIGIN_REJECTED'});
  if(!req.is('application/json'))return res.status(415).json({ok:false,error:'ADMIN_BOUNDARIES_QUERY_INVALID'});
  if(Number(req.get('content-length'))>1024*1024)return res.status(413).json({ok:false,error:'ADMIN_BOUNDARIES_QUERY_TOO_LARGE'});
  next();
 },express.json({limit:'1mb'}),compression({threshold:1024}),async(req,res)=>{
  try{const points=validateBoundaryQuery(req.body),data=await queryBoundaries(points,{geometry:req.body.geometry!==false,detail:req.body.detail||'detail'});return requireStaff(req,res,()=>res.json({ok:true,data}));}
  catch(error){const status=[400,413].includes(error.status)?error.status:503;return res.status(status).json({ok:false,error:status===400?'ADMIN_BOUNDARIES_QUERY_INVALID':status===413?'ADMIN_BOUNDARIES_QUERY_TOO_WIDE':'ADMIN_BOUNDARIES_UNAVAILABLE'});}
 });
 app.get('/api/map-phase2b/private/admin-boundaries',requireStaff,async(req,res)=>{
  res.set('Cache-Control','private, no-store');
  try{const data=await readBoundaries();return requireStaff(req,res,()=>res.json({ok:true,data}));}
  catch{return res.status(503).json({ok:false,error:'ADMIN_BOUNDARIES_UNAVAILABLE'});}
 });
}
