// Reuses the existing saved projection and review boot; no source fetch or publisher.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {staffStoreDetail} from './mapStaffDetail.js';
import {applyVerifiedCoordinateOverlay} from '../public/verified-coordinate-overlay.mjs';
const ORIGIN='https://freshon-admin-stage-preview-template.onrender.com';
const INPUT_SHA='5c61b55560c1774ad68f45b258e990816527c7fee1acaedb01b22cf53b5b6b2b';
const digest=v=>createHash('sha256').update(v).digest('hex');
const CARRIER_PREFIX=Buffer.from('OPSMAP_GZIP_BASE64_V1\n','ascii');
export function decodeStageReviewInput(stored) {
  const bytes=Buffer.isBuffer(stored)?stored:Buffer.from(stored);
  if(bytes.length>1048576)throw Error('REVIEW_INPUT_LIMIT');
  if(!bytes.subarray(0,CARRIER_PREFIX.length).equals(CARRIER_PREFIX))return bytes;
  if(bytes.length>512000)throw Error('REVIEW_INPUT_CARRIER_LIMIT');
  const encoded=bytes.subarray(CARRIER_PREFIX.length).toString('utf8');
  if(!encoded||encoded.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw Error('REVIEW_INPUT_BASE64');
  const compressed=Buffer.from(encoded,'base64');
  if(compressed.toString('base64')!==encoded)throw Error('REVIEW_INPUT_BASE64');
  try{return gunzipSync(compressed,{maxOutputLength:1048576});}
  catch{throw Error('REVIEW_INPUT_COMPRESSION');}
}
// The existing selected-customer PRIVATE route may consume an approved stored-day
// companion. Addresses never enter the public projection or the browser cache.
export function createStagePrivateCustomerDetails({env=process.env,appRoot,readFile=fs.readFileSync,stat=fs.statSync}={}) {
  const file=env.OPSMAP_STAGE_CUSTOMER_DETAIL_FILE,pin=env.OPSMAP_STAGE_CUSTOMER_DETAIL_SHA256;
  if(!file)return {enabled:false,mount(){}};
  if(env.OPSMAP_STAGE_VERIFY_ONLY!=='1'||env.RENDER_EXTERNAL_URL!==ORIGIN||!appRoot||!path.isAbsolute(file)||!/^[a-f0-9]{64}$/.test(pin||''))throw Error('PRIVATE_CUSTOMER_CONFIG');
  const relative=path.relative(path.resolve(appRoot),path.resolve(file));
  if(relative===''||(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)))throw Error('PRIVATE_CUSTOMER_OUTSIDE_IMAGE_REQUIRED');
  const size=stat(file).size;
  if(!Number.isSafeInteger(size)||size<1||size>1048576)throw Error('PRIVATE_CUSTOMER_LIMIT');
  const stored=readFile(file);if(stored.length!==size)throw Error('PRIVATE_CUSTOMER_FILE_CHANGED');
  const raw=decodeStageReviewInput(stored);if(digest(raw)!==pin)throw Error('PRIVATE_CUSTOMER_PIN');
  const value=JSON.parse(raw),m=value.meta||{},date=m.date;
  if(value.schema!=='opsmap-private-customer-detail-v1'||m.sourceSheet!=='daily_routes'||m.sourceFileId!=='1yXE6cq2OCz28TOHJwzF1Lr7Y7gLzsxUbzBBhclTsaHk'
    ||m.sourceState!=='SOURCE_CONSISTENT_OBSERVATION'||!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date
    ||!/^\d{1,30}$/.test(m.versionBefore||'')||m.versionBefore!==m.versionAfter||!Number.isFinite(Date.parse(m.checkedAt))||Date.parse(m.checkedAt)>Date.now()+300000
    ||m.published!==false||m.businessCoverageVerified!==false||!Array.isArray(value.data)||value.data.length<1||value.data.length>15000)throw Error('PRIVATE_CUSTOMER_CONTRACT');
  const withheld=new Set();
  if(m.withheldDetailCodes!==undefined){if(!Array.isArray(m.withheldDetailCodes)||m.withheldDetailCodes.length>value.data.length||m.withheldDetailCodes.some(code=>!/^[A-Z]\d+$/.test(code)||withheld.has(code)||(withheld.add(code),false)))throw Error('PRIVATE_CUSTOMER_WITHHELD_CONTRACT');}
  const index=new Map(),allowed=new Set(['customerCode','customerName','customerAddress','detailAddress','deliveryPattern']);
  for(const row of value.data){
    if(!row||Object.keys(row).some(k=>!allowed.has(k))||!/^[A-Z]\d+$/.test(row.customerCode||'')||index.has(row.customerCode))throw Error('PRIVATE_CUSTOMER_ROW');
    const detail=staffStoreDetail(row,{customerCode:row.customerCode,date});
    if(withheld.has(row.customerCode)){if(detail.detailAddress!==null)throw Error('PRIVATE_CUSTOMER_WITHHELD_VALUE');detail.detailAddressState='WITHHELD';}
    for(const [field,projected] of [['customerName','customerName'],['customerAddress','address'],['detailAddress','detailAddress']]){
      if(row[field]!=null&&row[field]!==''&&detail[projected]!==String(row[field]).trim())throw Error('PRIVATE_CUSTOMER_UNSAFE_FIELD');
    }
    index.set(row.customerCode,Object.freeze({...detail,source:'Customer daily_routes stored-day private read',sourceBasis:'STORED_DAY',sourceDate:date,sourceDriveVersion:m.versionAfter}));
  }
  return {enabled:true,date,sourceVersion:m.versionAfter,rows:index.size,hash:pin,mount({app,requireStaff}){
    if(typeof requireStaff!=='function')throw Error('EXISTING_STAFF_AUTH_REQUIRED');
    app.get('/api/map-phase2b/private/customer-search',requireStaff,(q,r)=>{
      // Keep staff-entered location text out of URL/query logs and all responses.
      const encoded=q.get('x-map-customer-query');let query;
      try{if(typeof encoded!=='string'||encoded.length>1536)throw Error();query=decodeURIComponent(encoded).normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();}
      catch{return r.status(400).set('Cache-Control','private, no-store').json({ok:false,error:'CUSTOMER_SEARCH_QUERY'});}
      if(query.length<2||query.length>120||/[\u0000-\u001f\u007f]/u.test(query))return r.status(400).set('Cache-Control','private, no-store').json({ok:false,error:'CUSTOMER_SEARCH_QUERY'});
      const found=[];let total=0;
      for(const detail of index.values()){
        if(![detail.customerCode,detail.customerName,detail.address].some(v=>String(v||'').normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').includes(query)))continue;
        total++;if(found.length<20)found.push({customerCode:detail.customerCode,customerName:detail.customerName});
      }
      return requireStaff(q,r,()=>r.set('Cache-Control','private, no-store').json({ok:true,data:found,meta:{date,sourceVersion:m.versionAfter,sourceBasis:'STORED_DAY',truncated:total>20},error:null}));
    });
    app.get('/api/map-phase2b/private/customer-detail',requireStaff,(q,r,next)=>{
      if(q.query.view!=='store'||q.query.date!==date)return next();
      const detail=index.get(String(q.query.customerCode||'').trim().toUpperCase());if(!detail)return next();
      return requireStaff(q,r,()=>r.set('Cache-Control','private, no-store').json({ok:true,data:detail,error:null}));
    });
  }};
}
export function createStageSavedReview({env=process.env,publicDir,appRoot=path.resolve(publicDir,'..'),readFile=fs.readFileSync,stat=fs.statSync}={}) {
  const selectedCustomerSource=createStagePrivateCustomerDetails({env,appRoot,readFile,stat});
  if(!env.OPSMAP_STAGE_SAVED_REVIEW_FILE)return {enabled:false,reason:'PRIVATE_INPUT_NOT_CONFIGURED',mount:binding=>selectedCustomerSource.mount(binding)};
  if(env.OPSMAP_STAGE_VERIFY_ONLY!=='1'||env.RENDER_EXTERNAL_URL!==ORIGIN)throw Error('EXACT_STAGE_REVIEW_REQUIRED');
  const file=env.OPSMAP_STAGE_SAVED_REVIEW_FILE;
  if(!path.isAbsolute(file)||path.resolve(file).startsWith(path.resolve(appRoot)+path.sep))throw Error('REVIEW_INPUT_OUTSIDE_IMAGE_REQUIRED');
  if(stat(file).size>1048576)throw Error('REVIEW_INPUT_LIMIT');
  const raw=decodeStageReviewInput(readFile(file));if(raw.length!==675467||digest(raw)!==INPUT_SHA)throw Error('REVIEW_INPUT_PIN');
  const input=JSON.parse(raw),data=input.data;
  if(input.meta?.date!=='2026-10-23'||input.meta.published!==false||input.meta.businessCoverageVerified!==false||!Array.isArray(data)||data.length!==2036
    ||data.some(r=>!Array.isArray(r)||r.length!==10||r[2]!==''||r[8]!==null)
    ||data.reduce((n,r)=>n+r[9].reduce((s,h)=>s+h[2],0),0)!==2038
    ||data.filter(r=>Number.isFinite(r[3])&&Number.isFinite(r[4])).length!==1839)throw Error('REVIEW_INPUT_CONTRACT');
  const coordinateHash=digest(JSON.stringify(data)),namespace='opsmap-isolated-stage-20261023-'+INPUT_SHA.slice(0,12);
  let envelope={data,meta:{date:'2026-10-23',sourceVersion:String(input.meta.sourceVersion),sourceCandidateHash:input.meta.sourceCandidateHash,sourceDriveVersion:String(input.meta.sourceDriveVersion),published:false,productionEligible:false,businessCoverageVerified:false,coverageComplete:false,reviewOnly:true,cacheNamespace:namespace,localManifestHash:INPUT_SHA,currentCoordinateEvidenceHash:INPUT_SHA,coordinateDataHash:coordinateHash}};
  const cfg={date:'2026-10-23',startDate:'2026-07-27',endDate:'2026-10-24',historyStartDate:'2026-07-26',offset:89,rows:2036,visits:2038,inputHash:INPUT_SHA,cacheNamespace:namespace,currentStoredReview:true,fixedMasterVerified:false,sourceRows:2036,currentCoordinateEvidenceHash:INPUT_SHA,coordinateDataHash:coordinateHash,recent90Evidence:{completeDays:0,storedDays:54,emptyUnconfirmedDays:11,dateOnlyDays:1,unobservedDays:24}};
  cfg.privateCustomerSearch=selectedCustomerSource.enabled;
  let ready=Promise.resolve(),overlayFailure=null;
  if(env.OPSMAP_STAGE_COORDINATE_OVERLAY_FILE){
    const f=env.OPSMAP_STAGE_COORDINATE_OVERLAY_FILE,pin=env.OPSMAP_STAGE_COORDINATE_OVERLAY_SHA256;
    const relative=path.relative(path.resolve(appRoot),path.resolve(f));
    if(!path.isAbsolute(f)||relative===''||(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))||!/^[a-f0-9]{64}$/.test(pin||''))throw Error('REVIEW_OVERLAY_CONFIG');
    const size=stat(f).size;if(!Number.isSafeInteger(size)||size<1||size>131072)throw Error('REVIEW_OVERLAY_LIMIT');
    const stored=readFile(f);if(stored.length!==size||digest(stored)!==pin)throw Error('REVIEW_OVERLAY_PIN');
    const overlay=JSON.parse(stored);
    if(!selectedCustomerSource.enabled||overlay.verification?.sourceVersion!==selectedCustomerSource.sourceVersion)throw Error('REVIEW_OVERLAY_CUSTOMER_VERSION');
    ready=applyVerifiedCoordinateOverlay(envelope,overlay,{expectedOverlayHash:overlay.hash,expectedSourceVersion:selectedCustomerSource.sourceVersion}).then(value=>{
      const nextNamespace=namespace+'-building-'+overlay.hash.slice(0,12),nextHash=digest(JSON.stringify(value.data));
      envelope={...value,meta:{...value.meta,cacheNamespace:nextNamespace,coordinateDataHash:nextHash,buildingCoordinateCodes:overlay.rows.map(p=>p.customerCode)}};
      Object.assign(cfg,{cacheNamespace:nextNamespace,coordinateDataHash:nextHash,buildingCoordinateOverlayHash:overlay.hash,buildingCoordinateSourceVersion:selectedCustomerSource.sourceVersion});
    }).catch(()=>{overlayFailure='REVIEW_OVERLAY_VALIDATION_FAILED';});
  }
  const boot=readFile(path.join(publicDir,'stage-saved-review-boot.js'),'utf8');
  return {enabled:true,ready,date:cfg.date,rows:2036,visits:2038,get coordinates(){return envelope.meta.coordinatePresentCount||1839;},inputSha256:INPUT_SHA,mount({app,requireStaff}){
    if(typeof requireStaff!=='function')throw Error('EXISTING_STAFF_AUTH_REQUIRED');
    selectedCustomerSource.mount({app,requireStaff});
    // mapStaffEntryGate also guards both existing /api/map-phase2b paths.
    app.get('/api/map-phase2b/preview/saved-review/data',requireStaff,async(q,r)=>{await ready;if(overlayFailure)return r.status(503).set('Cache-Control','no-store').json({ok:false,error:overlayFailure});return requireStaff(q,r,()=>r.set('Cache-Control','private, no-store').json(envelope));});
    app.get('/api/map-phase2b/preview/saved-review/boot.js',requireStaff,async(q,r)=>{await ready;if(overlayFailure)return r.status(503).set('Cache-Control','no-store').json({ok:false,error:overlayFailure});return requireStaff(q,r,()=>r.set('Cache-Control','private, no-store').type('js').send('window.LOCAL_REVIEW_CONFIG='+JSON.stringify(cfg)+';\n'+boot));});
    app.get(['/', '/map-phase2b-preview.html'],(_q,r)=>{
      let html=readFile(path.join(publicDir,'map-phase2b-preview.html'),'utf8');
      if(!html.includes('data-src="hybrid-map-ui-boot.js"'))throw Error('EXISTING_REVIEW_BOOT_SLOT_REQUIRED');
      html=html.replace('data-src="hybrid-map-ui-boot.js"','data-src="/api/map-phase2b/preview/saved-review/boot.js"');
      const banner='<div id="reviewBanner" role="status">10/23 저장자료 · 미게시 · 완전성 미확인<small>주소·보호정보 제외 · 기준호차 미확인</small></div>';
      html=html.replace(/<body([^>]*)>/,'<body$1>'+banner);
      return r.set('Cache-Control','no-store').type('html').send(html);
    });
  }};
}
