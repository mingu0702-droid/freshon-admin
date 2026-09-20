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
function fixture(){
 const files=new Map(sourceFiles),props=new Map([['PHASE2B_STAGE_READ_MODEL_V1','published'],['HUB_MAP_API_HMAC_SECRET',secrets.stage],['HUB_MODEL_PRODUCTION_HMAC_SECRET',secrets.production],['HUB_MODEL_STAGE_ENDPOINT',endpoints.stage],['HUB_MODEL_PRODUCTION_ENDPOINT',endpoints.production]]);
 const models={stage:createStageReadModel({secret:secrets.stage}),production:createStageReadModel({secret:secrets.production})},requests=[],writes=[];
 let triggers=['customerWatchdog'],failure=null,busy=false;
 const file=id=>({getId:()=>id,getBlob:()=>({getDataAsString:()=>{assert(files.has(id));return files.get(id);}}),setContent(text){assert(['restore-stage','restore-production'].includes(id));files.set(id,text);writes.push(id);}});
 const ctx=vm.createContext({Date,console:{log(){}},MimeType:{PLAIN_TEXT:'text/plain'},HUB_MAP_HTTP_API:{SECRET_PROPERTY:'HUB_MAP_API_HMAC_SECRET'},
  hubMapHttpValidateOnlyKeys_(params,keys){assert(Object.keys(params).every(k=>keys.includes(k)));},
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty(k,v){assert(['PHASE2B_STAGE_RESTORE_V1','PHASE2B_PRODUCTION_RESTORE_V1'].includes(k));props.set(k,v);}})},
  LockService:{getUserLock:()=>({tryLock:()=>!busy&&(busy=true),releaseLock(){busy=false;}}),getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
  DriveApp:{getFileById:file,getFolderById:()=>({createFile(name,text){const id=name==='restore-checkpoint.json'?'restore-stage':name==='restore-production-checkpoint.json'?'restore-production':assert.fail('unexpected file');assert(!files.has(id));files.set(id,text);return file(id);}})},
  SpreadsheetApp:new Proxy({},{get(){throw Error('SOURCE_READ_FORBIDDEN');}}),
  ScriptApp:{getProjectTriggers:()=>triggers.map(n=>({getHandlerFunction:()=>n})),deleteTrigger(t){assert.notEqual(t.getHandlerFunction(),'customerWatchdog');triggers=triggers.filter(n=>n!==t.getHandlerFunction());},newTrigger(n){assert(['hubStageReadModelRestoreContinue','hubProductionReadModelRestoreContinue'].includes(n));return{timeBased(){return this;},after(){return this;},create(){triggers.push(n);}};}},
  Utilities:{Charset:{UTF_8:'UTF-8',US_ASCII:'US-ASCII'},DigestAlgorithm:{SHA_256:'SHA256'},getUuid:()=>crypto.randomUUID(),computeDigest(_a,t,c){assert.equal(c,'UTF-8');return [...crypto.createHash('sha256').update(t).digest()];},computeHmacSha256Signature(t,k,c){assert.equal(c,'UTF-8');return [...crypto.createHmac('sha256',k).update(t).digest()];}},
  UrlFetchApp:{fetch(url,o){const target=Object.keys(endpoints).find(k=>endpoints[k]===url);assert(target);const body=JSON.parse(o.payload),type=body.message.type;
   assert.equal(o.headers['x-stage-model-signature'],crypto.createHmac('sha256',secrets[target]).update(o.payload).digest('hex'));
   const status=failure?.target===target&&failure.type===type?failure.http:200;
   if(status===200)models[target].ingest(body,o.headers['x-stage-model-signature']);requests.push({target,type,status});return{getResponseCode:()=>status};}}
 });vm.runInContext(worker+'\n'+restore,ctx);
 return{ctx,files,props,models,requests,writes,set failure(v){failure=v;},set busy(v){busy=v;},get triggers(){return triggers;},job:t=>JSON.parse(files.get('restore-'+t)),request:t=>ctx.hubStageModelRequest_({target:t}),run:t=>ctx.hubReadModelRestoreContinue_(t),unchanged(){for(const[k,v]of sourceFiles)assert.equal(files.get(k),v);}};
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
