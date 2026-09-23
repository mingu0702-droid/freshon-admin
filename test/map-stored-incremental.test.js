import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const text=n=>fs.readFileSync(new URL('../integrations/hub/'+n,import.meta.url),'utf8');
function fixture(){
 const files=new Map(),props=new Map(),writes=[],sent=[],reads=[];let triggers=['customerWatchdog'],fail=null,failPointer=false;
 const old={stateId:'old',folderId:'old-folder',phase:'DONE',generation:1789933588775,startDate:'2026-06-22',endDate:'2026-09-19',shards:{},sendAt:0};
 for(const date of ['2026-06-22','2026-06-23','2026-06-24','2026-09-19'])for(const kind of ['history','period']){
   const rows=[kind==='history'?{deliveryDate:date,customerCode:'S11111',deliveryId:'D1',vehicle:'용10',driverName:'합성 기사',driverPhone:'',kind:'ASSIGNED',sourceVersion:'v',updatedAt:date}:{deliveryDate:date,customerCode:'S11111',vehicle:'용10',driverName:'합성 기사',driverKey:'d',driverIdentity:'UNVERIFIED'}],key=kind+':'+date;
   files.set(key,JSON.stringify(rows));old.shards[key]={id:key,count:1,hash:hash(rows)};
 }
 old.sendAt=Object.keys(old.shards).length;files.set('old',JSON.stringify(old));
 const baseline=new Map(files);props.set('PHASE2B_STAGE_READ_MODEL_V1','old');
 let live={ready:true,generation:old.generation,startDate:old.startDate,endDate:old.endDate},id=0;
 const file=k=>({getId:()=>k,getBlob:()=>({getDataAsString:()=>{assert(files.has(k));return files.get(k);}}),setContent(v){assert(!baseline.has(k));files.set(k,v);writes.push(k);}});
 const folder={getSharingAccess:()=> 'PRIVATE',getId:()=> 'new-folder',createFile(name,value){const k='new-'+(++id);files.set(k,value);return file(k);},getFilesByName:()=>({hasNext:()=>false})};
 const ctx=vm.createContext({Date,console:{log(){}},MimeType:{PLAIN_TEXT:'text/plain'},HUB_MAP_HTTP_API:{SECRET_PROPERTY:'secret'},
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty(k,v){if(k==='PHASE2B_STAGE_READ_MODEL_V1'&&failPointer){failPointer=false;throw Error('temporary');}props.set(k,v);}})},
  LockService:{getUserLock:()=>({tryLock:()=>true,releaseLock(){}})},DriveApp:{Access:{PRIVATE:'PRIVATE'},createFolder:()=>folder,getFolderById:()=>folder,getFileById:file},
  ScriptApp:{getProjectTriggers:()=>triggers.map(x=>({getHandlerFunction:()=>x})),deleteTrigger(t){assert.equal(t.getHandlerFunction(),'hubMapIncrementalContinue');triggers=triggers.filter(x=>x!==t.getHandlerFunction());},newTrigger(x){assert.equal(x,'hubMapIncrementalContinue');return{timeBased(){return this;},after(){return this;},create(){triggers.push(x);}};}},
  Utilities:{Charset:{UTF_8:'utf8',US_ASCII:'ascii'},DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_a,s,c)=>[...crypto.createHash('sha256').update(s,c).digest()],computeHmacSha256Signature:(s,k,c)=>[...crypto.createHmac('sha256',k||'synthetic').update(s,c).digest()],base64EncodeWebSafe:a=>Buffer.from(a).toString('base64url')},
  hubMapHttpValidateOnlyKeys_:(p,keys)=>assert(Object.keys(p).every(k=>keys.includes(k))),hubStaffHistoryDate_:x=>x
 });
 vm.runInContext(text('HubStageReadModel.js')+'\n'+text('HubStageReadModelRestore.js')+'\n'+text('HubStageReadModelIncremental.js')+'\n'+text('HubMapIncremental.js'),ctx);
 ctx.hubMapCollectionStatus_=()=>({freshon:'2026-09-21',delivery:'2026-09-21'});
 ctx.hubMapIncrementalLive_=()=>live;ctx.hubStageRestoreLoad_=()=>null;
 ctx.hubMapIncrementalStable_=(kind,date)=>{
  reads.push(date);assert(['2026-09-20','2026-09-21'].includes(date));
  const rows=date==='2026-09-20'?[]:[kind==='history'?{deliveryDate:date,customerCode:'S11111',deliveryId:'D2',vehicle:'용10',driverName:'한글',driverPhone:'',kind:'ASSIGNED',sourceVersion:'v',updatedAt:date}:{deliveryDate:date,customerCode:'S11111',vehicle:'용10',driverName:'한글',driverKey:'d',driverIdentity:'UNVERIFIED'}];
  return{rows,hash:hash(rows),stats:{sourceRows:rows.length,generatedRows:rows.length,dedupe:0}};
 };
 ctx.hubStageIncrementalReadCompletion_=(date)=>({pass:date==='2026-09-21',deliveryPass:date==='2026-09-21',freshonPass:date==='2026-09-21'});
 ctx.hubStageModelSend_=(message,target)=>{
  assert.equal(target,'production');sent.push(message.type);
  if(fail?.type===message.type)throw Object.assign(Error('MODEL_STAGE_HTTP_'+fail.status),{modelAuthFatal:[401,403].includes(fail.status)});
  if(message.type==='commit'){const entries=message.manifest;live={ready:true,generation:message.generation,startDate:message.startDate,endDate:message.endDate,
   historyRows:entries.filter(x=>x.key.startsWith('history:')).reduce((n,x)=>n+x.count,0),periodRows:entries.filter(x=>x.key.startsWith('period:')).reduce((n,x)=>n+x.count,0)};}
  return 200;
 };
 const job=()=>ctx.hubMapIncrementalLoad_();
 return{ctx,files,props,writes,sent,reads,old,job,get live(){return live;},get triggers(){return triggers;},
  set fail(v){fail=v;},set failPointer(v){failPointer=v;},request:()=>ctx.hubMapIncrementalRequest_({target:'production'}),run:()=>ctx.hubMapIncrementalContinue(),
  unchanged(){for(const[k,v]of baseline)assert.equal(files.get(k),v);}};
}
test('stored incremental reuses immutable date shards, keeps 90 days and commits after verification',()=>{
 const f=fixture();f.request();const generation=f.job().generation;assert(generation>f.old.generation);assert.equal(f.job().startDate,'2026-06-24');
 for(let i=0;i<6;i++)f.run();
 const c=f.job();assert.equal(c.phase,'DONE');assert.equal(c.publication,'PUBLISHED');assert.equal(c.sendAt,6);assert.equal(c.generation,generation);
 assert.equal(f.live.generation,generation);assert.equal(f.props.get('PHASE2B_STAGE_READ_MODEL_V1'),c.stateId);
 assert.equal(c.days['2026-09-20'].history.collectionCompleteness,'UNCONFIRMED');assert.equal(c.days['2026-09-21'].history.collectionCompleteness,'VERIFIED');
 assert.equal(f.sent.at(-1),'commit');assert.equal(f.sent.filter(x=>x==='shard').length,6);f.unchanged();assert.deepEqual(f.triggers,['customerWatchdog']);
});
test('duplicate request preserves generation and progress; same job cannot reset ERROR',()=>{
 const f=fixture();f.request();f.run();const c=f.job();f.request();assert.equal(f.job().buildAt,c.buildAt);assert.equal(f.job().generation,c.generation);
 c.phase='ERROR';c.lastError='MODEL_STAGE_HTTP_401';f.ctx.hubStageModelSave_(c);const writes=f.writes.length;f.request();f.run();assert.equal(f.writes.length,writes);assert.equal(f.sent.length,0);
});
for(const type of ['begin','shard','commit'])for(const status of [401,403])test('incremental '+type+' '+status+' halts before any further transmission',()=>{
 const f=fixture();f.request();for(let i=0;i<5;i++)f.run();f.fail={type,status};f.run();
 assert.equal(f.job().phase,'ERROR');assert.equal(f.job().authHaltGeneration,f.job().generation);const sent=f.sent.length;f.run();f.request();assert.equal(f.sent.length,sent);assert.equal(f.props.get('PHASE2B_STAGE_READ_MODEL_V1'),'old');f.unchanged();
});
test('pointer interruption resumes publication only, without duplicate candidate or transmission',()=>{
 const f=fixture();f.request();for(let i=0;i<5;i++)f.run();f.failPointer=true;f.run();
 assert.equal(f.job().phase,'DONE');assert.equal(f.job().publication,'PENDING');const id=f.job().stateId,n=f.sent.length;f.request();f.run();
 assert.equal(f.job().stateId,id);assert.equal(f.sent.length,n);assert.equal(f.job().publication,'PUBLISHED');f.unchanged();
});
test('changed base pointer and corrupted shard block commit',()=>{
 for(const mode of ['pointer','shard']){
  const f=fixture();f.request();for(let i=0;i<4;i++)f.run();
  if(mode==='pointer')f.files.set('old',JSON.stringify({...f.old,generation:4}));else f.files.set('history:2026-09-19','[]');
  f.run();assert.equal(f.job().phase,'ERROR');assert.equal(f.sent.length,0);
 }
});
test('conflicting logical key is rejected; identical source overlap deduplicated',()=>{
 const f=fixture(),raw={deliveryDate:'2026-09-21',customerCode:'S11111',deliveryId:'D2',rawHash:'v',confirmedVehicle:'101',driverName:'한글'};
 const sources=[{name:'Archive',rows:[raw]},{name:'Current',rows:[raw]}];
 const r=f.ctx.hubMapIncrementalMerge_('history','2026-09-21',sources);assert.equal(r.rows.length,1);assert.equal(r.stats.dedupe,1);
 sources[1].rows=[{...raw,confirmedVehicle:'102'}];assert.throws(()=>f.ctx.hubMapIncrementalMerge_('history','2026-09-21',sources),/KEY_CONFLICT/);
});
test('source-read path is bounded, date-located and contains no source mutation or collector',()=>{
 const source=text('HubMapIncremental.js');assert(!/runFullSync|deleteRows|setValues|clearContent|collector\//.test(source));
 assert(source.includes('createTextFinder'));assert(source.includes('count<1000'));assert(source.includes('MODEL_INCREMENTAL_LOCATION_CHANGED'));
});
