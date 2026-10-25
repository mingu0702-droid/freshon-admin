// Reuses the existing saved projection and review boot; no source fetch or publisher.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const ORIGIN='https://freshon-admin-stage-preview-template.onrender.com';
const INPUT_SHA='5c61b55560c1774ad68f45b258e990816527c7fee1acaedb01b22cf53b5b6b2b';
const digest=v=>createHash('sha256').update(v).digest('hex');
export function createStageSavedReview({env=process.env,publicDir,appRoot=path.resolve(publicDir,'..'),readFile=fs.readFileSync,stat=fs.statSync}={}) {
  if(!env.OPSMAP_STAGE_SAVED_REVIEW_FILE)return {enabled:false,reason:'PRIVATE_INPUT_NOT_CONFIGURED',mount(){}};
  if(env.OPSMAP_STAGE_VERIFY_ONLY!=='1'||env.RENDER_EXTERNAL_URL!==ORIGIN)throw Error('EXACT_STAGE_REVIEW_REQUIRED');
  const file=env.OPSMAP_STAGE_SAVED_REVIEW_FILE;
  if(!path.isAbsolute(file)||path.resolve(file).startsWith(path.resolve(appRoot)+path.sep))throw Error('REVIEW_INPUT_OUTSIDE_IMAGE_REQUIRED');
  if(stat(file).size>1048576)throw Error('REVIEW_INPUT_LIMIT');
  const raw=readFile(file);if(digest(raw)!==INPUT_SHA)throw Error('REVIEW_INPUT_PIN');
  const input=JSON.parse(raw),data=input.data;
  if(input.meta?.date!=='2026-10-23'||input.meta.published!==false||input.meta.businessCoverageVerified!==false||!Array.isArray(data)||data.length!==2036
    ||data.some(r=>!Array.isArray(r)||r.length!==10||r[2]!==''||r[8]!==null)
    ||data.reduce((n,r)=>n+r[9].reduce((s,h)=>s+h[2],0),0)!==2038
    ||data.filter(r=>Number.isFinite(r[3])&&Number.isFinite(r[4])).length!==1839)throw Error('REVIEW_INPUT_CONTRACT');
  const coordinateHash=digest(JSON.stringify(data)),namespace='opsmap-isolated-stage-20261023-'+INPUT_SHA.slice(0,12);
  const envelope={data,meta:{date:'2026-10-23',sourceVersion:String(input.meta.sourceVersion),sourceDriveVersion:String(input.meta.sourceDriveVersion),published:false,productionEligible:false,businessCoverageVerified:false,coverageComplete:false,reviewOnly:true,cacheNamespace:namespace,localManifestHash:INPUT_SHA,currentCoordinateEvidenceHash:INPUT_SHA,coordinateDataHash:coordinateHash}};
  const cfg={date:'2026-10-23',startDate:'2026-07-27',endDate:'2026-10-24',historyStartDate:'2026-07-26',offset:89,rows:2036,visits:2038,inputHash:INPUT_SHA,cacheNamespace:namespace,currentStoredReview:true,fixedMasterVerified:false,sourceRows:2036,currentCoordinateEvidenceHash:INPUT_SHA,coordinateDataHash:coordinateHash,recent90Evidence:{completeDays:0,storedDays:54,emptyUnconfirmedDays:11,dateOnlyDays:1,unobservedDays:24}};
  const boot=readFile(path.join(publicDir,'stage-saved-review-boot.js'),'utf8');
  return {enabled:true,date:cfg.date,rows:2036,visits:2038,coordinates:1839,inputSha256:INPUT_SHA,mount({app,requireStaff}){
    if(typeof requireStaff!=='function')throw Error('EXISTING_STAFF_AUTH_REQUIRED');
    // mapStaffEntryGate also guards both existing /api/map-phase2b paths.
    app.get('/api/map-phase2b/preview/saved-review/data',requireStaff,(_q,r)=>r.set('Cache-Control','private, no-store').json(envelope));
    app.get('/api/map-phase2b/preview/saved-review/boot.js',requireStaff,(_q,r)=>r.set('Cache-Control','private, no-store').type('js').send('window.LOCAL_REVIEW_CONFIG='+JSON.stringify(cfg)+';\n'+boot));
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
