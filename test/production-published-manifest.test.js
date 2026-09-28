import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const code=fs.readFileSync(new URL('../integrations/hub/HubProductionRestoreRecovery.js',import.meta.url),'utf8');
function fixture(change={}){
 const p={generation:2000000000000,stateId:'live',phase:'DONE',operation:'MAP_INCREMENTAL',publishTarget:'production',commitHttp:200,verifiedFingerprint:'fp',verifyAt:162,...change};
 const manifest={keys:Array.from({length:162},(_,i)=>'key'+i),fingerprint:'fp',totals:{historyFiles:81,periodFiles:81,historyRows:130000,periodRows:150000}};
 const ctx=vm.createContext({PropertiesService:{getScriptProperties:()=>({getProperty:k=>({pub:'live',prod:'r',stage:'s'})[k]})},HUB_STAGE_MODEL:{property:'pub'},HUB_MODEL_TARGETS:{production:{property:'prod'},stage:{property:'stage'}},hubStageModelLoad_:()=>p,hubStageRestoreManifest_:()=>manifest});vm.runInContext(code,ctx);
 return()=>ctx.hubProductionRestoreBaseline_({target:'production',stateId:'r',publishedStateId:'live',generation:p.generation,fingerprint:'fp'});
}
test('Production restore accepts only verified published incremental manifest without 156 constant',()=>{assert.equal(fixture()().manifest.keys.length,162);});
test('unverified, uncommitted or foreign target generation cannot enter Production restore',()=>{for(const patch of [{commitHttp:null},{verifiedFingerprint:'wrong'},{verifyAt:161},{publishTarget:'stage'},{stateId:'other'},{phase:'VERIFY'}])assert.throws(fixture(patch),/MODEL_RECOVERY_BASELINE/);});
test('automatic worker uses manifest size and counts for cursor, completion and readback',()=>{const worker=code.slice(code.indexOf('function hubProductionRestoreWorker_'),code.indexOf('function hubProductionRestoreRecoveryStatus'));assert(!/\b(156|120035|147689)\b/.test(worker));assert.match(worker,/r.sendAt===m.keys.length/);assert.match(worker,/after.historyRows!==m.totals.historyRows/);});
