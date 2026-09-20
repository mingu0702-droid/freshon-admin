import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {createStageReadModel} from '../src/stageReadModel.js';
const worker=fs.readFileSync(new URL('../integrations/hub/HubStageReadModel.js',import.meta.url),'utf8');
const restore=fs.readFileSync(new URL('../integrations/hub/HubStageReadModelRestore.js',import.meta.url),'utf8');
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fixture(failure){
 const secret='synthetic-restore-test-secret-000000000',files=new Map(),props=new Map([['PHASE2B_STAGE_READ_MODEL_V1','published'],['HUB_MAP_API_HMAC_SECRET',secret],['HUB_MODEL_STAGE_ENDPOINT','https://freshon-admin-stage-preview-template.onrender.com/internal/stage-read-model']]);
 const s={stateId:'published',folderId:'folder',generation:1789401132459,phase:'DONE',startDate:'2026-06-18',endDate:'2026-09-15',sendAt:4,scanned:579006,source:4,shards:{}};
 for(const kind of ['history','period'])for(const d of ['2026-09-13','2026-09-14']){
  const k=kind+':'+d,row=kind==='history'?{deliveryDate:d,customerCode:'S12345',deliveryId:'D1',vehicle:'101',driverName:'가나다',driverPhone:'SYNTHETIC',kind:'ASSIGNED',sourceVersion:'x',updatedAt:d}
   :{deliveryDate:d,customerCode:'S12345',vehicle:'101',driverName:'가나다',driverKey:'key',driverIdentity:'UNVERIFIED'};
  files.set(k,JSON.stringify([row]));s.shards[k]={id:k,count:1,hash:hash([row])};
 }
 files.set('published',JSON.stringify(s));const baseline=new Map(files),requests=[],writes=[],created=[];let triggers=['other'],busy=false,model=createStageReadModel({secret});
 const file=id=>({getId:()=>id,getBlob:()=>({getDataAsString:()=>{if(!files.has(id))throw Error('MISSING');return files.get(id);}}),setContent(text){assert.equal(id,'restore');writes.push(id);files.set(id,text);}});
 const ctx=vm.createContext({Date,console:{log(){}},MimeType:{PLAIN_TEXT:'text/plain'},HUB_MAP_HTTP_API:{SECRET_PROPERTY:'secret'},hubMapHttpValidateOnlyKeys_(){},
  LockService:{getUserLock:()=>({tryLock:()=>!busy&&(busy=true),releaseLock(){busy=false;}}),getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,v)})},
  DriveApp:{getFileById:file,getFolderById:()=>({createFile(name,text){assert.equal(name,'restore-checkpoint.json');files.set('restore',text);return file('restore');}})},
  SpreadsheetApp:new Proxy({},{get(){throw Error('SOURCE_SCAN_FORBIDDEN');}}),
  ScriptApp:{getProjectTriggers:()=>triggers.map(n=>({getHandlerFunction:()=>n})),deleteTrigger(t){assert.equal(t.getHandlerFunction(),'hubStageReadModelRestoreContinue');triggers=triggers.filter(n=>n!==t.getHandlerFunction());},
   newTrigger(n){assert.equal(n,'hubStageReadModelRestoreContinue');return{timeBased(){return this;},after(){return this;},create(){triggers.push(n);created.push(n);}};}},
  Utilities:{Charset:{UTF_8:'UTF-8',US_ASCII:'US-ASCII'},DigestAlgorithm:{SHA_256:'SHA256'},getUuid:()=>crypto.randomUUID(),
   computeDigest(_a,t,c){assert.equal(c,'UTF-8');return [...crypto.createHash('sha256').update(t).digest()];},
   computeHmacSha256Signature(t,k,c){assert.equal(c,'UTF-8');return [...crypto.createHmac('sha256',k).update(t).digest()];}},
  UrlFetchApp:{fetch(_url,o){const b=JSON.parse(o.payload),type=b.message.type;let status=200;
   if(failure?.type===type)status=failure.http;
   if(status===200){try{model.ingest(b,o.headers['x-stage-model-signature']);}catch{status=409;}}
   requests.push({type,status});return{getResponseCode:()=>status};}}
 });vm.runInContext(worker+'\n'+restore,ctx);
 return{ctx,files,baseline,requests,writes,created,get job(){return files.has('restore')?JSON.parse(files.get('restore')):null;},get model(){return model;},restart(){model=createStageReadModel({secret});},get triggers(){return triggers;},set busy(v){busy=v;}};
}
test('published DONE routes to isolated restore; duplicate requests never rewind BUILD or restore progress',()=>{
 const f=fixture();f.ctx.hubStageModelRequest_({});assert.equal(f.job.phase,'RESTORE');const j=f.job;j.sendAt=1;j.verified=1;f.files.set('restore',JSON.stringify(j));
 f.ctx.hubStageModelRequest_({});assert.equal(f.job.sendAt,1);assert.equal(f.created.length,1);
 assert.equal(f.files.get('published'),f.baseline.get('published'));assert.deepEqual(f.triggers,['other','hubStageReadModelRestoreContinue']);
});
test('full restore verifies Unicode hashes and atomic commit without any BUILD/source/shard write',()=>{
 const f=fixture();f.ctx.hubStageModelRequest_({});f.ctx.hubStageReadModelRestoreContinue();assert.equal(f.job.phase,'DONE');assert.equal(f.job.verified,4);assert.equal(f.job.unicodeVerified,true);
 assert.equal(f.model.status().ready,true);assert.equal(f.model.status().generation,1789401132459);assert.equal(f.model.period('2026-09-14','2026-09-14').data.length,1);
 assert.equal(f.model.history({customerCode:'S12345',startDate:'2026-09-14',endDate:'2026-09-14'}).length,1);
 for(const [k,v]of f.baseline)assert.equal(f.files.get(k),v);assert.deepEqual(f.triggers,['other']);
});
test('new Stage process can automatically request same published generation again without changing original files',()=>{
 const f=fixture();f.ctx.hubStageModelRequest_({});f.ctx.hubStageReadModelRestoreContinue();f.restart();assert.equal(f.model.status().ready,false);
 f.ctx.hubStageModelRequest_({});f.ctx.hubStageReadModelRestoreContinue();assert.equal(f.model.status().ready,true);for(const [k,v]of f.baseline)assert.equal(f.files.get(k),v);
});
for(const type of ['begin','shard','commit'])for(const http of [401,403])test(`restore ${type} ${http} is terminal even on startup and scheduled continuation`,()=>{
 const f=fixture({type,http});f.ctx.hubStageModelRequest_({});f.ctx.hubStageReadModelRestoreContinue();assert.equal(f.job.phase,'ERROR');assert.equal(f.job.authHalt,true);
 const count=f.requests.length;f.ctx.hubStageModelRequest_({});f.ctx.hubStageReadModelRestoreContinue();assert.equal(f.requests.length,count);assert.equal(f.model.status().ready,false);assert.deepEqual(f.triggers,['other']);
});
test('changed shard or published manifest prevents publish and preserves old live',()=>{
 const f=fixture();f.ctx.hubStageModelRequest_({});f.ctx.hubStageReadModelRestoreContinue();assert.equal(f.model.status().ready,true);
 f.ctx.hubStageModelRequest_({});f.files.set('history:2026-09-13','[]');f.ctx.hubStageReadModelRestoreContinue();assert.equal(f.job.phase,'ERROR');assert.equal(f.model.status().ready,true);
 const g=fixture();g.ctx.hubStageModelRequest_({});const s=JSON.parse(g.files.get('published'));s.generation++;g.files.set('published',JSON.stringify(s));g.ctx.hubStageReadModelRestoreContinue();assert.equal(g.requests.length,0);assert.equal(g.job.phase,'ERROR');
});
test('restore transient 5xx retries are bounded to three and never reset successful cursor',()=>{
 const f=fixture({type:'shard',http:520});f.ctx.hubStageModelRequest_({});for(let i=0;i<4;i++)f.ctx.hubStageReadModelRestoreContinue();
 assert.equal(f.job.phase,'ERROR');assert.equal(f.job.errors,3);assert.equal(f.requests.filter(x=>x.type==='begin').length,1);assert.equal(f.requests.filter(x=>x.type==='shard').length,3);
});
test('invalid published totals and busy lock produce no restore writes or transmission',()=>{
 const f=fixture();f.busy=true;f.ctx.hubStageModelRequest_({});assert.equal(f.job,null);f.busy=false;
 const s=JSON.parse(f.files.get('published'));s.sendAt--;f.files.set('published',JSON.stringify(s));assert.throws(()=>f.ctx.hubStageModelRequest_({}),/NOT_PUBLISHED/);assert.equal(f.job,null);assert.equal(f.requests.length,0);
});
