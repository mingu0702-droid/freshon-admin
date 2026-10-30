import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../integrations/hub/HubProductionCheckpoint.js',import.meta.url),'utf8');
function fixture({writeError,readError,stale=false,freshMismatch=false,accessErrors=[]}={}){
 let stored='',writes=0,serializations=0,accesses=0;const audits=[];
 const props={prod:'p',stage:'s',published:'live'};
 const r={target:'production',stateId:'p',phase:'RESTORE',generation:7,sendAt:45,verified:45};
 const ctx=vm.createContext({Date,JSON:{...JSON,parse:JSON.parse,stringify(value){serializations++;return JSON.stringify(value);}},HUB_MODEL_TARGETS:{production:{property:'prod'},stage:{property:'stage'}},HUB_STAGE_MODEL:{property:'published'},
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]})},Utilities:{sleep(){}},
  DriveApp:{getFileById(id){assert.equal(id,'p');const error=accessErrors[accesses++];if(error)throw Error(error);return{setContent(s){writes++;stored=s;if(writeError)throw Error(writeError);},getBlob(){if(readError)throw Error('read error');return{getDataAsString:()=>stale?'stale':stored};}};}},
  hubProductionRestoreFreshText_:()=>freshMismatch?JSON.stringify({...r,updatedAt:'wrong'}):stored,
  hubProductionRestoreAudit_:(_r,step,code)=>audits.push({step,code})});vm.runInContext(source,ctx);
 return{ctx,r,audits,save:()=>ctx.hubProductionCheckpointSave_(r),get accesses(){return accesses;},get stored(){return stored;},get writes(){return writes;},get serializations(){return serializations;}};
}

test('transient Drive file access retries at most twice before exact single write',()=>{const f=fixture({accessErrors:['Service error: Drive','Service error: Drive']});f.save();assert.equal(f.accesses,3);assert.equal(f.writes,1);assert.equal(f.stored,JSON.stringify(f.r));});
test('persistent Drive access and permission/quota errors remain fail closed',()=>{for(const [errors,code,n] of [[Array(3).fill('Service error: Drive'),'MODEL_DRIVE_SERVICE_ERROR',3],[['permission denied'],'MODEL_PERMISSION_DENIED',1],[['quota exceeded'],'MODEL_QUOTA_LIMIT',1]]){const f=fixture({accessErrors:errors});assert.throws(f.save,new RegExp(code));assert.equal(f.accesses,n);assert.equal(f.writes,0);assert.equal(f.r.sendAt,45);}});
test('Production save freezes once, verifies exact UTF8 bytes and does not touch peer',()=>{const f=fixture();f.save();assert.equal(f.serializations,1);assert.equal(f.writes,1);assert.equal(f.stored,JSON.stringify(f.r));});
test('write ACK failure after persistence is accepted only by exact saved content',()=>{const f=fixture({writeError:'Service error: Drive'});f.save();assert.equal(f.audits.at(-1).code,'MODEL_WRITE_ACK_LOST_VERIFIED');assert.equal(f.writes,1);});
test('read-back service exception uses independent exact media read',()=>{const f=fixture({readError:true});f.save();assert.equal(f.audits.at(-1).code,'MODEL_CHECKPOINT_DRIVEAPP_STALE_CONFIRMED');assert.equal(f.serializations,1);});
test('persistent mismatch fails closed without changing progress or rewriting',()=>{const f=fixture({stale:true,freshMismatch:true});assert.throws(f.save,/MODEL_CHECKPOINT_SERIALIZATION_MISMATCH/);assert.equal(f.r.sendAt,45);assert.equal(f.writes,1);});
test('permission error never becomes success even when old content matches',()=>{const f=fixture({writeError:'permission denied'});assert.throws(f.save,/MODEL_PERMISSION_DENIED/);assert.equal(f.audits.length,0);});
test('foreign checkpoint is rejected without writing',()=>{const f=fixture();f.r.stateId='s';assert.throws(f.save,/MODEL_RESTORE_TARGET_CONFLICT/);assert.equal(f.writes,0);});
test('automatic Production worker uses frozen checkpoint writer, Stage helper unchanged',()=>{
 const recovery=fs.readFileSync(new URL('../integrations/hub/HubProductionRestoreRecovery.js',import.meta.url),'utf8');
 const restore=fs.readFileSync(new URL('../integrations/hub/HubStageReadModelRestore.js',import.meta.url),'utf8');
 assert.match(recovery,/function hubProductionRestoreSave_\(r\)\{\s*if\(typeof hubProductionCheckpointSave_==='function'\)return hubProductionCheckpointSave_\(r\)/);
 assert.match(restore,/hubProductionRestoreWorker_\(\)/);
 assert(!source.includes('setProperty('));assert(!source.includes('deleteTrigger('));
});
function resumeFixture(change={}){
 const r={target:'production',stateId:'p',generation:1789933588775,phase:'ERROR',sendAt:45,verified:45,lastError:'MODEL_CHECKPOINT_SAVE_FAILED',...change};
 let stored=JSON.stringify(r),backups=0,writes=0,schedules=0,reads=0;const audits=[];
 const ctx=vm.createContext({Date,JSON,MimeType:{PLAIN_TEXT:'text/plain'},
  LockService:{getUserLock:()=>({tryLock:()=>true,releaseLock(){}})},
  PropertiesService:{getScriptProperties:()=>({getProperty:()=>null})},
  hubStageRestoreLoad_:()=>JSON.parse(stored),hubProductionRestoreStatus_:()=>({ready:false,generation:null}),
  hubProductionRestoreFreshText_:()=>stored,hubStageModelHash_:()=> 'utf8',
  hubProductionRestoreBaseline_:()=>({manifest:{keys:['history:2026-09-19']},published:{folderId:'f',shards:{'history:2026-09-19':{id:'shard',count:1,hash:'utf8'}}}}),
  DriveApp:{getFileById:()=>({getBlob:()=>({getDataAsString:()=>{reads++;return '[{}]';}})}),getFolderById:()=>({createFile:(_n,text)=>{backups++;return{getId:()=> 'backup',getBlob:()=>({getDataAsString:()=>text})};}})},
  hubProductionRestoreSchedule_:()=>{schedules++;},hubProductionRestoreAudit_:(_r,_s,code)=>audits.push(code)});
 vm.runInContext(source,ctx);ctx.hubProductionCheckpointWrite_=(_r,text)=>{assert.equal(text,stored);};ctx.hubProductionCheckpointSave_=next=>{writes++;stored=JSON.stringify(next);};
 return{ctx,audits,run:()=>ctx.hubProductionCheckpointResumeApproved(),get stats(){return{backups,writes,schedules,reads};},get state(){return JSON.parse(stored);}};
}
test('approved ERROR45 repair backs up, checks shard and schedules same generation once',()=>{const f=resumeFixture();f.run();assert.deepEqual(f.stats,{backups:1,writes:1,schedules:1,reads:1});assert.equal(f.state.generation,1789933588775);assert.equal(f.state.sendAt,0);f.run();assert.equal(f.stats.writes,1);assert.equal(f.audits.at(-1),'MODEL_ALREADY_RUNNING');});
test('different error, cursor, auth halt or generation cannot be reset',()=>{for(const change of [{sendAt:46},{generation:99},{lastError:'MODEL_STAGE_HTTP_401'},{authHalt:true}]){const f=resumeFixture(change);f.run();assert.deepEqual(f.stats,{backups:0,writes:0,schedules:0,reads:0});assert.equal(f.audits.at(-1),'MODEL_CHECKPOINT_BASELINE_CHANGED');}});
test('active incremental and changed shard block approved resume',()=>{const f=resumeFixture();f.ctx.hubMapIncrementalLoad_=()=>({phase:'BUILD'});f.run();assert.equal(f.audits.at(-1),'MODEL_INCREMENTAL_BUSY');assert.equal(f.stats.writes,0);const g=resumeFixture();g.ctx.hubStageModelHash_=()=> 'bad';g.run();assert.equal(g.audits.at(-1),'MODEL_RESTORE_SHARD_CHANGED');assert.equal(g.stats.writes,0);});
test('consumed continuation rearm preserves all checkpoint bytes and progress',()=>{const f=resumeFixture({phase:'RESTORE',sendAt:84,verified:84,frozenStorageRepair:true,updatedAt:'2026-01-01T00:00:00Z'});const before=f.state;f.ctx.hubProductionCheckpointRearmInterrupted();assert.equal(f.stats.schedules,1);assert.equal(f.stats.writes,0);assert.deepEqual(f.state,before);assert.equal(f.audits.at(-1),'MODEL_STALLED_CONTINUATION_REARMED');});
test('recent, ERROR or auth-stopped restore cannot be rearmed',()=>{for(const change of [{phase:'ERROR'},{authHalt:true},{updatedAt:new Date().toISOString()}]){const f=resumeFixture({phase:'RESTORE',sendAt:84,verified:84,frozenStorageRepair:true,updatedAt:'2026-01-01T00:00:00Z',...change});f.ctx.hubProductionCheckpointRearmInterrupted();assert.equal(f.stats.schedules,0);assert.equal(f.stats.writes,0);}});
test('observed Drive ERROR48 is backed up and verified before same-file replay once',()=>{const f=resumeFixture({sendAt:48,verified:48,lastError:'MODEL_DRIVE_SERVICE_ERROR',failedStep:'CHECKPOINT_FILE_ACCESS'});f.ctx.hubProductionCheckpointRecoverDrive48();assert.equal(f.state.generation,1789933588775);assert.equal(f.state.sendAt,0);assert.equal(f.stats.backups,1);assert.equal(f.stats.reads,1);assert.equal(f.stats.schedules,1);f.ctx.hubProductionCheckpointRecoverDrive48();assert.equal(f.stats.writes,1);});
test('Drive48 repair does not reset any other error, generation, phase or worker',()=>{for(const change of [{sendAt:49},{lastError:'MODEL_PERMISSION_DENIED'},{failedStep:'SHARD_READ'},{generation:8},{authHalt:true},{drive48Repair:true}]){const f=resumeFixture({sendAt:48,verified:48,lastError:'MODEL_DRIVE_SERVICE_ERROR',failedStep:'CHECKPOINT_FILE_ACCESS',...change});f.ctx.hubProductionCheckpointRecoverDrive48();assert.equal(f.stats.writes,0);assert.equal(f.stats.schedules,0);}});
