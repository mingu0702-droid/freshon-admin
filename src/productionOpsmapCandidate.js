import fsSync from 'node:fs';
import express from 'express';import path from 'node:path';import fs from 'node:fs/promises';
import {mountProductionMapApi} from './opsmap-abc/productionMapIntegration.js';
import {createProductionStaffSessionStore as createProductionSessionStore} from './opsmap-abc/staffSessionStore.js';
import {createProductionManualPinGithubStore} from './opsmap-abc/manualPinGithubStore.js';
import {createManualPinAuthorizer} from './opsmap-abc/manualPinAuthorization.js';
import {createManualMapPins} from './opsmap-abc/manualMapPins.js';
import {redactPublicData} from './publicDataSecurity.js';
import {staffStoreDetail} from './opsmap-abc/mapStaffDetail.js';
import {roadRouteEnabledSetting} from './opsmap-abc/roadRouteService.js';
function existingJavaScriptKey(publicDir){try{const f=path.join(publicDir,'daily-routes.html');if(fsSync.statSync(f).size>1048576)return '';const keys=[...new Set([...fsSync.readFileSync(f,'utf8').matchAll(/appkey=([a-f0-9]{32})/gi)].map(m=>m[1]))];return keys.length===1?keys[0]:'';}catch{return '';}}
export function resolveProductionCredentials(env){
 // Explicit opt-in reuses only this Production process credentials; never reads Stage configuration.
 const reuse=env.OPSMAP_PRODUCTION_REUSE_EXISTING_CREDENTIALS==='1';
 return {sessionSecret:env.OPSMAP_AUTH_SESSION_SECRET||(reuse?env.MAP_STAFF_SESSION_SECRET:undefined),authToken:env.OPSMAP_AUTH_STORE_TOKEN||(reuse?env.GITHUB_TOKEN:undefined),pinToken:env.OPSMAP_PIN_STORE_TOKEN||(reuse?env.GITHUB_TOKEN:undefined)};
}
export async function readProductionManualPinCustomer(readers,code){
 const snapshot=await readers.readPhase2bSnapshot();
 const row=snapshot?.rows?.find(r=>r.customerCode===code);
 if(row?.address)return row;
 // An older map Snapshot is not the Customer registry. Read only this selected customer.
 if(!readers.readManualPinCustomer)return null;
 const hub=await readers.readManualPinCustomer(code);
 return staffStoreDetail(hub?.data,{customerCode:code,date:null});
}
export function mountProductionOpsmapCandidate(app,{env=process.env,publicDir,sessionStore:isolatedTestStore,...readers}){
 const router=express.Router(),root=path.join(publicDir,'opsmap');app.get(['/','/index.html','/daily-routes.html'],(q,r,n)=>env.OPSMAP_PRODUCTION_CANDIDATE_ENABLED==='1'?r.redirect(302,'/opsmap/'):n());app.use('/opsmap',router);
 if(env.OPSMAP_PRODUCTION_CANDIDATE_ENABLED!=='1'){router.use((_q,r)=>r.status(503).json({error:'OPSMAP_DISABLED'}));return {enabled:false};}
 const credentials=resolveProductionCredentials(env);
 const authEnv={...env,KAKAO_MAP_JAVASCRIPT_KEY:env.KAKAO_MAP_JAVASCRIPT_KEY||existingJavaScriptKey(publicDir),MAP_STAFF_ID:env.OPSMAP_AUTH_ID||env.MAP_STAFF_ID,MAP_STAFF_PASSWORD_HASH:env.OPSMAP_AUTH_PASSWORD_HASH||env.MAP_STAFF_PASSWORD_HASH,MAP_STAFF_SESSION_SECRET:credentials.sessionSecret,MAP_STAFF_ORIGIN:env.OPSMAP_AUTH_ORIGIN,
  GITHUB_TOKEN:credentials.authToken,GITHUB_CACHE_REPO:env.OPSMAP_AUTH_STORE_REPO,OPSMAP_MANUAL_PIN_GITHUB_BRANCH:env.OPSMAP_AUTH_STORE_BRANCH,OPSMAP_PRODUCTION_SESSION_ENABLED:'1',OPSMAP_ROAD_ROUTE_ENABLED:roadRouteEnabledSetting(env),OPSMAP_PRIVATE_DETAIL_CACHE_ENABLED:'0',OPSMAP_PREPARED_DETAILS_ENABLED:'0',OPSMAP_APPROVED_PHOTO_VERIFY:'0',MAP_HYBRID_90DAY_ENABLED:'false'};
 let store;try{if(!authEnv.MAP_STAFF_ID||!authEnv.MAP_STAFF_PASSWORD_HASH||!authEnv.MAP_STAFF_SESSION_SECRET)throw Error();store=isolatedTestStore||createProductionSessionStore({env:authEnv});if(!store)throw Error();}catch{router.use((_q,r)=>r.status(503).json({error:'OPSMAP_AUTH_CONFIGURATION_REQUIRED'}));return {enabled:false};}
 router.use('/internal',(_q,r)=>r.status(404).end());
 let pinStore;try{if(env.OPSMAP_PIN_STORE_REPO&&credentials.pinToken)pinStore=createProductionManualPinGithubStore({repo:env.OPSMAP_PIN_STORE_REPO,token:credentials.pinToken,branch:env.OPSMAP_PIN_STORE_BRANCH});}catch{/* Remain closed; an invalid store never falls back to Stage. */}
 const pinEnv={...authEnv,OPSMAP_MANUAL_PIN_STORE_FILE:undefined,OPSMAP_MANUAL_PIN_WRITES:env.OPSMAP_PRODUCTION_PIN_WRITES==='1'?'1':'0',OPSMAP_MANUAL_PIN_DURABLE_CONFIRMED:pinStore?'1':'0',OPSMAP_MANUAL_PIN_WRITER_ID:env.OPSMAP_PIN_WRITER_ID,OPSMAP_MANUAL_PIN_WRITE_AUTHORIZATION:env.OPSMAP_PIN_WRITE_AUTHORIZATION,OPSMAP_MANUAL_PIN_WRITE_APPROVAL_ID:env.OPSMAP_PIN_WRITE_APPROVAL_ID};
 const manual=createManualMapPins({env:pinEnv,appRoot:path.resolve(publicDir,'..'),store:pinStore,backupStore:pinStore?.backupStore,authorizeWrite:createManualPinAuthorizer({env:pinEnv}),readCoordinate:code=>{const row=readers.getSnapshotMemory()?.rows?.find(r=>r.customerCode===code);return row?{latitude:row.lat,longitude:row.lng}:null;},readCustomer:code=>readProductionManualPinCustomer(readers,code)});
 const api=mountProductionMapApi(router,{...readers,publicDir:root,previewEnabled:()=>true,requireView:(_q,_r,n)=>n(),authOptions:{env:authEnv,sessionStore:store},hybridEnabled:()=>false,mountPrivateExtensions:binding=>{
  manual.mount(binding);
  router.get('/api/vehicle-driver-master',binding.requireStaff,async(q,r)=>{try{if(!readers.readDriverMaster)return r.status(503).json({error:'DRIVER_SOURCE_NOT_CONFIGURED'});const value=await readers.readDriverMaster(String(q.query.date||''));return binding.requireStaff(q,r,()=>r.json(redactPublicData(value)));}catch{return r.status(503).json({error:'DRIVER_SOURCE_UNAVAILABLE'});}});
  router.get('/api/map-phase2b/preview/search',binding.requireStaff,async(q,r)=>{const text=String(q.query.q||'').trim();if(!text||text.length>200)return r.status(400).json({error:'INVALID_QUERY'});try{const value=await (readers.readUnifiedSearch?readers.readUnifiedSearch(text):readers.callHub?.('unifiedSearch',{q:text,limit:20}));if(!value)return r.status(503).json({error:'SEARCH_SOURCE_NOT_CONFIGURED'});return binding.requireStaff(q,r,()=>r.json(redactPublicData(value)));}catch{return r.status(503).json({error:'SEARCH_SOURCE_UNAVAILABLE'});}});
  router.get('/api/map-phase2b/preview/today-status',binding.requireStaff,async(q,r)=>{const date=readers.normalizeDateValue(q.query.date)||readers.phase2bKstDate();try{const value=await readers.phase2bTodayStatus(date);const vehicle=String(q.query.vehicle||'').trim(),vehicles=vehicle?(value.vehicles||[]).filter(v=>String(v.vehicle)===vehicle):value.vehicles;return binding.requireStaff(q,r,()=>r.json({ok:true,data:redactPublicData({...value,vehicles}),error:null}));}catch{return r.status(503).json({error:'DELIVERY_STATUS_UNAVAILABLE'});}});

  const safeRows=rows=>(rows||[]).map(row=>{const clean=redactPublicData(row);for(const field of ['address','customerAddress','detailAddress','addressDetail'])delete clean[field];return clean;});
  router.get('/api/map-phase2b/preview/snapshot',binding.requireStaff,async(_q,r)=>{try{const snap=await readers.readPhase2bSnapshot();if(!snap)return r.status(503).json({error:'PHASE2B_SNAPSHOT_NOT_READY'});return binding.requireStaff(_q,r,()=>r.json({ok:true,data:safeRows(snap.rows),meta:readers.phase2bSnapshotMeta(snap),error:null}));}catch{return r.status(503).json({error:'PHASE2B_SNAPSHOT_UNAVAILABLE'});}});
  router.get('/api/map-phase2b/private/customer-search',binding.requireStaff,async(q,r)=>{let text;try{text=decodeURIComponent(q.get('x-map-customer-query')||'').normalize('NFKC').trim().toLowerCase();}catch{return r.status(400).json({error:'INVALID_QUERY'});}if(!text||text.length>200)return r.status(400).json({error:'INVALID_QUERY'});try{const snap=await readers.readPhase2bSnapshot();const rows=(snap?.rows||[]).filter(v=>[v.customerCode,v.customerName,v.address,v.customerAddress].some(t=>String(t||'').normalize('NFKC').toLowerCase().includes(text))).slice(0,100);return binding.requireStaff(q,r,()=>r.json({ok:true,data:safeRows(rows),meta:{source:'EXISTING_PRODUCTION_SNAPSHOT',currentness:'UNCONFIRMED'}}));}catch{return r.status(503).json({error:'CUSTOMER_LOOKUP_UNAVAILABLE'});}});
  router.get('/api/map-phase2b/preview/route-plan',binding.requireStaff,async(q,r)=>{const date=readers.normalizeDateValue(q.query.date),vehicle=String(q.query.vehicle||'');if(!date||!vehicle||vehicle.length>40)return r.status(400).json({error:'INVALID_ROUTE'});try{const payload=await (readers.readStoredRoute?readers.readStoredRoute(date,vehicle):readers.callHub?.('routePlan',{date,vehicle}));if(!payload)return r.status(503).json({error:'ROUTE_SOURCE_NOT_CONFIGURED'});return binding.requireStaff(q,r,()=>r.json(redactPublicData(payload)));}catch{return r.status(503).json({error:'ROUTE_SOURCE_UNAVAILABLE'});}});

  router.use('/api/map-phase2b/private/delivery-photos',binding.requireStaff,(_q,r)=>r.status(503).json({ok:false,error:'PHOTO_SOURCE_DISABLED'}));
  router.get('/admin-features.js',binding.requireStaff,(_q,r)=>r.type('js').set('Cache-Control','private,no-store').send('window.ADMIN_FEATURES=[];window.OPSMAP_OPTIONAL_FEATURE_STATUS={state:"DISABLED",reason:"NOT_CONFIGURED"};'));
  router.get('/vehicle-data.js',binding.requireStaff,async(_q,r)=>{try{const text=await fs.readFile(path.join(publicDir,'vehicle-data.js'),'utf8'),match=text.match(/^\s*window\.[A-Z_]+\s*=\s*([\s\S]*?);?\s*$/);if(!match)throw Error();r.type('js').set('Cache-Control','private,no-store').send('window.VEHICLE_AREA_DATA='+JSON.stringify(redactPublicData(JSON.parse(match[1])))+';');}catch{r.status(503).json({error:'REFERENCE_DATA_UNAVAILABLE'});}});
 }});
 router.use('/api',(_q,r)=>r.status(404).json({error:'OPSMAP_API_NOT_AVAILABLE'}));router.get('/',(_q,r)=>r.sendFile(path.join(root,'map-phase2b-preview.html')));router.use(express.static(root));router.use((_q,r)=>r.status(404).end());return {enabled:true,status:api.status};
}
