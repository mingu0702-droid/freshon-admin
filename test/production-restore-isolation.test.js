import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {createStageReadModel} from '../src/stageReadModel.js';
const worker=fs.readFileSync(new URL('../integrations/hub/HubStageReadModel.js',import.meta.url),'utf8');
const restore=fs.readFileSync(new URL('../integrations/hub/HubStageReadModelRestore.js',import.meta.url),'utf8');
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const endpoints={stage:'https://freshon-admin-stage-preview-template.onrender.com/internal/stage-read-model',production:'https://freshon-admin-1.onrender.com/internal/stage-read-model'};
const secrets={stage:'synthetic-stage-only-key-00000000000000',production:'synthetic-production-only-key-0000000000'};
const sourceFiles=new Map(),published={stateId:'published',folderId:'folder',generation:1789933588775,phase:'DONE',startDate:'2026-06-22',endDate:'2026-09-19',sendAt:156,scanned:579006,source:4,shards:{}};
// Synthetic full-size shape. No real customer, secret, checkpoint, or shard access.
for(const kind of ['history','period'])for(let day=0;day<78;day++){
 const date=new Date(Date.parse('2026-06-22')+day*86400000).toISOString().slice(0,10),key=kind+':'+date;
 const total=kind==='history'?120035:147689,n=Math.floor(total/78)+(day<total%78?1:0);
 const rows=Array.from({length:n},(_,i)=>kind==='history'?{deliveryDate:date,customerCode:'S'+(100000+i),deliveryId:'D'+i,vehicle:'101',driverName:'한글 합성',driverPhone:'SYNTHETIC',kind:'ASSIGNED',sourceVersion:'test',updatedAt:date}:{deliveryDate:date,customerCode:'S'+(100000+i),vehicle:'101',driverName:'한글 합성',driverKey:'driver',driverIdentity:'UNVERIFIED'});
 sourceFiles.set(key,JSON.stringify(rows));published.shards[key]={id:key,count:n,hash:hash(rows)};
}
sourceFiles.set('published',JSON.stringify(published));
function fixture(recovery=false){
 const files=new Map(sourceFiles),props=new Map([['PHASE2B_STAGE_READ_MODEL_V1','published'],['HUB_MAP_API_HMAC_SECRET',secrets.stage],['HUB_MODEL_PRODUCTION_HMAC_SECRET',secrets.production],['HUB_MODEL_STAGE_ENDPOINT',endpoints.stage],['HUB_MODEL_PRODUCTION_ENDPOINT',endpoints.production]]);
 const models={stage:createStageReadModel({secret:secrets.stage}),production:createStageReadModel({secret:secrets.production})},requests=[],writes=[];
 let triggers=['customerWatchdog'],failure=null,busy=false,staleOnce=false,staleAlways=false,stalePending=null;const audits=[];
 const file=id=>({getId:()=>id,getBlob:()=>({getDataAsString:()=>{assert(files.has(id));if(id==='restore-production'&&stalePending!==null){const value=stalePending;if(!staleAlways)stalePending=null;return value;}return files.get(id);}}),setContent(text){assert(['restore-stage','restore-production'].includes(id));if(id==='restore-production'&&(staleOnce||staleAlways)){stalePending=files.get(id);staleOnce=false;}files.set(id,text);writes.push(id);}});
 const ctx=vm.createContext({Date,console:{log(s){audits.push(JSON.parse(s));}},MimeType:{PLAIN_TEXT:'text/plain'},HUB_MAP_HTTP_API:{SECRET_PROPERTY:'HUB_MAP_API_HMAC_SECRET'},
  hubMapHttpValidateOnlyKeys_(params,keys){assert(Object.keys(params).every(k=>keys.includes(k)));},
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty(k,v){assert(['PHASE2B_STAGE_RESTORE_V1','PHASE2B_PRODUCTION_RESTORE_V1','PHASE2B_PRODUCTION_RESTORE_HALT_V2'].includes(k));props.set(k,v);}})},
  LockService:{getUserLock:()=>({tryLock:()=>!busy&&(busy=true),releaseLock(){busy=false;}}),getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
  DriveApp:{getFileById:file,getFolderById:()=>({createFile(name,text){const id=name==='restore-checkpoint.json'?'restore-stage':name==='restore-production-checkpoint.json'?'restore-production':recovery&&name.startsWith('production-restore-before-fresh-read-')?'fresh-backup':recovery&&name.startsWith('production-restore-before-recovery-checkpoint-')?'checkpoint-backup':recovery&&name.startsWith('production-restore-before-recovery-')?'backup':assert.fail('unexpected file');assert(!files.has(id));files.set(id,text);return file(id);}})},
  SpreadsheetApp:new Proxy({},{get(){throw Error('SOURCE_READ_FORBIDDEN');}}),
  ScriptApp:{getOAuthToken:()=> 'SYNTHETIC-OAUTH',getProjectTriggers:()=>triggers.map(n=>({getHandlerFunction:()=>n})),deleteTrigger(t){assert.notEqual(t.getHandlerFunction(),'customerWatchdog');triggers=triggers.filter(n=>n!==t.getHandlerFunction());},newTrigger(n){assert(['hubStageReadModelRestoreContinue','hubProductionReadModelRestoreContinue'].includes(n));return{timeBased(){return this;},after(){return this;},create(){triggers.push(n);}};}},
  Utilities:{sleep(ms){assert(ms<=1000);},Charset:{UTF_8:'UTF-8',US_ASCII:'US-ASCII'},DigestAlgorithm:{SHA_256:'SHA256'},getUuid:()=>crypto.randomUUID(),computeDigest(_a,t,c){assert.equal(c,'UTF-8');return [...crypto.createHash('sha256').update(t).digest()];},computeHmacSha256Signature(t,k,c){assert.equal(c,'UTF-8');return [...crypto.createHmac('sha256',k).update(t).digest()];}},
  UrlFetchApp:{fetch(url,o){if(url.startsWith('https://www.googleapis.com/drive/v3/files/restore-production?alt=media&recoveryRead=')){assert.equal(o.method,undefined);assert.equal(o.headers.Authorization,'Bearer SYNTHETIC-OAUTH');return{getResponseCode:()=>failure?.type==='checkpoint-read'?failure.http:200,getContentText:()=>failure?.type==='checkpoint-read'&&failure.body!==undefined?failure.body:files.get('restore-production')};}if(recovery&&url===endpoints.production.replace('/internal/stage-read-model','/api/map-phase2b/preview/period-status'))return{getResponseCode:()=>200,getContentText:()=>JSON.stringify(models.production.status())};const target=Object.keys(endpoints).find(k=>endpoints[k]===url);assert(target);const body=JSON.parse(o.payload),type=body.message.type;
   assert.equal(o.headers['x-stage-model-signature'],crypto.createHmac('sha256',secrets[target]).update(o.payload).digest('hex'));
   const status=failure?.target===target&&failure.type===type?(failure.http??200):200;
   if(status===200)models[target].ingest(body,o.headers['x-stage-model-signature']);requests.push({target,type,status});if(failure?.type===type&&failure.error)throw Error(failure.error);return{getResponseCode:()=>status,getContentText:()=>failure?.type===type&&failure.ack!==undefined?failure.ack:JSON.stringify({ok:true})};}}
 });vm.runInContext(worker+'\n'+restore+'\n'+fs.readFileSync(new URL('../integrations/hub/HubProductionRestoreRecovery.js',import.meta.url),'utf8'),ctx);
 return{ctx,files,props,models,requests,writes,audits,set staleOnce(v){staleOnce=v;},set staleAlways(v){staleAlways=v;},set failure(v){failure=v;},set busy(v){busy=v;},get triggers(){return triggers;},job:t=>JSON.parse(files.get('restore-'+t)),request:t=>ctx.hubStageModelRequest_({target:t}),run:t=>ctx.hubReadModelRestoreContinue_(t),unchanged(){for(const[k,v]of sourceFiles)assert.equal(files.get(k),v);}};
}
test('same published 156 shards restore independently, UTF-8 HMAC/hash and atomic commits pass',()=>{
 const f=fixture();f.request('stage');f.run('stage');const stage=f.files.get('restore-stage');assert.equal(f.models.stage.status().ready,true);
 f.request('production');f.run('production');assert.equal(f.files.get('restore-stage'),stage);
 for(const t of ['stage','production']){assert.equal(f.job(t).phase,'DONE');assert.equal(f.job(t).sendAt,156);assert.equal(f.job(t).commitHttp,200);assert.equal(f.models[t].status().generation,1789933588775);assert.equal(f.models[t].status().historyRows,120035);assert.equal(f.models[t].status().periodRows,147689);}
 f.unchanged();assert.deepEqual(f.triggers,['customerWatchdog']);
});
for(const target of ['stage','production'])for(const type of ['begin','shard','commit'])for(const http of [401,403])test(`${target} ${type} ${http}: peer DONE untouched, no retry or publish`,()=>{
 const f=fixture(),peer=target==='stage'?'production':'stage';f.request(peer);f.run(peer);const peerState=f.files.get('restore-'+peer),peerModel=f.models[peer].status();
 f.failure={target,type,http};f.request(target);f.run(target);const n=f.requests.length;f.request(target);f.run(target);
 assert.equal(f.requests.length,n);assert.equal(f.job(target).phase,'ERROR');assert.equal(f.job(target).lastError,'MODEL_STAGE_HTTP_'+http);assert.equal(f.files.get('restore-'+peer),peerState);assert.deepEqual(f.models[peer].status(),peerModel);assert.equal(f.models[target].status().ready,false);f.unchanged();
});
test('duplicate requests preserve target cursor and install at most one continuation per target',()=>{
 const f=fixture();f.request('stage');f.request('production');const r=f.job('production');r.sendAt=4;r.verified=4;f.files.set('restore-production',JSON.stringify(r));f.request('production');
 assert.equal(f.job('production').sendAt,4);assert.equal(f.job('stage').sendAt,0);assert.equal(f.triggers.length,3);f.unchanged();
});
test('target endpoint/secret missing or unknown target cannot fall back to Stage',()=>{
 for(const key of ['HUB_MODEL_PRODUCTION_ENDPOINT','HUB_MODEL_PRODUCTION_HMAC_SECRET']){const f=fixture();f.props.delete(key);assert.throws(()=>f.request('production'));assert.equal(f.writes.length,0);assert.equal(f.requests.length,0);f.unchanged();}
 const f=fixture();assert.throws(()=>f.request('typo'));assert.equal(f.writes.length,0);
});
test('aliased checkpoint pointers cannot overwrite peer state',()=>{
 const f=fixture();f.request('stage');const saved=f.files.get('restore-stage');f.props.set('PHASE2B_PRODUCTION_RESTORE_V1','restore-stage');const writes=f.writes.length;
 assert.throws(()=>f.request('production'),/TARGET_CONFLICT/);f.run('production');assert.equal(f.files.get('restore-stage'),saved);assert.equal(f.writes.length,writes);assert.equal(f.requests.length,0);
});
test('unpublished or changed approved generation causes zero writes and no BUILD',()=>{
 for(const patch of [{phase:'ERROR'},{generation:1789933588776}]){const f=fixture();f.files.set('published',JSON.stringify({...published,...patch}));assert.throws(()=>f.request('production'));assert.equal(f.writes.length,0);assert.equal(f.requests.length,0);}
});
test('busy worker cannot create or reset either target checkpoint',()=>{const f=fixture();f.busy=true;f.request('production');assert.equal(f.writes.length,0);assert.equal(f.requests.length,0);});
test('busy continuation rearms only its own target without checkpoint writes',()=>{const f=fixture();f.request('stage');f.request('production');const stage=f.files.get('restore-stage'),production=f.files.get('restore-production'),writes=f.writes.length;f.busy=true;f.run('production');assert.equal(f.files.get('restore-stage'),stage);assert.equal(f.files.get('restore-production'),production);assert.equal(f.writes.length,writes);assert.equal(f.requests.length,0);assert.equal(f.triggers.filter(x=>x==='hubProductionReadModelRestoreContinue').length,1);assert.equal(f.triggers.filter(x=>x==='hubStageReadModelRestoreContinue').length,1);});

function recoveryFixture(){const f=fixture(true);f.request('stage');f.run('stage');f.stageBefore=f.files.get('restore-stage');f.request('production');const r=f.job('production');delete r.recoveryVersion;delete r.worker;Object.assign(r,{phase:'ERROR',status:'ERROR',sendAt:14,verified:14,lastError:'MODEL_RESTORE_FAILED'});f.files.set('restore-production',JSON.stringify(r));f.original=JSON.stringify(r);return f;}
function recover(f){f.ctx.hubProductionRestoreRecoverApproved();}
function runRecovery(f){f.ctx.hubProductionReadModelRestoreContinue();}
function unpause(f){const r=f.job('production');r.retryAfter=0;f.files.set('restore-production',JSON.stringify(r));}

test('fresh checkpoint diagnostic is read-only and redacts authorization failures',()=>{for(const http of [200,403]){const f=recoveryFixture(),r=f.job('production');Object.assign(r,{phase:'ERROR',sendAt:82,verified:82,lastError:'MODEL_CHECKPOINT_VERIFY'});f.files.set('restore-production',JSON.stringify(r));const before=f.files.get('restore-production'),writes=f.writes.length,requests=f.requests.length;f.failure={type:'checkpoint-read',http};f.ctx.hubProductionRestoreStorageReadDiagnostic();assert.equal(f.files.get('restore-production'),before);assert.equal(f.writes.length,writes);assert.equal(f.requests.length,requests);assert.equal(f.audits.at(-1).code,http===200?'MODEL_CHECKPOINT_FRESH_READ_MATCH':'MODEL_CHECKPOINT_HTTP_403');assert(!JSON.stringify(f.audits).includes('SYNTHETIC-OAUTH'));f.unchanged();}});

test('approved recovery backs up 14/156, retransfers immutable 156 files, commits with exact counts and Stage unchanged',()=>{
 const f=recoveryFixture();recover(f);assert.equal(f.files.get('backup'),f.original);assert.equal(f.job('production').sendAt,0);assert.equal(f.job('production').recoveryReason,'PENDING_RECEIPTS_NOT_EXPOSED');
 runRecovery(f);assert.equal(f.job('production').phase,'DONE');assert.equal(f.job('production').commitHttp,200);assert.equal(f.job('production').sendAt,156);assert.equal(f.models.production.status().ready,true);
 assert.equal(f.files.get('restore-stage'),f.stageBefore);assert.equal(f.models.production.status().historyRows,120035);assert.equal(f.models.production.status().periodRows,147689);f.unchanged();
 const n=f.requests.length;recover(f);runRecovery(f);assert.equal(f.requests.length,n);assert.equal(f.triggers.includes('hubProductionReadModelRestoreContinue'),false);
});
test('recovery baseline mismatch never writes or sends',()=>{const f=recoveryFixture();const r=f.job('production');r.sendAt=15;f.files.set('restore-production',JSON.stringify(r));const n=f.writes.length;recover(f);assert.equal(f.writes.length,n);assert.equal(f.files.has('backup'),false);assert.equal(f.requests.filter(r=>r.target==='production').length,0);});
for(const type of ['begin','shard','commit'])for(const http of [401,403,409])test(`recovery ${type} ${http} stops immediately including continuation`,()=>{const f=recoveryFixture();recover(f);f.failure={target:'production',type,http};runRecovery(f);const n=f.requests.length;runRecovery(f);recover(f);assert.equal(f.requests.length,n);assert.equal(f.job('production').phase,'ERROR');assert.equal(f.job('production').lastError,'MODEL_STAGE_HTTP_'+http);assert.equal(f.files.get('restore-stage'),f.stageBefore);assert.equal(f.models.production.status().ready,false);f.unchanged();});
for(const http of [429,500,502,503])test(`recovery ${http} bounded retry preserves acknowledged cursor and stops after three failures`,()=>{const f=recoveryFixture();recover(f);f.failure={target:'production',type:'shard',http};runRecovery(f);assert.equal(f.job('production').sendAt,0);assert.equal(f.job('production').phase,'RESTORE');const n=f.requests.length;runRecovery(f);assert.equal(f.requests.length,n);unpause(f);runRecovery(f);unpause(f);runRecovery(f);assert.equal(f.job('production').phase,'ERROR');assert.equal(f.job('production').retryAtCount,3);assert.equal(f.files.get('restore-stage'),f.stageBefore);f.unchanged();});
test('ACK loss after accepted shard retries idempotently, no raw exception retained',()=>{const f=recoveryFixture();recover(f);f.failure={target:'production',type:'shard',error:'Network connection failed PRIVATE_SENTINEL'};runRecovery(f);assert.equal(f.job('production').sendAt,0);assert.equal(f.job('production').lastFailure.step,'PRODUCTION_SEND');assert.equal(f.job('production').lastError,'MODEL_TRANSIENT_SERVICE');assert.equal(JSON.stringify(f.audits).includes('PRIVATE_SENTINEL'),false);f.failure=null;unpause(f);runRecovery(f);assert.equal(f.job('production').phase,'DONE');assert.equal(f.models.production.status().periodRows,147689);f.unchanged();});
test('malformed ACK halts without advancing source cursor',()=>{const f=recoveryFixture();recover(f);f.failure={target:'production',type:'shard',ack:'PRIVATE_SENTINEL'};runRecovery(f);assert.equal(f.job('production').phase,'ERROR');assert.equal(f.job('production').sendAt,0);assert.equal(f.job('production').lastFailure.step,'ACK_CHECK');assert.equal(f.job('production').lastError,'MODEL_ACK_JSON');assert.equal(JSON.stringify(f.audits).includes('PRIVATE_SENTINEL'),false);});
test('shard parse and hash failures are terminal and distinguished',()=>{for(const [body,step]of [['{','SHARD_PARSE'],['[]','HASH_COUNT']]){const f=recoveryFixture();recover(f);const key=Object.keys(published.shards).sort()[0];f.files.set(key,body);runRecovery(f);assert.equal(f.job('production').phase,'ERROR');assert.equal(f.job('production').lastFailure.step,step);assert.equal(f.requests.filter(r=>r.target==='production'&&r.type==='shard').length,0);assert.equal(f.files.get('restore-stage'),f.stageBefore);}});
test('already committed receiver ends without retransmission after lost commit ACK',()=>{const f=recoveryFixture();recover(f);f.failure={target:'production',type:'commit',error:'network timeout PRIVATE_SENTINEL'};runRecovery(f);assert.equal(f.models.production.status().ready,true);assert.equal(f.job('production').phase,'RESTORE');const n=f.requests.length;f.failure=null;unpause(f);runRecovery(f);assert.equal(f.requests.length,n);assert.equal(f.job('production').phase,'DONE');assert.equal(f.job('production').completionEvidence,'RECEIVER_ALREADY_COMMITTED');f.unchanged();});
test('checkpoint read-after-write delay is verified with fresh read and no additional write',()=>{const f=recoveryFixture();recover(f);const r=f.job('production'),n=f.writes.length;r.sendAt=1;r.verified=1;f.staleOnce=true;f.ctx.hubProductionRestoreSave_(r);assert.equal(f.writes.length,n+1);assert.equal(f.job('production').sendAt,1);assert.equal(f.audits.at(-1).code,'MODEL_CHECKPOINT_READBACK_RECOVERED');f.unchanged();});
test('persistent checkpoint mismatch fails closed, never accepted after retries',()=>{const f=recoveryFixture();recover(f);const r=f.job('production'),n=f.writes.length;r.sendAt=1;r.verified=1;f.staleAlways=true;f.failure={type:'checkpoint-read',http:200,body:JSON.stringify({...r,updatedAt:'MISMATCH'})};assert.throws(()=>f.ctx.hubProductionRestoreSave_(r),/MODEL_CHECKPOINT_SERIALIZATION_MISMATCH/);assert.equal(f.writes.length,n+1);assert.equal(f.models.production.status().ready,false);f.unchanged();});
test('observed checkpoint fault recovery backs up exact 88 state, preserves original backup and is single-use',()=>{const f=recoveryFixture();recover(f);const r=f.job('production');Object.assign(r,{phase:'ERROR',status:'ERROR',sendAt:88,verified:88,lastError:'MODEL_CHECKPOINT_VERIFY',lastFailure:{step:'CHECKPOINT_SAVE'}});const before=JSON.stringify(r);f.files.set('restore-production',before);f.ctx.hubProductionRestoreRetryCheckpointApproved();assert.equal(f.files.get('checkpoint-backup'),before);assert.equal(f.files.get('backup'),f.original);assert.equal(f.job('production').sendAt,0);const n=f.writes.length;f.ctx.hubProductionRestoreRetryCheckpointApproved();assert.equal(f.writes.length,n);assert.equal(f.files.get('restore-stage'),f.stageBefore);runRecovery(f);assert.equal(f.job('production').phase,'DONE');f.unchanged();});
test('independent media read proves DriveApp stale without weakening exact verification',()=>{const f=recoveryFixture();recover(f);const r=f.job('production');r.sendAt=1;r.verified=1;f.staleAlways=true;f.ctx.hubProductionRestoreSave_(r);assert.equal(f.audits.at(-1).code,'MODEL_CHECKPOINT_DRIVEAPP_STALE_CONFIRMED');f.unchanged();});
test('fresh read permission failure is terminal and does not bypass auth',()=>{const f=recoveryFixture();recover(f);const r=f.job('production');r.sendAt=1;r.verified=1;f.staleAlways=true;f.failure={type:'checkpoint-read',http:403};assert.throws(()=>f.ctx.hubProductionRestoreSave_(r),/MODEL_CHECKPOINT_HTTP_403/);assert.equal(f.models.production.status().ready,false);f.unchanged();});
test('exact 82 checkpoint recovery backs up once and reuses same files with isolated transfer',()=>{const f=recoveryFixture();recover(f);const r=f.job('production');Object.assign(r,{phase:'ERROR',status:'ERROR',sendAt:82,verified:82,recoveryCheckpointRetry:true,lastError:'MODEL_CHECKPOINT_VERIFY',lastFailure:{step:'CHECKPOINT_SAVE'}});const before=JSON.stringify(r);f.files.set('restore-production',before);f.ctx.hubProductionRestoreFreshReadRecoveryApproved();assert.equal(f.files.get('fresh-backup'),before);assert.equal(f.job('production').sendAt,0);const writes=f.writes.length;f.ctx.hubProductionRestoreFreshReadRecoveryApproved();assert.equal(f.writes.length,writes);runRecovery(f);assert.equal(f.job('production').phase,'DONE');assert.equal(f.files.get('restore-stage'),f.stageBefore);f.unchanged();});

test('normal cold-start request selects production worker with exact-readback fallback, Stage unchanged',()=>{
 const f=fixture(true);f.request('stage');f.run('stage');const stage=f.files.get('restore-stage');
 f.request('production');assert.equal(f.job('production').worker,'PRODUCTION_RESTORE_V2');assert.equal(f.job('production').recoveryVersion,1);
 f.staleAlways=true;runRecovery(f);assert.equal(f.job('production').phase,'DONE');assert.equal(f.job('production').sendAt,156);
 assert.equal(f.files.get('restore-stage'),stage);assert(f.audits.some(x=>x.code==='MODEL_CHECKPOINT_DRIVEAPP_STALE_CONFIRMED'));f.unchanged();
});
test('legacy RESTORE continuation cannot route back to generic production worker',()=>{
 const f=fixture(true);f.request('production');let r=f.job('production');delete r.recoveryVersion;delete r.worker;f.files.set('restore-production',JSON.stringify(r));
 f.ctx.hubReadModelRestoreContinue_=()=>assert.fail('legacy worker called');runRecovery(f);assert.equal(f.job('production').phase,'DONE');assert.equal(f.job('production').worker,'PRODUCTION_RESTORE_V2');f.unchanged();
});
test('first failure survives failure-checkpoint save error; continuation cannot retry',()=>{
 const f=recoveryFixture();recover(f);const original=f.ctx.hubProductionRestoreSave_;
 f.ctx.hubProductionRestoreSave_=r=>{if(r.lastFailure)throw Error('MODEL_CHECKPOINT_VERIFY');return original(r);};
 f.failure={target:'production',type:'shard',http:401};runRecovery(f);
 const h=JSON.parse(f.props.get('PHASE2B_PRODUCTION_RESTORE_HALT_V2'));assert.equal(h.code,'MODEL_STAGE_HTTP_401');assert.equal(h.failedStep,'PRODUCTION_SEND');assert.equal(h.http,401);
 const n=f.requests.length;runRecovery(f);assert.equal(f.requests.length,n);assert.equal(f.files.get('restore-stage'),f.stageBefore);f.unchanged();
});
test('cold-start preflight validates all immutable shards with zero writes and sends',()=>{
 const f=recoveryFixture();const n=f.writes.length,q=f.requests.length;f.ctx.hubProductionRestoreColdStartDiagnostic();
 assert.equal(f.audits.at(-1).code,'MODEL_156_SHARDS_VERIFIED');assert.equal(f.writes.length,n);assert.equal(f.requests.length,q);f.unchanged();
});
test('approved ERROR60 repair verifies all hashes, backs up exact checkpoint, never rebuilds or touches Stage',()=>{
 const f=recoveryFixture(),r=f.job('production');Object.assign(r,{sendAt:60,verified:60});const before=JSON.stringify(r);f.files.set('restore-production',before);
 const folder=f.ctx.DriveApp.getFolderById;
 f.ctx.DriveApp.getFolderById=id=>({createFile(name,text,mime){if(name.startsWith('production-restore-before-coldstart-')){f.files.set('cold-backup',text);return{getId:()=> 'cold-backup',getBlob:()=>({getDataAsString:()=>f.files.get('cold-backup')})};}return folder(id).createFile(name,text,mime);}});
 f.ctx.hubProductionRestoreColdStartRecoverApproved();assert.equal(f.files.get('cold-backup'),before);assert.equal(f.job('production').sendAt,0);
 const n=f.writes.length;f.ctx.hubProductionRestoreColdStartRecoverApproved();assert.equal(f.writes.length,n);
 runRecovery(f);assert.equal(f.job('production').sendAt,156);assert.equal(f.job('production').commitHttp,200);assert.equal(f.files.get('restore-stage'),f.stageBefore);f.unchanged();
});
test('ERROR60 repair refuses damaged shards before checkpoint writes or requests',()=>{
 const f=recoveryFixture(),r=f.job('production');Object.assign(r,{sendAt:60,verified:60});f.files.set('restore-production',JSON.stringify(r));
 f.files.set(Object.keys(published.shards)[0],'[]');const n=f.writes.length,q=f.requests.length;f.ctx.hubProductionRestoreColdStartRecoverApproved();
 assert.equal(f.audits.at(-1).code,'MODEL_RESTORE_SHARD_CHANGED');assert.equal(f.writes.length,n);assert.equal(f.requests.length,q);assert.equal(f.job('production').sendAt,60);
});
