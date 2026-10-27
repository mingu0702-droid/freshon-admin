import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import crypto from'node:crypto';import{execFileSync}from'node:child_process';
import{gzipSync}from'node:zlib';
import{applyVerifiedCoordinateOverlay,coordinateDigest,buildingRecoveryProof}from'../public/verified-coordinate-overlay.mjs';
import{createStageSavedReview,decodeStageReviewInput}from'../src/stageSavedReview.js';
const fixtures=process.env.OPSMAP_RECOVERY_FIXTURE_DIR;
if(!fixtures||!['OPSMAP_TEST_BASIS_FILE','OPSMAP_TEST_EXPECTED_FILE','OPSMAP_TEST_DETAIL_FILE','OPSMAP_TEST_SAVED_REVIEW_FILE'].every(k=>process.env[k])){test('private coordinate recovery fixture is required for Stage integration checks',{skip:true},()=>{});}else{
const read=name=>JSON.parse(fs.readFileSync(fixtures+'/'+name)),sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const basis=JSON.parse(fs.readFileSync(process.env.OPSMAP_TEST_BASIS_FILE));
const recovery=read('RECOVERY_141.addressless.json');
const options={expectedOverlayHash:recovery.hash,expectedSourceVersion:'40603'};
async function repin(value){const {hash,...content}=value;value.hash=await coordinateDigest(content);return {...options,expectedOverlayHash:value.hash};}
test('actual Stage chain adds141 to1875; preserves every existing coordinate, vehicle, name and history tuple',async()=>{
 const result=await applyVerifiedCoordinateOverlay(basis,recovery,options),expected=JSON.parse(fs.readFileSync(process.env.OPSMAP_TEST_EXPECTED_FILE));
 assert.equal(await coordinateDigest(result.data),await coordinateDigest(expected.data));assert.equal(result.data.filter(r=>Number.isFinite(r[3])).length,2016);assert.equal(new Set(result.data.map(r=>r[0])).size,2036);
 for(let n=0;n<basis.data.length;n++)for(let c=0;c<10;c++)if(c!==3&&c!==4||Number.isFinite(basis.data[n][3]))assert.equal(JSON.stringify(result.data[n][c]),JSON.stringify(basis.data[n][c]));
});
test('different donor address cannot pass by rehashing the outer review file',async()=>{
 const changed=structuredClone(recovery),p=changed.rows.find(r=>r.coordinateSource==='HISTORICAL_GPS_SAME_BUILDING');p.receipt.donor.addressHash='0'.repeat(64);p.evidenceHash=await coordinateDigest(buildingRecoveryProof(p));await assert.rejects(applyVerifiedCoordinateOverlay(basis,changed,await repin(changed)),/RECOVERY_DONOR/);
});
test('BUILDING evidence cannot be promoted to GPS and duplicate customers are rejected',async()=>{
 const promoted=structuredClone(recovery);promoted.rows[0].accuracy='GPS';await assert.rejects(applyVerifiedCoordinateOverlay(basis,promoted,await repin(promoted)),/RECOVERY_SOURCE/);
 const duplicate=structuredClone(recovery);duplicate.rows[1]=structuredClone(duplicate.rows[0]);await assert.rejects(applyVerifiedCoordinateOverlay(basis,duplicate,await repin(duplicate)),/POINT_INVALID/);
});
test('coordinate mutation and a changed source window remain held',async()=>{
 const changed=structuredClone(recovery);changed.rows[0].lat+=0.001;await assert.rejects(applyVerifiedCoordinateOverlay(basis,changed,await repin(changed)),/RECOVERY_DONOR|EVIDENCE_HASH/);
 const version=structuredClone(recovery);version.verification.versionAfter='40604';await assert.rejects(applyVerifiedCoordinateOverlay(basis,version,await repin(version)),/SOURCE_WINDOW/);
});
test('existing valid point cannot be overwritten by a new recovery row',async()=>{
 const changed=structuredClone(recovery),p=changed.rows[0],old=basis.data.find(r=>Number.isFinite(r[3]));p.customerCode=old[0];p.customerNameHash=await coordinateDigest(old[1]);p.evidenceHash=await coordinateDigest(buildingRecoveryProof(p));await assert.rejects(applyVerifiedCoordinateOverlay(basis,changed,await repin(changed)),/EXISTING_IMMUTABLE/);
});
test('marker/color/filter/detail mechanics and mobile layout retain identical Git contents apart from accuracy text',()=>{
 const base='2775b835cc13ca59802da85e90e4aba2437b71f1',prior=execFileSync('git',['show',base+':public/map-phase2b-runtime.js'],{encoding:'utf8'}),current=fs.readFileSync('public/map-phase2b-runtime.js','utf8');
 const withoutAccuracy=s=>s.replaceAll('\r\n','\n').split('\n').filter(line=>!line.includes('coordinateEvidence')).join('\n');assert.equal(sha(withoutAccuracy(current)),sha(withoutAccuracy(prior)));
 for(const file of ['public/map-phase2b-preview.html','public/hybrid-map-contract.mjs','public/map-staff-entry.js'])assert.equal(execFileSync('git',['hash-object',file],{encoding:'utf8'}).trim(),execFileSync('git',['rev-parse',base+':'+file],{encoding:'utf8'}).trim());
});
test('optional142 bundle preserves the existing35 file and invalid legacy binding is never served',async()=>{
 const detail=process.env.OPSMAP_TEST_DETAIL_FILE;
 const env={OPSMAP_STAGE_VERIFY_ONLY:'1',RENDER_EXTERNAL_URL:'https://freshon-admin-stage-preview-template.onrender.com',
  OPSMAP_STAGE_SAVED_REVIEW_FILE:process.env.OPSMAP_TEST_SAVED_REVIEW_FILE,
  OPSMAP_STAGE_CUSTOMER_DETAIL_FILE:detail,OPSMAP_STAGE_CUSTOMER_DETAIL_SHA256:sha(decodeStageReviewInput(fs.readFileSync(detail))),
  OPSMAP_STAGE_COORDINATE_OVERLAY_FILE:fixtures+'/STAGE_BASIS_35.addressless.json',OPSMAP_STAGE_COORDINATE_OVERLAY_SHA256:sha(fs.readFileSync(fixtures+'/STAGE_BASIS_35.addressless.json'))};
 const config={env,publicDir:process.cwd()+'/public',appRoot:process.cwd()},oldFileHash=sha(fs.readFileSync(env.OPSMAP_STAGE_COORDINATE_OVERLAY_FILE));
 const old=createStageSavedReview(config);await old.ready;assert.equal(old.coordinates,1874);
 const f=fixtures+'/STAGE_RECOVERY_142.gzip-base64.txt',enabled={...env,OPSMAP_STAGE_COORDINATE_RECOVERY_FILE:f,OPSMAP_STAGE_COORDINATE_RECOVERY_SHA256:sha(fs.readFileSync(f)),OPSMAP_STAGE_COORDINATE_RECOVERY_SOURCE_VERSION:'40603'};
 const next=createStageSavedReview({...config,env:enabled});await next.ready;assert.equal(next.coordinates,2016);assert.equal(sha(fs.readFileSync(env.OPSMAP_STAGE_COORDINATE_OVERLAY_FILE)),oldFileHash);
 const bundle=JSON.parse(decodeStageReviewInput(fs.readFileSync(f)));bundle.legacyOverlayHash='0'.repeat(64);const bytes=Buffer.from('OPSMAP_GZIP_BASE64_V1\n'+gzipSync(Buffer.from(JSON.stringify(bundle))).toString('base64'));
 const bad=createStageSavedReview({...config,env:{...enabled,OPSMAP_STAGE_COORDINATE_RECOVERY_SHA256:sha(bytes)},readFile:(file,...args)=>file===f?bytes:fs.readFileSync(file,...args),stat:file=>file===f?{size:bytes.length}:fs.statSync(file)});await bad.ready;assert.equal(bad.coordinates,1874);
 const routes=[],res={code:200,status(n){this.code=n;return this;},set(){return this;},json(value){this.value=value;return this;}};
 bad.mount({app:{get:(paths,...handlers)=>routes.push({paths,handlers})},requireStaff:(_q,_r,next)=>next()});const route=routes.find(r=>r.paths==='/api/map-phase2b/preview/saved-review/data');await route.handlers.at(-1)({},res);assert.equal(res.code,503);assert.equal(res.value.error,'REVIEW_RECOVERY_VALIDATION_FAILED');
});
}
